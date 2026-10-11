// Tests for evaluateBudgetThresholds and evaluateForecastBreach (checklist 2.4).

import { describe, expect, it } from 'vitest';
import { evaluateBudgetThresholds, evaluateForecastBreach, type BreachForecastInput } from '@/detection/budget';
import { forecastSeries } from '@/detection/forecast';
import { mkSeries } from '@/detection/testkit';
import { DetectionError } from '@/detection/types';
import type { MonthEndProjection } from '@/detection/forecast';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DetectionError ? err.code : 'NOT_A_DETECTION_ERROR';
  }
}

const daily = (amount: number) => ({ currency: 'USD', period: 'daily' as const, amount });
const monthly = (amount: number) => ({ currency: 'USD', period: 'monthly' as const, amount });

describe('evaluateBudgetThresholds: 70/90/100 boundaries', () => {
  it.each(['daily', 'monthly'] as const)('%s: below soft is none', (period) => {
    const e = evaluateBudgetThresholds({ currency: 'USD', period, amount: 69.99 }, { currency: 'USD', period, amount: 100 });
    expect(e.level).toBe('none');
    expect(e.alertType).toBeNull();
    expect(e.severity).toBeNull();
    expect(e.crossed).toEqual([]);
    expect(e.actions).toEqual([]);
    expect(e.next?.level).toBe('soft');
    expect(e.next?.remaining).toBe(0.01);
  });

  it.each(['daily', 'monthly'] as const)('%s: exactly 70 percent is soft (inclusive)', (period) => {
    const e = evaluateBudgetThresholds({ currency: 'USD', period, amount: 70 }, { currency: 'USD', period, amount: 100 });
    expect(e.level).toBe('soft');
    expect(e.alertType).toBe('budget_soft');
    expect(e.severity).toBe('info');
    expect(e.actions).toEqual(['notify_owner_slack', 'notify_owner_email']);
    expect(e.ratio).toBe(0.7);
    expect(e.next?.level).toBe('hard');
  });

  it.each(['daily', 'monthly'] as const)('%s: 89.99 is soft and exactly 90 is hard', (period) => {
    const b = { currency: 'USD', period, amount: 100 };
    expect(evaluateBudgetThresholds({ currency: 'USD', period, amount: 89.99 }, b).level).toBe('soft');
    const hard = evaluateBudgetThresholds({ currency: 'USD', period, amount: 90 }, b);
    expect(hard.level).toBe('hard');
    expect(hard.alertType).toBe('budget_hard');
    expect(hard.severity).toBe('warning');
    expect(hard.actions).toEqual(['escalate_to_po', 'flag_workload_in_ui']);
    expect(hard.crossed.map((c) => c.level)).toEqual(['soft', 'hard']);
  });

  it.each(['daily', 'monthly'] as const)('%s: 99.99 is hard and exactly 100 is kill', (period) => {
    const b = { currency: 'USD', period, amount: 100 };
    expect(evaluateBudgetThresholds({ currency: 'USD', period, amount: 99.99 }, b).level).toBe('hard');
    const kill = evaluateBudgetThresholds({ currency: 'USD', period, amount: 100 }, b);
    expect(kill.level).toBe('kill');
    expect(kill.alertType).toBe('budget_kill');
    expect(kill.severity).toBe('critical');
    expect(kill.actions).toEqual(['auto_throttle_or_pause']);
    expect(kill.next).toBeNull();
    expect(kill.overBudgetBy).toBe(0);
  });

  it('reports the overrun above 100 percent', () => {
    const e = evaluateBudgetThresholds(monthly(1500), monthly(1000));
    expect(e.level).toBe('kill');
    expect(e.ratio).toBe(1.5);
    expect(e.overBudgetBy).toBe(500);
    expect(e.remaining).toBe(-500);
  });

  it('is not tripped by binary floating point at the boundaries', () => {
    // 0.7 * 10 and 0.9 * 10 are not exact in binary; the boundary must still hold.
    const b = { currency: 'USD', period: 'daily' as const, amount: 10 };
    expect(evaluateBudgetThresholds({ ...daily(7), amount: 7 }, b).level).toBe('soft');
    expect(evaluateBudgetThresholds({ ...daily(9), amount: 9 }, b).level).toBe('hard');
    const odd = { currency: 'USD', period: 'daily' as const, amount: 0.3 };
    expect(evaluateBudgetThresholds({ ...daily(0.21), amount: 0.21 }, odd).level).toBe('soft');
    const big = { currency: 'USD', period: 'monthly' as const, amount: 1234567.89 };
    expect(evaluateBudgetThresholds({ currency: 'USD', period: 'monthly', amount: 864197.523 }, big).level).toBe('soft');
  });

  it('treats zero and negative net spend as none, with no divide-by-zero', () => {
    expect(evaluateBudgetThresholds(daily(0), daily(100)).level).toBe('none');
    const neg = evaluateBudgetThresholds(daily(-25), daily(100));
    expect(neg.level).toBe('none');
    expect(neg.ratio).toBe(-0.25);
    expect(neg.remaining).toBe(125);
  });

  it('supports per-budget thresholds and refuses disordered ones', () => {
    const b = { currency: 'USD', period: 'monthly' as const, amount: 100, thresholds: { soft: 0.5, hard: 0.8, kill: 1.2 } };
    expect(evaluateBudgetThresholds(monthly(50), b).level).toBe('soft');
    expect(evaluateBudgetThresholds(monthly(100), b).level).toBe('hard');
    expect(evaluateBudgetThresholds(monthly(120), b).level).toBe('kill');
    for (const t of [
      { soft: 0.9, hard: 0.7, kill: 1 },
      { soft: 0.7, hard: 0.7, kill: 1 },
      { soft: 0, hard: 0.9, kill: 1 },
      { soft: -0.1, hard: 0.9, kill: 1 },
      { soft: 0.7, hard: 0.9, kill: 2.01 },
      { soft: Number.NaN, hard: 0.9, kill: 1 },
      { soft: 0.7, hard: 0.9 },
    ]) {
      expect(codeOf(() => evaluateBudgetThresholds(monthly(1), { ...b, thresholds: t as never }))).toBe('BUDGET_INVALID');
    }
    expect(codeOf(() => evaluateBudgetThresholds(monthly(1), { ...b, thresholds: 5 as never }))).toBe('BUDGET_INVALID');
  });

  it('keeps currencies apart: a mismatch is refused, never compared', () => {
    expect(codeOf(() => evaluateBudgetThresholds({ currency: 'EUR', period: 'daily', amount: 90 }, daily(100)))).toBe(
      'CURRENCY_MISMATCH',
    );
    // JPY 15,000 against USD 100 must not look like an overrun.
    expect(codeOf(() => evaluateBudgetThresholds({ currency: 'JPY', period: 'daily', amount: 15000 }, daily(100)))).toBe(
      'CURRENCY_MISMATCH',
    );
  });

  it('refuses a period mismatch (a monthly spend against a daily budget)', () => {
    expect(codeOf(() => evaluateBudgetThresholds(monthly(90), daily(100)))).toBe('SPEND_INVALID');
  });

  it('validates budget and spend', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '100', null, 1e12 + 1]) {
      expect(codeOf(() => evaluateBudgetThresholds(daily(1), { ...daily(1), amount: bad as never }))).toBe('BUDGET_INVALID');
    }
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, '5', null, undefined, 1e12 + 1]) {
      expect(codeOf(() => evaluateBudgetThresholds({ ...daily(1), amount: bad as never }, daily(100)))).toBe('SPEND_INVALID');
    }
    expect(codeOf(() => evaluateBudgetThresholds(daily(1), { ...daily(1), currency: 'usd' }))).toBe('BUDGET_INVALID');
    expect(codeOf(() => evaluateBudgetThresholds({ ...daily(1), currency: 'usd' }, daily(1)))).toBe('SPEND_INVALID');
    expect(codeOf(() => evaluateBudgetThresholds(daily(1), { ...daily(1), period: 'weekly' as never }))).toBe('BUDGET_INVALID');
    expect(codeOf(() => evaluateBudgetThresholds(daily(1), null as never))).toBe('BUDGET_INVALID');
    expect(codeOf(() => evaluateBudgetThresholds(null as never, daily(1)))).toBe('SPEND_INVALID');
  });

  it('never echoes input in errors', () => {
    try {
      evaluateBudgetThresholds(daily(1), { ...daily(1), currency: 'SECRETXYZ' });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

// ---------------------------------------------------------------------------
// Forecast breach
// ---------------------------------------------------------------------------

function projection(over: Partial<MonthEndProjection> & { daily?: number[] } = {}): MonthEndProjection {
  const remainingDaily = over.daily ?? [10, 10, 10, 10, 10];
  const actualToDate = over.actualToDate ?? 100;
  const forecastRemaining = remainingDaily.reduce((a, b) => a + b, 0);
  return {
    month: '2026-03',
    asOf: '2026-03-26',
    daysInMonth: 31,
    remainingDays: remainingDaily.length,
    actualToDate,
    imputedDays: 0,
    imputedAmount: 0,
    forecastRemaining,
    projected: actualToDate + forecastRemaining,
    lo80: actualToDate + forecastRemaining - 5,
    hi80: actualToDate + forecastRemaining + 5,
    lo95: actualToDate + forecastRemaining - 9,
    hi95: actualToDate + forecastRemaining + 9,
    intervalMethod: 'sum_of_daily_bounds',
    remainingDaily,
    ...over,
  };
}
const fc = (m: MonthEndProjection | null, estimated = false, currency = 'USD'): BreachForecastInput => ({
  currency,
  estimated,
  monthEnd: m,
});
const mb = (amount: number) => ({ currency: 'USD', amount });

describe('evaluateForecastBreach', () => {
  it('on track: projected 150 against 200', () => {
    const e = evaluateForecastBreach(fc(projection()), mb(200));
    expect(e.status).toBe('on_track');
    expect(e.overshoot).toBe(0);
    expect(e.daysUntilBreach).toBeNull();
    expect(e.breachDay).toBeNull();
    expect(e.alertType).toBeNull();
    expect(e.severity).toBeNull();
    expect(e.projectedRatio).toBe(0.75);
  });

  it('projected exactly equal to the budget is not a breach', () => {
    const e = evaluateForecastBreach(fc(projection()), mb(150));
    expect(e.status).toBe('at_risk');
    expect(e.overshoot).toBe(0);
    expect(e.daysUntilBreach).toBeNull();
    expect(e.alertType).toBeNull();
  });

  it('at risk from 90 percent of the budget (inclusive) up to the budget', () => {
    expect(evaluateForecastBreach(fc(projection()), mb(166.66)).status).toBe('at_risk');
    expect(evaluateForecastBreach(fc(projection()), mb(150 / 0.9)).status).toBe('at_risk');
    expect(evaluateForecastBreach(fc(projection()), mb(167)).status).toBe('on_track');
    expect(evaluateForecastBreach(fc(projection()), mb(166.66)).severity).toBe('info');
  });

  it('breach projected: overshoot amount and days until breach', () => {
    // Carried 100, then +10/day. Budget 125 is first exceeded on day 3 (130).
    const e = evaluateForecastBreach(fc(projection()), mb(125));
    expect(e.status).toBe('breach_projected');
    expect(e.overshoot).toBe(25);
    expect(e.daysUntilBreach).toBe(3);
    expect(e.breachDay).toBe('2026-03-29');
    expect(e.alertType).toBe('forecast_breach');
    expect(e.overshootHigh80).toBe(30);
    expect(e.overshootLow80).toBe(20);
    expect(e.projectedLowerBoundBreaches).toBe(true);
    expect(e.severity).toBe('critical');
  });

  it('warning (not critical) when only the point estimate breaches', () => {
    const e = evaluateForecastBreach(fc(projection()), mb(148));
    expect(e.status).toBe('breach_projected');
    expect(e.projectedLowerBoundBreaches).toBe(false);
    expect(e.severity).toBe('warning');
    expect(e.overshoot).toBe(2);
    expect(e.daysUntilBreach).toBe(5);
    expect(e.breachDay).toBe('2026-03-31');
  });

  it('breach on the first remaining day, and exactly-at-budget cumulative is not yet a breach', () => {
    expect(evaluateForecastBreach(fc(projection()), mb(105)).daysUntilBreach).toBe(1);
    // Cumulative hits exactly 120 on day 2: not exceeded; exceeded on day 3.
    expect(evaluateForecastBreach(fc(projection()), mb(120)).daysUntilBreach).toBe(3);
  });

  it('already breached: actual to date above the budget gives zero days', () => {
    const e = evaluateForecastBreach(fc(projection({ actualToDate: 300 })), mb(250));
    expect(e.status).toBe('breached');
    expect(e.daysUntilBreach).toBe(0);
    expect(e.breachDay).toBe('2026-03-26');
    expect(e.severity).toBe('critical');
    expect(e.alertType).toBe('forecast_breach');
    expect(e.overshoot).toBe(100);
  });

  it('counts imputed days as spend already incurred', () => {
    const e = evaluateForecastBreach(fc(projection({ actualToDate: 90, imputedAmount: 15, imputedDays: 1 })), mb(100));
    expect(e.status).toBe('breached');
    expect(e.daysUntilBreach).toBe(0);
  });

  it('handles the last day of the month (nothing remaining)', () => {
    const m = projection({ daily: [], asOf: '2026-03-31', actualToDate: 180 });
    expect(evaluateForecastBreach(fc(m), mb(200)).status).toBe('at_risk');
    expect(evaluateForecastBreach(fc(m), mb(179)).status).toBe('breached');
  });

  it('returns no_forecast for a null month-end (no history)', () => {
    const e = evaluateForecastBreach(fc(null, true), mb(200));
    expect(e.status).toBe('no_forecast');
    expect(e.projected).toBeNull();
    expect(e.estimated).toBe(true);
  });

  it('passes the estimated flag through', () => {
    expect(evaluateForecastBreach(fc(projection(), true), mb(125)).estimated).toBe(true);
    expect(evaluateForecastBreach(fc(projection(), false), mb(125)).estimated).toBe(false);
  });

  it('refuses a currency mismatch', () => {
    expect(codeOf(() => evaluateForecastBreach(fc(projection(), false, 'EUR'), mb(100)))).toBe('CURRENCY_MISMATCH');
  });

  it('validates budget and forecast input', () => {
    for (const bad of [0, -1, Number.NaN, '5']) {
      expect(codeOf(() => evaluateForecastBreach(fc(projection()), { currency: 'USD', amount: bad as never }))).toBe('BUDGET_INVALID');
    }
    expect(codeOf(() => evaluateForecastBreach(fc(projection()), null as never))).toBe('BUDGET_INVALID');
    expect(codeOf(() => evaluateForecastBreach(null as never, mb(1)))).toBe('SPEND_INVALID');
    expect(codeOf(() => evaluateForecastBreach({ currency: 'USD', estimated: 'no' as never, monthEnd: null }, mb(1)))).toBe('SPEND_INVALID');
    expect(codeOf(() => evaluateForecastBreach(fc(projection({ projected: Number.NaN })), mb(1)))).toBe('SPEND_INVALID');
    expect(codeOf(() => evaluateForecastBreach(fc(projection({ remainingDays: 3 })), mb(1)))).toBe('SPEND_INVALID');
    expect(codeOf(() => evaluateForecastBreach(fc(projection({ asOf: '2026-02-30' })), mb(1)))).toBe('SPEND_INVALID');
    expect(codeOf(() => evaluateForecastBreach(fc(projection({ month: 'March' })), mb(1)))).toBe('SPEND_INVALID');
    expect(
      codeOf(() => evaluateForecastBreach(fc(projection({ daily: [1, Number.NaN] })), mb(1))),
    ).toBe('SPEND_INVALID');
  });

  it('works end to end on a real forecast: a flat 10 per day against a budget of 250 for March', () => {
    const series = mkSeries({ start: '2026-01-01', values: Array.from({ length: 70 }, () => 10) }); // through 2026-03-11
    const f = forecastSeries(series, '2026-03-11', 7);
    // March to date is 11 days x 10 = 110; the total projects to 310. Cumulative
    // spend first exceeds 250 on day 26 (260), which is 15 days after the as-of day.
    const e = evaluateForecastBreach(f, mb(250));
    expect(e.status).toBe('breach_projected');
    expect(e.overshoot).toBeCloseTo(60, 4);
    expect(e.daysUntilBreach).toBe(15);
    expect(e.breachDay).toBe('2026-03-26');
    expect(evaluateForecastBreach(f, mb(400)).status).toBe('on_track');
    expect(codeOf(() => evaluateForecastBreach(f, { currency: 'EUR', amount: 250 }))).toBe('CURRENCY_MISMATCH');
  });
});
