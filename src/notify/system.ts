// Production bindings for the injected clock, sleep and randomness.
//
// Nothing in src/notify/ calls these on its own: a composition root passes them
// to createDispatcher. Tests pass fakes instead. This file is the ONLY place in
// the directory that touches Date, timers or Math.random. It is not a network
// transport and does not enable egress.

import type { Clock, Random, Sleep } from './types';

export const systemClock: Clock = { now: () => Date.now() };

/** Math.random is adequate for backoff jitter (it is not used for any secret). */
export const systemRandom: Random = () => Math.random();

/** setTimeout-based sleep. Aborting clears the timer and settles the promise. */
export const systemSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
