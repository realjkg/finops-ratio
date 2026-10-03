// Stall protection: an idle watchdog for streams and a deadline for promises.
// A source or evidence store that stops sending data must end the run
// visibly (*_STALLED) instead of holding the lease forever.
import { Transform } from 'stream';
import { IngestError } from './errors';

export interface IdleWatchdog {
  /** Pass-through transform; fails with `code` after `ms` without data or touch(). */
  stream: Transform;
  /** Marks progress made elsewhere (e.g. a slow downstream insert) so it is not mistaken for a stall. */
  touch(): void;
  stop(): void;
}

export function idleWatchdog(ms: number, code: string, what: string, onData?: (bytes: number) => void, signal?: AbortSignal): IdleWatchdog {
  let timer: NodeJS.Timeout | undefined;
  // An aborted run (e.g. past its maximum duration) also ends the stream, with the abort reason.
  const onAbort = () => stream.destroy(signal!.reason instanceof Error ? signal!.reason : new IngestError('RUN_ABORTED', 'run aborted'));
  const fire = () => stream.destroy(new IngestError(code, `${what} produced no data for ${Math.round(ms / 1000)} s`, { retryable: true }));
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, ms);
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    signal?.removeEventListener('abort', onAbort);
  };
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      arm();
      onData?.(chunk.length);
      cb(null, chunk);
    },
    flush(cb) {
      stop();
      cb();
    },
    destroy(err, cb) {
      stop();
      cb(err);
    },
  });
  arm();
  if (signal) {
    if (signal.aborted) queueMicrotask(onAbort);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    stream,
    touch: () => {
      if (timer) arm();
    },
    stop,
  };
}

/**
 * Settles like `p`, or rejects with the signal's reason as soon as `signal`
 * aborts — also when whatever produces `p` ignores the signal (its later
 * settlement is then ignored).
 */
export async function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  p.catch(() => undefined); // a rejection after the abort is not an unhandled one
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Rejects with `code` if `p` does not settle within `ms` — or with the
 * signal's reason (e.g. MAX_RUN_EXCEEDED) as soon as `signal` aborts, so an
 * aborted run is never reported as a stall.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number, code: string, what: string, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IngestError(code, `${what} did not respond within ${Math.round(ms / 1000)} s`, { retryable: true })), ms);
    if (signal) {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
