// DB test harness: every test file gets its own freshly created database in
// the cluster named by RATIO_TEST_DATABASE_URL (a superuser URL), optionally
// migrated, and dropped afterwards. Test-only; excluded from the worker build.
import crypto from 'crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { migrateUp } from '../migrate';
import { requireTestDatabaseUrl } from './requireTestDatabaseUrl';

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
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createTestDatabase(opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `ratio_test_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  // Name is generated from [a-z0-9_] only, so quoting it as an identifier is safe.
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = withDatabase(requireTestDatabaseUrl(), name);
  const pool = new Pool({ connectionString: url, max: 5 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await pool.end();
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  };
  try {
    if (opts.migrate) {
      const c = new Client({ connectionString: url });
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
