// Exact money helpers, following src/costsource/aiSpendRatio.ts (integer
// nano-units via BigInt). A local copy because that module keeps its helper
// private and number-only; this one parses decimal strings so nothing is
// rounded through floating point. Documented limit: values need at most 9
// decimals and no exponent form, so 0.1 + 0.2 as a double (17 decimals) is rejected.

// BigInt() calls, not literals: the tsconfig target predates ES2020.
const NANOS = BigInt(1_000_000_000);
const ZERO = BigInt(0);
const DECIMAL = /^-?\d{1,12}(\.\d{1,9})?$/;

export function toNanos(value: unknown): bigint | null {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value : '';
  if (!DECIMAL.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const n = BigInt(whole.replace('-', '')) * NANOS + BigInt(frac.padEnd(9, '0'));
  return whole.startsWith('-') ? -n : n;
}

export function fmtNanos(n: bigint): string {
  const abs = n < ZERO ? -n : n;
  const frac = (abs % NANOS).toString().padStart(9, '0').replace(/0+$/, '');
  return `${n < ZERO ? '-' : ''}${abs / NANOS}${frac ? `.${frac}` : ''}`;
}

/** Trimmed, upper-cased 3-letter code, or null (also rejects '__proto__' etc.). */
export function normCurrency(value: unknown): string | null {
  const c = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(c) ? c : null;
}
