// Per-key call limiter for the MCP core (DESIGN 3.6 and T8). Purpose: bound how often
// one principal may call tools. Trust boundary: state is in process memory only (the
// design notes a multi-instance deployment needs a shared store); the clock value is
// passed in by the caller, so the limiter reads no time itself. Fail closed: a
// non-finite time, an over-long key, or a full table denies. A fixed window allows up
// to twice the limit across a window boundary, a known and documented gap.

export interface McpRateLimiter {
  /** Count one call for `key` at `nowMs`. Synchronous, so check-and-count is atomic. */
  take(key: string, nowMs: number): { allowed: boolean };
}

export interface RateLimiterOptions {
  /** Calls allowed per key per window (1 to 1,000). */
  limit: number;
  /** Window length in milliseconds (1,000 to 3,600,000). */
  windowMs: number;
  /** Distinct keys tracked at once (default 10,000, at most 100,000). */
  maxKeys?: number;
}

export const RATE_LIMIT_MAX_KEY_CHARS = 256;
const bad = (): never => {
  throw new Error('MCP rate limiter options invalid');
};

export function createRateLimiter(options: RateLimiterOptions): McpRateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) bad();
  if (!Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) bad();
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 100_000) bad();

  const entries = new Map<string, { slot: number; count: number }>();
  let purgedSlot = -Infinity;

  return {
    take(key, nowMs) {
      if (typeof key !== 'string' || key.length === 0 || key.length > RATE_LIMIT_MAX_KEY_CHARS) return { allowed: false };
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) return { allowed: false };
      const slot = Math.floor(nowMs / windowMs);
      let entry = entries.get(key);
      if (entry === undefined) {
        if (entries.size >= maxKeys && purgedSlot !== slot) {
          // At most one sweep per window, so a flood of new keys cannot make each call O(n).
          purgedSlot = slot;
          for (const [k, e] of entries) if (e.slot < slot) entries.delete(k);
        }
        if (entries.size >= maxKeys) return { allowed: false };
        entry = { slot, count: 0 };
        entries.set(key, entry);
      } else if (slot > entry.slot) {
        entry.slot = slot;
        entry.count = 0;
      } // a clock that moved backwards keeps the old window's count (fail closed)
      if (entry.count >= limit) return { allowed: false };
      entry.count += 1;
      return { allowed: true };
    },
  };
}
