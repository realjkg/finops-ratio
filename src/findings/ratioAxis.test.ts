import { describe, expect, it } from 'vitest';
import { RATIO_CEILING, ratioDomain, ratioFraction, ratioTicks } from './ratioAxis';

describe('ratio axis', () => {
  it('starts at zero when no ratio is negative', () => {
    expect(ratioDomain([2.3, 13.8, 0])).toEqual({ min: 0, max: RATIO_CEILING });
    expect(ratioDomain([])).toEqual({ min: 0, max: RATIO_CEILING });
  });

  it('extends below zero to the whole number under the lowest ratio', () => {
    expect(ratioDomain([-0.17, 4])).toEqual({ min: -1, max: RATIO_CEILING });
    expect(ratioDomain([-2.4, 1])).toEqual({ min: -3, max: RATIO_CEILING });
  });

  it('ignores non-finite ratios instead of poisoning the axis', () => {
    expect(ratioDomain([Number.NaN, Infinity, 3])).toEqual({ min: 0, max: RATIO_CEILING });
  });

  it('places a negative ratio left of the zero line, not on it', () => {
    const d = ratioDomain([-0.17, 4]);
    expect(ratioFraction(0, d)).toBeCloseTo(1 / 11);
    expect(ratioFraction(-0.17, d)).toBeLessThan(ratioFraction(0, d));
    expect(ratioFraction(-0.17, d)).toBeGreaterThan(0);
  });

  it('clamps only outside the domain', () => {
    const d = ratioDomain([-0.17]);
    expect(ratioFraction(-50, d)).toBe(0);
    expect(ratioFraction(50, d)).toBe(1);
  });

  it('adds the negative floor as a tick only when needed', () => {
    expect(ratioTicks({ min: 0, max: 10 })).toEqual([0, 1, 3, 5, 10]);
    expect(ratioTicks({ min: -1, max: 10 })).toEqual([-1, 0, 1, 3, 5, 10]);
  });
});
