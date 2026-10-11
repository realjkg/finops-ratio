// Shared types, caps and fixed-text errors for fleet forecasting and anomaly
// detection (RFQ checklist Step 2, items 2.1 to 2.4).
//
// Trust boundary: everything in src/detection is PURE. No I/O, no clock reads,
// no randomness; the caller passes data and an explicit as-of UTC day. Inputs
// are treated as untrusted (they may be parsed JSON): every public function
// validates its arguments and fails closed with a DetectionError whose text is
// fixed and never echoes the offending input. A numeric `index` (a position in
// the caller's array) is the only diagnostic detail an error may carry.
//
// Money rules: values are never summed across currencies (a series carries
// exactly one currency, and fleet roll-ups group by tenant and currency).
// Rounding rule: every money value this module emits is rounded to 6 decimal
// places, half away from zero, once, after summation (see round6).

export const LIMITS = Object.freeze({
  /** Cost rows accepted by one buildDailySeries call. */
  maxRows: 250_000,
  /** Distinct (tenant, currency, account, service, region) series per call. */
  maxSeries: 20_000,
  /** Calendar span (first to last day, inclusive) of one series. */
  maxDaysPerSeries: 400,
  /** Forecast horizon in days. */
  maxHorizonDays: 90,
  /** Findings returned by one detectAnomalies call. */
  maxFindings: 5_000,
  /** Ranked root-cause contributors per finding (AWS parity, design A-d). */
  maxContributors: 10,
  /** Member keys listed on a grouped finding (the count is always exact). */
  maxMemberKeys: 200,
  /** Lifecycle records held by one reduceFindings state. */
  maxRecords: 10_000,
  /** Length of any identifier (tenant, account, service, region, row id). */
  maxIdentifierLength: 256,
  /** Largest absolute per-row amount accepted. */
  maxAbsAmount: 1e12,
});

export type CostField = 'BilledCost' | 'EffectiveCost';

/** One UTC day of one series. `day` is `YYYY-MM-DD`. */
export interface DailyPoint {
  readonly day: string;
  readonly value: number;
}

/**
 * Identity of a daily series. `tenant` is the FOCUS BillingAccountId (the
 * obvious.md mapping BillingAccountId -> tenant); `account` is SubAccountId;
 * `region` is '' when the source carries no region.
 */
export interface SeriesKey {
  readonly tenant: string;
  readonly currency: string;
  readonly account: string;
  readonly service: string;
  readonly region: string;
}

export interface DailySeries {
  /** `tenant|currency|account|service|region`; identifiers never contain '|'. */
  readonly id: string;
  readonly key: SeriesKey;
  readonly costField: CostField;
  /** Strictly ascending unique UTC days. A day with no row is simply absent. */
  readonly points: readonly DailyPoint[];
}

export type Severity = 'info' | 'warning' | 'critical';
export type Direction = 'up' | 'down';

export type DetectionErrorCode =
  | 'ROW_CAP_EXCEEDED'
  | 'SERIES_CAP_EXCEEDED'
  | 'SERIES_TOO_LONG'
  | 'ROW_MALFORMED'
  | 'IDENTIFIER_INVALID'
  | 'CURRENCY_INVALID'
  | 'TIMESTAMP_INVALID'
  | 'AMOUNT_INVALID'
  | 'NEGATIVE_AMOUNT'
  | 'CROSS_TENANT_ROW'
  | 'DUPLICATE_CONFLICT'
  | 'OPTIONS_INVALID'
  | 'SERIES_INVALID'
  | 'AS_OF_INVALID'
  | 'HORIZON_INVALID'
  | 'CONFIG_INVALID'
  | 'BUDGET_INVALID'
  | 'SPEND_INVALID'
  | 'CURRENCY_MISMATCH'
  | 'RECORD_INVALID'
  | 'RECORD_CAP_EXCEEDED'
  | 'FINDING_INVALID'
  | 'BACKTEST_INVALID';

const MESSAGES: Readonly<Record<DetectionErrorCode, string>> = Object.freeze({
  ROW_CAP_EXCEEDED: 'Too many cost rows.',
  SERIES_CAP_EXCEEDED: 'Too many series.',
  SERIES_TOO_LONG: 'A series spans too many days.',
  ROW_MALFORMED: 'A cost row is malformed.',
  IDENTIFIER_INVALID: 'An identifier is missing, too long or contains a forbidden character.',
  CURRENCY_INVALID: 'A currency code is not a three-letter uppercase code.',
  TIMESTAMP_INVALID: 'A timestamp is not a valid ISO 8601 instant with an explicit offset.',
  AMOUNT_INVALID: 'An amount is not a finite number within range.',
  NEGATIVE_AMOUNT: 'A negative amount is not allowed under the selected rule.',
  CROSS_TENANT_ROW: 'A row belongs to a different tenant.',
  DUPLICATE_CONFLICT: 'Two rows share a row id but disagree.',
  OPTIONS_INVALID: 'The options are invalid.',
  SERIES_INVALID: 'A series is malformed.',
  AS_OF_INVALID: 'The as-of day is not a valid UTC calendar day.',
  HORIZON_INVALID: 'The horizon is not an integer within range.',
  CONFIG_INVALID: 'The configuration is invalid.',
  BUDGET_INVALID: 'The budget is invalid.',
  SPEND_INVALID: 'The spend is invalid.',
  CURRENCY_MISMATCH: 'Spend and budget use different currencies.',
  RECORD_INVALID: 'A lifecycle record is malformed.',
  RECORD_CAP_EXCEEDED: 'Too many lifecycle records.',
  FINDING_INVALID: 'A finding is malformed.',
  BACKTEST_INVALID: 'The backtest request is invalid.',
});

/** Fixed-text error. The message never contains caller input. */
export class DetectionError extends Error {
  readonly code: DetectionErrorCode;
  /** Position of the offending element in the caller's array, when known. */
  readonly index: number | undefined;

  constructor(code: DetectionErrorCode, index?: number) {
    super(MESSAGES[code]);
    this.name = 'DetectionError';
    this.code = code;
    this.index = index;
  }
}

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) throw new DetectionError('AMOUNT_INVALID');
  const abs = Math.abs(value);
  // At 1e9 and above a double no longer carries `decimals` fractional digits
  // reliably, so the value is returned as is (still finite, never -0).
  if (abs >= 1e9) return 0 + value;
  const factor = 10 ** decimals;
  // toPrecision(15) strips binary representation noise (0.49999999999999994
  // becomes 0.5) so decimal ties round away from zero as written.
  const scaled = Number((abs * factor).toPrecision(15));
  const rounded = Math.round(scaled) / factor;
  return value < 0 && rounded !== 0 ? -rounded : 0 + rounded;
}

/**
 * Rounds to 6 decimal places, half away from zero, and never returns -0.
 * Throws AMOUNT_INVALID for a non-finite input so bad math cannot leak out.
 * Values of magnitude 1e9 or more are returned unchanged.
 */
export function round6(value: number): number {
  return roundTo(value, 6);
}

/** Rounds to 4 decimal places for ratios and shares (same tie rule). */
export function round4(value: number): number {
  return roundTo(value, 4);
}

/** Code-unit comparison; never locale-dependent, so ordering is deterministic. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Control characters and the key separator are forbidden in identifiers.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IDENTIFIER_CHARS = /[\u0000-\u001f\u007f|]/;

/** True when `value` is a usable identifier. `allowEmpty` is for region only. */
export function isIdentifier(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return allowEmpty;
  if (value.length > LIMITS.maxIdentifierLength) return false;
  if (value.trim().length === 0) return false;
  return !FORBIDDEN_IDENTIFIER_CHARS.test(value);
}

export function isCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

export function seriesId(key: SeriesKey): string {
  return `${key.tenant}|${key.currency}|${key.account}|${key.service}|${key.region}`;
}
