// Dedupe window for alert delivery.
//
// The key is tenant + channel + severity + the producer's dedupe key, so two
// tenants never suppress each other, a Slack failure never suppresses email, and
// a severity ESCALATION on the same producer key is delivered rather than
// swallowed. A key is held for `windowMs` from the moment it is acquired; the
// window is half-open, [acquiredAt, acquiredAt + windowMs). A delivery that
// fails for good releases its key so a re-dispatch can try again.
//
// In-memory and bounded: expired entries are pruned, and at `maxEntries` the
// oldest entry is evicted. Time is injected.

import type { Clock } from './types';

export const DEFAULT_DEDUPE_WINDOW_MS = 15 * 60_000;
export const MAX_DEDUPE_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_DEDUPE_ENTRIES = 10_000;

export class DedupeWindow {
  private readonly expiry = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly windowMs: number = DEFAULT_DEDUPE_WINDOW_MS,
    private readonly maxEntries: number = MAX_DEDUPE_ENTRIES,
  ) {
    if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs > MAX_DEDUPE_WINDOW_MS) {
      throw new Error('invalid dedupe window');
    }
  }

  static key(tenant: string, channelId: string, severity: string, dedupeKey: string): string {
    return `${tenant}\u0000${channelId}\u0000${severity}\u0000${dedupeKey}`;
  }

  size(): number {
    return this.expiry.size;
  }

  private prune(now: number): void {
    for (const [k, until] of this.expiry) {
      if (until <= now) this.expiry.delete(k);
    }
  }

  /** Claim the key. False means an unexpired claim exists (a duplicate). */
  acquire(key: string): boolean {
    const now = this.clock.now();
    const until = this.expiry.get(key);
    if (until !== undefined && until > now) return false;
    if (until !== undefined) this.expiry.delete(key);
    if (this.expiry.size >= this.maxEntries) {
      this.prune(now);
      if (this.expiry.size >= this.maxEntries) {
        const oldest = this.expiry.keys().next();
        if (!oldest.done) this.expiry.delete(oldest.value);
      }
    }
    this.expiry.set(key, now + this.windowMs);
    return true;
  }

  /** Give the key back (the delivery did not happen), so a retry is not suppressed. */
  release(key: string): void {
    this.expiry.delete(key);
  }
}
