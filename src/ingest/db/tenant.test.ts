import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { withTenantTransaction } from './tenant';

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';

function fakePool() {
  const log: Array<{ sql: string; params?: unknown[] }> = [];
  let released = 0;
  let connects = 0;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released += 1;
    },
  };
  const pool = {
    connect: async () => {
      connects += 1;
      return client;
    },
  } as unknown as Pool;
  return { pool, log, released: () => released, connects: () => connects };
}

describe('withTenantTransaction', () => {
  it('rejects non-uuid tenant ids before touching the database', async () => {
    const bad = ['', 'abc', "x'; DROP TABLE ratio.tenants; --", ` ${TENANT}`, `${TENANT} `, TENANT.slice(0, -1), `{${TENANT}}`];
    for (const id of bad) {
      const f = fakePool();
      await expect(withTenantTransaction(f.pool, id, async () => 1), JSON.stringify(id)).rejects.toThrow(/tenant/i);
      expect(f.connects()).toBe(0);
      expect(f.log).toEqual([]);
    }
  });

  it('sets the tenant with a bound, transaction-local set_config and commits', async () => {
    const f = fakePool();
    const result = await withTenantTransaction(f.pool, TENANT, async (c) => {
      await c.query('SELECT 42');
      return 'done';
    });
    expect(result).toBe('done');
    expect(f.log.map((l) => l.sql)).toEqual([
      'BEGIN',
      "SELECT set_config('ratio.tenant_id', $1, true)",
      'SELECT 42',
      'COMMIT',
    ]);
    expect(f.log[1].params).toEqual([TENANT]);
    expect(f.released()).toBe(1);
  });

  it('rolls back and releases on error', async () => {
    const f = fakePool();
    await expect(
      withTenantTransaction(f.pool, TENANT, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(f.log.map((l) => l.sql)).toEqual(['BEGIN', "SELECT set_config('ratio.tenant_id', $1, true)", 'ROLLBACK']);
    expect(f.released()).toBe(1);
  });
});
