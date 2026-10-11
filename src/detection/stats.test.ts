import { describe, expect, it } from 'vitest';
import { mean, median, quantile, scaledMad, sum } from '@/detection/stats';
import { DetectionError, compareStrings, isCurrency, isIdentifier, round4, round6 } from '@/detection/types';

describe('stats helpers', () => {
  it('computes medians for odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    quantile(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });

  it('interpolates quantiles and clamps p', () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 2)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], -1)).toBe(1);
    expect(quantile([], 0.5)).toBe(0);
  });

  it('sums with compensation so many small terms do not vanish', () => {
    const values = [1e16, ...Array.from({ length: 1000 }, () => 1), -1e16];
    expect(sum(values)).toBe(1000);
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });

  it('scaled MAD ignores a single outlier', () => {
    const clean = [10, 11, 9, 10, 12, 10, 9, 11];
    const dirty = [...clean, 1000];
    expect(scaledMad(dirty)).toBeLessThan(2.5);
    expect(scaledMad([])).toBe(0);
  });
});

describe('rounding and identifiers', () => {
  it('rounds to 6 decimals half away from zero and never returns -0', () => {
    expect(round6(1.0000005)).toBe(1.000001);
    expect(round6(-1.0000005)).toBe(-1.000001);
    expect(round6(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(round6(-0.0000001), 0)).toBe(true);
    expect(Object.is(round6(-0), 0)).toBe(true);
    expect(round6(123456789.1234567)).toBe(123456789.123457);
    expect(round4(0.12345)).toBe(0.1235);
    expect(round4(-0.12345)).toBe(-0.1235);
  });

  it('refuses non-finite values when rounding', () => {
    expect(() => round6(Number.NaN)).toThrow(DetectionError);
    expect(() => round6(Number.POSITIVE_INFINITY)).toThrow(DetectionError);
    expect(() => round4(Number.NEGATIVE_INFINITY)).toThrow(DetectionError);
  });

  it('validates identifiers and currencies deny-by-default', () => {
    expect(isIdentifier('acct-1')).toBe(true);
    expect(isIdentifier('Amazon EC2')).toBe(true);
    expect(isIdentifier('')).toBe(false);
    expect(isIdentifier('', true)).toBe(true);
    expect(isIdentifier('   ')).toBe(false);
    expect(isIdentifier('a|b')).toBe(false);
    expect(isIdentifier('a\nb')).toBe(false);
    expect(isIdentifier('a'.repeat(256))).toBe(true);
    expect(isIdentifier('a'.repeat(257))).toBe(false);
    expect(isIdentifier(42)).toBe(false);
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('usd')).toBe(false);
    expect(isCurrency('US')).toBe(false);
    expect(isCurrency('USDX')).toBe(false);
    expect(isCurrency(null)).toBe(false);
  });

  it('orders strings by code unit, not locale', () => {
    expect(compareStrings('a', 'b')).toBe(-1);
    expect(compareStrings('B', 'a')).toBe(-1); // uppercase sorts first
    expect(compareStrings('x', 'x')).toBe(0);
  });
});
