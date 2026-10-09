// Accrual engine tests — exact rate×elapsed math, monotonicity, determinism
// across instances (injected clock = plain elapsed argument), rank re-order
// logic, and chart data derivation. Real-seed wiring checks pin the rate
// derivation to the SAME fields the report aggregates.
import { describe, expect, it } from 'vitest';
import {
  ACCRUAL_REPLAY_SPEED,
  MTD_WINDOW_SECONDS,
  accruedAt,
  liveAttributionView,
  spendAccrualCurve,
  teamBurnRates,
  totalUsdPerSecond,
  userBurnRates,
} from './accrual';
import { teamAttributionRows, userAttributionRows } from './aggregations';
import type { AttributionDimension, AttributionReport, AttributionRow } from './AttributionClient';
import type { BurnRate } from './accrual';
import { findModel } from '@/data/models';
import { USER_QUERY_EVENTS } from '@/data/userQueries';
import { WORKLOADS } from '@/data/workloads';

// ---------------------------------------------------------------------------
// Builders — synthetic rows/rates with clean, float-exact magnitudes
// ---------------------------------------------------------------------------

function row(key: string, inferenceCost: number, dimension: AttributionDimension = 'team'): AttributionRow {
  return {
    dimension,
    key,
    tokensIn: 0,
    tokensOut: 0,
    inferenceCost,
    shareOfTotal: 0,
    formulaLabel: 'test = fixed',
    inputs: {
      workloadIds: [],
      recordCount: 1,
      summedInferenceCost: inferenceCost,
      totalInferenceCost: inferenceCost,
    },
    basis: 'test basis',
  };
}

function reportOf(rows: AttributionRow[]): AttributionReport {
  const total = rows.reduce((acc, r) => acc + r.inferenceCost, 0);
  return {
    generatedAt: '2026-06-25T17:42:00.000Z',
    dimension: rows[0]?.dimension ?? 'team',
    window: 'test window',
    rows,
    totalInferenceCost: total,
    totalTokensIn: 0,
    totalTokensOut: 0,
  };
}

function rate(
  key: string,
  usdPerSecond: number,
  opts: { tokensInPerSecond?: number; tokensOutPerSecond?: number; dimension?: AttributionDimension } = {},
): BurnRate {
  return {
    dimension: opts.dimension ?? 'team',
    key,
    tokensInPerSecond: opts.tokensInPerSecond ?? 0,
    tokensOutPerSecond: opts.tokensOutPerSecond ?? 0,
    usdPerSecond,
    basis: 'test basis',
  };
}

// ---------------------------------------------------------------------------
// Seeded rate derivation (real seeds — wiring checks)
// ---------------------------------------------------------------------------

describe('teamBurnRates', () => {
  it('covers exactly the report row keys (same seeds as the team aggregation)', () => {
    const rates = teamBurnRates(WORKLOADS);
    const reportKeys = teamAttributionRows(WORKLOADS).map((r) => `${r.dimension}:${r.key}`).sort();
    const rateKeys = rates.map((r) => `${r.dimension}:${r.key}`).sort();
    expect(rateKeys).toEqual(reportKeys);
  });

  it('derives token rates from MTD token volumes ÷ the MTD window', () => {
    const team = 'CX Engineering';
    const members = WORKLOADS.filter((w) => w.team === team);
    const expectedIn = members.reduce((a, w) => a + w.costs.tokens_in_mtd, 0) / MTD_WINDOW_SECONDS;
    const expectedOut = members.reduce((a, w) => a + w.costs.tokens_out_mtd, 0) / MTD_WINDOW_SECONDS;
    const r = teamBurnRates(WORKLOADS).find((x) => x.key === team);
    expect(r).toBeDefined();
    expect(r!.tokensInPerSecond).toBeCloseTo(expectedIn, 12);
    expect(r!.tokensOutPerSecond).toBeCloseTo(expectedOut, 12);
  });

  it('derives the USD rate from registry pricing × seeded token rates', () => {
    const team = 'CX Engineering';
    const members = WORKLOADS.filter((w) => w.team === team);
    let expectedUsd = 0;
    for (const w of members) {
      const model = findModel(w.model);
      expect(model).toBeDefined();
      expectedUsd +=
        (w.costs.tokens_in_mtd / MTD_WINDOW_SECONDS) * (model!.pricing.input_per_1m / 1_000_000) +
        (w.costs.tokens_out_mtd / MTD_WINDOW_SECONDS) * (model!.pricing.output_per_1m / 1_000_000);
    }
    const r = teamBurnRates(WORKLOADS).find((x) => x.key === team);
    expect(r!.usdPerSecond).toBeCloseTo(expectedUsd, 15);
  });

  it('throws on a workload whose model is missing from the registry (loud, not defaulted)', () => {
    const ghost = { ...WORKLOADS[0], id: 'wl-ghost', model: 'no-such-model' };
    expect(() => teamBurnRates([ghost])).toThrow(/Unknown model in accrual seed/);
  });
});

describe('userBurnRates', () => {
  it('covers exactly the report row keys (same seeds as the user aggregation)', () => {
    const rates = userBurnRates(USER_QUERY_EVENTS);
    const reportKeys = userAttributionRows(USER_QUERY_EVENTS).map((r) => `${r.dimension}:${r.key}`).sort();
    const rateKeys = rates.map((r) => `${r.dimension}:${r.key}`).sort();
    expect(rateKeys).toEqual(reportKeys);
  });

  it('derives token and USD rates from the sampled log ÷ the MTD window', () => {
    const user = 'a.mendez';
    const events = USER_QUERY_EVENTS.filter((e) => e.user_id === user);
    const expectedIn = events.reduce((a, e) => a + e.tokens_used.input, 0) / MTD_WINDOW_SECONDS;
    const expectedUsd = events.reduce((a, e) => a + e.query_cost, 0) / MTD_WINDOW_SECONDS;
    const r = userBurnRates(USER_QUERY_EVENTS).find((x) => x.key === user);
    expect(r).toBeDefined();
    expect(r!.tokensInPerSecond).toBeCloseTo(expectedIn, 12);
    expect(r!.usdPerSecond).toBeCloseTo(expectedUsd, 15);
  });
});

// ---------------------------------------------------------------------------
// accruedAt — exact, monotonic, deterministic, guarded
// ---------------------------------------------------------------------------

describe('accruedAt', () => {
  const halfCent = rate('t', 0.5, { tokensInPerSecond: 10, tokensOutPerSecond: 2 });

  it('accrues exactly rate × elapsed × replay speed (float-exact magnitudes)', () => {
    expect(accruedAt(halfCent, 2)).toEqual({
      tokensIn: 10 * 2 * ACCRUAL_REPLAY_SPEED,
      tokensOut: 2 * 2 * ACCRUAL_REPLAY_SPEED,
      usd: 0.5 * 2 * ACCRUAL_REPLAY_SPEED,
    });
  });

  it('accrues nothing at elapsed 0', () => {
    expect(accruedAt(halfCent, 0)).toEqual({ tokensIn: 0, tokensOut: 0, usd: 0 });
  });

  it('is monotonic in elapsed', () => {
    const grid = [0, 1, 2, 5, 10, 100, 1000];
    let prev = { tokensIn: -1, tokensOut: -1, usd: -1 };
    for (const t of grid) {
      const a = accruedAt(halfCent, t);
      expect(a.tokensIn).toBeGreaterThanOrEqual(prev.tokensIn);
      expect(a.tokensOut).toBeGreaterThanOrEqual(prev.tokensOut);
      expect(a.usd).toBeGreaterThanOrEqual(prev.usd);
      prev = a;
    }
  });

  it('is deterministic across instances — same inputs, identical output', () => {
    expect(accruedAt(halfCent, 42)).toEqual(accruedAt(halfCent, 42));
  });

  it('guards negative, NaN, and Infinite clocks to zero (calculations.ts precedent)', () => {
    const zero = { tokensIn: 0, tokensOut: 0, usd: 0 };
    expect(accruedAt(halfCent, -5)).toEqual(zero);
    expect(accruedAt(halfCent, Number.NaN)).toEqual(zero);
    expect(accruedAt(halfCent, Number.POSITIVE_INFINITY)).toEqual(zero);
  });
});

// ---------------------------------------------------------------------------
// liveAttributionView — layering, ranking, share guards
// ---------------------------------------------------------------------------

describe('liveAttributionView', () => {
  it('at elapsed 0 the live view equals the stored report', () => {
    const report = reportOf([row('a', 100), row('b', 90)]);
    const view = liveAttributionView(report, [rate('a', 0.5), rate('b', 2)], 0);
    expect(view.totalBaseUsd).toBe(report.totalInferenceCost);
    expect(view.totalAccruedUsd).toBe(0);
    expect(view.rows.map((r) => [r.base.key, r.liveInferenceCost])).toEqual([
      ['a', 100],
      ['b', 90],
    ]);
    expect(view.rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('re-ranks when a faster-accruing row overtakes — and only then', () => {
    // a: 100 + 0.5·60·t = 100+30t ; b: 90 + 2·60·t = 90+120t → b passes at t≈0.111
    const report = reportOf([row('a', 100), row('b', 90)]);
    const rates = [rate('a', 0.5), rate('b', 2)];

    const before = liveAttributionView(report, rates, 0.05);
    expect(before.rows.map((r) => r.base.key)).toEqual(['a', 'b']);

    const after = liveAttributionView(report, rates, 0.2);
    expect(after.rows.map((r) => r.base.key)).toEqual(['b', 'a']);
    expect(after.rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('breaks live ties by key ascending (deterministic order)', () => {
    const report = reportOf([row('b', 100), row('a', 100)]);
    const view = liveAttributionView(report, [rate('a', 1), rate('b', 1)], 1);
    expect(view.rows.map((r) => r.base.key)).toEqual(['a', 'b']);
  });

  it('recomputes shares against the live total, summing to 1 (guarded)', () => {
    const report = reportOf([row('a', 100), row('b', 90)]);
    const view = liveAttributionView(report, [rate('a', 0.5), rate('b', 2)], 10);
    const shareSum = view.rows.reduce((a, r) => a + r.liveShareOfTotal, 0);
    expect(shareSum).toBeCloseTo(1, 12);
    expect(view.totalLiveUsd).toBe(view.totalBaseUsd + view.totalAccruedUsd);
  });

  it('carries live token totals (base + accrued) per row', () => {
    const report = reportOf([row('a', 100)]);
    const view = liveAttributionView(
      report,
      [rate('a', 0, { tokensInPerSecond: 10, tokensOutPerSecond: 2 })],
      1,
    );
    expect(view.rows[0].liveTokensIn).toBe(10 * ACCRUAL_REPLAY_SPEED);
    expect(view.rows[0].liveTokensOut).toBe(2 * ACCRUAL_REPLAY_SPEED);
  });

  it('returns an empty view for a report with no rows', () => {
    const view = liveAttributionView(reportOf([]), [], 5);
    expect(view.rows).toEqual([]);
    expect(view.totalLiveUsd).toBe(0);
    expect(view.totalAccruedUsd).toBe(0);
  });

  it('throws when a report row has no matching rate (wiring bug, never frozen rows)', () => {
    const report = reportOf([row('a', 100), row('orphan', 1)]);
    expect(() => liveAttributionView(report, [rate('a', 1)], 0)).toThrow(/No accrual rate/);
  });

  it('is deterministic across instances with the same injected clock', () => {
    const report = reportOf([row('a', 100), row('b', 90)]);
    const rates = [rate('a', 0.5), rate('b', 2)];
    expect(liveAttributionView(report, rates, 7)).toEqual(liveAttributionView(report, rates, 7));
  });

  it('layers accrual over the real seeded team report (integration)', () => {
    const rows = teamAttributionRows(WORKLOADS);
    const baseTotal = rows.reduce((a, r) => a + r.inferenceCost, 0);
    const report: AttributionReport = {
      generatedAt: '2026-06-25T17:42:00.000Z',
      dimension: 'team',
      window: 'integration window',
      rows,
      totalInferenceCost: baseTotal,
      totalTokensIn: 0,
      totalTokensOut: 0,
    };
    const rates = teamBurnRates(WORKLOADS);
    const atZero = liveAttributionView(report, rates, 0);
    const atMinute = liveAttributionView(report, rates, 60);

    expect(atZero.totalBaseUsd).toBeCloseTo(baseTotal, 6);
    expect(atZero.totalLiveUsd).toBeCloseTo(report.totalInferenceCost, 6);
    expect(atMinute.totalAccruedUsd).toBeGreaterThan(0);
    expect(atMinute.totalAccruedUsd).toBeCloseTo(totalUsdPerSecond(rates) * 60 * ACCRUAL_REPLAY_SPEED, 6);
    // Every row accrues monotonically; live costs never dip below base.
    for (const r of atMinute.rows) {
      expect(r.liveInferenceCost).toBeGreaterThanOrEqual(r.base.inferenceCost);
      expect(r.liveTokensIn).toBeGreaterThanOrEqual(r.base.tokensIn);
    }
  });
});

// ---------------------------------------------------------------------------
// spendAccrualCurve — chart data derivation
// ---------------------------------------------------------------------------

describe('spendAccrualCurve', () => {
  it('samples exactly `points` points ending at elapsed, exact rate×t math', () => {
    const series = spendAccrualCurve({ usdPerSecond: 0.5, elapsedWallSeconds: 25, points: 5, windowSeconds: 10 });
    expect(series.map((p) => p.tSeconds)).toEqual([15, 17.5, 20, 22.5, 25]);
    expect(series.map((p) => p.usd)).toEqual([
      0.5 * 15 * 60,
      0.5 * 17.5 * 60,
      0.5 * 20 * 60,
      0.5 * 22.5 * 60,
      0.5 * 25 * 60,
    ]);
  });

  it('clamps to 0 when the session is younger than the window, monotonic throughout', () => {
    const series = spendAccrualCurve({ usdPerSecond: 1, elapsedWallSeconds: 4, points: 5, windowSeconds: 10 });
    expect(series[0].tSeconds).toBe(0);
    expect(series[series.length - 1].tSeconds).toBe(4);
    for (let i = 1; i < series.length; i++) {
      expect(series[i].tSeconds).toBeGreaterThanOrEqual(series[i - 1].tSeconds);
      expect(series[i].usd).toBeGreaterThanOrEqual(series[i - 1].usd);
    }
  });

  it('defaults to 60 samples over a trailing 60s window', () => {
    const series = spendAccrualCurve({ usdPerSecond: 1, elapsedWallSeconds: 120 });
    expect(series).toHaveLength(60);
    expect(series[series.length - 1].tSeconds).toBe(120);
    expect(series[0].tSeconds).toBe(60);
  });

  it('degenerates cleanly: a single sample at elapsed, and a zero-length window is flat', () => {
    expect(spendAccrualCurve({ usdPerSecond: 1, elapsedWallSeconds: 30, points: 1 })).toEqual([
      { tSeconds: 30, usd: 1 * 30 * ACCRUAL_REPLAY_SPEED },
    ]);
    const flat = spendAccrualCurve({ usdPerSecond: 1, elapsedWallSeconds: 30, points: 3, windowSeconds: 0 });
    expect(flat).toEqual([
      { tSeconds: 30, usd: 30 * ACCRUAL_REPLAY_SPEED },
      { tSeconds: 30, usd: 30 * ACCRUAL_REPLAY_SPEED },
      { tSeconds: 30, usd: 30 * ACCRUAL_REPLAY_SPEED },
    ]);
  });

  it('guards a negative clock to an all-zero curve', () => {
    const series = spendAccrualCurve({ usdPerSecond: 1, elapsedWallSeconds: -10, points: 3 });
    expect(series.every((p) => p.tSeconds === 0 && p.usd === 0)).toBe(true);
  });
});
