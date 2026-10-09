// Pure attribution math — group-by/sum over the two dimensions, no side
// effects, no clock, no imports beyond types. Mirrors src/tokenomics/calculations.ts:
// every function takes fully named, typed inputs and guards its denominators.

import type { AgentQuery, Workload } from '@/types';
import type { AttributionDimension, AttributionRow } from './AttributionClient';

/**
 * Guarded share: numerator ÷ denominator, 0 when the denominator is 0 —
 * never NaN, never Infinity (the calculations.ts guard precedent).
 */
function share(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/** Σ a field of every record — 0 over an empty list. */
function sum(records: readonly number[]): number {
  return records.reduce((acc, v) => acc + v, 0);
}

/**
 * Team attribution: Σ workload costs + MTD tokens grouped by `workload.team`,
 * the rollup end of the ResourceId → workload → team join.
 *
 * Cost basis is the stored `costs.monthly_spend` (the same figure the FOCUS
 * seed emits as BilledCost) — aggregating the stored spend rather than
 * re-deriving it from tokens × registry pricing avoids double-derivation drift.
 */
export function teamAttributionRows(workloads: readonly Workload[]): AttributionRow[] {
  const totalInferenceCost = sum(workloads.map((w) => w.costs.monthly_spend));
  const byTeam = new Map<string, Workload[]>();
  for (const w of workloads) {
    const group = byTeam.get(w.team) ?? [];
    group.push(w);
    byTeam.set(w.team, group);
  }

  return [...byTeam.entries()]
    .map(([team, group]) => buildRow({
      dimension: 'team',
      key: team,
      tokensIn: sum(group.map((w) => w.costs.tokens_in_mtd)),
      tokensOut: sum(group.map((w) => w.costs.tokens_out_mtd)),
      inferenceCost: sum(group.map((w) => w.costs.monthly_spend)),
      totalInferenceCost,
      workloadIds: group.map((w) => w.id),
      recordCount: group.length,
      formulaLabel: 'share = Σ workload.costs.monthly_spend ÷ Σ all workload monthly_spend',
      basis:
        `Σ monthly_spend for ${group.length} workload(s) mapped via ResourceId ` +
        `arn:ratio:workload/<id> → workload → team; tokens are Σ tokens_{in,out}_mtd`,
    }))
    .sort(costDesc);
}

/**
 * User attribution: Σ sampled AgentQuery events grouped by `user_id`.
 *
 * Cost basis is the events' own `query_cost` (derived per event from the
 * referenced workload's model registry pricing). This is a SAMPLED log — its
 * totals are the log's own, not the portfolio's; `basis` says so on every row.
 */
export function userAttributionRows(events: readonly AgentQuery[]): AttributionRow[] {
  const totalInferenceCost = sum(events.map((e) => e.query_cost));
  const byUser = new Map<string, AgentQuery[]>();
  for (const e of events) {
    const group = byUser.get(e.user_id) ?? [];
    group.push(e);
    byUser.set(e.user_id, group);
  }

  return [...byUser.entries()]
    .map(([userId, group]) =>
      buildRow({
        dimension: 'user',
        key: userId,
        tokensIn: sum(group.map((e) => e.tokens_used.input)),
        tokensOut: sum(group.map((e) => e.tokens_used.output)),
        inferenceCost: sum(group.map((e) => e.query_cost)),
        totalInferenceCost,
        workloadIds: [...new Set(group.flatMap((e) => e.workloads_referenced))],
        recordCount: group.length,
        formulaLabel: 'share = Σ query_cost ÷ Σ all sampled query_cost',
        basis:
          `Σ query_cost over ${group.length} sampled AgentQuery events (demo log, ` +
          `month-to-date); tokens are Σ tokens_used — the log's own totals, not the portfolio's`,
      }))
    .sort(costDesc);
}

/** Build one honest row: sums in, share computed, the working carried along. */
function buildRow(args: {
  dimension: AttributionDimension;
  key: string;
  tokensIn: number;
  tokensOut: number;
  inferenceCost: number;
  totalInferenceCost: number;
  workloadIds: string[];
  recordCount: number;
  formulaLabel: string;
  basis: string;
}): AttributionRow {
  return {
    dimension: args.dimension,
    key: args.key,
    tokensIn: args.tokensIn,
    tokensOut: args.tokensOut,
    inferenceCost: args.inferenceCost,
    shareOfTotal: share(args.inferenceCost, args.totalInferenceCost),
    formulaLabel: args.formulaLabel,
    inputs: {
      workloadIds: args.workloadIds,
      recordCount: args.recordCount,
      summedInferenceCost: args.inferenceCost,
      totalInferenceCost: args.totalInferenceCost,
    },
    basis: args.basis,
  };
}

/** Worst burner first; key ascending breaks ties so ordering is deterministic. */
function costDesc(a: AttributionRow, b: AttributionRow): number {
  return b.inferenceCost - a.inferenceCost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
