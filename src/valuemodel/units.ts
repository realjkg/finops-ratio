// Units for user-defined KPIs. A unit is a product of base dimensions with integer exponents plus an exact factor to
// the base unit, so the engine can check that a formula makes sense (minutes ÷ invoices is minutes per invoice;
// a satisfaction score + USD is refused) and convert hours to minutes without float.
//
// Unit expressions: `term` or `term/term`, where a term is `name` or `name*name...`, and `1` is dimensionless.
//   Time:      second, minute, hour, day          (base: minute)
//   Ratio:     percent (1/100), 1
//   Money:     an ISO 4217-shaped code, upper case (USD, EUR); each currency is its own dimension, never converted
//   Scores:    score_<name>                       (its own dimension, e.g. score_csat)
//   Counts:    any other lower-case name           (invoice, case, inspection): each is its own dimension
import { type Rational, R_ONE, div, fromInt, mul, parseDecimal } from './rational';

export interface Unit {
  /** Base dimension → integer exponent; dimensionless is {}. Keys sorted, zero exponents removed. */
  readonly dims: Readonly<Record<string, number>>;
  /** Multiply a value in this unit by `factor` to get the base unit. */
  readonly factor: Rational;
}

/** The dimensionless unit `1`. */
export const R_ONE_UNIT: Unit = Object.freeze({ dims: Object.freeze({}), factor: R_ONE });

const TIME: Record<string, Rational> = {
  second: div(fromInt(1), fromInt(60)) as Rational,
  minute: fromInt(1),
  hour: fromInt(60),
  day: fromInt(1440),
};
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_UNIT_LENGTH = 80;

export class UnitError extends Error {
  readonly code = 'UNIT_INVALID';
  constructor(what: string) {
    super(what);
    this.name = 'UnitError';
  }
}

function normalize(dims: Record<string, number>): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(dims).sort()) if (dims[k] !== 0) out[k] = dims[k];
  return Object.freeze(out);
}

function atom(name: string): Unit {
  if (name === '1') return { dims: {}, factor: R_ONE };
  if (name === 'percent') return { dims: {}, factor: div(fromInt(1), fromInt(100)) as Rational };
  if (Object.hasOwn(TIME, name)) return { dims: { time: 1 }, factor: TIME[name] };
  if (CURRENCY_RE.test(name)) return { dims: { [`currency:${name}`]: 1 }, factor: R_ONE };
  if (name.startsWith('score_') && NAME_RE.test(name)) return { dims: { [`score:${name.slice(6)}`]: 1 }, factor: R_ONE };
  if (NAME_RE.test(name)) return { dims: { [`count:${name}`]: 1 }, factor: R_ONE };
  throw new UnitError(`unknown unit name (allowed: time units, percent, 1, a currency code, score_<name>, or a lower-case count name)`);
}

export function multiplyUnits(a: Unit, b: Unit, sign: 1 | -1 = 1): Unit {
  const dims: Record<string, number> = { ...a.dims };
  for (const [k, e] of Object.entries(b.dims)) dims[k] = (dims[k] ?? 0) + sign * e;
  const factor = sign === 1 ? mul(a.factor, b.factor) : (div(a.factor, b.factor) as Rational);
  return { dims: normalize(dims), factor };
}

function term(s: string): Unit {
  const parts = s.split('*');
  if (parts.some((p) => p === '')) throw new UnitError('empty unit term');
  return parts.map(atom).reduce((acc, u) => multiplyUnits(acc, u), { dims: {}, factor: R_ONE } as Unit);
}

/** Parses a unit expression; throws UnitError (whose message never echoes the input). */
export function parseUnit(expr: unknown): Unit {
  if (typeof expr !== 'string' || expr.length === 0 || expr.length > MAX_UNIT_LENGTH || /\s/.test(expr)) throw new UnitError('unit must be a short expression without spaces');
  const sides = expr.split('/');
  if (sides.length > 2) throw new UnitError('at most one "/" in a unit');
  const num = term(sides[0]);
  return sides.length === 2 ? multiplyUnits(num, term(sides[1]), -1) : { dims: normalize({ ...num.dims }), factor: num.factor };
}

export const sameDimension = (a: Unit, b: Unit): boolean => {
  const ka = Object.keys(a.dims);
  const kb = Object.keys(b.dims);
  return ka.length === kb.length && ka.every((k) => b.dims[k] === a.dims[k]);
};

export const isDimensionless = (u: Unit) => Object.keys(u.dims).length === 0;
export const isMoney = (u: Unit) => Object.keys(u.dims).some((k) => k.startsWith('currency:'));
export const currenciesOf = (u: Unit) => Object.keys(u.dims).filter((k) => k.startsWith('currency:')).map((k) => k.slice(9));

/** Human-readable dimension for problem messages, e.g. `currency:USD·count:invoice^-1`. */
export const describeDims = (u: Unit) => Object.entries(u.dims).map(([k, e]) => (e === 1 ? k : `${k}^${e}`)).join('·') || 'dimensionless';

/** The base unit of `u`'s dimension (factor 1): minutes for time, the currency itself for money. */
export const baseUnit = (u: Unit): Unit => ({ dims: u.dims, factor: R_ONE });

/** Converts an exact value expressed in `from` to `to`; null when the dimensions differ. */
export function convert(value: Rational, from: Unit, to: Unit): Rational | null {
  if (!sameDimension(from, to)) return null;
  return div(mul(value, from.factor), to.factor);
}

/** Converts a decimal-string quantity to base units; null when it is not a plain decimal string. */
export const toBase = (quantity: string, unit: Unit): Rational | null => {
  const r = parseDecimal(quantity);
  return r === null ? null : mul(r, unit.factor);
};
