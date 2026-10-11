// Integer money for the allocation module: ISO 4217 minor units in BigInt,
// strict decimal parsing and formatting, and the largest-remainder split.
//
// Trust boundary: amounts arrive as untrusted strings. Nothing here uses
// floating point, `parseFloat`, `Number(text)` or locale APIs. The grammar is
// `-?digits(.digits)?`: no exponent, no thousands separator, no locale comma,
// no sign other than a leading minus, no whitespace. A currency that is not in
// the table below is refused, never guessed (minor-unit exponents differ:
// JPY 0, USD 2, KWD 3, CLF 4). Money is never summed across currencies; this
// module has no function that could.
//
// Rounding rules (stated, and tested):
//   * Parsing: a decimal with more fractional digits than the currency allows is
//     REFUSED by default. With mode 'half-even' it is rounded to the minor unit,
//     ties to the even minor unit, applied to the magnitude (so -0.125 and 0.125
//     round symmetrically). The caller learns whether rounding happened.
//   * Splitting: largest-remainder. Each share is floor(total * weight / sum);
//     the leftover minor units go one each to the largest fractional remainders,
//     ties broken by ascending key (code-unit order), so a split is reproducible
//     and always sums to the total exactly. A negative total splits its
//     magnitude and applies the sign afterwards.
//
// The tsconfig target is ES2017, which has no BigInt literals; constants below
// are built with BigInt().

import { AllocationError } from './errors';
import { LIMITS, compareKeys } from './limits';

export const ZERO = BigInt(0);
export const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

const EXPONENT_0 = 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF';
const EXPONENT_3 = 'BHD IQD JOD KWD LYD OMR TND';
const EXPONENT_4 = 'CLF UYW';
const EXPONENT_2 =
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CNY COP CRC ' +
  'CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES ' +
  'KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR ' +
  'NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT ' +
  'TOP TRY TTD TWD TZS UAH USD UYU UZS VES WST XCD YER ZAR ZMW ZWG';

/** ISO 4217 minor-unit exponents for the supported currencies. A snapshot: a new code needs a code change. */
const EXPONENTS: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  const add = (list: string, exp: number): void => {
    for (const code of list.split(' ')) m.set(code, exp);
  };
  add(EXPONENT_2, 2);
  add(EXPONENT_0, 0);
  add(EXPONENT_3, 3);
  add(EXPONENT_4, 4);
  return m;
})();

/** Every supported currency code, sorted. Exposed for tests and callers that build pickers. */
export function supportedCurrencies(): string[] {
  return [...EXPONENTS.keys()].sort(compareKeys);
}

/** Minor-unit exponent of a currency. Throws UNKNOWN_CURRENCY for anything not in the table. */
export function currencyExponent(currency: unknown): number {
  if (typeof currency !== 'string') throw new AllocationError('UNKNOWN_CURRENCY');
  const exp = EXPONENTS.get(currency);
  if (exp === undefined) throw new AllocationError('UNKNOWN_CURRENCY');
  return exp;
}

const POW10_CACHE: bigint[] = [ONE];

/** 10^n as a BigInt, for 0 <= n <= 60. */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > 60) throw new AllocationError('AMOUNT_OUT_OF_RANGE');
  while (POW10_CACHE.length <= n) POW10_CACHE.push(POW10_CACHE[POW10_CACHE.length - 1] * TEN);
  return POW10_CACHE[n];
}

export type RoundingMode = 'refuse' | 'half-even';

const DECIMAL_RE = /^(-)?([0-9]+)(?:\.([0-9]+))?$/;
export const MAX_DECIMAL_TEXT = 64;
export const MAX_INTEGER_DIGITS = 24;

export interface ParsedScaled {
  /** The value scaled by 10^scale. */
  value: bigint;
  /** True when digits beyond the scale were rounded away (mode 'half-even' only). */
  rounded: boolean;
}

function anyNonZeroDigit(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 48) return true;
  return false;
}

/**
 * Strict decimal text to a BigInt scaled by 10^scale. Grammar: `-?digits(.digits)?`.
 * Fractional digits beyond `scale` must be zeros (exact) unless `mode` is 'half-even'.
 */
export function parseDecimalScaled(
  text: unknown,
  scale: number,
  mode: RoundingMode = 'refuse',
  allowNegative = true,
): ParsedScaled {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_DECIMAL_TEXT) {
    throw new AllocationError('INVALID_DECIMAL');
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 30) throw new AllocationError('AMOUNT_OUT_OF_RANGE');
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new AllocationError('INVALID_DECIMAL');
  const negative = m[1] === '-';
  const intPart = m[2];
  const frac = m[3] ?? '';
  if (negative && !allowNegative) throw new AllocationError('NEGATIVE_AMOUNT');
  if (intPart.length > MAX_INTEGER_DIGITS) throw new AllocationError('AMOUNT_OUT_OF_RANGE');
  const kept = frac.slice(0, scale).padEnd(scale, '0');
  const extra = frac.slice(scale);
  let value = BigInt(intPart + kept);
  let rounded = false;
  if (anyNonZeroDigit(extra)) {
    if (mode === 'refuse') throw new AllocationError('PRECISION_EXCEEDED');
    rounded = true;
    const first = extra.charCodeAt(0) - 48;
    let up: boolean;
    if (first > 5) up = true;
    else if (first < 5) up = false;
    else up = anyNonZeroDigit(extra.slice(1)) ? true : value % TWO === ONE; // exact tie: round to even
    if (up) value += ONE;
  }
  return { value: negative ? -value : value, rounded };
}

/** Parses a decimal string into integer minor units of `currency`. See the module header for the rules. */
export function parseDecimalToMinor(text: unknown, currency: unknown, mode: RoundingMode = 'refuse'): bigint {
  return parseDecimalScaled(text, currencyExponent(currency), mode).value;
}

/** As `parseDecimalToMinor`, also reporting whether rounding happened. */
export function parseDecimalToMinorChecked(
  text: unknown,
  currency: unknown,
  mode: RoundingMode = 'refuse',
): { minor: bigint; rounded: boolean } {
  const { value, rounded } = parseDecimalScaled(text, currencyExponent(currency), mode);
  return { minor: value, rounded };
}

/** Formats a scaled BigInt as plain decimal text (no exponent, no separators). Never prints "-0". */
export function formatScaled(value: bigint, scale: number): string {
  if (typeof value !== 'bigint' || !Number.isInteger(scale) || scale < 0 || scale > 60) {
    throw new AllocationError('INVALID_DECIMAL');
  }
  const negative = value < ZERO;
  const digits = (negative ? -value : value).toString();
  const sign = negative ? '-' : '';
  if (scale === 0) return sign + digits;
  const padded = digits.padStart(scale + 1, '0');
  return `${sign}${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
}

/** Formats integer minor units of `currency` as decimal text, e.g. 1050 USD -> "10.50", 1050 JPY -> "1050". */
export function formatMinor(minor: bigint, currency: unknown): string {
  return formatScaled(minor, currencyExponent(currency));
}

export function sumBigInt(values: Iterable<bigint>): bigint {
  let total = ZERO;
  for (const v of values) total += v;
  return total;
}

/**
 * Splits `total` over `weights` with the largest-remainder method. Weights are
 * non-negative integers whose sum is positive. The shares sum to `total`
 * exactly. Ties between equal remainders go to the lower index, so callers that
 * sort their targets by key get a deterministic, reproducible result.
 */
export function splitLargestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  if (typeof total !== 'bigint' || !Array.isArray(weights)) throw new AllocationError('INVALID_WEIGHT');
  const n = weights.length;
  if (n === 0) throw new AllocationError('EMPTY_SPLIT');
  if (n > LIMITS.maxSplitParts) throw new AllocationError('TOO_MANY_PARTS');
  let sum = ZERO;
  for (const w of weights) {
    if (typeof w !== 'bigint' || w < ZERO) throw new AllocationError('INVALID_WEIGHT');
    sum += w;
  }
  if (sum === ZERO) throw new AllocationError('ZERO_WEIGHT');

  const negative = total < ZERO;
  const magnitude = negative ? -total : total;
  const shares: bigint[] = new Array<bigint>(n);
  const remainders: bigint[] = new Array<bigint>(n);
  let assigned = ZERO;
  for (let i = 0; i < n; i++) {
    const numerator = magnitude * weights[i];
    const q = numerator / sum;
    shares[i] = q;
    remainders[i] = numerator - q * sum;
    assigned += q;
  }
  const leftover = Number(magnitude - assigned); // 0 <= leftover < n, so a safe integer
  if (leftover > 0) {
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (remainders[i] > ZERO) order.push(i);
    order.sort((a, b) => (remainders[a] > remainders[b] ? -1 : remainders[a] < remainders[b] ? 1 : a - b));
    for (let k = 0; k < leftover; k++) shares[order[k]] += ONE;
  }
  return negative ? shares.map((s) => -s) : shares;
}

export interface KeyedWeight {
  key: string;
  weight: bigint;
}
export interface KeyedShare {
  key: string;
  minor: bigint;
}

/**
 * Largest-remainder split over opaque string keys. Entries are sorted by key
 * (code-unit order) first, so the result does not depend on input order and
 * remainder ties always go to the smaller key. Duplicate keys are refused.
 */
export function splitByKeys(total: bigint, entries: readonly KeyedWeight[]): KeyedShare[] {
  if (!Array.isArray(entries)) throw new AllocationError('INVALID_WEIGHT');
  if (entries.length === 0) throw new AllocationError('EMPTY_SPLIT');
  if (entries.length > LIMITS.maxSplitParts) throw new AllocationError('TOO_MANY_PARTS');
  const sorted = [...entries].sort((a, b) => compareKeys(a.key, b.key));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].key === sorted[i - 1].key) throw new AllocationError('DUPLICATE_KEY');
  }
  const shares = splitLargestRemainder(
    total,
    sorted.map((e) => e.weight),
  );
  return sorted.map((e, i) => ({ key: e.key, minor: shares[i] }));
}

/** Percent scale used by fixed-percent policies: four fractional digits, so 100 percent is 1,000,000. */
export const PERCENT_SCALE = 4;
export const PERCENT_TOTAL = BigInt(100) * pow10(PERCENT_SCALE);

/** Parses a percent such as "33.3333" into units of 0.0001 percent. Negative values are refused. */
export function parsePercent(text: unknown): bigint {
  const { value } = parseDecimalScaled(text, PERCENT_SCALE, 'refuse', false);
  if (value > PERCENT_TOTAL) throw new AllocationError('PERCENT_SUM_INVALID');
  return value;
}

/** Checks that parsed percents sum to exactly 100. Throws PERCENT_SUM_INVALID otherwise. */
export function assertPercentsSumTo100(percents: readonly bigint[]): void {
  if (sumBigInt(percents) !== PERCENT_TOTAL) throw new AllocationError('PERCENT_SUM_INVALID');
}

/** Usage weights are non-negative decimals with up to six fractional digits. */
export const WEIGHT_SCALE = 6;

export function parseUsageWeight(text: unknown): bigint {
  return parseDecimalScaled(text, WEIGHT_SCALE, 'refuse', false).value;
}

/** Extra fractional digits carried beyond the minor unit while allocating (the "exact scale"). */
export const EXACT_EXTRA = 12;
export const EXACT_UNIT = pow10(EXACT_EXTRA);

/** Floor division for a positive divisor (rounds toward negative infinity). */
export function floorDiv(value: bigint, divisor: bigint): bigint {
  const q = value / divisor;
  return value % divisor !== ZERO && value < ZERO ? q - ONE : q;
}

/** Divides and rounds half to even, symmetric around zero (applied to the magnitude). Divisor must be positive. */
export function divRoundHalfEven(value: bigint, divisor: bigint): bigint {
  const negative = value < ZERO;
  const mag = negative ? -value : value;
  let q = mag / divisor;
  const r2 = (mag - q * divisor) * TWO;
  if (r2 > divisor || (r2 === divisor && q % TWO === ONE)) q += ONE;
  return negative ? -q : q;
}
