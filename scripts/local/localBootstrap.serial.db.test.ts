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
  for (const r of [names.migrator, names.worker, names.reader]) await c.query(`DROP ROLE IF EXISTS ${r}`);
  const left = await c.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ANY ($1::text[])`, [[names.migrator, names.worker, names.reader]]);
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
