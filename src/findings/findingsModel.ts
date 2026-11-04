// Findings view-model — Wave 4 Slice 5 (grounded recommendation math).
// Ranks workloads worst value-ratio first; the recommended action + projected
// monthly impact are computed by the rule-driven engine in recommendationMath.ts
// from the model registry, budget profile, demand-shape factors, and the
// value-ratio invariant. No placeholder strings, no invented figures.

import { WORKLOADS } from '@/data/workloads';
import { ratioColor } from '@/lib/scales';
import { CACHE_HIT_RATE_MATERIAL, deriveCacheEconomics } from '@/lib/derive';
import { headlineEvidenceStatus } from '@/lib/valueEvidence';
import { deriveWorkloadValue } from '@/lib/valueMath';
import { COPY, VOCAB, VALUE_COST_BREAK_EVEN } from '@/lib/vocabulary';
import { formatUSD } from '@/lib/format';
import { DEMO_NOW } from '@/data/workloads';
import type { EvidenceStatus, Workload } from '@/types';
import {
  recommendFor,
  VALUE_MINIMUM,
  type RecommendationKind,
} from './recommendationMath';

export { VALUE_MINIMUM };

/** Where Value / cost sits against its two reference points. */
export type TargetStatus = 'below_break_even' | 'below_target' | 'on_target';

export function targetStatusFor(ratio: number): TargetStatus {
  if (ratio < VALUE_COST_BREAK_EVEN) return 'below_break_even';
  return ratio < VALUE_MINIMUM ? 'below_target' : 'on_target';
}

/**
 * Everything "View calculation" shows: the formula, the period, the cost basis, the value
 * assumptions and the source. Built from the same pure function every surface reads
 * (lib/valueMath.ts), so the breakdown cannot disagree with the headline ratio.
 */
export interface FindingCalculation {
  formula: string;
  /** Period the cost and value figures cover, e.g. "Monthly · June 2026". */
  period: string;
  costBasis: string;
  monthlyCost: number;
  grossValue: number;
  /** Share of outputs meeting the quality floor, or null on legacy shapes (ungated). */
  qualityFloorPassRate: number | null;
  countedValue: number;
  harmFromMisses: number;
  netValue: number;
  /** Target minus ratio when below target, else null. Exact gap, kept off the main card. */
  gapToTarget: number | null;
  valueAssumptions: string;
  source: string;
}

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
  /** True when ratio is below the Gate 3 configured target. */
  belowMinimum: boolean;
  /** Below break-even, below target, or on target. */
  targetStatus: TargetStatus;
  /** One line for "Why this needs attention". */
  why: string;
  /** Contents of "View calculation". */
  calculation: FindingCalculation;
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

/** Build findings sorted lowest Value / cost first. */
export function buildFindings(workloads: Workload[] = WORKLOADS, now: Date = DEMO_NOW): FindingView[] {
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

      const defensible = deriveWorkloadValue(w);
      const targetStatus = targetStatusFor(ratio);
      const problem =
        targetStatus === 'on_target'
          ? `${VOCAB.valueToCost.label} ${ratio.toFixed(1)}\u00d7, at or above the ${VALUE_MINIMUM}\u00d7 target`
          : `Below target \u00b7 ${COPY.estimatedValue}`;
      const why =
        defensible.total_value <= 0
          ? `Harm from misses (${formatUSD(defensible.harm_from_misses)}) is larger than counted value (${formatUSD(defensible.counted_value)}), so estimated value is negative.`
          : targetStatus === 'below_break_even'
            ? `Estimated value (${formatUSD(defensible.total_value)}) does not cover monthly cost (${formatUSD(w.costs.monthly_spend)}).`
            : targetStatus === 'below_target'
              ? `Value / cost is above break-even but under the ${VALUE_MINIMUM}\u00d7 target.`
              : `Value / cost meets the ${VALUE_MINIMUM}\u00d7 target.`;
      const calculation: FindingCalculation = {
        formula: `${VOCAB.valueToCost.label} = (counted value \u2212 harm from misses) \u00f7 monthly cost`,
        period: `Monthly \u00b7 ${now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
        costBasis: `${VOCAB.monthlyRunRate.label}. ${COPY.costBasisNotStated} (not Billed cost or Effective cost).`,
        monthlyCost: w.costs.monthly_spend,
        grossValue: defensible.gross_value,
        qualityFloorPassRate: defensible.floor_applied ? (w.value.quality_floor_pass_rate ?? null) : null,
        countedValue: defensible.counted_value,
        harmFromMisses: defensible.harm_from_misses,
        netValue: defensible.total_value,
        gapToTarget: ratio < VALUE_MINIMUM ? VALUE_MINIMUM - ratio : null,
        valueAssumptions:
          'Revenue protected and cost avoided are stated assumptions, as are the quality-floor pass rate and harm from misses. Counted value is gross value times the pass rate.',
        source: 'Synthetic workload data in this workspace. No live connection.',
      };

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
        targetStatus,
        why,
        calculation,
        cacheEvidence,
      };
    })
    .sort((a, b) => a.valueRatio - b.valueRatio);
}
