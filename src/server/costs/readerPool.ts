// One pg pool per reader URL (process-wide), with pinned session settings:
//   - search_path = pg_catalog, pg_temp (Slice 0 deployment note, option 2:
//     an owner-planted object in `public` cannot shadow anything; every name
//     the API uses is schema-qualified);
//   - default_transaction_read_only = on;
//   - statement / lock / idle-in-transaction timeouts, so a request can never
//     hold a connection or a lock indefinitely;
//   - timezone = UTC.
import { Pool } from 'pg';

export const READER_SESSION_OPTIONS = [
  '-c search_path=pg_catalog,pg_temp',
  '-c default_transaction_read_only=on',
  '-c statement_timeout=10000',
  '-c lock_timeout=5000',
  '-c idle_in_transaction_session_timeout=30000',
  '-c timezone=UTC',
].join(' ');

const pools = new Map<string, Pool>();

export function readerPool(url: string): Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      application_name: 'ratio-reader-api',
      options: READER_SESSION_OPTIONS,
    });
    // An idle client's error (e.g. the server terminated it) must never crash
    // the process; the next request simply gets a fresh connection.
    pool.on('error', () => undefined);
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
