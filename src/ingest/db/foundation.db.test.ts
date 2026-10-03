// Round 10 (Copilot on 17f07d7): the catalog check must also require the
// reviewed 0001 foundation to be PRESENT and unaltered once the ledger says
// 0001 is applied — not only refuse extra privileges/hooks. Every attack below
// is a committed contract migration on a disposable database, refused by the
// runner's check (nothing committed), or drift made outside the runner and
// reported by status.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from './testing/harness';
import { DEFAULT_MIGRATIONS_DIR } from './migrationFiles';
import { migrateDown, migrateUp, migrationStatus } from './migrate';

// Loaded lazily so each test reports its own failure while the module is missing.
const foundation = () => import('./foundation');
const model = () => import('./privilegeModel');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function freshDb(migrate: boolean): Promise<TestDatabase> {
  const db = await createTestDatabase({ migrate });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-foundation-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(DEFAULT_MIGRATIONS_DIR)) fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

const CONTRACT = '-- ratio:phase contract\n';

/** A committed contract 0002 that the runner must refuse because a required 0001 object is missing or altered. */
async function expectFoundationRefusal(sql: string, expectMessage: RegExp): Promise<Client> {
  const db = await freshDb(false);
  const c = await connect(db);
  const dir = migrationsWith({ '0002_attack.up.sql': CONTRACT + sql });
  const err = await migrateUp(c, { dir, allowContract: true }).then(
    () => null,
    (e: Error & { code?: string }) => e,
  );
  expect(err, 'runner must refuse').not.toBeNull();
  expect(err!.code).toBe('PRIVILEGE_MODEL_VIOLATION');
  expect(err!.message).toMatch(/required 0001 object missing or altered/);
  expect(err!.message).toMatch(expectMessage);
  expect((await c.query(`SELECT array_agg(version ORDER BY version) AS v FROM public.schema_migrations`)).rows[0].v).toEqual(['0001']);
  return c;
}

/** Name of one composite FK of ratio.cost_facts, resolved in SQL (no hard-coded constraint name). */
const COST_FACTS_FK = `(SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid = 'ratio.cost_facts'::regclass AND contype = 'f' ORDER BY conname LIMIT 1)`;

describe('round 10: the manifest is generated from 0001 and cannot drift silently', () => {
  it('a fresh 0001 apply produces exactly FOUNDATION_0001 (the stored manifest)', async () => {
    const { FOUNDATION_0001, foundationSnapshot } = await foundation();
    const db = await freshDb(true);
    const c = await connect(db);
    expect(await foundationSnapshot(c)).toEqual([...FOUNDATION_0001].sort());
    // It covers every rule class the check relies on.
    for (const prefix of ['schema:', 'table:', 'column:', 'policy:', 'trigger:', 'function:', 'view:', 'constraint:', 'index:']) {
      expect(FOUNDATION_0001.some((e) => e.startsWith(prefix)), prefix).toBe(true);
    }
    expect(FOUNDATION_0001.filter((e) => e.startsWith('trigger:'))).toHaveLength(11);
    expect(FOUNDATION_0001.filter((e) => e.startsWith('policy:'))).toHaveLength(9);
  });

  it('positive controls: pre-migration, a clean apply and post-down all pass; status reports no privilege problem', async () => {
    const { assertReviewedPrivileges } = await model();
    const db = await freshDb(false);
    const c = await connect(db);
    await assertReviewedPrivileges(c); // nothing applied
    expect((await migrationStatus(c)).privilegeProblems).toEqual([]);
    await migrateUp(c);
    await assertReviewedPrivileges(c);
    expect((await migrationStatus(c)).privilegeProblems).toEqual([]);
    await migrateDown(c, { steps: 1, env: { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test' } });
    await assertReviewedPrivileges(c); // 0001 reverted: absence is fine
    expect((await migrationStatus(c)).privilegeProblems).toEqual([]);
  });
});

describe('round 10: removing or weakening the reviewed foundation is refused (contract migrations, committed attempts)', () => {
  it('DROP TRIGGER for each guard class (RT001 child, RT002 lifecycle, RT003 publication consistency, TRUNCATE refusal)', async () => {
    for (const [stmt, re] of [
      ['DROP TRIGGER child_of_staged_batch ON ratio.cost_facts;', /trigger:ratio\.cost_facts:child_of_staged_batch/],
      ['DROP TRIGGER batch_lifecycle ON ratio.ingest_batches;', /trigger:ratio\.ingest_batches:batch_lifecycle/],
      ['DROP TRIGGER publication_consistency ON ratio.period_publications;', /trigger:ratio\.period_publications:publication_consistency/],
      ['DROP TRIGGER refuse_truncate ON ratio.cost_facts;', /trigger:ratio\.cost_facts:refuse_truncate/],
    ] as const) {
      const c = await expectFoundationRefusal(stmt + '\n', re);
      expect((await c.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'ratio.cost_facts'::regclass AND NOT tgisinternal`)).rows[0].n).toBe(2);
    }
  });

  it('ALTER TABLE … DISABLE TRIGGER and ENABLE REPLICA TRIGGER (built so the lexical classifier cannot see them)', async () => {
    await expectFoundationRefusal(
      "DO $$ BEGIN EXECUTE format('ALTER TABLE ratio.cost_facts %s TRIGGER child_of_staged_batch', 'DISABLE'); END $$;\n",
      /trigger:ratio\.cost_facts:child_of_staged_batch/,
    );
    await expectFoundationRefusal(
      'ALTER TABLE ratio.ingest_batches ENABLE REPLICA TRIGGER batch_lifecycle;\n',
      /trigger:ratio\.ingest_batches:batch_lifecycle/,
    );
  });

  it('a constraint trigger made NOT DEFERRABLE (RT003 timing pinned)', async () => {
    await expectFoundationRefusal(
      'DROP TRIGGER publication_consistency ON ratio.period_publications;\n' +
        'CREATE CONSTRAINT TRIGGER publication_consistency AFTER INSERT OR UPDATE OR DELETE ON ratio.period_publications\n' +
        '  NOT DEFERRABLE FOR EACH ROW EXECUTE FUNCTION ratio.tg_publication_consistency();\n',
      /trigger:ratio\.period_publications:publication_consistency/,
    );
  });

  it('NO FORCE ROW LEVEL SECURITY, and DISABLE ROW LEVEL SECURITY', async () => {
    await expectFoundationRefusal(
      "DO $$ BEGIN EXECUTE format('ALTER TABLE ratio.cost_facts %s ROW LEVEL SECURITY', 'NO FORCE'); END $$;\n",
      /table:ratio\.cost_facts:/,
    );
    await expectFoundationRefusal(
      "DO $$ BEGIN EXECUTE format('ALTER TABLE ratio.sources %s ROW LEVEL SECURITY', 'DISABLE'); END $$;\n",
      /table:ratio\.sources:/,
    );
  });

  it('DROP POLICY, and a policy rewritten to USING (true)', async () => {
    await expectFoundationRefusal(
      "DO $$ BEGIN EXECUTE format('DROP %s tenant_isolation ON ratio.cost_facts', 'POLICY'); END $$;\n",
      /policy:ratio\.cost_facts:tenant_isolation/,
    );
    await expectFoundationRefusal(
      "DO $$ BEGIN EXECUTE format('ALTER %s tenant_isolation ON ratio.ingest_batches USING (true)', 'POLICY'); END $$;\n",
      /policy:ratio\.ingest_batches:tenant_isolation/,
    );
  });

  it('CREATE OR REPLACE a guard function into a no-op (owner and trigger unchanged; body pinned)', async () => {
    await expectFoundationRefusal(
      'SET LOCAL ROLE ratio_owner;\n' +
        'CREATE OR REPLACE FUNCTION ratio.tg_child_of_staged_batch() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp\n' +
        'AS $fn$ BEGIN IF TG_OP = $q$DELETE$q$ THEN RETURN OLD; END IF; RETURN NEW; END $fn$;\n',
      /function:ratio\.tg_child_of_staged_batch\(\)/,
    );
  });

  it('a dropped composite tenant FK, and one re-added NOT VALID', async () => {
    await expectFoundationRefusal(
      `DO $$ DECLARE n text := ${COST_FACTS_FK}; BEGIN EXECUTE format('ALTER TABLE ratio.cost_facts DROP CONSTRAINT %I', n); END $$;\n`,
      /constraint:ratio\.cost_facts:/,
    );
    await expectFoundationRefusal(
      `DO $$ DECLARE n text := ${COST_FACTS_FK}; d text; BEGIN\n` +
        `  SELECT pg_catalog.pg_get_constraintdef(oid) INTO d FROM pg_catalog.pg_constraint WHERE conrelid = 'ratio.cost_facts'::regclass AND conname = n;\n` +
        `  EXECUTE format('ALTER TABLE ratio.cost_facts DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID', n, n, d);\n` +
        `END $$;\n`,
      /constraint:ratio\.cost_facts:.*validated=true/,
    );
  });

  it('the published view: reader grant revoked, or switched to security_invoker', async () => {
    await expectFoundationRefusal('REVOKE SELECT ON ratio.cost_facts_published FROM ratio_reader;\n', /privilege:ratio_reader:relation:ratio\.cost_facts_published:SELECT/);
    await expectFoundationRefusal('ALTER VIEW ratio.cost_facts_published SET (security_invoker = true);\n', /view:ratio\.cost_facts_published:/);
  });

  it('a partial unique index (one published batch per period) dropped', async () => {
    await expectFoundationRefusal('DROP INDEX ratio.ingest_batches_one_published_per_period;\n', /index:ratio\.ingest_batches:ingest_batches_one_published_per_period/);
  });

  it('a 0001 column type changed', async () => {
    await expectFoundationRefusal('ALTER TABLE ratio.sync_runs ALTER COLUMN error_code TYPE varchar(64);\n', /column:ratio\.sync_runs:error_code:text/);
  });

  it('DROP SCHEMA ratio CASCADE as a migration is refused', async () => {
    await expectFoundationRefusal('DROP SCHEMA ratio CASCADE;\n', /schema:ratio:owner=ratio_owner/);
  });

  it('DROP SCHEMA ratio CASCADE made outside the runner: status reports it (problem PRIVILEGE_MODEL_VIOLATION)', async () => {
    const db = await freshDb(true);
    await db.pool.query('DROP SCHEMA ratio CASCADE');
    const c = await connect(db);
    const st = await migrationStatus(c);
    expect(st.matches).toBe(false);
    expect(st.problems).toContain('PRIVILEGE_MODEL_VIOLATION');
    expect(st.privilegeProblems.join('\n')).toMatch(/required 0001 object missing or altered: schema:ratio:owner=ratio_owner/);
  });
});
