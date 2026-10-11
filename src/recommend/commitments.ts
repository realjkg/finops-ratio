// Commitment coverage and utilization from FOCUS commitment-discount columns
// (checklist item 4.1). Pure and deterministic: no clock, no I/O, no randomness.
//
// Trust boundary: rows are untrusted until parsed here. Every field read is
// type- and range-checked; a row that is malformed or self-contradictory is
// REJECTED and counted (fixed reason codes, never echoing input); a valid row
// that is simply not relevant (tax, credit, spot pricing) is IGNORED and counted.
// Nothing is silently dropped: received = analyzed + ignored + rejected + out of
// window, and the counts are returned.
//
// Columns read (FOCUS names): ChargePeriodStart, ChargePeriodEnd,
// BillingCurrency, ServiceName, ChargeCategory, ChargeFrequency, PricingCategory,
// CommitmentDiscountId, CommitmentDiscountCategory, CommitmentDiscountStatus,
// CommitmentDiscountType, CommitmentDiscountQuantity, CommitmentDiscountUnit,
// EffectiveCost, BilledCost, and ContractedCost or ListCost (the chosen
// on-demand-equivalent basis). SkuId, ResourceId and ConsumedQuantity are NOT
// used: coverage is value-based, not quantity-based, because consumed units from
// different SKUs cannot be added.
//
// Definitions (also returned in every result as `definitions`):
//   ELIGIBLE USAGE. A row is eligible usage when ChargeCategory is 'Usage',
//     ChargeFrequency is 'Usage-Based' or absent, and it is either
//     (a) covered: CommitmentDiscountStatus 'Used' (PricingCategory 'Committed'
//         or absent), or
//     (b) on-demand: no commitment fields and PricingCategory 'Standard'.
//     Excluded: Dynamic (spot or preemptible) and Other pricing, unused-commitment
//     rows (they are waste, not usage), and any non-Usage charge.
//   BASIS. Covered and on-demand usage are both valued at the on-demand
//     equivalent: ContractedCost by default (negotiated rate, before commitment
//     discounts), or ListCost when asked. Numerator and denominator use the same
//     basis, so the ratio is consistent.
//   COVERAGE % = covered basis / (covered basis + on-demand basis), floored to
//     two decimals. By construction it cannot exceed 100; a computed value above
//     100 is clamped and flagged 'over_100_clamped' instead of being believed.
//   UTILIZATION % = used / (used + unused), over EffectiveCost (the amortized
//     commitment cost FOCUS places on Used and Unused rows), floored. Unit
//     quantities are reported per unit and never added across units.
//   Unused-commitment dollars = the sum of EffectiveCost on Unused rows.
//
// Known data gaps are listed in README.md (notably: the repo's CanonicalFocusRow
// does not yet carry most commitment columns, and FOCUS Cost and Usage rows have
// no commitment end date, so expiry comes from caller-supplied terms).

import type { CostWindow } from '@/costsource/CostSourceClient';
import { parseIsoUtc } from '@/costsource/transports/focusExport';
import { RecommendInputError } from './errors';
import {
  MAX_ABS_MAJOR,
  ZERO,
  formatScaled,
  isCurrencyCode,
  currencyExponent,
  percentFloor,
  toMinorUnits,
  toScaled,
} from './money';
import { isRecord, own } from './validate';

export const MAX_COMMITMENT_ROWS = 100_000;
export const MAX_WINDOW_DAYS = 400;
export const MAX_TERMS = 10_000;
export const DEFAULT_EXPIRING_WITHIN_DAYS = 60;
export const MAX_COMMITMENT_ID_LENGTH = 256;
export const HOURS_PER_MONTH = 730;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const QUANTITY_DECIMALS = 6;

export type CostBasis = 'ContractedCost' | 'ListCost';

/** The columns this slice reads. CanonicalFocusRow is structurally assignable only once the ingest seam carries the commitment columns. */
export interface CommitmentFocusRow {
  ChargePeriodStart: string;
  ChargePeriodEnd?: string | null;
  BillingCurrency: string;
  ServiceName: string;
  ChargeCategory: string;
  ChargeFrequency?: string | null;
  PricingCategory?: string | null;
  CommitmentDiscountId?: string | null;
  CommitmentDiscountCategory?: string | null;
  CommitmentDiscountStatus?: string | null;
  CommitmentDiscountType?: string | null;
  CommitmentDiscountQuantity?: number | null;
  CommitmentDiscountUnit?: string | null;
  ListCost?: number | null;
  ContractedCost?: number | null;
  EffectiveCost?: number | null;
  BilledCost?: number | null;
}

/** Caller-supplied term information; FOCUS Cost and Usage rows carry no commitment end date. */
export interface CommitmentTerm {
  commitmentId: string;
  /** ISO-8601 instant at which the commitment ends. */
  termEnd: string;
}

export interface CommitmentAnalysisOptions {
  /** On-demand-equivalent column. Default 'ContractedCost'. */
  costBasis?: CostBasis;
  terms?: ReadonlyArray<CommitmentTerm>;
  /** Flag a commitment expiring within this many days of asOf. Default 60, range 1 to 365. */
  expiringWithinDays?: number;
  /** Injected "now" for expiry math (ISO-8601). Defaults to the window end, so the result is deterministic. */
  asOf?: string;
}

export type RowRejectCode =
  | 'not_an_object'
  | 'invalid_charge_period'
  | 'invalid_currency'
  | 'invalid_field'
  | 'unknown_charge_category'
  | 'unknown_enum_value'
  | 'inconsistent_commitment_fields'
  | 'inconsistent_pricing_category'
  | 'missing_pricing_category'
  | 'invalid_amount'
  | 'negative_amount';

export type RowIgnoreCode =
  | 'non_usage_charge'
  | 'purchase_without_commitment'
  | 'non_usage_frequency'
  | 'dynamic_pricing'
  | 'other_pricing';

export const ROW_REJECT_MESSAGES: Readonly<Record<RowRejectCode, string>> = {
  not_an_object: 'row is not an object',
  invalid_charge_period: 'charge period is missing, malformed or not ordered',
  invalid_currency: 'billing currency is not a three-letter uppercase code',
  invalid_field: 'a required text field is missing, too long or the wrong type',
  unknown_charge_category: 'charge category is not a FOCUS value',
  unknown_enum_value: 'a categorical column has a value outside the FOCUS set',
  inconsistent_commitment_fields: 'commitment id, status and pricing category contradict each other',
  inconsistent_pricing_category: 'pricing category contradicts the commitment status',
  missing_pricing_category: 'pricing category is missing on a usage row',
  invalid_amount: 'a required cost is missing, non-finite or out of range',
  negative_amount: 'a cost is negative',
};

export const ROW_IGNORE_MESSAGES: Readonly<Record<RowIgnoreCode, string>> = {
  non_usage_charge: 'tax, credit or adjustment charge',
  purchase_without_commitment: 'purchase row with no commitment id',
  non_usage_frequency: 'usage row that is not usage-based',
  dynamic_pricing: 'dynamic (spot or preemptible) pricing is not commitment-eligible',
  other_pricing: 'pricing category Other is not commitment-eligible',
};

export const COMMITMENT_DEFINITIONS = {
  eligibility:
    "Eligible usage: ChargeCategory 'Usage', ChargeFrequency 'Usage-Based' or absent, and either covered (CommitmentDiscountStatus 'Used') or on-demand (no commitment fields, PricingCategory 'Standard'). Excluded: Dynamic and Other pricing, Unused-commitment rows, all non-Usage charges.",
  coverage:
    'Coverage percent = covered basis / (covered basis + on-demand basis), floored to two decimals. Basis is the on-demand-equivalent ContractedCost (default) or ListCost.',
  utilization:
    'Utilization percent = used / (used + unused) over EffectiveCost, floored to two decimals. Unit quantities are per unit and never added across units.',
  unusedCommitment: 'Unused-commitment cost = sum of EffectiveCost on rows with CommitmentDiscountStatus Unused.',
} as const;

export type CommitmentKind = 'spend' | 'usage' | 'unknown' | 'conflicting';
export type TermStatus = 'unknown' | 'active' | 'expiring_soon' | 'expired';
export type CommitmentFlag =
  | 'all_unused'
  | 'mixed_units'
  | 'category_conflict'
  | 'quantity_unusable'
  | 'baseline_below_effective'
  | 'over_100_clamped';
export type FamilyFlag = 'baseline_below_effective' | 'over_100_clamped' | 'coarse_granularity';

export interface UnitQuantity {
  unit: string;
  /** Exact decimal text (six decimals at most). */
  usedQuantity: string;
  unusedQuantity: string;
  utilizationPct: number | null;
}

export interface AmountSummary {
  usedCostMinor: bigint;
  unusedCostMinor: bigint;
  committedCostMinor: bigint;
  utilizationPct: number | null;
  coveredBasisMinor: bigint;
  onDemandBasisMinor: bigint;
  eligibleBasisMinor: bigint;
  coveragePct: number | null;
}

export interface CommitmentReport {
  commitmentId: string;
  currency: string;
  kind: CommitmentKind;
  types: string[];
  families: string[];
  usedCostMinor: bigint;
  unusedCostMinor: bigint;
  /** Used plus unused amortized cost over the window. */
  committedCostMinor: bigint;
  utilizationPct: number | null;
  /** Billed cost of Purchase rows for this commitment in the window (cash view). */
  purchaseBilledMinor: bigint;
  coveredBasisMinor: bigint;
  /** Covered basis over the eligible basis of the families this commitment touches. */
  shareOfFamilyEligiblePct: number | null;
  units: UnitQuantity[];
  termEnd: string | null;
  daysToExpiry: number | null;
  termStatus: TermStatus;
  expiringSoon: boolean;
  expired: boolean;
  flags: CommitmentFlag[];
}

export interface CommitmentFamilyCell {
  commitmentId: string;
  family: string;
  usedCostMinor: bigint;
  unusedCostMinor: bigint;
  committedCostMinor: bigint;
  utilizationPct: number | null;
  coveredBasisMinor: bigint;
  shareOfFamilyEligiblePct: number | null;
}

export interface SeriesPoint {
  /** Bucket index from the window start. */
  index: number;
  coveredMinor: bigint;
  onDemandMinor: bigint;
}

export interface EligibleSeries {
  /** 'hour' when every eligible row is at most one hour long, 'day' when at most 24 hours, else 'coarse' (unusable). */
  granularity: 'hour' | 'day' | 'coarse';
  bucketHours: number;
  /** Window start; bucket i spans [start + i*bucket, start + (i+1)*bucket). */
  startIso: string;
  /** Buckets in the whole window; absent buckets are zero. */
  bucketCount: number;
  /** Sparse, ascending by index. */
  points: SeriesPoint[];
  /** Distinct window days that contain at least one eligible row. */
  observedDays: number;
  windowDays: number;
}

export interface FamilyCoverageReport extends AmountSummary {
  family: string;
  currency: string;
  commitmentIds: string[];
  series: EligibleSeries;
  flags: FamilyFlag[];
}

export interface CurrencyCommitmentReport {
  currency: string;
  exponent: number;
  totals: AmountSummary;
  commitments: CommitmentReport[];
  families: FamilyCoverageReport[];
  cells: CommitmentFamilyCell[];
}

export interface RowCounts {
  received: number;
  outOfWindow: number;
  ignored: number;
  rejected: number;
  analyzed: number;
  ignoredByReason: Partial<Record<RowIgnoreCode, number>>;
  rejectedByReason: Partial<Record<RowRejectCode, number>>;
}

export interface CommitmentAnalysis {
  window: { start: string; end: string };
  asOf: string;
  costBasis: CostBasis;
  expiringWithinDays: number;
  rows: RowCounts;
  termsRejected: number;
  currencies: CurrencyCommitmentReport[];
  definitions: typeof COMMITMENT_DEFINITIONS;
}

// --- row parsing -------------------------------------------------------------

const INVALID = Symbol('invalid');
type Invalid = typeof INVALID;

const CHARGE_CATEGORIES = ['Usage', 'Purchase', 'Tax', 'Credit', 'Adjustment'] as const;
const CHARGE_FREQUENCIES = ['One-Time', 'Recurring', 'Usage-Based'] as const;
const PRICING_CATEGORIES = ['Standard', 'Dynamic', 'Committed', 'Other'] as const;
const COMMITMENT_STATUSES = ['Used', 'Unused'] as const;
const COMMITMENT_CATEGORIES = ['Spend', 'Usage'] as const;

function optionalText(v: unknown, max = MAX_COMMITMENT_ID_LENGTH): string | null | Invalid {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) return INVALID;
  return v;
}

function optionalEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null | Invalid {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : INVALID;
}

function costField(rec: Record<string, unknown>, key: string, currency: string): bigint | null | Invalid {
  const v = own(rec, key);
  if (v === undefined || v === null) return null;
  const m = toMinorUnits(v, currency);
  return m === null ? INVALID : m;
}

type Role = 'used' | 'unused' | 'ondemand' | 'purchase';

interface ParsedRow {
  startMs: number;
  endMs: number | null;
  currency: string;
  family: string;
  role: Role;
  eligible: boolean;
  commitmentId: string | null;
  category: 'Spend' | 'Usage' | null;
  type: string | null;
  effective: bigint;
  basis: bigint;
  billed: bigint;
  qty: bigint | null;
  unit: string | null;
  quantityIssue: boolean;
}

type RowOutcome =
  | { kind: 'ok'; row: ParsedRow }
  | { kind: 'reject'; code: RowRejectCode }
  | { kind: 'ignore'; code: RowIgnoreCode }
  | { kind: 'out' };

const rej = (code: RowRejectCode): RowOutcome => ({ kind: 'reject', code });
const ign = (code: RowIgnoreCode): RowOutcome => ({ kind: 'ignore', code });

function parseRow(raw: unknown, winStart: number, winEnd: number, basisKey: CostBasis): RowOutcome {
  if (!isRecord(raw)) return rej('not_an_object');

  const startRaw = own(raw, 'ChargePeriodStart');
  const startMs = typeof startRaw === 'string' ? parseIsoUtc(startRaw) : null;
  if (startMs === null) return rej('invalid_charge_period');
  if (startMs < winStart || startMs >= winEnd) return { kind: 'out' };

  let endMs: number | null = null;
  const endRaw = own(raw, 'ChargePeriodEnd');
  if (endRaw !== undefined && endRaw !== null && endRaw !== '') {
    endMs = typeof endRaw === 'string' ? parseIsoUtc(endRaw) : null;
    if (endMs === null || endMs <= startMs) return rej('invalid_charge_period');
  }

  const currency = own(raw, 'BillingCurrency');
  if (!isCurrencyCode(currency)) return rej('invalid_currency');

  const family = optionalText(own(raw, 'ServiceName'));
  if (family === INVALID || family === null) return rej('invalid_field');

  const chargeCategory = optionalEnum(own(raw, 'ChargeCategory'), CHARGE_CATEGORIES);
  if (chargeCategory === INVALID || chargeCategory === null) return rej('unknown_charge_category');

  const frequency = optionalEnum(own(raw, 'ChargeFrequency'), CHARGE_FREQUENCIES);
  const pricing = optionalEnum(own(raw, 'PricingCategory'), PRICING_CATEGORIES);
  const status = optionalEnum(own(raw, 'CommitmentDiscountStatus'), COMMITMENT_STATUSES);
  const cdCategory = optionalEnum(own(raw, 'CommitmentDiscountCategory'), COMMITMENT_CATEGORIES);
  if (frequency === INVALID || pricing === INVALID || status === INVALID || cdCategory === INVALID) {
    return rej('unknown_enum_value');
  }
  const commitmentId = optionalText(own(raw, 'CommitmentDiscountId'));
  const type = optionalText(own(raw, 'CommitmentDiscountType'), 128);
  const unit = optionalText(own(raw, 'CommitmentDiscountUnit'), 64);
  if (commitmentId === INVALID || type === INVALID || unit === INVALID) return rej('invalid_field');

  if (chargeCategory === 'Tax' || chargeCategory === 'Credit' || chargeCategory === 'Adjustment') {
    return ign('non_usage_charge');
  }

  const base = { startMs, endMs, currency, family, commitmentId, category: cdCategory, type, unit };

  if (chargeCategory === 'Purchase') {
    if (commitmentId === null) return ign('purchase_without_commitment');
    const billed = costField(raw, 'BilledCost', currency);
    if (billed === INVALID || billed === null) return rej('invalid_amount');
    return {
      kind: 'ok',
      row: {
        ...base, role: 'purchase', eligible: false, effective: ZERO, basis: ZERO, billed,
        qty: null, quantityIssue: false,
      },
    };
  }

  // ChargeCategory === 'Usage' from here.
  const usageBased = frequency === null || frequency === 'Usage-Based';

  // FOCUS: status is non-null exactly when a commitment id is present.
  if ((commitmentId === null) !== (status === null)) return rej('inconsistent_commitment_fields');
  if (commitmentId === null && pricing === 'Committed') return rej('inconsistent_commitment_fields');

  if (status !== null) {
    const effective = costField(raw, 'EffectiveCost', currency);
    if (effective === INVALID || effective === null) return rej('invalid_amount');
    if (effective < ZERO) return rej('negative_amount');

    // Optional quantity: unusable quantity is flagged, never a reason to drop the cost.
    let qty: bigint | null = null;
    let quantityIssue = false;
    const rawQty = own(raw, 'CommitmentDiscountQuantity');
    if (rawQty !== undefined && rawQty !== null) {
      const scaled = unit === null ? null : toScaled(rawQty, QUANTITY_DECIMALS, MAX_ABS_MAJOR);
      if (scaled === null || scaled < ZERO) quantityIssue = true;
      else qty = scaled;
    }

    if (status === 'Unused') {
      return {
        kind: 'ok',
        row: { ...base, role: 'unused', eligible: false, effective, basis: ZERO, billed: ZERO, qty, quantityIssue },
      };
    }
    // Used: must be committed pricing and carries an on-demand-equivalent basis.
    if (pricing !== null && pricing !== 'Committed') return rej('inconsistent_pricing_category');
    const basis = costField(raw, basisKey, currency);
    if (basis === INVALID || basis === null) return rej('invalid_amount');
    if (basis < ZERO) return rej('negative_amount');
    return {
      kind: 'ok',
      row: { ...base, role: 'used', eligible: usageBased, effective, basis, billed: ZERO, qty, quantityIssue },
    };
  }

  // No commitment fields: on-demand candidate.
  if (pricing === null) return rej('missing_pricing_category');
  if (pricing === 'Dynamic') return ign('dynamic_pricing');
  if (pricing === 'Other') return ign('other_pricing');
  if (pricing === 'Committed') return rej('inconsistent_commitment_fields');
  if (!usageBased) return ign('non_usage_frequency');
  const basis = costField(raw, basisKey, currency);
  if (basis === INVALID || basis === null) return rej('invalid_amount');
  if (basis < ZERO) return rej('negative_amount');
  return {
    kind: 'ok',
    row: {
      ...base, role: 'ondemand', eligible: true, effective: ZERO, basis, billed: ZERO,
      qty: null, quantityIssue: false,
    },
  };
}

// --- aggregation -------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface CommitmentAcc {
  id: string;
  categories: Set<string>;
  types: Set<string>;
  used: bigint;
  unused: bigint;
  purchaseBilled: bigint;
  covered: bigint;
  units: Map<string, { used: bigint; unused: bigint }>;
  families: Set<string>;
  quantityIssue: boolean;
  baselineBelowEffective: boolean;
}

interface CellAcc {
  used: bigint;
  unused: bigint;
  covered: bigint;
}

interface EligibleEntry {
  startMs: number;
  endMs: number | null;
  covered: bigint;
  onDemand: bigint;
}

interface FamilyAcc {
  used: bigint;
  unused: bigint;
  covered: bigint;
  onDemand: bigint;
  commitments: Set<string>;
  entries: EligibleEntry[];
  baselineBelowEffective: boolean;
}

interface CurrencyAcc {
  commitments: Map<string, CommitmentAcc>;
  cells: Map<string, CellAcc>;
  families: Map<string, FamilyAcc>;
}

function summarize(
  used: bigint,
  unused: bigint,
  covered: bigint,
  onDemand: bigint,
  clampSink: { clamped: boolean },
): AmountSummary {
  const committed = used + unused;
  const util = percentFloor(used, committed);
  const eligible = covered + onDemand;
  const cov = percentFloor(covered, eligible);
  if (util?.clamped || cov?.clamped) clampSink.clamped = true;
  return {
    usedCostMinor: used,
    unusedCostMinor: unused,
    committedCostMinor: committed,
    utilizationPct: util ? util.pct : null,
    coveredBasisMinor: covered,
    onDemandBasisMinor: onDemand,
    eligibleBasisMinor: eligible,
    coveragePct: cov ? cov.pct : null,
  };
}

function buildSeries(entries: readonly EligibleEntry[], winStart: number, winEnd: number): EligibleSeries {
  const windowDays = Math.ceil((winEnd - winStart) / DAY_MS);
  const startIso = new Date(winStart).toISOString();
  let maxLen = 0;
  let unknownLen = false;
  for (const e of entries) {
    if (e.endMs === null) unknownLen = true;
    else maxLen = Math.max(maxLen, e.endMs - e.startMs);
  }
  const days = new Set<number>();
  for (const e of entries) days.add(Math.floor((e.startMs - winStart) / DAY_MS));
  const observedDays = days.size;

  if (entries.length === 0 || unknownLen || maxLen > DAY_MS) {
    return { granularity: 'coarse', bucketHours: 0, startIso, bucketCount: 0, points: [], observedDays, windowDays };
  }
  const bucketHours = maxLen <= HOUR_MS ? 1 : 24;
  const bucketMs = bucketHours * HOUR_MS;
  const bucketCount = Math.ceil((winEnd - winStart) / bucketMs);
  const byIndex = new Map<number, SeriesPoint>();
  for (const e of entries) {
    const index = Math.floor((e.startMs - winStart) / bucketMs);
    const p = byIndex.get(index) ?? { index, coveredMinor: ZERO, onDemandMinor: ZERO };
    p.coveredMinor += e.covered;
    p.onDemandMinor += e.onDemand;
    byIndex.set(index, p);
  }
  const points = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return {
    granularity: bucketHours === 1 ? 'hour' : 'day',
    bucketHours,
    startIso,
    bucketCount,
    points,
    observedDays,
    windowDays,
  };
}

function unitReports(units: Map<string, { used: bigint; unused: bigint }>): UnitQuantity[] {
  return [...units.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([unit, q]) => {
      const util = percentFloor(q.used, q.used + q.unused);
      return {
        unit,
        usedQuantity: trimDecimal(formatScaled(q.used, QUANTITY_DECIMALS)),
        unusedQuantity: trimDecimal(formatScaled(q.unused, QUANTITY_DECIMALS)),
        utilizationPct: util ? util.pct : null,
      };
    });
}

/** Trims trailing zeros of a decimal text only after a decimal point. */
function trimDecimal(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function parseTerms(
  terms: ReadonlyArray<CommitmentTerm> | undefined,
): { ends: Map<string, number>; rejected: number } {
  const ends = new Map<string, number>();
  let rejected = 0;
  if (terms === undefined) return { ends, rejected };
  if (!Array.isArray(terms)) throw new RecommendInputError('INVALID_INPUT');
  if (terms.length > MAX_TERMS) throw new RecommendInputError('TOO_MANY_TERMS');
  for (const t of terms) {
    const id = isRecord(t) ? optionalText(own(t, 'commitmentId')) : INVALID;
    const endRaw = isRecord(t) ? own(t, 'termEnd') : undefined;
    const endMs = typeof endRaw === 'string' ? parseIsoUtc(endRaw) : null;
    if (id === INVALID || id === null || endMs === null) {
      rejected++;
      continue;
    }
    // Duplicate entries for one id: keep the EARLIEST end, which flags expiry sooner.
    const prior = ends.get(id);
    if (prior === undefined || endMs < prior) ends.set(id, endMs);
  }
  return { ends, rejected };
}

/**
 * Analyzes FOCUS rows for commitment utilization, coverage, unused commitment
 * cost and expiry. Throws RecommendInputError only for whole-input problems
 * (bad window, over the row cap, bad options); bad rows are rejected and counted.
 */
export function analyzeCommitments(
  rows: ReadonlyArray<CommitmentFocusRow>,
  window: CostWindow,
  options: CommitmentAnalysisOptions = {},
): CommitmentAnalysis {
  if (!Array.isArray(rows)) throw new RecommendInputError('INVALID_INPUT');
  if (rows.length > MAX_COMMITMENT_ROWS) throw new RecommendInputError('TOO_MANY_ROWS');

  const winStart = isRecord(window) ? parseIsoUtc(window.start, { window: true }) : null;
  const winEnd = isRecord(window) ? parseIsoUtc(window.end, { window: true }) : null;
  if (winStart === null || winEnd === null || !(winStart < winEnd)) throw new RecommendInputError('INVALID_WINDOW');
  if (Math.ceil((winEnd - winStart) / DAY_MS) > MAX_WINDOW_DAYS) throw new RecommendInputError('WINDOW_TOO_LONG');

  if (options === null || typeof options !== 'object') throw new RecommendInputError('INVALID_INPUT');
  const costBasis = options.costBasis ?? 'ContractedCost';
  if (costBasis !== 'ContractedCost' && costBasis !== 'ListCost') throw new RecommendInputError('INVALID_INPUT');
  const expiringWithinDays = options.expiringWithinDays ?? DEFAULT_EXPIRING_WITHIN_DAYS;
  if (!Number.isInteger(expiringWithinDays) || expiringWithinDays < 1 || expiringWithinDays > 365) {
    throw new RecommendInputError('INVALID_INPUT');
  }
  let asOfMs = winEnd;
  if (options.asOf !== undefined) {
    const parsed = typeof options.asOf === 'string' ? parseIsoUtc(options.asOf) : null;
    if (parsed === null) throw new RecommendInputError('INVALID_INPUT');
    asOfMs = parsed;
  }
  const { ends: termEnds, rejected: termsRejected } = parseTerms(options.terms);

  const counts: RowCounts = {
    received: rows.length,
    outOfWindow: 0,
    ignored: 0,
    rejected: 0,
    analyzed: 0,
    ignoredByReason: {},
    rejectedByReason: {},
  };
  const byCurrency = new Map<string, CurrencyAcc>();

  for (let i = 0; i < rows.length; i++) {
    let outcome: RowOutcome;
    try {
      outcome = parseRow(rows[i], winStart, winEnd, costBasis);
    } catch {
      outcome = rej('not_an_object');
    }
    if (outcome.kind === 'out') {
      counts.outOfWindow++;
      continue;
    }
    if (outcome.kind === 'ignore') {
      counts.ignored++;
      counts.ignoredByReason[outcome.code] = (counts.ignoredByReason[outcome.code] ?? 0) + 1;
      continue;
    }
    if (outcome.kind === 'reject') {
      counts.rejected++;
      counts.rejectedByReason[outcome.code] = (counts.rejectedByReason[outcome.code] ?? 0) + 1;
      continue;
    }
    counts.analyzed++;
    const r = outcome.row;
    let cur = byCurrency.get(r.currency);
    if (!cur) {
      cur = { commitments: new Map(), cells: new Map(), families: new Map() };
      byCurrency.set(r.currency, cur);
    }
    let fam = cur.families.get(r.family);
    if (!fam) {
      fam = { used: ZERO, unused: ZERO, covered: ZERO, onDemand: ZERO, commitments: new Set(), entries: [], baselineBelowEffective: false };
      cur.families.set(r.family, fam);
    }

    if (r.role === 'ondemand') {
      fam.onDemand += r.basis;
      fam.entries.push({ startMs: r.startMs, endMs: r.endMs, covered: ZERO, onDemand: r.basis });
      continue;
    }

    const id = r.commitmentId as string;
    let c = cur.commitments.get(id);
    if (!c) {
      c = {
        id, categories: new Set(), types: new Set(), used: ZERO, unused: ZERO, purchaseBilled: ZERO, covered: ZERO,
        units: new Map(), families: new Set(), quantityIssue: false, baselineBelowEffective: false,
      };
      cur.commitments.set(id, c);
    }
    if (r.category) c.categories.add(r.category);
    if (r.type) c.types.add(r.type);
    c.families.add(r.family);
    fam.commitments.add(id);

    if (r.role === 'purchase') {
      c.purchaseBilled += r.billed;
      continue;
    }

    const cellKey = `${id}\u0000${r.family}`;
    let cell = cur.cells.get(cellKey);
    if (!cell) {
      cell = { used: ZERO, unused: ZERO, covered: ZERO };
      cur.cells.set(cellKey, cell);
    }
    if (r.quantityIssue) c.quantityIssue = true;
    if (r.qty !== null && r.unit !== null) {
      const u = c.units.get(r.unit) ?? { used: ZERO, unused: ZERO };
      if (r.role === 'used') u.used += r.qty;
      else u.unused += r.qty;
      c.units.set(r.unit, u);
    }

    if (r.role === 'unused') {
      c.unused += r.effective;
      cell.unused += r.effective;
      fam.unused += r.effective;
    } else {
      c.used += r.effective;
      cell.used += r.effective;
      fam.used += r.effective;
      if (r.eligible) {
        c.covered += r.basis;
        cell.covered += r.basis;
        fam.covered += r.basis;
        fam.entries.push({ startMs: r.startMs, endMs: r.endMs, covered: r.basis, onDemand: ZERO });
        // A covered row whose on-demand-equivalent is below what it cost is a data-quality symptom
        // (for example a source that backfilled ContractedCost from EffectiveCost).
        if (r.basis < r.effective) {
          c.baselineBelowEffective = true;
          fam.baselineBelowEffective = true;
        }
      }
    }
  }

  const currencies: CurrencyCommitmentReport[] = [];
  for (const currency of [...byCurrency.keys()].sort(cmp)) {
    const cur = byCurrency.get(currency) as CurrencyAcc;
    const familyEligible = new Map<string, bigint>();
    for (const [name, f] of cur.families) familyEligible.set(name, f.covered + f.onDemand);

    const families: FamilyCoverageReport[] = [];
    let tUsed = ZERO, tUnused = ZERO, tCovered = ZERO, tOnDemand = ZERO;
    for (const name of [...cur.families.keys()].sort(cmp)) {
      const f = cur.families.get(name) as FamilyAcc;
      const sink = { clamped: false };
      const summary = summarize(f.used, f.unused, f.covered, f.onDemand, sink);
      const series = buildSeries(f.entries, winStart, winEnd);
      const flags: FamilyFlag[] = [];
      if (f.baselineBelowEffective) flags.push('baseline_below_effective');
      if (sink.clamped) flags.push('over_100_clamped');
      if (series.granularity === 'coarse' && f.entries.length > 0) flags.push('coarse_granularity');
      families.push({
        family: name,
        currency,
        ...summary,
        commitmentIds: [...f.commitments].sort(cmp),
        series,
        flags,
      });
      tUsed += f.used;
      tUnused += f.unused;
      tCovered += f.covered;
      tOnDemand += f.onDemand;
    }

    const commitments: CommitmentReport[] = [];
    for (const id of [...cur.commitments.keys()].sort(cmp)) {
      const c = cur.commitments.get(id) as CommitmentAcc;
      const flags: CommitmentFlag[] = [];
      const committed = c.used + c.unused;
      const util = percentFloor(c.used, committed);
      let touchedEligible = ZERO;
      for (const fname of c.families) touchedEligible += familyEligible.get(fname) ?? ZERO;
      const share = percentFloor(c.covered, touchedEligible);
      if (util?.clamped || share?.clamped) flags.push('over_100_clamped');
      if (c.used === ZERO && c.unused > ZERO) flags.push('all_unused');
      if (c.units.size > 1) flags.push('mixed_units');
      if (c.categories.size > 1) flags.push('category_conflict');
      if (c.quantityIssue) flags.push('quantity_unusable');
      if (c.baselineBelowEffective) flags.push('baseline_below_effective');

      const kind: CommitmentKind =
        c.categories.size > 1 ? 'conflicting' : c.categories.has('Spend') ? 'spend' : c.categories.has('Usage') ? 'usage' : 'unknown';

      const endMs = termEnds.get(id);
      let termEnd: string | null = null;
      let daysToExpiry: number | null = null;
      let termStatus: TermStatus = 'unknown';
      if (endMs !== undefined) {
        termEnd = new Date(endMs).toISOString();
        const remaining = endMs - asOfMs;
        daysToExpiry = Math.floor(remaining / DAY_MS);
        termStatus = remaining <= 0 ? 'expired' : remaining <= expiringWithinDays * DAY_MS ? 'expiring_soon' : 'active';
      }

      commitments.push({
        commitmentId: id,
        currency,
        kind,
        types: [...c.types].sort(cmp),
        families: [...c.families].sort(cmp),
        usedCostMinor: c.used,
        unusedCostMinor: c.unused,
        committedCostMinor: committed,
        utilizationPct: util ? util.pct : null,
        purchaseBilledMinor: c.purchaseBilled,
        coveredBasisMinor: c.covered,
        shareOfFamilyEligiblePct: share ? share.pct : null,
        units: unitReports(c.units),
        termEnd,
        daysToExpiry,
        termStatus,
        expiringSoon: termStatus === 'expiring_soon',
        expired: termStatus === 'expired',
        flags,
      });
    }

    const cells: CommitmentFamilyCell[] = [...cur.cells.keys()]
      .map((key) => {
        const [commitmentId, family] = key.split('\u0000');
        return { key, commitmentId, family };
      })
      .sort((a, b) => cmp(a.commitmentId, b.commitmentId) || cmp(a.family, b.family))
      .map(({ key, commitmentId, family }) => {
        const cell = cur.cells.get(key) as CellAcc;
        const committed = cell.used + cell.unused;
        const util = percentFloor(cell.used, committed);
        const share = percentFloor(cell.covered, familyEligible.get(family) ?? ZERO);
        return {
          commitmentId,
          family,
          usedCostMinor: cell.used,
          unusedCostMinor: cell.unused,
          committedCostMinor: committed,
          utilizationPct: util ? util.pct : null,
          coveredBasisMinor: cell.covered,
          shareOfFamilyEligiblePct: share ? share.pct : null,
        };
      });

    currencies.push({
      currency,
      exponent: currencyExponent(currency),
      totals: summarize(tUsed, tUnused, tCovered, tOnDemand, { clamped: false }),
      commitments,
      families,
      cells,
    });
  }

  return {
    window: { start: new Date(winStart).toISOString(), end: new Date(winEnd).toISOString() },
    asOf: new Date(asOfMs).toISOString(),
    costBasis,
    expiringWithinDays,
    rows: counts,
    termsRejected,
    currencies,
    definitions: COMMITMENT_DEFINITIONS,
  };
}
