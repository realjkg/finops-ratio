// Exact rational arithmetic for the value model (BigInt numerator and denominator, never float). The formula engine
// divides (minutes per invoice, value / cost), so a decimal-only helper is not enough: results stay exact until they
// are rounded once, half-even, to the scale a definition declares. Pure: no I/O, clock, network or dynamic code.

// BigInt() calls, not literals: the app tsconfig target predates ES2020.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

/** A plain decimal string: optional minus, up to 18 integer digits, up to 12 fraction digits, no exponent. */
export const DECIMAL_RE = /^-?\d{1,18}(\.\d{1,12})?$/;
/** Bound on the digits of a numerator or denominator, so a hostile formula cannot grow numbers without limit. */
export const MAX_DIGITS = 120;

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

export class RationalOverflowError extends Error {
  readonly code = 'RATIONAL_OVERFLOW';
  constructor() {
    super('value exceeds the bounded precision of the value model');
    this.name = 'RationalOverflowError';
  }
}

const abs = (x: bigint) => (x < ZERO ? -x : x);
function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [abs(a), abs(b)];
  while (y !== ZERO) [x, y] = [y, x % y];
  return x;
}

function make(n: bigint, d: bigint): Rational {
  if (d === ZERO) throw new RangeError('zero denominator');
  if (d < ZERO) [n, d] = [-n, -d];
  const g = gcd(n, d);
  const r = g > ONE ? { n: n / g, d: d / g } : { n, d };
  if (abs(r.n).toString().length > MAX_DIGITS || r.d.toString().length > MAX_DIGITS) throw new RationalOverflowError();
  return Object.freeze(r);
}

export const isDecimalString = (s: unknown): s is string => typeof s === 'string' && DECIMAL_RE.test(s);

/** Parses a plain decimal string exactly; anything else (numbers, exponents, NaN, '') is refused with null. */
export function parseDecimal(s: unknown): Rational | null {
  if (!isDecimalString(s)) return null;
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(i + f);
  return make(neg ? -n : n, TEN ** BigInt(f.length));
}

export const fromInt = (k: number): Rational => {
  if (!Number.isSafeInteger(k)) throw new TypeError('not a safe integer');
  return make(BigInt(k), ONE);
};
export const R_ZERO = make(ZERO, ONE);
export const R_ONE = make(ONE, ONE);

export const add = (a: Rational, b: Rational) => make(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational) => make(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational) => make(a.n * b.n, a.d * b.d);
export const neg = (a: Rational) => make(-a.n, a.d);
export const isZero = (a: Rational) => a.n === ZERO;
/** a / b; null when b is zero (the caller reports "unavailable", never infinity or 0). */
export const div = (a: Rational, b: Rational): Rational | null => (b.n === ZERO ? null : make(a.n * b.d, a.d * b.n));
/** -1, 0 or 1. */
export const cmp = (a: Rational, b: Rational): number => {
  const x = a.n * b.d - b.n * a.d;
  return x === ZERO ? 0 : x < ZERO ? -1 : 1;
};

/** Rounds once, half-to-even, to `scale` fraction digits (0..12) and formats as a plain decimal string. */
export function toDecimal(a: Rational, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) throw new RangeError('scale must be an integer from 0 to 12');
  const m = TEN ** BigInt(scale);
  const num = abs(a.n) * m;
  let q = num / a.d;
  const r = num % a.d;
  const twice = r * TWO;
  if (twice > a.d || (twice === a.d && q % TWO === ONE)) q += ONE;
  const digits = q.toString().padStart(scale + 1, '0');
  const body = scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return a.n < ZERO && q !== ZERO ? `-${body}` : body;
}
