// Conservative commitment purchase suggestion (checklist item 4.3, payback part).
//
// Pure and deterministic. The caller supplies the discount rate: NO vendor price,
// discount or term table exists in this module, and none is assumed. The result
// always carries the assumptions it used, and a refusal carries them too.
//
// Method (all integer arithmetic on minor units; percentages in basis points):
//   1. Take the family's ON-DEMAND-priced eligible usage per bucket (hour or day,
//      from analyzeCommitments). Buckets with no data are ZERO-FILLED, which can
//      only lower the floor (conservative).
//   2. Floor = the p-th percentile (nearest rank, default p = 10) of that series,
//      converted to a per-hour rate, then reduced by the safety margin.
//   3. Cap the suggestion so projected coverage stays at or under the coverage
//      target (default 80 percent).
//   4. Commitment per hour C = F x (1 - discount), rounded UP; savings figures are
//      rounded DOWN. Term total TC = C x term hours (730 hours per month).
//   5. Backtested utilization u = sum over buckets of min(usage, F) / (F x buckets).
//      This replays the SAME history the floor came from, so it is in-sample.
//   6. Break-even utilization = 1 - discount: below it the commitment costs more
//      than the on-demand usage it displaces.
//   7. Payback: cash out U up front (rounded up) plus R per month (rounded up);
//      each month displaces A = F x 730 x u of on-demand cost. Payback months =
//      U / (A - R), rounded UP to hundredths; no up-front payment pays back at 0.
//   8. Risk label from a documented point score (headroom plus aggravating
//      factors); see riskFor below.
//
// Refusals (decision 'refused', fixed reason code): invalid coverage input,
// invalid options, insufficient history (fewer than MIN_HISTORY_DAYS observed
// days, or under MIN_COMPLETENESS_PCT of the window), coarse granularity, existing
// commitments under-utilized, coverage already at target, no steady-state usage,
// and a discount too small to beat the break-even.
//
// Known limits (also in README.md): no growth or decline is modeled (flat
// extrapolation); expiring commitments are not netted out; payment-option
// economics come ONLY from the caller's discount for that option and term.

import { HOURS_PER_MONTH, type FamilyCoverageReport } from './commitments';
import { BPS, ZERO, ceilDiv, isCurrencyCode, minBig, percentFloor } from './money';
import { isRecord, own } from './validate';

const HOURS_PER_MONTH_BIG = BigInt(HOURS_PER_MONTH);

export const MIN_HISTORY_DAYS = 30;
export const MIN_COMPLETENESS_PCT = 80;
export const MAX_SERIES_BUCKETS = 9_600;
export const DEFAULT_FLOOR_PERCENTILE = 10;
export const DEFAULT_SAFETY_MARGIN_PCT = 10;
export const DEFAULT_COVERAGE_TARGET_PCT = 80;
export const DEFAULT_MIN_EXISTING_UTILIZATION_PCT = 90;

export type PaymentOption = 'no_upfront' | 'partial_upfront' | 'all_upfront';

export interface PurchaseOptions {
  /** Caller-supplied discount versus the on-demand equivalent, percent in (0, 100), for THIS term and payment option. Required. */
  discountRatePct: number;
  /** Whole months, 1 to 60. Required. */
  termMonths: number;
  paymentOption: PaymentOption;
  /** Share of the term cost paid up front, percent in (0, 100). Required for partial_upfront, forbidden otherwise. */
  partialUpfrontPct?: number;
  /** Percentile of the on-demand series used as the floor, 1 to 50. Default 10. */
  floorPercentile?: number;
  /** Haircut applied to the floor, 0 to 50 percent. Default 10. */
  safetyMarginPct?: number;
  /** Do not suggest more than reaches this coverage, 1 to 100 percent. Default 80. */
  coverageTargetPct?: number;
  /** Refuse when the family's existing commitments are used less than this, 0 to 100 percent. Default 90. */
  minExistingUtilizationPct?: number;
}

export type RefusalReason =
  | 'invalid_coverage_input'
  | 'invalid_options'
  | 'insufficient_history'
  | 'coarse_granularity'
  | 'existing_underutilized'
  | 'coverage_at_target'
  | 'no_steady_state_usage'
  | 'discount_not_economic';

export const REFUSAL_REASON_MESSAGES: Readonly<Record<RefusalReason, string>> = {
  invalid_coverage_input: 'coverage input is malformed or reports coverage outside 0 to 100 percent',
  invalid_options: 'purchase options are missing or out of range',
  insufficient_history: 'not enough observed history to size a commitment',
  coarse_granularity: 'usage rows are longer than one day, so a steady-state floor cannot be measured',
  existing_underutilized: 'existing commitments for this family are under-utilized; fix them before buying more',
  coverage_at_target: 'coverage is already at or above the target',
  no_steady_state_usage: 'no steady on-demand usage remains to commit against',
  discount_not_economic: 'the supplied discount does not beat break-even at the backtested utilization',
};

export interface PurchaseAssumptions {
  /** Statements the reader must be able to see next to any number below. */
  statements: string[];
  lookbackDays: number | null;
  observedDays: number | null;
  minHistoryDays: number;
  minCompletenessPct: number;
  granularity: 'hour' | 'day' | 'coarse' | null;
  floorStatistic: string;
  floorPercentile: number | null;
  safetyMarginPct: number | null;
  coverageTargetPct: number | null;
  minExistingUtilizationPct: number | null;
  discountRatePct: number | null;
  discountSource: 'caller_supplied';
  termMonths: number | null;
  paymentOption: PaymentOption | null;
  upfrontPct: number | null;
  hoursPerMonth: number;
  missingBuckets: 'zero_filled';
  growth: 'none';
}

export type PurchaseRisk = 'low' | 'medium' | 'high';
export type PurchaseRiskFactor = 'floor_volatile' | 'intraday_unobserved' | 'short_history' | 'long_term';

export interface PurchaseRecommendation {
  decision: 'recommend';
  family: string;
  currency: string;
  /** Hourly commitment in discounted (committed) dollars, minor units, rounded up. */
  commitmentPerHourMinor: bigint;
  /** On-demand-equivalent usage that commitment covers per hour, minor units. */
  onDemandEquivalentPerHourMinor: bigint;
  limitedBy: 'steady_state_floor' | 'coverage_target';
  termMonths: number;
  paymentOption: PaymentOption;
  /** Total obligation over the term, minor units. This is the amount at risk if usage disappears. */
  termCommitmentMinor: bigint;
  upfrontMinor: bigint;
  recurringMonthlyMinor: bigint;
  /** Months until cumulative displaced on-demand cost covers cash out. null = never. 0 with no up-front payment. */
  paybackMonths: number | null;
  paybackWithinTerm: boolean;
  /** Utilization below which the commitment loses money, percent. Equals 100 minus the discount. */
  breakEvenUtilizationPct: number;
  /** In-sample utilization from replaying the lookback, percent (floored). */
  backtestedUtilizationPct: number;
  expectedNetSavingsTermMinor: bigint;
  currentCoveragePct: number | null;
  projectedCoveragePct: number | null;
  risk: PurchaseRisk;
  riskFactors: PurchaseRiskFactor[];
  assumptions: PurchaseAssumptions;
}

export interface PurchaseRefusal {
  decision: 'refused';
  reason: RefusalReason;
  message: string;
  /** The offending option name when reason is invalid_options; otherwise null. */
  field: string | null;
  assumptions: PurchaseAssumptions;
}

export type PurchaseDecision = PurchaseRecommendation | PurchaseRefusal;

// --- helpers -----------------------------------------------------------------

function toBps(pct: number): number {
  return Math.round(pct * 100);
}

function numberIn(
  v: unknown,
  lo: number,
  hi: number,
  inclusiveLo: boolean,
  inclusiveHi: boolean,
): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (inclusiveLo ? v < lo : v <= lo) return null;
  if (inclusiveHi ? v > hi : v >= hi) return null;
  return v;
}

interface ValidOptions {
  discountBps: number;
  termMonths: number;
  paymentOption: PaymentOption;
  upfrontBps: number;
  floorPercentile: number;
  safetyBps: number;
  targetBps: number;
  minUtilBps: number;
}

function validateOptions(o: unknown): { ok: true; value: ValidOptions } | { ok: false; field: string } {
  if (!isRecord(o)) return { ok: false, field: 'options' };
  const discount = numberIn(own(o, 'discountRatePct'), 0, 100, false, false);
  if (discount === null || toBps(discount) < 1 || toBps(discount) > 9999) return { ok: false, field: 'discountRatePct' };
  const term = own(o, 'termMonths');
  if (typeof term !== 'number' || !Number.isInteger(term) || term < 1 || term > 60) return { ok: false, field: 'termMonths' };
  const payment = own(o, 'paymentOption');
  if (payment !== 'no_upfront' && payment !== 'partial_upfront' && payment !== 'all_upfront') {
    return { ok: false, field: 'paymentOption' };
  }
  const partial = own(o, 'partialUpfrontPct');
  let upfrontBps: number;
  if (payment === 'partial_upfront') {
    const p = numberIn(partial, 0, 100, false, false);
    if (p === null || toBps(p) < 1 || toBps(p) > 9999) return { ok: false, field: 'partialUpfrontPct' };
    upfrontBps = toBps(p);
  } else {
    if (partial !== undefined) return { ok: false, field: 'partialUpfrontPct' };
    upfrontBps = payment === 'all_upfront' ? 10000 : 0;
  }
  const pctl = own(o, 'floorPercentile') ?? DEFAULT_FLOOR_PERCENTILE;
  const pctlN = numberIn(pctl, 1, 50, true, true);
  if (pctlN === null) return { ok: false, field: 'floorPercentile' };
  const safety = numberIn(own(o, 'safetyMarginPct') ?? DEFAULT_SAFETY_MARGIN_PCT, 0, 50, true, true);
  if (safety === null) return { ok: false, field: 'safetyMarginPct' };
  const target = numberIn(own(o, 'coverageTargetPct') ?? DEFAULT_COVERAGE_TARGET_PCT, 1, 100, true, true);
  if (target === null) return { ok: false, field: 'coverageTargetPct' };
  const minUtil = numberIn(
    own(o, 'minExistingUtilizationPct') ?? DEFAULT_MIN_EXISTING_UTILIZATION_PCT, 0, 100, true, true,
  );
  if (minUtil === null) return { ok: false, field: 'minExistingUtilizationPct' };
  return {
    ok: true,
    value: {
      discountBps: toBps(discount),
      termMonths: term,
      paymentOption: payment,
      upfrontBps,
      floorPercentile: pctlN,
      safetyBps: toBps(safety),
      targetBps: toBps(target),
      minUtilBps: toBps(minUtil),
    },
  };
}

/** Structural check of a FamilyCoverageReport; any doubt means invalid (deny by default). */
export function isFamilyCoverage(x: unknown): x is FamilyCoverageReport {
  if (!isRecord(x)) return false;
  if (typeof own(x, 'family') !== 'string' || !isCurrencyCode(own(x, 'currency'))) return false;
  for (const k of ['coveredBasisMinor', 'onDemandBasisMinor', 'usedCostMinor', 'unusedCostMinor']) {
    const v = own(x, k);
    if (typeof v !== 'bigint' || v < ZERO) return false;
  }
  for (const k of ['coveragePct', 'utilizationPct']) {
    const v = own(x, k);
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) return false;
  }
  const s = own(x, 'series');
  if (!isRecord(s)) return false;
  const g = own(s, 'granularity');
  if (g !== 'hour' && g !== 'day' && g !== 'coarse') return false;
  const bucketCount = own(s, 'bucketCount');
  const bucketHours = own(s, 'bucketHours');
  const observedDays = own(s, 'observedDays');
  const windowDays = own(s, 'windowDays');
  if (
    typeof bucketCount !== 'number' || !Number.isInteger(bucketCount) || bucketCount < 0 || bucketCount > MAX_SERIES_BUCKETS ||
    typeof bucketHours !== 'number' || !Number.isInteger(bucketHours) || bucketHours < 0 ||
    typeof observedDays !== 'number' || !Number.isInteger(observedDays) || observedDays < 0 ||
    typeof windowDays !== 'number' || !Number.isInteger(windowDays) || windowDays < 1
  ) {
    return false;
  }
  if (g === 'hour' && bucketHours !== 1) return false;
  if (g === 'day' && bucketHours !== 24) return false;
  const points = own(s, 'points');
  if (!Array.isArray(points) || points.length > bucketCount) return false;
  const seen = new Set<number>();
  for (const p of points) {
    if (!isRecord(p)) return false;
    const idx = own(p, 'index');
    const cv = own(p, 'coveredMinor');
    const od = own(p, 'onDemandMinor');
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= bucketCount || seen.has(idx)) return false;
    if (typeof cv !== 'bigint' || cv < ZERO || typeof od !== 'bigint' || od < ZERO) return false;
    seen.add(idx);
  }
  return true;
}

/** Nearest-rank percentile of an ascending-sorted list; pBps is the percentile in basis points (1 to 10000). */
export function nearestRank(sortedAsc: readonly bigint[], pBps: number): bigint {
  const n = sortedAsc.length;
  if (n === 0) return ZERO;
  let rank = Math.floor((pBps * n + 9999) / 10000);
  if (rank < 1) rank = 1;
  if (rank > n) rank = n;
  return sortedAsc[rank - 1];
}

export const RISK_FACTOR_POINTS: Readonly<Record<PurchaseRiskFactor, number>> = {
  floor_volatile: 2,
  intraday_unobserved: 1,
  short_history: 1,
  long_term: 1,
};

/**
 * Risk label from a point score (documented so it can be audited and changed).
 *   Headroom = backtested utilization minus break-even, in basis points:
 *     under 500 adds 4 points, under 1500 adds 2, otherwise 0.
 *   Factors add points: floor_volatile 2 (the floor is under half the median
 *     bucket), intraday_unobserved 1 (only daily rows, so hourly troughs are
 *     hidden), short_history 1 (under 60 observed days), long_term 1 (term of
 *     36 months or more).
 *   Label: 0 or 1 point is low, 2 or 3 is medium, 4 or more is high.
 */
export function riskFor(headroomBps: number, factors: readonly PurchaseRiskFactor[]): PurchaseRisk {
  let points = headroomBps < 500 ? 4 : headroomBps < 1500 ? 2 : 0;
  for (const f of factors) points += RISK_FACTOR_POINTS[f];
  return points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low';
}

function buildAssumptions(
  cov: FamilyCoverageReport | null,
  o: ValidOptions | null,
  raw: unknown,
): PurchaseAssumptions {
  const rawRec = isRecord(raw) ? raw : null;
  const num = (k: string): number | null => {
    const v = rawRec ? own(rawRec, k) : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const series = cov?.series ?? null;
  const floorPct = o ? o.floorPercentile : null;
  const safety = o ? o.safetyBps / 100 : null;
  const statements = [
    'Discount rate is supplied by the caller for the chosen term and payment option; no vendor price or discount is built in.',
    `Floor is the nearest-rank percentile ${floorPct ?? DEFAULT_FLOOR_PERCENTILE} of on-demand-priced eligible usage per ${series && series.granularity === 'day' ? 'day (converted to an hourly average)' : 'hour'}, reduced by the safety margin.`,
    'Buckets with no data are treated as zero usage, which can only lower the floor.',
    `History must cover at least ${MIN_HISTORY_DAYS} observed days and ${MIN_COMPLETENESS_PCT} percent of the window.`,
    'Future usage is assumed to equal the lookback: no growth, decline, migration or seasonality is modeled.',
    'Backtested utilization replays the same history the floor came from, so it is in-sample and optimistic.',
    `A month is ${HOURS_PER_MONTH} hours.`,
    'Existing commitments that expire are not netted out; renew them separately.',
  ];
  return {
    statements,
    lookbackDays: series ? series.windowDays : null,
    observedDays: series ? series.observedDays : null,
    minHistoryDays: MIN_HISTORY_DAYS,
    minCompletenessPct: MIN_COMPLETENESS_PCT,
    granularity: series ? series.granularity : null,
    floorStatistic: 'nearest-rank percentile of on-demand-priced eligible usage',
    floorPercentile: floorPct,
    safetyMarginPct: safety,
    coverageTargetPct: o ? o.targetBps / 100 : null,
    minExistingUtilizationPct: o ? o.minUtilBps / 100 : null,
    discountRatePct: o ? o.discountBps / 100 : num('discountRatePct'),
    discountSource: 'caller_supplied',
    termMonths: o ? o.termMonths : null,
    paymentOption: o ? o.paymentOption : null,
    upfrontPct: o ? o.upfrontBps / 100 : null,
    hoursPerMonth: Number(HOURS_PER_MONTH_BIG),
    missingBuckets: 'zero_filled',
    growth: 'none',
  };
}

function refuse(
  reason: RefusalReason,
  assumptions: PurchaseAssumptions,
  field: string | null = null,
): PurchaseRefusal {
  return { decision: 'refused', reason, message: REFUSAL_REASON_MESSAGES[reason], field, assumptions };
}

/**
 * Suggests a conservative commitment for one family, or refuses with a fixed
 * reason. Never throws for bad inputs: they become refusals so a caller can show
 * them next to the assumptions.
 */
export function recommendCommitmentPurchase(coverage: FamilyCoverageReport, options: PurchaseOptions): PurchaseDecision {
  const validCoverage = isFamilyCoverage(coverage);
  const opts = validateOptions(options);
  const assumptions = buildAssumptions(validCoverage ? coverage : null, opts.ok ? opts.value : null, options);
  if (!validCoverage) return refuse('invalid_coverage_input', assumptions);
  if (!opts.ok) return refuse('invalid_options', assumptions, opts.field);
  const o = opts.value;
  const series = coverage.series;

  if (series.granularity === 'coarse') return refuse('coarse_granularity', assumptions);
  if (
    series.observedDays < MIN_HISTORY_DAYS ||
    series.observedDays * 100 < series.windowDays * MIN_COMPLETENESS_PCT
  ) {
    return refuse('insufficient_history', assumptions);
  }
  if (coverage.utilizationPct !== null && coverage.utilizationPct * 100 < o.minUtilBps) {
    return refuse('existing_underutilized', assumptions);
  }
  if (coverage.coveragePct !== null && coverage.coveragePct * 100 >= o.targetBps) {
    return refuse('coverage_at_target', assumptions);
  }

  // Dense, zero-filled on-demand series.
  const n = series.bucketCount;
  const dense: bigint[] = new Array<bigint>(n).fill(ZERO);
  for (const p of series.points) dense[p.index] = p.onDemandMinor;
  const sorted = [...dense].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bucketHours = BigInt(series.bucketHours);

  const floorBucket = nearestRank(sorted, toBps(o.floorPercentile));
  const medianBucket = nearestRank(sorted, 5000);
  const floorPerHour = floorBucket / bucketHours;
  if (floorPerHour === ZERO) return refuse('no_steady_state_usage', assumptions);

  // Safety margin, then the coverage-target cap.
  let f = (floorPerHour * BigInt(10000 - o.safetyBps)) / BPS;
  let limitedBy: 'steady_state_floor' | 'coverage_target' = 'steady_state_floor';
  const eligible = coverage.coveredBasisMinor + coverage.onDemandBasisMinor;
  const windowHours = BigInt(n) * bucketHours;
  const headroom = (BigInt(o.targetBps) * eligible) / BPS - coverage.coveredBasisMinor;
  if (headroom <= ZERO) return refuse('coverage_at_target', assumptions);
  const cap = headroom / windowHours;
  if (cap < f) {
    f = cap;
    limitedBy = 'coverage_target';
  }
  if (f === ZERO) return refuse(limitedBy === 'coverage_target' ? 'coverage_at_target' : 'no_steady_state_usage', assumptions);

  const commitPerHour = ceilDiv(f * BigInt(10000 - o.discountBps), BPS);
  if (commitPerHour === ZERO) return refuse('no_steady_state_usage', assumptions);

  // Backtest: usage the commitment would have absorbed, bucket by bucket.
  const fBucket = f * bucketHours;
  let absorbed = ZERO;
  for (const v of dense) absorbed += minBig(v, fBucket);
  const utilization = percentFloor(absorbed, fBucket * BigInt(n));
  const uBps = utilization ? utilization.bps : 0;
  const breakEvenBps = 10000 - o.discountBps;
  if (uBps <= breakEvenBps) return refuse('discount_not_economic', assumptions);

  // Cash flows.
  const termMonths = BigInt(o.termMonths);
  const termHours = termMonths * HOURS_PER_MONTH_BIG;
  const termCost = commitPerHour * termHours;
  const upfront = ceilDiv(termCost * BigInt(o.upfrontBps), BPS);
  const recurringTotal = termCost - upfront;
  const recurringMonthly = recurringTotal === ZERO ? ZERO : ceilDiv(recurringTotal, termMonths);
  const displacedMonthly = (f * HOURS_PER_MONTH_BIG * BigInt(uBps)) / BPS;
  const netMonthly = displacedMonthly - recurringMonthly;

  let paybackMonths: number | null;
  let paybackWithinTerm: boolean;
  if (upfront === ZERO) {
    paybackMonths = 0;
    paybackWithinTerm = true;
  } else if (netMonthly <= ZERO) {
    paybackMonths = null;
    paybackWithinTerm = false;
  } else {
    const x100 = ceilDiv(upfront * BigInt(100), netMonthly);
    paybackMonths = Number(x100) / 100;
    paybackWithinTerm = x100 <= termMonths * BigInt(100);
  }

  // Coverage after the purchase: what the replay says the commitment would absorb.
  const projected = percentFloor(coverage.coveredBasisMinor + absorbed, eligible);

  // Risk.
  const factors: PurchaseRiskFactor[] = [];
  if (medianBucket > ZERO && floorBucket * BigInt(2) < medianBucket) factors.push('floor_volatile');
  if (series.granularity === 'day') factors.push('intraday_unobserved');
  if (series.observedDays < 60) factors.push('short_history');
  if (o.termMonths >= 36) factors.push('long_term');

  return {
    decision: 'recommend',
    family: coverage.family,
    currency: coverage.currency,
    commitmentPerHourMinor: commitPerHour,
    onDemandEquivalentPerHourMinor: f,
    limitedBy,
    termMonths: o.termMonths,
    paymentOption: o.paymentOption,
    termCommitmentMinor: termCost,
    upfrontMinor: upfront,
    recurringMonthlyMinor: recurringMonthly,
    paybackMonths,
    paybackWithinTerm,
    breakEvenUtilizationPct: breakEvenBps / 100,
    backtestedUtilizationPct: uBps / 100,
    expectedNetSavingsTermMinor: displacedMonthly * termMonths - termCost,
    currentCoveragePct: coverage.coveragePct,
    projectedCoveragePct: projected ? projected.pct : null,
    risk: riskFor(uBps - breakEvenBps, factors),
    riskFactors: factors,
    assumptions,
  };
}
