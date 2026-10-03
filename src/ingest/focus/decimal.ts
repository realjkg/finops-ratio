// Money and quantities are validated as decimal STRINGS and handed to Postgres
// `numeric` unchanged — they never become JS numbers. NaN/Infinity (which
// Postgres numeric would accept) and locale formats are rejected.

const DECIMAL_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?$/;
const MAX_LEN = 100;

export function isDecimalString(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_LEN && DECIMAL_RE.test(s);
}
