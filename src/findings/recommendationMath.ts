// Grounded recommendation math — Wave 4 Slice 5.
//
// Replaces the Slice-1 placeholder action/impact with rule-driven computation
// over existing model registry, budget profile, demand-shape factors, and the
// value-ratio invariant. Every figure traces to stored data; nothing is invented.
//
// Honest-risk guardrail (R4 / obvious.md UI Direction): the projected figure is
// a *conditional* projection, never a guaranteed saving. Each recommendation
// carries its computation basis + an assumption note, and an action whose impact
// cannot be computed from available data returns `null` ("not quantified")
// rather than a fabricated number. The UI must never outrun this rigor.

import type {
  ModelEntry,
  CostTier,
  DemandShape,
  Workload,
  WorkloadGovernance,
} from '@/types';
import { MODEL_REGISTRY, findModel } from '@/data/models';
import { budgetFor } from '@/data/budgets';
import { modelDailyCost, type VolumeProfile } from '@/lib/modelCompare';
import { SHAPE_FACTOR, SHAPE_LABEL, alwaysOnBaseline } from '@/lib/demandShape';
import { formatUSD, formatRatio, formatPct } from '@/lib/format';

// Gate 3 configured minimum value ratio (obvious.md Governance Gates, default 3×).
export const VALUE_MINIMUM = 3.0;
// Value-critical floor (obvious.md Alert & Threshold Rules: below 2× → critical).
export const VALUE_CRITICAL = 2.0;

export type RecommendationKind =
  | 'model_switch'
  | 'demand_shaping'
  | 'governance_gate'
  | 'sunset_review'
  | 'monitor';

export interface Recommendation {
  kind: RecommendationKind;
  /** Single recommended action — the only one surfaced in the pane. */
  action: string;
  /**
   * Projected monthly USD impact (the hero figure). `null` means the impact
   * cannot be computed from available data — shown honestly as "not quantified",
   * never fabricated.
   */
  projectedMonthlyImpact: number | null;
  /** Value ratio after the action (equal-value assumption); `null` when N/A. */
  projectedRatio: number | null;
  /** What the figure is computed from (shown as the basis line). */
  basis: string;
  /** Confidence / assumption qualifier (shown as the confidence note). */
  confidence: string;
}

// --- Volume profile -------------------------------------------------------

// Per-call token mix derived from the workload's stored daily volumes. Token
// price is linear in volume, so the cost *ratio* between two models is volume-
// independent — we apply it to the stored monthly_spend for the projection.
function volumeProfile(w: Workload): VolumeProfile {
  const calls = w.outputs.daily_inferences;
  return {
    calls,
    avgInputTokens: calls > 0 ? w.costs.tokens_in_today / calls : 0,
    avgOutputTokens: calls > 0 ? w.costs.tokens_out_today / calls : 0,
  };
}

// --- Model switch ---------------------------------------------------------

const TIER_RANK: Record<CostTier, number> = {
  economy: 0,
  standard: 1,
  premium: 2,
  ultra: 3,
};

// "Same capability" using the registry's own capability metadata: the candidate
// must match the current model's context window, max output, and feature flags,
// and sit no more than one cost tier below it. The one-tier guard keeps the
// equal-value assumption defensible — a cliff from premium to economy is a real
// capability downgrade the registry's booleans alone would not catch.
function sameCapability(current: ModelEntry, candidate: ModelEntry): boolean {
  return (
    candidate.context_window >= current.context_window &&
    candidate.max_output >= current.max_output &&
    (!current.supports_vision || candidate.supports_vision) &&
    (!current.supports_tools || candidate.supports_tools) &&
    (!current.supports_streaming || candidate.supports_streaming) &&
    TIER_RANK[candidate.cost_tier] >= TIER_RANK[current.cost_tier] - 1
  );
}

// Cheapest capability-preserving alternative + its cost ratio vs. the current
// model at this workload's token mix. `null` when none is cheaper.
export function cheaperSameCapabilityModel(
  w: Workload,
): { model: ModelEntry; costRatio: number } | null {
  const current = findModel(w.model);
  if (!current) return null;
  const vol = volumeProfile(w);
  const currentDaily = modelDailyCost(current, vol).total;
  if (currentDaily <= 0) return null;

  let best: { model: ModelEntry; costRatio: number } | null = null;
  for (const candidate of MODEL_REGISTRY) {
    if (candidate.id === current.id) continue;
    if (!sameCapability(current, candidate)) continue;
    const costRatio = modelDailyCost(candidate, vol).total / currentDaily;
    if (costRatio >= 1) continue; // not cheaper
    if (!best || costRatio < best.costRatio) best = { model: candidate, costRatio };
  }
  return best;
}

function modelSwitchCandidate(w: Workload): Recommendation | null {
  // A non-positive numerator breaks the equal-value premise: with negative
  // value, lower spend makes the ratio MORE negative — a switch cannot rescue
  // the workload, so do not offer one (audit C3/C4).
  if (w.value.total_value <= 0) return null;
  const current = findModel(w.model);
  const alt = cheaperSameCapabilityModel(w);
  if (!current || !alt) return null;

  // Equal-value assumption: same value, lower spend ⇒ recomputed monthly spend
  // and a higher value ratio (value-ratio invariant).
  const newSpend = w.costs.monthly_spend * alt.costRatio;
  const impact = round0(w.costs.monthly_spend - newSpend);
  if (impact <= 0) return null;
  const projectedRatio = round1(w.value.value_ratio / alt.costRatio);

  return {
    kind: 'model_switch',
    action: `Switch to ${alt.model.display_name} — same capability tier, ${formatPct(
      1 - alt.costRatio,
    )} lower token cost`,
    projectedMonthlyImpact: impact,
    projectedRatio,
    basis: `Registry pricing (${current.display_name} → ${alt.model.display_name}) × current token mix; equal-value assumption lifts the ratio ${formatRatio(
      w.value.value_ratio,
    )} → ${formatRatio(projectedRatio)}`,
    confidence: `Assumes ${alt.model.display_name} holds ${current.display_name}'s resolution quality at this volume — validate on a canary before cutover; not a guaranteed saving.`,
  };
}

// --- Demand shaping -------------------------------------------------------

// Workloads with shaping headroom (running hotter than a managed schedule).
function demandShapingCandidate(w: Workload): Recommendation | null {
  if (w.demand_shape !== 'always_on' && w.demand_shape !== 'unmanaged') return null;

  const target: DemandShape = 'business_hours';
  const baseline = alwaysOnBaseline(w);
  const newSpend = baseline * SHAPE_FACTOR[target];
  const impact = round0(w.costs.monthly_spend - newSpend);
  if (impact <= 0) return null;
  const projectedRatio = newSpend > 0 ? round1(w.value.total_value / newSpend) : null;

  return {
    kind: 'demand_shaping',
    action: `Shape demand to ${SHAPE_LABEL[target]} — idle overnight and weekends`,
    projectedMonthlyImpact: impact,
    projectedRatio,
    basis: `Demand-shape factor (${SHAPE_LABEL[w.demand_shape]} → ${SHAPE_LABEL[target]}) applied to current run rate; recomputed spend ${formatUSD(
      round0(newSpend),
    )}/mo`,
    confidence: `Assumes off-peak demand is deferrable without lost value — a projection, not a guaranteed saving.`,
  };
}

// --- Governance gate ------------------------------------------------------

type GovernanceGateField =
  | 'policy_check'
  | 'ethics_review'
  | 'cost_approval'
  | 'scale_authorized';

const GATE_SEQUENCE: ReadonlyArray<{ field: GovernanceGateField; label: string }> = [
  { field: 'policy_check', label: 'Policy' },
  { field: 'ethics_review', label: 'Ethics' },
  { field: 'cost_approval', label: 'Cost' },
  { field: 'scale_authorized', label: 'Scale' },
];

function governanceGateCandidate(w: Workload): Recommendation | null {
  const next = GATE_SEQUENCE.find((g) => !(w.governance as WorkloadGovernance)[g.field]);
  if (!next) return null;
  return {
    kind: 'governance_gate',
    action: `Complete the ${next.label} governance gate before scaling`,
    projectedMonthlyImpact: null, // a prerequisite, not a dollar saving
    projectedRatio: null,
    basis: `Governance gate sequence (Policy → Ethics → Cost → Scale); ${next.label} is the next unpassed gate (R3: governance precedes scale)`,
    confidence: `Governance is a gate, not a saving — impact not quantified.`,
  };
}

// --- Sunset / monitor -----------------------------------------------------

function sunsetCandidate(w: Workload): Recommendation {
  const valueNegative = w.value.total_value <= 0;
  return {
    kind: 'sunset_review',
    action: valueNegative
      ? `Critical value review — sunset or renegotiate; counted value is ${formatUSD(
          w.value.total_value,
        )}/mo against ${formatUSD(w.costs.monthly_spend)} spend — misses and quality gaps outweigh claimed value`
      : `Critical value review — sunset or renegotiate; ${formatRatio(
          w.value.value_ratio,
        )} is below the ${VALUE_CRITICAL}× floor`,
    projectedMonthlyImpact: null, // sunsetting removes spend AND its value
    projectedRatio: null,
    basis: `Value-ratio invariant: ${formatUSD(w.value.total_value)} value ÷ ${formatUSD(
      w.costs.monthly_spend,
    )} spend = ${formatRatio(w.value.value_ratio)}`,
    confidence: `Sunsetting removes the spend and the value it returns — net impact not quantified; needs a value-owner decision.`,
  };
}

function monitorCandidate(w: Workload): Recommendation {
  return {
    kind: 'monitor',
    action: `Monitor — ${formatRatio(w.value.value_ratio)} is within the acceptable range`,
    projectedMonthlyImpact: null,
    projectedRatio: null,
    basis: `Value ratio ${formatRatio(w.value.value_ratio)} ≥ the ${VALUE_MINIMUM}× minimum; spend within budget`,
    confidence: `No action required — no quantified impact.`,
  };
}

// --- Selection ------------------------------------------------------------

// Rule-driven action selection, ordered by severity and grounded in stored data.
// Honesty-first: lower-assumption actions (demand shaping) are preferred over a
// cross-tier model downgrade where both could apply.
export function recommendFor(w: Workload): Recommendation {
  const ratio = w.value.value_ratio;
  const budget = budgetFor(w.id);
  const utilization =
    budget && budget.budget_amount > 0
      ? w.costs.monthly_spend / budget.budget_amount
      : 0;
  const killBreach = !!budget && utilization >= budget.kill_threshold_pct;

  const shapeRec = demandShapingCandidate(w);
  const switchRec = modelSwitchCandidate(w);

  // 0. Non-positive defensible numerator (audit C3/C4): the workload destroys
  //    value. No cost-side optimization rescues a negative numerator — cutting
  //    spend only deepens a negative ratio — so fix the value side first.
  if (w.value.total_value <= 0) return sunsetCandidate(w);

  // 1. Budget kill breach (spend ≥ 100% of budget) → throttle via demand shaping.
  if (killBreach && shapeRec) return shapeRec;

  // 2. Value-critical (<2×) → a capability-preserving switch rescues the ratio;
  //    fall back to shaping, then to a critical review when nothing computes.
  if (ratio < VALUE_CRITICAL) {
    if (switchRec) return switchRec;
    if (shapeRec) return shapeRec;
    return sunsetCandidate(w);
  }

  // 3. Below the 3× minimum → demand shaping first (lowest-assumption), else switch.
  if (ratio < VALUE_MINIMUM) {
    if (shapeRec) return shapeRec;
    if (switchRec) return switchRec;
  }

  // 4. Unmanaged demand (or budget breach) without a value problem → shaping.
  if ((w.demand_shape === 'unmanaged' || killBreach) && shapeRec) return shapeRec;

  // 5. Missing governance gate (R3) → recommend the next sequential gate.
  const gateRec = governanceGateCandidate(w);
  if (gateRec) return gateRec;

  // 6. Healthy.
  return monitorCandidate(w);
}

// --- rounding -------------------------------------------------------------

function round0(n: number): number {
  return Math.round(n);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

