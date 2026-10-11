import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, HARD_LIMITS, resolveLimits, type McpLimits } from './limits';

describe('resolveLimits', () => {
  it('returns the defaults for no or invalid overrides', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits(null as never)).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits('x' as never)).toEqual(DEFAULT_LIMITS);
    const junk = { maxMessageBytes: NaN, maxArgBytes: -5, maxResultBytes: 0, toolTimeoutMs: 1.5, auditTimeoutMs: '9' as never, maxKeyBytes: Infinity };
    expect(resolveLimits(junk)).toEqual(DEFAULT_LIMITS);
  });

  it('takes valid overrides and clamps each to its hard ceiling', () => {
    expect(resolveLimits({ maxArgBytes: 100 }).maxArgBytes).toBe(100);
    expect(resolveLimits({ maxArgBytes: 1 }).maxArgBytes).toBe(1);
    for (const key of Object.keys(HARD_LIMITS) as (keyof McpLimits)[]) {
      expect(resolveLimits({ [key]: HARD_LIMITS[key] })[key], key).toBe(HARD_LIMITS[key]);
      expect(resolveLimits({ [key]: HARD_LIMITS[key] + 1 })[key], key).toBe(HARD_LIMITS[key]);
      expect(resolveLimits({ [key]: Number.MAX_SAFE_INTEGER })[key], key).toBe(HARD_LIMITS[key]);
    }
  });

  it('keeps every default at or under its ceiling, and both tables frozen', () => {
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof McpLimits)[]) expect(DEFAULT_LIMITS[key]).toBeLessThanOrEqual(HARD_LIMITS[key]);
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect(Object.isFrozen(HARD_LIMITS)).toBe(true);
  });

  it('ignores inherited override keys', () => {
    const inherited = Object.create({ maxArgBytes: 5 }) as Partial<McpLimits>;
    expect(resolveLimits(inherited).maxArgBytes).toBe(DEFAULT_LIMITS.maxArgBytes);
  });

  it('does not mutate the defaults', () => {
    resolveLimits({ maxArgBytes: 7 }).maxArgBytes += 1;
    expect(DEFAULT_LIMITS.maxArgBytes).toBe(2048);
  });
});
