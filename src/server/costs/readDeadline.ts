// Client-side deadlines for the published-costs read (Copilot 4176494809).
//
// statement_timeout is enforced by the SERVER. A stalled connection or a lost
// response never reaches it, and the request would hold one of the reader
// pool's 4 slots forever. So:
//   - every query has a client-side query_timeout (readerPool.ts), slightly
//     above the server's 10 s statement_timeout;
//   - connecting is bounded (connectionTimeoutMillis);
//   - the whole request (tenant transaction, login check, reads) has a
//     deadline;
//   - a client that saw anything but a session-preserving SQL error, or
//     outlived the request deadline, is DESTROYED (release(err) plus its
//     socket), never returned to the pool. Once poisoned, it accepts no
//     further query (the ROLLBACK fails at once instead of queueing behind
//     the stuck one or going to a dead transport).
//   - The SQL error is classified POSITIVELY (Copilot 4176969214): a code that
//     merely looks like a SQLSTATE is not one (Node's EPIPE is 5 uppercase
//     letters too).
// Slice 0's withTenantTransaction is unchanged: it releases through this guard.
import { DatabaseError, type Pool, type PoolClient } from 'pg';

export const READ_TIMEOUTS = Object.freeze({
  /** pg connectionTimeoutMillis. */
  connectMs: 5_000,
  /** pg query_timeout: client-side, above the server's 10 s statement_timeout. */
  queryMs: 12_000,
  /** The whole request. */
  requestMs: 20_000,
});

type Connectable = Pick<Pool, 'connect'>;

/** Clients that already carry the stray-error listener (one per client, for its whole life). */
const strayErrorGuarded = new WeakSet<object>();
const ignoreStrayError = (): void => undefined;

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** SQLSTATEs that end or break the session even at severity ERROR: class 08 (connection exception), 57P01–57P05 (shutdown, crash, idle timeouts). */
const SESSION_ENDING = /^(?:08|57P0[1-5])/;

/**
 * True only for a SQL error the SERVER raised that leaves the session usable:
 * a pg DatabaseError (from the wire protocol) with severity exactly ERROR
 * (FATAL/PANIC end the session; a localized or missing severity fails safe),
 * a SQLSTATE-shaped code outside the session-ending classes, and no Node
 * system-error fields. Everything else poisons the client: Node system errors
 * (EPIPE, ECONNRESET, …: errno/syscall), pg's query_timeout and "Connection
 * terminated" errors, errors without a code, and look-alikes that are not a
 * DatabaseError.
 */
export function isSessionPreservingSqlError(err: unknown): boolean {
  if (!(err instanceof DatabaseError)) return false;
  const e = err as DatabaseError & { errno?: unknown; syscall?: unknown };
  return (
    e.severity === 'ERROR' &&
    typeof e.code === 'string' &&
    SQLSTATE.test(e.code) &&
    !SESSION_ENDING.test(e.code) &&
    e.errno === undefined &&
    e.syscall === undefined
  );
}

function destroySocket(client: PoolClient): void {
  try {
    (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.();
  } catch {
    // already gone
  }
}

/**
 * Runs `read` against a guarded view of `pool` and rejects at `deadlineMs`,
 * destroying every client the read still holds.
 */
export async function readWithDeadline<T>(pool: Connectable, read: (pool: Connectable) => Promise<T>, deadlineMs: number): Promise<T> {
  const live = new Set<(err: Error) => void>();
  let expired: Error | null = null;

  const guard = (client: PoolClient): PoolClient => {
    let poisoned: Error | null = null;
    let released = false;
    // A stray 'error' (e.g. the socket destroyed at the deadline while no
    // query is active) must never crash the process. Attached ONCE per client
    // (challenger Medium on 480dd87: per checkout, a pooled client that is
    // never retired collected one listener per request).
    if (!strayErrorGuarded.has(client)) {
      strayErrorGuarded.add(client);
      (client as unknown as { on?: (e: string, f: () => void) => void }).on?.('error', ignoreStrayError);
    }
    const finish = (err: Error | null) => {
      if (released) return;
      released = true;
      live.delete(destroy);
      client.release(err ?? undefined);
      if (err) destroySocket(client);
    };
    const destroy = (err: Error) => finish(err);
    live.add(destroy);
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (...args: unknown[]) => {
            const stop = poisoned ?? expired;
            if (stop) return Promise.reject(stop);
            return (target.query as (...a: unknown[]) => Promise<unknown>)(...args).catch((e: unknown) => {
              if (!isSessionPreservingSqlError(e)) poisoned = e instanceof Error ? e : new Error(String(e));
              throw e;
            });
          };
        }
        if (prop === 'release') {
          return (err?: Error | boolean) => finish(err instanceof Error ? err : err ? new Error('released with an error') : (poisoned ?? expired));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  const guarded: Connectable = {
    connect: (async () => {
      if (expired) throw expired;
      const client = await pool.connect();
      const g = guard(client);
      if (expired) {
        g.release(expired);
        throw expired;
      }
      return g;
    }) as Connectable['connect'],
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = new Error(`published-costs request deadline (${deadlineMs} ms) exceeded`);
      for (const destroy of [...live]) destroy(expired);
      reject(expired);
    }, deadlineMs);
  });
  try {
    return await Promise.race([read(guarded), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
