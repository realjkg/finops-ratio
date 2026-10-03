// Sliding-window rate limiter (Wave3b gateway). In-memory, keyed by tenant —
// adequate for this single-instance demo. NOTE: production behind multiple
// instances would key a shared store (Redis) instead; the interface is the same
// so swapping the backing store is the only change.
//
// Aligns with the repo's API-First rule (.obvious/obvious.md): 1,000 req/min
// standard tier. A window is the trailing `windowMs`; each accepted request
// records a timestamp and stale timestamps are pruned on every call.

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the window frees the oldest slot. */
  resetMs: number;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSec: number;
}

export const STANDARD_TIER_LIMIT = 1000;
export const WINDOW_MS = 60_000;

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastPrune = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limit: number = STANDARD_TIER_LIMIT,
    private readonly windowMs: number = WINDOW_MS,
    // Injectable clock keeps the limiter deterministic under test.
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Drop every key whose hits are all older than the window, at most once per
   * window — keeps the map bounded by the keys active in the last window.
   */
  private prune(now: number): void {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    const windowStart = now - this.windowMs;
    for (const [key, hits] of this.hits) {
      if (!hits.some((t) => t > windowStart)) this.hits.delete(key);
    }
  }

  /** Number of tracked keys (tests / diagnostics). */
  size(): number {
    return this.hits.size;
  }

  take(key: string): RateLimitResult {
    const now = this.now();
    this.prune(now);
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const resetMs = recent[0] + this.windowMs;
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        resetMs,
        retryAfterSec: Math.max(1, Math.ceil((resetMs - now) / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - recent.length,
      resetMs: now + this.windowMs,
      retryAfterSec: 0,
    };
  }

  /**
   * Whether `key` is currently over the limit, WITHOUT consuming a slot. Lets a
   * caller count only some events (e.g. failed auth) yet block every request
   * from a key that is over the limit.
   */
  peek(key: string): RateLimitResult {
    const now = this.now();
    this.prune(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    const blocked = recent.length >= this.limit;
    const resetMs = recent.length > 0 ? recent[0] + this.windowMs : now + this.windowMs;
    return {
      allowed: !blocked,
      limit: this.limit,
      remaining: Math.max(0, this.limit - recent.length),
      resetMs,
      retryAfterSec: blocked ? Math.max(1, Math.ceil((resetMs - now) / 1000)) : 0,
    };
  }

  /** Drop a key's history — exposed for tests and future tenant resets. */
  reset(key: string): void {
    this.hits.delete(key);
  }
}

