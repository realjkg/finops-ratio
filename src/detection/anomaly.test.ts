// Core detectAnomalies scenarios (checklist 2.2, 2.6): flat, weekday pattern,
// spike, step, ramp, gaps, short history, currency isolation, calendar edges,
// DST and time zone immunity, extreme and zero series, determinism.

import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '@/detection/anomaly';
import { mkSeries, START, dayAt, synth, TENANT } from '@/detection/testkit';
import { DetectionError } from '@/detection/types';

const AS_OF = dayAt(89); // 2026-03-31

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DetectionError ? err.code : 'NOT_A_DETECTION_ERROR';
  }
}

describe('quiet series', () => {
  it('flat series with no noise yields no findings', () => {
    const s = mkSeries({ start: START, values: Array.from({ length: 90 }, () => 500) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toEqual([]);
    expect(r.stats.scoredLeaves).toBe(1);
  });

  it('a weekday-patterned noiseless series raises nothing on weekends or Mondays', () => {
    const s = synth({ n: 90, base: 1000, noise: 0, seed: 1 });
    for (let d = 40; d < 90; d += 1) {
      expect(detectAnomalies([s], dayAt(d)).findings).toEqual([]);
    }
  });

  it('a noisy weekday-patterned series is quiet over 50 consecutive days', () => {
    const s = synth({ n: 90, base: 1000, noise: 0.05, seed: 11 });
    let found = 0;
    for (let d = 40; d < 90; d += 1) found += detectAnomalies([s], dayAt(d)).findings.length;
    expect(found).toBe(0);
  });

  it('a sub-threshold wobble on a tiny series is ignored (dollar floor)', () => {
    // 5 dollars a day, then 30: a six-fold jump but far under the 100 dollar floor.
    const s = synth({ n: 90, base: 5, noise: 0.02, seed: 2, weekly: false, mod: (i, v) => (i === 89 ? 30 : v) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });
});

describe('single spike', () => {
  const spiked = (day: number) => synth({ n: 90, base: 1000, noise: 0.05, seed: 1, mod: (i, v) => (i === day ? v * 4 : v) });

  it('flags a four-fold spike on the as-of day as a critical spend_spike', () => {
    const r = detectAnomalies([spiked(89)], AS_OF);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f?.category).toBe('spend_spike');
    expect(f?.severity).toBe('critical');
    expect(f?.direction).toBe('up');
    expect(f?.scope).toBe('leaf');
    expect(f?.startDay).toBe(AS_OF);
    expect(f?.lastDay).toBe(AS_OF);
    expect(f?.impact as number).toBeGreaterThan(2500);
    expect(f?.relative as number).toBeGreaterThan(2);
    expect(f?.detectors).toEqual(['residual_1d']);
    expect(f?.estimated).toBe(false);
    expect(f?.cumulativeCriticalImpact).toBe(5000);
  });

  it('does not re-flag the spike on the following days (no aftershock)', () => {
    const s = spiked(87);
    expect(detectAnomalies([s], dayAt(88)).findings).toEqual([]);
    expect(detectAnomalies([s], dayAt(89)).findings).toEqual([]);
  });

  it('flags a spike on a weekend day relative to the weekend baseline', () => {
    // 2026-03-29 is a Sunday (index 87); normal Sunday is about 600.
    const s = synth({ n: 90, base: 1000, noise: 0.05, seed: 1, mod: (i, v) => (i === 87 ? v * 4 : v) });
    const r = detectAnomalies([s], dayAt(87));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.expected as number).toBeLessThan(800);
  });

  it('a moderate bump below the dollar floor is not warning or critical', () => {
    const s = synth({ n: 90, base: 1000, noise: 0.02, seed: 4, mod: (i, v) => (i === 89 ? v + 90 : v) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });
});

describe('step change', () => {
  const stepped = (pct: number) =>
    synth({ n: 90, base: 1000, noise: 0.03, seed: 2, mod: (i, v) => (i >= 80 ? v * pct : v) });

  it('flags a 30 percent step on its first day and keeps one finding key through day 8', () => {
    const s = stepped(1.3);
    const keys = new Set<string>();
    for (let d = 80; d <= 88; d += 1) {
      const r = detectAnomalies([s], dayAt(d));
      expect(r.findings, `day ${d}`).toHaveLength(1);
      expect(r.findings[0]?.severity).toBe('warning');
      keys.add(r.findings[0]?.key as string);
    }
    expect(keys.size).toBe(1);
  });

  it('reports a persistent step as a level shift after the first days', () => {
    const r = detectAnomalies([stepped(1.3)], dayAt(84));
    expect(r.findings[0]?.category).toBe('level_shift');
    expect(r.findings[0]?.startDay).toBe(dayAt(80));
  });

  it('does not flag anything before the step', () => {
    expect(detectAnomalies([stepped(1.3)], dayAt(79)).findings).toEqual([]);
  });

  it('a small 15 percent step is detected only as info (below the 20 percent relative floor)', () => {
    let worst = 'none';
    for (let d = 80; d <= 89; d += 1) {
      for (const f of detectAnomalies([stepped(1.15)], dayAt(d)).findings) worst = f.severity;
    }
    expect(['none', 'info']).toContain(worst);
  });

  it('a drop of 40 percent is a spend_drop and stays info', () => {
    const s = synth({ n: 90, base: 1000, noise: 0.03, seed: 3, mod: (i, v) => (i >= 85 ? v * 0.6 : v) });
    const r = detectAnomalies([s], dayAt(87));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.direction).toBe('down');
    expect(r.findings[0]?.category).toBe('spend_drop');
    expect(r.findings[0]?.severity).toBe('info');
    expect(r.findings[0]?.impact as number).toBeLessThan(0);
  });
});

describe('ramp', () => {
  const ramp = synth({ n: 90, base: 1000, noise: 0.03, seed: 3, mod: (i, v) => (i >= 70 ? v * (1 + 0.03 * (i - 69)) : v) });

  it('is quiet before the ramp starts', () => {
    for (let d = 60; d <= 70; d += 1) expect(detectAnomalies([ramp], dayAt(d)).findings).toEqual([]);
  });

  it('is detected within a week of starting and becomes a warning, labelled drift', () => {
    const seenAt = (d: number) => detectAnomalies([ramp], dayAt(d)).findings;
    expect(seenAt(76).length).toBeGreaterThan(0);
    const late = seenAt(85);
    expect(late).toHaveLength(1);
    expect(late[0]?.severity).toBe('warning');
    expect(late[0]?.category).toBe('gradual_drift');
  });
});

describe('missing days (gaps)', () => {
  it('stays quiet on a gappy series and still flags a spike', () => {
    const gappy = (spike: boolean) =>
      synth({
        n: 90,
        base: 1000,
        noise: 0.04,
        seed: 6,
        mod: (i, v) => (i % 6 === 2 && i < 89 ? null : spike && i === 89 ? v * 4 : v),
      });
    for (let d = 45; d < 89; d += 1) expect(detectAnomalies([gappy(false)], dayAt(d)).findings).toEqual([]);
    expect(detectAnomalies([gappy(true)], AS_OF).findings).toHaveLength(1);
  });

  it('skips a leaf with no data on the as-of day and counts it', () => {
    const s = synth({ n: 89, base: 1000, noise: 0.04, seed: 6 }); // last day is index 88
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toEqual([]);
    expect(r.stats.skipped.no_data_asof).toBe(1);
    expect(r.stats.scoredLeaves).toBe(0);
  });
});

describe('short history', () => {
  it('does not score a leaf with fewer than 14 observed days, even with a spike', () => {
    const s = synth({ n: 13, base: 1000, noise: 0.03, seed: 7, mod: (i, v) => (i === 12 ? v * 5 : v) });
    const r = detectAnomalies([s], dayAt(12));
    expect(r.findings).toEqual([]);
    expect(r.stats.skipped.insufficient_history).toBe(1);
  });

  it('scores from 14 observed days and marks the finding estimated (fewer than 56 days)', () => {
    const s = synth({ n: 20, base: 1000, noise: 0.02, seed: 8, mod: (i, v) => (i === 19 ? v * 5 : v) });
    const r = detectAnomalies([s], dayAt(19));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.estimated).toBe(true);
  });

  it('honors a longer configured minimum history', () => {
    const s = synth({ n: 20, base: 1000, noise: 0.02, seed: 8, mod: (i, v) => (i === 19 ? v * 5 : v) });
    const r = detectAnomalies([s], dayAt(19), { minHistoryDays: 21 });
    expect(r.findings).toEqual([]);
    expect(r.stats.skipped.insufficient_history).toBe(1);
  });
});

describe('zero and dormant series', () => {
  it('an all-zero series is silent', () => {
    const s = mkSeries({ start: START, values: Array.from({ length: 90 }, () => 0) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toEqual([]);
  });

  it('a long-dormant series that restarts at a large amount is a reactivation', () => {
    const s = mkSeries({ start: START, values: Array.from({ length: 90 }, (_, i) => (i === 89 ? 5000 : 0)) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.category).toBe('reactivation');
    expect(r.findings[0]?.source).toBe('reactivation');
    expect(r.findings[0]?.severity).toBe('critical');
    expect(r.findings[0]?.relative).toBeNull();
  });

  it('a small restart (under 10 times the minimum) is info only', () => {
    const s = mkSeries({ start: START, values: Array.from({ length: 90 }, (_, i) => (i === 89 ? 300 : 0)) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.severity).toBe('info');
  });

  it('a restart below the minimum impact is ignored', () => {
    const s = mkSeries({ start: START, values: Array.from({ length: 90 }, (_, i) => (i === 89 ? 50 : 0)) });
    expect(detectAnomalies([s], AS_OF).findings).toEqual([]);
  });

  it('an intermittent series (30 percent or more zero days) is not scored daily and is counted', () => {
    const s = synth({ n: 90, base: 1000, noise: 0.05, seed: 9, weekly: false, mod: (i, v) => (i % 3 === 0 && i < 89 ? 0 : i === 89 ? v * 6 : v) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toEqual([]);
    expect(r.stats.skipped.intermittent).toBe(1);
  });
});

describe('currency isolation', () => {
  it('a spike in one currency never produces a finding in another', () => {
    const usd = synth({ n: 90, base: 1000, noise: 0.04, seed: 1, currency: 'USD', mod: (i, v) => (i === 89 ? v * 4 : v) });
    const eur = synth({ n: 90, base: 1000, noise: 0.04, seed: 1, currency: 'EUR' });
    const r = detectAnomalies([usd, eur], AS_OF);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.currency).toBe('USD');
    expect(r.findings[0]?.key).toContain('|USD|');
  });

  it('applies the per-currency minimum: JPY 5,000 is below the 15,000 floor, USD 5,000 is not', () => {
    const mk = (currency: string) =>
      synth({ n: 90, base: 20, noise: 0.02, seed: 5, weekly: false, currency, mod: (i, v) => (i === 89 ? 5000 : v) });
    const jpy = detectAnomalies([mk('JPY')], AS_OF);
    expect(jpy.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    const usd = detectAnomalies([mk('USD')], AS_OF);
    expect(usd.findings[0]?.severity).toBe('critical');
  });

  it('skips a currency with no configured minimum instead of guessing, and counts it', () => {
    const s = synth({ n: 90, base: 1000, noise: 0.04, seed: 1, currency: 'CHF', mod: (i, v) => (i === 89 ? v * 4 : v) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toEqual([]);
    expect(r.stats.skipped.no_min_impact).toBe(1);
    const configured = detectAnomalies([s], AS_OF, { minImpact: { CHF: 100 } });
    expect(configured.findings).toHaveLength(1);
  });

  it('keeps tenants apart: equal keys in two tenants are two findings', () => {
    const mk = (tenant: string) =>
      synth({ n: 90, base: 1000, noise: 0.04, seed: 1, tenant, mod: (i, v) => (i === 89 ? v * 4 : v) });
    const r = detectAnomalies([mk('t1'), mk('t2')], AS_OF);
    expect(r.findings.map((f) => f.tenant).sort()).toEqual(['t1', 't2']);
  });
});

describe('calendar edges, DST and time zones', () => {
  it('detects a spike on 1 March after a leap February (2028)', () => {
    const start = '2028-01-01';
    const s = synth({ n: 61, base: 1000, noise: 0.04, seed: 1, start, mod: (i, v) => (i === 60 ? v * 4 : v) });
    const r = detectAnomalies([s], '2028-03-01');
    expect(r.asOf).toBe('2028-03-01');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.lastDay).toBe('2028-03-01');
  });

  it('detects a spike on the US spring-forward day (2026-03-08) the same as any other day', () => {
    const idx = 66; // 2026-03-08
    expect(dayAt(idx)).toBe('2026-03-08');
    const s = synth({ n: 90, base: 1000, noise: 0.04, seed: 1, mod: (i, v) => (i === idx ? v * 4 : v) });
    const r = detectAnomalies([s], dayAt(idx));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.startDay).toBe('2026-03-08');
  });

  it('gives identical results under different process time zones', () => {
    const original = process.env.TZ;
    const s = synth({ n: 90, base: 1000, noise: 0.04, seed: 1, mod: (i, v) => (i >= 85 ? v * 2 : v) });
    try {
      const out = ['UTC', 'Asia/Tokyo', 'America/Chicago'].map((tz) => {
        process.env.TZ = tz;
        return JSON.stringify(detectAnomalies([s], dayAt(87)));
      });
      expect(out[1]).toBe(out[0]);
      expect(out[2]).toBe(out[0]);
      expect(JSON.parse(out[0] as string).findings).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('extreme values', () => {
  it('handles values near the amount bound without NaN or Infinity', () => {
    const s = synth({ n: 90, base: 4e11, noise: 0.01, seed: 1, mod: (i, v) => (i === 89 ? v * 2 : v) });
    const r = detectAnomalies([s], AS_OF);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    for (const n of [f?.impact, f?.actual, f?.expected, f?.meanDailyExcess, f?.todayExcess]) {
      expect(Number.isFinite(n)).toBe(true);
    }
    expect(f?.severity).toBe('critical');
  });

  it('handles sub-cent values quietly', () => {
    const s = synth({ n: 90, base: 0.000004, noise: 0.1, seed: 1 });
    expect(detectAnomalies([s], AS_OF).findings).toEqual([]);
  });

  it('a net-negative (credit) day does not crash or alarm on a small series', () => {
    const s = synth({ n: 90, base: 300, noise: 0.04, seed: 1, mod: (i, v) => (i === 89 ? -50 : v) });
    const r = detectAnomalies([s], AS_OF);
    for (const f of r.findings) expect(f.severity).toBe('info');
  });
});

describe('validation, determinism and purity', () => {
  const s = synth({ n: 90, base: 1000, noise: 0.04, seed: 1, mod: (i, v) => (i === 89 ? v * 4 : v) });

  it('rejects a bad as-of day, bad series and duplicate series ids', () => {
    expect(codeOf(() => detectAnomalies([s], '2026-02-30'))).toBe('AS_OF_INVALID');
    expect(codeOf(() => detectAnomalies([s], 'today'))).toBe('AS_OF_INVALID');
    expect(codeOf(() => detectAnomalies('x' as never, AS_OF))).toBe('SERIES_INVALID');
    expect(codeOf(() => detectAnomalies([{ ...s, id: 'forged' }], AS_OF))).toBe('SERIES_INVALID');
    expect(codeOf(() => detectAnomalies([s, s], AS_OF))).toBe('SERIES_INVALID');
  });

  it('is deterministic and independent of series order', () => {
    const other = synth({ n: 90, base: 700, noise: 0.04, seed: 2, account: 'acct-b', mod: (i, v) => (i === 89 ? v * 5 : v) });
    const a = detectAnomalies([s, other], AS_OF);
    const b = detectAnomalies([other, s], AS_OF);
    expect(b).toEqual(a);
    expect(detectAnomalies([s, other], AS_OF)).toEqual(a);
  });

  it('does not mutate its input and ignores data after the as-of day', () => {
    const copy = JSON.parse(JSON.stringify(s));
    detectAnomalies([s], dayAt(80));
    expect(JSON.parse(JSON.stringify(s))).toEqual(copy);
    const truncated = mkSeries({ start: START, values: s.points.slice(0, 81).map((p) => p.value) });
    expect(detectAnomalies([s], dayAt(80))).toEqual(detectAnomalies([truncated], dayAt(80)));
  });

  it('never echoes input in error text', () => {
    try {
      detectAnomalies([{ ...s, id: `SECRET-${TENANT}` }], AS_OF);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});
