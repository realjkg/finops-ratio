// The ONE place a workload's Value / cost is computed for display or comparison.
//
// Every surface (Value review, Workloads, Mission, Overview, Reports, the chart, Frank, XLSX and PDF)
// reads this. It is the unrounded adjusted value divided by cost (lib/valueMath.ts), so the same
// workload shows the same number everywhere and a status or sort never depends on how the text was
// rounded. The stored `value.value_ratio` is a rounded seed field: it stays for serialized contracts
// (FOCUS extension, API goldens) and must not be read by a display or a comparison; a test enforces it.
//
// N/A (null) when there is no usable cost: zero, negative, NaN or Infinity cost cannot be divided by.

import type { Workload } from '@/types';
import { deriveWorkloadValue } from './valueMath';

export function workloadValueRatio(w: Workload): number | null {
  const cost = w.costs.monthly_spend;
  if (!(cost > 0) || !Number.isFinite(cost)) return null;
  const ratio = deriveWorkloadValue(w).value_ratio;
  return Number.isFinite(ratio) ? ratio : null;
}

/**
 * For wire formats that carry a plain number (the Frank context): N/A travels as NaN, which JSON
 * turns into null, and Frank's validation treats as "n/a". Never 0.
 */
export function workloadValueRatioOrNaN(w: Workload): number {
  return workloadValueRatio(w) ?? Number.NaN;
}
