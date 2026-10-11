// Tests for forecastSeries, forecastFleet and backtestSeries (checklist 2.1, 2.6).
// All fixtures are deterministic; noise comes from the seeded PRNG in testkit.

import { describe, expect, it } from 'vitest';
import { addDays, parseDay, weekdayOf } from '@/detection/dates';
import { backtestSeries, forecastFleet, forecastSeries } from '@/detection/forecast';
import { gaussian, mkSeries, mulberry32, WEEKLY_PATTERN } from '@/detection/testkit';
import { DetectionError, LIMITS } from '@/detection/types';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DetectionError ? err.code : 'NOT_A_DETECTION_ERROR';
  }
}

function flat(n: number, value: number, start = '2026-01-01'): ReturnType<typeof mkSeries> {
  return mkSeries({ start, values: Array.from({ length: n }, () => value) });
}

function seasonal(n: number, base: number, noise: number, seed: number, start = '2026-01-01') {
  const rng = mulberry32(seed);
  const startDn = parseDay(start);
  return mkSeries({
    start,
    values: Array.from({ length: n }, (_, i) => {
      const f = WEEKLY_PATTERN[weekdayOf(startDn + i)] as number;
      return Math.max(0, base * f * (1 + noise * gaussian(rng)));
    }),
  });
}

describe('flat series', () => {
  it('forecasts the level with a small interval and is not estimated at 60 days', () => {
    const s = flat(60, 100); // 2026-01-01 .. 2026-03-01
    const f = forecastSeries(s, '2026-03-01', 14);
    expect(f.status).toBe('ok');
    expect(f.method).toBe('level_trend_weekday');
    expect(f.estimated).toBe(false);
    expect(f.reasons).toEqual([]);
    expect(f.points).toHaveLength(14);
    expect(f.points[0]?.day).toBe('2026-03-02');
    for (const p of f.points) {
      expect(p.point).toBeCloseTo(100, 6);
      expect(p.lo80).toBeLessThanOrEqual(p.point);
      expect(p.hi80).toBeGreaterThanOrEqual(p.point);
      expect(p.lo95).toBeLessThanOrEqual(p.lo80);
      expect(p.hi95).toBeGreaterThanOrEqual(p.hi80);
      expect(p.hi95 - p.lo95).toBeLessThan(5);
    }
  });

  it('orders the interval bounds lo95 <= lo80 <= point <= hi80 <= hi95 on noisy data', () => {
    const s = seasonal(90, 200, 0.15, 7);
    const f = forecastSeries(s, '2026-03-31', 30);
    for (const p of f.points) {
      expect(p.lo95).toBeLessThanOrEqual(p.lo80);
      expect(p.lo80).toBeLessThanOrEqual(p.point);
      expect(p.point).toBeLessThanOrEqual(p.hi80);
      expect(p.hi80).toBeLessThanOrEqual(p.hi95);
      expect(p.lo95).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('weekday seasonality', () => {
  it('reproduces the weekly shape: weekends are lower than weekdays', () => {
    const s = seasonal(84, 100, 0, 1); // noise-free weekly pattern
    const f = forecastSeries(s, '2026-03-25', 14);
    for (const p of f.points) {
      const dow = weekdayOf(parseDay(p.day));
      const expected = 100 * (WEEKLY_PATTERN[dow] as number);
      expect(Math.abs(p.point - expected)).toBeLessThan(expected * 0.08);
    }
    const sunday = f.points.find((p) => weekdayOf(parseDay(p.day)) === 0)?.point as number;
    const tuesday = f.points.find((p) => weekdayOf(parseDay(p.day)) === 2)?.point as number;
    expect(sunday).toBeLessThan(tuesday * 0.7);
  });

  it('is robust to a single past spike inside the fit window', () => {
    const base = seasonal(84, 100, 0, 1);
    const values = base.points.map((p) => p.value);
    values[values.length - 10] = (values[values.length - 10] as number) * 20;
    const spiked = mkSeries({ start: '2026-01-01', values });
    const clean = forecastSeries(base, '2026-03-25', 7);
    const dirty = forecastSeries(spiked, '2026-03-25', 7);
    for (let i = 0; i < 7; i += 1) {
      const c = clean.points[i]?.point as number;
      const d = dirty.points[i]?.point as number;
      expect(Math.abs(d - c)).toBeLessThan(c * 0.15);
    }
  });
});

describe('trend', () => {
  it('follows a ramp (damped) rather than staying flat', () => {
    const s = mkSeries({ start: '2026-01-01', values: Array.from({ length: 70 }, (_, i) => 100 + 2 * i) });
    const f = forecastSeries(s, '2026-03-11', 14);
    const last = 100 + 2 * 69;
    expect(f.points[0]?.point as number).toBeGreaterThan(last);
    expect(f.points[13]?.point as number).toBeGreaterThan(f.points[0]?.point as number);
    // Damped: 14 days of undamped slope would add 28; damping adds less.
    expect((f.points[13]?.point as number) - last).toBeLessThan(28);
    expect((f.points[13]?.point as number) - last).toBeGreaterThan(15);
  });

  it('never forecasts a negative point on a falling series', () => {
    const s = mkSeries({ start: '2026-01-01', values: Array.from({ length: 60 }, (_, i) => Math.max(0, 60 - i)) });
    const f = forecastSeries(s, '2026-03-01', 30);
    for (const p of f.points) {
      expect(p.point).toBeGreaterThanOrEqual(0);
      expect(p.lo80).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('step change', () => {
  it('moves to the new level once the window has absorbed it', () => {
    const values = [...Array.from({ length: 40 }, () => 100), ...Array.from({ length: 30 }, () => 250)];
    const s = mkSeries({ start: '2026-01-01', values });
    const f = forecastSeries(s, '2026-03-11', 7);
    for (const p of f.points) expect(Math.abs(p.point - 250)).toBeLessThan(15);
  });
});

describe('minimum history and the estimated flag', () => {
  it('returns no_history with no numbers for an empty series', () => {
    const f = forecastSeries(mkSeries({ start: '2026-01-01', values: [] }), '2026-03-01', 7);
    expect(f.status).toBe('no_history');
    expect(f.estimated).toBe(true);
    expect(f.points).toEqual([]);
    expect(f.monthEnd).toBeNull();
    expect(f.method).toBe('none');
  });

  it('treats a series whose data all lies after the as-of day as no_history', () => {
    const s = flat(20, 10, '2026-03-10');
    expect(forecastSeries(s, '2026-03-01', 7).status).toBe('no_history');
  });

  it('uses the mean of available days below 14 observed days and flags estimated', () => {
    for (const n of [1, 2, 13]) {
      const s = flat(n, 50);
      const f = forecastSeries(s, addDays('2026-01-01', n - 1), 7);
      expect(f.status).toBe('ok');
      expect(f.method).toBe('mean_of_available');
      expect(f.estimated).toBe(true);
      expect(f.reasons).toContain('very_short_history');
      expect(f.points[0]?.point).toBe(50);
      expect(f.points[0]?.hi80 as number).toBeGreaterThan(50);
    }
  });

  it('fits from 14 days but stays estimated until 56 observed days', () => {
    const at14 = forecastSeries(flat(14, 50), '2026-01-14', 7);
    expect(at14.method).toBe('level_trend_weekday');
    expect(at14.estimated).toBe(true);
    expect(at14.reasons).toContain('short_history');
    const at55 = forecastSeries(flat(55, 50), '2026-02-24', 7);
    expect(at55.estimated).toBe(true);
    const at56 = forecastSeries(flat(56, 50), '2026-02-25', 7);
    expect(at56.estimated).toBe(false);
    expect(at56.historyDays).toBe(56);
  });

  it('flags a stale series whose last observation is more than 7 days before as-of', () => {
    const s = flat(60, 20);
    const f = forecastSeries(s, '2026-03-20', 7);
    expect(f.reasons).toContain('stale_history');
    expect(f.estimated).toBe(true);
    expect(f.lastObservedDay).toBe('2026-03-01');
  });

  it('flags negative days in the fit window', () => {
    const values = Array.from({ length: 60 }, (_, i) => (i === 50 ? -20 : 30));
    const f = forecastSeries(mkSeries({ start: '2026-01-01', values }), '2026-03-01', 7);
    expect(f.reasons).toContain('negative_days');
    expect(f.estimated).toBe(true);
  });
});

describe('missing days (gaps)', () => {
  it('counts gaps, skips them in the fit and still forecasts the level', () => {
    const values: (number | null)[] = Array.from({ length: 70 }, (_, i) => (i % 5 === 3 ? null : 80));
    const s = mkSeries({ start: '2026-01-01', values });
    const f = forecastSeries(s, '2026-03-11', 7);
    expect(f.gapDays).toBeGreaterThan(10);
    expect(f.historyDays + f.gapDays).toBe(70);
    for (const p of f.points) expect(p.point).toBeCloseTo(80, 4);
  });

  it('flags a sparse series (more than 30 percent gaps)', () => {
    const values: (number | null)[] = Array.from({ length: 70 }, (_, i) => (i % 2 === 0 ? 80 : null));
    const f = forecastSeries(mkSeries({ start: '2026-01-01', values }), '2026-03-11', 7);
    expect(f.reasons).toContain('sparse_history');
    expect(f.estimated).toBe(true);
  });

  it('treats absent days as zero under gapPolicy zero', () => {
    const values: (number | null)[] = Array.from({ length: 70 }, (_, i) => (i % 2 === 0 ? 80 : null));
    const s = mkSeries({ start: '2026-01-01', values });
    const missing = forecastSeries(s, '2026-03-11', 14, { gapPolicy: 'missing' });
    const zero = forecastSeries(s, '2026-03-11', 14, { gapPolicy: 'zero' });
    const avg = (f: typeof missing): number => f.points.reduce((a, p) => a + p.point, 0) / f.points.length;
    expect(avg(missing)).toBeGreaterThan(70);
    expect(avg(zero)).toBeLessThan(60);
    expect(zero.gapDays).toBe(0);
    expect(codeOf(() => forecastSeries(s, '2026-03-11', 7, { gapPolicy: 'interpolate' as never }))).toBe('OPTIONS_INVALID');
  });

  it('imputes missing month-to-date days in the month-end total and says so', () => {
    const values: (number | null)[] = Array.from({ length: 70 }, () => 10);
    values[62] = null; // 2026-03-04
    const f = forecastSeries(mkSeries({ start: '2026-01-01', values }), '2026-03-10', 7);
    expect(f.monthEnd?.imputedDays).toBe(1);
    expect(f.reasons).toContain('gaps_imputed');
    expect(f.monthEnd?.imputedAmount).toBeCloseTo(10, 4);
    expect(f.monthEnd?.actualToDate).toBeCloseTo(90, 6);
  });
});

describe('month-end projection and calendar edges', () => {
  it('projects a flat 10 per day to 280 for February 2026 (28 days)', () => {
    const s = flat(40, 10); // 2026-01-01 .. 2026-02-09
    const f = forecastSeries(s, '2026-02-09', 7);
    expect(f.monthEnd?.daysInMonth).toBe(28);
    expect(f.monthEnd?.remainingDays).toBe(19);
    expect(f.monthEnd?.actualToDate).toBe(90);
    expect(f.monthEnd?.projected).toBeCloseTo(280, 4);
    expect(f.points).toHaveLength(7);
  });

  it('uses 29 days for February 2028 (leap year)', () => {
    const s = flat(40, 10, '2028-01-01');
    const f = forecastSeries(s, '2028-02-09', 3);
    expect(f.monthEnd?.daysInMonth).toBe(29);
    expect(f.monthEnd?.projected).toBeCloseTo(290, 4);
  });

  it('on the last day of the month the projection equals the actual total', () => {
    const s = flat(59, 10); // 2026-01-01 .. 2026-02-28
    const f = forecastSeries(s, '2026-02-28', 7);
    expect(f.monthEnd?.remainingDays).toBe(0);
    expect(f.monthEnd?.forecastRemaining).toBe(0);
    expect(f.monthEnd?.projected).toBe(280);
    expect(f.monthEnd?.lo95).toBe(280);
    expect(f.monthEnd?.hi95).toBe(280);
  });

  it('on the first day of a month the month-to-date is that one day', () => {
    const s = flat(60, 10); // through 2026-03-01
    const f = forecastSeries(s, '2026-03-01', 7);
    expect(f.monthEnd?.actualToDate).toBe(10);
    expect(f.monthEnd?.remainingDays).toBe(30);
    expect(f.monthEnd?.projected).toBeCloseTo(310, 4);
  });

  it('keeps the month-end interval ordered around the projection', () => {
    const f = forecastSeries(seasonal(90, 100, 0.2, 3), '2026-03-20', 7);
    const m = f.monthEnd;
    expect(m).not.toBeNull();
    expect(m?.lo95 as number).toBeLessThanOrEqual(m?.lo80 as number);
    expect(m?.lo80 as number).toBeLessThanOrEqual(m?.projected as number);
    expect(m?.projected as number).toBeLessThanOrEqual(m?.hi80 as number);
    expect(m?.hi80 as number).toBeLessThanOrEqual(m?.hi95 as number);
  });

  it('is identical under different process time zones (finding F1)', () => {
    const original = process.env.TZ;
    const s = seasonal(70, 100, 0.1, 11);
    try {
      const out = ['UTC', 'Asia/Tokyo', 'America/Chicago'].map((tz) => {
        process.env.TZ = tz;
        return JSON.stringify(forecastSeries(s, '2026-03-11', 21));
      });
      expect(out[1]).toBe(out[0]);
      expect(out[2]).toBe(out[0]);
      const parsed = JSON.parse(out[0] as string) as { monthEnd: { daysInMonth: number } };
      expect(parsed.monthEnd.daysInMonth).toBe(31);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('computes the horizon across a DST date as exactly one entry per UTC day', () => {
    const s = flat(60, 10, '2026-01-01');
    const f = forecastSeries(s, '2026-03-05', 7); // covers 2026-03-08 (US DST)
    expect(f.points.map((p) => p.day)).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ]);
  });
});

describe('no future leakage and determinism', () => {
  it('ignores data after the as-of day', () => {
    const full = seasonal(100, 100, 0.1, 5);
    const truncated = mkSeries({ start: '2026-01-01', values: full.points.slice(0, 70).map((p) => p.value) });
    const a = forecastSeries(full, '2026-03-11', 14);
    const b = forecastSeries(truncated, '2026-03-11', 14);
    expect(a).toEqual(b);
  });

  it('is deterministic: the same input twice gives deep-equal output', () => {
    const s = seasonal(90, 150, 0.12, 21);
    expect(forecastSeries(s, '2026-03-31', 30)).toEqual(forecastSeries(s, '2026-03-31', 30));
  });

  it('does not mutate its input', () => {
    const s = seasonal(70, 100, 0.1, 2);
    const copy = JSON.parse(JSON.stringify(s));
    forecastSeries(s, '2026-03-11', 14);
    expect(JSON.parse(JSON.stringify(s))).toEqual(copy);
  });
});

describe('validation', () => {
  const s = flat(40, 10);
  it('rejects a bad as-of day', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'yesterday', '', null, 20260301]) {
      expect(codeOf(() => forecastSeries(s, bad as never, 7))).toBe('AS_OF_INVALID');
    }
  });

  it('accepts the horizon cap and refuses one past it, zero, fractions and non-numbers', () => {
    expect(forecastSeries(s, '2026-02-09', LIMITS.maxHorizonDays).points).toHaveLength(LIMITS.maxHorizonDays);
    expect(codeOf(() => forecastSeries(s, '2026-02-09', LIMITS.maxHorizonDays + 1))).toBe('HORIZON_INVALID');
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '7', null]) {
      expect(codeOf(() => forecastSeries(s, '2026-02-09', bad as never))).toBe('HORIZON_INVALID');
    }
  });

  it('refuses a malformed series without echoing it', () => {
    const bad = { ...s, id: 'SECRET-id-123' };
    try {
      forecastSeries(bad, '2026-02-09', 7);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DetectionError).code).toBe('SERIES_INVALID');
      expect((err as Error).message).not.toContain('SECRET');
    }
  });

  it('marks extrapolated points beyond 14 days', () => {
    const f = forecastSeries(seasonal(90, 100, 0.1, 9), '2026-03-31', 30);
    expect(f.points[13]?.extrapolated).toBe(false);
    expect(f.points[14]?.extrapolated).toBe(true);
  });
});

describe('extreme and zero series', () => {
  it('forecasts a zero-spend series as zero with a degenerate but ordered interval', () => {
    const f = forecastSeries(flat(60, 0), '2026-03-01', 7);
    expect(f.status).toBe('ok');
    for (const p of f.points) {
      expect(p.point).toBe(0);
      expect(p.lo95).toBe(0);
      expect(p.hi95).toBeGreaterThanOrEqual(0);
    }
    expect(f.monthEnd?.projected).toBe(0);
  });

  it('handles very large values without overflow or NaN', () => {
    const f = forecastSeries(flat(60, 5e11), '2026-03-01', 7);
    for (const p of f.points) {
      expect(Number.isFinite(p.point)).toBe(true);
      expect(Number.isFinite(p.hi95)).toBe(true);
    }
    expect(f.points[0]?.point).toBeCloseTo(5e11, -3);
  });

  it('handles tiny values (sub-cent) without NaN', () => {
    const f = forecastSeries(flat(60, 0.000002), '2026-03-01', 3);
    for (const p of f.points) expect(Number.isFinite(p.hi80)).toBe(true);
  });
});

describe('forecastFleet (currency isolation and roll-up)', () => {
  const usd = mkSeries({ start: '2026-01-01', values: Array.from({ length: 60 }, () => 100), currency: 'USD', account: 'a1' });
  const usd2 = mkSeries({ start: '2026-01-01', values: Array.from({ length: 60 }, () => 50), currency: 'USD', account: 'a2' });
  const eur = mkSeries({ start: '2026-01-01', values: Array.from({ length: 60 }, () => 80), currency: 'EUR', account: 'a1' });
  const jpy = mkSeries({ start: '2026-01-01', values: Array.from({ length: 60 }, () => 15000), currency: 'JPY', account: 'a1' });

  it('never sums across currencies: one group per tenant and currency', () => {
    const fleet = forecastFleet([usd, usd2, eur, jpy], '2026-03-01', 3);
    expect(fleet.groups.map((g) => g.currency)).toEqual(['EUR', 'JPY', 'USD']);
    const byCur = new Map(fleet.groups.map((g) => [g.currency, g]));
    expect(byCur.get('USD')?.points[0]?.point).toBeCloseTo(150, 4);
    expect(byCur.get('EUR')?.points[0]?.point).toBeCloseTo(80, 4);
    expect(byCur.get('JPY')?.points[0]?.point).toBeCloseTo(15000, 2);
    expect(byCur.get('USD')?.seriesCount).toBe(2);
  });

  it('the group month-end equals the sum of its series month-ends', () => {
    const fleet = forecastFleet([usd, usd2], '2026-03-01', 3);
    const group = fleet.groups[0];
    const total = fleet.series.reduce((acc, s) => acc + (s.monthEnd?.projected ?? 0), 0);
    expect(group?.monthEnd?.projected).toBeCloseTo(total, 4);
    expect(group?.monthEnd?.projected).toBeCloseTo(150 * 31, 2);
  });

  it('keeps tenants apart', () => {
    const other = mkSeries({ start: '2026-01-01', values: Array.from({ length: 60 }, () => 7), tenant: 'tenant-2' });
    const fleet = forecastFleet([usd, other], '2026-03-01', 3);
    expect(fleet.groups).toHaveLength(2);
    expect(fleet.groups.map((g) => g.tenant).sort()).toEqual(['tenant-1', 'tenant-2']);
  });

  it('reports estimated when any member series is estimated, and counts no-history series', () => {
    const young = mkSeries({ start: '2026-02-20', values: Array.from({ length: 10 }, () => 5), account: 'young' });
    const empty = mkSeries({ start: '2026-01-01', values: [], account: 'empty' });
    const fleet = forecastFleet([usd, young, empty], '2026-03-01', 3);
    const g = fleet.groups[0];
    expect(g?.seriesCount).toBe(3);
    expect(g?.noHistorySeries).toBe(1);
    expect(g?.estimatedSeries).toBe(1);
    expect(g?.estimated).toBe(true);
  });

  it('refuses duplicate series ids and enforces the series cap', () => {
    expect(codeOf(() => forecastFleet([usd, usd], '2026-03-01', 3))).toBe('SERIES_INVALID');
    expect(codeOf(() => forecastFleet(new Array(LIMITS.maxSeries + 1).fill(usd), '2026-03-01', 3))).toBe('SERIES_CAP_EXCEEDED');
    expect(codeOf(() => forecastFleet('x' as never, '2026-03-01', 3))).toBe('SERIES_INVALID');
  });

  it('is independent of input order', () => {
    const a = forecastFleet([usd, usd2, eur], '2026-03-01', 3);
    const b = forecastFleet([eur, usd2, usd], '2026-03-01', 3);
    expect(a).toEqual(b);
  });
});

describe('backtest accuracy', () => {
  it('meets a stated MAPE threshold on synthetic seasonal data (MAPE <= 0.10, 14-day holdout)', () => {
    // 150 days of a weekday pattern with 5 percent noise; scored on the last 14.
    const s = seasonal(150, 200, 0.05, 20260401);
    const asOf = addDays('2026-01-01', 149);
    const r = backtestSeries(s, asOf, { holdoutDays: 14, origins: 4, stepDays: 7 });
    expect(r.aggregate.n).toBeGreaterThanOrEqual(50);
    expect(r.aggregate.mape).not.toBeNull();
    expect(r.aggregate.mape as number).toBeLessThanOrEqual(0.1);
    expect(r.aggregate.wape as number).toBeLessThanOrEqual(0.08);
    expect(Math.abs(r.aggregate.bias as number)).toBeLessThanOrEqual(0.05);
  });

  it('is exact on noise-free flat data', () => {
    const r = backtestSeries(flat(90, 40), '2026-03-31', { holdoutDays: 14 });
    expect(r.aggregate.mape).toBe(0);
    expect(r.aggregate.wape).toBe(0);
    expect(r.aggregate.bias).toBe(0);
  });

  it('beats a flat-mean baseline that ignores weekdays on seasonal data', () => {
    const s = seasonal(120, 200, 0.03, 99);
    const asOf = addDays('2026-01-01', 119);
    const r = backtestSeries(s, asOf, { holdoutDays: 14 });
    const train = s.points.slice(0, 120 - 14).map((p) => p.value);
    const flatMean = train.slice(-28).reduce((a, b) => a + b, 0) / 28;
    const test = s.points.slice(120 - 14);
    const flatWape = test.reduce((a, p) => a + Math.abs(p.value - flatMean), 0) / test.reduce((a, p) => a + p.value, 0);
    expect(r.aggregate.wape as number).toBeLessThan(flatWape);
  });

  it('reports interval coverage in [0, 1] and a plausible 80 percent coverage', () => {
    const s = seasonal(180, 200, 0.08, 4242);
    const asOf = addDays('2026-01-01', 179);
    const r = backtestSeries(s, asOf, { holdoutDays: 14, origins: 8, stepDays: 7 });
    expect(r.aggregate.coverage80 as number).toBeGreaterThan(0.55);
    expect(r.aggregate.coverage80 as number).toBeLessThanOrEqual(1);
    expect(r.aggregate.coverage95 as number).toBeGreaterThanOrEqual(r.aggregate.coverage80 as number);
  });

  it('never lets an origin see its own holdout: poisoning the holdout cannot change its forecast', () => {
    const s = seasonal(100, 100, 0.05, 31);
    const asOf = addDays('2026-01-01', 99);
    const values = s.points.map((p) => p.value);
    const poisoned = mkSeries({ start: '2026-01-01', values: values.map((v, i) => (i >= 86 ? v * 50 : v)) });
    const originDay = addDays(asOf, -14);
    expect(forecastSeries(s, originDay, 14)).toEqual(forecastSeries(poisoned, originDay, 14));
  });

  it('returns null metrics, not NaN, when nothing can be scored', () => {
    const r = backtestSeries(flat(5, 10), '2026-01-05', { holdoutDays: 14 });
    expect(r.aggregate.n).toBe(0);
    expect(r.aggregate.mape).toBeNull();
    expect(r.aggregate.wape).toBeNull();
    expect(r.aggregate.coverage80).toBeNull();
  });

  it('returns a null wape on an all-zero holdout instead of dividing by zero', () => {
    const r = backtestSeries(flat(90, 0), '2026-03-31', { holdoutDays: 14 });
    expect(r.aggregate.wape).toBeNull();
    expect(r.aggregate.n).toBe(14);
  });

  it('validates its options', () => {
    const s = flat(60, 10);
    for (const bad of [{ holdoutDays: 0 }, { holdoutDays: 31 }, { origins: 9 }, { stepDays: 0 }, { holdoutDays: 1.5 }]) {
      expect(codeOf(() => backtestSeries(s, '2026-03-01', bad))).toBe('BACKTEST_INVALID');
    }
    expect(codeOf(() => backtestSeries(s, '2026-03-01', { mapeFloor: 0 }))).toBe('BACKTEST_INVALID');
    expect(codeOf(() => backtestSeries(s, 'nope'))).toBe('AS_OF_INVALID');
  });
});
