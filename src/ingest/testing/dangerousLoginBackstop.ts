// RUNTIME backstop against dangerous roles — the real control behind the
// static rule in serialLogins.test.ts. Roles are cluster-global: a committed
// role with SUPERUSER / BYPASSRLS / REPLICATION / CREATEROLE / CREATEDB, or
// one that is (transitively) a member of such a role or of a server-file role
// (pg_read_server_files, pg_write_server_files, pg_execute_server_program),
// makes every concurrent migration, status and doctor check fail. Such tests
// belong in *.serial.db.test.ts.
//
// Checks (backstopProblems):
//   1. SNAPSHOT DIFF, regardless of name or pid: every dangerous role in the
//      cluster now that was not there when the file started (beforeAll);
//   2. this process's ratio_test_*_<pid>_* roles that are dangerous (also
//      catches one that existed before the snapshot was taken);
//   3. the ratio roles themselves: no attribute at all (SUPERUSER, BYPASSRLS,
//      REPLICATION, CREATEROLE, CREATEDB, LOGIN) and no membership in any
//      other role (0001 reviews none).
//
// Wiring: vitest.db.config.ts (parallel phase) runs it after EVERY test and
// after the file; vitest.db.serial.config.ts runs it after the file only
// (serial files may create dangerous roles on purpose, but must leave nothing
// behind). backstopWiring.test.ts fails if either config stops listing it.
//
// Known gap: a dangerous role created AND dropped inside one test is not seen
// (no event trigger exists for roles). Mitigations: the static rule
// (serialLogins.test.ts) flags dangerous DDL and logins in non-serial files;
// Slice 0's catalog checks refuse migrations/status in any concurrent file
// while such a role exists, so the window shows up as a failing neighbour;
// the dangerous tests that need such roles run in the serial phase, alone.
import { Client } from 'pg';
import { requireTestDatabaseUrl } from '../db/testing/requireTestDatabaseUrl';

type Queryable = Pick<Client, 'query'>;

const DANGEROUS_ROLE = `(d.rolsuper OR d.rolbypassrls OR d.rolreplication OR d.rolcreaterole OR d.rolcreatedb
                         OR d.rolname IN ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))`;

/** Every role in the cluster that is dangerous itself or (transitively) a member of a dangerous role. */
export async function dangerousRoles(c: Queryable): Promise<string[]> {
  const r = await c.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_catalog.pg_roles r
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles d
                     WHERE ${DANGEROUS_ROLE}
                       AND (d.oid = r.oid OR pg_catalog.pg_has_role(r.oid, d.oid, 'MEMBER')))
      ORDER BY 1`,
  );
  return r.rows.map((x) => x.rolname);
}

/** This process's dangerous ratio_test_* logins (or roles), by name. */
export async function dangerousTestRoles(c: Queryable, pid: number): Promise<string[]> {
  const r = await c.query<{ rolname: string }>(
    `SELECT r.rolname
       FROM pg_catalog.pg_roles r
      WHERE r.rolname LIKE 'ratio\\_test\\_%' AND r.rolname LIKE $1
        AND (r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreaterole OR r.rolcreatedb
             OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles d
                         WHERE d.oid <> r.oid AND ${DANGEROUS_ROLE}
                           AND pg_catalog.pg_has_role(r.oid, d.oid, 'MEMBER')))
      ORDER BY 1`,
    [`%\\_${pid}\\_%`],
  );
  return r.rows.map((x) => x.rolname);
}

/** Any attribute on, or any membership of, the ratio roles themselves. */
export async function ratioRoleProblems(c: Queryable): Promise<string[]> {
  const attrs = await c.query<{ rolname: string; attrs: string[] }>(
    `SELECT rolname, array_remove(ARRAY[
              CASE WHEN rolsuper THEN 'SUPERUSER' END, CASE WHEN rolbypassrls THEN 'BYPASSRLS' END,
              CASE WHEN rolreplication THEN 'REPLICATION' END, CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
              CASE WHEN rolcreatedb THEN 'CREATEDB' END, CASE WHEN rolcanlogin THEN 'LOGIN' END], NULL) AS attrs
       FROM pg_catalog.pg_roles WHERE rolname IN ('ratio_owner', 'ratio_worker', 'ratio_reader') ORDER BY 1`,
  );
  const out = attrs.rows.filter((x) => x.attrs.length).map((x) => `ratio role ${x.rolname} has ${x.attrs.join(', ')}`);
  const memberships = await c.query<{ member: string; role: string }>(
    `SELECT m.rolname AS member, g.rolname AS role
       FROM pg_catalog.pg_auth_members a
       JOIN pg_catalog.pg_roles m ON m.oid = a.member
       JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
      WHERE m.rolname IN ('ratio_owner', 'ratio_worker', 'ratio_reader') ORDER BY 1, 2`,
  );
  out.push(...memberships.rows.map((x) => `ratio role ${x.member} is a member of ${x.role} (not reviewed)`));
  return out;
}

/** Everything the backstop reports, against a snapshot of dangerousRoles taken when the file started. */
export async function backstopProblems(c: Queryable, snapshot: readonly string[], pid: number): Promise<string[]> {
  const before = new Set(snapshot);
  const out = (await dangerousRoles(c)).filter((r) => !before.has(r)).map((r) => `new dangerous role since the file started: ${r}`);
  out.push(...(await dangerousTestRoles(c, pid)).map((r) => `dangerous test login of this process: ${r}`));
  out.push(...(await ratioRoleProblems(c)));
  return [...new Set(out)];
}

export async function assertNoDangerousTestRoles(c: Queryable, pid: number, snapshot?: readonly string[]): Promise<void> {
  const found = snapshot ? await backstopProblems(c, snapshot, pid) : (await dangerousTestRoles(c, pid)).map((r) => `dangerous test login of this process: ${r}`);
  if (found.length) {
    throw new Error(
      `dangerous test login(s)/role(s) left in the cluster: ${found.join('; ')} — roles are cluster-global and break every ` +
        'concurrent migration; such tests belong in a *.serial.db.test.ts file and must drop what they create',
    );
  }
}

/**
 * Registers the snapshot (beforeAll) and the checks (afterEach when
 * `perTest`, and afterAll). Call from a vitest setup file.
 */
export function installDangerousLoginBackstop(
  hooks: {
    beforeAll(fn: () => Promise<void>): void;
    afterEach(fn: () => Promise<void>): void;
    afterAll(fn: () => Promise<void>): void;
  },
  opts: { perTest: boolean },
): void {
  let client: Client | null = null;
  let snapshot: string[] = [];
  const connect = async (): Promise<Client> => {
    if (!client) {
      client = new Client({ connectionString: requireTestDatabaseUrl(), application_name: 'ratio-dangerous-role-backstop' });
      client.on('error', () => undefined);
      await client.connect();
    }
    return client;
  };
  hooks.beforeAll(async () => {
    snapshot = await dangerousRoles(await connect());
  });
  const check = async () => assertNoDangerousTestRoles(await connect(), process.pid, snapshot);
  if (opts.perTest) hooks.afterEach(check);
  hooks.afterAll(async () => {
    try {
      await check();
    } finally {
      const c = client;
      client = null;
      if (c) await c.end().catch(() => undefined);
    }
  });
}
