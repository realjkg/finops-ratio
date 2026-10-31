// Exact reconciliation of an imported synthetic dataset. Pure and client-safe: money is parsed into
// BigInt units of 1e-10 and summed per currency (never across currencies, never as floats), and an
// empty cell is N/A: it is counted, explained, and left out of the sums rather than treated as 0.
import type { Dataset } from './types';

const SCALE = 10;
const UNIT = BigInt('10000000000');
const ZERO = BigInt(0);

/** The reason an empty column is N/A when the dataset gives none (conditional FOCUS columns). */
export const GENERIC_NA_REASON = 'Not provided by this connection';

export function parseUnits(v: string): bigint {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(v);
  if (!m || (m[3] ?? '').length > SCALE) throw new Error('not an exact decimal');
  const n = BigInt((m[2] || '0') + (m[3] ?? '').padEnd(SCALE, '0'));
  return m[1] === '-' ? -n : n;
}

/** Exact 10-place decimal string. */
export function formatUnits(u: bigint): string {
  const neg = u < ZERO;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${a / UNIT}.${(a % UNIT).toString().padStart(SCALE, '0')}`;
}

/** "USD 2,830.22": rounded half away from zero to cents, for display only. */
export function formatMoney(value: string, currency: string): string {
  const u = parseUnits(value);
  const neg = u < ZERO;
  const c = ((neg ? -u : u) + BigInt('50000000')) / BigInt('100000000');
  const whole = String(c / BigInt(100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg && c > ZERO ? '-' : ''}${currency} ${whole}.${String(c % BigInt(100)).padStart(2, '0')}`;
}

export interface Reconciled {
  id: string;
  name: string;
  connectionType: Dataset['meta']['connectionType'];
  currency: string;
  rows: number;
  billed: string;
  effective: string;
  /** Billed minus Effective (a prepaid commitment makes Billed larger; owned hardware makes it smaller). */
  difference: string;
  naBilled: number;
  naEffective: number;
  /** True when the sums over the imported rows equal the control totals shipped with the fixture. */
  matchesControl: boolean;
  naColumns: { column: string; rows: number; reason: string }[];
  topServices: { service: string; effective: string }[];
  commitment: null | { name: string; purchaseBilled: string; usedEffective: string; unusedEffective: string };
}

export function reconcile(d: Dataset, commonReasons: Record<string, string> = {}): Reconciled {
  const ix = (name: string) => d.columns.indexOf(name);
  const [bi, ei, ci, si, cat, status, cname] = ['BilledCost', 'EffectiveCost', 'BillingCurrency', 'ServiceName', 'ChargeCategory', 'CommitmentDiscountStatus', 'CommitmentDiscountName'].map(ix);
  const currencies = new Set(d.rows.map((r) => r[ci]));
  if (currencies.size !== 1) throw new Error('A dataset must have one billing currency; currencies are never added together.');
  let billed = ZERO; let effective = ZERO; let naBilled = 0; let naEffective = 0;
  let purchase = ZERO; let used = ZERO; let unused = ZERO; let commitmentName = '';
  const byService = new Map<string, bigint>();
  for (const r of d.rows) {
    if (r[bi] === '') naBilled++; else billed += parseUnits(r[bi]);
    if (r[ei] === '') { naEffective++; continue; }
    const e = parseUnits(r[ei]);
    effective += e;
    byService.set(r[si], (byService.get(r[si]) ?? ZERO) + e);
    if (r[cat] === 'Purchase' && r[bi] !== '') { purchase += parseUnits(r[bi]); commitmentName = r[cname]; }
    if (r[status] === 'Used') used += e;
    if (r[status] === 'Unused') unused += e;
  }
  const reasons = { ...commonReasons, ...d.meta.naReasons };
  const naColumns = d.columns.map((column, c) => ({ column, rows: d.rows.filter((r) => r[c] === '').length }))
    .filter((x) => x.rows > 0).map((x) => ({ ...x, reason: reasons[x.column] ?? GENERIC_NA_REASON }));
  const control = d.meta.controlTotals[d.rows[0]?.[ci] ?? ''];
  return {
    id: d.meta.id, name: d.meta.name, connectionType: d.meta.connectionType, currency: [...currencies][0], rows: d.rows.length,
    billed: formatUnits(billed), effective: formatUnits(effective), difference: formatUnits(billed - effective), naBilled, naEffective,
    matchesControl: Boolean(control) && control.rows === d.rows.length && control.billed === formatUnits(billed) && control.effective === formatUnits(effective)
      && control.naBilled === naBilled && control.naEffective === naEffective && d.meta.rowCount === d.rows.length,
    naColumns,
    topServices: [...byService].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0]))).slice(0, 5).map(([service, e]) => ({ service, effective: formatUnits(e) })),
    commitment: purchase > ZERO ? { name: commitmentName, purchaseBilled: formatUnits(purchase), usedEffective: formatUnits(used), unusedEffective: formatUnits(unused) } : null,
  };
}

/** Per-currency totals over several reconciled datasets. Different currencies are never merged. */
export function totalsByCurrency(list: Reconciled[]): { currency: string; rows: number; billed: string; effective: string; difference: string; connections: number }[] {
  const acc = new Map<string, { rows: number; billed: bigint; effective: bigint; connections: number }>();
  for (const r of list) {
    const t = acc.get(r.currency) ?? { rows: 0, billed: ZERO, effective: ZERO, connections: 0 };
    acc.set(r.currency, { rows: t.rows + r.rows, billed: t.billed + parseUnits(r.billed), effective: t.effective + parseUnits(r.effective), connections: t.connections + 1 });
  }
  return [...acc].sort((a, b) => a[0].localeCompare(b[0])).map(([currency, t]) => ({ currency, rows: t.rows, billed: formatUnits(t.billed), effective: formatUnits(t.effective), difference: formatUnits(t.billed - t.effective), connections: t.connections }));
}
