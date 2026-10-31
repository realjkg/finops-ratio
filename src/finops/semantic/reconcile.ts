// Reconciliation identities of the unified view (S1), pure and exact (BigInt decimal strings, never float).
//   I1 allocation conservation: sum(allocated by business unit) + unallocated (+ named deltas) = published
//      total, per currency and basis (billed and effective are separate results; currencies are never summed).
//   I2 source to headline: headline total = sum of the sources the M0c policy marks eligible for that measure.
//      The caller passes the result of evaluateSourcePolicy (src/connectors/managed/policy/overlap.ts, a
//      worker-only tree app code may not import); this module never re-decides eligibility or overlap.
// residual = right - left, present only when both sides exist. A missing side is N/A with a reason, never 0.
// Identities are tenant-wide: a BU-scoped caller gets not_applicable (no tenant total can be inferred).
import type { CurrencyFacts, ReportFacts } from '../../reports/reportFacts';
import { isDecimal, isZeroDecimal, subDecimal, sumDecimal } from './decimal';
import type { Scope } from './query';

export type Basis = 'billed' | 'effective';
export type ReconciliationStatus = 'reconciled' | 'unreconciled' | 'not_reconcilable' | 'not_applicable';
export type Amount = { status: 'available'; value: string } | { status: 'not_available'; reason: string };
export interface Reason { code: string; detail: string }
export interface BridgeLine { line: string; amount: string }
export interface ReconciliationResult {
  id: 'I1' | 'I2'; key: { period: string; currency: string | null; basis: Basis | null; scope: 'tenant' | 'business_unit' }; status: ReconciliationStatus;
  left: { label: string; amount: Amount }; right: { label: string; amount: Amount }; residual: Amount; bridge: BridgeLine[]; reasons: Reason[];
  inputs: { batchIds: string[]; configSha256: string | null; asOf: string };
}

const CODE_DETAIL = {
  unexplainedResidual: ['UNEXPLAINED_RESIDUAL', 'Both sides exist and differ; the residual is not explained by a named delta'],
  allocationMissing: ['ALLOCATION_MISSING', 'No allocation for this currency and basis (needs R6 attribution); not treated as 0'],
  unallocatedMissing: ['UNALLOCATED_MISSING', 'The unallocated line is missing; it is never treated as 0'],
  effectivePartial: ['EFFECTIVE_PARTIAL', 'Effective cost is partial or missing for this group and is never filled from billed cost'],
  currencyNotPublished: ['CURRENCY_NOT_PUBLISHED', 'No published facts in this currency; amounts are never converted or summed across currencies'],
  noBusinessUnitDimension: ['NO_BUSINESS_UNIT_DIMENSION', 'No business-unit dimension in the data: every amount is unallocated'],
  noPublishedFacts: ['NO_PUBLISHED_FACTS', 'No published facts for this period are visible to the reader'],
  multiSourceNotCombined: ['MULTI_SOURCE_NOT_COMBINED', 'More than one source published facts for this period; they are not combined into one headline'],
  tenantScopeOnly: ['TENANT_SCOPE_ONLY', 'Tenant-wide identity; not evaluated for a business-unit scope'],
  needsR4TrustViews: ['NEEDS_R4_TRUST_VIEWS', 'Needs R4 trust views (migration 0005): the reader role cannot link published sources to configured sources'],
  noEligibleSource: ['NO_ELIGIBLE_SOURCE', 'The source-role and overlap policy (M0c) marks no source eligible for this headline measure'],
  sourceExcluded: ['SOURCE_EXCLUDED', 'Excluded from the headline by the M0c policy'],
  sourceNotPublished: ['SOURCE_NOT_PUBLISHED', 'A source the policy marks eligible has no published facts for this period'],
  headlineMissing: ['HEADLINE_MISSING', 'No headline figure for this currency and basis'],
} as const;
type CodeName = keyof typeof CODE_DETAIL;
/** Named reason codes (stable identifiers). */
export const RECONCILE_CODES = Object.fromEntries(Object.entries(CODE_DETAIL).map(([k, v]) => [k, v[0]])) as { [K in CodeName]: (typeof CODE_DETAIL)[K][0] };
const C = RECONCILE_CODES;
const DETAIL: Record<string, string> = Object.fromEntries(Object.values(CODE_DETAIL));
const reason = (code: string, detail = DETAIL[code]): Reason => ({ code, detail });
const avail = (value: string): Amount => ({ status: 'available', value });
const na = (r: string): Amount => ({ status: 'not_available', reason: r });
const BASES: readonly Basis[] = ['billed', 'effective'];
const CURRENCY_RE = /^[A-Z]{3}$/;
const DELTA_REASON_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const pairKey = (c: string, b: Basis) => `${c}/${b}`;

function measureOf(c: CurrencyFacts | undefined, basis: Basis): Amount {
  if (!c) return na(DETAIL[C.currencyNotPublished]);
  if (basis === 'billed') return avail(c.billedCost);
  return c.effectiveCost.status === 'available' ? avail(c.effectiveCost.value) : na(DETAIL[C.effectivePartial]);
}
type Labels = { id: 'I1' | 'I2'; left: string; right: string };
type Ctx = Labels & { period: string; scope: 'tenant' | 'business_unit'; inputs: ReconciliationResult['inputs'] };
function context(l: Labels, scope: Scope, p: ReportFacts, configSha256: string | null): Ctx {
  const batchIds = p.sources.flatMap((s) => s.batches.map((b) => b.batchId)).sort();
  return { ...l, period: p.period.month, scope: scope.wildcard ? 'tenant' : 'business_unit', inputs: { batchIds, configSha256, asOf: p.freshness.asOf } };
}
/** Builds one result. `blocked` set: not reconcilable/applicable, residual N/A. Otherwise both sides must exist. */
function result(x: Ctx, currency: string | null, basis: Basis | null, left: Amount, right: Amount, bridge: BridgeLine[], reasons: Reason[], blocked: ReconciliationStatus | null): ReconciliationResult {
  const base = { id: x.id, key: { period: x.period, currency, basis, scope: x.scope }, left: { label: x.left, amount: left }, right: { label: x.right, amount: right }, bridge, inputs: x.inputs };
  if (blocked || left.status !== 'available' || right.status !== 'available') {
    return { ...base, status: blocked ?? 'not_reconcilable', residual: na('Not computed: a side is not available'), reasons };
  }
  const residual = subDecimal(right.value, left.value);
  const closes = isZeroDecimal(residual);
  return { ...base, status: closes ? 'reconciled' : 'unreconciled', residual: avail(residual), reasons: closes ? reasons : [reason(C.unexplainedResidual), ...reasons] };
}
/** Results that do not depend on the identity: BU scope, or no headline facts at all. */
function preamble(x: Ctx, p: ReportFacts, multiSourceBlocks: boolean): ReconciliationResult[] | null {
  const one = (status: ReconciliationStatus, code: string) => [result(x, null, null, na(DETAIL[code]), na(DETAIL[code]), [], [reason(code)], status)];
  if (x.scope !== 'tenant') return one('not_applicable', C.tenantScopeOnly);
  if (p.sources.length === 0) return one('not_applicable', C.noPublishedFacts);
  if (multiSourceBlocks && p.totals.status !== 'available') return one('not_reconcilable', C.multiSourceNotCombined);
  return null;
}

export interface AllocationSlice { currency: string; basis: Basis; lines: Array<{ businessUnit: string; amount: string }>; unallocated: string | null }
export interface Delta { currency: string; basis: Basis; amount: string; reason: string }
export interface AllocationInput { scope: Scope; published: ReportFacts; allocation: { configSha256: string; slices: AllocationSlice[] } | null; deltas: Delta[] }

export function reconcileAllocation(i: AllocationInput): ReconciliationResult[] {
  const x = context({ id: 'I1', left: 'allocated by business unit + unallocated + named deltas', right: 'published total' }, i.scope, i.published, i.allocation?.configSha256 ?? null);
  const pre = preamble(x, i.published, true);
  if (pre) return pre;
  const totals = i.published.totals.status === 'available' ? i.published.totals.value : [];
  const slices = new Map<string, AllocationSlice>();
  for (const s of i.allocation?.slices ?? []) {
    if (!CURRENCY_RE.test(s.currency) || !BASES.includes(s.basis)) throw new TypeError('reconcile: an allocation slice has an invalid currency or basis');
    if (slices.has(pairKey(s.currency, s.basis))) throw new TypeError('reconcile: an allocation slice is listed twice');
    slices.set(pairKey(s.currency, s.basis), s);
  }
  for (const d of i.deltas) {
    if (typeof d.reason !== 'string' || !DELTA_REASON_RE.test(d.reason)) throw new TypeError('reconcile: a delta needs a named reason');
    if (!isDecimal(d.amount) || !totals.some((t) => t.currency === d.currency) || !BASES.includes(d.basis)) throw new TypeError('reconcile: a delta matches no published currency and basis');
  }
  const out: ReconciliationResult[] = [];
  for (const t of totals) {
    for (const basis of BASES) {
      const right = measureOf(t, basis);
      const s = slices.get(pairKey(t.currency, basis));
      const blockedBy = right.status !== 'available' ? C.effectivePartial : !s ? C.allocationMissing : s.unallocated === null ? C.unallocatedMissing : null;
      if (blockedBy || !s || s.unallocated === null) {
        out.push(result(x, t.currency, basis, na(DETAIL[blockedBy ?? C.allocationMissing]), right, [], [reason(blockedBy ?? C.allocationMissing)], 'not_reconcilable'));
        continue;
      }
      const bridge: BridgeLine[] = [
        ...s.lines.map((l) => ({ line: `business_unit:${l.businessUnit}`, amount: l.amount })),
        { line: 'unallocated', amount: s.unallocated },
        ...i.deltas.filter((d) => d.currency === t.currency && d.basis === basis).map((d) => ({ line: `delta:${d.reason}`, amount: d.amount })),
      ];
      const left = avail(sumDecimal(bridge.map((b) => b.amount)));
      out.push(result(x, t.currency, basis, left, right, bridge, s.lines.length === 0 ? [reason(C.noBusinessUnitDimension)] : [], null));
    }
  }
  const published = new Set(totals.map((t) => t.currency));
  for (const s of [...slices.values()].filter((v) => !published.has(v.currency)).sort((a, b) => (pairKey(a.currency, a.basis) < pairKey(b.currency, b.basis) ? -1 : 1))) {
    out.push(result(x, s.currency, s.basis, na(DETAIL[C.currencyNotPublished]), na(DETAIL[C.currencyNotPublished]), [], [reason(C.currencyNotPublished)], 'not_reconcilable'));
  }
  return out;
}

/** The parts of the M0c PolicyResult (evaluateSourcePolicy) this identity reads; a PolicyResult is assignable. */
type Coded = ReadonlyArray<{ code: string; sources: readonly string[] }>;
export interface PolicyOutcome { ok: boolean; problems: Coded; warnings: Coded; headline: Readonly<Record<Basis, readonly string[]>>; excluded: ReadonlyArray<{ id: string; reason: string }> }
/** sourceKeys: published source id -> configured source id; null until the reader can see source keys (R4 0005).
 *  headline: the figures shown to users; default: the report-facts totals (a single source only). */
export interface SourceTotalsInput { scope: Scope; published: ReportFacts; policy: PolicyOutcome; sourceKeys: Readonly<Record<string, string>> | null; headline?: ReadonlyArray<{ currency: string; basis: Basis; amount: string }>; configSha256?: string }

export function reconcileSourceTotals(i: SourceTotalsInput): ReconciliationResult[] {
  const x = context({ id: 'I2', left: 'sum of the sources M0c marks eligible', right: 'headline total' }, i.scope, i.published, i.configSha256 ?? null);
  const pre = preamble(x, i.published, false);
  if (pre) return pre;
  const p = i.published;
  const currencies = [...new Set(p.sources.flatMap((s) => s.currencies.map((c) => c.currency)))].sort();
  const byConfigId = new Map(p.sources.filter((s) => i.sourceKeys && Object.prototype.hasOwnProperty.call(i.sourceKeys, s.sourceId)).map((s) => [i.sourceKeys![s.sourceId], s]));
  const noted = [
    ...i.policy.excluded.map((e) => reason(C.sourceExcluded, `source ${e.id}: ${e.reason}`)),
    ...i.policy.warnings.map((w) => reason(w.code, `M0c warning for sources ${w.sources.join(', ')}; shown next to the totals`)),
  ];
  const headlineOf = (currency: string, basis: Basis): Amount => {
    const h = i.headline?.find((v) => v.currency === currency && v.basis === basis);
    if (h && !isDecimal(h.amount)) throw new TypeError('amount is not a plain decimal string');
    if (i.headline) return h ? avail(h.amount) : na(DETAIL[C.headlineMissing]);
    return p.totals.status === 'available' ? measureOf(p.totals.value.find((c) => c.currency === currency), basis) : na(DETAIL[C.multiSourceNotCombined]);
  };
  const out: ReconciliationResult[] = [];
  for (const currency of currencies) {
    for (const basis of BASES) {
      const right = headlineOf(currency, basis);
      const stop = (codes: Reason[], left: Amount = na(codes[0].detail), bridge: BridgeLine[] = []) => out.push(result(x, currency, basis, left, right, bridge, codes, 'not_reconcilable'));
      if (!i.sourceKeys) { stop([reason(C.needsR4TrustViews)]); continue; }
      if (!i.policy.ok) { stop([...i.policy.problems.map((q) => reason(q.code, `M0c problem for sources ${q.sources.join(', ')}`)), ...noted]); continue; }
      const eligible = i.policy.headline[basis];
      if (eligible.length === 0) { stop([reason(C.noEligibleSource), ...noted]); continue; }
      if (eligible.some((id) => !byConfigId.has(id))) { stop([reason(C.sourceNotPublished), ...noted]); continue; }
      const parts = eligible.map((id) => ({ id, amount: measureOf(byConfigId.get(id)!.currencies.find((c) => c.currency === currency), basis) }));
      const missing = parts.find((v) => v.amount.status !== 'available');
      if (missing) { stop([reason((missing.amount as { reason: string }).reason === DETAIL[C.effectivePartial] ? C.effectivePartial : C.currencyNotPublished), ...noted]); continue; }
      const bridge = parts.map((v) => ({ line: `source:${v.id}`, amount: (v.amount as { value: string }).value }));
      const left = avail(sumDecimal(bridge.map((b) => b.amount)));
      if (right.status !== 'available') { stop([reason(i.headline ? C.headlineMissing : C.multiSourceNotCombined), ...noted], left, bridge); continue; }
      out.push(result(x, currency, basis, left, right, bridge, noted, null));
    }
  }
  return out;
}
