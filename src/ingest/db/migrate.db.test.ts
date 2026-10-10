// Migration runner against real Postgres. Each test gets its own pristine
// database because every case needs to start from "nothing applied".
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from './testing/harness';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from './migrationFiles';
import { migrateDown, migrateUp } from './migrate';

const ALLOW_DOWN = { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test' };

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
  c.on('error', () => undefined); // a terminated backend must never become an uncaught exception
  await c.connect();
  cleanups.push(() => c.end());
  return c;
}

function copyMigrations(extra: Record<string, string> = {}, opts: { withDown?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-mig-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    if (opts.withDown === false && f.endsWith('.down.sql')) continue;
    fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
  }
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

/** Versions of the repo's real migration set, from the default directory. */
function realVersions(): string[] {
  return loadMigrations(DEFAULT_MIGRATIONS_DIR).map((f) => f.version);
}

/** Two version labels sorting after the real migration set, for pending synthetic probes. */
function nextProbeVersions(): [string, string] {
  const last = Number(realVersions().at(-1));
  return [String(last + 1).padStart(4, '0'), String(last + 2).padStart(4, '0')];
}

function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-mig-empty-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function ledger(c: Client) {
  const r = await c.query(`SELECT version, name, checksum, down_checksum, applied_at FROM public.schema_migrations ORDER BY version`);
  return r.rows;
}

async function relExists(c: Client, qualified: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [qualified]);
  return r.rows[0].e;
}

/** Everything user-visible in the catalog outside system schemas. */
async function catalogSnapshot(c: Client) {
  const sys = `('pg_catalog','information_schema','pg_toast')`;
  const q = async (sql: string) => (await c.query(sql)).rows.map((r) => Object.values(r).join(':'));
  return {
    namespaces: await q(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT IN ${sys} AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%' ORDER BY 1`,
    ),
    relations: await q(
      `SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${sys} AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%' ORDER BY 1,2`,
    ),
    functions: await q(
      `SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ${sys} ORDER BY 1,2`,
    ),
    types: await q(
      `SELECT n.nspname, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname NOT IN ${sys} AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%' ORDER BY 1,2`,
    ),
    policies: await q(`SELECT polname, polrelid::regclass::text FROM pg_policy ORDER BY 1,2`),
    ledgerRows: await q(`SELECT version FROM public.schema_migrations ORDER BY 1`),
  };
}

const EXPECTED_TABLES = [
  'cost_facts',
  'ingest_artifacts',
  'ingest_batches',
  'ingest_validation_errors',
  'outcome_benefit_evidence',
  'outcome_events',
  'outcome_supplemental_costs',
  'outcome_unit_registrations',
  'period_publications',
  'source_checkpoints',
  'sources',
  'sync_runs',
  'tenants',
];

describe('migration runner (real Postgres)', () => {
  it('applies every migration to an empty database and records checksums', async () => {
    const db = await freshDb();
    const c = await connect(db);
    expect(await relExists(c, 'ratio.tenants')).toBe(false);

    const res = await migrateUp(c);
    const files = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(res.applied).toEqual(files.map((f) => f.version));
    expect(res.applied[0]).toBe('0001');

    const rows = await ledger(c);
    expect(rows.map((r) => [r.version, r.name, r.checksum, r.down_checksum])).toEqual(
      files.map((f) => [f.version, f.name, f.checksum, f.downChecksum]),
    );
    expect(rows[0].down_checksum).toMatch(/^[0-9a-f]{64}$/);
    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'ratio' AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
    expect(await relExists(c, 'ratio.cost_facts_published')).toBe(true);
  });

  it('re-running is a no-op (nothing applied, ledger and catalog unchanged)', async () => {
    const db = await freshDb();
    const c = await connect(db);
    await migrateUp(c);
    const before = { ledger: await ledger(c), catalog: await catalogSnapshot(c) };
    const res = await migrateUp(c);
    expect(res.applied).toEqual([]);
    expect(await ledger(c)).toEqual(before.ledger);
    expect(await catalogSnapshot(c)).toEqual(before.catalog);
  });

  it("refuses to run when an applied migration's checksum changed", async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = copyMigrations();
    await migrateUp(c, { dir });
    const before = await ledger(c);

    const upFile = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('0001_') && f.endsWith('.up.sql'))!);
    fs.appendFileSync(upFile, '\n-- tampered after apply\n');
    // A new pending migration must NOT be applied either.
    fs.writeFileSync(path.join(dir, '0002_probe.up.sql'), '-- ratio:phase expand\nCREATE TABLE public.tamper_probe(x int);\n');

    await expect(migrateUp(c, { dir })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(await ledger(c)).toEqual(before);
    expect(await relExists(c, 'public.tamper_probe')).toBe(false);
  });

  it("refuses when an applied migration's down file changed or disappeared", async () => {
    for (const mutate of ['edit', 'remove'] as const) {
      const db = await freshDb();
      const c = await connect(db);
      const dir = copyMigrations();
      await migrateUp(c, { dir });
      const before = await ledger(c);
      const downFile = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('0001_') && f.endsWith('.down.sql'))!);
      if (mutate === 'edit') fs.appendFileSync(downFile, '\n-- tampered down after apply\n');
      else fs.rmSync(downFile);
      fs.writeFileSync(path.join(dir, '0002_probe.up.sql'), '-- ratio:phase expand\nCREATE TABLE public.down_tamper_probe(x int);\n');
      await expect(migrateUp(c, { dir }), mutate).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
      expect(await ledger(c)).toEqual(before);
      expect(await relExists(c, 'public.down_tamper_probe')).toBe(false);
    }
  });

  it("refuses when an applied migration's file is missing", async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = copyMigrations();
    await migrateUp(c, { dir });
    for (const f of fs.readdirSync(dir)) if (f.startsWith('0001_')) fs.rmSync(path.join(dir, f));
    fs.writeFileSync(path.join(dir, '0002_probe.up.sql'), '-- ratio:phase expand\nCREATE TABLE public.missing_probe(x int);\n');
    await expect(migrateUp(c, { dir })).rejects.toMatchObject({ code: 'MISSING_FILE' });
    expect(await relExists(c, 'public.missing_probe')).toBe(false);
  });

  it('refuses an out-of-order pending migration', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = copyMigrations({ '0003_third.up.sql': '-- ratio:phase expand\nCREATE TABLE public.third(x int);\n' });
    expect((await migrateUp(c, { dir })).applied).toEqual(['0001', '0003', ...realVersions().slice(1)]);
    fs.writeFileSync(path.join(dir, '0002_late.up.sql'), '-- ratio:phase expand\nCREATE TABLE public.late(x int);\n');
    await expect(migrateUp(c, { dir })).rejects.toMatchObject({ code: 'OUT_OF_ORDER' });
    expect(await relExists(c, 'public.late')).toBe(false);
    expect((await ledger(c)).map((r) => r.version)).toEqual(['0001', '0003', ...realVersions().slice(1)]);
  });

  it('a failing migration is rolled back completely and stops the run', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = copyMigrations({
      // contract: INSERT/SELECT are outside the expand allow-list.
      '0002_broken.up.sql': '-- ratio:phase contract\nCREATE TABLE public.half_done(x int);\nINSERT INTO public.half_done VALUES (1);\nSELECT 1/0;\n',
      '0003_after.up.sql': '-- ratio:phase expand\nCREATE TABLE public.after_broken(x int);\n',
    });
    await expect(migrateUp(c, { dir, allowContract: true })).rejects.toThrow(/division by zero/);
    expect((await ledger(c)).map((r) => r.version)).toEqual(['0001']);
    expect(await relExists(c, 'public.half_done')).toBe(false);
    expect(await relExists(c, 'public.after_broken')).toBe(false);
    expect(await relExists(c, 'ratio.tenants')).toBe(true);
    // The connection is usable afterwards (no dangling transaction) and the lock was released.
    const lock = await c.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`);
    expect(lock.rows[0].n).toBe(0);
  });

  it('an unmarked migration is refused and nothing is applied', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = copyMigrations({ '0002_unmarked.up.sql': 'CREATE TABLE public.unmarked(x int);\n' });
    await expect(migrateUp(c, { dir })).rejects.toMatchObject({ code: 'MISSING_PHASE' });
    expect(await relExists(c, 'ratio.tenants')).toBe(false);
    expect(await relExists(c, 'public.unmarked')).toBe(false);
  });

  it('a pending contract migration is refused without allowContract and applied with it', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = copyMigrations();
    await migrateUp(c, { dir });
    // Probe versions must sort after the real migration set so they are pending, not out of order.
    const [n1, n2] = nextProbeVersions();
    fs.writeFileSync(path.join(dir, `${n1}_expand.up.sql`), '-- ratio:phase expand\nCREATE TABLE public.legacy(x int);\n');
    fs.writeFileSync(path.join(dir, `${n2}_contract.up.sql`), '-- ratio:phase contract\nDROP TABLE public.legacy;\n');

    // Refused as a whole: the expand migration queued before it is not applied either.
    await expect(migrateUp(c, { dir })).rejects.toMatchObject({ code: 'CONTRACT_NOT_ALLOWED' });
    expect((await ledger(c)).map((r) => r.version)).toEqual(realVersions());
    expect(await relExists(c, 'public.legacy')).toBe(false);

    const res = await migrateUp(c, { dir, allowContract: true });
    expect(res.applied).toEqual([n1, n2]);
    expect(await relExists(c, 'public.legacy')).toBe(false);
  });

  it('two concurrent runners: exactly one applies, the other waits on the lock then no-ops', async () => {
    const db = await freshDb();
    const a = await connect(db);
    const b = await connect(db);
    const observer = await connect(db);
    const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;

    let sawBWaiting = false;
    let releaseB!: () => void;
    const aHoldsLock = new Promise<void>((resolve) => (releaseB = resolve));

    const runA = migrateUp(a, {
      hooks: {
        afterLockAcquired: async () => {
          releaseB(); // let runner B start only once A holds the lock
          // Wait (bounded) until B is observed blocked on the advisory lock.
          for (let i = 0; i < 200 && !sawBWaiting; i++) {
            const r = await observer.query(
              `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = $1`,
              [bPid],
            );
            sawBWaiting = r.rows[0].n === 1;
            if (!sawBWaiting) await new Promise((r2) => setTimeout(r2, 25));
          }
        },
      },
    });
    await aHoldsLock;
    const runB = migrateUp(b);
    const [resA, resB] = await Promise.all([runA, runB]);

    expect(sawBWaiting).toBe(true);
    expect(resA.applied).toEqual(realVersions());
    expect(resB.applied).toEqual([]);
    expect((await ledger(observer)).map((r) => r.version)).toEqual(realVersions());
  });

  it('down 1 returns the database to its pre-migration catalog state, and up re-applies (up/down/up)', async () => {
    const db = await freshDb();
    const c = await connect(db);
    // Bootstrap only the ledger (no migrations) to capture the "empty" state.
    expect((await migrateUp(c, { dir: emptyDir() })).applied).toEqual([]);
    const empty = await catalogSnapshot(c);
    expect(empty.namespaces).not.toContain('ratio');

    // Capture the catalog after only the first migration has applied.
    const firstOnly = copyMigrations();
    for (const f of fs.readdirSync(firstOnly)) if (!f.startsWith('0001_')) fs.rmSync(path.join(firstOnly, f));
    expect((await migrateUp(c, { dir: firstOnly })).applied).toEqual(['0001']);
    const afterFirst = await catalogSnapshot(c);
    expect(afterFirst.namespaces).toContain('ratio');

    await migrateUp(c);
    const down = await migrateDown(c, { steps: 1, env: ALLOW_DOWN });
    expect(down.reverted).toEqual([realVersions().at(-1)]);
    expect(await catalogSnapshot(c)).toEqual(afterFirst);

    expect((await migrateUp(c)).applied).toEqual([realVersions().at(-1)]);
    expect(await relExists(c, 'ratio.cost_facts')).toBe(true);
  });

  it('down is refused without the allow flag and in production; schema untouched', async () => {
    const db = await freshDb();
    const c = await connect(db);
    await migrateUp(c);
    for (const env of [
      {},
      { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test', NODE_ENV: 'production' },
      { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'production' },
      { RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'staging' },
      { RATIO_ALLOW_DOWN_MIGRATIONS: '1' },
    ]) {
      await expect(migrateDown(c, { steps: 1, env })).rejects.toMatchObject({ code: 'DOWN_NOT_ALLOWED' });
    }
    expect(await relExists(c, 'ratio.cost_facts')).toBe(true);
    expect((await ledger(c)).map((r) => r.version)).toEqual(realVersions());
  });

  it('down is refused when a migration has no down file', async () => {
    const db = await freshDb();
    const c = await connect(db);
    const dir = copyMigrations({}, { withDown: false });
    await migrateUp(c, { dir });
    await expect(migrateDown(c, { steps: 1, env: ALLOW_DOWN, dir })).rejects.toMatchObject({ code: 'NO_DOWN' });
    expect(await relExists(c, 'ratio.cost_facts')).toBe(true);
  });

  it('down refuses more steps than applied migrations', async () => {
    const db = await freshDb();
    const c = await connect(db);
    await migrateUp(c);
    await expect(migrateDown(c, { steps: realVersions().length + 1, env: ALLOW_DOWN })).rejects.toMatchObject({ code: 'INVALID_STEPS' });
    expect(await relExists(c, 'ratio.cost_facts')).toBe(true);
  });
});
