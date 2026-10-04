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
//   - a client that saw a client-side failure (timeout, connection lost: an
//     error without a SQLSTATE) or outlived the request deadline is DESTROYED
//     (release(err) plus its socket), never returned to the pool. Once
//     poisoned, it accepts no further query (the ROLLBACK fails at once
//     instead of queueing behind the stuck one).
// Slice 0's withTenantTransaction is unchanged: it releases through this guard.
import type { Pool, PoolClient } from 'pg';

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

/** A server-side SQL error carries a SQLSTATE; anything else (timeout, lost connection) poisons the client. */
function clientSideFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return !(typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code));
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
              if (clientSideFailure(e)) poisoned = e instanceof Error ? e : new Error(String(e));
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
