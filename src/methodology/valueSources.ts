// Value sources: trace every Value / cost figure back to the record it came from.
//
// Pure functions over a workload (and, inside a simulation workspace, its cost
// ledger). The methodology page and "View calculation" both read this, so the
// explanation is computed from the same data and formula as the headline and
// cannot drift from it. Each trace also re-derives the inputs from their source
// record (the demo dataset record, or the workspace's cost postings) and reports
// any difference instead of hiding it.

import { WORKLOAD_SEED_SPECS, modeledDailyCost, seedValueSplit, type ModeledDailyCost, type WorkloadSeedSpec } from '@/data/workloads';
import { deriveWorkloadValue } from '@/lib/valueMath';
import { workloadValueRatio } from '@/lib/valueRatio';
import { isEvidenceStatus, headlineEvidence, type ValueInput } from '@/lib/valueEvidence';
import { costSourceOf, type CostSource } from '@/lib/vocabulary';
import type { EvidenceStatus, Workload } from '@/types';

/** Where this workload's records come from. */
export type DataOrigin = 'demo_dataset' | 'simulation_workspace';

/** File that holds the demo dataset records (shown as text; the UI links to the in-app page, not to a repository). */
export const DEMO_DATASET_FILE = 'src/data/workloads.ts';
/** Repository document that sets out the value formula and its limits. */
export const VALUE_DERIVATION_DOC = 'docs/design/value-derivation/VALUE-DERIVATION.md';
/** In-app page that explains the calculation. */
export const METHODOLOGY_PATH = '/methodology';

/** Link to one workload's worked example on the methodology page. */
export function methodologyHref(workloadId: string): string {
  return `${METHODOLOGY_PATH}#${workloadAnchor(workloadId)}`;
}
export function workloadAnchor(workloadId: string): string {
  return `calc-${workloadId}`;
}

/** One posting in the workspace cost ledger (the subset this trace needs). */
export interface LedgerPosting {
  workloadId: string;
  cents: number;
  source: string;
}

export interface InputTrace {
  key: ValueInput | 'monthly_cost';
  label: string;
  value: number;
  /** usd: whole dollars as the rest of the app shows them; usd_cents: to the cent (recorded cost). */
  format: 'usd' | 'usd_cents' | 'pct';
  /** The recorded evidence mark; null for cost, which is not a value input. */
  evidence: EvidenceStatus | null;
  /** True when the input has no recorded mark and so counts as assumed. */
  unmarked: boolean;
  /** Where the number comes from, in one sentence. */
  origin: string;
}

export interface StepTrace {
  label: string;
  formula: string;
  value: number | null;
  format: 'usd' | 'ratio';
}

export interface SourceCheck {
  /** True when every input re-derived from its source record equals the value in use. */
  matches: boolean;
  /** Plain-language description of each difference; empty when `matches`. */
  differences: string[];
  /** What was compared, for the page. */
  checked: string;
}

export interface WorkloadTrace {
  id: string;
  name: string;
  anchor: string;
  origin: DataOrigin;
  costSource: CostSource;
  inputs: InputTrace[];
  steps: StepTrace[];
  /** Weakest evidence mark of the value inputs (unmarked counts as assumed). */
  headlineEvidence: EvidenceStatus;
  /** The demo dataset record, when the workload has one. */
  seed: WorkloadSeedSpec | null;
  /** Modeled daily cost from tokens × list price (demo dataset only). */
  dailyCost: (ModeledDailyCost & { calls: number; inputTokens: number; outputTokens: number; cachedTokens: number }) | null;
  /** Workspace postings behind recorded cost (simulation workspace only). */
  postings: { count: number; totalCents: number; sources: string[] } | null;
  check: SourceCheck;
}

const LABELS: Record<ValueInput, string> = {
  revenue_protected: 'Protected revenue',
  cost_avoided: 'Avoided cost',
  quality_floor_pass_rate: 'Quality-floor pass rate',
  harm_from_misses: 'Harm from misses',
};

const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const cents = (n: number) => Math.round(n * 100);

export function seedFor(workloadId: string): WorkloadSeedSpec | null {
  return WORKLOAD_SEED_SPECS.find((s) => s.id === workloadId) ?? null;
}

/**
 * Trace one workload. `ledger` is the workspace cost ledger; pass it inside a
 * simulation workspace (origin then reads as the workspace), omit it for the demo.
 */
export function traceWorkload(w: Workload, ledger?: readonly LedgerPosting[]): WorkloadTrace {
  const origin: DataOrigin = ledger ? 'simulation_workspace' : 'demo_dataset';
  const seed = seedFor(w.id);
  const d = deriveWorkloadValue(w);
  const ratio = workloadValueRatio(w);
  const costSource = costSourceOf(w);
  const ev = w.value.evidence;
  const mark = (k: ValueInput) => (isEvidenceStatus(ev?.[k]) ? { evidence: ev![k] as EvidenceStatus, unmarked: false } : { evidence: 'assumed' as const, unmarked: true });

  const record = seed ? `dataset record ${seed.id}` : 'this workload record';
  const copied = origin === 'simulation_workspace' ? ' Copied into the workspace when it was created.' : '';
  const split = seed ? seedValueSplit(seed) : null;
  const inputs: InputTrace[] = [
    {
      key: 'revenue_protected', label: LABELS.revenue_protected, value: w.value.revenue_protected, format: 'usd', ...mark('revenue_protected'),
      origin: seed && split
        ? `Stated in ${record}: a stated value multiple of ${seed.valueRatio}× the stated monthly cost of ${usd(seed.monthlySpend)} gives ${usd(split.totalValue)} of claimed value; ${pct(seed.revenueSplit)} of it is protected revenue.${copied}`
        : `Stated in ${record}.${copied}`,
    },
    {
      key: 'cost_avoided', label: LABELS.cost_avoided, value: w.value.cost_avoided, format: 'usd', ...mark('cost_avoided'),
      origin: seed && split ? `Stated in ${record}: the remaining ${pct(1 - seed.revenueSplit)} of the ${usd(split.totalValue)} claimed value.${copied}` : `Stated in ${record}.${copied}`,
    },
  ];
  if (w.value.quality_floor_pass_rate !== undefined) {
    inputs.push({
      key: 'quality_floor_pass_rate', label: LABELS.quality_floor_pass_rate, value: w.value.quality_floor_pass_rate, format: 'pct', ...mark('quality_floor_pass_rate'),
      origin: `Stated in ${record}. Not measured from graded outputs.${copied}`,
    });
  }
  inputs.push({
    key: 'harm_from_misses', label: LABELS.harm_from_misses, value: d.harm_from_misses, format: 'usd', ...mark('harm_from_misses'),
    origin: w.value.harm_from_misses === undefined ? 'Not recorded, so counted as $0.' : `Stated in ${record}. Not measured from refunds or rework records.${copied}`,
  });

  const workloadPostings = ledger?.filter((p) => p.workloadId === w.id) ?? null;
  const postings = workloadPostings
    ? { count: workloadPostings.length, totalCents: workloadPostings.reduce((s, p) => s + p.cents, 0), sources: [...new Set(workloadPostings.map((p) => p.source))].sort() }
    : null;
  inputs.push({
    key: 'monthly_cost', label: costSource === 'recorded' ? 'Recorded cost, month to date' : 'Modeled monthly cost', value: w.costs.monthly_spend, format: postings ? 'usd_cents' : 'usd', evidence: null, unmarked: false,
    origin: postings
      ? postings.count > 0
        ? `Sum of ${postings.count} cost postings recorded in this workspace (${postings.sources.join(', ')}).`
        : 'No cost postings are recorded in this workspace for this workload.'
      : seed
        ? `Stated in ${record} as a monthly run rate. It is not derived from the token counts below, and it is not a bill.`
        : 'Stated on this workload record. It is not a bill.',
  });

  const steps: StepTrace[] = [
    { label: 'Gross value', formula: 'protected revenue + avoided cost', value: d.gross_value, format: 'usd' },
    { label: 'Counted value', formula: d.floor_applied ? 'gross value × quality-floor pass rate' : 'gross value (no pass rate recorded, so all outputs count)', value: d.counted_value, format: 'usd' },
    { label: 'Adjusted value', formula: 'counted value − harm from misses', value: d.total_value, format: 'usd' },
    { label: 'Value / cost', formula: 'adjusted value ÷ cost', value: ratio, format: 'ratio' },
  ];

  const dailyCost = seed && origin === 'demo_dataset'
    ? { ...modeledDailyCost(seed), calls: seed.callsToday, inputTokens: seed.callsToday * seed.avgInputTokens, outputTokens: seed.callsToday * seed.avgOutputTokens, cachedTokens: seed.cachedTokensToday }
    : null;

  return {
    id: w.id, name: w.name, anchor: workloadAnchor(w.id), origin, costSource, inputs, steps,
    headlineEvidence: headlineEvidence(w.value).status,
    seed, dailyCost, postings,
    check: checkAgainstSource(w, seed, dailyCost, postings),
  };
}

/** Re-derive each input from its source record and compare it with the value in use. */
export function checkAgainstSource(
  w: Workload,
  seed: WorkloadSeedSpec | null,
  dailyCost: ModeledDailyCost | null,
  postings: WorkloadTrace['postings'],
): SourceCheck {
  const differences: string[] = [];
  const compare = (what: string, inUse: number | undefined, fromSource: number, fmt: (n: number) => string) => {
    if (inUse === undefined || cents(inUse) !== cents(fromSource)) differences.push(`${what}: ${inUse === undefined ? 'missing' : fmt(inUse)} in use, ${fmt(fromSource)} in the source record.`);
  };
  const checked: string[] = [];
  // The stored headline figures many screens read directly must equal the derivation from the inputs.
  const derived = deriveWorkloadValue(w);
  compare('Stored estimated value', w.value.total_value, Math.round(derived.total_value), usd);
  checked.push('stored estimated value against the inputs, to the cent');
  if (w.costs.monthly_spend > 0) {
    // The demo stores the ratio rounded to 2 decimals and the workspace stores it unrounded, so it is compared to 0.01.
    const expectedRatio = Math.round(derived.total_value) / w.costs.monthly_spend;
    if (!Number.isFinite(w.value.value_ratio) || Math.abs(w.value.value_ratio - expectedRatio) >= 0.005) {
      differences.push(`Stored Value / cost: ${w.value.value_ratio} in use, ${expectedRatio.toFixed(2)} from the inputs.`);
    }
    checked.push('stored Value / cost against the inputs, to 0.01');
  }
  if (seed) {
    const split = seedValueSplit(seed);
    compare('Protected revenue', w.value.revenue_protected, split.revenueProtected, usd);
    compare('Avoided cost', w.value.cost_avoided, split.costAvoided, usd);
    compare('Harm from misses', w.value.harm_from_misses, seed.harmFromMisses, usd);
    const rate = w.value.quality_floor_pass_rate;
    if (rate === undefined || Math.abs(rate - seed.qualityFloorPassRate) > 1e-9) {
      differences.push(`Quality-floor pass rate: ${rate === undefined ? 'missing' : pct(rate)} in use, ${pct(seed.qualityFloorPassRate)} in the source record.`);
    }
    checked.push(`value inputs against dataset record ${seed.id}, to the cent`);
  } else {
    differences.push('No dataset record has this workload id, so its value inputs cannot be traced.');
  }
  if (postings) {
    compare('Recorded cost', w.costs.monthly_spend, postings.totalCents / 100, usd);
    checked.push(`cost against the sum of ${postings.count} workspace postings, to the cent`);
  } else if (seed) {
    compare('Modeled monthly cost', w.costs.monthly_spend, seed.monthlySpend, usd);
    if (dailyCost) compare('Modeled daily cost', w.costs.daily_spend, dailyCost.dailySpend, usd);
    checked.push(`cost against dataset record ${seed.id}, to the cent`);
  }
  return { matches: differences.length === 0, differences, checked: checked.join('; ') };
}

/** Trace every workload in display order. */
export function traceAll(workloads: readonly Workload[], ledger?: readonly LedgerPosting[]): WorkloadTrace[] {
  return workloads.map((w) => traceWorkload(w, ledger));
}
