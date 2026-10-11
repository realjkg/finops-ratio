import { describe, expect, it } from 'vitest';
import { createRateLimiter, RATE_LIMIT_MAX_KEY_CHARS } from './rateLimit';

const T0 = 1_800_000_000_000;

describe('createRateLimiter', () => {
  it('allows exactly limit calls per window and refuses the next', () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect([1, 2, 3, 4, 5].map(() => rl.take('k', T0).allowed)).toEqual([true, true, true, false, false]);
  });
  it('opens a fresh window at the boundary', () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const start = Math.floor(T0 / 60_000) * 60_000;
    rl.take('k', start);
    rl.take('k', start + 59_999);
    expect(rl.take('k', start + 59_999).allowed).toBe(false);
    expect(rl.take('k', start + 60_000).allowed).toBe(true);
  });
  it('keeps keys apart', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.take('a', T0).allowed).toBe(true);
    expect(rl.take('b', T0).allowed).toBe(true);
    expect(rl.take('a', T0).allowed).toBe(false);
  });
  it('does not reset when the clock moves backwards', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.take('k', T0).allowed).toBe(true);
    expect(rl.take('k', T0 - 3_600_000).allowed).toBe(false);
  });
  it('fails closed on a bad key or time', () => {
    const rl = createRateLimiter({ limit: 5, windowMs: 60_000 });
    for (const key of ['', 'k'.repeat(RATE_LIMIT_MAX_KEY_CHARS + 1), undefined as never]) expect(rl.take(key, T0).allowed).toBe(false);
    expect(rl.take('k'.repeat(RATE_LIMIT_MAX_KEY_CHARS), T0).allowed).toBe(true);
    for (const now of [NaN, Infinity, -1, '1' as never]) expect(rl.take('k', now).allowed).toBe(false);
  });
  it('refuses new keys when full, and recovers after the window', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2 });
    rl.take('a', T0);
    rl.take('b', T0);
    expect(rl.take('c', T0).allowed).toBe(false);
    expect(rl.take('c', T0 + 1_000).allowed).toBe(true);
  });
  it('rejects invalid options', () => {
    const bad = [{ limit: 0, windowMs: 60_000 }, { limit: 1_001, windowMs: 60_000 }, { limit: 1.5, windowMs: 60_000 }, { limit: 1, windowMs: 999 },
      { limit: 1, windowMs: 3_600_001 }, { limit: 1, windowMs: 60_000, maxKeys: 0 }, { limit: 1, windowMs: 60_000, maxKeys: 100_001 }];
    for (const o of bad) expect(() => createRateLimiter(o)).toThrow('MCP rate limiter options invalid');
  });
});
