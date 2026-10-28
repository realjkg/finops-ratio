// M0b: the accounting bridge. Per scope, period and cost basis, every measure
// line (records, billed, effective, credits, tax, usage by unit, distinct
// accounts, ...) reads `source + named deltas = normalized`, per currency, and
// must close EXACTLY (decimal strings, BigInt arithmetic). There is no universal
// row-count equality: a split or merge is a named delta. A measure present on
// one side only fails the bridge (never an invented zero). Aggregate controls
// (e.g. a provider query API total) are compared and reported, never used to
// close the bridge or as completeness proof.

export interface Measure { measure: string; currency?: string; unit?: string; amount: string }
export interface Delta extends Measure { reason: string }
export interface AggregateControl { measure: string; currency?: string; unit?: string; amount: string; origin: string }
export interface BridgeKey { scope: string; period: string; costBasis: string }

export interface BridgeLine { measure: string; currency?: string; unit?: string; source: string; deltas: Array<{ amount: string; reason: string }>; normalized: string; closes: boolean }
export type BridgeFailure =
  | { line: string; code: 'BRIDGE_NOT_CLOSED'; expected: string; actual: string }
  | { line: string; code: 'BRIDGE_SIDE_MISSING'; side: 'source' | 'normalized' };
export interface ControlResult extends AggregateControl { kind: 'control:aggregate'; status: 'matched' | 'variance' | 'not-comparable' }
export interface Bridge { key: BridgeKey; lines: BridgeLine[]; failures: BridgeFailure[]; closed: boolean; controls: ControlResult[] }

const DEC_RE = /^-?\d+(\.\d+)?$/;
// BigInt() calls, not literals or **: the app tsconfig target predates ES2020.
const [ZERO, TEN] = [BigInt(0), BigInt(10)];
const pow10 = (k: number) => {
  let r = BigInt(1);
  for (let i = 0; i < k; i++) r *= TEN;
  return r;
};

function parse(s: string): { n: bigint; scale: number } {
  if (typeof s !== 'string' || !DEC_RE.test(s)) throw new TypeError('bridge amounts must be plain decimal strings');
  const [i, f = ''] = s.replace('-', '').split('.');
  const n = BigInt(i + f);
  return { n: s.startsWith('-') ? -n : n, scale: f.length };
}

function format(n: bigint, scale: number): string {
  const neg = n < ZERO;
  let s = (neg ? -n : n).toString().padStart(scale + 1, '0');
  if (scale > 0) s = `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, '');
  return s === '0' ? '0' : `${neg ? '-' : ''}${s}`;
}

/** Exact decimal sum of decimal strings. */
export function addDecimal(...xs: string[]): string {
  const ps = xs.map(parse);
  const scale = Math.max(0, ...ps.map((p) => p.scale));
  return format(ps.reduce((acc, p) => acc + p.n * pow10(scale - p.scale), ZERO), scale);
}

const eq = (a: string, b: string) => addDecimal(a, `-${b}`.replace('--', '')) === '0';
const lineName = (m: { measure: string; currency?: string; unit?: string }) => [m.measure, m.currency, m.unit].filter(Boolean).join(' ');

function index<T extends Measure>(xs: readonly T[], side: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const x of xs) {
    parse(x.amount);
    const k = lineName(x);
    if (out.has(k)) throw new TypeError(`bridge: ${side} measure ${k} is listed twice`);
    out.set(k, x);
  }
  return out;
}

export function buildBridge(o: { key: BridgeKey; source: readonly Measure[]; normalized: readonly Measure[]; deltas: readonly Delta[]; controls?: readonly AggregateControl[] }): Bridge {
  const src = index(o.source, 'source');
  const norm = index(o.normalized, 'normalized');
  for (const d of o.deltas) {
    parse(d.amount);
    if (typeof d.reason !== 'string' || d.reason.trim() === '') throw new TypeError(`bridge: the delta on ${lineName(d)} needs a named reason`);
  }
  const lines: BridgeLine[] = [];
  const failures: BridgeFailure[] = [];
  for (const k of [...new Set([...src.keys(), ...norm.keys()])].sort()) {
    const s = src.get(k);
    const n = norm.get(k);
    if (!s || !n) {
      failures.push({ line: k, code: 'BRIDGE_SIDE_MISSING', side: s ? 'normalized' : 'source' });
      continue;
    }
    const ds = o.deltas.filter((d) => lineName(d) === k).map((d) => ({ amount: d.amount, reason: d.reason }));
    const expected = addDecimal(s.amount, ...ds.map((d) => d.amount));
    const closes = eq(expected, n.amount);
    lines.push({ measure: s.measure, ...(s.currency ? { currency: s.currency } : {}), ...(s.unit ? { unit: s.unit } : {}), source: s.amount, deltas: ds, normalized: n.amount, closes });
    if (!closes) failures.push({ line: k, code: 'BRIDGE_NOT_CLOSED', expected, actual: n.amount });
  }
  const controls: ControlResult[] = (o.controls ?? []).map((c) => {
    parse(c.amount);
    const n = norm.get(lineName(c));
    return { ...c, kind: 'control:aggregate', status: !n ? 'not-comparable' : eq(n.amount, c.amount) ? 'matched' : 'variance' };
  });
  return { key: o.key, lines, failures, closed: failures.length === 0, controls };
}
