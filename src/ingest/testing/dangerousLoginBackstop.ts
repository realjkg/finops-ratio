// RUNTIME backstop against dangerous test logins — the real control behind the
// static rule in serialLogins.test.ts. Roles are cluster-global: a committed
// ratio_test_* login with SUPERUSER / BYPASSRLS / REPLICATION / CREATEROLE /
// CREATEDB, or one that is (transitively) a member of a role with any of them,
// makes every concurrent migration, status and doctor check fail. Such tests
// belong in *.serial.db.test.ts.
//
// Used as a setup file of the PARALLEL DB config (vitest.db.config.ts): after
// every test and after the file, it queries the cluster for such logins whose
// name carries this test process's pid (createLogin names them
// ratio_test_<kind>_<pid>_<hex>) and fails the file if any exist. Serial files
// are not covered (vitest.db.serial.config.ts has no such setup file).
import { Client } from 'pg';
import { requireTestDatabaseUrl } from '../db/testing/requireTestDatabaseUrl';

type Queryable = Pick<Client, 'query'>;

/** This process's dangerous ratio_test_* logins (or roles), by name. */
export async function dangerousTestRoles(c: Queryable, pid: number): Promise<string[]> {
  const r = await c.query<{ rolname: string }>(
    `SELECT r.rolname
       FROM pg_catalog.pg_roles r
      WHERE r.rolname LIKE 'ratio\\_test\\_%' AND r.rolname LIKE $1
        AND (r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreaterole OR r.rolcreatedb
             OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles d
                         WHERE d.oid <> r.oid
                           AND (d.rolsuper OR d.rolbypassrls OR d.rolreplication OR d.rolcreaterole OR d.rolcreatedb)
                           AND pg_catalog.pg_has_role(r.oid, d.oid, 'MEMBER')))
      ORDER BY 1`,
    [`%\\_${pid}\\_%`],
  );
  return r.rows.map((x) => x.rolname);
}

export async function assertNoDangerousTestRoles(c: Queryable, pid: number): Promise<void> {
  const found = await dangerousTestRoles(c, pid);
  if (found.length) {
    throw new Error(
      `dangerous test login(s) committed by a NON-serial DB test file: ${found.join(', ')} — ` +
        'roles are cluster-global and break every concurrent migration; move the test to a *.serial.db.test.ts file',
    );
  }
}

/** Registers the per-test and per-file checks (call from a vitest setup file). */
export function installDangerousLoginBackstop(hooks: { afterEach(fn: () => Promise<void>): void; afterAll(fn: () => Promise<void>): void }): void {
  let client: Client | null = null;
  const check = async () => {
    if (!client) {
      client = new Client({ connectionString: requireTestDatabaseUrl(), application_name: 'ratio-dangerous-login-backstop' });
      client.on('error', () => undefined);
      await client.connect();
    }
    await assertNoDangerousTestRoles(client, process.pid);
  };
  hooks.afterEach(check);
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
