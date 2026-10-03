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

/**
 * Every privilege each role may EFFECTIVELY hold in the database (directly,
 * via PUBLIC or via membership), in the form the check reports:
 *   relation:<schema>.<name>:<PRIV>          table-level privilege
 *   relation:<schema>.<name>:<PRIV>(<col>)   column-level privilege not covered by a table-level one
 *   function:<schema>.<name>(<arg types>)    EXECUTE
 *   schema:<name>:<USAGE|CREATE>
 * Relations and functions count only in schemas the role can use (without
 * USAGE they are unreachable; USAGE itself is checked). pg_catalog and
 * information_schema are the system's and are not checked.
 */
export const REVIEWED_PRIVILEGES: Readonly<Record<CheckedRole, readonly string[]>> = {
  ratio_reader: [
    'schema:public:USAGE', // PostgreSQL 15+ default (PUBLIC); nothing in public is granted to the reader
    'schema:ratio:USAGE',
    'relation:ratio.cost_facts_published:SELECT',
    'function:ratio.current_tenant_id()',
  ],
  ratio_worker: [
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

/** Schemas in which PUBLIC must not hold EXECUTE on any function. */
export const NO_PUBLIC_EXECUTE_SCHEMAS: readonly string[] = ['ratio', 'public'];

const SYSTEM_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_|toast_temp_)'`;
const FN_NAME = `n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'`;

/** Effective privileges of each checked role that exists, in REVIEWED_PRIVILEGES form. */
export async function effectivePrivileges(client: ClientBase): Promise<Record<CheckedRole, string[]>> {
  const r = await client.query<{ role: CheckedRole; priv: string }>(
    `WITH roles AS (
       SELECT rolname AS role FROM pg_catalog.pg_roles WHERE rolname IN ('ratio_reader', 'ratio_worker')
     ),
     schemas AS (
       SELECT n.oid, n.nspname FROM pg_catalog.pg_namespace n WHERE ${SYSTEM_SCHEMAS}
     ),
     rels AS (
       SELECT c.oid, c.relkind, s.oid AS nsp, s.nspname || '.' || c.relname AS name
       FROM pg_catalog.pg_class c JOIN schemas s ON s.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     )
     SELECT ro.role, 'schema:' || s.nspname || ':' || pr.p AS priv
       FROM roles ro CROSS JOIN schemas s CROSS JOIN (VALUES ('USAGE'), ('CREATE')) pr(p)
      WHERE pg_catalog.has_schema_privilege(ro.role, s.oid, pr.p)
     UNION ALL
     SELECT ro.role, 'relation:' || rl.name || ':' || pr.p
       FROM roles ro CROSS JOIN rels rl
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) pr(p)
      WHERE rl.relkind <> 'S' AND pg_catalog.has_schema_privilege(ro.role, rl.nsp, 'USAGE')
        AND pg_catalog.has_table_privilege(ro.role, rl.oid, pr.p)
     UNION ALL
     SELECT ro.role, 'relation:' || rl.name || ':' || pr.p
       FROM roles ro CROSS JOIN rels rl CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) pr(p)
      WHERE rl.relkind = 'S' AND pg_catalog.has_schema_privilege(ro.role, rl.nsp, 'USAGE')
        AND pg_catalog.has_sequence_privilege(ro.role, rl.oid, pr.p)
     UNION ALL
     SELECT ro.role, 'relation:' || rl.name || ':' || pr.p || '(' || a.attname || ')'
       FROM roles ro CROSS JOIN rels rl
       JOIN pg_catalog.pg_attribute a ON a.attrelid = rl.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) pr(p)
      WHERE rl.relkind <> 'S' AND pg_catalog.has_schema_privilege(ro.role, rl.nsp, 'USAGE')
        AND NOT pg_catalog.has_table_privilege(ro.role, rl.oid, pr.p)
        AND pg_catalog.has_column_privilege(ro.role, rl.oid, a.attnum, pr.p)
     UNION ALL
     SELECT ro.role, 'function:' || ${FN_NAME}
       FROM roles ro CROSS JOIN pg_catalog.pg_proc p JOIN schemas n ON n.oid = p.pronamespace
      WHERE pg_catalog.has_schema_privilege(ro.role, n.oid, 'USAGE')
        AND pg_catalog.has_function_privilege(ro.role, p.oid, 'EXECUTE')`,
  );
  const out: Record<CheckedRole, string[]> = { ratio_reader: [], ratio_worker: [] };
  for (const row of r.rows) out[row.role].push(row.priv);
  return out;
}

/** Every deviation from the reviewed model, one human-readable line each (empty when compliant). */
export async function privilegeModelViolations(client: ClientBase): Promise<string[]> {
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
