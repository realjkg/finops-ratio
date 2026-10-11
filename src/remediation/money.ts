// Money in minor units (BigInt). Trust boundary: every amount is parsed here before use.
// Rules: amounts are non-negative integers; fractional input is refused, never rounded;
// two amounts in different currencies are never added or compared (the helpers return null).
// The tsconfig target is ES2017, so BigInt literals are unavailable: use BigInt(...).

/** 10^15 minor units, a ceiling far above any plausible amount and well inside what BigInt handles. */
export const MAX_MINOR: bigint = BigInt('1000000000000000');
export const ZERO: bigint = BigInt(0);
const CURRENCY = /^[A-Z]{3}$/;
const DIGITS = /^(?:0|[1-9][0-9]{0,15})$/;

export interface Money {
  readonly currency: string;
  readonly minor: bigint;
}

export const isCurrency = (v: unknown): v is string => typeof v === 'string' && CURRENCY.test(v);

/**
 * Accepts a bigint, a decimal digit string, or a safe integer number; returns null for
 * anything else: negative, fractional, NaN, Infinity, over MAX_MINOR, other types.
 */
export function parseMinor(v: unknown): bigint | null {
  let n: bigint;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'string' && DIGITS.test(v)) n = BigInt(v);
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
  else return null;
  return n >= ZERO && n <= MAX_MINOR ? n : null;
}

/** Sum of two amounts, or null if the currencies differ or the total passes MAX_MINOR. */
export function addMoney(a: Money, b: Money): Money | null {
  if (a.currency !== b.currency) return null;
  const minor = a.minor + b.minor;
  return minor <= MAX_MINOR ? { currency: a.currency, minor } : null;
}
