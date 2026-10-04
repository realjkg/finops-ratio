// The local role bootstrap (scripts/local/bootstrap.mjs) against a real
// PostgreSQL 16, with PRE-EXISTING logins in a wrong state (Copilot
// 4176705227): every wrong attribute is either normalised by runBootstrap, or
// verifyBootstrap fails. SERIAL test file: it commits role attributes and
// per-role settings on its own uniquely named logins (cluster-global state),
// including dangerous ones, then drops them and verifies they are gone.
import crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireTestDatabaseUrl } from '../../src/ingest/db/testing/requireTestDatabaseUrl';
import { runBootstrap, verifyBootstrap } from './bootstrap.mjs';

const sfx = crypto.randomBytes(4).toString('hex');
const names = {
  database: `ratio_bs_db_${sfx}`,
  migrator: `ratio_bs_m_${sfx}`,
  worker: `ratio_bs_w_${sfx}`,
  reader: `ratio_bs_r_${sfx}`,
};
// Roles OUTSIDE the bootstrap's set, used to plant unexpected memberships (Copilot 4176878790).
const extra = { login: `ratio_bs_x_${sfx}`, role: `ratio_bs_y_${sfx}`, delegate: `ratio_bs_d_${sfx}` };
const pw = () => crypto.randomBytes(32).toString('base64url');
let c: Client;

beforeAll(async () => {
  c = new Client({ connectionString: requireTestDatabaseUrl(process.env) });
  await c.connect();
  // The ratio roles exist in a migrated cluster; make sure (as 0001 would) for a fresh one.
  for (const r of ['ratio_owner', 'ratio_worker', 'ratio_reader']) {
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$`);
  }
  // Pre-existing logins, each with wrong attributes / settings.
  await c.query(`CREATE ROLE ${names.migrator} LOGIN NOINHERIT SUPERUSER CONNECTION LIMIT 0 IN ROLE ratio_owner`);
  await c.query(`CREATE ROLE ${names.worker} LOGIN CREATEDB CREATEROLE VALID UNTIL '2000-01-01' IN ROLE ratio_worker`);
  await c.query(`ALTER ROLE ${names.worker} SET search_path = public`);
  await c.query(`CREATE DATABASE ${names.database}`);
  await c.query(`CREATE ROLE ${names.reader} NOLOGIN BYPASSRLS REPLICATION IN ROLE ratio_reader`);
  await c.query(`ALTER ROLE ${names.reader} IN DATABASE ${names.database} SET statement_timeout = 1`);
});

afterAll(async () => {
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [names.database]);
  await c.query(`DROP DATABASE IF EXISTS ${names.database}`);
  await dropDelegate();
  for (const r of [extra.login, extra.role, names.migrator, names.worker, names.reader]) await c.query(`DROP ROLE IF EXISTS ${r}`);
  const all = [extra.login, extra.role, extra.delegate, names.migrator, names.worker, names.reader];
  const left = await c.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1::text[])`, [all]);
  expect(left.rows[0].n).toBe(0);
  await c.end();
});

describe('local bootstrap on pre-existing logins with wrong attributes (Copilot 4176705227)', () => {
  it('verifyBootstrap reports every wrong attribute and setting before the bootstrap', async () => {
    const problems = (await verifyBootstrap(c, names)).join('\n');
    for (const expected of [
      `${names.migrator}: rolinherit`,
      `${names.migrator}: rolsuper`,
      `${names.migrator}: rolconnlimit`,
      `${names.worker}: rolcreatedb`,
      `${names.worker}: rolcreaterole`,
      `${names.worker}: VALID UNTIL`,
      `${names.worker}: per-role setting search_path`,
      `${names.reader}: rolcanlogin`,
      `${names.reader}: rolbypassrls`,
      `${names.reader}: rolreplication`,
      `${names.reader}: per-role setting statement_timeout`,
    ]) {
      expect(problems).toContain(expected);
    }
    expect(problems).not.toMatch(/=public|= ?1\b/);
  });

  it('runBootstrap normalises all of it; afterwards the logins have exactly the intended attributes and no per-role settings', async () => {
    await runBootstrap(c, names, { [names.migrator]: pw(), [names.worker]: pw(), [names.reader]: pw() });
    expect(await verifyBootstrap(c, names)).toEqual([]);
    const r = await c.query(
      `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb, rolconnlimit,
              (rolvaliduntil IS NULL OR rolvaliduntil = 'infinity') AS no_expiry
         FROM pg_roles WHERE rolname = ANY ($1::text[]) ORDER BY rolname`,
      [[names.migrator, names.worker, names.reader]],
    );
    for (const row of r.rows) {
      expect(row, row.rolname).toMatchObject({
        rolcanlogin: true,
        rolinherit: true,
        rolsuper: false,
        rolbypassrls: false,
        rolreplication: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolconnlimit: -1,
        no_expiry: true,
      });
    }
    const settings = await c.query(
      `SELECT count(*)::int AS n FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = ANY ($1::text[])`,
      [[names.migrator, names.worker, names.reader]],
    );
    expect(settings.rows[0].n).toBe(0);
  });
});

/** Removes the delegate role and every grant it made (it may be the grantor of the worker's edge). */
async function dropDelegate() {
  const r = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [extra.delegate]);
  if (!r.rowCount) return;
  const granted = await c.query(
    `SELECT pg_get_userbyid(roleid) AS parent, pg_get_userbyid(member) AS member FROM pg_auth_members WHERE grantor = $1::regrole`,
    [extra.delegate],
  );
  for (const g of granted.rows) await c.query(`REVOKE ${g.parent} FROM ${g.member} GRANTED BY ${extra.delegate}`);
  await c.query(`DROP ROLE ${extra.delegate}`);
}

/** The edge rows (member->parent) that touch `role`, either side. */
async function edgesOf(role: string): Promise<string[]> {
  const r = await c.query(
    `SELECT pg_get_userbyid(member) || '->' || pg_get_userbyid(roleid) AS e FROM pg_auth_members
      WHERE member = $1::regrole OR roleid = $1::regrole ORDER BY 1`,
    [role],
  );
  return r.rows.map((x) => x.e);
}

/** Fail closed: verification names the problem, runBootstrap refuses, and the planted edge is NOT revoked. */
async function expectFailClosed(problem: string, planted: string, plantedOn: string) {
  expect((await verifyBootstrap(c, names)).join('\n')).toContain(problem);
  await expect(runBootstrap(c, names, { [names.migrator]: pw(), [names.worker]: pw(), [names.reader]: pw() })).rejects.toThrow(problem);
  expect(await edgesOf(plantedOn)).toContain(planted);
}

describe('memberships touching a managed role, on EITHER side, fail closed (Copilot 4176878790)', () => {
  it('an unrelated login made a member of ratio_reader fails verification; the bootstrap refuses and revokes nothing', async () => {
    await c.query(`CREATE ROLE ${extra.login} LOGIN`);
    await c.query(`GRANT ratio_reader TO ${extra.login}`);
    try {
      await expectFailClosed(`membership ${extra.login}->ratio_reader is not expected`, `${extra.login}->ratio_reader`, extra.login);
    } finally {
      await c.query(`DROP ROLE ${extra.login}`);
    }
    expect(await verifyBootstrap(c, names)).toEqual([]);
  });

  it('an unrelated role made a member of the local reader login fails verification', async () => {
    await c.query(`CREATE ROLE ${extra.role} NOLOGIN`);
    await c.query(`GRANT ${names.reader} TO ${extra.role}`);
    try {
      await expectFailClosed(`membership ${extra.role}->${names.reader} is not expected`, `${extra.role}->${names.reader}`, extra.role);
    } finally {
      await c.query(`DROP ROLE ${extra.role}`);
    }
    expect(await verifyBootstrap(c, names)).toEqual([]);
  });

  it('a local login made a member of pg_read_all_data fails verification, named as a predefined role', async () => {
    await c.query(`GRANT pg_read_all_data TO ${names.reader}`);
    try {
      await expectFailClosed(`membership ${names.reader}->pg_read_all_data is not expected (predefined role`, `${names.reader}->pg_read_all_data`, names.reader);
    } finally {
      await c.query(`REVOKE pg_read_all_data FROM ${names.reader}`);
    }
    expect(await verifyBootstrap(c, names)).toEqual([]);
  });

  it("the worker's edge granted through ADMIN delegation (grantor not the bootstrap superuser) fails, as does the delegate's own edge", async () => {
    await c.query(`CREATE ROLE ${extra.delegate} NOLOGIN`);
    await c.query(`GRANT ratio_worker TO ${extra.delegate} WITH ADMIN TRUE`);
    await c.query(`REVOKE ratio_worker FROM ${names.worker}`);
    await c.query(`SET ROLE ${extra.delegate}`);
    try {
      await c.query(`GRANT ratio_worker TO ${names.worker}`);
    } finally {
      await c.query('RESET ROLE');
    }
    try {
      const problems = (await verifyBootstrap(c, names)).join('\n');
      expect(problems).toContain(`membership ${extra.delegate}->ratio_worker is not expected`);
      await expectFailClosed(`membership ${names.worker}->ratio_worker: granted by ${extra.delegate}, expected the bootstrap superuser`, `${names.worker}->ratio_worker`, names.worker);
    } finally {
      // Back to the bootstrap's own edge: drop the delegated grant (and any re-grant the refused run made), then re-grant as the superuser.
      await dropDelegate();
      await c.query(`REVOKE ratio_worker FROM ${names.worker}`).catch(() => undefined);
      await c.query(`GRANT ratio_worker TO ${names.worker} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
    }
    expect(await verifyBootstrap(c, names)).toEqual([]);
  });
});
