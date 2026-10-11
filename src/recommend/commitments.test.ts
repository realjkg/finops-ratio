import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPIRING_WITHIN_DAYS, MAX_COMMITMENT_ROWS, MAX_TERMS, MAX_WINDOW_DAYS, analyzeCommitments,
  type CommitmentFocusRow, type CurrencyCommitmentReport,
} from './commitments';
import { RECOMMEND_INPUT_ERROR_MESSAGES, RecommendInputError } from './errors';
import { toJsonSafe } from './money';
import { DAY, T0, T0_MS, dailyOnDemand, hourlyOnDemand, iso, lcg, onDemand, purchase, unused, used, win } from './testRows';

const B = (n: number | string) => BigInt(n);

function usd(rows: CommitmentFocusRow[], days = 30, opts = {}): CurrencyCommitmentReport {
  const c = analyzeCommitments(rows, win(days), opts).currencies.find((x) => x.currency === 'USD');
  if (!c) throw new Error('no USD report');
  return c;
}

describe('coverage and utilization', () => {
  it('partial coverage, hand computed', () => {
    const r = usd([used('sp-1', 60, 40), unused('sp-1', 10), onDemand(40)]);
    expect(r.totals.usedCostMinor).toBe(B(4000));
    expect(r.totals.unusedCostMinor).toBe(B(1000));
    expect(r.totals.committedCostMinor).toBe(B(5000));
    expect(r.totals.utilizationPct).toBe(80);
    expect(r.totals.eligibleBasisMinor).toBe(B(10000));
    expect(r.totals.coveragePct).toBe(60);
    expect(r.commitments[0]).toMatchObject({ commitmentId: 'sp-1', unusedCostMinor: B(1000), utilizationPct: 80, kind: 'spend' });
  });
  it('zero coverage', () => {
    const r = usd([onDemand(25), onDemand(75)]);
    expect(r.totals.coveragePct).toBe(0);
    expect(r.totals.utilizationPct).toBeNull();
    expect(r.commitments).toEqual([]);
  });
  it('fully used', () => {
    const r = usd([used('ri-1', 100, 70), used('ri-1', 100, 70)]);
    expect(r.commitments[0].utilizationPct).toBe(100);
    expect(r.commitments[0].unusedCostMinor).toBe(B(0));
    expect(r.totals.coveragePct).toBe(100);
  });
  it('all unused is flagged; coverage undefined', () => {
    const r = usd([unused('ri-2', 30), unused('ri-2', 20)]);
    expect(r.commitments[0].utilizationPct).toBe(0);
    expect(r.commitments[0].unusedCostMinor).toBe(B(5000));
    expect(r.commitments[0].flags).toContain('all_unused');
    expect(r.totals.coveragePct).toBeNull();
  });
  it('coverage never exceeds 100 and floors', () => {
    expect(usd([used('sp-1', 123.45, 80)]).totals.coveragePct).toBe(100);
    expect(usd([used('sp-1', 20, 10), onDemand(10)]).totals.coveragePct).toBe(66.66);
  });
  it('splits a commitment across families', () => {
    const r = usd([
      used('sp-1', 60, 40, { ServiceName: 'Compute' }), used('sp-1', 20, 10, { ServiceName: 'Fargate' }),
      onDemand(40, { ServiceName: 'Compute' }), onDemand(30, { ServiceName: 'Fargate' }),
    ]);
    expect(r.families.map((f) => [f.family, f.coveragePct])).toEqual([['Compute', 60], ['Fargate', 40]]);
    expect(r.cells).toHaveLength(2);
    expect(r.commitments[0].shareOfFamilyEligiblePct).toBe(53.33);
  });
  it('honors costBasis', () => {
    const skew = [used('sp-1', 0, 40, { ContractedCost: 60, ListCost: 100 }), onDemand(0, { ContractedCost: 40, ListCost: 20 })];
    expect(usd(skew).totals.coveragePct).toBe(60);
    expect(usd(skew, 30, { costBasis: 'ListCost' }).totals.coveragePct).toBe(83.33);
  });
  it('flags baseline below effective', () => {
    const r = usd([used('sp-1', 30, 50), onDemand(10)]);
    expect(r.families[0].flags).toContain('baseline_below_effective');
  });
  it('sums purchases separately', () => {
    const r = usd([purchase('ri-1', 1200), purchase('ri-1', 300), used('ri-1', 100, 70)]);
    expect(r.commitments[0].purchaseBilledMinor).toBe(B(150000));
  });
});

describe('eligibility', () => {
  it('ignores and counts non-eligible rows', () => {
    const a = analyzeCommitments([
      onDemand(10), onDemand(99, { PricingCategory: 'Dynamic' }), onDemand(99, { PricingCategory: 'Other' }),
      onDemand(99, { ChargeCategory: 'Tax' }), onDemand(99, { ChargeCategory: 'Credit' }),
      onDemand(99, { ChargeFrequency: 'Recurring' }), purchase('', 5, { CommitmentDiscountId: null }),
    ], win(30));
    expect(a.rows.analyzed).toBe(1);
    expect(a.rows.ignoredByReason).toEqual({
      dynamic_pricing: 1, other_pricing: 1, non_usage_charge: 2, non_usage_frequency: 1, purchase_without_commitment: 1,
    });
  });
  it('covered non-usage-based row counts for utilization, not coverage', () => {
    const r = usd([used('sp-1', 50, 30, { ChargeFrequency: 'Recurring' }), onDemand(50)]);
    expect(r.commitments[0].usedCostMinor).toBe(B(3000));
    expect(r.totals.coveredBasisMinor).toBe(B(0));
  });
  it('absent frequency is usage-based', () => {
    const r0 = onDemand(10);
    delete r0.ChargeFrequency;
    expect(usd([r0]).totals.onDemandBasisMinor).toBe(B(1000));
  });
  it('window is half open', () => {
    const a = analyzeCommitments([
      onDemand(1, { ChargePeriodStart: T0 }), onDemand(1, { ChargePeriodStart: iso(T0_MS + 30 * DAY), ChargePeriodEnd: null }),
      onDemand(1, { ChargePeriodStart: iso(T0_MS + 30 * DAY - 1), ChargePeriodEnd: null }), onDemand(1, { ChargePeriodStart: iso(T0_MS - 1), ChargePeriodEnd: null }),
    ], win(30));
    expect(a.rows.outOfWindow).toBe(2);
    expect(a.rows.analyzed).toBe(2);
  });
});

describe('spend vs usage based, units', () => {
  it('keeps kinds and units apart', () => {
    const r = usd([
      used('sp-1', 60, 40, { CommitmentDiscountQuantity: 12.5, CommitmentDiscountUnit: 'USD' }),
      unused('sp-1', 10, { CommitmentDiscountQuantity: 2.5, CommitmentDiscountUnit: 'USD' }),
      used('ri-9', 100, 70, { CommitmentDiscountCategory: 'Usage', CommitmentDiscountQuantity: 30, CommitmentDiscountUnit: 'Hours', CommitmentDiscountType: 'Reserved Instance' }),
      unused('ri-9', 5, { CommitmentDiscountCategory: 'Usage', CommitmentDiscountQuantity: 10, CommitmentDiscountUnit: 'Hours' }),
    ]);
    const sp = r.commitments.find((c) => c.commitmentId === 'sp-1');
    const ri = r.commitments.find((c) => c.commitmentId === 'ri-9');
    expect(sp?.kind).toBe('spend');
    expect(ri?.kind).toBe('usage');
    expect(sp?.units).toEqual([{ unit: 'USD', usedQuantity: '12.5', unusedQuantity: '2.5', utilizationPct: 83.33 }]);
    expect(ri?.units).toEqual([{ unit: 'Hours', usedQuantity: '30', unusedQuantity: '10', utilizationPct: 75 }]);
    expect(ri?.utilizationPct).toBe(93.33);
  });
  it('mixed units flagged and separate', () => {
    const r = usd([
      used('c-1', 10, 5, { CommitmentDiscountQuantity: 4, CommitmentDiscountUnit: 'vCPU-Hours' }),
      used('c-1', 10, 5, { CommitmentDiscountQuantity: 8, CommitmentDiscountUnit: 'GB-Hours' }),
    ]);
    expect(r.commitments[0].flags).toContain('mixed_units');
    expect(r.commitments[0].units.map((u) => u.unit)).toEqual(['GB-Hours', 'vCPU-Hours']);
  });
  it('conflicting and unknown categories', () => {
    expect(usd([used('c', 1, 1, { CommitmentDiscountCategory: 'Spend' }), used('c', 1, 1, { CommitmentDiscountCategory: 'Usage' })]).commitments[0].kind).toBe('conflicting');
    expect(usd([used('c', 1, 1, { CommitmentDiscountCategory: null })]).commitments[0].kind).toBe('unknown');
  });
  it('adds fractional quantities exactly', () => {
    const rows = [0.1, 0.2].map((q) => used('c', 1, 1, { CommitmentDiscountQuantity: q, CommitmentDiscountUnit: 'Hours' }));
    expect(usd(rows).commitments[0].units[0].usedQuantity).toBe('0.3');
  });
  it('unusable quantity is flagged but cost kept', () => {
    const r = usd([
      used('c', 10, 5, { CommitmentDiscountQuantity: -3, CommitmentDiscountUnit: 'Hours' }),
      used('c', 10, 5, { CommitmentDiscountQuantity: 3, CommitmentDiscountUnit: null }),
    ]);
    expect(r.commitments[0].usedCostMinor).toBe(B(1000));
    expect(r.commitments[0].flags).toContain('quantity_unusable');
  });
});

describe('mixed currencies', () => {
  it('reports each currency apart', () => {
    const a = analyzeCommitments([
      used('sp-usd', 60, 40), onDemand(40), used('sp-eur', 50, 30, { BillingCurrency: 'EUR' }),
      unused('sp-eur', 10, { BillingCurrency: 'EUR' }), onDemand(5000, { BillingCurrency: 'JPY' }),
    ], win(30));
    expect(a.currencies.map((c) => c.currency)).toEqual(['EUR', 'JPY', 'USD']);
    expect(a.currencies[0].totals.usedCostMinor).toBe(B(3000));
    expect(a.currencies[1].totals.onDemandBasisMinor).toBe(B(5000));
    expect(a.currencies[2].totals.usedCostMinor).toBe(B(4000));
  });
  it('same id in two currencies is two commitments', () => {
    const a = analyzeCommitments([used('s', 1, 1), used('s', 1, 1, { BillingCurrency: 'EUR' })], win(30));
    expect(a.currencies.every((c) => c.commitments.length === 1)).toBe(true);
  });
});

describe('expiry', () => {
  const termAt = (days: number, extra = 0) => iso(T0_MS + (30 + days) * DAY + extra);
  it('classifies terms', () => {
    const r = usd([used('soon', 1, 1), used('later', 1, 1), used('gone', 1, 1), used('none', 1, 1)], 30, {
      terms: [
        { commitmentId: 'soon', termEnd: termAt(42) }, { commitmentId: 'later', termEnd: termAt(120) },
        { commitmentId: 'gone', termEnd: termAt(-15) },
      ],
    });
    const by = Object.fromEntries(r.commitments.map((c) => [c.commitmentId, c]));
    expect(by.soon).toMatchObject({ termStatus: 'expiring_soon', expiringSoon: true, daysToExpiry: 42 });
    expect(by.later).toMatchObject({ termStatus: 'active', expiringSoon: false });
    expect(by.gone).toMatchObject({ termStatus: 'expired', expired: true, daysToExpiry: -15 });
    expect(by.none).toMatchObject({ termStatus: 'unknown', termEnd: null });
  });
  it('boundary is exact', () => {
    const run = (x: number) => usd([used('c', 1, 1)], 30, { terms: [{ commitmentId: 'c', termEnd: termAt(DEFAULT_EXPIRING_WITHIN_DAYS, x) }] }).commitments[0];
    expect(run(0).expiringSoon).toBe(true);
    expect(run(1).expiringSoon).toBe(false);
  });
  it('end equal to asOf is expired; custom horizon and asOf', () => {
    expect(usd([used('c', 1, 1)], 30, { terms: [{ commitmentId: 'c', termEnd: termAt(0) }] }).commitments[0].expired).toBe(true);
    const terms = [{ commitmentId: 'c', termEnd: termAt(100) }];
    expect(usd([used('c', 1, 1)], 30, { terms, expiringWithinDays: 90 }).commitments[0].expiringSoon).toBe(false);
    expect(usd([used('c', 1, 1)], 30, { terms, expiringWithinDays: 120 }).commitments[0].expiringSoon).toBe(true);
    expect(usd([used('c', 1, 1)], 30, { terms, asOf: iso(T0_MS + 100 * DAY) }).commitments[0].daysToExpiry).toBe(30);
  });
  it('earliest duplicate wins; malformed terms counted', () => {
    const a = analyzeCommitments([used('c', 1, 1)], win(30), {
      terms: [
        { commitmentId: 'c', termEnd: termAt(200) }, { commitmentId: 'c', termEnd: termAt(20) },
        { commitmentId: '', termEnd: termAt(20) }, { commitmentId: 'c', termEnd: 'bad' }, null as never,
      ],
    });
    expect(a.currencies[0].commitments[0].daysToExpiry).toBe(20);
    expect(a.termsRejected).toBe(3);
  });
});

describe('malformed rows', () => {
  const good = onDemand(10);
  const cases: Array<[string, unknown, string]> = [
    ['null', null, 'not_an_object'],
    ['array', [], 'not_an_object'],
    ['bad start', { ...good, ChargePeriodStart: 'yesterday' }, 'invalid_charge_period'],
    ['end before start', { ...good, ChargePeriodEnd: T0 }, 'invalid_charge_period'],
    ['lowercase currency', { ...good, BillingCurrency: 'usd' }, 'invalid_currency'],
    ['missing service', { ...good, ServiceName: '' }, 'invalid_field'],
    ['huge service', { ...good, ServiceName: 'x'.repeat(257) }, 'invalid_field'],
    ['bad charge category', { ...good, ChargeCategory: 'usage' }, 'unknown_charge_category'],
    ['bad frequency', { ...good, ChargeFrequency: 'Hourly' }, 'unknown_enum_value'],
    ['bad pricing', { ...good, PricingCategory: 'Spot' }, 'unknown_enum_value'],
    ['missing pricing', { ...good, PricingCategory: null }, 'missing_pricing_category'],
    ['id without status', { ...good, CommitmentDiscountId: 'c' }, 'inconsistent_commitment_fields'],
    ['committed without id', { ...good, PricingCategory: 'Committed' }, 'inconsistent_commitment_fields'],
    ['used with standard pricing', used('c', 5, 5, { PricingCategory: 'Standard' }), 'inconsistent_pricing_category'],
    ['NaN basis', { ...good, ContractedCost: NaN }, 'invalid_amount'],
    ['Infinity basis', { ...good, ContractedCost: Infinity }, 'invalid_amount'],
    ['string basis', { ...good, ContractedCost: '10' }, 'invalid_amount'],
    ['absurd basis', { ...good, ContractedCost: 1e13 }, 'invalid_amount'],
    ['negative basis', { ...good, ContractedCost: -1 }, 'negative_amount'],
    ['used negative effective', used('c', 5, -1), 'negative_amount'],
    ['unused NaN', unused('c', NaN), 'invalid_amount'],
    ['purchase missing billed', purchase('c', 5, { BilledCost: undefined }), 'invalid_amount'],
  ];
  for (const [name, row, code] of cases) {
    it(`rejects ${name} as ${code}; batch survives`, () => {
      const a = analyzeCommitments([good, row as CommitmentFocusRow, good], win(30));
      expect(a.rows.rejectedByReason).toEqual({ [code]: 1 });
      expect(a.rows.analyzed).toBe(2);
      expect(a.currencies[0].totals.onDemandBasisMinor).toBe(B(2000));
    });
  }
  it('accounts for every row', () => {
    const a = analyzeCommitments([good, null, onDemand(1, { ChargeCategory: 'Tax' }), onDemand(1, { ChargePeriodStart: iso(T0_MS - DAY), ChargePeriodEnd: null }), used('c', 5, 3)] as CommitmentFocusRow[], win(30));
    expect(a.rows).toMatchObject({ received: 5, analyzed: 2, ignored: 1, rejected: 1, outOfWindow: 1 });
  });
  it('hostile getter neither throws nor leaks', () => {
    const hostile = { get ChargePeriodStart(): string { throw new Error('SECRET-MARKER-123'); } };
    const a = analyzeCommitments([hostile as unknown as CommitmentFocusRow, good], win(30));
    expect(a.rows.rejected).toBe(1);
    expect(JSON.stringify(toJsonSafe(a))).not.toContain('SECRET-MARKER-123');
  });
  it('ignores inherited properties', () => {
    const row = Object.create({ ChargePeriodStart: T0 }) as CommitmentFocusRow;
    expect(analyzeCommitments([row], win(30)).rows.rejectedByReason).toEqual({ invalid_charge_period: 1 });
  });
});

describe('caps and fixed errors', () => {
  it('row cap and one past', () => {
    const rows = new Array<CommitmentFocusRow>(MAX_COMMITMENT_ROWS).fill(onDemand(1));
    expect(analyzeCommitments(rows, win(30)).rows.analyzed).toBe(MAX_COMMITMENT_ROWS);
    rows.push(onDemand(1));
    expect(() => analyzeCommitments(rows, win(30))).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.TOO_MANY_ROWS);
  });
  it('term cap and one past', () => {
    const terms = Array.from({ length: MAX_TERMS }, (_, i) => ({ commitmentId: `c${i}`, termEnd: iso(T0_MS + 90 * DAY) }));
    expect(analyzeCommitments([], win(30), { terms }).termsRejected).toBe(0);
    expect(() => analyzeCommitments([], win(30), { terms: [...terms, terms[0]] })).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.TOO_MANY_TERMS);
  });
  it('window cap and one past', () => {
    expect(() => analyzeCommitments([], win(MAX_WINDOW_DAYS))).not.toThrow();
    expect(() => analyzeCommitments([], win(MAX_WINDOW_DAYS + 1))).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.WINDOW_TOO_LONG);
  });
  for (const w of [null, {}, { start: T0 }, { start: 'nope', end: T0 }, { start: T0, end: T0 }, { start: 5, end: 6 }]) {
    it(`bad window ${JSON.stringify(w)}`, () => {
      expect(() => analyzeCommitments([], w as never)).toThrow(RECOMMEND_INPUT_ERROR_MESSAGES.INVALID_WINDOW);
    });
  }
  it('errors never echo input', () => {
    for (const run of [
      () => analyzeCommitments([], { start: 'SECRET-MARKER-123', end: T0 }),
      () => analyzeCommitments([], win(30), { costBasis: 'SECRET-MARKER-123' as never }),
      () => analyzeCommitments([], win(30), { asOf: 'SECRET-MARKER-123' }),
      () => analyzeCommitments('SECRET-MARKER-123' as never, win(30)),
      () => analyzeCommitments([], win(30), { expiringWithinDays: 0 }),
      () => analyzeCommitments([], win(30), { expiringWithinDays: 366 }),
      () => analyzeCommitments([], win(30), { terms: 'SECRET-MARKER-123' as never }),
      () => analyzeCommitments([], win(30), null as never),
    ]) {
      let msg = '';
      try { run(); } catch (e) { expect(e).toBeInstanceOf(RecommendInputError); msg = (e as Error).message; }
      expect(msg).not.toBe('');
      expect(msg).not.toContain('SECRET-MARKER-123');
    }
  });
});

describe('eligible series', () => {
  it('hourly', () => {
    const s = usd(hourlyOnDemand(2, (h) => (h < 24 ? 1 : 2)), 2).families[0].series;
    expect(s).toMatchObject({ granularity: 'hour', bucketHours: 1, bucketCount: 48, observedDays: 2, windowDays: 2 });
    expect(s.points[0].onDemandMinor).toBe(B(100));
    expect(s.points[47].onDemandMinor).toBe(B(200));
  });
  it('sub-hourly rows sum into an hour', () => {
    const rows = [0, 15, 30, 45].map((m) => onDemand(1, { ChargePeriodStart: iso(T0_MS + m * 60000), ChargePeriodEnd: iso(T0_MS + (m + 15) * 60000) }));
    expect(usd(rows, 1).families[0].series.points).toEqual([{ index: 0, coveredMinor: B(0), onDemandMinor: B(400) }]);
  });
  it('daily and coarse', () => {
    expect(usd(dailyOnDemand(3, () => 1), 3).families[0].series).toMatchObject({ granularity: 'day', bucketCount: 3 });
    const coarse = usd([onDemand(1, { ChargePeriodEnd: iso(T0_MS + 2 * DAY) })], 3).families[0];
    expect(coarse.series.granularity).toBe('coarse');
    expect(coarse.flags).toContain('coarse_granularity');
    const noEnd = onDemand(1);
    delete noEnd.ChargePeriodEnd;
    expect(usd([noEnd], 3).families[0].series.granularity).toBe('coarse');
  });
  it('covered and on-demand share a bucket; observed days sparse', () => {
    expect(usd([onDemand(1), used('sp', 2, 1)], 1).families[0].series.points).toEqual([{ index: 0, coveredMinor: B(200), onDemandMinor: B(100) }]);
    expect(usd(dailyOnDemand(10, () => 1).filter((_, i) => i % 2 === 0), 10).families[0].series.observedDays).toBe(5);
  });
});

describe('determinism and reconciliation', () => {
  function randomRows(seed: number, n: number): CommitmentFocusRow[] {
    const rnd = lcg(seed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
    const rows: CommitmentFocusRow[] = [];
    for (let i = 0; i < n; i++) {
      const startMs = T0_MS + Math.floor(rnd() * 30) * DAY + Math.floor(rnd() * 24) * 3600000;
      const common = {
        ChargePeriodStart: iso(startMs), ChargePeriodEnd: iso(startMs + 3600000),
        BillingCurrency: pick(['USD', 'EUR', 'JPY']), ServiceName: pick(['Compute', 'Database', 'Functions']),
      };
      const cost = Math.round(rnd() * 100000) / 100;
      const k = Math.floor(rnd() * 3);
      const id = pick(['sp-a', 'sp-b', 'ri-c']);
      rows.push(k === 0 ? onDemand(cost, common) : k === 1 ? used(id, cost * 1.5, cost, common) : unused(id, cost, common));
    }
    return rows;
  }
  it('reconciles on random inputs', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = analyzeCommitments(randomRows(seed, 400), win(30));
      for (const c of a.currencies) {
        const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, B(0));
        expect(sum(c.families.map((f) => f.usedCostMinor))).toBe(c.totals.usedCostMinor);
        expect(sum(c.commitments.map((x) => x.unusedCostMinor))).toBe(c.totals.unusedCostMinor);
        expect(sum(c.cells.map((x) => x.coveredBasisMinor))).toBe(c.totals.coveredBasisMinor);
        expect(c.totals.eligibleBasisMinor).toBe(c.totals.coveredBasisMinor + c.totals.onDemandBasisMinor);
        expect(c.totals.coveragePct ?? 0).toBeLessThanOrEqual(100);
        for (const f of c.families) expect(f.flags).not.toContain('over_100_clamped');
      }
      const r = a.rows;
      expect(r.analyzed + r.ignored + r.rejected + r.outOfWindow).toBe(r.received);
    }
  });
  it('is order independent and serializable via toJsonSafe', () => {
    const rows = randomRows(9, 300);
    const shuffled = [...rows];
    const rnd = lcg(77);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const a = analyzeCommitments(rows, win(30));
    expect(a.rows.analyzed).toBeGreaterThan(250);
    expect(toJsonSafe(a)).toEqual(toJsonSafe(analyzeCommitments(shuffled, win(30))));
    expect(() => JSON.stringify(a)).toThrow();
    expect(() => JSON.stringify(toJsonSafe(a))).not.toThrow();
    expect(a.definitions.coverage).toContain('floored');
  });
});
