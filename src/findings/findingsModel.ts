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
import { workloadValueRatio } from '@/lib/valueRatio';
import { COPY, VOCAB, VALUE_COST_BREAK_EVEN, basisLine, costLabel, costSourceOf, type CostSource } from '@/lib/vocabulary';
import { formatRatio, formatUSD } from '@/lib/format';
import { DEMO_NOW } from '@/data/workloads';
import type { EvidenceStatus, Workload } from '@/types';
import {
  recommendFor,
  VALUE_MINIMUM,
  type RecommendationKind,
} from './recommendationMath';

export { VALUE_MINIMUM };

/** Where Value / cost sits against its two reference points. */
export type TargetStatus = 'below_break_even' | 'below_target' | 'on_target' | 'not_available';

/** Compares the UNROUNDED ratio; the one-decimal display never decides a status. Null or non-finite is N/A. */
export function targetStatusFor(ratio: number | null): TargetStatus {
  if (ratio === null || !Number.isFinite(ratio)) return 'not_available';
  if (ratio < VALUE_COST_BREAK_EVEN) return 'below_break_even';
  return ratio < VALUE_MINIMUM ? 'below_target' : 'on_target';
}

/**
 * Everything "View calculation" shows: the formula, the period, the cost basis, the value
 * assumptions and the source. Built from the same pure function every surface reads
 * (lib/valueMath.ts), so the breakdown cannot disagree with the headline ratio.
 */
export interface FindingCalculation {
  definition: string;
  /** Period of the value inputs, e.g. "Monthly · June 2026". */
  period: string;
  /** Period the cost covers: "monthly" for modeled cost, "June 1–25" for cost recorded to date. */
  costPeriod: string;
  /** Said plainly when value and cost cover different spans (recorded cost to date), else null. */
  periodNote: string | null;
  costSource: CostSource;
  costLabel: string;
  /** "Basis: modeled" or "Basis: simulation postings". */
  basis: string;
  /** Disclosed only where the cost is a modeled estimate scaled by days. */
  monthConvention: string | null;
  cost: number;
  /** Protected revenue plus avoided cost, before the quality floor. */
  grossValue: number;
  /** Share of outputs meeting the quality floor, or null on legacy shapes (ungated). */
  qualityFloorPassRate: number | null;
  /** Gross value times the pass rate: the quality-floor shortfall is already out of this figure. */
  countedValue: number;
  harmFromMisses: number;
  /** Counted value less harm: the estimated business value. */
  adjustedValue: number;
  /** adjustedValue divided by cost, unrounded; null when cost is not positive. */
  ratio: number | null;
  /** Why the ratio is N/A, else null. */
  naReason: string | null;
  /** Target minus the unrounded ratio when below target, else null. */
  gapToTarget: number | null;
  valueAssumptions: string;
  source: string;
}

export interface FindingView {
  workloadId: string;
  workloadName: string;
  /** Evidence #1: current value ratio. */
  /**
   * Unrounded Value / cost (adjusted value ÷ cost); null when the workload has no positive cost.
   * Sorting, target comparisons and gaps use this, not the one-decimal text.
   */
  valueRatio: number | null;
  /** Ratio color from the existing ratio color scale. */
  valueColor: string;
  /** Evidence #2: current monthly spend. */
  monthlySpend: number;
  /** Whether the cost is modeled (sample workspace) or recorded (simulation postings). */
  costSource: CostSource;
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
      const defensible = deriveWorkloadValue(w);
      const cost = w.costs.monthly_spend;
      // Unrounded: adjusted value / cost. Null (N/A) when there is no positive cost to divide by.
      const ratio: number | null = workloadValueRatio(w);
      const naReason = ratio === null ? 'No positive, finite workload cost for the period' : null;
      const source = costSourceOf(w);
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

      const targetStatus = targetStatusFor(ratio);
      const problem =
        targetStatus === 'not_available'
          ? `${VOCAB.valueToCost.label} N/A: ${naReason}`
          : targetStatus === 'on_target'
            ? `${VOCAB.valueToCost.label} ${formatRatio(ratio as number)}, at or above the ${VALUE_MINIMUM}\u00d7 target`
            : 'Below target';
      const why =
        targetStatus === 'not_available'
          ? `${VOCAB.valueToCost.label} cannot be computed: ${naReason}.`
          : defensible.total_value <= 0
            ? `Harm from misses (${formatUSD(defensible.harm_from_misses)}) is larger than counted value (${formatUSD(defensible.counted_value)}), so estimated value is negative.`
            : targetStatus === 'below_break_even'
              ? `Estimated value (${formatUSD(defensible.total_value)}) does not cover workload cost (${formatUSD(cost)}).`
              : targetStatus === 'below_target'
                ? `Value / cost is above break-even but under the ${VALUE_MINIMUM}\u00d7 target.`
                : `Value / cost meets the ${VALUE_MINIMUM}\u00d7 target.`;
      const calculation: FindingCalculation = {
        definition: VOCAB.valueToCost.definition,
        period: `Monthly \u00b7 ${now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
        costPeriod: source === 'recorded' ? `${now.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} 1\u2013${now.getUTCDate()}` : 'monthly',
        periodNote:
          source === 'recorded'
            ? 'Value inputs are stated for the whole month; cost is what the workspace has recorded so far. The ratio divides monthly value by cost recorded to date.'
            : null,
        costSource: source,
        costLabel: costLabel(source),
        basis: basisLine(source),
        monthConvention: source === 'modeled' ? COPY.monthConvention : null,
        cost,
        grossValue: defensible.gross_value,
        qualityFloorPassRate: defensible.floor_applied ? (w.value.quality_floor_pass_rate ?? null) : null,
        countedValue: defensible.counted_value,
        harmFromMisses: defensible.harm_from_misses,
        adjustedValue: defensible.total_value,
        ratio,
        naReason,
        gapToTarget: ratio !== null && ratio < VALUE_MINIMUM ? VALUE_MINIMUM - ratio : null,
        valueAssumptions:
          'Protected revenue, avoided cost, the quality-floor pass rate and harm from misses are stated assumptions, not measured results.',
        source: source === 'modeled' ? 'Demo dataset.' : 'Postings recorded in this workspace.',
      };

      return {
        workloadId: w.id,
        workloadName: w.name,
        valueRatio: ratio,
        valueColor: ratio === null ? 'var(--dim)' : ratioColor(ratio),
        monthlySpend: w.costs.monthly_spend,
        costSource: source,
        valueEvidenceStatus: headlineEvidenceStatus(w.value),
        problem,
        recommendedAction: rec.action,
        recommendationKind: rec.kind,
        projectedMonthlyImpact: rec.projectedMonthlyImpact,
        projectedRatio: rec.projectedRatio,
        impactBasis: rec.basis,
        confidenceNote: rec.confidence,
        belowMinimum: ratio !== null && ratio < VALUE_MINIMUM,
        targetStatus,
        why,
        calculation,
        cacheEvidence,
      };
    })
    // Unrounded, lowest first; N/A (no cost) sorts to the top because it cannot be reviewed as a ratio.
    .sort((a, b) => (a.valueRatio ?? -Infinity) - (b.valueRatio ?? -Infinity));
}
