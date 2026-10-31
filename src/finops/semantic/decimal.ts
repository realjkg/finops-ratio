// Exact decimal arithmetic on plain decimal strings (BigInt, never float). Local on purpose: the M0b bridge
// (src/connectors/managed/evidence/bridge.ts) is in the worker-only managed tree (see its boundary.test.ts),
// so app code may not import it; decimal.test.ts cross-checks this helper against the bridge's addDecimal.
const DEC_RE = /^-?\d{1,40}(\.\d{1,40})?$/;
// BigInt() calls, not literals: the app tsconfig target predates ES2020.
const [ZERO, TEN] = [BigInt(0), BigInt(10)];

export const isDecimal = (s: unknown): s is string => typeof s === 'string' && DEC_RE.test(s);

function parse(s: string): { n: bigint; scale: number } {
  if (!isDecimal(s)) throw new TypeError('amount is not a plain decimal string');
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(i + f);
  return { n: neg ? -n : n, scale: f.length };
}

function format(n: bigint, scale: number): string {
  const d = (n < ZERO ? -n : n).toString().padStart(scale + 1, '0');
  return `${n < ZERO ? '-' : ''}${scale > 0 ? `${d.slice(0, -scale)}.${d.slice(-scale)}` : d}`;
}

/** Exact sum; the scale is the largest input scale (as Postgres sum(numeric)). An empty sum is refused, never 0. */
export function sumDecimal(xs: readonly string[]): string {
  if (xs.length === 0) throw new TypeError('an empty sum is not zero');
  const ps = xs.map(parse);
  const scale = Math.max(...ps.map((p) => p.scale));
  let acc = ZERO;
  for (const p of ps) {
    let n = p.n;
    for (let k = p.scale; k < scale; k++) n *= TEN;
    acc += n;
  }
  return format(acc, scale);
}

function negate(s: string): string {
  parse(s);
  return s.startsWith('-') ? s.slice(1) : `-${s}`;
}
/** a - b, exactly. */
export const subDecimal = (a: string, b: string) => sumDecimal([a, negate(b)]);
export const isZeroDecimal = (s: string) => parse(s).n === ZERO;
