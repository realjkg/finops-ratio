// CLI end-to-end against real Postgres, including the machine-readable status
// the deploy pipeline gates on.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './db/testing/harness';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from './db/migrationFiles';
import { main } from './cli';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function freshDb(): Promise<TestDatabase> {
  const db = await createTestDatabase({ migrate: false });
  cleanups.push(() => db.close());
  return db;
}

async function run(argv: string[], env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

interface StatusDoc {
  expectedVersion: string;
  currentVersion: string | null;
  matches: boolean;
  applied: Array<{
    version: string;
    name: string;
    checksum: string;
    downChecksum: string | null;
    appliedAt: string;
    fileChecksum: string | null;
    fileDownChecksum: string | null;
    checksumMatches: boolean;
  }>;
  pending: Array<{ version: string; name: string; phase: string; checksum: string }>;
  unknownApplied: string[];
  problems: string[];
}

function onlyJson(out: string[]): StatusDoc {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]) as StatusDoc;
}

const files = loadMigrations(DEFAULT_MIGRATIONS_DIR);
const latest = files[files.length - 1].version;

describe('ingest CLI (real Postgres)', () => {
  it('--status --json reports pending and exits 3 before migrating', async () => {
    const db = await freshDb();
    const r = await run(['migrate', '--status', '--json'], { RATIO_MIGRATE_DATABASE_URL: db.url });
    expect(r.code).toBe(3);
    const doc = onlyJson(r.out);
    expect(doc).toMatchObject({ expectedVersion: latest, currentVersion: null, matches: false, applied: [], unknownApplied: [] });
    expect(doc.pending.map((p) => [p.version, p.phase, p.checksum])).toEqual(files.map((f) => [f.version, f.phase, f.checksum]));
    expect(doc.problems).toContain('PENDING');
    // Status is read-only: it did not create the ledger.
    const ledger = await db.pool.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    expect(ledger.rows[0].t).toBeNull();
  });

  it('--status --json reports a match and exits 0 after migrating', async () => {
    const db = await freshDb();
    const env = { RATIO_MIGRATE_DATABASE_URL: db.url };
    const up = await run(['migrate'], env);
    expect(up.code).toBe(0);
    for (const line of up.out) expect(() => JSON.parse(line)).not.toThrow();
    expect(up.out.join('\n')).toContain('"0001"');

    const r = await run(['migrate', '--status', '--json'], env);
    expect(r.code).toBe(0);
    const doc = onlyJson(r.out);
    expect(doc).toMatchObject({ expectedVersion: latest, currentVersion: latest, matches: true, pending: [], unknownApplied: [], problems: [] });
    expect(doc.applied.map((a) => [a.version, a.checksum, a.downChecksum, a.fileDownChecksum, a.checksumMatches])).toEqual(
      files.map((f) => [f.version, f.checksum, f.downChecksum, f.downChecksum, true]),
    );
    expect(Number.isNaN(Date.parse(doc.applied[0].appliedAt))).toBe(false);

    // Re-running up is a no-op through the CLI too.
    const again = await run(['migrate'], env);
    expect(again.code).toBe(0);
  });

  it('--status --json exits 3 on checksum drift or unknown applied versions', async () => {
    const db = await freshDb();
    const env = { RATIO_MIGRATE_DATABASE_URL: db.url };
    expect((await run(['migrate'], env)).code).toBe(0);

    await db.pool.query(`UPDATE public.schema_migrations SET checksum = repeat('0', 64) WHERE version = '0001'`);
    let r = await run(['migrate', '--status', '--json'], env);
    expect(r.code).toBe(3);
    let doc = onlyJson(r.out);
    expect(doc.matches).toBe(false);
    expect(doc.problems).toContain('CHECKSUM_MISMATCH');
    expect(doc.applied.find((a) => a.version === '0001')?.checksumMatches).toBe(false);

    await db.pool.query(`UPDATE public.schema_migrations SET checksum = $1 WHERE version = '0001'`, [files[0].checksum]);
    // Drift in the recorded down checksum is a mismatch too.
    await db.pool.query(`UPDATE public.schema_migrations SET down_checksum = repeat('0', 64) WHERE version = '0001'`);
    r = await run(['migrate', '--status', '--json'], env);
    expect(r.code).toBe(3);
    doc = onlyJson(r.out);
    expect(doc.problems).toContain('CHECKSUM_MISMATCH');
    expect(doc.applied.find((a) => a.version === '0001')?.checksumMatches).toBe(false);
    await db.pool.query(`UPDATE public.schema_migrations SET down_checksum = $1 WHERE version = '0001'`, [files[0].downChecksum]);
    await db.pool.query(`INSERT INTO public.schema_migrations (version, name, checksum) VALUES ('9999', 'from_newer_release', repeat('f', 64))`);
    r = await run(['migrate', '--status', '--json'], env);
    expect(r.code).toBe(3);
    doc = onlyJson(r.out);
    expect(doc.unknownApplied).toEqual(['9999']);
    expect(doc.problems).toContain('UNKNOWN_APPLIED');
  });

  it('round 5: --status --json runs the catalog privilege check and exits 3 on privilege drift', async () => {
    const db = await freshDb();
    const env = { RATIO_MIGRATE_DATABASE_URL: db.url };
    expect((await run(['migrate'], env)).code).toBe(0);
    // Drift made outside the runner (e.g. by hand, or a hook): the ledger still matches the files.
    await db.pool.query(`GRANT SELECT ON ratio.cost_facts TO ratio_reader`);
    const r = await run(['migrate', '--status', '--json'], env);
    expect(r.code).toBe(3);
    const doc = onlyJson(r.out) as StatusDoc & { privilegeProblems?: string[] };
    expect(doc.matches).toBe(false);
    expect(doc.problems).toContain('PRIVILEGE_MODEL_VIOLATION');
    expect(doc.privilegeProblems).toEqual(expect.arrayContaining([expect.stringMatching(/ratio_reader holds relation:ratio\.cost_facts:SELECT/)]));
    expect(doc.applied.every((a) => a.checksumMatches)).toBe(true);
    // Repaired: back to exit 0.
    await db.pool.query(`REVOKE SELECT ON ratio.cost_facts FROM ratio_reader`);
    const ok = await run(['migrate', '--status', '--json'], env);
    expect(ok.code).toBe(0);
    expect(onlyJson(ok.out)).toMatchObject({ matches: true, problems: [], privilegeProblems: [] });
  });

  it('round 6 (Copilot High): a password with JSON metacharacters inside a real pg error is never printed, in any form', async () => {
    const base = new URL(process.env.RATIO_TEST_DATABASE_URL!);
    // The password doubles as the (non-existent) database name, so the server's error
    // message (database "<pw>" does not exist) carries the decoded password verbatim.
    for (const pw of ['ab"cd', 'ef\\gh', 'q"\\"x', 'nl\nz', 'üñí✓"']) {
      const u = new URL(base.toString());
      u.password = encodeURIComponent(pw);
      u.pathname = '/' + encodeURIComponent(pw);
      const url = u.toString();
      for (const argv of [['migrate'], ['migrate', '--status', '--json']]) {
        const r = await run(argv, { RATIO_MIGRATE_DATABASE_URL: url });
        expect(r.code, JSON.stringify(pw)).toBe(1);
        const all = r.out.concat(r.err).join('\n');
        expect(all).toMatch(/does not exist/);
        for (const f of [pw, JSON.stringify(pw).slice(1, -1), encodeURIComponent(pw)]) expect(all, `${JSON.stringify(pw)} as ${JSON.stringify(f)}`).not.toContain(f);
        expect(all).toContain('[redacted]');
        for (const line of r.out.concat(r.err)) expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it('status --json prints exactly one JSON document; plain status logs one line', async () => {
    const db = await freshDb();
    const env = { RATIO_MIGRATE_DATABASE_URL: db.url };
    const json = await run(['migrate', '--status', '--json'], env);
    expect(json.out).toHaveLength(1);
    expect(json.err).toEqual([]);
    const plain = await run(['migrate', '--status'], env);
    expect(plain.code).toBe(3);
    expect(plain.out).toHaveLength(1);
    expect(JSON.parse(plain.out[0])).toMatchObject({ level: 'info', event: 'migrate.status', matches: false });
  });

  it('down via the CLI requires the explicit allow flag and reverts the schema', async () => {
    const db = await freshDb();
    const env = { RATIO_MIGRATE_DATABASE_URL: db.url };
    expect((await run(['migrate'], env)).code).toBe(0);
    const refused = await run(['migrate', '--down', '1'], { ...env, RATIO_ENV: 'test' });
    expect(refused.code).toBe(1);
    expect(refused.out.concat(refused.err).join('\n')).toContain('DOWN_NOT_ALLOWED');

    const ok = await run(['migrate', '--down', '1'], { ...env, RATIO_ENV: 'test', RATIO_ALLOW_DOWN_MIGRATIONS: '1' });
    expect(ok.code).toBe(0);
    const ns = await db.pool.query(`SELECT to_regnamespace('ratio') AS n`);
    expect(ns.rows[0].n).toBeNull();
    const st = await run(['migrate', '--status', '--json'], env);
    expect(st.code).toBe(3);
    expect(onlyJson(st.out).applied).toEqual([]);
  });
});
