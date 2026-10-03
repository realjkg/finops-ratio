// Round 4 (challenger round 3, M1): the migration runner checks the CATALOG,
// not the SQL text, inside each migration's transaction before COMMIT:
//   * ratio_reader / ratio_worker hold no privilege beyond the reviewed set
//     (relations, columns, functions, schemas — implicit PUBLIC grants count);
//   * no SECURITY DEFINER function exists outside pg_catalog/information_schema
//     unless it is owned by ratio_owner AND on the reviewed allow-list;
//   * PUBLIC has EXECUTE on no function in schemas ratio or public.
// The classifier (migrationFiles.ts) is lexical defence in depth; these tests
// get past it either by bypassing it (SQL executed directly, then the check)
// or with reasoned markers, and the catalog check must still refuse.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from './testing/harness';
import { seedTwoTenants } from './testing/fixtures';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from './migrationFiles';
import { migrateDown, migrateUp, migrationStatus } from './migrate';

// Loaded lazily so each test reports its own failure while the module is missing.
const model = () => import('./privilegeModel');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function freshDb(): Promise<TestDatabase> {
  const db = await createTestDatabase({ migrate: false });
  cleanups.push(() => db.close());
  return db;
}

async function connect(db: TestDatabase): Promise<Client> {
  const c = new Client({ connectionString: db.url });
  c.on('error', () => undefined);
  await c.connect();
  cleanups.push(() => c.end());
  return c;
}

function migrationsWith(extra: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-priv-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(DEFAULT_MIGRATIONS_DIR)) fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

const EXPAND = '-- ratio:phase expand\n';
const CONTRACT = '-- ratio:phase contract\n';
const REPRO =
  'CREATE FUNCTION public.report_rows() RETURNS SETOF ratio.cost_facts LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT * FROM ratio.cost_facts $$;';

async function versions(c: Client): Promise<string[]> {
  return (await c.query(`SELECT version FROM public.schema_migrations ORDER BY version`)).rows.map((r) => r.version);
}

async function fnExists(c: Client, name: string): Promise<boolean> {
  return (await c.query(`SELECT to_regproc($1) IS NOT NULL AS e`, [name])).rows[0].e;
}

/** Applies a 0002 through the runner (classifier included) and expects the catalog check to refuse it. */
async function expectRunnerRefuses(sql: string, expectMessage: RegExp, opts: { contract?: boolean } = {}): Promise<Client> {
  const db = await freshDb();
  const c = await connect(db);
  const dir = migrationsWith({ '0002_extra.up.sql': (opts.contract ? CONTRACT : EXPAND) + sql });
  // The classifier lets it through (marked); only the catalog check stands in the way.
  expect(loadMigrations(dir).map((m) => m.version)).toEqual(['0001', '0002']);
  const err = await migrateUp(c, { dir, allowContract: opts.contract === true }).then(
    () => null,
    (e: Error & { code?: string }) => e,
  );
  expect(err, 'runner must refuse').not.toBeNull();
  expect(err!.code).toBe('PRIVILEGE_MODEL_VIOLATION');
  expect(err!.message).toMatch(expectMessage);
  // 0001 committed in its own transaction; 0002 rolled back completely.
  expect(await versions(c)).toEqual(['0001']);
  return c;
}

describe('runner catalog check: positive control', () => {
  it('0001 applies cleanly and the effective reader/worker privileges equal the reviewed allow-list exactly', async () => {
    const { REVIEWED_PRIVILEGES, assertReviewedPrivileges, effectivePrivileges } = await model();
    const db = await freshDb();
    const c = await connect(db);
    expect(await migrateUp(c)).toEqual({ applied: ['0001'] });
    await assertReviewedPrivileges(c);
    const eff = await effectivePrivileges(c);
    for (const role of ['ratio_reader', 'ratio_worker'] as const) {
      expect([...eff[role]].sort(), role).toEqual([...REVIEWED_PRIVILEGES[role]].sort());
    }
    expect(REVIEWED_PRIVILEGES.ratio_reader).toEqual(
      expect.arrayContaining(['relation:ratio.cost_facts_published:SELECT', 'function:ratio.current_tenant_id()', 'schema:ratio:USAGE']),
    );
    expect(REVIEWED_PRIVILEGES.ratio_reader.filter((p) => p.startsWith('relation:'))).toEqual(['relation:ratio.cost_facts_published:SELECT']);
  });

  it('a legitimate marked expand migration (table, ratio function revoked from PUBLIC, ratio view, no new grants) still applies', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = migrationsWith({
      '0002_legit.up.sql':
        EXPAND +
        'SET LOCAL ROLE ratio_owner;\n' +
        'CREATE TABLE ratio.notes (tenant_id uuid NOT NULL, body text);\n' +
        'ALTER TABLE ratio.notes ENABLE ROW LEVEL SECURITY;\nALTER TABLE ratio.notes FORCE ROW LEVEL SECURITY;\n' +
        'CREATE POLICY tenant_isolation ON ratio.notes USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());\n' +
        "-- ratio:allow-function pure helper, invoker rights\nCREATE FUNCTION ratio.add_one(x int) RETURNS int LANGUAGE sql IMMUTABLE AS 'select x + 1';\n" +
        'REVOKE EXECUTE ON FUNCTION ratio.add_one(int) FROM PUBLIC;\n' +
        '-- ratio:allow-view owner-only projection\nCREATE VIEW ratio.note_bodies AS SELECT body FROM ratio.notes;\n',
    });
    expect(await migrateUp(c, { dir })).toEqual({ applied: ['0001', '0002'] });
    expect(await versions(c)).toEqual(['0001', '0002']);
    await (await model()).assertReviewedPrivileges(c);
  });
});

describe('runner catalog check refuses what the classifier cannot see', () => {
  it('challenger repro (classifier bypassed): the public SECURITY DEFINER reader of ratio.cost_facts is refused before COMMIT', async () => {
    const { assertReviewedPrivileges } = await model();
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    await seedTwoTenants(db.pool);
    const c = await connect(db);
    await c.query('BEGIN');
    try {
      await c.query(REPRO);
      // The threat is real: a reader with NO tenant set reads every tenant's rows, staged and quarantined included.
      const all = (await c.query(`SELECT count(*)::int AS n FROM ratio.cost_facts`)).rows[0].n as number;
      expect(all).toBeGreaterThan(0);
      await c.query('SET LOCAL ROLE ratio_reader');
      const leak = await c.query(`SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS t FROM public.report_rows()`);
      expect(leak.rows[0]).toEqual({ n: all, t: 2 });
      await c.query('RESET ROLE');
      const err = await assertReviewedPrivileges(c).then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
      expect(err).not.toBeNull();
      expect(err!.code).toBe('PRIVILEGE_MODEL_VIOLATION');
      expect(err!.message).toMatch(/SECURITY DEFINER.*public\.report_rows\(\)/);
      expect(err!.message).toMatch(/ratio_reader.*function:public\.report_rows\(\)/);
      expect(err!.message).toMatch(/PUBLIC.*EXECUTE.*public\.report_rows\(\)/);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  it('the repro with reasoned markers passes the classifier but is refused by the runner and rolled back', async () => {
    const c = await expectRunnerRefuses(
      '-- ratio:allow-function reporting helper\n-- ratio:allow-security-definer reporting\n' + REPRO + '\n',
      /SECURITY DEFINER.*public\.report_rows\(\)/,
    );
    expect(await fnExists(c, 'public.report_rows')).toBe(false);
  });

  it('a marked SECURITY DEFINER function owned by ratio_owner, revoked from PUBLIC and granted to nobody, is still refused (not on the reviewed list)', async () => {
    const c = await expectRunnerRefuses(
      'SET LOCAL ROLE ratio_owner;\n' +
        '-- ratio:allow-function definer helper\n-- ratio:allow-security-definer not reviewed into the allow-list\n' +
        "CREATE FUNCTION ratio.definer_one() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'select 1';\n" +
        'REVOKE EXECUTE ON FUNCTION ratio.definer_one() FROM PUBLIC;\n',
      /SECURITY DEFINER.*ratio\.definer_one\(\)/,
    );
    expect(await fnExists(c, 'ratio.definer_one')).toBe(false);
  });

  it('view variant: a marked superuser-owned view over ratio.cost_facts granted to ratio_worker is refused', async () => {
    const c = await expectRunnerRefuses(
      '-- ratio:allow-view reporting projection\nCREATE VIEW public.all_facts AS SELECT * FROM ratio.cost_facts;\n' +
        'GRANT SELECT ON public.all_facts TO ratio_worker;\n',
      /ratio_worker.*relation:public\.all_facts:SELECT/,
    );
    expect((await c.query(`SELECT to_regclass('public.all_facts') IS NULL AS gone`)).rows[0].gone).toBe(true);
  });

  it('view variant (classifier bypassed): a view granted to ratio_reader is refused', async () => {
    const { assertReviewedPrivileges } = await model();
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    const c = await connect(db);
    await c.query('BEGIN');
    try {
      await c.query('CREATE VIEW public.all_facts AS SELECT * FROM ratio.cost_facts');
      await c.query('GRANT SELECT ON public.all_facts TO ratio_reader');
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(/ratio_reader.*relation:public\.all_facts:SELECT/);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  it('implicit grant: a marked public non-definer function is refused (PUBLIC holds EXECUTE by default)', async () => {
    const c = await expectRunnerRefuses(
      "-- ratio:allow-function counts facts\nCREATE FUNCTION public.fact_count() RETURNS bigint LANGUAGE sql STABLE AS 'select count(*) from ratio.cost_facts';\n",
      /PUBLIC.*EXECUTE.*public\.fact_count\(\)/,
    );
    expect(await fnExists(c, 'public.fact_count')).toBe(false);
  });

  it('implicit grant: a marked ratio function that keeps the default PUBLIC EXECUTE is refused', async () => {
    await expectRunnerRefuses(
      "SET LOCAL ROLE ratio_owner;\n-- ratio:allow-function helper\nCREATE FUNCTION ratio.add_one(x int) RETURNS int LANGUAGE sql IMMUTABLE AS 'select x + 1';\n",
      /ratio_reader.*function:ratio\.add_one\(integer\)/,
    );
  });

  it('worker grants beyond the reviewed set (table privilege, column privilege, schema CREATE) are refused', async () => {
    await expectRunnerRefuses('GRANT TRUNCATE ON ratio.cost_facts TO ratio_worker;\n', /ratio_worker.*relation:ratio\.cost_facts:TRUNCATE/);
    await expectRunnerRefuses('GRANT UPDATE (billed_cost) ON ratio.cost_facts TO ratio_worker;\n', /ratio_worker.*relation:ratio\.cost_facts:UPDATE\(billed_cost\)/);
    await expectRunnerRefuses('GRANT CREATE ON SCHEMA public TO ratio_worker;\n', /ratio_worker.*schema:public:CREATE/);
    await expectRunnerRefuses('GRANT REFERENCES ON ratio.tenants TO ratio_worker;\n', /ratio_worker.*relation:ratio\.tenants:REFERENCES/);
  });

  it('the check also runs inside a down migration transaction', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = migrationsWith({
      '0002_extra.up.sql': EXPAND + 'CREATE TABLE public.scratch_priv (x int);\n',
      '0002_extra.down.sql': 'DROP TABLE public.scratch_priv;\nGRANT TRUNCATE ON ratio.sync_runs TO ratio_worker;\n',
    });
    expect(await migrateUp(c, { dir })).toEqual({ applied: ['0001', '0002'] });
    const err = await migrateDown(c, { steps: 1, dir, env: { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test' } }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe('PRIVILEGE_MODEL_VIOLATION');
    expect(await versions(c)).toEqual(['0001', '0002']);
    expect((await c.query(`SELECT to_regclass('public.scratch_priv') IS NOT NULL AS e`)).rows[0].e).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 5 (challenger round 4): nothing a migration installs may run after the
// catalog check, and the check pins hooks, role identity, search_path and the
// remaining privilege kinds.
// ---------------------------------------------------------------------------

async function readerHasCostFacts(c: Client): Promise<boolean> {
  return (await c.query(`SELECT has_table_privilege('ratio_reader', 'ratio.cost_facts', 'SELECT') AS h`)).rows[0].h;
}

describe('round 5 M1: code that would run after the check (ledger / deferred triggers) is refused', () => {
  it('(a) expand: an AFTER INSERT trigger on public.schema_migrations granting the reader cost_facts is refused; nothing committed', async () => {
    const c = await expectRunnerRefuses(
      "-- ratio:allow-function audit hook\nCREATE FUNCTION public.audit_ledger() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'GRANT SELECT ON ratio.cost_facts, ratio.ingest_validation_errors TO ' || 'ratio_reader'; RETURN NULL; END $f$;\n" +
        'REVOKE EXECUTE ON FUNCTION public.audit_ledger() FROM PUBLIC;\n' +
        'CREATE TRIGGER audit_ledger AFTER INSERT ON public.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.audit_ledger();\n',
      /public\.schema_migrations/,
    );
    expect(await readerHasCostFacts(c)).toBe(false);
    expect((await c.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.schema_migrations'::regclass`)).rows[0].n).toBe(0);
  });

  it('(b) expand: a deferred constraint trigger on the ledger, function in another schema, is refused; nothing committed', async () => {
    const c = await expectRunnerRefuses(
      'CREATE SCHEMA hooks;\nCREATE TABLE hooks.tick(i int);\n' +
        "-- ratio:allow-function deferred hook\nCREATE FUNCTION hooks.later() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'GRANT SELECT ON ratio.cost_facts TO ' || 'ratio_reader'; RETURN NULL; END $f$;\n" +
        'CREATE CONSTRAINT TRIGGER later AFTER INSERT ON public.schema_migrations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hooks.later();\n',
      /later/,
    );
    expect(await readerHasCostFacts(c)).toBe(false);
    expect((await c.query(`SELECT to_regnamespace('hooks') IS NULL AS gone`)).rows[0].gone).toBe(true);
  });

  it('(c) contract: a deferred constraint trigger on a helper table, queued by an INSERT, is refused; nothing committed', async () => {
    const c = await expectRunnerRefuses(
      'CREATE TABLE public.tick(i int);\n' +
        "CREATE FUNCTION public.later() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'GRANT SELECT ON ratio.cost_facts TO ' || 'ratio_reader'; RETURN NULL; END $f$;\n" +
        'REVOKE EXECUTE ON FUNCTION public.later() FROM PUBLIC;\n' +
        'CREATE CONSTRAINT TRIGGER later AFTER INSERT ON public.tick DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.later();\n' +
        'INSERT INTO public.tick VALUES (1);\n',
      /ratio_reader holds relation:ratio\.cost_facts:SELECT|trigger/,
      { contract: true },
    );
    expect(await readerHasCostFacts(c)).toBe(false);
  });

  it('(c, isolated) the deferred trigger fires BEFORE the check (SET CONSTRAINTS ALL IMMEDIATE), so its GRANT is seen', async () => {
    await expectRunnerRefuses(
      'CREATE TABLE public.tick(i int);\n' +
        "CREATE FUNCTION public.later() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'GRANT SELECT ON ratio.cost_facts TO ' || 'ratio_reader'; RETURN NULL; END $f$;\n" +
        'REVOKE EXECUTE ON FUNCTION public.later() FROM PUBLIC;\n' +
        'CREATE CONSTRAINT TRIGGER later AFTER INSERT ON public.tick DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.later();\n' +
        'INSERT INTO public.tick VALUES (1);\n',
      /ratio_reader holds relation:ratio\.cost_facts:SELECT/,
      { contract: true },
    );
  });

  it('(a, isolated) the ledger row is written BEFORE the check, so an AFTER INSERT ledger trigger has already run when the check looks', async () => {
    await expectRunnerRefuses(
      "-- ratio:allow-function audit hook\nCREATE FUNCTION public.audit_ledger() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'GRANT SELECT ON ratio.cost_facts TO ' || 'ratio_reader'; RETURN NULL; END $f$;\n" +
        'REVOKE EXECUTE ON FUNCTION public.audit_ledger() FROM PUBLIC;\n' +
        'CREATE TRIGGER audit_ledger AFTER INSERT ON public.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.audit_ledger();\n',
      /ratio_reader holds relation:ratio\.cost_facts:SELECT/,
    );
  });

  it('an event trigger is refused', async () => {
    const c = await expectRunnerRefuses(
      'CREATE FUNCTION public.on_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $f$ BEGIN NULL; END $f$;\n' +
        'REVOKE EXECUTE ON FUNCTION public.on_ddl() FROM PUBLIC;\n' +
        'CREATE EVENT TRIGGER ratio_probe_on_ddl ON ddl_command_end EXECUTE FUNCTION public.on_ddl();\n',
      /event trigger ratio_probe_on_ddl/,
      { contract: true },
    );
    expect((await c.query(`SELECT count(*)::int AS n FROM pg_event_trigger`)).rows[0].n).toBe(0);
  });

  it('a rule is refused (on a helper table, and on the ledger)', async () => {
    await expectRunnerRefuses(
      'CREATE TABLE public.tick(i int);\nCREATE RULE tick_notify AS ON INSERT TO public.tick DO ALSO NOTIFY ratio_probe;\n',
      /rule tick_notify on public\.tick/,
      { contract: true },
    );
    await expectRunnerRefuses(
      'CREATE RULE ledger_notify AS ON INSERT TO public.schema_migrations DO ALSO NOTIFY ratio_probe;\n',
      /rule ledger_notify on public\.schema_migrations/,
      { contract: true },
    );
  });

  it('a policy (or RLS) on the ledger is refused', async () => {
    await expectRunnerRefuses(
      'ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;\n' +
        'CREATE POLICY ledger_narrow ON public.schema_migrations AS RESTRICTIVE FOR SELECT USING (true);\n',
      /public\.schema_migrations/,
    );
  });

  it('a trigger on a ratio table that is not on the reviewed list is refused, even with a ratio_owner function in schema ratio', async () => {
    await expectRunnerRefuses(
      'SET LOCAL ROLE ratio_owner;\n' +
        '-- ratio:allow-function extra guard\nCREATE FUNCTION ratio.tg_extra() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $f$ BEGIN RETURN NEW; END $f$;\n' +
        'REVOKE EXECUTE ON FUNCTION ratio.tg_extra() FROM PUBLIC;\n' +
        '-- ratio:allow-function attaches extra guard\nCREATE TRIGGER extra_guard BEFORE INSERT ON ratio.sync_runs FOR EACH ROW EXECUTE FUNCTION ratio.tg_extra();\n',
      /trigger ratio\.sync_runs:extra_guard/,
    );
  });

  it('positive control: the 0001 triggers are exactly the reviewed list', async () => {
    const { REVIEWED_TRIGGERS } = await model();
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    const r = await db.pool.query(
      `SELECT n.nspname || '.' || c.relname || ':' || t.tgname || ':' || pn.nspname || '.' || p.proname || '()' AS t
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace
        WHERE NOT t.tgisinternal ORDER BY 1`,
    );
    expect(r.rows.map((x) => x.t)).toEqual([...REVIEWED_TRIGGERS].sort());
    expect(REVIEWED_TRIGGERS).toHaveLength(11);
  });
});

describe('round 5 L1: the check cannot be blinded by operators on the search_path', () => {
  it('a migration that installs public.=/<> operators and puts public first on the search_path still has its grant detected', async () => {
    await expectRunnerRefuses(
      "CREATE FUNCTION public.always_false(name, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select false';\n" +
        "CREATE FUNCTION public.always_true(name, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select true';\n" +
        "CREATE FUNCTION public.char_false(\"char\", \"char\") RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select false';\n" +
        'REVOKE EXECUTE ON FUNCTION public.always_false(name, name), public.always_true(name, name), public.char_false("char", "char") FROM PUBLIC;\n' +
        'CREATE OPERATOR public.= (LEFTARG = name, RIGHTARG = name, FUNCTION = public.always_false);\n' +
        'CREATE OPERATOR public.<> (LEFTARG = name, RIGHTARG = name, FUNCTION = public.always_true);\n' +
        'CREATE OPERATOR public.<> (LEFTARG = "char", RIGHTARG = "char", FUNCTION = public.char_false);\n' +
        'CREATE OPERATOR public.= (LEFTARG = "char", RIGHTARG = "char", FUNCTION = public.char_false);\n' +
        'SET LOCAL search_path = public, pg_catalog;\n' +
        'GRANT TRUNCATE ON ratio.cost_facts TO ratio_worker;\n',
      /ratio_worker holds relation:ratio\.cost_facts:TRUNCATE/,
      { contract: true },
    );
  });
});

describe('round 5 L2: role identity is pinned (a rename cannot launder grants)', () => {
  /** Runs fn as the superuser in a transaction that is ALWAYS rolled back (role changes are cluster-global). */
  async function inRolledBackTxn(fn: (c: Client) => Promise<void>): Promise<void> {
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    const c = await connect(db);
    await c.query('BEGIN');
    try {
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  }
  const sfx = () => Math.random().toString(16).slice(2, 10);

  it('GRANT to ratio_reader, rename it away and create an impostor ratio_reader: refused', async () => {
    const { assertReviewedPrivileges } = await model();
    const old = `ratio_probe_renamed_${sfx()}`;
    await inRolledBackTxn(async (c) => {
      await c.query('GRANT SELECT ON ratio.cost_facts TO ratio_reader');
      await c.query(`ALTER ROLE ratio_reader RENAME TO ${old}`);
      await c.query('CREATE ROLE ratio_reader NOLOGIN');
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(new RegExp(`${old} holds relation:ratio\\.cost_facts:SELECT`));
    });
  });

  it('rename without an impostor (members keep the old role): refused', async () => {
    const { assertReviewedPrivileges } = await model();
    const old = `ratio_probe_renamed_${sfx()}`;
    await inRolledBackTxn(async (c) => {
      await c.query(`ALTER ROLE ratio_worker RENAME TO ${old}`);
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(/ratio_worker/);
    });
  });

  it('a LOGIN member of ratio_reader holding an extra privilege is refused; a plain LOGIN member passes', async () => {
    const { assertReviewedPrivileges } = await model();
    const login = `ratio_probe_login_${sfx()}`;
    await inRolledBackTxn(async (c) => {
      await c.query(`CREATE ROLE ${login} LOGIN IN ROLE ratio_reader`);
      await assertReviewedPrivileges(c); // plain member: fine
      await c.query(`GRANT SELECT ON ratio.ingest_batches TO ${login}`);
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(new RegExp(`${login} holds relation:ratio\\.ingest_batches:SELECT`));
    });
  });

  it('a NOLOGIN member of a ratio role is refused', async () => {
    const { assertReviewedPrivileges } = await model();
    const grp = `ratio_probe_group_${sfx()}`;
    await inRolledBackTxn(async (c) => {
      await c.query(`CREATE ROLE ${grp} NOLOGIN IN ROLE ratio_worker`);
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(new RegExp(`${grp} .*member of ratio_worker`));
    });
  });

  it('a non-ratio role holding any privilege on ratio objects is refused', async () => {
    const { assertReviewedPrivileges } = await model();
    const other = `ratio_probe_other_${sfx()}`;
    await inRolledBackTxn(async (c) => {
      await c.query(`CREATE ROLE ${other} NOLOGIN`);
      await c.query(`GRANT USAGE ON SCHEMA ratio TO ${other}`);
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(new RegExp(`${other} holds schema:ratio:USAGE`));
    });
  });

  it('ratio role attributes and memberships are pinned', async () => {
    const { assertReviewedPrivileges } = await model();
    for (const stmt of ['ALTER ROLE ratio_reader BYPASSRLS', 'ALTER ROLE ratio_worker CREATEDB', 'GRANT pg_read_all_data TO ratio_reader']) {
      await inRolledBackTxn(async (c) => {
        await c.query(stmt);
        await expect(assertReviewedPrivileges(c), stmt).rejects.toThrow(/ratio_(reader|worker)/);
      });
    }
  });
});

describe('round 5 L3/L4: sequence, database, parameter, FDW/server and large-object privileges', () => {
  it('L3: a sequence privilege beyond the reviewed set is refused', async () => {
    await expectRunnerRefuses(
      'CREATE SEQUENCE ratio.probe_seq;\nGRANT USAGE ON SEQUENCE ratio.probe_seq TO ratio_worker;\n',
      /ratio_worker holds relation:ratio\.probe_seq:USAGE/,
    );
  });

  it('L4: GRANT CREATE ON DATABASE built inside a DO block is refused', async () => {
    await expectRunnerRefuses(
      "-- ratio:allow-do grants on the current database\nDO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ratio_worker', current_database()); END $$;\n",
      /ratio_worker holds database:CREATE/,
    );
  });

  it('L4: GRANT SET ON PARAMETER is refused (cluster-global: probed in a rolled-back transaction, never via a committing migration)', async () => {
    const { assertReviewedPrivileges } = await model();
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    const c = await connect(db);
    await c.query('BEGIN');
    try {
      await c.query('GRANT SET ON PARAMETER session_replication_role TO ratio_worker');
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(/ratio_worker holds parameter:session_replication_role:SET/);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  it('L4: USAGE on a foreign-data wrapper or foreign server is refused', async () => {
    await expectRunnerRefuses(
      'CREATE FOREIGN DATA WRAPPER ratio_probe_fdw;\nGRANT USAGE ON FOREIGN DATA WRAPPER ratio_probe_fdw TO ratio_worker;\n',
      /ratio_worker holds foreign_data_wrapper:ratio_probe_fdw:USAGE/,
      { contract: true },
    );
    await expectRunnerRefuses(
      'CREATE FOREIGN DATA WRAPPER ratio_probe_fdw;\nCREATE SERVER ratio_probe_srv FOREIGN DATA WRAPPER ratio_probe_fdw;\nGRANT USAGE ON FOREIGN SERVER ratio_probe_srv TO ratio_worker;\n',
      /ratio_worker holds foreign_server:ratio_probe_srv:USAGE/,
      { contract: true },
    );
  });

  it('L4: a large-object privilege is refused', async () => {
    await expectRunnerRefuses(
      'SELECT pg_catalog.lo_create(424242);\nGRANT SELECT ON LARGE OBJECT 424242 TO ratio_worker;\n',
      /ratio_worker holds large_object:424242:SELECT/,
      { contract: true },
    );
  });
});

describe('round 5: tests added for mutations that survived the first table', () => {
  it('a reviewed trigger whose function is no longer owned by ratio_owner is refused', async () => {
    await expectRunnerRefuses('ALTER FUNCTION ratio.tg_refuse_truncate() OWNER TO postgres;\n', /trigger ratio\.cost_facts:refuse_truncate:ratio\.tg_refuse_truncate\(\) \(function owner postgres\)/, {
      contract: true,
    });
  });

  it('status (no runner SET LOCAL) still detects drift under a hostile session search_path with public operators', async () => {
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    await db.pool.query(
      "CREATE FUNCTION public.always_false(name, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select false';" +
        "CREATE FUNCTION public.char_false(\"char\", \"char\") RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select false';" +
        'CREATE OPERATOR public.= (LEFTARG = name, RIGHTARG = name, FUNCTION = public.always_false);' +
        'CREATE OPERATOR public.<> (LEFTARG = "char", RIGHTARG = "char", FUNCTION = public.char_false);' +
        'GRANT TRUNCATE ON ratio.cost_facts TO ratio_worker;',
    );
    const c = await connect(db);
    await c.query('SET search_path = public, pg_catalog');
    const st = await migrationStatus(c);
    expect(st.problems).toContain('PRIVILEGE_MODEL_VIOLATION');
    expect(st.privilegeProblems).toEqual(expect.arrayContaining(['ratio_worker holds relation:ratio.cost_facts:TRUNCATE beyond the reviewed set']));
  });

  it('assertReviewedPrivileges pins its own search_path (a caller-side hostile search_path cannot blind it)', async () => {
    const { assertReviewedPrivileges } = await model();
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    const c = await connect(db);
    await c.query('BEGIN');
    try {
      await c.query("CREATE FUNCTION public.always_false(name, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select false'");
      await c.query('CREATE FUNCTION public.char_false("char", "char") RETURNS boolean LANGUAGE sql IMMUTABLE AS \'select false\'');
      await c.query('REVOKE EXECUTE ON FUNCTION public.always_false(name, name), public.char_false("char", "char") FROM PUBLIC');
      await c.query('CREATE OPERATOR public.= (LEFTARG = name, RIGHTARG = name, FUNCTION = public.always_false)');
      await c.query('CREATE OPERATOR public.<> (LEFTARG = "char", RIGHTARG = "char", FUNCTION = public.char_false)');
      await c.query('GRANT TRUNCATE ON ratio.cost_facts TO ratio_worker');
      await c.query('SET LOCAL search_path = public, pg_catalog');
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(/ratio_worker holds relation:ratio\.cost_facts:TRUNCATE/);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  it('a ratio role made a member of a role that grants nothing is still refused', async () => {
    const { assertReviewedPrivileges } = await model();
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    const c = await connect(db);
    const grp = `ratio_probe_parent_${Math.random().toString(16).slice(2, 10)}`;
    await c.query('BEGIN');
    try {
      await c.query(`CREATE ROLE ${grp} NOLOGIN`);
      await c.query(`GRANT ${grp} TO ratio_reader`);
      await expect(assertReviewedPrivileges(c)).rejects.toThrow(new RegExp(`role ratio_reader must not be a member of ${grp}`));
    } finally {
      await c.query('ROLLBACK');
    }
  });
});

// ---------------------------------------------------------------------------
// Round 7 (Copilot review of 19fdbed)
// ---------------------------------------------------------------------------

const HOSTILE_0002 =
  CONTRACT +
  'CREATE SCHEMA attacker;\n' +
  "CREATE FUNCTION attacker.name_eq_false(name, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select false';\n" +
  'CREATE OPERATOR attacker.= (LEFTARG = name, RIGHTARG = name, FUNCTION = attacker.name_eq_false);\n' +
  "CREATE FUNCTION attacker.current_setting(text) RETURNS text LANGUAGE sql AS 'select ''attacker''::text';\n" +
  '-- session-scoped settings planted for whatever runs next on this connection\n' +
  'SET search_path = attacker, pg_catalog;\n' +
  'SET row_security = off;\n';

describe('round 7 High A: session-scoped settings a migration plants do not survive into the next migration', () => {
  it('the next migration in the same run resolves names through the pinned path, as the runner role, with row_security on', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = migrationsWith({
      '0002_hostile.up.sql': HOSTILE_0002,
      '0003_probe.up.sql':
        EXPAND +
        "CREATE TABLE ratio.session_probe AS SELECT current_setting('search_path') AS sp, current_setting('row_security') AS rs, ('a'::name = 'a'::name) AS eq, current_user::text AS cu;\n",
    });
    expect(await migrateUp(c, { dir, allowContract: true })).toEqual({ applied: ['0001', '0002', '0003'] });
    const probe = (await db.pool.query(`SELECT sp, rs, eq, cu FROM ratio.session_probe`)).rows[0];
    expect(probe).toEqual({ sp: 'pg_catalog, pg_temp', rs: 'on', eq: true, cu: 'postgres' });
    // ... and the runner leaves the caller's connection pinned, not hostile.
    expect((await c.query(`SELECT pg_catalog.current_setting('search_path') AS sp, pg_catalog.current_setting('row_security') AS rs`)).rows[0]).toEqual({
      sp: 'pg_catalog, pg_temp',
      rs: 'on',
    });
  });

  it('the check of the following migration still detects a planted grant', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = migrationsWith({
      '0002_hostile.up.sql': HOSTILE_0002,
      '0003_grant.up.sql': EXPAND + 'GRANT TRUNCATE ON ratio.cost_facts TO ratio_worker;\n',
    });
    const err = await migrateUp(c, { dir, allowContract: true }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(err?.code).toBe('PRIVILEGE_MODEL_VIOLATION');
    expect(err?.message).toMatch(/ratio_worker holds relation:ratio\.cost_facts:TRUNCATE/);
    expect(await versions(c)).toEqual(['0001', '0002']);
  });

  it('down: a down file that plants a session search_path does not affect the next down step', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = migrationsWith({
      '0002_attacker.up.sql':
        CONTRACT +
        'CREATE SCHEMA attacker;\n' +
        "CREATE FUNCTION attacker.name_eq_false(name, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'select false';\n" +
        'CREATE OPERATOR attacker.= (LEFTARG = name, RIGHTARG = name, FUNCTION = attacker.name_eq_false);\n',
      '0002_attacker.down.sql':
        "CREATE TABLE public.down_probe AS SELECT pg_catalog.current_setting('search_path') AS sp, ('a'::name = 'a'::name) AS eq;\n" +
        'DROP SCHEMA attacker CASCADE;\n',
      '0003_plant.up.sql': EXPAND + 'CREATE TABLE public.plant_marker (x int);\n',
      '0003_plant.down.sql': 'DROP TABLE public.plant_marker;\nSET search_path = attacker, pg_catalog;\n',
    });
    expect(await migrateUp(c, { dir, allowContract: true })).toEqual({ applied: ['0001', '0002', '0003'] });
    expect(await migrateDown(c, { steps: 2, dir, env: { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test' } })).toEqual({ reverted: ['0003', '0002'] });
    expect((await db.pool.query(`SELECT sp, eq FROM public.down_probe`)).rows[0]).toEqual({ sp: 'pg_catalog, pg_temp', eq: true });
  });

  it('resetSession clears SET SESSION AUTHORIZATION, SET ROLE, row_security and search_path', async () => {
    const { resetSession } = (await import('./migrate')) as unknown as { resetSession: (c: Client) => Promise<void> };
    const db = await createTestDatabase({ migrate: true });
    cleanups.push(() => db.close());
    const c = await connect(db);
    // SET ROLE first (as the owner session one could not SET ROLE ratio_worker).
    await c.query('SET ROLE ratio_worker');
    await resetSession(c);
    expect((await c.query(`SELECT current_user::text AS cu`)).rows[0].cu).toBe('postgres');
    await c.query('SET SESSION AUTHORIZATION ratio_owner');
    await c.query('SET row_security = off');
    await c.query('SET search_path = public, pg_catalog');
    await resetSession(c);
    expect(
      (
        await c.query(
          `SELECT session_user::text AS su, current_user::text AS cu, pg_catalog.current_setting('row_security') AS rs, pg_catalog.current_setting('search_path') AS sp`,
        )
      ).rows[0],
    ).toEqual({ su: 'postgres', cu: 'postgres', rs: 'on', sp: 'pg_catalog, pg_temp' });
  });
});

describe('round 7 High C: a ratio role with LOGIN is drift (rolled-back transactions; roles are cluster-global)', () => {
  for (const role of ['ratio_owner', 'ratio_worker', 'ratio_reader']) {
    it(`ALTER ROLE ${role} LOGIN is reported by the check (and therefore by migrate --status)`, async () => {
      const { assertReviewedPrivileges, privilegeModelViolations } = await model();
      const db = await createTestDatabase({ migrate: true });
      cleanups.push(() => db.close());
      const c = await connect(db);
      await c.query('BEGIN');
      try {
        await c.query(`ALTER ROLE ${role} LOGIN`);
        expect(await privilegeModelViolations(c)).toEqual(expect.arrayContaining([`role ${role} must not have LOGIN (deployment logins are separate member roles)`]));
        await expect(assertReviewedPrivileges(c)).rejects.toThrow(new RegExp(`role ${role} must not have LOGIN`));
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }
});
