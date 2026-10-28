// M0c: source roles and the headline measures each cost basis may feed. Pure.
//   authoritative       -> billed/effective headline totals (one basis per measure)
//   allocated           -> attribution views labeled "allocated", never summed with the bill
//   enrichment | recommendation | change-management -> never financial totals
//   unknown             -> excluded (fail closed)
export type SourceRole = 'authoritative' | 'allocated' | 'enrichment' | 'recommendation' | 'change-management' | 'unknown';
export type CostBasis = 'billed' | 'effective' | 'actual' | 'amortized' | 'focus-native' | 'unknown';
export type HeadlineMeasure = 'billed' | 'effective';

export const NON_FINANCIAL_ROLES: readonly SourceRole[] = ['enrichment', 'recommendation', 'change-management'];

/** A FOCUS dataset carries both measures (separate columns, never added); native datasets carry one. */
export function measuresFor(basis: CostBasis): HeadlineMeasure[] {
  if (basis === 'focus-native') return ['billed', 'effective'];
  if (basis === 'billed' || basis === 'actual') return ['billed'];
  if (basis === 'effective' || basis === 'amortized') return ['effective'];
  return [];
}

const DEC_RE = /^-?\d+(\.\d+)?$/;
// BigInt() calls, not literals: the app tsconfig target predates ES2020.
const [ZERO, HUNDRED, BP] = [BigInt(0), BigInt(100), BigInt(10000)];
const scaled = (s: string, scale: number) => {
  const [i, f = ''] = s.replace('-', '').split('.');
  const n = BigInt(i + f.padEnd(scale, '0').slice(0, scale));
  return s.startsWith('-') ? -n : n;
};

/**
 * Share of the underlying (authoritative) cost an allocated dataset covers, as a
 * percentage with two decimals (truncated), from exact decimal strings. 'N/A'
 * when either side is not a decimal or the underlying total is zero.
 */
export function allocationCoverage(allocated: string, underlying: string): string {
  if (!DEC_RE.test(allocated) || !DEC_RE.test(underlying)) return 'N/A';
  const scale = 12;
  const u = scaled(underlying, scale);
  if (u === ZERO) return 'N/A';
  const bp = (scaled(allocated, scale) * BP) / u; // basis points of a percent
  const neg = bp < ZERO;
  const a = neg ? -bp : bp;
  return `${neg ? '-' : ''}${a / HUNDRED}.${(a % HUNDRED).toString().padStart(2, '0')}`;
}
