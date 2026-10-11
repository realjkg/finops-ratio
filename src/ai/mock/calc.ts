// Analytics calculators: pure functions over WorkloadFacts. No formatting and
// no I/O here. Group figures are value-dollar weighted (sum value / sum spend),
// never a mean of ratios, and a group's evidence status is the weakest of its
// members (a chain is as weak as its weakest link — audit C2).

import { findModel } from '@/data/models';
import { weakestStatus } from '@/lib/valueEvidence';
import { DAYS_PER_MONTH, resolveAssumptions, type Overrides, type ResolvedAssumptions } from './assumptions';
import type { Baselines } from './parse';
import type { Rollup, Scope, World, WorkloadFacts } from './types';

export function rollup(members: WorkloadFacts[]): Rollup {
  const spend = members.reduce((s, w) => s + w.monthlySpend, 0);
  const value = members.reduce((s, w) => s + w.monthlyValue, 0);
  return {
    members,
    spend,
    value,
    ratio: spend > 0 ? value / spend : null,
    evidence: weakestStatus(members.map((w) => w.evidence)),
  };
}

export function membersOf(world: World, scope: Scope): WorkloadFacts[] {
  switch (scope.kind) {
    case 'portfolio':
      return world.workloads;
    case 'team':
      return world.workloads.filter((w) => w.team === scope.team);
    case 'workload':
      return world.workloads.filter((w) => w.id === scope.id);
    case 'model':
      return world.workloads.filter((w) => w.model === scope.model);
  }
}

export function scopeLabel(world: World, scope: Scope): string {
  switch (scope.kind) {
    case 'portfolio':
      return 'Portfolio';
    case 'team':
      return scope.team;
    case 'workload':
      return world.workloads.find((w) => w.id === scope.id)?.name ?? scope.id;
    case 'model':
      return scope.model;
  }
}

/** Header suffix naming the scope kind, e.g. "Legal (team)". */
export function scopeTitle(world: World, scope: Scope): string {
  return scope.kind === 'portfolio' ? 'Portfolio' : `${scopeLabel(world, scope)} (${scope.kind})`;
}

export const byValueDesc = (a: WorkloadFacts, b: WorkloadFacts): number => b.monthlyValue - a.monthlyValue;
export const bySpendDesc = (a: WorkloadFacts, b: WorkloadFacts): number => b.monthlySpend - a.monthlySpend;

/** Strongest and weakest member by value ratio (members without a ratio are skipped). */
export function extremes(members: WorkloadFacts[]): { strongest: WorkloadFacts; weakest: WorkloadFacts } | null {
  const rated = members.filter((w) => w.ratio !== null);
  if (rated.length < 2) return null;
  const sorted = [...rated].sort((a, b) => (b.ratio as number) - (a.ratio as number));
  return { strongest: sorted[0], weakest: sorted[sorted.length - 1] };
}

export interface TeamRow {
  team: string;
  roll: Rollup;
  savings: number;
}

export function teamRows(world: World): TeamRow[] {
  return world.teams.map((team) => {
    const members = world.workloads.filter((w) => w.team === team);
    return { team, roll: rollup(members), savings: members.reduce((s, w) => s + w.savings, 0) };
  });
}

export type RankMetric = 'cost' | 'roi' | 'savings';

export function rankTeams(world: World, metric: RankMetric, ascending: boolean): TeamRow[] {
  const key = (r: TeamRow): number =>
    metric === 'cost' ? r.roll.spend : metric === 'savings' ? r.savings : (r.roll.ratio ?? Number.NEGATIVE_INFINITY);
  return [...teamRows(world)].sort((a, b) => (ascending ? key(a) - key(b) : key(b) - key(a)));
}

// ------------------------------------------------------------------ EBITDA

/** Seeded MoM trend: prior spend = spend / (1 + pct/100). Positive = spend rose. */
export function impliedMonthlyChange(members: WorkloadFacts[]): { change: number; prior: number } | null {
  const rated = members.filter((w) => w.costTrendPct !== null && (w.costTrendPct as number) > -100);
  if (rated.length === 0) return null;
  let change = 0;
  let prior = 0;
  for (const w of rated) {
    const p = w.monthlySpend / (1 + (w.costTrendPct as number) / 100);
    prior += p;
    change += w.monthlySpend - p;
  }
  return { change, prior };
}

export interface EbitdaEffect {
  annualImprovement: number;
  ebitdaBefore?: number;
  ebitdaAfter?: number;
  /** null when the baseline is zero or negative (a percentage is not defined). */
  ebitdaPct?: number | null;
  revenue?: number;
  marginBefore?: number;
  marginAfter?: number;
  marginPoints?: number;
  /** EBITDA was derived from revenue x a stated margin. */
  derivedFromMargin: boolean;
}

/** A recurring operating-cost reduction raises EBITDA one-for-one (pre-tax). */
export function ebitdaEffect(monthlyReduction: number, b: Baselines): EbitdaEffect {
  const annual = monthlyReduction * 12;
  const out: EbitdaEffect = { annualImprovement: annual, derivedFromMargin: false };
  let base = b.ebitda;
  const rev = b.revenue !== undefined && b.revenue > 0 ? b.revenue : undefined;
  if (base === undefined && rev !== undefined && b.marginPct !== undefined) {
    base = (rev * b.marginPct) / 100;
    out.derivedFromMargin = true;
  }
  if (base !== undefined) {
    out.ebitdaBefore = base;
    out.ebitdaAfter = base + annual;
    out.ebitdaPct = base > 0 ? (annual / base) * 100 : null;
  }
  if (rev !== undefined) {
    out.revenue = rev;
    out.marginPoints = (annual / rev) * 100;
    if (base !== undefined) {
      out.marginBefore = (base / rev) * 100;
      out.marginAfter = ((base + annual) / rev) * 100;
    }
  }
  return out;
}

// --------------------------------------------------------------- migration

export interface MemberCost {
  member: WorkloadFacts;
  tokens: number;
  api: number;
}

export interface Migration {
  kind: 'ok';
  a: ResolvedAssumptions;
  parts: MemberCost[];
  tokens: number;
  api: number;
  perGpuTokens: number;
  gpus: number;
  neededGpus: number;
  coverage: number;
  gpuCost: number;
  selfHost: number;
  saving: number;
  oneTime: number;
  payback: number | null;
  breakEvenTokens: number | null;
  /** Members whose registry model is unknown or whose volume is missing. */
  unpriced: WorkloadFacts[];
}

export type MigrationResult = Migration | { kind: 'no-volume'; unpriced: WorkloadFacts[] };

/** Public-API list-price cost vs a pooled self-hosted cluster for the same tokens. */
export function migration(members: WorkloadFacts[], overrides: Overrides = {}): MigrationResult {
  const a = resolveAssumptions(overrides);
  const parts: MemberCost[] = [];
  const unpriced: WorkloadFacts[] = [];
  for (const w of members) {
    const model = w.model ? findModel(w.model) : undefined;
    if (!model || w.tokIn === null || w.tokOut === null || w.tokCached === null) {
      unpriced.push(w);
      continue;
    }
    const inT = w.tokIn * DAYS_PER_MONTH;
    const outT = w.tokOut * DAYS_PER_MONTH;
    const cT = w.tokCached * DAYS_PER_MONTH;
    const cachedRate = model.pricing.cached_input_per_1m ?? model.pricing.input_per_1m * 0.25;
    const api =
      (inT / 1e6) * model.pricing.input_per_1m +
      (outT / 1e6) * model.pricing.output_per_1m +
      (cT / 1e6) * cachedRate;
    parts.push({ member: w, tokens: inT + outT + cT, api });
  }
  const tokens = parts.reduce((s, p) => s + p.tokens, 0);
  const api = parts.reduce((s, p) => s + p.api, 0);
  if (!(tokens > 0)) return { kind: 'no-volume', unpriced };

  const perGpuTokens = a.tokensPerSecondPerGpu * a.utilisation * 3600 * a.hoursPerMonth;
  const neededGpus = Math.max(1, Math.ceil(tokens / perGpuTokens));
  const gpus = a.gpuCount ?? Math.max(a.minGpus, neededGpus);
  const gpuCost = gpus * a.gpuHourlyUsd * a.hoursPerMonth;
  const selfHost = gpuCost * (1 + a.opsOverheadPct);
  const saving = api - selfHost;
  return {
    kind: 'ok',
    a,
    parts,
    tokens,
    api,
    perGpuTokens,
    gpus,
    neededGpus,
    coverage: (gpus * perGpuTokens) / tokens,
    gpuCost,
    selfHost,
    saving,
    oneTime: a.migrationOneTimeUsd,
    payback: saving > 0 ? a.migrationOneTimeUsd / saving : null,
    breakEvenTokens: api > 0 ? (selfHost * tokens) / api : null,
    unpriced,
  };
}
