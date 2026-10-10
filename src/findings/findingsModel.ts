// Findings view-model — Wave 4 Slice 5 (grounded recommendation math).
// Ranks workloads worst value-ratio first; the recommended action + projected
// monthly impact are computed by the rule-driven engine in recommendationMath.ts
// from the model registry, budget profile, demand-shape factors, and the
// value-ratio invariant. No placeholder strings, no invented figures.

import { WORKLOADS } from '@/data/workloads';
import { ratioColor } from '@/lib/scales';
import { CACHE_HIT_RATE_MATERIAL, deriveCacheEconomics } from '@/lib/derive';
import { headlineEvidenceStatus } from '@/lib/valueEvidence';
import type { EvidenceStatus, Workload } from '@/types';
import {
  recommendFor,
  VALUE_MINIMUM,
  type RecommendationKind,
} from './recommendationMath';

export { VALUE_MINIMUM };

export interface FindingView {
  workloadId: string;
  workloadName: string;
  /** Evidence #1: current value ratio. */
  valueRatio: number;
  /** Ratio color from the existing ratio color scale. */
  valueColor: string;
  /** Evidence #2: current monthly spend. */
  monthlySpend: number;
  /**
   * Provenance mark on the value ratio — the weakest value input's status
   * (audit C1/C2). `undefined` when the value carries no evidence block; the
   * UI then renders the ratio unmarked rather than inventing a status.
   */
  valueEvidenceStatus?: EvidenceStatus;
  /** One-line problem summary. */
  problem: string;
  /** Single recommended action, derived from real rules (recommendationMath). */
  recommendedAction: string;
  /** Which rule produced the action — drives quiet UI labeling. */
  recommendationKind: RecommendationKind;
  /**
   * Projected monthly impact — hero figure. Computed from registry pricing +
   * current volume + the value-ratio math. `null` when the chosen action's
   * impact cannot be computed from available data (shown as "not quantified").
   */
  projectedMonthlyImpact: number | null;
  /** Value ratio after the action (equal-value assumption); `null` when N/A. */
  projectedRatio: number | null;
  /** What the projected figure is computed from (honest basis line). */
  impactBasis: string;
  /** Confidence / assumption qualifier shown beneath the figure. */
  confidenceNote: string;
  /** True when ratio is below the Gate 3 configured minimum. */
  belowMinimum: boolean;
  /**
   * Cache-evidence chip data (audit A3) — populated ONLY where cache economics
   * materially shape this workload's cost: hit rate ≥ CACHE_HIT_RATE_MATERIAL
   * AND a nonzero cached-rate discount. Null elsewhere; the chip never states
   * a claim the token counts and registry rates don't support.
   */
  cacheEvidence: {
    hitRate: number;
    cachedTokens: number;
    totalInputTokens: number;
    cachedRatePer1m: number;
    uncachedRatePer1m: number;
    cacheDiscountDaily: number;
  } | null;
}

/** Build findings sorted worst value-ratio first. */
export function buildFindings(workloads: Workload[] = WORKLOADS): FindingView[] {
  return workloads
    .map((w): FindingView => {
      const ratio = w.value.value_ratio;
      const rec = recommendFor(w);

      const econ = deriveCacheEconomics(w);
      const cacheEvidence =
        econ.hitRate !== null &&
        econ.hitRate >= CACHE_HIT_RATE_MATERIAL &&
        econ.cacheDiscountDaily > 0
          ? {
              hitRate: econ.hitRate,
              cachedTokens: econ.cachedTokens,
              totalInputTokens: econ.cachedTokens + econ.uncachedInputTokens,
              cachedRatePer1m: econ.cachedRatePer1m,
              uncachedRatePer1m: econ.uncachedRatePer1m,
              cacheDiscountDaily: econ.cacheDiscountDaily,
            }
          : null;

      const problem =
        ratio < 1.0
          ? 'Below break-even — spend exceeds value returned'
          : ratio < VALUE_MINIMUM
            ? `Returning ${ratio.toFixed(1)}\u00d7 — below the ${VALUE_MINIMUM}\u00d7 value minimum`
            : `Returning ${ratio.toFixed(1)}\u00d7 value per inference dollar`;

      return {
        workloadId: w.id,
        workloadName: w.name,
        valueRatio: ratio,
        valueColor: ratioColor(ratio),
        monthlySpend: w.costs.monthly_spend,
        valueEvidenceStatus: headlineEvidenceStatus(w.value),
        problem,
        recommendedAction: rec.action,
        recommendationKind: rec.kind,
        projectedMonthlyImpact: rec.projectedMonthlyImpact,
        projectedRatio: rec.projectedRatio,
        impactBasis: rec.basis,
        confidenceNote: rec.confidence,
        belowMinimum: ratio < VALUE_MINIMUM,
        cacheEvidence,
      };
    })
    .sort((a, b) => a.valueRatio - b.valueRatio);
}
