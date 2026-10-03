// Round 16 (challenger round 15, L2): the seed fixture checks its own COMMIT
// tag. If anything inside the seed transaction failed and was swallowed,
// PostgreSQL answers COMMIT with ROLLBACK; the fixture must then throw rather
// than hand tests a fixture whose rows were never written.
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { seedTwoTenants } from './fixtures';

function fakePool(commitTag: string) {
  const sqls: string[] = [];
  let released = 0;
  const client = {
    query: async (sql: string) => {
      sqls.push(sql);
      return { rows: [{ s: '0' }], rowCount: 1, command: sql === 'COMMIT' ? commitTag : sql.trim().split(/\s+/)[0].toUpperCase() };
    },
    release: () => {
      released += 1;
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, sqls, released: () => released };
}

describe('seed fixture COMMIT tag', () => {
  it('a COMMIT answered with ROLLBACK makes the seed throw (nothing was written)', async () => {
    const f = fakePool('ROLLBACK');
    await expect(seedTwoTenants(f.pool)).rejects.toMatchObject({ code: 'TRANSACTION_ROLLED_BACK' });
    expect(f.released()).toBe(1);
  });

  it('positive control: a COMMIT answered with COMMIT returns both fixtures', async () => {
    const f = fakePool('COMMIT');
    const seeded = await seedTwoTenants(f.pool);
    expect(seeded.a.tenantId).not.toBe(seeded.b.tenantId);
    expect(f.sqls.filter((s) => s === 'COMMIT')).toHaveLength(2);
  });
});
