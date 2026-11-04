// One short cost vocabulary. Every surface that names a cost measure (dashboards, report
// headers, Frank's answers, agent-facing descriptions) imports its label and definition
// from here, so the words cannot drift apart. Labels and definitions only: no serialized
// field, API key, filename or stored data key is renamed by this module.
//
// Billed cost and Effective cost are distinct measures (FOCUS 1.0: billed is the invoiced
// charge; effective includes applicable discounts and amortized prepaid purchases). Neither
// may stand in for the other, and neither may be called "actual cost".

export interface Term {
  /** Display label (sentence case). */
  label: string;
  /** One-sentence definition, shown in tooltips, calculation panels and agent descriptions. */
  definition: string;
}

export const VOCAB = {
  billedCost: {
    label: 'Billed cost',
    definition: 'Charges billed for the period.',
  },
  effectiveCost: {
    label: 'Effective cost',
    definition: 'Cost after discounts and allocation of applicable prepaid commitments.',
  },
  forecastCost: {
    label: 'Forecast cost',
    definition: 'Estimated total cost for the selected period.',
  },
  budget: {
    label: 'Budget',
    definition: 'Planned spending limit for the period.',
  },
  budgetUsed: {
    label: 'Budget used',
    definition: 'Cost to date as a percentage of budget. Name the cost basis next to the number.',
  },
  forecastBudgetUse: {
    label: 'Forecast budget use',
    definition: 'Forecast cost as a percentage of budget. Name the cost basis next to the number.',
  },
  estimatedBusinessValue: {
    label: 'Estimated business value',
    definition: 'Monetary benefit based on stated assumptions.',
  },
  valueToCost: {
    label: 'Value / cost',
    definition: 'Business value divided by cost. Break-even is 1×. It can be negative when harm exceeds counted value.',
  },
  /**
   * The seeded workload cost: a stated monthly figure the demo scales to month to date by
   * dividing by 30. It is a run rate, not month-to-date, billed or effective cost.
   */
  monthlyRunRate: {
    label: 'Monthly run rate',
    definition: 'The workload\'s stated monthly cost at its current pace. Not accumulated month-to-date cost.',
  },
} as const satisfies Record<string, Term>;

export type VocabKey = keyof typeof VOCAB;

/** Display strings that are not cost measures but must read the same everywhere. */
export const COPY = {
  /** Replaces any freshness claim on synthetic data. */
  sampleData: 'Synthetic data · No live connections',
  /** The cost basis of the seeded workload figures: the seed never says billed or effective. */
  costBasisNotStated: 'Cost basis not stated',
  /** Evidence status "assumed" as shown beside a value number. */
  estimatedValue: 'Estimated value',
  estimatedValueExplanation:
    'Estimated business value rests on stated assumptions, not measured results. Treat it as an estimate until the outcome is measured.',
  /** Default where the demo configuration carries no named owner. */
  targetSetBy: 'Set in demo configuration',
} as const;

/** Break-even for Value / cost: value equals cost. */
export const VALUE_COST_BREAK_EVEN = 1;

/**
 * The 3× Value / cost target is a configured policy target (Gate 3 of the governance
 * gates), not a financial standard. This is the single sentence that says so.
 */
export function targetPolicyText(target: number): string {
  return `${target}× is a policy target configured for this workspace, not a general financial standard.`;
}

/**
 * Phrases that must not appear in user-facing copy, with the reason. The vocabulary test
 * scans the UI, report, Frank and agent-description sources for these.
 */
export const BANNED_PHRASES: ReadonlyArray<{ pattern: RegExp; use: string }> = [
  { pattern: /\bactual (cost|spend)s?\b/i, use: 'Billed cost or Effective cost, whichever the number is' },
  { pattern: /\bbudget vs\.? actual\b/i, use: 'Budget vs effective cost' },
  { pattern: /\bbudget consum(ed|ption)\b/i, use: 'Budget used' },
  { pattern: /\bvalue (minimum|floor)\b/i, use: 'the 3× target (a configured policy target)' },
  { pattern: /\bbelow (the )?minimum\b/i, use: 'Below target' },
];
