// M0b: the accounting bridge. Per scope, period and cost basis, every measure
// line (records, billed, effective, credits, tax, usage by unit, distinct
// accounts, ...) reads `source + named deltas = normalized`, per currency, and
// must close EXACTLY (decimal strings, BigInt arithmetic). There is no universal
// row-count equality: a split or merge is a named delta. A measure present on
// one side only or a delta matching no line fails the bridge (never an invented
// zero); a monetary measure needs an ISO currency and every currency needs a
// money line (an empty bridge never closes). Aggregate controls
// (e.g. a provider query API total) are compared and reported, never used to
// close the bridge or as completeness proof.

export interface Measure { measure: string; currency?: string; unit?: string; amount: string }
export interface Delta extends Measure { reason: string }
export interface AggregateControl { measure: string; currency?: string; unit?: string; amount: string; origin: string }
export interface BridgeKey { scope: string; period: string; costBasis: string }

export interface BridgeLine { measure: string; currency?: string; unit?: string; source: string; deltas: Array<{ amount: string; reason: string }>; normalized: string; closes: boolean }
/** `line` is a display name; measure/currency/unit identify the line structurally. */
type LineRef = { line: string; measure: string; currency?: string; unit?: string };
export type BridgeFailure =
  | (LineRef & { code: 'BRIDGE_NOT_CLOSED'; expected: string; actual: string; residual: string })
  | (LineRef & { code: 'BRIDGE_SIDE_MISSING'; side: 'source' | 'normalized' })
  | (LineRef & { code: 'BRIDGE_ORPHAN_DELTA'; amount: string; reason: string })
  | { line: string; currency: string; code: 'BRIDGE_CURRENCY_UNCOVERED' }
  | { line: 'money'; code: 'BRIDGE_NO_MONEY_LINE' };
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

const neg = (a: string) => (a.startsWith('-') ? a.slice(1) : `-${a}`);
const eq = (a: string, b: string) => addDecimal(a, neg(b)) === '0';
type LineId = { measure: string; currency?: string; unit?: string };
const MONETARY_RE = /billed|effective|list|contracted|cost|credit|refund|adjust|tax|amortiz|charge|fee|discount|spend|saving|price|amount/i;
/** A money line: a monetary measure with its currency (a count tagged with a currency is not one). */
export const isMoneyLine = (l: LineId) => !!l.currency && MONETARY_RE.test(l.measure);
const lineName = (m: LineId) => `${m.measure}${m.currency ? ` ${m.currency}` : ''}${m.unit ? ` [${m.unit}]` : ''}`;
const lineKey = (m: LineId) => JSON.stringify([m.measure, m.currency ?? null, m.unit ?? null]);
const ref = (m: LineId): LineRef => ({ line: lineName(m), measure: m.measure, ...(m.currency ? { currency: m.currency } : {}), ...(m.unit ? { unit: m.unit } : {}) });

function check(m: LineId & { amount: string }): void {
  parse(m.amount);
  if (typeof m.measure !== 'string' || !/^[A-Za-z][\w.:-]*$/.test(m.measure)) throw new TypeError('bridge: a measure name is one token (letters, digits, _ . : -)');
  if (m.currency !== undefined && !/^[A-Z]{3}$/.test(m.currency)) throw new TypeError(`bridge: ${m.measure} needs an ISO 4217 currency code`);
  if (m.currency === undefined && MONETARY_RE.test(m.measure)) throw new TypeError(`bridge: the monetary measure ${m.measure} needs a currency`);
  if (m.unit !== undefined && (typeof m.unit !== 'string' || m.unit.trim() === '')) throw new TypeError(`bridge: ${m.measure} has an empty unit`);
}

function index<T extends Measure>(xs: readonly T[], side: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const x of xs) {
    check(x);
    const k = lineKey(x);
    if (out.has(k)) throw new TypeError(`bridge: ${side} measure ${lineName(x)} is listed twice`);
    out.set(k, x);
  }
  return out;
}

export function buildBridge(o: { key: BridgeKey; source: readonly Measure[]; normalized: readonly Measure[]; deltas: readonly Delta[]; controls?: readonly AggregateControl[]; currencies?: readonly string[] }): Bridge {
  const src = index(o.source, 'source');
  const norm = index(o.normalized, 'normalized');
  for (const d of [...o.deltas, ...(o.controls ?? [])]) check(d);
  for (const d of o.deltas) {
    if (typeof d.reason !== 'string' || d.reason.trim() === '') throw new TypeError(`bridge: the delta on ${lineName(d)} needs a named reason`);
  }
  const lines: BridgeLine[] = [];
  const failures: BridgeFailure[] = [];
  const keys = [...new Set([...src.keys(), ...norm.keys()])].map((k) => [k, (src.get(k) ?? norm.get(k))!] as const);
  for (const [k, m] of keys.sort((a, b) => (lineName(a[1]) < lineName(b[1]) ? -1 : 1))) {
    const s = src.get(k);
    const n = norm.get(k);
    if (!s || !n) {
      failures.push({ ...ref(m), code: 'BRIDGE_SIDE_MISSING', side: s ? 'normalized' : 'source' });
      continue;
    }
    const ds = o.deltas.filter((d) => lineKey(d) === k).map((d) => ({ amount: d.amount, reason: d.reason }));
    const expected = addDecimal(s.amount, ...ds.map((d) => d.amount));
    const closes = eq(expected, n.amount);
    lines.push({ measure: s.measure, ...(s.currency ? { currency: s.currency } : {}), ...(s.unit ? { unit: s.unit } : {}), source: s.amount, deltas: ds, normalized: n.amount, closes });
    if (!closes) failures.push({ ...ref(m), code: 'BRIDGE_NOT_CLOSED', expected, actual: n.amount, residual: addDecimal(n.amount, neg(expected)) });
  }
  for (const d of o.deltas) {
    if (!src.has(lineKey(d)) && !norm.has(lineKey(d))) failures.push({ ...ref(d), code: 'BRIDGE_ORPHAN_DELTA', amount: d.amount, reason: d.reason });
  }
  const money = new Set(lines.filter(isMoneyLine).map((l) => l.currency));
  if (money.size === 0) failures.push({ line: 'money', code: 'BRIDGE_NO_MONEY_LINE' });
  const currencies = [...(o.currencies ?? []), ...[...o.source, ...o.normalized, ...(o.controls ?? [])].map((m) => m.currency)];
  for (const c of [...new Set(currencies)].sort()) {
    if (c !== undefined && !money.has(c)) failures.push({ line: c, currency: c, code: 'BRIDGE_CURRENCY_UNCOVERED' });
  }
  const controls: ControlResult[] = (o.controls ?? []).map((c) => {
    const n = norm.get(lineKey(c));
    return { ...c, kind: 'control:aggregate', status: !n ? 'not-comparable' : eq(n.amount, c.amount) ? 'matched' : 'variance' };
  });
  return { key: o.key, lines, failures, closed: failures.length === 0, controls };
}
