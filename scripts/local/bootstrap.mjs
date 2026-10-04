// LOCAL role bootstrap for the Ratio stack (run by `npm run local:up`, as the
// local container superuser). LOCAL AND EPHEMERAL ONLY: production role and
// login provisioning follows D-04 as decided (an admin pre-creates the roles;
// docs/evidence/slice-2/DEPLOYMENT_BRIEF.md, Decision log).
//
// What it creates (every step idempotent; on a correct cluster re-running
// changes nothing but the passwords, which are re-set from
// .ratio-local/<project>/env; a drifted login is normalised back, see
// bootstrapPlan):
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
// The only GRANTs are the three membership re-grants (login -> its ratio role).
// FAIL CLOSED on every other membership (Copilot 4176878790): any edge with a
// managed role (the 3 ratio roles, the 3 logins) on EITHER side that is not
// one of those three - an unexpected member of a ratio role, anything granted
// TO a login, a login or ratio role in any other role (predefined pg_* roles
// named as such), an expected edge from another grantor - fails
// verification. The bootstrap never REVOKEs: a cluster may share roles with
// something else, so removing an edge is left to a person.
// Verification: verifyBootstrap() below, then `local:migrate` runs
// `migrate --status --json`, whose catalog check (Slice 0's privilege model)
// must report no privilege problem for these exact logins.

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_ATTRS = 'NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEDB NOCREATEROLE';
/**
 * The complete attribute set every bootstrap login must have (Copilot
 * 4176705227), normalised on every run and verified against pg_roles:
 * LOGIN, INHERIT (a NOINHERIT login would not receive its ratio role's
 * privileges), none of the dangerous attributes, no connection limit, and no
 * expiry (VALID UNTIL 'infinity'; NULL is accepted too).
 */
export const LOGIN_ATTRIBUTES = Object.freeze({
  rolcanlogin: true,
  rolinherit: true,
  rolsuper: false,
  rolbypassrls: false,
  rolreplication: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolconnlimit: -1,
});
const LOGIN_DDL = `LOGIN INHERIT ${SAFE_ATTRS} CONNECTION LIMIT -1 VALID UNTIL 'infinity'`;
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
    // Normalise a login that already existed: the complete attribute set,
    // no per-role setting, and its one membership edge with the exact PG16
    // options (an edge granted while the login was NOINHERIT keeps
    // inherit_option false; re-granting by the same grantor updates it).
    plan.push(`ALTER ROLE ${login} ${LOGIN_DDL}`);
    plan.push(`ALTER ROLE ${login} RESET ALL`);
    plan.push(`GRANT ${parent} TO ${login} WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
  }
  // CREATE DATABASE cannot run in a DO block: the runner executes the row this returns (like psql \gexec).
  plan.push(`SELECT 'CREATE DATABASE ${database} OWNER ${migrator}' AS ddl WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = '${database}')`);
  plan.push(`ALTER DATABASE ${database} OWNER TO ${migrator}`);
  // Per-role settings scoped to this database (the global ones are reset above).
  for (const [login] of loginMemberships(names)) plan.push(`ALTER ROLE ${login} IN DATABASE ${database} RESET ALL`);
  return plan;
}

/**
 * The exact PG16 shape of every bootstrap membership (login → its one ratio
 * role), as `CREATE ROLE … IN ROLE` creates it on PG16:
 *   - admin_option FALSE: the login cannot grant its ratio role to anyone;
 *   - inherit_option TRUE: the login holds the role's privileges directly
 *     (the reader reads the view, the worker writes, the migrator owns);
 *   - set_option TRUE: PG16's default for IN ROLE; Slice 0's catalog check
 *     reviews it with the rest of the closure.
 */
export const EXPECTED_MEMBERSHIP_OPTIONS = Object.freeze({ admin_option: false, inherit_option: true, set_option: true });

/**
 * Why membership in a predefined role is refused: a mirror of Slice 0's
 * REFUSED_PREDEFINED_ROLES (src/ingest/db/privilegeModel.ts, which this plain
 * node script cannot import). L25 checks every Slice 0 entry against this
 * mirror, so a drift fails. Any other pg_* role is refused too.
 */
const PREDEFINED_ROLE_REASONS = Object.freeze({
  pg_read_server_files: 'reads server files',
  pg_write_server_files: 'writes server files',
  pg_execute_server_program: 'runs programs on the server',
  pg_read_all_data: 'SELECT on every table, view and sequence',
  pg_write_all_data: 'INSERT, UPDATE and DELETE on every table',
  pg_signal_backend: 'cancels or terminates other sessions',
  pg_create_subscription: 'creates logical-replication subscriptions',
  pg_monitor: "reads every session's statements and every setting",
  pg_read_all_stats: "reads every session's statement text (pg_stat_activity.query)",
  pg_read_all_settings: 'reads every setting, including superuser-only ones',
  pg_stat_scan_tables: 'runs monitoring functions that take ACCESS SHARE locks on any table',
});

const predefinedNote = (role) =>
  typeof role === 'string' && role.startsWith('pg_') ? ` (predefined role${PREDEFINED_ROLE_REASONS[role] ? `: ${PREDEFINED_ROLE_REASONS[role]}` : ''})` : '';

/**
 * Problems with EVERY membership row that has a managed role (a ratio role or
 * a login) on either side: exactly one grant per expected login → ratio-role
 * edge, granted by the bootstrap superuser, with exactly
 * EXPECTED_MEMBERSHIP_OPTIONS (a missing option or grantor, e.g. NULL, fails
 * closed), and no other edge at all.
 */
export function membershipProblems(rows, names) {
  const problems = [];
  const expected = new Map(loginMemberships(names).map(([l, p]) => [`${l}->${p}`, { member: l, parent: p }]));
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.member}->${r.parent}`;
    if (!expected.has(key)) {
      problems.push(`membership ${key} is not expected${predefinedNote(r.parent)}`);
      continue;
    }
    seen.set(key, (seen.get(key) ?? 0) + 1);
    // PG16 records any superuser's grant as made by the bootstrap superuser; another grantor means ADMIN delegation.
    if (r.grantor_is_bootstrap_superuser !== true) problems.push(`membership ${key}: granted by ${r.grantor ?? 'unknown'}, expected the bootstrap superuser`);
    for (const [option, want] of Object.entries(EXPECTED_MEMBERSHIP_OPTIONS)) {
      if (r[option] !== want) problems.push(`membership ${key}: ${option} is ${JSON.stringify(r[option] ?? null)}, expected ${want}`);
    }
  }
  for (const key of expected.keys()) {
    const n = seen.get(key) ?? 0;
    if (n === 0) problems.push(`membership ${key} is missing`);
    if (n > 1) problems.push(`membership ${key} has more than one grant (${n}, e.g. from another grantor)`);
  }
  return problems;
}

/**
 * Problems with the bootstrap logins' attributes (rows from pg_roles, with
 * `validity` = 'none' | 'infinity' | 'past' | 'future' computed from
 * rolvaliduntil) and per-role settings (rows from pg_db_role_setting: role,
 * database, setconfig). A NULL or missing attribute fails closed. Settings are
 * reported by KEY only (a value may be a secret).
 */
export function loginAttributeProblems(roleRows, settingRows, names) {
  const problems = [];
  const byName = new Map(roleRows.map((r) => [r.rolname, r]));
  for (const [login] of loginMemberships(names)) {
    const r = byName.get(login);
    if (!r) {
      problems.push(`${login}: missing`);
      continue;
    }
    for (const [attr, want] of Object.entries(LOGIN_ATTRIBUTES)) {
      if (r[attr] !== want) problems.push(`${login}: ${attr} is ${JSON.stringify(r[attr] ?? null)}, expected ${want}`);
    }
    if (r.validity !== 'none' && r.validity !== 'infinity') problems.push(`${login}: VALID UNTIL is ${r.validity ?? 'unknown'}, expected no expiry`);
  }
  const logins = new Set(loginMemberships(names).map(([l]) => l));
  for (const row of settingRows) {
    if (!logins.has(row.role)) continue;
    for (const entry of row.setconfig ?? []) {
      const key = String(entry).split('=')[0];
      problems.push(`${row.role}: per-role setting ${key} (${row.database === '*' ? 'all databases' : `database ${row.database}`}) is not expected`);
    }
  }
  return problems;
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
  if (problems.length) {
    throw new Error(
      `bootstrap verification failed:\n  ${problems.join('\n  ')}\n` +
        'The bootstrap fails closed and revokes nothing: review and remove any unexpected membership yourself, or start a fresh local project (local:down -v).',
    );
  }
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
  // The logins: the complete intended attribute set and no per-role settings (Copilot 4176705227).
  const logins = await client.query(
    `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb, rolconnlimit,
            CASE WHEN rolvaliduntil IS NULL THEN 'none' WHEN rolvaliduntil = 'infinity' THEN 'infinity'
                 WHEN rolvaliduntil <= now() THEN 'past' ELSE 'future' END AS validity
       FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])`,
    [loginMemberships(names).map(([l]) => l)],
  );
  const settings = await client.query(
    `SELECT r.rolname AS role, COALESCE(d.datname, '*') AS database, s.setconfig
       FROM pg_catalog.pg_db_role_setting s
       JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
       LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
      WHERE r.rolname = ANY ($1::text[])`,
    [loginMemberships(names).map(([l]) => l)],
  );
  problems.push(...loginAttributeProblems(logins.rows, settings.rows, names));
  // PG16: one row per grant, with its grantor and ADMIN / INHERIT / SET options
  // (Copilot 4176494789), for EVERY edge with a managed role on either side
  // (Copilot 4176878790: a member-only query missed `GRANT ratio_reader TO x`).
  // Grantor oid 10 is the bootstrap superuser (BOOTSTRAP_SUPERUSERID).
  const edges = await client.query(
    `SELECT m.rolname AS member, g.rolname AS parent, pg_catalog.pg_get_userbyid(a.grantor) AS grantor,
            (a.grantor = 10) AS grantor_is_bootstrap_superuser, a.admin_option, a.inherit_option, a.set_option
       FROM pg_catalog.pg_auth_members a
       JOIN pg_catalog.pg_roles m ON m.oid = a.member JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
      WHERE m.rolname = ANY ($1::text[]) OR g.rolname = ANY ($1::text[]) ORDER BY 1, 2`,
    [[...RATIO_ROLES, ...loginMemberships(names).map(([l]) => l)]],
  );
  problems.push(...membershipProblems(edges.rows, names));
  const db = await client.query(
    `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = $1`,
    [ident(names.database)],
  );
  if (db.rows[0]?.owner !== names.migrator) problems.push(`database ${names.database} must be owned by ${names.migrator}`);
  return problems;
}
