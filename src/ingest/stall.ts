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

export function idleWatchdog(ms: number, code: string, what: string, onData?: (bytes: number) => void): IdleWatchdog {
  let timer: NodeJS.Timeout | undefined;
  const fire = () => stream.destroy(new IngestError(code, `${what} produced no data for ${Math.round(ms / 1000)} s`, { retryable: true }));
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, ms);
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
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
  return {
    stream,
    touch: () => {
      if (timer) arm();
    },
    stop,
  };
}

/** Rejects with `code` if `p` does not settle within `ms`. */
export async function withDeadline<T>(p: Promise<T>, ms: number, code: string, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IngestError(code, `${what} did not respond within ${Math.round(ms / 1000)} s`, { retryable: true })), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
