// DB test harness: every test file gets its own freshly created database in
// the cluster named by RATIO_TEST_DATABASE_URL (a superuser URL), optionally
// migrated, and dropped afterwards. Test-only; excluded from the worker build.
import crypto from 'crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { migrateUp } from '../migrate';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations } from '../migrationFiles';
import { requireTestDatabaseUrl } from './requireTestDatabaseUrl';

/**
 * Fixture migration versions just past the last real one, for tests that inject
 * extra migrations into a copy of the migrations dir. Real migrations keep
 * landing (0002 attribution, then the consumption/outcome/economics slices), so
 * fixtures must never hardcode a version: a file that collides with a real
 * version breaks the loader, and one that reuses a real version's number
 * inherits that version's manifest requirements.
 */
export function fixtureMigrationVersions(count: number): string[] {
  const max = loadMigrations(DEFAULT_MIGRATIONS_DIR).reduce((m, f) => (f.version > m ? f.version : m), '0000');
  const base = Number(max) + 1;
  return Array.from({ length: count }, (_, i) => String(base + i).padStart(4, '0'));
}

export interface TestDatabase {
  name: string;
  url: string;
  /** Superuser pool on the test database (bypasses RLS: use it for seeding and ground truth). */
  pool: Pool;
  /** Closes the pool and drops the database. */
  close(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: requireTestDatabaseUrl() });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Polls pg_stat_activity until no backend is connected to `name` (true) or the
 * timeout elapses (false). Bounded: never waits longer than timeoutMs.
 */
export async function waitForNoBackends(name: string, timeoutMs: number): Promise<boolean> {
  return admin(async (c) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await c.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      if (r.rows[0].n === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((res) => setTimeout(res, 50));
    }
  });
}

const POOL_END_TIMEOUT_MS = 5_000;
const BACKEND_DRAIN_TIMEOUT_MS = 10_000;

export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `ratio_test_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  // Name is generated from [a-z0-9_] only, so quoting it as an identifier is safe.
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = withDatabase(requireTestDatabaseUrl(), name);
  const pool = new Pool({ connectionString: url, max: 5 });
  // Every connection gets an 'error' listener for its whole life (also while
  // checked out), so a backend terminated by DROP DATABASE ... WITH (FORCE)
  // surfaces as a handled error on that client, never as an uncaught exception.
  const ignore = () => undefined;
  pool.on('error', ignore);
  pool.on('connect', (client) => {
    client.on('error', ignore);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // pool.end() resolves before its clients have actually disconnected and
    // never resolves while a client is checked out, so bound it ...
    await Promise.race([
      pool.end().catch(ignore),
      new Promise((res) => setTimeout(res, POOL_END_TIMEOUT_MS).unref()),
    ]);
    // ... then wait (bounded) until the server shows no backend on this DB, so
    // the forced drop below normally has nobody left to terminate.
    await waitForNoBackends(name, BACKEND_DRAIN_TIMEOUT_MS);
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  try {
    if (opts.migrate) {
      const c = new Client({ connectionString: url });
      c.on('error', ignore);
      await c.connect();
      try {
        await migrateUp(c);
      } finally {
        await c.end();
      }
    }
  } catch (e) {
    await close();
    throw e;
  }
  return { name, url, pool, close };
}

export type RatioRole = 'ratio_worker' | 'ratio_reader' | 'ratio_owner';
const ROLES: ReadonlySet<string> = new Set(['ratio_worker', 'ratio_reader', 'ratio_owner']);

/**
 * Runs fn inside a transaction as `role` (SET LOCAL ROLE), with the tenant set
 * transaction-locally (or not at all when null). Always rolls back.
 */
export async function withRole<T>(
  pool: Pool,
  role: RatioRole,
  tenantId: string | null,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  if (!ROLES.has(role)) throw new Error(`unknown role ${role}`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    if (tenantId !== null) await c.query("SELECT set_config('ratio.tenant_id', $1, true)", [tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

export type AttemptResult =
  | { ok: true; rowCount: number; rows: Record<string, unknown>[] }
  | { ok: false; code: string; message: string };

/** Runs one statement inside a savepoint so a failure does not abort the surrounding transaction. */
export async function attempt(c: PoolClient, sql: string, params: unknown[] = []): Promise<AttemptResult> {
  await c.query('SAVEPOINT attempt');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT attempt');
    return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT attempt');
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? 'UNKNOWN', message: err.message ?? String(e) };
  }
}
