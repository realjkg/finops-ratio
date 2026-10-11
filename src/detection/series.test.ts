// Tests for buildDailySeries and series validation.

import { describe, expect, it } from 'vitest';
import { buildDailySeries, viewSeries } from '@/detection/series';
import { row, mkSeries, TENANT } from '@/detection/testkit';
import { DetectionError, LIMITS, seriesId, type DailySeries } from '@/detection/types';
import type { CostRowInput } from '@/detection/series';
import type { CanonicalCostRow } from '@/costsource/focusRows';

const BASE = { tenant: TENANT, costField: 'EffectiveCost' } as const;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof DetectionError ? err.code : 'NOT_A_DETECTION_ERROR';
  }
}

describe('buildDailySeries aggregation', () => {
  it('aggregates rows into one series per (tenant, currency, account, service, region) and day', () => {
    const rows = [
      row({ EffectiveCost: 1.5 }),
      row({ EffectiveCost: 2.5 }),
      row({ ChargePeriodStart: '2026-03-02T00:00:00Z', ChargePeriodEnd: '2026-03-03T00:00:00Z', EffectiveCost: 4 }),
      row({ x_RatioRegion: 'eu-west-1', EffectiveCost: 7 }),
      row({ ServiceName: 'Storage', EffectiveCost: 9 }),
    ];
    const { series, stats } = buildDailySeries(rows, BASE);
    expect(series.map((s) => s.id)).toEqual([
      `${TENANT}|USD|acct-a|Compute|eu-west-1`,
      `${TENANT}|USD|acct-a|Compute|us-east-1`,
      `${TENANT}|USD|acct-a|Storage|us-east-1`,
    ]);
    const east = series[1] as DailySeries;
    expect(east.points).toEqual([
      { day: '2026-03-01', value: 4 },
      { day: '2026-03-02', value: 4 },
    ]);
    expect(stats).toMatchObject({ rowsRead: 5, rowsAggregated: 5, rowsExcluded: 0, duplicatesDropped: 0 });
  });

  it('makes the cost field an explicit choice and reads only that field', () => {
    const rows = [row({ BilledCost: 100, EffectiveCost: 60 })];
    const billed = buildDailySeries(rows, { ...BASE, costField: 'BilledCost' });
    const effective = buildDailySeries(rows, BASE);
    expect(billed.series[0]?.points[0]?.value).toBe(100);
    expect(effective.series[0]?.points[0]?.value).toBe(60);
    expect(billed.series[0]?.costField).toBe('BilledCost');
    expect(codeOf(() => buildDailySeries(rows, { tenant: TENANT } as never))).toBe('OPTIONS_INVALID');
    expect(codeOf(() => buildDailySeries(rows, { ...BASE, costField: 'ListCost' as never }))).toBe('OPTIONS_INVALID');
  });

  it('does not validate the unselected cost field', () => {
    const rows = [row({ BilledCost: Number.NaN, EffectiveCost: 5 })];
    expect(buildDailySeries(rows, BASE).series[0]?.points[0]?.value).toBe(5);
    expect(codeOf(() => buildDailySeries(rows, { ...BASE, costField: 'BilledCost' }))).toBe('AMOUNT_INVALID');
  });

  it('keeps currencies apart and never sums across them', () => {
    const rows = [
      row({ BillingCurrency: 'USD', EffectiveCost: 100 }),
      row({ BillingCurrency: 'EUR', EffectiveCost: 90 }),
      row({ BillingCurrency: 'JPY', EffectiveCost: 15000 }),
    ];
    const { series } = buildDailySeries(rows, BASE);
    expect(series).toHaveLength(3);
    const byCurrency = new Map(series.map((s) => [s.key.currency, s.points[0]?.value]));
    expect(byCurrency.get('USD')).toBe(100);
    expect(byCurrency.get('EUR')).toBe(90);
    expect(byCurrency.get('JPY')).toBe(15000);
  });

  it('treats a region-less row as region empty string', () => {
    const { series } = buildDailySeries([row({ x_RatioRegion: null }), row({ x_RatioRegion: undefined })], BASE);
    expect(series).toHaveLength(1);
    expect(series[0]?.key.region).toBe('');
    expect(series[0]?.points[0]?.value).toBe(16);
  });

  it('accepts a canonical FOCUS cost row shape (type compatibility)', () => {
    const pick = (r: CanonicalCostRow): CostRowInput => r;
    expect(typeof pick).toBe('function');
  });

  it('rounds each daily total once to six decimals', () => {
    const rows = Array.from({ length: 10 }, () => row({ EffectiveCost: 0.1 }));
    const { series } = buildDailySeries(rows, BASE);
    expect(series[0]?.points[0]?.value).toBe(1);
    const tiny = buildDailySeries([row({ EffectiveCost: 0.0000004 })], BASE);
    expect(tiny.series[0]?.points[0]?.value).toBe(0);
    const half = buildDailySeries([row({ EffectiveCost: 0.0000005 })], BASE);
    expect(half.series[0]?.points[0]?.value).toBe(0.000001);
  });

  it('returns an empty result for no rows', () => {
    const { series, stats } = buildDailySeries([], BASE);
    expect(series).toEqual([]);
    expect(stats.rowsRead).toBe(0);
  });

  it('is deterministic regardless of input row order', () => {
    const rows = [
      row({ ServiceName: 'B', EffectiveCost: 2 }),
      row({ ServiceName: 'A', EffectiveCost: 1 }),
      row({ SubAccountId: 'acct-z', EffectiveCost: 3 }),
      row({ ChargePeriodStart: '2026-03-05T00:00:00Z', ChargePeriodEnd: '2026-03-06T00:00:00Z' }),
    ];
    const forward = buildDailySeries(rows, BASE);
    const reversed = buildDailySeries(rows.slice().reverse(), BASE);
    expect(reversed.series).toEqual(forward.series);
  });
});

describe('inclusion rules', () => {
  it('excludes non-Usage categories, corrections and non-usage-based Usage rows', () => {
    const rows = [
      row({ EffectiveCost: 10 }),
      row({ ChargeCategory: 'Tax', EffectiveCost: 99 }),
      row({ ChargeCategory: 'Credit', EffectiveCost: -50 }),
      row({ ChargeCategory: 'Purchase', EffectiveCost: 1000 }),
      row({ ChargeClass: 'Correction', EffectiveCost: 77 }),
      row({ ChargeFrequency: 'Recurring', EffectiveCost: 55 }),
      row({ ChargeFrequency: 'Usage-Based', EffectiveCost: 5 }),
    ];
    const { series, stats } = buildDailySeries(rows, BASE);
    expect(series[0]?.points[0]?.value).toBe(15);
    expect(stats.rowsExcluded).toBe(5);
    expect(stats.rowsAggregated).toBe(2);
  });

  it('lets the caller include other categories explicitly', () => {
    const rows = [row({ EffectiveCost: 10 }), row({ ChargeCategory: 'Credit', EffectiveCost: -4 })];
    const { series } = buildDailySeries(rows, { ...BASE, includeCategories: ['Usage', 'Credit'] });
    expect(series[0]?.points[0]?.value).toBe(6);
  });

  it('excludes multi-day charge periods and counts them (design D-09)', () => {
    const rows = [
      row({ EffectiveCost: 10 }),
      row({ ChargePeriodStart: '2026-03-01T00:00:00Z', ChargePeriodEnd: '2026-04-01T00:00:00Z', EffectiveCost: 3100 }),
      // Exactly 24 hours is allowed.
      row({ ChargePeriodStart: '2026-03-03T00:00:00Z', ChargePeriodEnd: '2026-03-04T00:00:00Z', EffectiveCost: 1 }),
      // One millisecond over 24 hours is not.
      row({ ChargePeriodStart: '2026-03-04T00:00:00Z', ChargePeriodEnd: '2026-03-05T00:00:00.001Z', EffectiveCost: 1 }),
    ];
    const { series, stats } = buildDailySeries(rows, BASE);
    expect(stats.rowsMultiDay).toBe(2);
    expect(series[0]?.points.map((p) => p.value)).toEqual([10, 1]);
  });

  it('applies the window and counts rows outside it', () => {
    const rows = [
      row({ ChargePeriodStart: '2026-02-28T00:00:00Z', ChargePeriodEnd: '2026-03-01T00:00:00Z' }),
      row(),
      row({ ChargePeriodStart: '2026-03-02T00:00:00Z', ChargePeriodEnd: '2026-03-03T00:00:00Z' }),
      row({ ChargePeriodStart: '2026-03-03T00:00:00Z', ChargePeriodEnd: '2026-03-04T00:00:00Z' }),
    ];
    const { series, stats } = buildDailySeries(rows, { ...BASE, fromDay: '2026-03-01', toDay: '2026-03-02' });
    expect(series[0]?.points.map((p) => p.day)).toEqual(['2026-03-01', '2026-03-02']);
    expect(stats.rowsOutOfWindow).toBe(2);
    expect(codeOf(() => buildDailySeries(rows, { ...BASE, fromDay: '2026-03-05', toDay: '2026-03-01' }))).toBe(
      'OPTIONS_INVALID',
    );
    expect(codeOf(() => buildDailySeries(rows, { ...BASE, fromDay: 'nope' }))).toBe('OPTIONS_INVALID');
  });
});

describe('credits, refunds and negative amounts', () => {
  it('nets a negative Usage credit into the day by default (design 3.1)', () => {
    const rows = [row({ EffectiveCost: 100 }), row({ EffectiveCost: -30 })];
    expect(buildDailySeries(rows, BASE).series[0]?.points[0]?.value).toBe(70);
  });

  it('allows a day to net to zero or below', () => {
    const rows = [row({ EffectiveCost: 10 }), row({ EffectiveCost: -25 })];
    expect(buildDailySeries(rows, BASE).series[0]?.points[0]?.value).toBe(-15);
  });

  it('refuses any negative included amount under the reject rule', () => {
    const rows = [row({ EffectiveCost: 10 }), row({ EffectiveCost: -0.01 })];
    expect(codeOf(() => buildDailySeries(rows, { ...BASE, negativeAmounts: 'reject' }))).toBe('NEGATIVE_AMOUNT');
    expect(codeOf(() => buildDailySeries(rows, { ...BASE, negativeAmounts: 'void' as never }))).toBe(
      'OPTIONS_INVALID',
    );
  });

  it('does not apply the reject rule to excluded credit rows', () => {
    const rows = [row({ EffectiveCost: 10 }), row({ ChargeCategory: 'Credit', EffectiveCost: -500 })];
    expect(buildDailySeries(rows, { ...BASE, negativeAmounts: 'reject' }).series[0]?.points[0]?.value).toBe(10);
  });
});

describe('duplicates', () => {
  it('drops an exact repeat of a RowId and counts it', () => {
    const rows = [row({ RowId: 'r1', EffectiveCost: 10 }), row({ RowId: 'r1', EffectiveCost: 10 }), row({ RowId: 'r2', EffectiveCost: 5 })];
    const { series, stats } = buildDailySeries(rows, BASE);
    expect(series[0]?.points[0]?.value).toBe(15);
    expect(stats.duplicatesDropped).toBe(1);
    expect(stats.rowsAggregated).toBe(2);
  });

  it('refuses a RowId reused with a different amount, day or series', () => {
    expect(codeOf(() => buildDailySeries([row({ RowId: 'r1', EffectiveCost: 10 }), row({ RowId: 'r1', EffectiveCost: 11 })], BASE))).toBe(
      'DUPLICATE_CONFLICT',
    );
    expect(
      codeOf(() =>
        buildDailySeries(
          [
            row({ RowId: 'r1' }),
            row({ RowId: 'r1', ChargePeriodStart: '2026-03-02T00:00:00Z', ChargePeriodEnd: '2026-03-03T00:00:00Z' }),
          ],
          BASE,
        ),
      ),
    ).toBe('DUPLICATE_CONFLICT');
    expect(codeOf(() => buildDailySeries([row({ RowId: 'r1' }), row({ RowId: 'r1', ServiceName: 'Other' })], BASE))).toBe(
      'DUPLICATE_CONFLICT',
    );
  });

  it('sums rows without a RowId (separate charges); upstream owns their de-duplication', () => {
    const rows = [row({ EffectiveCost: 10 }), row({ EffectiveCost: 10 })];
    expect(buildDailySeries(rows, BASE).series[0]?.points[0]?.value).toBe(20);
  });
});

describe('strict validation (fail closed, fixed text)', () => {
  it('refuses bad dates', () => {
    expect(codeOf(() => buildDailySeries([row({ ChargePeriodStart: '2026-02-30T00:00:00Z' })], BASE))).toBe('TIMESTAMP_INVALID');
    expect(codeOf(() => buildDailySeries([row({ ChargePeriodStart: '2026-03-01T00:00:00' })], BASE))).toBe('TIMESTAMP_INVALID');
    expect(codeOf(() => buildDailySeries([row({ ChargePeriodEnd: 'garbage' })], BASE))).toBe('TIMESTAMP_INVALID');
    expect(codeOf(() => buildDailySeries([row({ ChargePeriodStart: undefined as never })], BASE))).toBe('TIMESTAMP_INVALID');
  });

  it('refuses an empty or reversed charge period', () => {
    expect(codeOf(() => buildDailySeries([row({ ChargePeriodEnd: '2026-03-01T00:00:00Z' })], BASE))).toBe('TIMESTAMP_INVALID');
    expect(codeOf(() => buildDailySeries([row({ ChargePeriodEnd: '2026-02-28T00:00:00Z' })], BASE))).toBe('TIMESTAMP_INVALID');
  });

  it('refuses non-finite and out-of-range numbers, and non-number types', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e12 + 1, -1e12 - 1]) {
      expect(codeOf(() => buildDailySeries([row({ EffectiveCost: bad })], BASE))).toBe('AMOUNT_INVALID');
    }
    expect(codeOf(() => buildDailySeries([row({ EffectiveCost: '12' as never })], BASE))).toBe('AMOUNT_INVALID');
    expect(codeOf(() => buildDailySeries([row({ EffectiveCost: null as never })], BASE))).toBe('AMOUNT_INVALID');
  });

  it('accepts extreme values at the bound and sums them without losing finiteness', () => {
    const rows = [row({ EffectiveCost: 1e12 }), row({ EffectiveCost: 1e12 }), row({ EffectiveCost: -1e12 })];
    expect(buildDailySeries(rows, BASE).series[0]?.points[0]?.value).toBe(1e12);
  });

  it('refuses bad identifiers and currencies', () => {
    expect(codeOf(() => buildDailySeries([row({ SubAccountId: '' })], BASE))).toBe('IDENTIFIER_INVALID');
    expect(codeOf(() => buildDailySeries([row({ ServiceName: 'a|b' })], BASE))).toBe('IDENTIFIER_INVALID');
    expect(codeOf(() => buildDailySeries([row({ x_RatioRegion: 'x\u0000y' })], BASE))).toBe('IDENTIFIER_INVALID');
    expect(codeOf(() => buildDailySeries([row({ ChargeCategory: 5 as never })], BASE))).toBe('IDENTIFIER_INVALID');
    expect(codeOf(() => buildDailySeries([row({ BillingCurrency: 'usd' })], BASE))).toBe('CURRENCY_INVALID');
    expect(codeOf(() => buildDailySeries([row({ BillingCurrency: 'CREDITS' })], BASE))).toBe('CURRENCY_INVALID');
  });

  it('refuses malformed rows and options', () => {
    expect(codeOf(() => buildDailySeries([null as never], BASE))).toBe('ROW_MALFORMED');
    expect(codeOf(() => buildDailySeries(['x' as never], BASE))).toBe('ROW_MALFORMED');
    expect(codeOf(() => buildDailySeries([[] as never], BASE))).toBe('ROW_MALFORMED');
    expect(codeOf(() => buildDailySeries('rows' as never, BASE))).toBe('ROW_MALFORMED');
    expect(codeOf(() => buildDailySeries([], null as never))).toBe('OPTIONS_INVALID');
    expect(codeOf(() => buildDailySeries([], { ...BASE, tenant: '' }))).toBe('OPTIONS_INVALID');
    expect(codeOf(() => buildDailySeries([], { ...BASE, includeCategories: [] }))).toBe('OPTIONS_INVALID');
    expect(codeOf(() => buildDailySeries([], { ...BASE, includeCategories: [''] }))).toBe('OPTIONS_INVALID');
  });

  it('validates the whole batch: one bad row refuses the call and reports only its index', () => {
    const rows = [row(), row(), row({ EffectiveCost: Number.NaN })];
    try {
      buildDailySeries(rows, BASE);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DetectionError);
      expect((err as DetectionError).index).toBe(2);
    }
  });

  it('never echoes input values in error messages', () => {
    const secret = 'ZZ-SECRET-9f3';
    const attempts: CostRowInput[] = [
      row({ SubAccountId: `${secret}|x` }),
      row({ ServiceName: `${secret}\n` }),
      row({ ChargePeriodStart: secret }),
      row({ BillingCurrency: secret }),
      row({ BillingAccountId: secret }),
    ];
    for (const attempt of attempts) {
      try {
        buildDailySeries([attempt], BASE);
        throw new Error('expected throw');
      } catch (err) {
        expect(String((err as Error).message)).not.toContain(secret);
      }
    }
  });
});

describe('tenant scoping', () => {
  it('refuses a row from another tenant instead of skipping it', () => {
    const rows = [row(), row({ BillingAccountId: 'tenant-2' })];
    try {
      buildDailySeries(rows, BASE);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as DetectionError).code).toBe('CROSS_TENANT_ROW');
      expect((err as DetectionError).index).toBe(1);
      expect((err as Error).message).not.toContain('tenant-2');
    }
  });
});

describe('caps', () => {
  const manyRows = (n: number, vary: boolean): CostRowInput[] => {
    const shared = row();
    return Array.from({ length: n }, (_, i) => (vary ? row({ SubAccountId: `acct-${i}` }) : shared));
  };

  it('accepts exactly the row cap and refuses one past it (lowered cap)', () => {
    expect(buildDailySeries(manyRows(50, false), { ...BASE, maxRows: 50 }).stats.rowsRead).toBe(50);
    expect(codeOf(() => buildDailySeries(manyRows(51, false), { ...BASE, maxRows: 50 }))).toBe('ROW_CAP_EXCEEDED');
  });

  it('enforces the built-in row cap at the cap and one past it', () => {
    const atCap = manyRows(LIMITS.maxRows, false);
    expect(buildDailySeries(atCap, BASE).stats.rowsRead).toBe(LIMITS.maxRows);
    const pastCap = atCap.concat([row()]);
    expect(codeOf(() => buildDailySeries(pastCap, BASE))).toBe('ROW_CAP_EXCEEDED');
  });

  it('cannot raise a cap above the built-in limit', () => {
    const pastCap = manyRows(LIMITS.maxRows + 1, false);
    expect(codeOf(() => buildDailySeries(pastCap, { ...BASE, maxRows: LIMITS.maxRows * 10 }))).toBe('ROW_CAP_EXCEEDED');
    expect(codeOf(() => buildDailySeries([], { ...BASE, maxRows: 0 }))).toBe('OPTIONS_INVALID');
    expect(codeOf(() => buildDailySeries([], { ...BASE, maxRows: 1.5 }))).toBe('OPTIONS_INVALID');
    expect(codeOf(() => buildDailySeries([], { ...BASE, maxSeries: -1 }))).toBe('OPTIONS_INVALID');
  });

  it('accepts exactly the series cap and refuses one past it', () => {
    expect(buildDailySeries(manyRows(25, true), { ...BASE, maxSeries: 25 }).series).toHaveLength(25);
    expect(codeOf(() => buildDailySeries(manyRows(26, true), { ...BASE, maxSeries: 25 }))).toBe('SERIES_CAP_EXCEEDED');
  });

  it('accepts a series spanning exactly the maximum days and refuses one more', () => {
    const dayRows = (n: number): CostRowInput[] =>
      Array.from({ length: n }, (_, i) => {
        const ms = Date.UTC(2026, 0, 1) + i * 86_400_000;
        const start = new Date(ms).toISOString().replace('.000Z', 'Z');
        const end = new Date(ms + 86_400_000).toISOString().replace('.000Z', 'Z');
        return row({ ChargePeriodStart: start, ChargePeriodEnd: end });
      });
    expect(buildDailySeries(dayRows(LIMITS.maxDaysPerSeries), BASE).series[0]?.points).toHaveLength(LIMITS.maxDaysPerSeries);
    expect(codeOf(() => buildDailySeries(dayRows(LIMITS.maxDaysPerSeries + 1), BASE))).toBe('SERIES_TOO_LONG');
  });
});

describe('viewSeries (validation of an untrusted series)', () => {
  const good = (): DailySeries => mkSeries({ start: '2026-03-01', values: [1, 2, 3] });

  it('accepts a valid series and returns day numbers', () => {
    const view = viewSeries(good());
    expect(view.dns).toHaveLength(3);
    expect(view.values).toEqual([1, 2, 3]);
  });

  it('refuses unsorted, duplicate and invalid days and non-finite values', () => {
    const base = good();
    const withPoints = (points: unknown): DailySeries => ({ ...base, points: points as DailySeries['points'] });
    expect(codeOf(() => viewSeries(withPoints([{ day: '2026-03-02', value: 1 }, { day: '2026-03-01', value: 1 }])))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries(withPoints([{ day: '2026-03-01', value: 1 }, { day: '2026-03-01', value: 1 }])))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries(withPoints([{ day: '2026-02-30', value: 1 }])))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries(withPoints([{ day: '2026-03-01', value: Number.NaN }])))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries(withPoints([{ day: '2026-03-01', value: '1' }])))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries(withPoints(null)))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries(withPoints([null])))).toBe('SERIES_INVALID');
  });

  it('refuses an id that does not match the key, a bad key and a bad cost field', () => {
    const base = good();
    expect(codeOf(() => viewSeries({ ...base, id: 'forged' }))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries({ ...base, key: { ...base.key, currency: 'usd' } }))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries({ ...base, key: null as never }))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries({ ...base, costField: 'ListCost' as never }))).toBe('SERIES_INVALID');
    expect(codeOf(() => viewSeries(null as never, 4))).toBe('SERIES_INVALID');
    expect(seriesId(base.key)).toBe(base.id);
  });

  it('enforces the span cap at the cap and one past it', () => {
    const atCap = mkSeries({ start: '2026-01-01', values: Array.from({ length: LIMITS.maxDaysPerSeries }, () => 1) });
    expect(viewSeries(atCap).dns).toHaveLength(LIMITS.maxDaysPerSeries);
    const pastCap = mkSeries({ start: '2026-01-01', values: Array.from({ length: LIMITS.maxDaysPerSeries + 1 }, () => 1) });
    expect(codeOf(() => viewSeries(pastCap))).toBe('SERIES_TOO_LONG');
    const sparsePastCap = mkSeries({ start: '2026-01-01', values: [1, ...Array.from({ length: LIMITS.maxDaysPerSeries }, () => null), 1] });
    expect(codeOf(() => viewSeries(sparsePastCap))).toBe('SERIES_TOO_LONG');
  });
});

describe('time zone and DST immunity of bucketing', () => {
  it('buckets hourly rows across the US DST day into exactly 24 hours per UTC day', () => {
    const rows: CostRowInput[] = [];
    for (let h = 0; h < 48; h += 1) {
      const ms = Date.UTC(2026, 2, 8, 0, 0, 0) + h * 3_600_000;
      const startIso = new Date(ms).toISOString().replace('.000Z', 'Z');
      const endIso = new Date(ms + 3_600_000).toISOString().replace('.000Z', 'Z');
      rows.push(row({ ChargePeriodStart: startIso, ChargePeriodEnd: endIso, EffectiveCost: 1 }));
    }
    const { series } = buildDailySeries(rows, BASE);
    expect(series[0]?.points).toEqual([
      { day: '2026-03-08', value: 24 },
      { day: '2026-03-09', value: 24 },
    ]);
  });

  it('gives identical series under different process time zones', () => {
    const original = process.env.TZ;
    const rows = [
      row({ ChargePeriodStart: '2026-03-08T23:30:00-06:00', ChargePeriodEnd: '2026-03-09T00:30:00-06:00', EffectiveCost: 3 }),
      row({ ChargePeriodStart: '2026-03-08T01:30:00+09:00', ChargePeriodEnd: '2026-03-08T02:30:00+09:00', EffectiveCost: 5 }),
      row({ ChargePeriodStart: '2026-03-29T01:30:00+01:00', ChargePeriodEnd: '2026-03-29T02:30:00+01:00', EffectiveCost: 7 }),
    ];
    try {
      const outputs = ['UTC', 'Asia/Tokyo', 'America/Chicago'].map((tz) => {
        process.env.TZ = tz;
        return buildDailySeries(rows, BASE).series[0]?.points;
      });
      expect(outputs[1]).toEqual(outputs[0]);
      expect(outputs[2]).toEqual(outputs[0]);
      expect(outputs[0]).toEqual([
        { day: '2026-03-07', value: 5 },
        { day: '2026-03-09', value: 3 },
        { day: '2026-03-29', value: 7 },
      ]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('keeps month boundaries and leap February in the right months', () => {
    const rows = [
      row({ ChargePeriodStart: '2028-02-28T23:59:59Z', ChargePeriodEnd: '2028-02-29T00:30:00Z' }),
      row({ ChargePeriodStart: '2028-02-29T23:59:59Z', ChargePeriodEnd: '2028-03-01T00:30:00Z' }),
      row({ ChargePeriodStart: '2028-03-01T00:00:00Z', ChargePeriodEnd: '2028-03-01T00:30:00Z' }),
    ];
    const { series } = buildDailySeries(rows, BASE);
    expect(series[0]?.points.map((p) => p.day)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });
});
