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
    definition:
      'Business value after the quality-floor shortfall and after harm from misses, based on stated assumptions. It can be negative.',
  },
  valueToCost: {
    label: 'Value / cost',
    definition:
      'Quality-adjusted business value, less modeled harm from misses, divided by workload cost for the same reporting period. Break-even is 1×; it can be negative.',
  },
  /** A workload's cost for the month as the demo models it (an assumed figure). */
  modeledCost: {
    label: 'Modeled workload cost',
    definition: 'The workload\'s monthly cost as modeled from stated assumptions. It is not billed or effective cost.',
  },
  /** Cost accumulated so far this month from recorded postings (customer simulation workspace). */
  recordedCost: {
    label: 'Recorded cost to date',
    definition: 'Cost recorded so far this period from postings in the workspace.',
  },
  /** Assumed daily cost times elapsed days (30-day month convention). */
  estimatedCostToDate: {
    label: 'Estimated cost to date',
    definition: 'Assumed daily cost multiplied by the days elapsed, on a 30-day month convention.',
  },
  estimatedBudgetConsumption: {
    label: 'Estimated budget consumption to date',
    definition: 'Estimated cost to date as a percentage of the period budget.',
  },
  /** Neutral name for a monthly workload cost that may be modeled or recorded (exports, charts). */
  monthlyWorkloadCost: {
    label: 'Monthly workload cost',
    definition: 'The workload\'s cost for the month: modeled from stated assumptions, or recorded from postings in a customer workspace.',
  },
} as const satisfies Record<string, Term>;

export type VocabKey = keyof typeof VOCAB;

/** Display strings that are not cost measures but must read the same everywhere. */
export const COPY = {
  /** Modeled cost basis, stated only inside the View calculation disclosure (never Billed or Effective). */
  basisModeled: 'Basis: modeled',
  /** Simulation postings are ledger-style entries whose billed/effective treatment is not stated. */
  basisRecorded: 'Basis: simulation postings',
  monthConvention: '30-day month convention',
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
  { pattern: /(?<!estimated )\bbudget consum(ed|ption)\b/i, use: 'Budget used (recorded cost) or Estimated budget consumption (modeled cost)' },
  { pattern: /\bvalue (minimum|floor)\b/i, use: 'the 3× target (a configured policy target)' },
  { pattern: /\bbelow (the )?minimum\b/i, use: 'Below target' },
  { pattern: /\bMonthly [Cc]ost\b/, use: 'Modeled workload cost / Recorded cost to date / Monthly workload cost' },
  { pattern: /\bAI [Ss]pend\b(?! (vs|ratio))/, use: 'AI monthly workload cost' },
  { pattern: /\b[Ww]orst first\b/, use: 'Lowest value first' },
  { pattern: /\bSpend \/ mo\b/, use: 'Modeled workload cost' },
  { pattern: /\bCost this month\b/, use: 'Recorded cost to date' },
  { pattern: /\bMonthly run rate\b/, use: 'Modeled workload cost (a run rate is not month-to-date)' },
  { pattern: /\bCost [Ee]fficiency( [Ss]core)?\b/, use: 'Value / cost' },
  { pattern: /\bvalue ratios?\b/i, use: 'Value / cost' },
  { pattern: /\bValue return\b|\d× return\b/, use: 'Value / cost' },
  { pattern: /\(Billed cost\)|\(Effective cost\)/, use: 'the cost basis is not Billed or Effective for modeled data' },
];

// --- Cost source: modeled (bundled seed) vs recorded (simulation postings) ---

export type CostSource = 'modeled' | 'recorded';

/** A workload carries recorded month-to-date cost only when a ledger supplied it (costs.recorded_mtd). */
export function costSourceOf(w: { costs: { recorded_mtd?: number } }): CostSource {
  return w.costs.recorded_mtd !== undefined ? 'recorded' : 'modeled';
}

/** A portfolio is recorded only when every workload is; a mix reads as modeled (the cautious wording). */
export function portfolioCostSource(ws: ReadonlyArray<{ costs: { recorded_mtd?: number } }>): CostSource {
  return ws.length > 0 && ws.every((w) => costSourceOf(w) === 'recorded') ? 'recorded' : 'modeled';
}

export const costLabel = (source: CostSource): string => (source === 'recorded' ? VOCAB.recordedCost.label : VOCAB.modeledCost.label);
export const basisLine = (source: CostSource): string => (source === 'recorded' ? COPY.basisRecorded : COPY.basisModeled);

/**
 * The budget percentage label must match its numerator and horizon. Modeled cost is an estimate
 * (assumed daily cost x elapsed days), so it is never called "Budget used"; only recorded cost to
 * date earns that name, with the basis stated beside the number. Daily cost is modeled in both.
 */
export function budgetLabel(source: CostSource, horizon: 'month' | 'day' = 'month'): string {
  if (horizon === 'day') return 'Estimated budget consumption today';
  return source === 'recorded' ? VOCAB.budgetUsed.label : VOCAB.estimatedBudgetConsumption.label;
}

/** Column and cell headers for exports, per cost source. Display text only; no keys. */
export function reportHeaders(source: CostSource) {
  return {
    cost: source === 'recorded' ? VOCAB.recordedCost.label : VOCAB.modeledCost.label,
    budget: budgetLabel(source, 'month'),
    valueToCost: VOCAB.valueToCost.label,
  };
}
