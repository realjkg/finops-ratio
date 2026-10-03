// Worker authorization with DANGEROUS logins (A1): a BYPASSRLS member of
// ratio_worker, and a ratio_worker member that can SET ROLE to a SUPERUSER role.
//
// SERIAL test file (vitest.db.serial.config.ts, run by `npm run test:db` after
// the parallel phase): the logins must be COMMITTED to connect, roles are
// cluster-global, and while they exist every migration / status / doctor check
// in the cluster is (correctly) refused — so nothing else may run meanwhile.
// Unique names, dropped afterwards, verified gone.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing/harness';
import { assertSafeWorkerRole, createWorkerPool } from './db';
import { createLogin, type Login } from '../testing/db';

let db: TestDatabase;
const logins: Login[] = [];
const extraRoles: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
});
afterAll(async () => {
  for (const l of logins) await l.drop();
  for (const r of extraRoles) await db.pool.query(`DROP ROLE IF EXISTS ${r}`);
  const left = await db.pool.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1::text[])`, [[...logins.map((l) => l.name), ...extraRoles]]);
  expect(left.rows[0].n).toBe(0);
  await db.close();
});

async function check(url: string) {
  const pool = createWorkerPool(url, { max: 1 });
  try {
    await assertSafeWorkerRole(pool);
  } finally {
    await pool.end();
  }
}

describe('worker refuses dangerous database roles (serial)', () => {
  it('A1 refuses a BYPASSRLS login even if it is a ratio_worker member', async () => {
    const l = await createLogin(db, ['ratio_worker'], ['BYPASSRLS']);
    logins.push(l);
    await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
  });

  it('A1 refuses a login that can SET ROLE to a superuser role', async () => {
    const su = `ratio_test_su_${crypto.randomBytes(4).toString('hex')}`;
    await db.pool.query(`CREATE ROLE ${su} NOLOGIN SUPERUSER`);
    extraRoles.push(su);
    const l = await createLogin(db, ['ratio_worker']);
    logins.push(l);
    await db.pool.query(`GRANT ${su} TO ${l.name}`);
    await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
  });
});
