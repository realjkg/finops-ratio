// Every worker transaction goes through here. PostgreSQL answers COMMIT with a
// ROLLBACK command tag (and no error) when the transaction was already aborted
// — e.g. a statement failed and some code caught the error. Every write is
// then discarded, so such a COMMIT must be a failure, never a success: it must
// never advance a checkpoint, mark a batch published or finish a run.
//
// The transaction itself is Slice 0's sanctioned `withTenantTransaction`
// (BEGIN, transaction-local tenant, COMMIT/ROLLBACK); this wrapper only hands
// it clients whose COMMIT result is checked, so the tenant handling stays in
// exactly one place.
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withTenantTransaction } from '../db/tenant';
import { IngestError } from '../errors';

/** Throws unless `result` is the reply to a COMMIT that actually committed. */
export function assertCommitted(result: Pick<QueryResult, 'command'>): void {
  if (result.command !== 'COMMIT') {
    throw new IngestError(
      'COMMIT_ROLLED_BACK',
      `the transaction was rolled back at COMMIT (server replied ${String(result.command)}): an earlier statement failed, nothing was written`,
    );
  }
}

const isCommit = (arg: unknown) => {
  const text = typeof arg === 'string' ? arg : (arg as { text?: unknown } | null)?.text;
  return typeof text === 'string' && /^\s*(COMMIT|END)(\s+(WORK|TRANSACTION))?\s*;?\s*$/i.test(text);
};

/** The same client, except that a COMMIT whose reply is not COMMIT throws. */
function commitChecked(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') {
        return async (...args: unknown[]) => {
          const result = await (target.query as (...a: unknown[]) => Promise<QueryResult>).apply(target, args);
          if (isCommit(args[0])) assertCommitted(result);
          return result;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** `withTenantTransaction`, with the COMMIT reply checked. */
export function workerTransaction<T>(pool: Pick<Pool, 'connect'>, tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantTransaction({ connect: async () => commitChecked(await pool.connect()) } as Pick<Pool, 'connect'>, tenantId, fn);
}
