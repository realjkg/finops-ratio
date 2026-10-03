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
 * Relations and functions count only in schemas the role can use (without
 * USAGE they are unreachable; USAGE itself is checked). pg_catalog and
 * information_schema are the system's and are not checked.
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
      WHERE a.grantee = 0 OR pg_catalog.pg_has_role(ro.oid, a.grantee, 'USAGE')`;
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
        AND pg_catalog.has_function_privilege(ro.oid, p.oid, 'EXECUTE')${extra}`;
}

/** Effective privileges of each checked role that exists, in REVIEWED_PRIVILEGES form. */
export async function effectivePrivileges(client: ClientBase): Promise<Record<CheckedRole, string[]>> {
  await pinSearchPath(client);
  const r = await client.query<{ role: CheckedRole; priv: string }>(
    `WITH roles AS (
       SELECT oid, rolname AS role FROM pg_catalog.pg_roles WHERE rolname IN ('ratio_reader', 'ratio_worker')
     ),
     privs AS (WITH ${privilegeQuery(false)})
     SELECT ro.role, pv.priv FROM privs pv(oid, priv) JOIN roles ro ON ro.oid = pv.oid`,
  );
  const out: Record<CheckedRole, string[]> = { ratio_reader: [], ratio_worker: [] };
  for (const row of r.rows) out[row.role].push(row.priv);
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
  // Every other role (not superuser, not predefined pg_*, not a ratio role, not
  // a member of ratio_owner) may hold on schema ratio and its objects at most
  // what the ratio_reader / ratio_worker roles it belongs to are reviewed for.
  // This is what catches a renamed ratio role (it keeps its grants and its
  // members under the new name) and LOGIN members with extra grants.
  const others = await client.query<{ role: string; priv: string; in_reader: boolean; in_worker: boolean }>(
    `WITH ratio AS (
       SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = ANY ($1::text[])
     ),
     roles AS (
       SELECT r.oid, r.rolname AS role FROM pg_catalog.pg_roles r
        WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid NOT IN (SELECT oid FROM ratio)
          AND NOT EXISTS (SELECT 1 FROM ratio o WHERE o.rolname = 'ratio_owner' AND pg_catalog.pg_has_role(r.oid, o.oid, 'MEMBER'))
     ),
     privs AS (WITH ${privilegeQuery(true)})
     SELECT ro.role, pv.priv,
            EXISTS (SELECT 1 FROM ratio x WHERE x.rolname = 'ratio_reader' AND pg_catalog.pg_has_role(ro.oid, x.oid, 'MEMBER')) AS in_reader,
            EXISTS (SELECT 1 FROM ratio x WHERE x.rolname = 'ratio_worker' AND pg_catalog.pg_has_role(ro.oid, x.oid, 'MEMBER')) AS in_worker
       FROM privs pv(oid, priv) JOIN roles ro ON ro.oid = pv.oid ORDER BY 1, 2`,
    [RATIO_ROLES],
  );
  for (const { role, priv, in_reader, in_worker } of others.rows) {
    const allowed = (in_reader && REVIEWED_PRIVILEGES.ratio_reader.includes(priv)) || (in_worker && REVIEWED_PRIVILEGES.ratio_worker.includes(priv));
    if (!allowed) problems.push(`${role} holds ${priv} beyond the reviewed set of the ratio roles it belongs to`);
  }
  return problems;
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

/** Every deviation from the reviewed model, one human-readable line each (empty when compliant). */
export async function privilegeModelViolations(client: ClientBase): Promise<string[]> {
  await pinSearchPath(client);
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
  problems.push(...(await roleViolations(client)));
  return problems;
}

/** Throws PRIVILEGE_MODEL_VIOLATION when the catalog deviates from the reviewed model. */
export async function assertReviewedPrivileges(client: ClientBase, context = 'catalog'): Promise<void> {
  const problems = await privilegeModelViolations(client);
  if (problems.length) {
    const shown = problems.slice(0, 20).join('; ');
    const more = problems.length > 20 ? `; ... and ${problems.length - 20} more` : '';
    throw new MigrationError('PRIVILEGE_MODEL_VIOLATION', `${context}: ${shown}${more}`);
  }
}
