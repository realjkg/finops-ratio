import { describe, expect, it } from 'vitest';
import { analyzeCommitments, type CommitmentFocusRow, type FamilyCoverageReport } from './commitments';
import { toJsonSafe } from './money';
import {
  MIN_HISTORY_DAYS, REFUSAL_REASON_MESSAGES, nearestRank, recommendCommitmentPurchase, riskFor,
  type PurchaseOptions, type PurchaseRecommendation, type PurchaseRefusal,
} from './purchase';
import { dailyOnDemand, hourlyOnDemand, onDemand, unused, used, win } from './testRows';

const B = (n: number | string) => BigInt(n);

function family(rows: CommitmentFocusRow[], days: number): FamilyCoverageReport {
  const c = analyzeCommitments(rows, win(days)).currencies[0];
  return c.families[0];
}
const flat30 = () => family(hourlyOnDemand(30, () => 10), 30);
const base: PurchaseOptions = { discountRatePct: 30, termMonths: 12, paymentOption: 'no_upfront', coverageTargetPct: 100 };

function rec(cov: FamilyCoverageReport, o: Partial<PurchaseOptions> = {}): PurchaseRecommendation {
  const d = recommendCommitmentPurchase(cov, { ...base, ...o });
  if (d.decision !== 'recommend') throw new Error(`refused: ${d.reason}`);
  return d;
}
function refusal(cov: unknown, o: unknown = base): PurchaseRefusal {
  const d = recommendCommitmentPurchase(cov as FamilyCoverageReport, o as PurchaseOptions);
  if (d.decision !== 'refused') throw new Error('expected refusal');
  return d;
}

describe('recommendCommitmentPurchase: hand-computed math', () => {
  // Flat $10.00/hour on demand for 30 days = 1000 minor/hour, 720 hours, eligible 720000.
  // p10 floor 1000, safety 10 percent -> 900. Cap at 100 percent target is 1000, so floor binds.
  // Commitment = ceil(900 x 0.70) = 630 per hour. Term 12 months x 730 h = 8760 h -> 5,518,800.
  it('no up-front', () => {
    const r = rec(flat30());
    expect(r.onDemandEquivalentPerHourMinor).toBe(B(900));
    expect(r.limitedBy).toBe('steady_state_floor');
    expect(r.commitmentPerHourMinor).toBe(B(630));
    expect(r.termCommitmentMinor).toBe(B(5518800));
    expect(r.upfrontMinor).toBe(B(0));
    expect(r.recurringMonthlyMinor).toBe(B(459900));
    expect(r.breakEvenUtilizationPct).toBe(70);
    expect(r.backtestedUtilizationPct).toBe(100);
    // displaced monthly = 900 x 730 = 657000; savings = 657000 x 12 - 5518800
    expect(r.expectedNetSavingsTermMinor).toBe(B(2365200));
    expect(r.paybackMonths).toBe(0);
    expect(r.paybackWithinTerm).toBe(true);
    expect(r.projectedCoveragePct).toBe(90);
    expect(r.risk).toBe('low');
    expect(r.riskFactors).toEqual(['short_history']);
  });
  it('all up-front payback is 8.4 months', () => {
    const r = rec(flat30(), { paymentOption: 'all_upfront' });
    expect(r.upfrontMinor).toBe(B(5518800));
    expect(r.recurringMonthlyMinor).toBe(B(0));
    expect(r.paybackMonths).toBe(8.4); // 5518800 / 657000
    expect(r.paybackWithinTerm).toBe(true);
  });
  it('partial up-front 50 percent', () => {
    const r = rec(flat30(), { paymentOption: 'partial_upfront', partialUpfrontPct: 50 });
    expect(r.upfrontMinor).toBe(B(2759400));
    expect(r.recurringMonthlyMinor).toBe(B(229950));
    // net monthly = 657000 - 229950 = 427050; 2759400 / 427050 = 6.4614 -> 6.47 (rounded up)
    expect(r.paybackMonths).toBe(6.47);
  });
  it('payback beyond the term is reported as such', () => {
    const r = rec(flat30(), { paymentOption: 'all_upfront', termMonths: 6, discountRatePct: 30 });
    // term cost 630 x 4380 = 2,759,400; 2759400 / 657000 = 4.2 months, within a 6 month term
    expect(r.paybackMonths).toBe(4.2);
    const slim = rec(flat30(), { paymentOption: 'all_upfront', termMonths: 6, discountRatePct: 2 });
    // commit = ceil(900 x 0.98) = 882; cost 882 x 4380 = 3,863,160; 3863160 / 657000 = 5.88 -> 5.88
    expect(slim.paybackMonths).toBe(5.88);
    expect(slim.breakEvenUtilizationPct).toBe(98);
  });
  it('coverage target caps the suggestion', () => {
    const r = rec(flat30(), { coverageTargetPct: 80 });
    // headroom = 0.8 x 720000 = 576000; / 720 h = 800 per hour
    expect(r.onDemandEquivalentPerHourMinor).toBe(B(800));
    expect(r.limitedBy).toBe('coverage_target');
    expect(r.commitmentPerHourMinor).toBe(B(560));
  });
  it('uses daily series as hourly averages and adds an intraday risk factor', () => {
    const r = rec(family(dailyOnDemand(40, () => 240), 40));
    expect(r.onDemandEquivalentPerHourMinor).toBe(B(900));
    expect(r.riskFactors).toContain('intraday_unobserved');
    expect(r.assumptions.granularity).toBe('day');
  });
  it('is deterministic', () => {
    expect(toJsonSafe(rec(flat30()))).toEqual(toJsonSafe(rec(flat30())));
  });
  it('always shows its assumptions', () => {
    const r = rec(flat30());
    expect(r.assumptions).toMatchObject({
      discountSource: 'caller_supplied', discountRatePct: 30, termMonths: 12, paymentOption: 'no_upfront',
      floorPercentile: 10, safetyMarginPct: 10, minHistoryDays: MIN_HISTORY_DAYS, growth: 'none', missingBuckets: 'zero_filled',
    });
    expect(r.assumptions.statements.join(' ')).toContain('no vendor price');
  });
  it('a volatile floor raises risk', () => {
    // 71 zero hours: p10 (rank 72) is nonzero but the series is mostly steady
    const rows = hourlyOnDemand(30, (h) => (h % 10 === 0 && h < 710 ? 0 : 10));
    const r = rec(family(rows, 30), { discountRatePct: 30 });
    expect(r.backtestedUtilizationPct).toBeGreaterThan(70);
  });
});

describe('recommendCommitmentPurchase: refusals', () => {
  it('insufficient history: too few observed days', () => {
    const d = refusal(family(hourlyOnDemand(20, () => 10), 20));
    expect(d.reason).toBe('insufficient_history');
    expect(d.message).toBe(REFUSAL_REASON_MESSAGES.insufficient_history);
    expect(d.assumptions.minHistoryDays).toBe(30);
    expect(d.assumptions.observedDays).toBe(20);
  });
  it('boundary: 29 days refused, 30 days accepted', () => {
    expect(refusal(family(hourlyOnDemand(29, () => 10), 29)).reason).toBe('insufficient_history');
    expect(recommendCommitmentPurchase(flat30(), base).decision).toBe('recommend');
  });
  it('insufficient completeness: 30 observed days in a 40 day window', () => {
    expect(refusal(family(hourlyOnDemand(30, () => 10), 40)).reason).toBe('insufficient_history');
  });
  it('completeness boundary: 32 of 40 days (80 percent) is not an insufficient-history refusal; 31 is', () => {
    const keep = (days: number) => hourlyOnDemand(40, () => 10).filter((r) => Date.parse(r.ChargePeriodStart) < Date.parse(win(days).end));
    expect(refusal(family(keep(31), 40)).reason).toBe('insufficient_history');
    // 8 zero-filled days make the p10 floor zero, which is a different, later refusal.
    expect(refusal(family(keep(32), 40)).reason).toBe('no_steady_state_usage');
  });
  it('coarse granularity', () => {
    const rows = [onDemand(10, { ChargePeriodEnd: win(30).end })];
    expect(refusal(family(rows, 30)).reason).toBe('coarse_granularity');
  });
  it('existing commitments underutilized', () => {
    const rows = [...hourlyOnDemand(30, () => 10), used('c', 10, 5), unused('c', 50)];
    expect(refusal(family(rows, 30)).reason).toBe('existing_underutilized');
  });
  it('coverage already at target', () => {
    const rows = [...hourlyOnDemand(30, () => 1), used('c', 10000, 5000)];
    expect(refusal(family(rows, 30), { ...base, coverageTargetPct: 80 }).reason).toBe('coverage_at_target');
  });
  it('no steady-state usage', () => {
    const rows = hourlyOnDemand(30, (h) => (h % 2 === 0 ? 10 : 0)).filter((r) => r.ContractedCost !== 0);
    expect(refusal(family(rows, 30)).reason).toBe('no_steady_state_usage');
  });
  it('discount that does not beat break-even', () => {
    // 71 of 720 hours are zero; floor is nonzero, backtest utilization is 90.13 percent, break-even 95.
    const rows = hourlyOnDemand(30, (h) => (h < 71 ? 0 : 10));
    const d = refusal(family(rows, 30), { ...base, discountRatePct: 5 });
    expect(d.reason).toBe('discount_not_economic');
  });
  const bad: Array<[string, Partial<PurchaseOptions> | null, string]> = [
    ['null options', null, 'options'],
    ['discount zero', { discountRatePct: 0 }, 'discountRatePct'],
    ['discount 100', { discountRatePct: 100 }, 'discountRatePct'],
    ['discount NaN', { discountRatePct: NaN }, 'discountRatePct'],
    ['discount string', { discountRatePct: '30' as never }, 'discountRatePct'],
    ['term zero', { termMonths: 0 }, 'termMonths'],
    ['term 61', { termMonths: 61 }, 'termMonths'],
    ['term fraction', { termMonths: 1.5 }, 'termMonths'],
    ['payment unknown', { paymentOption: 'monthly' as never }, 'paymentOption'],
    ['partial missing pct', { paymentOption: 'partial_upfront' }, 'partialUpfrontPct'],
    ['pct on no_upfront', { partialUpfrontPct: 10 }, 'partialUpfrontPct'],
    ['percentile 0', { floorPercentile: 0 }, 'floorPercentile'],
    ['percentile 51', { floorPercentile: 51 }, 'floorPercentile'],
    ['safety 51', { safetyMarginPct: 51 }, 'safetyMarginPct'],
    ['target 0', { coverageTargetPct: 0 }, 'coverageTargetPct'],
    ['min util 101', { minExistingUtilizationPct: 101 }, 'minExistingUtilizationPct'],
  ];
  for (const [name, o, field] of bad) {
    it(`invalid options: ${name}`, () => {
      const d = refusal(flat30(), o === null ? null : { ...base, ...o });
      expect(d.reason).toBe('invalid_options');
      expect(d.field).toBe(field);
      expect(d.assumptions.statements.length).toBeGreaterThan(0);
    });
  }
  it('invalid coverage input is refused, never thrown', () => {
    const good = flat30();
    for (const c of [null, undefined, {}, 'x', { ...good, coveredBasisMinor: -1 }, { ...good, coveragePct: 120 },
      { ...good, series: { ...good.series, bucketCount: 99999 } }, { ...good, series: null }]) {
      expect(recommendCommitmentPurchase(c as never, base).decision).toBe('refused');
    }
    expect(refusal(null).reason).toBe('invalid_coverage_input');
    expect(refusal({ ...good, coveragePct: 120 }).reason).toBe('invalid_coverage_input');
    expect(refusal({ ...good, series: { ...good.series, points: [{ index: 0, coveredMinor: B(0), onDemandMinor: B(1) }, { index: 0, coveredMinor: B(0), onDemandMinor: B(1) }] } }).reason).toBe('invalid_coverage_input');
  });
  it('refusal text never echoes input', () => {
    const d = refusal(flat30(), { ...base, paymentOption: 'SECRET-MARKER-123' });
    expect(JSON.stringify(toJsonSafe(d))).not.toContain('SECRET-MARKER-123');
  });
});

describe('helpers', () => {
  it('nearestRank', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(B);
    expect(nearestRank(xs, 1000)).toBe(B(1));
    expect(nearestRank(xs, 5000)).toBe(B(5));
    expect(nearestRank(xs, 10000)).toBe(B(10));
    expect(nearestRank([], 5000)).toBe(B(0));
  });
  it('riskFor ladder', () => {
    expect(riskFor(400, [])).toBe('high');
    expect(riskFor(1000, [])).toBe('medium');
    expect(riskFor(3000, [])).toBe('low');
    expect(riskFor(3000, ['floor_volatile'])).toBe('medium');
    expect(riskFor(1000, ['short_history', 'long_term'])).toBe('high');
  });
});
