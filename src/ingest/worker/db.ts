// Worker database access: pool construction and the startup role-safety check
// (rule 12). The worker must be RLS-bound: never superuser, never BYPASSRLS,
// never able to become one, never the schema owner, and a ratio_worker member.
import { Pool } from 'pg';
import { IngestError } from '../errors';
import { DEFAULT_DB_SESSION } from '../config';
import { SERVER_FILE_ROLES } from '../db/privilegeModel';

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
  ownerMember: boolean;
  workerMember: boolean;
  /**
   * Refusals found over the FULL membership closure of the session and current
   * user (every pg_auth_members edge: inherit, SET-only, ADMIN-only,
   * transitive): a member-audit attribute, or a refused predefined role.
   */
  closureProblems: string[];
}

/** Role attributes the member audit refuses on anything a worker can reach (as Slice 0's member audit). */
const REFUSED_ATTRIBUTES: ReadonlyArray<readonly [string, string]> = [
  ['rolsuper', 'SUPERUSER'],
  ['rolbypassrls', 'BYPASSRLS'],
  ['rolreplication', 'REPLICATION'],
  ['rolcreaterole', 'CREATEROLE'],
  ['rolcreatedb', 'CREATEDB'],
];

/**
 * Predefined roles a worker must never reach. Taken from Slice 0
 * (privilegeModel) — not duplicated here. NOTE: this branch's Slice 0 exports
 * only SERVER_FILE_ROLES; the full REFUSED_PREDEFINED_ROLES map (rounds 17-19,
 * origin/main) replaces it once Slice 0 is merged.
 */
const REFUSED_PREDEFINED: readonly string[] = SERVER_FILE_ROLES;

async function closureProblems(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const r = await pool.query(
    `WITH RECURSIVE me AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)),
          up(oid) AS (
            SELECT oid FROM me
            UNION
            SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN up ON m.member = up.oid
          )
     SELECT r.rolname::text AS role, r.rolsuper, r.rolbypassrls, r.rolreplication, r.rolcreaterole, r.rolcreatedb
       FROM up JOIN pg_catalog.pg_roles r ON r.oid = up.oid ORDER BY 1`,
  );
  const out: string[] = [];
  for (const row of r.rows as Array<Record<string, unknown> & { role: string }>) {
    for (const [col, attr] of REFUSED_ATTRIBUTES) if (row[col]) out.push(`can reach ${row.role}, which is ${attr}`);
    if (REFUSED_PREDEFINED.includes(row.role)) out.push(`can reach the refused predefined role ${row.role}`);
  }
  return out;
}

export async function inspectRole(pool: Pick<Pool, 'query'>): Promise<RoleReport> {
  const r = await pool.query(`
    SELECT current_user::text AS cu, session_user::text AS su,
      (SELECT bool_or(rolsuper) FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)) AS superuser,
      (SELECT bool_or(rolbypassrls) FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)) AS bypass,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE (r.rolsuper OR r.rolbypassrls)
              AND (pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') OR pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER'))) AS privileged,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ratio_owner')
        AND (pg_catalog.pg_has_role(current_user, 'ratio_owner', 'MEMBER') OR pg_catalog.pg_has_role(session_user, 'ratio_owner', 'MEMBER')) AS owner_member,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ratio_worker')
        AND pg_catalog.pg_has_role(current_user, 'ratio_worker', 'USAGE') AS worker_member`);
  const row = r.rows[0];
  return {
    currentUser: row.cu,
    sessionUser: row.su,
    superuser: !!row.superuser,
    bypassRls: !!row.bypass,
    canBecomePrivileged: !!row.privileged,
    ownerMember: !!row.owner_member,
    workerMember: !!row.worker_member,
    closureProblems: await closureProblems(pool),
  };
}

export function roleProblems(r: RoleReport): string[] {
  const p: string[] = [];
  if (r.superuser) p.push('connected role is a superuser (RLS would be bypassed)');
  if (r.bypassRls) p.push('connected role has BYPASSRLS');
  if (r.canBecomePrivileged && !r.superuser && !r.bypassRls) p.push('connected role is a member of a superuser or BYPASSRLS role');
  if (r.ownerMember) p.push('connected role is a member of ratio_owner (could disable RLS)');
  if (!r.workerMember) p.push('connected role is not a member of ratio_worker');
  // Same refusal set as Slice 0's member audit, over the full closure (review H1, fifth round).
  // SUPERUSER/BYPASSRLS already have their own messages above.
  for (const c of r.closureProblems) if (!/which is (SUPERUSER|BYPASSRLS)$/.test(c)) p.push(`connected role ${c}`);
  return p;
}

/** Refuses (UNSAFE_DB_ROLE) before any work if the connection is not a safe worker identity. */
export async function assertSafeWorkerRole(pool: Pick<Pool, 'query'>): Promise<RoleReport> {
  const report = await inspectRole(pool);
  const problems = roleProblems(report);
  if (problems.length) throw new IngestError('UNSAFE_DB_ROLE', `refusing to run: ${problems.join('; ')}`);
  return report;
}
