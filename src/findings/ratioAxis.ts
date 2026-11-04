// Axis for Value / cost, shared by the meter and the scatter chart.
//
// Value / cost is (counted value − harm from misses) ÷ monthly cost (lib/valueMath.ts), so it
// can be negative. A scale that starts at zero would draw a value-destroying workload as a
// zero-length bar and hide the difference between 0× and −0.2×. The domain therefore extends
// below zero to the next whole number under the lowest ratio in view, and stays at 0 otherwise.

/** Ratios at or above this fill the bar completely (unchanged from the original scale). */
export const RATIO_CEILING = 10;

/** Lowest value drawn. A ratio below it is clipped to this edge and marked "≤ -5×", so one extreme workload cannot squash the 0×, 1× and 3× marks together. */
export const RATIO_FLOOR = -5;

export interface RatioDomain {
  min: number;
  max: number;
  /** True when some ratio is below RATIO_FLOOR and is drawn clipped at the floor. */
  clipped: boolean;
}

/** Domain covering every given ratio: min is 0 or the whole number below the lowest ratio. */
export function ratioDomain(ratios: ReadonlyArray<number | null>): RatioDomain {
  const finite = ratios.filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
  const lowest = finite.length > 0 ? Math.min(...finite) : 0;
  return { min: Math.max(RATIO_FLOOR, Math.min(0, Math.floor(lowest))), max: RATIO_CEILING, clipped: lowest < RATIO_FLOOR };
}

/** Axis text for a tick: the floor reads "≤ -5×" when values are clipped there. */
export function ratioTickLabel(v: number, domain: RatioDomain): string {
  return v === domain.min && domain.clipped ? `\u2264 ${v}\u00d7` : `${v}\u00d7`;
}

/** Position of a ratio along the domain as a fraction in [0, 1], clamped to the domain. */
export function ratioFraction(ratio: number, domain: RatioDomain): number {
  const span = domain.max - domain.min;
  if (!Number.isFinite(ratio) || span <= 0) return 0;
  return Math.max(0, Math.min((ratio - domain.min) / span, 1));
}

/** Tick values for the chart's y axis: the negative floor (if any), then 0, 1, 3, 5, 10. */
export function ratioTicks(domain: RatioDomain): number[] {
  const base = [0, 1, 3, 5, RATIO_CEILING];
  return domain.min < 0 ? [domain.min, ...base] : base;
}
