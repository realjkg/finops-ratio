// LOCAL role bootstrap for the Ratio stack (run by `npm run local:up`, as the
// local container superuser). LOCAL AND EPHEMERAL ONLY: production role and
// login provisioning is an owner decision (docs/evidence/slice-2/DEPLOYMENT_BRIEF.md, D-04).
//
// What it creates (every step idempotent; re-running changes nothing but the
// passwords, which are re-set from .ratio-local/<project>/env):
//   1. ratio_owner, ratio_worker, ratio_reader — EXACTLY as migration 0001
//      would (NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE, member
//      of nothing). Pre-creating them means the migrator never needs
//      CREATEROLE. 0001's guard (RT010) and the runner's catalog check still
//      verify them on every migration.
//   2. Three LOGIN roles, each with every NO... attribute and exactly ONE
//      membership:
//        ratio_local_migrator IN ROLE ratio_owner  (owns database `ratio`)
//        ratio_local_worker   IN ROLE ratio_worker
//        ratio_local_reader   IN ROLE ratio_reader
//   3. Database `ratio`, owned by the migrator (CREATE SCHEMA and the ledger
//      in `public` need it; Slice 0's REVIEWED_OWNER_PRIVILEGES allow it).
// Nothing is GRANTed to any login on the database or on any object: an
// explicit grant to a ratio-role member would exceed Slice 0's reviewed set.
// Verification: verifyBootstrap() below, then `local:migrate` runs
// `migrate --status --json`, whose catalog check (Slice 0's privilege model)
// must report no privilege problem for these exact logins.

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_ATTRS = 'NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE';
export const RATIO_ROLES = Object.freeze(['ratio_owner', 'ratio_worker', 'ratio_reader']);

function ident(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) throw new Error('bootstrap: identifiers must be plain lower-case names');
  return name;
}

/** The logins and the ratio role each one is a member of. */
export function loginMemberships(names) {
  return [
    [ident(names.migrator), 'ratio_owner'],
    [ident(names.worker), 'ratio_worker'],
    [ident(names.reader), 'ratio_reader'],
  ];
}

const ifMissing = (role, ddl) =>
  `DO $bootstrap$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN ${ddl}; END IF; END $bootstrap$`;

/** Every statement of the bootstrap, in order. No secret is part of the plan. */
export function bootstrapPlan(names) {
  const database = ident(names.database);
  const migrator = ident(names.migrator);
  const plan = [];
  for (const r of RATIO_ROLES) plan.push(ifMissing(r, `CREATE ROLE ${r} NOLOGIN ${SAFE_ATTRS}`));
  for (const [login, parent] of loginMemberships(names)) {
    plan.push(ifMissing(login, `CREATE ROLE ${login} LOGIN ${SAFE_ATTRS} IN ROLE ${parent}`));
    // Re-assert the safe attributes on a login that already existed.
    plan.push(`ALTER ROLE ${login} LOGIN ${SAFE_ATTRS}`);
  }
  // CREATE DATABASE cannot run in a DO block: the runner executes the row this returns (like psql \gexec).
  plan.push(`SELECT 'CREATE DATABASE ${database} OWNER ${migrator}' AS ddl WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = '${database}')`);
  plan.push(`ALTER DATABASE ${database} OWNER TO ${migrator}`);
  return plan;
}

/** Runs the plan on a superuser client, then sets the login passwords (server-side quoting) and verifies. */
export async function runBootstrap(client, names, passwords) {
  for (const sql of bootstrapPlan(names)) {
    const r = await client.query(sql);
    if (/^SELECT 'CREATE DATABASE /.test(sql)) for (const row of r.rows) await client.query(row.ddl);
  }
  for (const [login] of loginMemberships(names)) {
    const password = passwords[login];
    if (typeof password !== 'string' || password.length < 32) throw new Error(`bootstrap: no strong password for ${login}`);
    const f = await client.query(`SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`, [login, password]);
    await client.query(f.rows[0].sql);
  }
  const problems = await verifyBootstrap(client, names);
  if (problems.length) throw new Error(`bootstrap verification failed:\n  ${problems.join('\n  ')}`);
}

/** The bootstrap's own invariants (Slice 0's catalog check is the authoritative one, run by local:migrate). */
export async function verifyBootstrap(client, names) {
  const problems = [];
  const roles = await client.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb
       FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])`,
    [[...RATIO_ROLES, ...loginMemberships(names).map(([l]) => l)]],
  );
  const byName = new Map(roles.rows.map((r) => [r.rolname, r]));
  const expectRole = (name, login) => {
    const r = byName.get(name);
    if (!r) return problems.push(`${name} is missing`);
    if (r.rolcanlogin !== login) problems.push(`${name} must ${login ? '' : 'not '}have LOGIN`);
    for (const a of ['rolsuper', 'rolbypassrls', 'rolreplication', 'rolcreaterole', 'rolcreatedb']) if (r[a]) problems.push(`${name} has ${a}`);
  };
  for (const r of RATIO_ROLES) expectRole(r, false);
  for (const [login] of loginMemberships(names)) expectRole(login, true);
  const edges = await client.query(
    `SELECT m.rolname AS member, g.rolname AS parent
       FROM pg_catalog.pg_auth_members a
       JOIN pg_catalog.pg_roles m ON m.oid = a.member JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
      WHERE m.rolname = ANY ($1::text[]) ORDER BY 1, 2`,
    [[...RATIO_ROLES, ...loginMemberships(names).map(([l]) => l)]],
  );
  const actual = edges.rows.map((e) => `${e.member}->${e.parent}`).sort();
  const expected = loginMemberships(names).map(([l, p]) => `${l}->${p}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`memberships are ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  const db = await client.query(
    `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = $1`,
    [ident(names.database)],
  );
  if (db.rows[0]?.owner !== names.migrator) problems.push(`database ${names.database} must be owned by ${names.migrator}`);
  return problems;
}
