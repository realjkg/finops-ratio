import { describe, expect, it } from 'vitest';
import { RATIO_CEILING, RATIO_FLOOR, ratioDomain, ratioFraction, ratioTickLabel, ratioTicks } from './ratioAxis';

describe('ratio axis', () => {
  it('starts at zero when no ratio is negative', () => {
    expect(ratioDomain([2.3, 13.8, 0])).toEqual({ min: 0, max: RATIO_CEILING, clipped: false });
    expect(ratioDomain([])).toEqual({ min: 0, max: RATIO_CEILING, clipped: false });
  });

  it('extends below zero to the whole number under the lowest ratio', () => {
    expect(ratioDomain([-0.17, 4])).toEqual({ min: -1, max: RATIO_CEILING, clipped: false });
    expect(ratioDomain([-2.4, 1])).toEqual({ min: -3, max: RATIO_CEILING, clipped: false });
  });

  it('ignores non-finite ratios instead of poisoning the axis', () => {
    expect(ratioDomain([Number.NaN, Infinity, 3])).toEqual({ min: 0, max: RATIO_CEILING, clipped: false });
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
    expect(ratioTicks({ min: 0, max: 10, clipped: false })).toEqual([0, 1, 3, 5, 10]);
    expect(ratioTicks({ min: -1, max: 10, clipped: false })).toEqual([-1, 0, 1, 3, 5, 10]);
  });

  it('caps the negative extent at the floor and marks it, so extreme negatives cannot squash the scale', () => {
    const d = ratioDomain([-40, 2]);
    expect(d).toEqual({ min: RATIO_FLOOR, max: RATIO_CEILING, clipped: true });
    expect(ratioTickLabel(d.min, d)).toBe('\u2264 -5\u00d7');
    expect(ratioTickLabel(0, d)).toBe('0\u00d7');
    // 0x, 1x and 3x stay well apart on a 0..100 track: at least 5 points between neighbours.
    const pts = [0, 1, 3].map((v) => ratioFraction(v, d) * 100);
    expect(pts[1] - pts[0]).toBeGreaterThan(5);
    expect(pts[2] - pts[1]).toBeGreaterThan(5);
    expect(ratioFraction(-40, d)).toBe(0);
  });

  it('a ratio exactly at the floor is not clipped', () => {
    expect(ratioDomain([-5]).clipped).toBe(false);
  });

  it('ignores null (N/A) ratios', () => {
    expect(ratioDomain([null, 4])).toEqual({ min: 0, max: RATIO_CEILING, clipped: false });
  });
});
