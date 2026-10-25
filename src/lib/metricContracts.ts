// Metric contracts (pilot P0). One definition per headline metric, so every
// surface reads the same meaning and an invalid input is never shown as zero.

/** A percentage, or N/A with the reason it cannot be computed. */
export interface PctMetric {
  pct: number | null;
  naReason: string | null;
}

const na = (naReason: string): PctMetric => ({ pct: null, naReason });
const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * 'Budget consumed (%)' = eligible actual period-to-date cost divided by the
 * approved full-period budget. Not clamped: 125 means 25% over budget.
 * A budget that is missing, non-finite or not positive, or a missing actual,
 * is N/A with a reason. A real zero spend against a valid budget is 0.
 */
export function budgetConsumed(actualToDate: number | null | undefined, approvedBudget: number | null | undefined): PctMetric {
  if (!usable(approvedBudget) || approvedBudget <= 0) return na('No valid approved budget for the period');
  if (!usable(actualToDate)) return na('Actual cost to date is missing');
  return { pct: (actualToDate / approvedBudget) * 100, naReason: null };
}

/** Whole-percent text, or "N/A (reason)". */
export function formatBudgetConsumed(m: PctMetric): string {
  return m.pct === null ? `N/A (${m.naReason ?? 'no evidence'})` : `${Math.round(m.pct)}%`;
}

/** Required wording for any model-switch (or similar scenario) cost forecast. */
export const SCENARIO_REDUCTION_LABEL = 'Estimated scenario cost reduction—not realized savings';
