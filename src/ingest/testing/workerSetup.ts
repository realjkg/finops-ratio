// Test-only: a migrated per-file database plus a real LOGIN role that is only
// a member of ratio_worker, and a worker pool connected as that login (so every
// library call in the tests is bound by RLS and grants exactly like production).
import type { Pool } from 'pg';
import { createTestDatabase, type TestDatabase } from '../db/testing/harness';
import { createWorkerPool } from '../worker/db';
import { createLogin, type Login } from './db';

export interface WorkerTestDb {
  db: TestDatabase;
  login: Login;
  pool: Pool;
  close(): Promise<void>;
}

export async function workerTestDb(): Promise<WorkerTestDb> {
  const db = await createTestDatabase({ migrate: true });
  const login = await createLogin(db, ['ratio_worker']);
  const pool = createWorkerPool(login.url, { max: 6 });
  return {
    db,
    login,
    pool,
    async close() {
      await pool.end().catch(() => undefined);
      await login.drop();
      await db.close();
    },
  };
}

export const noSleep = { sleep: async () => undefined };
