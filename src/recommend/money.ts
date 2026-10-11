// Integer minor-unit money helpers for the recommendation engine.
//
// Rules (checklist "Definition of done" item 7):
//   - Currency is held as BigInt minor units. Floating point is used ONLY at the
//     output boundary for the legacy CostFinding adapter (JSON numbers are read
//     through their shortest decimal text, see parseDecimalToMinor),
//   - Money is never summed across currencies; callers key every accumulator by
//     currency code. Nothing in this module converts between currencies.
//   - Rounding: reading a decimal into minor units rounds HALF AWAY FROM ZERO.
//     Percentages derived from two amounts are FLOORED to two decimals so a
//     ratio is never overstated.
//
// Target note: tsconfig targets ES2017, which has no BigInt literals (`1n`), so
// constants are built with BigInt(...) exactly as src/attribution/allocation.ts
// does.

import { currencyExponent as allocationExponent } from '@/allocation/money';
import { RecommendInputError } from './errors';

export const ZERO = BigInt(0);
export const ONE = BigInt(1);
export const TEN = BigInt(10);
export const BPS = BigInt(10000);

/** Per-amount sanity cap, in MAJOR units (one trillion). Larger values are refused. */
export const MAX_ABS_MAJOR = 1e12;

/**
 * Exponent from the allocation module's vetted ISO 4217 table, or null for a
 * code that table does not know. Unknown codes are refused, never defaulted.
 */
function knownExponent(code: unknown): number | null {
  try {
    return allocationExponent(code);
  } catch {
    return null;
  }
}

/** True only for a SUPPORTED ISO 4217 code (shape alone is not enough). */
export function isCurrencyCode(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Z]{3}$/.test(v) && knownExponent(v) !== null;
}

/** Minor-unit exponent (JPY 0, USD 2, KWD 3, CLF 4). Throws a fixed-text error for an unsupported code. */
export function currencyExponent(code: string): number {
  const e = knownExponent(code);
  if (e === null) throw new RecommendInputError('INVALID_INPUT');
  return e;
}

export function pow10(n: number): bigint {
  let r = ONE;
  for (let i = 0; i < n; i++) r *= TEN;
  return r;
}

export function absBig(v: bigint): bigint {
  return v < ZERO ? -v : v;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Division of a non-negative numerator by a positive denominator, rounded up. */
export function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - ONE) / den;
}

/** num / den rounded half away from zero. `den` must be positive. */
export function divRound(num: bigint, den: bigint): bigint {
  const neg = num < ZERO;
  const mag = neg ? -num : num;
  const q = (mag * BigInt(2) + den) / (den * BigInt(2));
  return neg ? -q : q;
}

/**
 * A JS number to a scaled integer (value x 10^decimals), rounded half away from
 * zero on the exact binary value (toFixed semantics). null when the value is not
 * a finite number or its magnitude exceeds `maxAbs`.
 */
export function toScaled(value: unknown, decimals: number, maxAbs: number): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maxAbs) return null;
  const v = BigInt(Math.abs(value).toFixed(decimals).replace('.', ''));
  return value < 0 ? -v : v;
}

const DECIMAL_TEXT_RE = /^(-?)(\d{1,13})(?:\.(\d{1,20}))?$/;

function textToMinor(text: string, exp: number): bigint | null {
  const m = DECIMAL_TEXT_RE.exec(text);
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  let v = BigInt(whole + frac.slice(0, exp).padEnd(exp, '0'));
  // Round half away from zero on the magnitude: the first dropped digit decides.
  if (frac.length > exp && frac.charCodeAt(exp) >= 53) v += ONE;
  return sign && v !== ZERO ? -v : v;
}

/**
 * Reads an amount in MAJOR units into integer minor units. ONE rounding rule
 * for both input kinds: half away from zero on the SHORTEST DECIMAL TEXT of the
 * value. A JSON number is first turned into its shortest round-trip decimal
 * string (so 1.005 is read as "1.005", exactly like the string "1.005", and both
 * give 101 USD minor units). Strings must be strict decimals (no exponent, no
 * separators, no whitespace). Returns null for an unsupported currency, any
 * other input, or a magnitude above MAX_ABS_MAJOR.
 */
export function parseDecimalToMinor(value: unknown, currency: string): bigint | null {
  const exp = knownExponent(currency);
  if (exp === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_MAJOR) return null;
    const abs = Math.abs(value);
    let text = String(abs);
    if (text.includes('e')) text = abs.toFixed(20);
    return textToMinor((value < 0 ? '-' : '') + text, exp);
  }
  if (typeof value !== 'string') return null;
  return textToMinor(value, exp);
}

/** JSON number (major units) to minor units; see parseDecimalToMinor. */
export function toMinorUnits(value: unknown, currency: string): bigint | null {
  if (typeof value !== 'number') return null;
  return parseDecimalToMinor(value, currency);
}

/** Exact decimal text of a scaled integer, e.g. (12345, 2) -> "123.45". */
export function formatScaled(v: bigint, decimals: number): string {
  const neg = v < ZERO;
  const digits = absBig(v).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? '.' + digits.slice(digits.length - decimals) : '';
  return (neg ? '-' : '') + whole + frac;
}

/** Plain decimal text of a minor-unit amount (no symbol, no grouping). */
export function formatMinor(minor: bigint, currency: string): string {
  return formatScaled(minor, currencyExponent(currency));
}

/**
 * Minor units to a JS number in major units. Lossy by nature: ONLY for the
 * legacy CostFinding adapter whose field is a float. null above 2^53 minor
 * units, where the conversion would no longer be exact.
 */
export function minorToNumber(minor: bigint, currency: string): number | null {
  if (absBig(minor) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor) / Math.pow(10, currencyExponent(currency));
}

export interface PercentResult {
  /** Percent, floored to two decimals, in [0, 100]. */
  pct: number;
  /** Same value as integer basis points. */
  bps: number;
  /** True when part exceeded whole and the value was clamped to 100. */
  clamped: boolean;
}

/**
 * part/whole as a floored percent. null when the whole is not positive or the
 * part is negative (undefined ratio). An apparent value above 100 percent is
 * CLAMPED to 100 and flagged: it signals inconsistent inputs, never real
 * over-utilization.
 */
export function percentFloor(part: bigint, whole: bigint): PercentResult | null {
  if (whole <= ZERO || part < ZERO) return null;
  if (part > whole) return { pct: 100, bps: 10000, clamped: true };
  const bps = Number((part * BPS) / whole);
  return { pct: bps / 100, bps, clamped: false };
}

/**
 * Recursively turns bigint into decimal strings so results can go through
 * JSON.stringify (which throws on bigint). Depth-limited; deeper values become null.
 */
export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v, depth + 1);
    return out;
  }
  return value;
}
