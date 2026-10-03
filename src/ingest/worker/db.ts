// Worker database access: pool construction and the startup role-safety check
// (rule 12). The worker must be RLS-bound: never superuser, never BYPASSRLS,
// never able to become one, never the schema owner, and a ratio_worker member.
import { Pool } from 'pg';
import { IngestError } from '../errors';

export function createWorkerPool(url: string, opts: { max?: number; readOnly?: boolean; applicationName?: string } = {}): Pool {
  const options = ['-c timezone=UTC', ...(opts.readOnly ? ['-c default_transaction_read_only=on'] : [])].join(' ');
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
  };
}

export function roleProblems(r: RoleReport): string[] {
  const p: string[] = [];
  if (r.superuser) p.push('connected role is a superuser (RLS would be bypassed)');
  if (r.bypassRls) p.push('connected role has BYPASSRLS');
  if (r.canBecomePrivileged && !r.superuser && !r.bypassRls) p.push('connected role is a member of a superuser or BYPASSRLS role');
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
