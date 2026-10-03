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
import { migrateDown, migrateUp } from './migrate';

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
const REPRO =
  'CREATE FUNCTION public.report_rows() RETURNS SETOF ratio.cost_facts LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT * FROM ratio.cost_facts $$;';

async function versions(c: Client): Promise<string[]> {
  return (await c.query(`SELECT version FROM public.schema_migrations ORDER BY version`)).rows.map((r) => r.version);
}

async function fnExists(c: Client, name: string): Promise<boolean> {
  return (await c.query(`SELECT to_regproc($1) IS NOT NULL AS e`, [name])).rows[0].e;
}

/** Applies a 0002 through the runner (classifier included) and expects the catalog check to refuse it. */
async function expectRunnerRefuses(sql: string, expectMessage: RegExp): Promise<Client> {
  const db = await freshDb();
  const c = await connect(db);
  const dir = migrationsWith({ '0002_extra.up.sql': EXPAND + sql });
  // The classifier lets it through (marked); only the catalog check stands in the way.
  expect(loadMigrations(dir).map((m) => m.version)).toEqual(['0001', '0002']);
  const err = await migrateUp(c, { dir }).then(
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
