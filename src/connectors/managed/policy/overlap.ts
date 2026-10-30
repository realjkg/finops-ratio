// M0c: overlap and headline eligibility. Pure; consumed by the read model (R5)
// and by startup checks. Overlapping financial sources are never combined
// without an explicit dedup policy: two authoritative (or two allocated)
// sources whose scope intersects, or whose config declares (or does not rule
// out) overlap, give OVERLAP_UNRESOLVED. Problems name source ids and codes,
// never account identifiers or amounts.
//
// Periods are compared as instants (Date.parse after a strict ISO 8601 check),
// never as strings, so mixed UTC offsets are handled. period.endSemantics
// carries R1 scope.period_end_semantics; absent, the FOCUS BillingPeriodEnd
// convention (exclusive) applies. An inclusive date-only end covers that whole
// day. A period that does not parse, or whose start is not before its end, is
// PERIOD_INVALID and treated as overlapping everything (never ok).
//
// Dedup policies (until the R1 schema carries them, callers pass them in):
//   prefer             the preferred source wins; the other leaves the headline (or allocated view) entirely.
//                      Row-level partial dedup is not supported in 1.0. When the loser's declared accounts or
//                      period provably exceed the winner's, prefer is refused (PREFER_UNDERCOUNTS); when coverage
//                      cannot be proven (unknown accounts, different providers), the result carries a
//                      PREFER_MAY_UNDERCOUNT warning. Prefer policies that form a cycle are POLICY_INVALID.
//   split-by           disjoint sub-account lists, each covering its source's declared accounts.
//   basis-per-measure  one source feeds billed only, the other effective only (e.g. actual + amortized).
// When the billed and effective headlines are fed by different sources whose scope is not provably equal,
// the result carries a MEASURE_SCOPE_DIFFERS warning. Warnings must be shown next to the totals.
import type { EngagementSource } from '../../../engagement/config';
import { NON_FINANCIAL_ROLES, measuresFor, type CostBasis, type HeadlineMeasure, type SourceRole } from './roles';

export interface PolicySource {
  id: string;
  role: SourceRole;
  costBasis: CostBasis;
  providers: string[];
  accounts: string[] | 'unknown';
  period: { start: string; end: string; endSemantics?: 'inclusive' | 'exclusive' };
  alsoPresentInOtherSource: 'yes' | 'no' | 'unknown';
  relatedSource: string;
}

export type DedupPolicy =
  | { kind: 'prefer'; sources: [string, string]; prefer: string }
  | { kind: 'split-by'; sources: [string, string]; subAccounts: Record<string, string[]> }
  | { kind: 'basis-per-measure'; sources: [string, string] };

export interface PolicyProblem { code: 'OVERLAP_UNRESOLVED' | 'POLICY_INVALID' | 'PERIOD_INVALID' | 'PREFER_UNDERCOUNTS' | 'RELATED_SOURCE_MISSING'; sources: string[]; detail: string }
export interface PolicyWarning { code: 'PREFER_MAY_UNDERCOUNT' | 'MEASURE_SCOPE_DIFFERS'; sources: string[]; detail: string }
export interface PolicyResult {
  ok: boolean;
  problems: PolicyProblem[];
  /** Disclosures that do not block the headline but must be shown with it. */
  warnings: PolicyWarning[];
  headline: Record<HeadlineMeasure, string[]>;
  allocated: Array<{ id: string; allocates?: string }>;
  nonFinancial: string[];
  excluded: Array<{ id: string; reason: string }>;
}

export class SourcePolicyError extends Error {
  constructor(readonly problems: PolicyProblem[]) {
    super(problems.map((p) => `${p.code}: ${p.detail}`).join('; '));
    this.name = 'SourcePolicyError';
  }
}

export function fromEngagementSource(s: EngagementSource): PolicySource {
  const m = s.metadata;
  return {
    id: s.id, role: m.source_role, costBasis: m.cost_basis, providers: [...s.providers], accounts: Array.isArray(m.scope.accounts) ? [...m.scope.accounts] : 'unknown',
    period: { start: m.scope.period_start, end: m.scope.period_end, endSemantics: m.scope.period_end_semantics }, alsoPresentInOtherSource: m.overlap.also_present_in_other_source, relatedSource: m.overlap.related_source,
  };
}

const intersects = <T>(a: readonly T[], b: readonly T[]) => a.some((x) => b.includes(x));
const subset = <T>(a: readonly T[], b: readonly T[]) => a.every((x) => b.includes(x));
const sameSet = <T>(a: readonly T[], b: readonly T[]) => subset(a, b) && subset(b, a);
const names = (ids: readonly string[]) => (ids.length < 2 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`);
const declared = (a: PolicySource, b: PolicySource) =>
  a.alsoPresentInOtherSource === 'unknown' || b.alsoPresentInOtherSource === 'unknown' || (a.alsoPresentInOtherSource === 'yes' && a.relatedSource === b.id) || (b.alsoPresentInOtherSource === 'yes' && b.relatedSource === a.id);

// Strict ISO 8601: a calendar date, or a date-time with seconds optional and a Z or +-HH:MM offset.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2})))?$/;
const DAY_MS = 86_400_000;
function instant(v: unknown): { t: number; dateOnly: boolean } | null {
  if (typeof v !== 'string') return null;
  const m = ISO_RE.exec(v);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, sec = 0] = [1, 2, 3, 4, 5, 6].map((i) => (m[i] === undefined ? undefined : Number(m[i]))) as number[];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || sec > 59) return null;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : { t, dateOnly: m[4] === undefined };
}
/** Half-open [s, e) in epoch ms, or null when the period is not a valid interval. */
type Span = { s: number; e: number } | null;
function spanOf(p: PolicySource['period']): Span {
  const a = instant(p.start);
  const b = instant(p.end);
  if (!a || !b || !(a.t < b.t)) return null;
  const e = (p.endSemantics ?? 'exclusive') === 'exclusive' ? b.t : b.dateOnly ? b.t + DAY_MS : b.t + 1; // ms resolution
  return { s: a.t, e };
}
const spansOverlap = (x: Span, y: Span) => x === null || y === null || (x.s < y.e && y.s < x.e);
// Unknown accounts intersect everything; an invalid period overlaps everything.
const sameScope = (a: PolicySource, b: PolicySource, spans: Map<string, Span>) =>
  intersects(a.providers, b.providers) && (a.accounts === 'unknown' || b.accounts === 'unknown' || intersects(a.accounts, b.accounts)) && spansOverlap(spans.get(a.id)!, spans.get(b.id)!);

/** Does the prefer winner cover everything the loser declares? 'exceeds' is proven loss; 'unproven' cannot be ruled in or out. */
function preferCoverage(w: PolicySource, l: PolicySource, spans: Map<string, Span>): 'covers' | 'exceeds' | 'unproven' {
  const sw = spans.get(w.id)!;
  const sl = spans.get(l.id)!;
  if (sw && sl && (sl.s < sw.s || sl.e > sw.e)) return 'exceeds';
  const sameProviders = subset(l.providers, w.providers);
  if (sameProviders && w.accounts !== 'unknown' && l.accounts !== 'unknown') return subset(l.accounts, w.accounts) ? 'covers' : 'exceeds';
  return 'unproven';
}

function policyResolves(p: DedupPolicy, a: PolicySource, b: PolicySource): { ok: true; drop?: string } | { ok: false; detail: string } {
  if (p.kind === 'prefer') return p.prefer === a.id || p.prefer === b.id ? { ok: true, drop: p.prefer === a.id ? b.id : a.id } : { ok: false, detail: `the prefer policy for ${a.id} and ${b.id} must name one of them` };
  if (p.kind === 'split-by') {
    const la = p.subAccounts[a.id];
    const lb = p.subAccounts[b.id];
    const covers = (s: PolicySource, l?: string[]) => Array.isArray(l) && s.accounts !== 'unknown' && s.accounts.every((x) => l.includes(x));
    if (!covers(a, la) || !covers(b, lb) || intersects(la!, lb!)) return { ok: false, detail: `the split-by policy for ${a.id} and ${b.id} needs disjoint sub-account lists covering each source's declared accounts` };
    return { ok: true };
  }
  const ma = measuresFor(a.costBasis);
  const mb = measuresFor(b.costBasis);
  if (ma.length !== 1 || mb.length !== 1 || ma[0] === mb[0]) return { ok: false, detail: `the basis-per-measure policy for ${a.id} and ${b.id} needs one billed-only and one effective-only source` };
  return { ok: true };
}

/** Ids on a cycle of the winner -> loser graph (sorted). */
function cycleNodes(edges: Map<string, Set<string>>): string[] {
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>();
    const stack = [...(edges.get(from) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(edges.get(n) ?? []));
    }
    return false;
  };
  return [...edges.keys()].filter((n) => reaches(n, n)).sort();
}

/** Scope a set of headline sources covers; equal only when provably equal. */
function sameMeasureScope(x: readonly PolicySource[], y: readonly PolicySource[], spans: Map<string, Span>): boolean {
  const providers = (l: readonly PolicySource[]) => l.flatMap((s) => s.providers);
  const accounts = (l: readonly PolicySource[]) => (l.some((s) => s.accounts === 'unknown') ? null : l.flatMap((s) => s.accounts as string[]));
  const bounds = (l: readonly PolicySource[]) => {
    const sp = l.map((s) => spans.get(s.id));
    return sp.some((v) => !v) ? null : { s: Math.min(...sp.map((v) => v!.s)), e: Math.max(...sp.map((v) => v!.e)) };
  };
  const [ax, ay, bx, by] = [accounts(x), accounts(y), bounds(x), bounds(y)];
  return sameSet(providers(x), providers(y)) && ax !== null && ay !== null && sameSet(ax, ay) && bx !== null && by !== null && bx.s === by.s && bx.e === by.e;
}

export function evaluateSourcePolicy(sources: readonly PolicySource[], policies: readonly DedupPolicy[] = []): PolicyResult {
  const problems: PolicyProblem[] = [];
  const overlapProblems: PolicyProblem[] = [];
  const warnings: PolicyWarning[] = [];
  const excluded: PolicyResult['excluded'] = [];
  const ids = new Set(sources.map((s) => s.id));
  const pairKey = (x: string, y: string) => [x, y].sort().join('\u0000');
  const byPair = new Map<string, DedupPolicy>();
  for (const p of policies) {
    if (!p.sources.every((id) => ids.has(id)) || p.sources[0] === p.sources[1]) problems.push({ code: 'POLICY_INVALID', sources: [...p.sources], detail: `a ${p.kind} policy names a source that is not configured` });
    else byPair.set(pairKey(...p.sources), p);
  }
  // The config validator (R1) already refuses this; the pure policy reports it too. The value is not echoed.
  for (const s of sources) if (s.relatedSource !== 'none' && (s.relatedSource === s.id || !ids.has(s.relatedSource))) problems.push({ code: 'RELATED_SOURCE_MISSING', sources: [s.id], detail: `source ${s.id} names a related_source that is not another configured source` });
  const financial = sources.filter((s) => {
    if (s.role === 'unknown') excluded.push({ id: s.id, reason: 'source role unknown; excluded from headline totals' });
    else if (s.role === 'authoritative' && measuresFor(s.costBasis).length === 0) excluded.push({ id: s.id, reason: 'cost basis unknown; excluded from headline totals' });
    else return s.role === 'authoritative' || s.role === 'allocated';
    return false;
  });
  const spans = new Map<string, Span>(financial.map((s) => [s.id, spanOf(s.period)]));
  for (const s of financial) if (spans.get(s.id) === null) problems.push({ code: 'PERIOD_INVALID', sources: [s.id], detail: `the period of source ${s.id} is not a valid ISO 8601 interval with a UTC offset (start before end); treated as overlapping` });
  const droppedBy = new Map<string, string[]>(); // loser -> winners, in evaluation order
  const preferEdges = new Map<string, Set<string>>(); // winner -> losers
  for (let i = 0; i < financial.length; i++) {
    for (let j = i + 1; j < financial.length; j++) {
      const [a, b] = [financial[i], financial[j]].sort((x, y) => (x.id < y.id ? -1 : 1));
      if (a.role !== b.role) continue; // an allocation of the bill is expected to cover the same scope
      const isDeclared = declared(a, b);
      if (!isDeclared && !sameScope(a, b, spans)) continue;
      const p = byPair.get(pairKey(a.id, b.id));
      const r = p ? policyResolves(p, a, b) : undefined;
      if (r?.ok) {
        if (r.drop) {
          const w = r.drop === a.id ? b : a;
          const l = r.drop === a.id ? a : b;
          const cov = preferCoverage(w, l, spans);
          if (cov === 'exceeds') {
            problems.push({ code: 'PREFER_UNDERCOUNTS', sources: [w.id, l.id], detail: `preferring ${w.id} over ${l.id} would drop accounts or a period that ${w.id} does not cover; use split-by, or prefer a source that covers ${l.id}` });
            continue;
          }
          if (cov === 'unproven') warnings.push({ code: 'PREFER_MAY_UNDERCOUNT', sources: [w.id, l.id], detail: `preferring ${w.id} over ${l.id} may undercount: it cannot be proven that ${w.id} covers ${l.id} (unknown accounts or different providers)` });
          droppedBy.set(l.id, [...(droppedBy.get(l.id) ?? []), w.id]);
          preferEdges.set(w.id, new Set([...(preferEdges.get(w.id) ?? []), l.id]));
        }
        continue;
      }
      if (r) problems.push({ code: 'POLICY_INVALID', sources: [a.id, b.id], detail: r.detail });
      const fix = 'name a dedup policy (prefer, split-by or basis-per-measure)';
      const detail =
        a.role === 'allocated' ? `sources ${a.id} and ${b.id} are both allocated over the same scope; name a prefer policy`
        : isDeclared ? `sources ${a.id} and ${b.id} may overlap (declared in the config, or not ruled out); ${fix}`
        : `sources ${a.id} and ${b.id} overlap (same provider, accounts and period); ${fix}`;
      overlapProblems.push({ code: 'OVERLAP_UNRESOLVED', sources: [a.id, b.id], detail });
    }
  }
  const cycle = cycleNodes(preferEdges);
  if (cycle.length > 0) problems.push({ code: 'POLICY_INVALID', sources: cycle, detail: `the prefer policies for ${names(cycle)} form a cycle, so no source would remain; break the cycle` });
  problems.push(...overlapProblems);
  for (const [id, winners] of droppedBy) excluded.push({ id, reason: `overlaps ${names([...new Set(winners)].sort())}; excluded by its prefer policy` });
  const ok = problems.length === 0;
  const live = financial.filter((s) => !droppedBy.has(s.id));
  const auth = ok ? live.filter((s) => s.role === 'authoritative') : [];
  const billed = auth.filter((s) => measuresFor(s.costBasis).includes('billed'));
  const effective = auth.filter((s) => measuresFor(s.costBasis).includes('effective'));
  if (billed.length > 0 && effective.length > 0 && !sameSet(billed, effective) && !sameMeasureScope(billed, effective, spans)) {
    const only = auth.filter((s) => billed.includes(s) !== effective.includes(s)).map((s) => s.id).sort(); // non-empty: the sets differ
    warnings.push({
      code: 'MEASURE_SCOPE_DIFFERS',
      sources: only,
      detail: `the billed headline (${names(billed.map((s) => s.id))}) and the effective headline (${names(effective.map((s) => s.id))}) cover a scope that differs or cannot be proven equal; each total covers only its own sources`,
    });
  }
  return {
    ok,
    problems,
    warnings,
    headline: { billed: billed.map((s) => s.id), effective: effective.map((s) => s.id) },
    allocated: live.filter((s) => s.role === 'allocated').map((s) => (ids.has(s.relatedSource) ? { id: s.id, allocates: s.relatedSource } : { id: s.id })),
    nonFinancial: sources.filter((s) => NON_FINANCIAL_ROLES.includes(s.role)).map((s) => s.id),
    excluded,
  };
}

/**
 * The headline sources per measure for the configured sources, with the warnings that must be shown next to
 * the totals; throws SourcePolicyError (startup refusal) on any problem.
 */
export function headlineEligibleSources(sources: readonly EngagementSource[], policies: readonly DedupPolicy[] = []): { headline: Record<HeadlineMeasure, string[]>; warnings: PolicyWarning[] } {
  const r = evaluateSourcePolicy(sources.map(fromEngagementSource), policies);
  if (!r.ok) throw new SourcePolicyError(r.problems);
  return { headline: r.headline, warnings: r.warnings };
}
