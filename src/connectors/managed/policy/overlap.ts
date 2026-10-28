// M0c: overlap and headline eligibility. Pure; consumed by the read model (R5)
// and by startup checks. Overlapping financial sources are never combined
// without an explicit dedup policy: two authoritative (or two allocated)
// sources whose scope intersects, or whose config declares (or does not rule
// out) overlap, give OVERLAP_UNRESOLVED. Problems name source ids and codes,
// never account identifiers or amounts.
//
// Dedup policies (until the R1 schema carries them, callers pass them in):
//   prefer             the preferred source wins; the other leaves the headline (or allocated view) entirely.
//                      Row-level partial dedup is not supported in 1.0, so prefer may undercount, visibly.
//   split-by           disjoint sub-account lists, each covering its source's declared accounts.
//   basis-per-measure  one source feeds billed only, the other effective only (e.g. actual + amortized).
import type { EngagementSource } from '../../../engagement/config';
import { NON_FINANCIAL_ROLES, measuresFor, type CostBasis, type HeadlineMeasure, type SourceRole } from './roles';

export interface PolicySource {
  id: string;
  role: SourceRole;
  costBasis: CostBasis;
  providers: string[];
  accounts: string[] | 'unknown';
  period: { start: string; end: string };
  alsoPresentInOtherSource: 'yes' | 'no' | 'unknown';
  relatedSource: string;
}

export type DedupPolicy =
  | { kind: 'prefer'; sources: [string, string]; prefer: string }
  | { kind: 'split-by'; sources: [string, string]; subAccounts: Record<string, string[]> }
  | { kind: 'basis-per-measure'; sources: [string, string] };

export interface PolicyProblem { code: 'OVERLAP_UNRESOLVED' | 'POLICY_INVALID'; sources: string[]; detail: string }
export interface PolicyResult {
  ok: boolean;
  problems: PolicyProblem[];
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
    period: { start: m.scope.period_start, end: m.scope.period_end }, alsoPresentInOtherSource: m.overlap.also_present_in_other_source, relatedSource: m.overlap.related_source,
  };
}

const intersects = <T>(a: readonly T[], b: readonly T[]) => a.some((x) => b.includes(x));
const declared = (a: PolicySource, b: PolicySource) =>
  a.alsoPresentInOtherSource === 'unknown' || b.alsoPresentInOtherSource === 'unknown' || (a.alsoPresentInOtherSource === 'yes' && a.relatedSource === b.id) || (b.alsoPresentInOtherSource === 'yes' && b.relatedSource === a.id);
// Periods compared inclusively (conservative); unknown accounts intersect everything.
const sameScope = (a: PolicySource, b: PolicySource) =>
  intersects(a.providers, b.providers) && (a.accounts === 'unknown' || b.accounts === 'unknown' || intersects(a.accounts, b.accounts)) && a.period.start <= b.period.end && b.period.start <= a.period.end;

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

export function evaluateSourcePolicy(sources: readonly PolicySource[], policies: readonly DedupPolicy[] = []): PolicyResult {
  const problems: PolicyProblem[] = [];
  const overlapProblems: PolicyProblem[] = [];
  const excluded: PolicyResult['excluded'] = [];
  const ids = new Set(sources.map((s) => s.id));
  const pairKey = (x: string, y: string) => [x, y].sort().join('\u0000');
  const byPair = new Map<string, DedupPolicy>();
  for (const p of policies) {
    if (!p.sources.every((id) => ids.has(id)) || p.sources[0] === p.sources[1]) problems.push({ code: 'POLICY_INVALID', sources: [...p.sources], detail: `a ${p.kind} policy names a source that is not configured` });
    else byPair.set(pairKey(...p.sources), p);
  }
  const financial = sources.filter((s) => {
    if (s.role === 'unknown') excluded.push({ id: s.id, reason: 'source role unknown; excluded from headline totals' });
    else if (s.role === 'authoritative' && measuresFor(s.costBasis).length === 0) excluded.push({ id: s.id, reason: 'cost basis unknown; excluded from headline totals' });
    else return s.role === 'authoritative' || s.role === 'allocated';
    return false;
  });
  const dropped = new Set<string>();
  for (let i = 0; i < financial.length; i++) {
    for (let j = i + 1; j < financial.length; j++) {
      const [a, b] = [financial[i], financial[j]].sort((x, y) => (x.id < y.id ? -1 : 1));
      if (a.role !== b.role) continue; // an allocation of the bill is expected to cover the same scope
      const isDeclared = declared(a, b);
      if (!isDeclared && !sameScope(a, b)) continue;
      const p = byPair.get(pairKey(a.id, b.id));
      const r = p ? policyResolves(p, a, b) : undefined;
      if (r?.ok) {
        if (r.drop) dropped.add(r.drop);
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
  problems.push(...overlapProblems);
  for (const id of dropped) {
    const winner = policies.find((p) => p.kind === 'prefer' && p.sources.includes(id)) as Extract<DedupPolicy, { kind: 'prefer' }>;
    excluded.push({ id, reason: `overlaps ${winner.prefer}; excluded by its prefer policy` });
  }
  const ok = problems.length === 0;
  const live = financial.filter((s) => !dropped.has(s.id));
  const auth = ok ? live.filter((s) => s.role === 'authoritative') : [];
  return {
    ok,
    problems,
    headline: { billed: auth.filter((s) => measuresFor(s.costBasis).includes('billed')).map((s) => s.id), effective: auth.filter((s) => measuresFor(s.costBasis).includes('effective')).map((s) => s.id) },
    allocated: live.filter((s) => s.role === 'allocated').map((s) => (ids.has(s.relatedSource) ? { id: s.id, allocates: s.relatedSource } : { id: s.id })),
    nonFinancial: sources.filter((s) => NON_FINANCIAL_ROLES.includes(s.role)).map((s) => s.id),
    excluded,
  };
}

/** The headline sources per measure for the configured sources; throws SourcePolicyError (startup refusal) on any problem. */
export function headlineEligibleSources(sources: readonly EngagementSource[], policies: readonly DedupPolicy[] = []): Record<HeadlineMeasure, string[]> {
  const r = evaluateSourcePolicy(sources.map(fromEngagementSource), policies);
  if (!r.ok) throw new SourcePolicyError(r.problems);
  return r.headline;
}
