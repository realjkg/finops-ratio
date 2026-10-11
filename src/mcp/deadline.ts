// Per-call time budget (DESIGN 3.6 timeout_ms). Purpose: run an async job against an
// injected clock and report timeout, failure or value. Trust boundary: the job is the
// data provider or the audit sink, both injected code that may hang or throw. A job
// that finishes after its budget (by the injected clock) is a timeout even if it
// resolves, and its late result is discarded.
import type { McpClock } from './clock';

export type Timed<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'error' };

export async function runWithDeadline<T>(
  job: (signal: AbortSignal) => Promise<T> | T,
  budgetMs: number,
  clock: McpClock,
): Promise<Timed<T>> {
  const controller = new AbortController();
  const started = clock.now();
  let cancelTimer: () => void = () => undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    cancelTimer = clock.after(budgetMs, () => resolve('timeout'));
  });
  let work: Promise<T>;
  try {
    work = Promise.resolve(job(controller.signal));
  } catch {
    cancelTimer();
    return { ok: false, reason: 'error' };
  }
  work.catch(() => undefined); // a rejection after the deadline must not be unhandled
  try {
    const settled = await Promise.race([work.then((value) => ({ value })), timeout]);
    if (settled === 'timeout') {
      controller.abort();
      return { ok: false, reason: 'timeout' };
    }
    if (clock.now() - started > budgetMs) {
      controller.abort();
      return { ok: false, reason: 'timeout' };
    }
    return { ok: true, value: settled.value };
  } catch {
    return { ok: false, reason: 'error' };
  } finally {
    cancelTimer();
  }
}
