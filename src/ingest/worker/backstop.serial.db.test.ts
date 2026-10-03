// Self-test of the RUNTIME backstop against dangerous test logins
// (testing/dangerousLoginBackstop.ts, a setup file of the PARALLEL DB config:
// after every test and file it fails the file if this process left a
// ratio_test_* login with a dangerous attribute, or one that is a member of a
// dangerous role, in the cluster).
//
// SERIAL (it must commit such a login to show the backstop fires). Unique
// names carrying this process's pid, dropped afterwards, verified gone.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { requireTestDatabaseUrl } from '../db/testing/requireTestDatabaseUrl';
import { assertNoDangerousTestRoles, backstopProblems, dangerousRoles, dangerousTestRoles, ratioRoleProblems } from '../testing/dangerousLoginBackstop';

let admin: Client;
const created: string[] = [];
const name = (kind: string) => `ratio_test_${kind}_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  admin = new Client({ connectionString: requireTestDatabaseUrl() });
  await admin.connect();
});
afterAll(async () => {
  for (const r of created.reverse()) await admin.query(`DROP ROLE IF EXISTS ${r}`);
  const left = await admin.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1::text[])`, [created]);
  expect(left.rows[0].n).toBe(0);
  await admin.end();
});

describe('runtime backstop against dangerous test logins (serial self-test)', () => {
  it('a clean cluster passes', async () => {
    expect(await dangerousTestRoles(admin, process.pid)).toEqual([]);
    await expect(assertNoDangerousTestRoles(admin, process.pid)).resolves.toBeUndefined();
  });

  for (const attr of ['SUPERUSER', 'BYPASSRLS', 'REPLICATION', 'CREATEROLE', 'CREATEDB']) {
    it(`a ${attr} login of this process makes it fail; dropping it clears it`, async () => {
      const r = name('login');
      await admin.query(`CREATE ROLE ${r} LOGIN ${attr}`);
      created.push(r);
      expect(await dangerousTestRoles(admin, process.pid)).toEqual([r]);
      await expect(assertNoDangerousTestRoles(admin, process.pid)).rejects.toThrow(new RegExp(`dangerous test login.*${r}`));
      await admin.query(`DROP ROLE ${r}`);
      expect(await dangerousTestRoles(admin, process.pid)).toEqual([]);
    });
  }

  it('a plain login that is a member of a dangerous role (GRANT su TO login) makes it fail', async () => {
    const su = `ratio_probe_su_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE ROLE ${su} NOLOGIN SUPERUSER`);
    created.push(su);
    const r = name('login');
    await admin.query(`CREATE ROLE ${r} LOGIN`);
    created.push(r);
    await admin.query(`GRANT ${su} TO ${r}`);
    expect(await dangerousTestRoles(admin, process.pid)).toEqual([r]);
    await admin.query(`DROP ROLE ${r}`);
    await admin.query(`DROP ROLE ${su}`);
  });

  it("another process's dangerous login (different pid) is not attributed to this file", async () => {
    const other = `ratio_test_login_${process.pid + 1_000_000}_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE ROLE ${other} LOGIN BYPASSRLS`);
    created.push(other);
    expect(await dangerousTestRoles(admin, process.pid)).toEqual([]);
    await admin.query(`DROP ROLE ${other}`);
  });
});

// Evasion (challenger Low 1): a dangerous role need not carry the ratio_test_
// prefix or this pid, and the ratio roles themselves can be made dangerous.
describe('runtime backstop: snapshot diff and the ratio roles themselves (serial self-test)', () => {
  it('a dangerous role with ANY name created after the snapshot is reported', async () => {
    const snapshot = await dangerousRoles(admin);
    expect(await backstopProblems(admin, snapshot, process.pid)).toEqual([]);
    const r = `zz_evasive_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE ROLE ${r} LOGIN BYPASSRLS`);
    created.push(r);
    expect((await backstopProblems(admin, snapshot, process.pid)).join('\n')).toMatch(new RegExp(`new dangerous role.*${r}`));
    await admin.query(`DROP ROLE ${r}`);
    expect(await backstopProblems(admin, snapshot, process.pid)).toEqual([]);
  });

  it('a plain login made a member of a server-file role after the snapshot is reported', async () => {
    const snapshot = await dangerousRoles(admin);
    const r = `zz_evasive_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE ROLE ${r} LOGIN IN ROLE pg_read_server_files`);
    created.push(r);
    expect((await backstopProblems(admin, snapshot, process.pid)).join('\n')).toContain(r);
    await admin.query(`DROP ROLE ${r}`);
  });

  for (const attr of ['BYPASSRLS', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'SUPERUSER', 'LOGIN']) {
    it(`ALTER ROLE ratio_worker ${attr} is reported (any attribute on a ratio role)`, async () => {
      const snapshot = await dangerousRoles(admin);
      await admin.query(`ALTER ROLE ratio_worker ${attr}`);
      try {
        expect((await ratioRoleProblems(admin)).join('\n')).toMatch(/ratio_worker/);
        expect((await backstopProblems(admin, snapshot, process.pid)).length).toBeGreaterThan(0);
      } finally {
        await admin.query(`ALTER ROLE ratio_worker NO${attr}`);
      }
      expect(await ratioRoleProblems(admin)).toEqual([]);
    });
  }

  it('a ratio role made a member of another role is reported (no reviewed membership of the ratio roles)', async () => {
    const other = `zz_other_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE ROLE ${other} NOLOGIN`);
    created.push(other);
    await admin.query(`GRANT ${other} TO ratio_reader`);
    try {
      expect((await ratioRoleProblems(admin)).join('\n')).toMatch(new RegExp(`ratio_reader.*member of ${other}`));
    } finally {
      await admin.query(`REVOKE ${other} FROM ratio_reader`);
    }
    expect(await ratioRoleProblems(admin)).toEqual([]);
  });
});

