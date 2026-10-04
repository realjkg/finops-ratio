// One pg pool per reader URL (process-wide), with pinned session settings:
//   - search_path = pg_catalog, pg_temp (Slice 0 deployment note, option 2:
//     an owner-planted object in `public` cannot shadow anything; every name
//     the API uses is schema-qualified);
//   - default_transaction_read_only = on;
//   - statement / lock / idle-in-transaction timeouts, so a request can never
//     hold a connection or a lock indefinitely;
//   - TimeZone = UTC, DateStyle = ISO, MDY, IntervalStyle = postgres: the
//     output never depends on a database or role default (Copilot 4176238982;
//     startup options take precedence over ALTER ROLE / ALTER DATABASE
//     defaults, and publishedCosts.ts asserts them in every read).
import { Pool, type PoolConfig } from 'pg';
import { READ_TIMEOUTS } from './readDeadline';

export const READER_SESSION_OPTIONS = [
  '-c search_path=pg_catalog,pg_temp',
  '-c default_transaction_read_only=on',
  // Every transaction starts at REPEATABLE READ: page 1's rows and its totals
  // come from ONE snapshot. A session default (not SET TRANSACTION) because
  // Slice 0's withTenantTransaction runs set_config — a query, which fixes the
  // isolation level — before the callback. The libpq escape keeps the space.
  '-c default_transaction_isolation=repeatable\\ read',
  '-c statement_timeout=10000',
  '-c lock_timeout=5000',
  '-c idle_in_transaction_session_timeout=30000',
  '-c TimeZone=UTC',
  '-c DateStyle=ISO,MDY',
  '-c IntervalStyle=postgres',
].join(' ');

const pools = new Map<string, Pool>();

/**
 * The reader pool's configuration. Client-side deadlines (Copilot 4176494809):
 * query_timeout slightly above the server's statement_timeout, and a connect
 * timeout; the request deadline and the destruction of a stuck client are in
 * readDeadline.ts. `overrides` exist for tests only.
 */
export function readerPoolConfig(url: string, overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: READ_TIMEOUTS.connectMs,
    query_timeout: READ_TIMEOUTS.queryMs,
    idleTimeoutMillis: 10_000,
    application_name: 'ratio-reader-api',
    options: READER_SESSION_OPTIONS,
    ...overrides,
  };
}

export function createReaderPool(url: string, overrides: Partial<PoolConfig> = {}): Pool {
  const pool = new Pool(readerPoolConfig(url, overrides));
  // An idle client's error (e.g. the server terminated it) must never crash
  // the process; the next request simply gets a fresh connection.
  pool.on('error', () => undefined);
  return pool;
}

export function readerPool(url: string): Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = createReaderPool(url);
    pools.set(url, pool);
  }
  return pool;
}

/** Ends every reader pool (tests, graceful shutdown). */
export async function closeReaderPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => undefined)));
}
