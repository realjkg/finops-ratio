// Metric contracts (pilot P0): 'Budget consumed (%)' is eligible actual
// period-to-date cost over the approved full-period budget. An invalid
// denominator or missing evidence is N/A with a reason, never zero.
import { describe, expect, it } from 'vitest';
import { budgetConsumed, formatBudgetConsumed, SCENARIO_REDUCTION_LABEL } from './metricContracts';

describe('budgetConsumed', () => {
  it('divides actual to date by the approved full-period budget', () => {
    expect(budgetConsumed(50, 200)).toEqual({ pct: 25, naReason: null });
    expect(budgetConsumed(250, 200)).toEqual({ pct: 125, naReason: null });
  });

  it('keeps a real zero spend as 0 when the budget is valid', () => {
    expect(budgetConsumed(0, 100)).toEqual({ pct: 0, naReason: null });
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined])(
    'renders an invalid budget (%s) as N/A with a reason, not zero',
    (budget) => {
      const m = budgetConsumed(10, budget);
      expect(m.pct).toBeNull();
      expect(m.naReason).toMatch(/approved budget/i);
    },
  );

  it('treats a budget below one cent as invalid, with a reason that says so', () => {
    const m = budgetConsumed(10, 0.0099);
    expect(m.pct).toBeNull();
    expect(m.naReason).toMatch(/below \$0\.01/);
    expect(budgetConsumed(0.005, 0.01)).toEqual({ pct: 50, naReason: null });
  });

  it.each([Number.NaN, null, undefined])('renders missing actual cost (%s) as N/A with a reason', (actual) => {
    const m = budgetConsumed(actual, 100);
    expect(m.pct).toBeNull();
    expect(m.naReason).toMatch(/actual cost/i);
  });

  it('formats N/A with its reason and values as whole percents', () => {
    expect(formatBudgetConsumed(budgetConsumed(25, 200))).toBe('13%');
    expect(formatBudgetConsumed(budgetConsumed(1, 0))).toMatch(/^N\/A \(.*approved budget.*\)$/);
  });
});

describe('scenario label', () => {
  it('is the owner-approved wording', () => {
    expect(SCENARIO_REDUCTION_LABEL).toBe('Estimated scenario cost reduction—not realized savings');
  });
});
