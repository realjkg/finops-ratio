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

async function check(url: string): Promise<void> {
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

  for (const attr of ['REPLICATION', 'CREATEROLE', 'CREATEDB']) {
    it(`A1 refuses a ${attr} login even if it is a ratio_worker member`, async () => {
      const l = await createLogin(db, ['ratio_worker'], [attr]);
      logins.push(l);
      await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
    });

    it(`A1 refuses a ratio_worker login that can assume a ${attr} role`, async () => {
      const role = `ratio_test_unsafe_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
      await db.pool.query(`CREATE ROLE ${role} NOLOGIN ${attr}`);
      extraRoles.push(role);
      const l = await createLogin(db, ['ratio_worker']);
      logins.push(l);
      await db.pool.query(`GRANT ${role} TO ${l.name}`);
      await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
    });
  }

  for (const role of ['pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program']) {
    it(`A1 refuses a ratio_worker login that can assume ${role}`, async () => {
      const l = await createLogin(db, ['ratio_worker']);
      logins.push(l);
      await db.pool.query(`GRANT ${role} TO ${l.name}`);
      await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE' });
    });
  }

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

// PR #54 fifth Copilot review H1: the same refusals as Slice 0's member audit
// (attributes SUPERUSER/BYPASSRLS/REPLICATION/CREATEROLE/CREATEDB, and the
// refused predefined roles), held directly or reachable over ANY membership
// edge (inherit, SET-only, ADMIN-only, transitive).
describe('worker refuses the member-audit set over the full membership closure (serial)', () => {
  const role = async (attrs: string) => {
    const r = `ratio_test_r_${crypto.randomBytes(4).toString('hex')}`;
    await db.pool.query(`CREATE ROLE ${r} NOLOGIN ${attrs}`);
    extraRoles.push(r);
    return r;
  };
  const login = async (attrs: string[] = []) => {
    const l = await createLogin(db, ['ratio_worker'], attrs);
    logins.push(l);
    return l;
  };

  for (const attr of ['REPLICATION', 'CREATEROLE', 'CREATEDB']) {
    it(`refuses a ratio_worker login that holds ${attr} itself`, async () => {
      const l = await login([attr]);
      await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE', message: expect.stringContaining(attr) });
    });
  }

  for (const [edge, grant] of [
    ['an INHERIT edge', ''],
    ['a SET-only edge', ' WITH INHERIT FALSE, SET TRUE'],
    ['an ADMIN-only edge', ' WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'],
  ] as const) {
    for (const attr of ['REPLICATION', 'CREATEROLE', 'CREATEDB']) {
      it(`refuses a login that reaches a ${attr} role over ${edge}`, async () => {
        const r = await role(attr);
        const l = await login();
        await db.pool.query(`GRANT ${r} TO ${l.name}${grant}`);
        await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE', message: expect.stringContaining(attr) });
      });
    }
  }

  it('refuses a login that reaches a CREATEROLE role transitively (login -> plain role -> CREATEROLE role)', async () => {
    const top = await role('CREATEROLE');
    const mid = await role('');
    await db.pool.query(`GRANT ${top} TO ${mid} WITH INHERIT FALSE, SET TRUE`);
    const l = await login();
    await db.pool.query(`GRANT ${mid} TO ${l.name}`);
    await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE', message: expect.stringContaining('CREATEROLE') });
  });

  for (const [edge, grant] of [
    ['an INHERIT edge', ''],
    ['a SET-only edge', ' WITH INHERIT FALSE, SET TRUE'],
    ['an ADMIN-only edge', ' WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'],
  ] as const) {
    it(`refuses a login that reaches a refused predefined role (pg_read_server_files) over ${edge}`, async () => {
      const l = await login();
      await db.pool.query(`GRANT pg_read_server_files TO ${l.name}${grant}`);
      await expect(check(l.url)).rejects.toMatchObject({ code: 'UNSAFE_DB_ROLE', message: expect.stringContaining('pg_read_server_files') });
    });
  }

  it('still accepts a ratio_worker login that is also a member of a harmless role (no over-refusal)', async () => {
    const r = await role('');
    const l = await login();
    await db.pool.query(`GRANT ${r} TO ${l.name}`);
    await expect(check(l.url)).resolves.toBeUndefined();
  });
});

