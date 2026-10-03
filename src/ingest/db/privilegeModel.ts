// The reviewed privilege model, checked against the CATALOG (not the SQL text)
// by the migration runner inside every migration's transaction, before COMMIT
// (challenger round 3, M1). The lexical classifier in migrationFiles.ts is
// defence in depth; this is the control that does not depend on parsing SQL.
//
// A migration that legitimately widens what ratio_reader / ratio_worker can
// do must update REVIEWED_PRIVILEGES (or REVIEWED_SECURITY_DEFINER_FUNCTIONS)
// in the same change, so the widening is visible in code review.
import type { ClientBase } from 'pg';
import { MigrationError } from './migrationFiles';
import { FOUNDATION_0001 } from './foundationManifest';
import { loadManifests } from './migrationFiles';
import { SYSTEM_SCHEMAS as SYSTEM_SCHEMA_NAMES, systemBaselineViolations, type SystemBaseline } from './systemBaseline';

/** Inputs of the check that depend on the migrations directory / server (round 14). */
export interface CheckOptions {
  /** Foundation manifests by migration version (default: the shipped migrations directory). */
  manifests?: Record<string, readonly string[]>;
  /** PUBLIC system-schema baseline (default: the generated PostgreSQL 16 baseline). */
  systemBaseline?: SystemBaseline;
}

export type CheckedRole = 'ratio_reader' | 'ratio_worker';
export const RATIO_ROLES = ['ratio_owner', 'ratio_worker', 'ratio_reader'] as const;

/**
 * Every privilege each role may EFFECTIVELY hold in the database (directly,
 * via PUBLIC or via membership), in the form the check reports:
 *   relation:<schema>.<name>:<PRIV>          table-level privilege
 *   relation:<schema>.<name>:<PRIV>(<col>)   column-level privilege not covered by a table-level one
 *   function:<schema>.<name>(<arg types>)    EXECUTE
 *   schema:<name>:<USAGE|CREATE>
 *   database:<CREATE|TEMPORARY|CONNECT>      on the current database
 *   parameter:<name>:<SET|ALTER SYSTEM>      GRANT … ON PARAMETER
 *   foreign_data_wrapper:<name>:USAGE, foreign_server:<name>:USAGE
 *   large_object:<oid>:<PRIV|OWNER>
 *   tablespace:<name>:CREATE                                (round 16)
 *   language:<name>:USAGE, type:<schema>.<name>:USAGE        (round 16; only
 *     when PUBLIC does NOT hold it — PUBLIC holds USAGE on every language and
 *     type by default, so a grant is an extension only beyond PUBLIC)
 * Relations, functions and types count only in schemas the role can use
 * (without USAGE they are unreachable; USAGE itself is checked). pg_catalog
 * and information_schema are the system's and are not checked here (explicit
 * ACL entries there are, see systemAclViolations).
 * "Hold" means: the role itself OR any role in its upward membership closure
 * (every role it can inherit from or SET ROLE to, transitively — round 16 H2).
 */
export const REVIEWED_PRIVILEGES: Readonly<Record<CheckedRole, readonly string[]>> = {
  ratio_reader: [
    'database:CONNECT', // PUBLIC default
    'database:TEMPORARY', // PUBLIC default
    'schema:public:USAGE', // PostgreSQL 15+ default (PUBLIC); nothing in public is granted to the reader
    'schema:ratio:USAGE',
    'relation:ratio.cost_facts_published:SELECT',
    'function:ratio.current_tenant_id()',
  ],
  ratio_worker: [
    'database:CONNECT',
    'database:TEMPORARY',
    'schema:public:USAGE',
    'schema:ratio:USAGE',
    'relation:ratio.tenants:SELECT',
    'relation:ratio.sources:SELECT',
    'relation:ratio.sync_runs:SELECT',
    'relation:ratio.sync_runs:INSERT',
    'relation:ratio.sync_runs:UPDATE',
    'relation:ratio.period_publications:SELECT',
    'relation:ratio.period_publications:INSERT',
    'relation:ratio.period_publications:UPDATE',
    'relation:ratio.source_checkpoints:SELECT',
    'relation:ratio.source_checkpoints:INSERT',
    'relation:ratio.source_checkpoints:UPDATE',
    'relation:ratio.ingest_batches:SELECT',
    'relation:ratio.ingest_batches:INSERT',
    'relation:ratio.ingest_batches:UPDATE',
    'relation:ratio.ingest_batches:DELETE',
    'relation:ratio.ingest_artifacts:SELECT',
    'relation:ratio.ingest_artifacts:INSERT',
    'relation:ratio.ingest_artifacts:DELETE',
    'relation:ratio.ingest_artifacts:UPDATE(row_count)',
    'relation:ratio.ingest_validation_errors:SELECT',
    'relation:ratio.ingest_validation_errors:INSERT',
    'relation:ratio.ingest_validation_errors:DELETE',
    'relation:ratio.cost_facts:SELECT',
    'relation:ratio.cost_facts:INSERT',
    'relation:ratio.cost_facts:DELETE',
    'relation:ratio.cost_facts_published:SELECT',
    'function:ratio.current_tenant_id()',
    'function:ratio.text_looks_secret(text)',
    'function:ratio.jsonb_has_secret_like_key(jsonb)',
    'function:ratio.jsonb_has_secret_like_value(jsonb)',
  ],
};

/**
 * SECURITY DEFINER functions that have been reviewed: `<schema>.<name>(<arg types>)`,
 * each must also be owned by ratio_owner. 0001 defines none.
 */
export const REVIEWED_SECURITY_DEFINER_FUNCTIONS: readonly string[] = [];

/**
 * The only user triggers allowed anywhere in the database (0001's), as
 * `<schema>.<table>:<trigger>:<function schema>.<function>()`; each function
 * must also be owned by ratio_owner in schema ratio. Rules (other than view
 * `_RETURN` rules) and event triggers are never allowed.
 */
export const REVIEWED_TRIGGERS: readonly string[] = [
  'ratio.cost_facts:child_of_staged_batch:ratio.tg_child_of_staged_batch()',
  'ratio.cost_facts:refuse_truncate:ratio.tg_refuse_truncate()',
  'ratio.ingest_artifacts:child_of_staged_batch:ratio.tg_child_of_staged_batch()',
  'ratio.ingest_artifacts:refuse_truncate:ratio.tg_refuse_truncate()',
  'ratio.ingest_batches:batch_lifecycle:ratio.tg_batch_lifecycle()',
  'ratio.ingest_batches:publication_consistency:ratio.tg_publication_consistency()',
  'ratio.ingest_batches:refuse_truncate:ratio.tg_refuse_truncate()',
  'ratio.ingest_validation_errors:child_of_staged_batch:ratio.tg_child_of_staged_batch()',
  'ratio.ingest_validation_errors:refuse_truncate:ratio.tg_refuse_truncate()',
  'ratio.period_publications:publication_consistency:ratio.tg_publication_consistency()',
  'ratio.period_publications:refuse_truncate:ratio.tg_refuse_truncate()',
];

/** Schemas in which PUBLIC must not hold EXECUTE on any function. */
export const NO_PUBLIC_EXECUTE_SCHEMAS: readonly string[] = ['ratio', 'public'];

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_|toast_temp_)'`;
const FN_NAME = `n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'`;

/**
 * Every query below runs with search_path = pg_catalog, pg_temp, so operators
 * and functions a migration put in another schema (or on a session/local
 * search_path) cannot change what the check computes (challenger round 4, L1).
 * Transaction-local: callers run the check inside a transaction.
 */
async function pinSearchPath(client: ClientBase): Promise<void> {
  await client.query(`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`);
}

/**
 * SQL returning (role_oid, priv) for every privilege the roles in `roles` (a
 * CTE with columns oid, role) effectively hold. With ratioOnly, only schema
 * ratio and the relations/functions in it are enumerated.
 */
function privilegeQuery(ratioOnly: boolean): string {
  const nsp = ratioOnly ? `n.nspname = 'ratio'` : SYSTEM_SCHEMAS;
  const extra = ratioOnly
    ? ''
    : `
     UNION ALL
     SELECT ro.oid, 'database:' || pr.p
       FROM roles ro CROSS JOIN (VALUES ('CREATE'), ('TEMPORARY'), ('CONNECT')) pr(p)
      WHERE pg_catalog.has_database_privilege(ro.oid, pg_catalog.current_database(), pr.p)
     UNION ALL
     SELECT ro.oid, 'parameter:' || pa.parname || ':' || pr.p
       FROM roles ro CROSS JOIN pg_catalog.pg_parameter_acl pa CROSS JOIN (VALUES ('SET'), ('ALTER SYSTEM')) pr(p)
      WHERE pg_catalog.has_parameter_privilege(ro.oid, pa.parname, pr.p)
     UNION ALL
     SELECT ro.oid, 'foreign_data_wrapper:' || w.fdwname || ':USAGE'
       FROM roles ro CROSS JOIN pg_catalog.pg_foreign_data_wrapper w
      WHERE pg_catalog.has_foreign_data_wrapper_privilege(ro.oid, w.oid, 'USAGE')
     UNION ALL
     SELECT ro.oid, 'foreign_server:' || sv.srvname || ':USAGE'
       FROM roles ro CROSS JOIN pg_catalog.pg_foreign_server sv
      WHERE pg_catalog.has_server_privilege(ro.oid, sv.oid, 'USAGE')
     UNION ALL
     SELECT ro.oid, 'large_object:' || lo.oid::text || ':OWNER'
       FROM roles ro JOIN pg_catalog.pg_largeobject_metadata lo ON pg_catalog.pg_has_role(ro.oid, lo.lomowner, 'USAGE')
     UNION ALL
     SELECT ro.oid, 'large_object:' || lo.oid::text || ':' || a.privilege_type
       FROM roles ro CROSS JOIN pg_catalog.pg_largeobject_metadata lo
       CROSS JOIN LATERAL pg_catalog.aclexplode(lo.lomacl) a
      WHERE a.grantee = 0 OR pg_catalog.pg_has_role(ro.oid, a.grantee, 'USAGE')
     UNION ALL
     SELECT ro.oid, 'tablespace:' || ts.spcname || ':CREATE'
       FROM roles ro CROSS JOIN pg_catalog.pg_tablespace ts
      WHERE pg_catalog.has_tablespace_privilege(ro.oid, ts.oid, 'CREATE')
     UNION ALL
     SELECT ro.oid, 'language:' || l.lanname || ':USAGE'
       FROM roles ro CROSS JOIN pg_catalog.pg_language l
      WHERE pg_catalog.has_language_privilege(ro.oid, l.oid, 'USAGE')
        AND NOT pg_catalog.has_language_privilege('public', l.oid, 'USAGE')`;
  return `
     schemas AS (
       SELECT n.oid, n.nspname FROM pg_catalog.pg_namespace n WHERE ${nsp}
     ),
     rels AS (
       SELECT c.oid, c.relkind, s.oid AS nsp, s.nspname || '.' || c.relname AS name
       FROM pg_catalog.pg_class c JOIN schemas s ON s.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     )
     SELECT ro.oid, 'schema:' || s.nspname || ':' || pr.p AS priv
       FROM roles ro CROSS JOIN schemas s CROSS JOIN (VALUES ('USAGE'), ('CREATE')) pr(p)
      WHERE pg_catalog.has_schema_privilege(ro.oid, s.oid, pr.p)
     UNION ALL
     SELECT ro.oid, 'relation:' || rl.name || ':' || pr.p
       FROM roles ro CROSS JOIN rels rl
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) pr(p)
      WHERE rl.relkind <> 'S' AND pg_catalog.has_schema_privilege(ro.oid, rl.nsp, 'USAGE')
        AND pg_catalog.has_table_privilege(ro.oid, rl.oid, pr.p)
     UNION ALL
     SELECT ro.oid, 'relation:' || rl.name || ':' || pr.p
       FROM roles ro CROSS JOIN rels rl CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) pr(p)
      WHERE rl.relkind = 'S' AND pg_catalog.has_schema_privilege(ro.oid, rl.nsp, 'USAGE')
        AND pg_catalog.has_sequence_privilege(ro.oid, rl.oid, pr.p)
     UNION ALL
     SELECT ro.oid, 'relation:' || rl.name || ':' || pr.p || '(' || a.attname || ')'
       FROM roles ro CROSS JOIN rels rl
       JOIN pg_catalog.pg_attribute a ON a.attrelid = rl.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) pr(p)
      WHERE rl.relkind <> 'S' AND pg_catalog.has_schema_privilege(ro.oid, rl.nsp, 'USAGE')
        AND NOT pg_catalog.has_table_privilege(ro.oid, rl.oid, pr.p)
        AND pg_catalog.has_column_privilege(ro.oid, rl.oid, a.attnum, pr.p)
     UNION ALL
     SELECT ro.oid, 'function:' || ${FN_NAME}
       FROM roles ro CROSS JOIN pg_catalog.pg_proc p JOIN schemas n ON n.oid = p.pronamespace
      WHERE pg_catalog.has_schema_privilege(ro.oid, n.oid, 'USAGE')
        AND pg_catalog.has_function_privilege(ro.oid, p.oid, 'EXECUTE')
     UNION ALL
     SELECT ro.oid, 'type:' || s.nspname || '.' || t.typname || ':USAGE'
       FROM roles ro CROSS JOIN pg_catalog.pg_type t JOIN schemas s ON s.oid = t.typnamespace
      WHERE NOT (t.typelem <> 0 AND t.typlen = -1) -- array types follow their element type
        AND pg_catalog.has_schema_privilege(ro.oid, s.oid, 'USAGE')
        AND pg_catalog.has_type_privilege(ro.oid, t.oid, 'USAGE')
        AND NOT pg_catalog.has_type_privilege('public', t.oid, 'USAGE')${extra}`;
}

/**
 * (principal oid, priv) for every principal in $1 (oid[]): what the principal
 * itself or ANY role in its upward membership closure holds (round 16 H2).
 * The closure follows every pg_auth_members edge upward, whatever its
 * INHERIT / SET / ADMIN options: an INHERIT edge gives the privileges
 * directly, a SET edge through SET ROLE, an ADMIN edge by granting the role to
 * oneself. has_*_privilege() alone only follows INHERIT edges. Superuser roles
 * in a closure are not enumerated (they hold everything; reaching one is
 * reported by the member-attribute rule).
 */
function closurePrivilegeSql(ratioOnly: boolean): string {
  return `WITH RECURSIVE up(principal, oid) AS (
       SELECT p, p FROM pg_catalog.unnest($1::oid[]) AS p
       UNION
       SELECT up.principal, m.roleid FROM pg_catalog.pg_auth_members m JOIN up ON m.member = up.oid
     ),
     roles AS (
       SELECT DISTINCT up.oid FROM up JOIN pg_catalog.pg_roles r ON r.oid = up.oid WHERE NOT r.rolsuper
     ),
     privs AS (WITH ${privilegeQuery(ratioOnly)})
     SELECT DISTINCT up.principal::text AS principal, pv.priv FROM up JOIN privs pv(oid, priv) ON pv.oid = up.oid`;
}

async function closurePrivileges(client: ClientBase, principals: readonly string[], ratioOnly: boolean): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!principals.length) return out;
  const r = await client.query<{ principal: string; priv: string }>(closurePrivilegeSql(ratioOnly), [principals]);
  for (const row of r.rows) {
    const list = out.get(row.principal) ?? [];
    list.push(row.priv);
    out.set(row.principal, list);
  }
  return out;
}

/** Effective privileges of each checked role that exists, in REVIEWED_PRIVILEGES form. */
export async function effectivePrivileges(client: ClientBase): Promise<Record<CheckedRole, string[]>> {
  await pinSearchPath(client);
  const roles = await client.query<{ oid: string; role: CheckedRole }>(
    `SELECT oid::text AS oid, rolname AS role FROM pg_catalog.pg_roles WHERE rolname IN ('ratio_reader', 'ratio_worker')`,
  );
  const privs = await closurePrivileges(
    client,
    roles.rows.map((r) => r.oid),
    false,
  );
  const out: Record<CheckedRole, string[]> = { ratio_reader: [], ratio_worker: [] };
  for (const { oid, role } of roles.rows) out[role].push(...(privs.get(oid) ?? []));
  return out;
}

/** Role identity and membership invariants (challenger round 4, L2). */
async function roleViolations(client: ClientBase): Promise<string[]> {
  const problems: string[] = [];
  const schemaExists = (await client.query<{ e: boolean }>(`SELECT pg_catalog.to_regnamespace('ratio') IS NOT NULL AS e`)).rows[0].e;
  const roles = await client.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolcanlogin: boolean;
  }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb, rolcanlogin
       FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])`,
    [RATIO_ROLES],
  );
  const byName = new Map(roles.rows.map((r) => [r.rolname, r]));
  for (const name of RATIO_ROLES) {
    const r = byName.get(name);
    if (!r) {
      if (schemaExists) problems.push(`role ${name} does not exist (renamed or dropped) while schema ratio exists`);
      continue;
    }
    if (r.rolsuper || r.rolbypassrls || r.rolreplication) problems.push(`role ${name} must not be SUPERUSER, BYPASSRLS or REPLICATION`);
    if (name !== 'ratio_owner' && (r.rolcreaterole || r.rolcreatedb)) problems.push(`role ${name} must not have CREATEROLE or CREATEDB`);
    if (r.rolcanlogin) problems.push(`role ${name} must not have LOGIN (deployment logins are separate member roles)`);
  }
  // A ratio role is a member of no role (covers pg_read_all_data & co. and each other).
  const memberOf = await client.query<{ member: string; parent: string }>(
    `SELECT r.rolname AS member, g.rolname AS parent
       FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.member JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY ($1::text[]) ORDER BY 1, 2`,
    [RATIO_ROLES],
  );
  for (const { member, parent } of memberOf.rows) problems.push(`role ${member} must not be a member of ${parent}`);
  // Members of a ratio role are LOGIN roles (deployment logins) only.
  const members = await client.query<{ member: string; parent: string }>(
    `SELECT r.rolname AS member, g.rolname AS parent
       FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.member JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
      WHERE g.rolname = ANY ($1::text[]) AND NOT r.rolcanlogin ORDER BY 1, 2`,
    [RATIO_ROLES],
  );
  for (const { member, parent } of members.rows) problems.push(`role ${member} is a NOLOGIN member of ${parent}`);
  // Attributes of every member, DIRECT OR TRANSITIVE (pg_auth_members graph —
  // not pg_has_role, which is true for every superuser), of a ratio role
  // (round 15). A BYPASSRLS member inherits e.g. the worker's base-table grants
  // and ignores FORCE RLS; a SUPERUSER member is everything. Members of
  // ratio_worker / ratio_reader: none of SUPERUSER, BYPASSRLS, REPLICATION,
  // CREATEROLE, CREATEDB. Members of ratio_owner (the migrator login):
  // CREATEROLE / CREATEDB are allowed (first-time role creation, a deployment
  // decision), SUPERUSER / BYPASSRLS / REPLICATION are not.
  const transitive = await client.query<{
    member: string;
    parent: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
  }>(
    `WITH RECURSIVE ratio AS (SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])),
          mem(member, top) AS (
            SELECT m.member, r.rolname FROM pg_catalog.pg_auth_members m JOIN ratio r ON r.oid = m.roleid
            UNION
            SELECT m.member, mem.top FROM pg_catalog.pg_auth_members m JOIN mem ON m.roleid = mem.member
          )
     SELECT DISTINCT rr.rolname AS member, mem.top AS parent, rr.rolsuper, rr.rolbypassrls, rr.rolreplication, rr.rolcreaterole, rr.rolcreatedb
       FROM mem JOIN pg_catalog.pg_roles rr ON rr.oid = mem.member
      ORDER BY 1, 2`,
    [RATIO_ROLES],
  );
  for (const m of transitive.rows) {
    const bad: string[] = [];
    if (m.rolsuper) bad.push('SUPERUSER');
    if (m.rolbypassrls) bad.push('BYPASSRLS');
    if (m.rolreplication) bad.push('REPLICATION');
    if (m.parent !== 'ratio_owner' && m.rolcreaterole) bad.push('CREATEROLE');
    if (m.parent !== 'ratio_owner' && m.rolcreatedb) bad.push('CREATEDB');
    for (const attr of bad) problems.push(`role ${m.member} (member of ${m.parent}) must not be ${attr}`);
  }
  // Roles a member must not be able to reach by membership (round 16 H2): an
  // INHERIT / SET / ADMIN path to a SUPERUSER, BYPASSRLS or REPLICATION role
  // (CREATEROLE / CREATEDB too for worker/reader members) is the attribute
  // itself; the predefined roles in REFUSED_PREDEFINED_ROLES act outside (or
  // across) the per-object ACLs (round 16: server files/programs; round 17:
  // pg_read/write_all_data, pg_signal_backend, pg_create_subscription;
  // round 18: pg_monitor, pg_read_all_stats, pg_read_all_settings).
  const reach = await client.query<{
    member: string;
    parent: string;
    target: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolreplication: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
  }>(
    `WITH RECURSIVE ratio AS (SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])),
          mem(member, top) AS (
            SELECT m.member, r.rolname FROM pg_catalog.pg_auth_members m JOIN ratio r ON r.oid = m.roleid
            UNION
            SELECT m.member, mem.top FROM pg_catalog.pg_auth_members m JOIN mem ON m.roleid = mem.member
          ),
          up(member, top, oid) AS (
            SELECT mem.member, mem.top, m.roleid FROM mem JOIN pg_catalog.pg_auth_members m ON m.member = mem.member
            UNION
            SELECT up.member, up.top, m.roleid FROM up JOIN pg_catalog.pg_auth_members m ON m.member = up.oid
          )
     SELECT DISTINCT mr.rolname AS member, up.top AS parent, t.rolname AS target,
            t.rolsuper, t.rolbypassrls, t.rolreplication, t.rolcreaterole, t.rolcreatedb
       FROM up JOIN pg_catalog.pg_roles t ON t.oid = up.oid JOIN pg_catalog.pg_roles mr ON mr.oid = up.member
      WHERE up.oid <> up.member AND up.oid NOT IN (SELECT oid FROM ratio)
      ORDER BY 1, 2, 3`,
    [RATIO_ROLES],
  );
  for (const m of reach.rows) {
    const bad: string[] = [];
    if (m.rolsuper) bad.push('SUPERUSER');
    if (m.rolbypassrls) bad.push('BYPASSRLS');
    if (m.rolreplication) bad.push('REPLICATION');
    if (m.parent !== 'ratio_owner' && m.rolcreaterole) bad.push('CREATEROLE');
    if (m.parent !== 'ratio_owner' && m.rolcreatedb) bad.push('CREATEDB');
    for (const attr of bad) problems.push(`role ${m.member} (member of ${m.parent}) can assume ${m.target}, which is ${attr}`);
    const why = REFUSED_PREDEFINED_ROLES[m.target];
    if (why) problems.push(`role ${m.member} (member of ${m.parent}) can assume ${m.target} (${why}; never reviewed)`);
  }
  problems.push(...(await memberPrivilegeViolations(client)));
  return problems;
}

/**
 * Predefined roles no member of a ratio role — owner side included — may be
 * able to assume, over ANY membership edge (INHERIT, SET or ADMIN,
 * transitively). Their powers are outside the per-object ACLs this check
 * enumerates, or bypass them wholesale (round 16: server files/programs;
 * round 17: data-wide read/write, signalling other sessions, subscriptions).
 */
export const REFUSED_PREDEFINED_ROLES: Readonly<Record<string, string>> = {
  pg_read_server_files: 'reads server files',
  pg_write_server_files: 'writes server files',
  pg_execute_server_program: 'runs programs on the server',
  pg_read_all_data: 'SELECT on every table, view and sequence',
  pg_write_all_data: 'INSERT, UPDATE and DELETE on every table',
  pg_signal_backend: 'cancels or terminates other sessions',
  pg_create_subscription: 'creates logical-replication subscriptions',
  // round 18: monitoring roles. Checked HERE by name, not left to the
  // system-ACL scan: pg_read_all_settings has no pg_catalog ACL footprint, and
  // what the others expose (pg_stat_activity.query of every session) is not
  // an ACL either.
  pg_monitor: "reads every session's statements and every setting",
  pg_read_all_stats: "reads every session's statement text (pg_stat_activity.query)",
  pg_read_all_settings: 'reads every setting, including superuser-only ones',
};

/**
 * What a member of ratio_owner (the migrator login) — and ratio_owner itself —
 * may hold OUTSIDE schema ratio (round 16 H1). Inside ratio it owns
 * everything. The migrator may own the database (CREATE SCHEMA needs CREATE
 * on it; a database owner also holds CREATE on schema public through
 * pg_database_owner) and the migration ledger it creates in public.
 */
export const REVIEWED_OWNER_PRIVILEGES: readonly string[] = [
  'database:CREATE',
  'database:CONNECT',
  'database:TEMPORARY',
  'schema:public:USAGE',
  'schema:public:CREATE',
];
const OWNER_LEDGER = /^relation:public\.schema_migrations:/;
const RATIO_SCOPE = /^(schema:ratio:|relation:ratio\.|function:ratio\.|type:ratio\.)/;

/**
 * Privileges of every role other than ratio_reader / ratio_worker (those are
 * checked against REVIEWED_PRIVILEGES directly), each resolved through its
 * upward membership closure (round 16 H2):
 *   - ratio_owner and every DIRECT OR TRANSITIVE member of a ratio role
 *     (pg_auth_members graph; superusers are refused by the attribute rule):
 *     EVERY category (round 16 H1) — a LOGIN member of ratio_worker granted
 *     SET on session_replication_role could otherwise switch to replica and
 *     skip the RT triggers and FKs. Allowed: the reviewed set of each ratio
 *     role it belongs to; on the owner side also everything in schema ratio
 *     and REVIEWED_OWNER_PRIVILEGES (+ the ledger).
 *   - every other cluster role (not superuser, not predefined pg_*, not a
 *     ratio role or member): schema ratio and its objects only, where it may
 *     hold nothing. This catches a renamed ratio role (it keeps its grants and
 *     members under the new name). Other databases' and the cluster's own
 *     roles are otherwise not this check's business.
 */
async function memberPrivilegeViolations(client: ClientBase): Promise<string[]> {
  const roles = await client.query<{ oid: string; role: string; is_member: boolean; owner_side: boolean; in_reader: boolean; in_worker: boolean }>(
    `WITH RECURSIVE ratio AS (SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])),
          mem(member, top) AS (
            SELECT m.member, r.rolname FROM pg_catalog.pg_auth_members m JOIN ratio r ON r.oid = m.roleid
            UNION
            SELECT m.member, mem.top FROM pg_catalog.pg_auth_members m JOIN mem ON m.roleid = mem.member
          )
     SELECT r.oid::text AS oid, r.rolname AS role,
            r.rolname = 'ratio_owner' OR EXISTS (SELECT 1 FROM mem WHERE mem.member = r.oid) AS is_member,
            r.rolname = 'ratio_owner' OR EXISTS (SELECT 1 FROM mem WHERE mem.member = r.oid AND mem.top = 'ratio_owner') AS owner_side,
            EXISTS (SELECT 1 FROM mem WHERE mem.member = r.oid AND mem.top = 'ratio_reader') AS in_reader,
            EXISTS (SELECT 1 FROM mem WHERE mem.member = r.oid AND mem.top = 'ratio_worker') AS in_worker
       FROM pg_catalog.pg_roles r
      WHERE NOT r.rolsuper AND r.rolname NOT IN ('ratio_reader', 'ratio_worker')
        AND (r.rolname !~ '^pg_' OR EXISTS (SELECT 1 FROM mem WHERE mem.member = r.oid))
      ORDER BY 2`,
    [RATIO_ROLES],
  );
  const members = roles.rows.filter((r) => r.is_member);
  const others = roles.rows.filter((r) => !r.is_member);
  const full = await closurePrivileges(
    client,
    members.map((r) => r.oid),
    false,
  );
  const scoped = await closurePrivileges(
    client,
    others.map((r) => r.oid),
    true,
  );
  const problems: string[] = [];
  for (const r of roles.rows) {
    const privs = [...new Set((r.is_member ? full : scoped).get(r.oid) ?? [])].sort();
    for (const priv of privs) {
      const allowed =
        (r.owner_side && (RATIO_SCOPE.test(priv) || REVIEWED_OWNER_PRIVILEGES.includes(priv) || OWNER_LEDGER.test(priv))) ||
        (r.in_reader && REVIEWED_PRIVILEGES.ratio_reader.includes(priv)) ||
        (r.in_worker && REVIEWED_PRIVILEGES.ratio_worker.includes(priv));
      if (!allowed) problems.push(`${r.role} holds ${priv} beyond the reviewed set of the ratio roles it belongs to`);
    }
  }
  return problems;
}

/**
 * Settings that change what a session can see or enforce (trigger/FK
 * bypass, RLS, name resolution, read-only, isolation, identity).
 */
export const SECURITY_RELEVANT_SETTINGS: readonly string[] = [
  'session_replication_role',
  'row_security',
  'search_path',
  'default_transaction_read_only',
  'default_transaction_isolation',
  'role',
  'session_authorization',
  // round 9: large-object ACL bypass and library loading at session start
  'lo_compat_privileges',
  'session_preload_libraries',
  'local_preload_libraries',
];

/**
 * Security-relevant setting keys: the list above, plus ANY `ratio.*` custom
 * setting (case-insensitive) — e.g. a default `ratio.tenant_id` would give
 * every new session a tenant without set_config (round 9, L1).
 */
export function isSecurityRelevantSetting(key: string): boolean {
  const k = key.trim().toLowerCase();
  return SECURITY_RELEVANT_SETTINGS.includes(k) || k.startsWith('ratio.');
}

/**
 * Per-database / per-role setting defaults (`ALTER DATABASE … SET`, `ALTER
 * ROLE … [IN DATABASE …] SET`, stored in pg_db_role_setting) apply to every
 * NEW session, so a migration could plant e.g. session_replication_role =
 * replica for the worker and every later worker session would skip the
 * RT001–RT003 triggers and FK checks (round 8, L1).
 * Only rows that apply to sessions in THIS database count (setdatabase =
 * this database, or 0 = all databases): a row scoped to another database
 * cannot affect sessions here and is that database's own check's business
 * (pg_db_role_setting is a shared catalog; counting other databases' rows
 * would also let one database's drift block every other database's
 * migrations in a shared cluster). Targeted, not blanket (deployments may
 * legitimately set e.g. statement_timeout per database):
 *   - ANY setting on a ratio role itself is refused: the ratio roles are
 *     NOLOGIN and are configured by migrations only;
 *   - a security-relevant key (SECURITY_RELEVANT_SETTINGS or any ratio.*
 *     custom setting, see isSecurityRelevantSetting) is refused for any role in this
 *     database (ALTER DATABASE, ALTER ROLE x IN DATABASE this), for all roles
 *     (ALTER ROLE ALL), and for a member of a ratio role.
 */
async function settingViolations(client: ClientBase): Promise<string[]> {
  const rows = await client.query<{
    key: string;
    rolname: string | null;
    datname: string | null;
    here: boolean;
    all_roles_here: boolean;
    ratio_role: boolean;
    ratio_member: boolean;
  }>(
    `WITH ratio AS (SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])),
          cur AS (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
     SELECT pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(cfg, '=', 1))) AS key, r.rolname, d.datname,
            (s.setdatabase = (SELECT oid FROM cur)) AS here,
            s.setrole = 0 AS all_roles_here,
            EXISTS (SELECT 1 FROM ratio x WHERE x.oid = s.setrole) AS ratio_role,
            (s.setrole <> 0 AND EXISTS (SELECT 1 FROM ratio x WHERE pg_catalog.pg_has_role(s.setrole, x.oid, 'MEMBER'))) AS ratio_member
       FROM pg_catalog.pg_db_role_setting s
       LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
       LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
       CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS cfg
      WHERE s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM cur)
      ORDER BY 1, 2, 3`,
    [RATIO_ROLES],
  );
  // Only the KEY and the scope are ever reported — never the value, which may
  // be a secret (round 13, H1). The value is not even selected.
  const problems: string[] = [];
  for (const row of rows.rows) {
    const key = row.key;
    const where = `for role ${row.rolname ?? 'ALL'} in database ${row.datname ?? 'ALL'}`;
    if (row.ratio_role) {
      problems.push(`setting ${key} ${where} is not allowed (ratio roles carry no setting defaults)`);
    } else if (isSecurityRelevantSetting(key) && (row.here || row.all_roles_here || row.ratio_member)) {
      problems.push(`setting ${key} ${where} is not allowed (security-relevant default)`);
    }
  }
  return problems;
}

/**
 * Explicit ACL entries in the system schemas (pg_catalog, information_schema)
 * that name a ratio role or any member of one (round 13, H2). The effective
 * privilege scan skips these schemas because PUBLIC's default access to the
 * catalogs is the normal baseline; but an explicit GRANT — e.g. SELECT on
 * pg_catalog.pg_authid (or its rolpassword column), EXECUTE on
 * pg_read_file / lo_import, USAGE on information_schema — is never part of
 * the reviewed model. Covers schema (nspacl), relation (relacl), column
 * (attacl) and function (proacl) ACLs.
 */
async function systemAclViolations(client: ClientBase): Promise<string[]> {
  const rows = await client.query<{ role: string; what: string; via: string | null }>(
    `WITH RECURSIVE ratio AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])),
          mem(member) AS (
            SELECT m.member FROM pg_catalog.pg_auth_members m JOIN ratio r ON r.oid = m.roleid
            UNION
            SELECT m.member FROM pg_catalog.pg_auth_members m JOIN mem ON m.roleid = mem.member
          ),
          checked AS (
            -- the ratio roles and their direct or transitive members (membership
            -- graph; superusers, members of everything, are refused elsewhere)
            SELECT r.oid, r.rolname FROM pg_catalog.pg_roles r
             WHERE NOT r.rolsuper AND (r.oid IN (SELECT oid FROM ratio) OR r.oid IN (SELECT member FROM mem))
          ),
          -- round 16 H2: an entry granted to ANY role in a checked role's upward
          -- closure (INHERIT, SET or ADMIN edge, transitively) is the checked role's
          up(principal, oid) AS (
            SELECT oid, oid FROM checked
            UNION
            SELECT up.principal, m.roleid FROM pg_catalog.pg_auth_members m JOIN up ON m.member = up.oid
          ),
          sys AS (SELECT oid, nspname, nspacl FROM pg_catalog.pg_namespace WHERE nspname = ANY ($2::text[])),
          entries AS (
            SELECT a.grantee, a.privilege_type || ' on schema ' || s.nspname AS what
              FROM sys s CROSS JOIN LATERAL pg_catalog.aclexplode(s.nspacl) a
            UNION ALL
            SELECT a.grantee, a.privilege_type || ' on ' || s.nspname || '.' || c.relname
              FROM pg_catalog.pg_class c JOIN sys s ON s.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
            UNION ALL
            SELECT a.grantee, a.privilege_type || '(' || att.attname || ') on ' || s.nspname || '.' || c.relname
              FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid JOIN sys s ON s.oid = c.relnamespace
              CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
             WHERE att.attacl IS NOT NULL
            UNION ALL
            SELECT a.grantee, a.privilege_type || ' on ' || s.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'
              FROM pg_catalog.pg_proc p JOIN sys s ON s.oid = p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
          )
     SELECT DISTINCT ch.rolname AS role, e.what, CASE WHEN up.oid = up.principal THEN NULL ELSE pg_catalog.pg_get_userbyid(up.oid) END AS via
       FROM entries e JOIN up ON up.oid = e.grantee JOIN checked ch ON ch.oid = up.principal ORDER BY 1, 2, 3`,
    [RATIO_ROLES, SYSTEM_SCHEMA_NAMES],
  );
  return rows.rows.map(
    (r) =>
      `${r.role} holds explicit ${r.what}${r.via ? ` (via ${r.via})` : ''} (system-schema ACL entries for ratio roles and their members are never reviewed)`,
  );
}

/** Triggers, rules, event triggers and ledger hooks (challenger round 4, M1). */
async function hookViolations(client: ClientBase): Promise<string[]> {
  const problems: string[] = [];
  const triggers = await client.query<{ id: string; fn_schema: string; fn_owner: string }>(
    `SELECT n.nspname || '.' || c.relname || ':' || t.tgname || ':' || pn.nspname || '.' || p.proname || '()' AS id,
            pn.nspname AS fn_schema, pg_catalog.pg_get_userbyid(p.proowner) AS fn_owner
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
      WHERE NOT t.tgisinternal ORDER BY 1`,
  );
  const reviewed = new Set(REVIEWED_TRIGGERS);
  for (const t of triggers.rows) {
    if (!reviewed.has(t.id) || t.fn_schema !== 'ratio' || t.fn_owner !== 'ratio_owner') {
      problems.push(`trigger ${t.id} (function owner ${t.fn_owner}) is not a reviewed ratio_owner trigger`);
    }
  }
  const rules = await client.query<{ rule: string; rel: string }>(
    `SELECT r.rulename AS rule, n.nspname || '.' || c.relname AS rel
       FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rulename <> '_RETURN' AND ${SYSTEM_SCHEMAS} ORDER BY 2, 1`,
  );
  for (const r of rules.rows) problems.push(`rule ${r.rule} on ${r.rel} is not allowed`);
  const events = await client.query<{ evtname: string }>(`SELECT evtname FROM pg_catalog.pg_event_trigger ORDER BY 1`);
  for (const e of events.rows) problems.push(`event trigger ${e.evtname} is not allowed`);
  const ledger = await client.query<{ rls: boolean | null; policies: string[] | null }>(
    `SELECT c.relrowsecurity OR c.relforcerowsecurity AS rls,
            (SELECT pg_catalog.array_agg(p.polname ORDER BY p.polname) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass('public.schema_migrations')`,
  );
  const l = ledger.rows[0];
  if (l?.rls) problems.push('row-level security is enabled on public.schema_migrations');
  for (const p of l?.policies ?? []) problems.push(`policy ${p} on public.schema_migrations is not allowed`);
  return problems;
}

const b = (x: unknown) => (x === true ? 'true' : 'false');

/** Every policy on a table in schema ratio, rendered as a manifest line. */
async function policyEntries(client: ClientBase): Promise<string[]> {
  const policies = await client.query<{ t: string; name: string; cmd: string; permissive: boolean; roles: string; using: string; chk: string }>(
    `SELECT 'ratio.' || c.relname AS t, p.polname AS name, p.polcmd::text AS cmd, p.polpermissive AS permissive,
            (SELECT pg_catalog.string_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END, ',' ORDER BY 1)
               FROM pg_catalog.unnest(p.polroles) AS r) AS roles,
            coalesce(pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)), '') AS using,
            coalesce(pg_catalog.md5(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)), '') AS chk
       FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ratio'`,
  );
  return policies.rows.map(
    (p) => `policy:${p.t}:${p.name}:cmd=${p.cmd}:permissive=${b(p.permissive)}:roles=${p.roles}:using=${p.using}:check=${p.chk}`,
  );
}

/** `policy:<schema>.<table>:<rest>` → `policy:<rest>` (the shape, independent of the table). */
const policyShape = (entry: string) => entry.replace(/^policy:[^:]+:/, 'policy:');

/**
 * Reviewed policy SHAPES (name, command, permissive, roles, USING / WITH CHECK
 * hashes — not the table): exactly the 0001 tenant_isolation policy on
 * `tenant_id = ratio.current_tenant_id()` for all commands, to PUBLIC,
 * permissive. A later migration's new ratio table may use that reviewed shape;
 * any other policy must be added to this list in a reviewed change (round 11).
 * The tenants table's `id = ratio.current_tenant_id()` policy is NOT a reusable
 * shape (round 12, L4): on another table `id` is not the tenant, so it is
 * allowed only as its exact 0001 manifest entry on ratio.tenants. The
 * tenant_id shape needs no column check: the expression cannot be created
 * unless the table has a uuid-comparable tenant_id column.
 */
export const REVIEWED_POLICY_SHAPES: readonly string[] = [
  ...new Set(FOUNDATION_0001.filter((e) => e.startsWith('policy:') && !e.startsWith('policy:ratio.tenants:')).map(policyShape)),
];

/** True when a rendered policy entry is reviewed (exact entry of the active manifest or of 0001, or a reviewed shape). */
function isReviewedPolicy(entry: string, active: ReadonlySet<string>): boolean {
  return active.has(entry) || FOUNDATION_0001.includes(entry) || REVIEWED_POLICY_SHAPES.includes(policyShape(entry));
}

/**
 * Every table in schema ratio — 0001's and any a later migration adds — must
 * have RLS enabled AND forced, be permanent (not UNLOGGED/TEMP), and carry at
 * least one reviewed policy; and no relation may inherit from, or be a
 * partition of, a ratio table (or the reverse) — inheritance/partitioning
 * would route rows around the parent's policies (round 12, L1).
 */
async function tableViolations(client: ClientBase, active: ReadonlySet<string>): Promise<string[]> {
  const problems: string[] = [];
  const tables = await client.query<{ t: string; rls: boolean; force: boolean; persistence: string }>(
    `SELECT 'ratio.' || c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force, c.relpersistence::text AS persistence
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ratio' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
  const policies = await policyEntries(client);
  for (const t of tables.rows) {
    if (!t.rls || !t.force) problems.push(`table ${t.t} must have row-level security enabled and forced`);
    if (t.persistence !== 'p') problems.push(`table ${t.t} must be a permanent (logged) table`);
    if (!policies.some((e) => e.startsWith(`policy:${t.t}:`) && isReviewedPolicy(e, active))) problems.push(`table ${t.t} has no reviewed policy`);
  }
  const inherits = await client.query<{ child: string; parent: string }>(
    `SELECT cn.nspname || '.' || c.relname AS child, pn.nspname || '.' || p.relname AS parent
       FROM pg_catalog.pg_inherits i
       JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_catalog.pg_class p ON p.oid = i.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
      WHERE c.relkind IN ('r', 'p', 'f') AND (cn.nspname = 'ratio' OR pn.nspname = 'ratio')
      ORDER BY 1, 2`,
  );
  for (const r of inherits.rows) problems.push(`${r.child} inherits from or is a partition of ${r.parent}`);
  return problems;
}

/**
 * Any policy on a ratio table that is neither a 0001 manifest entry nor of a
 * reviewed shape is refused — whether or not 0001 is in the ledger
 * (round 11, M1). Permissive policies are ORed, so an extra one widens access
 * (e.g. USING (true)). Decision: RESTRICTIVE ones are refused too — their
 * expressions run for every candidate row and may call functions, and they
 * can deny service; none is reviewed.
 */
async function policyViolations(client: ClientBase, active: ReadonlySet<string>): Promise<string[]> {
  return (await policyEntries(client))
    .filter((e) => !isReviewedPolicy(e, active))
    .sort()
    .map((e) => `${e} is not a reviewed policy`);
}

/**
 * The reviewed 0001 foundation as it is in the catalog, one normalized string
 * per object (round 10). Compared with FOUNDATION_0001 (generated from a fresh
 * 0001 apply, see foundationManifest.ts) whenever the ledger says 0001 is
 * applied: every manifest entry must be present, so dropping, disabling or
 * replacing any of these is a violation. Bodies/definitions are pinned by md5
 * of PostgreSQL's own deparse (pg_get_functiondef / _viewdef / _constraintdef
 * / _indexdef / _expr), computed with search_path = pg_catalog, pg_temp.
 */
export async function foundationSnapshot(client: ClientBase): Promise<string[]> {
  await pinSearchPath(client);
  const q = async (sql: string) => (await client.query<{ e: string }>(sql)).rows.map((r) => r.e);
  const entries: string[] = [];
  entries.push(
    ...(await q(`SELECT 'schema:' || n.nspname || ':owner=' || pg_catalog.pg_get_userbyid(n.nspowner) AS e
                   FROM pg_catalog.pg_namespace n WHERE n.nspname = 'ratio'`)),
  );
  const tables = await client.query<{ t: string; owner: string; rls: boolean; force: boolean; persistence: string; replident: string }>(
    `SELECT 'ratio.' || c.relname AS t, pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
            c.relpersistence::text AS persistence, c.relreplident::text AS replident
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ratio' AND c.relkind IN ('r', 'p')`,
  );
  for (const t of tables.rows) {
    entries.push(`table:${t.t}:owner=${t.owner}:rls=${b(t.rls)}:force=${b(t.force)}:persistence=${t.persistence}:replident=${t.replident}`);
  }
  const columns = await client.query<{ t: string; col: string; typ: string; nn: boolean; def: string }>(
    `SELECT 'ratio.' || c.relname AS t, a.attname AS col, pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS nn,
            coalesce(pg_catalog.md5(pg_catalog.pg_get_expr(d.adbin, d.adrelid)), '') AS def
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'ratio' AND c.relkind IN ('r', 'p', 'v') AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  for (const r of columns.rows) entries.push(`column:${r.t}:${r.col}:${r.typ}:notnull=${b(r.nn)}:default=${r.def}`);
  entries.push(...(await policyEntries(client)));
  const triggers = await client.query<{ t: string; name: string; fn: string; enabled: string; type: number; deferrable: boolean; initdeferred: boolean }>(
    `SELECT 'ratio.' || c.relname AS t, tg.tgname AS name, fn.nspname || '.' || p.proname || '()' AS fn, tg.tgenabled::text AS enabled,
            tg.tgtype::int AS type, tg.tgdeferrable AS deferrable, tg.tginitdeferred AS initdeferred
       FROM pg_catalog.pg_trigger tg
       JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_proc p ON p.oid = tg.tgfoid JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
      WHERE n.nspname = 'ratio' AND NOT tg.tgisinternal`,
  );
  for (const t of triggers.rows) {
    entries.push(
      `trigger:${t.t}:${t.name}:fn=${t.fn}:enabled=${t.enabled}:type=${t.type}:deferrable=${b(t.deferrable)}:initdeferred=${b(t.initdeferred)}`,
    );
  }
  entries.push(
    ...(await q(`SELECT 'function:' || ${FN_NAME} || ':owner=' || pg_catalog.pg_get_userbyid(p.proowner)
                        || ':secdef=' || CASE WHEN p.prosecdef THEN 'true' ELSE 'false' END
                        || ':def=' || pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) AS e
                   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'ratio'`)),
  );
  entries.push(
    ...(await q(`SELECT 'view:ratio.' || c.relname || ':owner=' || pg_catalog.pg_get_userbyid(c.relowner)
                        || ':options=' || coalesce(pg_catalog.array_to_string(c.reloptions, ','), '')
                        || ':def=' || pg_catalog.md5(pg_catalog.pg_get_viewdef(c.oid)) AS e
                   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'ratio' AND c.relkind IN ('v', 'm')`)),
  );
  entries.push(
    ...(await q(`SELECT 'constraint:ratio.' || c.relname || ':' || k.conname || ':type=' || k.contype::text
                        || ':validated=' || CASE WHEN k.convalidated THEN 'true' ELSE 'false' END
                        || ':def=' || pg_catalog.md5(pg_catalog.pg_get_constraintdef(k.oid)) AS e
                   FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'ratio' AND k.contype IN ('c', 'f', 'p', 'u', 'x')`)),
  );
  entries.push(
    ...(await q(`SELECT 'index:ratio.' || t.relname || ':' || i.relname || ':def=' || pg_catalog.md5(pg_catalog.pg_get_indexdef(i.oid)) AS e
                   FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
                   JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'ratio'`)),
  );
  // The reviewed ratio-scope grants must be PRESENT (e.g. the reader's SELECT on the view).
  const eff = await effectivePrivileges(client);
  for (const role of ['ratio_reader', 'ratio_worker'] as const) {
    for (const p of eff[role]) if (/^(schema:ratio:|relation:ratio\.|function:ratio\.)/.test(p)) entries.push(`privilege:${role}:${p}`);
  }
  return entries.sort();
}

const FOUNDATION_ORDER = ['schema', 'table', 'trigger', 'policy', 'function', 'view', 'privilege', 'constraint', 'index', 'column'];

/** Missing or altered 0001 objects, when (and only when) the ledger says 0001 is applied. */
/**
 * The expected foundation for the applied migration state (round 14): the
 * manifest of the HIGHEST applied version that ships one. A migration that
 * changes the reviewed foundation ships its own manifest; one that does not
 * leaves the previous manifest in force (so an unreviewed change fails). Null
 * when no applied version has a manifest (before 0001, or after its down).
 */
async function activeManifest(
  client: ClientBase,
  manifests: Record<string, readonly string[]>,
): Promise<{ version: string; entries: readonly string[] } | null> {
  const ledger = (await client.query<{ e: boolean }>(`SELECT pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL AS e`)).rows[0].e;
  if (!ledger) return null;
  const applied = (await client.query<{ version: string }>(`SELECT version FROM public.schema_migrations ORDER BY version DESC`)).rows;
  for (const { version } of applied) if (manifests[version]) return { version, entries: manifests[version] };
  return null;
}

/** Missing or altered foundation objects relative to the active manifest. */
async function foundationViolations(client: ClientBase, active: { version: string; entries: readonly string[] } | null): Promise<string[]> {
  if (!active) return [];
  const present = new Set(await foundationSnapshot(client));
  // Most significant first, so a truncated error message still names the root cause
  // (e.g. the schema, not 128 of its columns).
  const rank = (e: string) => FOUNDATION_ORDER.indexOf(e.slice(0, e.indexOf(':')));
  return active.entries
    .filter((e) => !present.has(e))
    .sort((x, y) => rank(x) - rank(y) || (x < y ? -1 : 1))
    .map((e) => `required ${active.version} object missing or altered: ${e}`);
}

/** Every deviation from the reviewed model, one human-readable line each (empty when compliant). */
export async function privilegeModelViolations(client: ClientBase, opts: CheckOptions = {}): Promise<string[]> {
  await pinSearchPath(client);
  const manifests = opts.manifests ?? loadManifests();
  const problems: string[] = [];
  const eff = await effectivePrivileges(client);
  for (const role of ['ratio_reader', 'ratio_worker'] as const) {
    const allowed = new Set(REVIEWED_PRIVILEGES[role]);
    for (const p of eff[role].sort()) if (!allowed.has(p)) problems.push(`${role} holds ${p} beyond the reviewed set`);
  }
  const secdef = await client.query<{ fn: string; owner: string }>(
    `SELECT ${FN_NAME} AS fn, pg_catalog.pg_get_userbyid(p.proowner) AS owner
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1`,
  );
  const reviewed = new Set(REVIEWED_SECURITY_DEFINER_FUNCTIONS);
  for (const { fn, owner } of secdef.rows) {
    if (!(reviewed.has(fn) && owner === 'ratio_owner')) {
      problems.push(`SECURITY DEFINER function ${fn} (owner ${owner}) is not a reviewed ratio_owner function`);
    }
  }
  const pub = await client.query<{ fn: string }>(
    `SELECT ${FN_NAME} AS fn
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ANY ($1::text[]) AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
      ORDER BY 1`,
    [NO_PUBLIC_EXECUTE_SCHEMAS],
  );
  for (const { fn } of pub.rows) problems.push(`PUBLIC holds EXECUTE on ${fn}`);
  problems.push(...(await hookViolations(client)));
  problems.push(...(await settingViolations(client)));
  const active = await activeManifest(client, manifests);
  const activeSet = new Set(active ? active.entries : FOUNDATION_0001);
  problems.push(...(await foundationViolations(client, active)));
  problems.push(...(await policyViolations(client, activeSet)));
  problems.push(...(await tableViolations(client, activeSet)));
  problems.push(...(await systemAclViolations(client)));
  problems.push(...(await systemBaselineViolations(client, opts.systemBaseline)));
  problems.push(...(await roleViolations(client)));
  return problems;
}

/** Throws PRIVILEGE_MODEL_VIOLATION when the catalog deviates from the reviewed model. */
export async function assertReviewedPrivileges(client: ClientBase, context = 'catalog', opts: CheckOptions = {}): Promise<void> {
  const problems = await privilegeModelViolations(client, opts);
  if (problems.length) {
    const shown = problems.slice(0, 20).join('; ');
    const more = problems.length > 20 ? `; ... and ${problems.length - 20} more` : '';
    throw new MigrationError('PRIVILEGE_MODEL_VIOLATION', `${context}: ${shown}${more}`);
  }
}
