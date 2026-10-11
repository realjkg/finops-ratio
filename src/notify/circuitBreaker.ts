// Per-channel circuit breaker (closed -> open -> half-open -> closed).
//
// A channel that keeps failing for transient reasons is cut off for `openMs` so
// a dead endpoint is not hammered by retries from every alert. After the open
// period one probe call is allowed (half-open): success closes the circuit,
// failure re-opens it with a fresh timer. Time is injected. In-memory,
// single-process, bounded by `maxEntries` (oldest entry evicted first).

import type { Clock } from './types';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive transient failures that open the circuit. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before a probe is allowed. */
  readonly openMs: number;
}

export const DEFAULT_BREAKER: CircuitBreakerOptions = Object.freeze({ failureThreshold: 5, openMs: 60_000 });
export const MAX_BREAKER_ENTRIES = 5000;

interface Entry {
  failures: number;
  openedAt: number | null;
  probeStartedAt: number | null;
}

export class CircuitBreakers {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    private readonly opts: CircuitBreakerOptions = DEFAULT_BREAKER,
    private readonly maxEntries: number = MAX_BREAKER_ENTRIES,
  ) {
    if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1 || opts.failureThreshold > 1000) {
      throw new Error('invalid circuit breaker option');
    }
    if (!Number.isFinite(opts.openMs) || opts.openMs < 1 || opts.openMs > 86_400_000) {
      throw new Error('invalid circuit breaker option');
    }
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
      e = { failures: 0, openedAt: null, probeStartedAt: null };
      this.entries.set(key, e);
    }
    return e;
  }

  size(): number {
    return this.entries.size;
  }

  state(key: string): CircuitState {
    const e = this.entries.get(key);
    if (!e || e.openedAt === null) return 'closed';
    return this.clock.now() - e.openedAt >= this.opts.openMs ? 'half_open' : 'open';
  }

  /**
   * Whether a call may proceed. In half-open state exactly one caller gets the
   * probe slot; a probe that never reports back is considered lost after
   * `openMs` and another is allowed.
   */
  allow(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.openedAt === null) return true;
    const now = this.clock.now();
    if (now - e.openedAt < this.opts.openMs) return false;
    if (e.probeStartedAt !== null && now - e.probeStartedAt < this.opts.openMs) return false;
    e.probeStartedAt = now;
    return true;
  }

  onSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** A transient failure. Returns the state after recording it. */
  onFailure(key: string): CircuitState {
    const e = this.entry(key);
    const now = this.clock.now();
    if (e.openedAt !== null) {
      // The probe failed (or a late failure arrived): re-open with a fresh timer.
      e.openedAt = now;
      e.probeStartedAt = null;
      return 'open';
    }
    e.failures += 1;
    if (e.failures >= this.opts.failureThreshold) {
      e.openedAt = now;
      e.probeStartedAt = null;
      return 'open';
    }
    return 'closed';
  }

  /** The call ended without a verdict on the endpoint's health (config or policy error): free the probe slot. */
  release(key: string): void {
    const e = this.entries.get(key);
    if (e) e.probeStartedAt = null;
  }
}
