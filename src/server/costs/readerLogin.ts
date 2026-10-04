// The read API's database-identity check. It REUSES Slice 1's worker check
// (inspectRole + roleProblems, which read Slice 0's REFUSED_PREDEFINED_ROLES)
// and adds the reader's own rules. Nothing is copied.
//
// Refused (any one is enough):
//   - Slice 1 rules: current/session user is SUPERUSER or BYPASSRLS; the login
//     can reach (over ANY pg_auth_members edge, transitively) a SUPERUSER,
//     BYPASSRLS, REPLICATION, CREATEROLE or CREATEDB role, or a role in
//     Slice 0's REFUSED_PREDEFINED_ROLES; it is a member of ratio_owner;
//   - reader rules: it does not hold ratio_reader's privileges directly
//     (INHERIT: the API never runs SET ROLE); it can reach ratio_worker over
//     any edge (a reader that can write is not a reader); its LOGIN attribute
//     has been removed (`ALTER ROLE … NOLOGIN` does not end pooled sessions,
//     so this rule turns NOLOGIN into an immediate kill switch).
//
// The decision is Slice 1's roleProblems + the reader rules. Each refusal
// also gets fixed reason CODES, which are what the route logs: the problem
// texts can name roles (e.g. a refused predefined role) and are never logged
// or returned.
import type { ClientBase } from 'pg';
import { inspectRole, roleProblems, type RoleReport } from '@/ingest/worker/db';

type Queryable = Pick<ClientBase, 'query'>;

export type UnsafeReason =
  | 'SUPERUSER'
  | 'BYPASSRLS'
  | 'PRIVILEGED_ROLE_REACHABLE'
  | 'UNSAFE_ATTRIBUTE'
  | 'REFUSED_PREDEFINED_ROLE'
  | 'OWNER_MEMBER'
  | 'NOT_READER_MEMBER'
  | 'WORKER_REACHABLE'
  | 'LOGIN_DISABLED'
  | 'UNCLASSIFIED';

const ATTRIBUTES = new Set(['REPLICATION', 'CREATEROLE', 'CREATEDB']);

export class UnsafeReaderLoginError extends Error {
  readonly code = 'UNSAFE_DB_LOGIN';
  constructor(
    readonly problems: readonly string[],
    readonly reasons: readonly string[],
  ) {
    super(`refusing to serve: ${problems.join('; ')}`);
    this.name = 'UnsafeReaderLoginError';
  }
}

/** Fixed codes for Slice 1's findings (classification only; the decision is roleProblems). */
function slice1Reasons(r: RoleReport): UnsafeReason[] {
  const out: UnsafeReason[] = [];
  if (r.superuser) out.push('SUPERUSER');
  if (r.bypassRls) out.push('BYPASSRLS');
  if (r.canBecomePrivileged && !r.superuser && !r.bypassRls) out.push('PRIVILEGED_ROLE_REACHABLE');
  const other = r.unsafeCapabilities.filter((c) => c !== 'SUPERUSER' && c !== 'BYPASSRLS');
  if (other.some((c) => ATTRIBUTES.has(c))) out.push('UNSAFE_ATTRIBUTE');
  if (other.some((c) => !ATTRIBUTES.has(c))) out.push('REFUSED_PREDEFINED_ROLE');
  if (r.ownerMember) out.push('OWNER_MEMBER');
  return out;
}

export async function readerLoginReport(client: Queryable): Promise<{ problems: string[]; reasons: string[] }> {
  const report = await inspectRole(client);
  // Slice 1's last rule ("not a member of ratio_worker") is the worker's own
  // membership requirement; it is neutralised here, and ONLY it: the reader's
  // rules follow below.
  const problems = roleProblems({ ...report, workerMember: true });
  const reasons: string[] = problems.length ? slice1Reasons(report) : [];
  const r = await client.query<{ reader: boolean; worker: boolean; can_login: boolean }>(
    `WITH RECURSIVE reach(oid) AS (
       SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)
       UNION
       SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reach ON reach.oid = m.member
     )
     SELECT
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ratio_reader')
         AND pg_catalog.pg_has_role(current_user, 'ratio_reader', 'USAGE') AS reader,
       EXISTS (SELECT 1 FROM reach JOIN pg_catalog.pg_roles r ON r.oid = reach.oid WHERE r.rolname = 'ratio_worker') AS worker,
       COALESCE((SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = session_user), false) AS can_login`,
  );
  // Fail closed on anything the catalog does not affirm: a missing row or a
  // NULL counts as unsafe (strict === true / === false comparisons).
  const row: { reader?: boolean | null; worker?: boolean | null; can_login?: boolean | null } = r.rows[0] ?? {};
  if (row.reader !== true) {
    problems.push('connected role does not hold ratio_reader privileges (not an inheriting member)');
    reasons.push('NOT_READER_MEMBER');
  }
  if (row.worker !== false) {
    problems.push('connected role can reach ratio_worker (a reader login must not be able to write)');
    reasons.push('WORKER_REACHABLE');
  }
  if (row.can_login !== true) {
    problems.push('the login has been set NOLOGIN (its pooled sessions are refused too)');
    reasons.push('LOGIN_DISABLED');
  }
  if (problems.length && !reasons.length) reasons.push('UNCLASSIFIED');
  return { problems, reasons };
}

export async function readerLoginProblems(client: Queryable): Promise<string[]> {
  return (await readerLoginReport(client)).problems;
}

/** Throws UnsafeReaderLoginError (before anything is read) unless the connection is a safe reader identity. */
export async function assertSafeReaderLogin(client: Queryable): Promise<void> {
  const { problems, reasons } = await readerLoginReport(client);
  if (problems.length) throw new UnsafeReaderLoginError(problems, reasons);
}
