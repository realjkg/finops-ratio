// Severity matrix boundaries (dollar impact AND percent deviation, both with
// floors) and configuration validation (checklist 2.2, 2.6).

import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '@/detection/anomaly';
import {
  DEFAULT_MIN_IMPACT,
  FLOORS,
  atLeast,
  classifySeverity,
  relativeDeviation,
  resolveConfig,
  type SeverityInput,
} from '@/detection/severity';
import { dayAt, synth } from '@/detection/testkit';
import { DetectionError } from '@/detection/types';

const cfg = resolveConfig();
const MIN = 100;

/** A one-day candidate with a given excess and expected value. */
function input(excess: number, expected: number, over: Partial<SeverityInput> = {}): SeverityInput {
  return { direction: 'up', meanExcess: excess, expectedSum: expected, cumulativeImpact: excess, windowDays: 1, ...over };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DetectionError ? err.code : 'NOT_A_DETECTION_ERROR';
  }
}

describe('severity matrix: warning boundaries (excess >= min AND relative >= 20 percent)', () => {
  it('is warning exactly on both boundaries', () => {
    expect(classifySeverity(input(100, 500), cfg, MIN)).toBe('warning'); // 100 and exactly 20 percent
  });

  it('is info one cent below the dollar floor, even at a huge percentage', () => {
    expect(classifySeverity(input(99.99, 50), cfg, MIN)).toBe('info'); // +200 percent but under 100 dollars
  });

  it('is info just below 20 percent, even at a huge dollar amount', () => {
    expect(classifySeverity(input(100, 500.01), cfg, MIN)).toBe('info'); // 19.998 percent
    expect(classifySeverity(input(4000, 20001), cfg, MIN)).toBe('info'); // 19.9990 percent of a big series
  });

  it('requires both: either alone is not enough', () => {
    expect(classifySeverity(input(90, 100), cfg, MIN)).toBe('info');
    expect(classifySeverity(input(200, 5000), cfg, MIN)).toBe('info');
    expect(classifySeverity(input(200, 900), cfg, MIN)).toBe('warning');
  });

  it('is robust to floating point noise right on a boundary', () => {
    // 0.1 + 0.2 style sums must not fall under a boundary they equal.
    expect(classifySeverity(input(0.1 + 0.2 + 99.7, 500), cfg, MIN)).toBe('warning');
    expect(atLeast(0.30000000000000004, 0.3)).toBe(true);
    expect(atLeast(0.2999, 0.3)).toBe(false);
  });
});

describe('severity matrix: critical boundaries (excess >= 10x min AND relative >= 50 percent)', () => {
  it('is critical exactly on both boundaries', () => {
    expect(classifySeverity(input(1000, 2000), cfg, MIN)).toBe('critical'); // 1000 and exactly 50 percent
  });

  it('is warning when the dollar amount is just under 10x min', () => {
    expect(classifySeverity(input(999.99, 100), cfg, MIN)).toBe('warning');
  });

  it('is warning when the relative deviation is just under 50 percent', () => {
    expect(classifySeverity(input(1000, 2000.01), cfg, MIN)).toBe('warning'); // 49.9998 percent
    expect(classifySeverity(input(4000, 8001), cfg, MIN)).toBe('warning'); // 49.994 percent, under the cumulative 50x clause
  });

  it('is critical on the cumulative clause alone (50x min), and not just below it', () => {
    expect(classifySeverity(input(150, 600, { cumulativeImpact: 5000 }), cfg, MIN)).toBe('critical');
    expect(classifySeverity(input(150, 600, { cumulativeImpact: 4999.99 }), cfg, MIN)).toBe('warning');
  });
});

describe('severity matrix: unbounded relative deviation and decreases', () => {
  it('with expected zero or less the relative is unbounded, so the dollar amount decides', () => {
    expect(relativeDeviation(500, 0, 1)).toBeNull();
    expect(relativeDeviation(500, -20, 1)).toBeNull();
    expect(classifySeverity(input(100, 0), cfg, MIN)).toBe('warning');
    expect(classifySeverity(input(99.99, 0), cfg, MIN)).toBe('info');
    expect(classifySeverity(input(1000, 0), cfg, MIN)).toBe('critical');
    expect(classifySeverity(input(999.99, 0), cfg, MIN)).toBe('warning');
    expect(classifySeverity(input(500, -1), cfg, MIN)).toBe('warning');
  });

  it('a zero or negative excess has zero relative deviation', () => {
    expect(relativeDeviation(0, 0, 1)).toBe(0);
    expect(relativeDeviation(-5, 0, 1)).toBe(0);
    expect(relativeDeviation(20, 100, 1)).toBeCloseTo(0.2, 12);
    expect(relativeDeviation(20, 700, 7)).toBeCloseTo(0.2, 12);
  });

  it('every decrease is info, however large (design D-14)', () => {
    expect(classifySeverity(input(-5000, 6000, { direction: 'down', cumulativeImpact: -50000 }), cfg, MIN)).toBe('info');
  });

  it('uses the window mean: a long window with a small daily mean stays info', () => {
    // A 7-day window with 400 total excess is 57 a day: under the 100 floor.
    expect(classifySeverity({ direction: 'up', meanExcess: 400 / 7, expectedSum: 1400, cumulativeImpact: 400, windowDays: 7 }, cfg, MIN)).toBe('info');
    expect(classifySeverity({ direction: 'up', meanExcess: 700 / 7, expectedSum: 3500, cumulativeImpact: 700, windowDays: 7 }, cfg, MIN)).toBe('warning');
  });
});

describe('severity thresholds are configurable, with floors', () => {
  it('a higher minimum impact turns a critical spike into a warning', () => {
    const s = synth({ n: 90, base: 1000, noise: 0.03, seed: 1, mod: (i, v) => (i === 89 ? v * 4 : v) });
    expect(detectAnomalies([s], dayAt(89)).findings[0]?.severity).toBe('critical');
    const strict = detectAnomalies([s], dayAt(89), { minImpact: { USD: 1000 } });
    expect(strict.findings[0]?.severity).toBe('warning');
    expect(strict.findings[0]?.minImpact).toBe(1000);
    const stricter = detectAnomalies([s], dayAt(89), { minImpact: { USD: 5000 } });
    expect(stricter.findings[0]?.severity).toBe('info');
  });

  it('a stricter relative threshold downgrades without touching the dollar rule', () => {
    // The first day of a 30 percent step: +300 on a 1000 base.
    const s = synth({ n: 90, base: 1000, noise: 0.03, seed: 2, mod: (i, v) => (i >= 85 ? v * 1.3 : v) });
    expect(detectAnomalies([s], dayAt(85)).findings[0]?.severity).toBe('warning');
    expect(detectAnomalies([s], dayAt(85), { warningRelative: 0.5 }).findings[0]?.severity).toBe('info');
  });

  it('keeps the documented defaults', () => {
    expect(DEFAULT_MIN_IMPACT).toEqual({ USD: 100, EUR: 100, GBP: 100, JPY: 15000 });
    expect(cfg.warningRelative).toBe(0.2);
    expect(cfg.criticalRelative).toBe(0.5);
    expect(cfg.criticalMultiple).toBe(10);
    expect(cfg.cumulativeCriticalMultiple).toBe(50);
    expect(cfg.zThreshold).toBe(4.5);
    expect(cfg.minHistoryDays).toBe(14);
    expect(cfg.noveltyMinAccountAgeDays).toBe(30);
    expect(cfg.groupMinMembers).toBe(3);
  });

  it('refuses values under the floors (a threshold cannot be configured away)', () => {
    const bad: unknown[] = [
      { minImpact: { USD: 0 } },
      { minImpact: { USD: FLOORS.minImpact / 2 } },
      { minImpact: { USD: -5 } },
      { minImpact: { usd: 100 } },
      { minImpact: { USD: Number.NaN } },
      { minImpact: [] },
      { minImpact: null },
      { warningRelative: 0 },
      { warningRelative: FLOORS.warningRelative - 0.001 },
      { criticalRelative: 0.1 }, // below the default warning relative of 0.2
      { warningRelative: 0.3, criticalRelative: 0.2 },
      { criticalMultiple: 0.5 },
      { cumulativeCriticalMultiple: 5 }, // below criticalMultiple
      { zThreshold: 2.99 },
      { zThreshold: Number.POSITIVE_INFINITY },
      { minHistoryDays: 6 },
      { minHistoryDays: 14.5 },
      { noveltyMinAccountAgeDays: 6 },
      { groupMinMembers: 1 },
      { tenantFanInShare: 0 },
      { tenantFanInShare: 1.01 },
      { maxFindings: 0 },
    ];
    for (const config of bad) {
      expect(codeOf(() => resolveConfig(config as never)), JSON.stringify(config)).toBe('CONFIG_INVALID');
    }
  });

  it('accepts values exactly at the floors', () => {
    expect(() =>
      resolveConfig({
        minImpact: { USD: FLOORS.minImpact },
        warningRelative: FLOORS.warningRelative,
        zThreshold: FLOORS.zThreshold,
        minHistoryDays: FLOORS.minHistoryDays,
        noveltyMinAccountAgeDays: FLOORS.noveltyMinAccountAgeDays,
        groupMinMembers: FLOORS.groupMinMembers,
        tenantFanInShare: FLOORS.tenantFanInShare,
      }),
    ).not.toThrow();
  });

  it('refuses unknown keys and non-objects (deny by default)', () => {
    expect(codeOf(() => resolveConfig({ warningRelativ: 0.3 } as never))).toBe('CONFIG_INVALID');
    expect(codeOf(() => resolveConfig({ __proto__x: 1 } as never))).toBe('CONFIG_INVALID');
    expect(codeOf(() => resolveConfig(null as never))).toBe('CONFIG_INVALID');
    expect(codeOf(() => resolveConfig([] as never))).toBe('CONFIG_INVALID');
    expect(codeOf(() => resolveConfig('x' as never))).toBe('CONFIG_INVALID');
  });

  it('merges per-currency minimums over the defaults', () => {
    const merged = resolveConfig({ minImpact: { CHF: 80, USD: 250 } });
    expect(merged.minImpact).toEqual({ USD: 250, EUR: 100, GBP: 100, JPY: 15000, CHF: 80 });
  });

  it('never echoes a config value in the error', () => {
    try {
      resolveConfig({ evilKey: 'SECRET-VALUE' } as never);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
      expect((err as Error).message).not.toContain('evilKey');
    }
  });
});
