// Worker database access: pool construction and the startup role-safety check
// (rule 12). The worker must be RLS-bound: never superuser, never BYPASSRLS,
// never able to become one, never the schema owner, and a ratio_worker member.
import { Pool } from 'pg';
import { IngestError } from '../errors';
import { DEFAULT_DB_SESSION } from '../config';
import { REFUSED_PREDEFINED_ROLES } from '../db/privilegeModel';

/**
 * Predefined roles a worker login must not be able to reach over ANY
 * membership edge: exactly Slice 0's member-audit list (read-only import).
 */
const REFUSED_PREDEFINED: readonly string[] = Object.keys(REFUSED_PREDEFINED_ROLES);

export function createWorkerPool(
  url: string,
  opts: { max?: number; readOnly?: boolean; applicationName?: string; lockTimeoutMs?: number; idleInTransactionTimeoutMs?: number; statementTimeoutMs?: number } = {},
): Pool {
  // Session timeouts (L-b): a lock held by a stuck run, an abandoned open
  // transaction, or a runaway statement can never block a worker indefinitely.
  const int = (v: number | undefined, d: number) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : d);
  const options = [
    '-c timezone=UTC',
    `-c lock_timeout=${int(opts.lockTimeoutMs, DEFAULT_DB_SESSION.lockTimeoutMs)}`,
    `-c idle_in_transaction_session_timeout=${int(opts.idleInTransactionTimeoutMs, DEFAULT_DB_SESSION.idleInTransactionTimeoutMs)}`,
    `-c statement_timeout=${int(opts.statementTimeoutMs, DEFAULT_DB_SESSION.statementTimeoutMs)}`,
    ...(opts.readOnly ? ['-c default_transaction_read_only=on'] : []),
  ].join(' ');
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: opts.applicationName ?? 'ratio-worker',
    options,
  });
  // An idle client error must never crash the process with an unredacted trace.
  pool.on('error', () => undefined);
  return pool;
}

export interface RoleReport {
  currentUser: string;
  sessionUser: string;
  superuser: boolean;
  bypassRls: boolean;
  canBecomePrivileged: boolean;
  unsafeCapabilities: string[];
  ownerMember: boolean;
  workerMember: boolean;
}

export async function inspectRole(pool: Pick<Pool, 'query'>): Promise<RoleReport> {
  const r = await pool.query(`
    WITH RECURSIVE connected_roles(oid) AS (
      SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)
      UNION
      SELECT m.roleid FROM pg_catalog.pg_auth_members m
        JOIN connected_roles c ON c.oid = m.member
    )
    SELECT current_user::text AS cu, session_user::text AS su,
      (SELECT bool_or(rolsuper) FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)) AS superuser,
      (SELECT bool_or(rolbypassrls) FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)) AS bypass,
      EXISTS (SELECT 1 FROM connected_roles c JOIN pg_catalog.pg_roles r ON r.oid = c.oid
              WHERE r.rolsuper OR r.rolbypassrls) AS privileged,
      (SELECT COALESCE(array_agg(DISTINCT capability ORDER BY capability), ARRAY[]::text[])
         FROM connected_roles c JOIN pg_catalog.pg_roles r ON r.oid = c.oid
         CROSS JOIN LATERAL (VALUES
           (CASE WHEN r.rolsuper THEN 'SUPERUSER'::text END),
           (CASE WHEN r.rolbypassrls THEN 'BYPASSRLS'::text END),
           (CASE WHEN r.rolreplication THEN 'REPLICATION'::text END),
           (CASE WHEN r.rolcreaterole THEN 'CREATEROLE'::text END),
           (CASE WHEN r.rolcreatedb THEN 'CREATEDB'::text END),
           (CASE WHEN r.rolname = ANY ($1::text[]) THEN r.rolname::text END)
         ) AS capabilities(capability)
        WHERE capability IS NOT NULL) AS unsafe_capabilities,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ratio_owner')
        AND (pg_catalog.pg_has_role(current_user, 'ratio_owner', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'ratio_owner', 'MEMBER')) AS owner_member,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ratio_worker')
        AND pg_catalog.pg_has_role(current_user, 'ratio_worker', 'USAGE') AS worker_member`,
    [REFUSED_PREDEFINED],
  );
  const row = r.rows[0];
  return {
    currentUser: row.cu,
    sessionUser: row.su,
    superuser: !!row.superuser,
    bypassRls: !!row.bypass,
    canBecomePrivileged: !!row.privileged,
    unsafeCapabilities: row.unsafe_capabilities,
    ownerMember: !!row.owner_member,
    workerMember: !!row.worker_member,
  };
}

export function roleProblems(r: RoleReport): string[] {
  const p: string[] = [];
  if (r.superuser) p.push('connected role is a superuser (RLS would be bypassed)');
  if (r.bypassRls) p.push('connected role has BYPASSRLS');
  if (r.canBecomePrivileged && !r.superuser && !r.bypassRls) p.push('connected role is a member of a superuser or BYPASSRLS role');
  const otherUnsafeCapabilities = r.unsafeCapabilities.filter((capability) => capability !== 'SUPERUSER' && capability !== 'BYPASSRLS');
  if (otherUnsafeCapabilities.length) p.push(`connected role has unsafe capabilities: ${otherUnsafeCapabilities.join(', ')}`);
  if (r.ownerMember) p.push('connected role is a member of ratio_owner (could disable RLS)');
  if (!r.workerMember) p.push('connected role is not a member of ratio_worker');
  return p;
}

/** Refuses (UNSAFE_DB_ROLE) before any work if the connection is not a safe worker identity. */
export async function assertSafeWorkerRole(pool: Pick<Pool, 'query'>): Promise<RoleReport> {
  const report = await inspectRole(pool);
  const problems = roleProblems(report);
  if (problems.length) throw new IngestError('UNSAFE_DB_ROLE', `refusing to run: ${problems.join('; ')}`);
  return report;
}
