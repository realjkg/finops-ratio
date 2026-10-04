// The read API's database-identity check. It REUSES Slice 1's worker check
// (inspectRole + roleProblems, which read Slice 0's REFUSED_PREDEFINED_ROLES)
// and adds the reader's own two rules. Nothing is copied.
//
// Refused (any one is enough):
//   - Slice 1 rules: current/session user is SUPERUSER or BYPASSRLS; the login
//     can reach (over ANY pg_auth_members edge, transitively) a SUPERUSER,
//     BYPASSRLS, REPLICATION, CREATEROLE or CREATEDB role, or a role in
//     Slice 0's REFUSED_PREDEFINED_ROLES; it is a member of ratio_owner;
//   - reader rules: it does not hold ratio_reader's privileges directly
//     (INHERIT: the API never runs SET ROLE); it can reach ratio_worker over
//     any edge (a reader that can write is not a reader).
import type { ClientBase } from 'pg';
import { inspectRole, roleProblems } from '@/ingest/worker/db';

type Queryable = Pick<ClientBase, 'query'>;

export class UnsafeReaderLoginError extends Error {
  readonly code = 'UNSAFE_DB_LOGIN';
  constructor(readonly problems: readonly string[]) {
    super(`refusing to serve: ${problems.join('; ')}`);
    this.name = 'UnsafeReaderLoginError';
  }
}

export async function readerLoginProblems(client: Queryable): Promise<string[]> {
  const report = await inspectRole(client);
  // Slice 1's last rule ("not a member of ratio_worker") is the worker's own
  // membership requirement; it is neutralised here, and ONLY it: the reader's
  // membership rules follow below.
  const problems = roleProblems({ ...report, workerMember: true });
  const r = await client.query<{ reader: boolean; worker: boolean }>(
    `WITH RECURSIVE reach(oid) AS (
       SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user, session_user)
       UNION
       SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reach ON reach.oid = m.member
     )
     SELECT
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ratio_reader')
         AND pg_catalog.pg_has_role(current_user, 'ratio_reader', 'USAGE') AS reader,
       EXISTS (SELECT 1 FROM reach JOIN pg_catalog.pg_roles r ON r.oid = reach.oid WHERE r.rolname = 'ratio_worker') AS worker`,
  );
  if (!r.rows[0].reader) problems.push('connected role does not hold ratio_reader privileges (not an inheriting member)');
  if (r.rows[0].worker) problems.push('connected role can reach ratio_worker (a reader login must not be able to write)');
  return problems;
}

/** Throws UnsafeReaderLoginError (before anything is read) unless the connection is a safe reader identity. */
export async function assertSafeReaderLogin(client: Queryable): Promise<void> {
  const problems = await readerLoginProblems(client);
  if (problems.length) throw new UnsafeReaderLoginError(problems);
}
