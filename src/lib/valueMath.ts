// Defensible value math — audit C3/C4 (quality floor, harm subtraction).
//
// The Foundation's realized-value rigor: outputs missing the workload's quality
// floor contribute no value (C3 — misses don't count), and the harm those
// misses cause is subtracted from what remains (C4). Pure functions, same
// derivation pattern as `derive.ts` — given stored components they compute the
// numbers the UI never stores, so the headline ratio and the defensible
// numerator can never drift apart.

import type { Workload, WorkloadValue } from '@/types';

export interface DefensibleValue {
  /** Claimed value before gating: revenue_protected + cost_avoided. */
  gross_value: number;
  /** Value earned by floor-passing outputs only (C3). */
  counted_value: number;
  /** Monthly harm from missed outputs (C4) — 0 when unaccounted. */
  harm_from_misses: number;
  /**
   * The headline numerator: counted_value − harm_from_misses. May be zero or
   * negative — a non-positive numerator is rendered as-is, never floored to a
   * fake positive ratio.
   */
  total_value: number;
  /** total_value / monthly_spend — negative when the workload destroys value. */
  value_ratio: number;
  /** True when a quality_floor_pass_rate was present and applied. */
  floor_applied: boolean;
}

/**
 * The defensible headline numerator (revised value-ratio invariant, R4):
 *   total_value = (revenue_protected + cost_avoided) × quality_floor_pass_rate − harm_from_misses
 *   value_ratio = total_value / monthly_spend
 * Legacy shapes without the floor/harm fields pass through ungated
 * (pass rate 1, harm 0) — identical to the pre-C3/C4 math.
 */
export function deriveDefensibleValue(
  value: Pick<WorkloadValue, 'revenue_protected' | 'cost_avoided' | 'harm_from_misses' | 'quality_floor_pass_rate'>,
  monthlySpend: number,
): DefensibleValue {
  const gross = value.revenue_protected + value.cost_avoided;
  const floorApplied = value.quality_floor_pass_rate !== undefined;
  const passRate = clampPassRate(value.quality_floor_pass_rate);
  const counted = gross * passRate;
  const harm = value.harm_from_misses ?? 0;
  const total = counted - harm;
  return {
    gross_value: gross,
    counted_value: counted,
    harm_from_misses: harm,
    total_value: total,
    value_ratio: monthlySpend > 0 ? total / monthlySpend : 0,
    floor_applied: floorApplied,
  };
}

/** Convenience wrapper over a stored workload (derive.ts pattern). */
export function deriveWorkloadValue(workload: Workload): DefensibleValue {
  return deriveDefensibleValue(workload.value, workload.costs.monthly_spend);
}

// A pass rate outside [0, 1] is a data error, not a multiplier — clamp so a
// bad seed can never inflate the numerator above claimed value.
function clampPassRate(rate: number | undefined): number {
  if (rate === undefined) return 1; // ungated — legacy shape
  return Math.min(Math.max(rate, 0), 1);
}
