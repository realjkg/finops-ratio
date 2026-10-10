// useLiveSpend — the live-accrual clock: a 1s wall-clock ticker that pauses
// (without drift) while the tab is hidden. Pure accrual math lives in
// accrual.ts; this hook owns ONLY the effectful wiring.
//
// No-drift contract: while hidden, elapsed does not grow. The interval keeps
// running (browsers may throttle it heavily in hidden tabs), but each tick
// only re-baselines `last` — and the visibilitychange listener re-baselines
// on the hidden→visible edge, so throttled-tab latency after resume is never
// counted as burn time. Cleanup on unmount clears the interval and listener.

import { useEffect, useState } from 'react';

export interface LiveSpendState {
  /** Wall-clock seconds of VISIBLE session time (float; 1s granularity). */
  elapsedSeconds: number;
  /** True while the tab is hidden (the clock is holding, not accruing). */
  paused: boolean;
}

export function useLiveSpend(tickMs = 1000): LiveSpendState {
  // Lazy init keeps the prerender safe (Pages Router prerenders with no document).
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(() => typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    let last = Date.now();

    const onVisibility = () => {
      // Re-baseline on EVERY edge: hidden time never counts, and a long-throttled
      // interval can leave `last` stale by up to a tick after resume — this line
      // is what makes the pause drift-free.
      last = Date.now();
      setPaused(document.hidden);
    };

    const intervalId = setInterval(() => {
      const now = Date.now();
      // Eager delta: React evaluates queued updater functions lazily, so the
      // updater must capture an immutable number — never the mutable `last`.
      const deltaMs = now - last;
      last = now;
      if (!document.hidden) setElapsedMs((m) => m + deltaMs);
    }, tickMs);

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tickMs]);

  return { elapsedSeconds: elapsedMs / 1000, paused };
}
