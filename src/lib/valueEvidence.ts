// Value-evidence propagation — audit C2 ("confidence = the weakest input").
//
// The headline value ratio inherits the evidence status of its weakest input:
// a chain is as weak as its weakest link. Pure functions — no UI, no side
// effects — so both the surfaces and the agent read the same roll-up.

import type { EvidenceStatus, WorkloadValue } from '@/types';
import { TOKEN_COLOR } from '@/lib/scales';
import { COPY } from '@/lib/vocabulary';

// Higher rank = weaker evidence. `measured` (ledger-verified) beats `projected`
// (forward-looking estimate) beats `assumed` (asserted, unverified).
const WEAKNESS_RANK: Record<EvidenceStatus, number> = {
  measured: 0,
  projected: 1,
  assumed: 2,
};

/** True only for the three known statuses (own keys, so `'toString'` or `'Measured'` is not one). */
export function isEvidenceStatus(x: unknown): x is EvidenceStatus {
  return typeof x === 'string' && Object.hasOwn(WEAKNESS_RANK, x);
}

/**
 * Weakest status among the given marks. An unmarked input (`undefined`, `null`)
 * or one that is not a known status (`''`, `'Measured'`, stored data from an
 * older version) counts as `assumed`: missing provenance is the weakest evidence,
 * never a mark that silently drops out of the roll-up (owner decision 1,
 * value-derivation note §4). Returns `undefined` only for an empty list.
 */
export function weakestStatus(statuses: ReadonlyArray<unknown>): EvidenceStatus | undefined {
  let weakest: EvidenceStatus | undefined;
  for (const raw of statuses) {
    const status: EvidenceStatus = isEvidenceStatus(raw) ? raw : 'assumed';
    if (weakest === undefined || WEAKNESS_RANK[status] > WEAKNESS_RANK[weakest]) {
      weakest = status;
    }
  }
  return weakest;
}

/** The four value inputs whose marks make up a headline status. */
export const VALUE_INPUTS = ['revenue_protected', 'cost_avoided', 'harm_from_misses', 'quality_floor_pass_rate'] as const;
export type ValueInput = (typeof VALUE_INPUTS)[number];

/**
 * Headline evidence for a workload value: the weakest input mark (an unmarked
 * input counts as `assumed`), plus the inputs that carry no mark at all, so a
 * missing provenance field stays visible instead of hiding behind a label.
 */
export function headlineEvidence(value: WorkloadValue): { status: EvidenceStatus; unmarked: ValueInput[] } {
  const marks = VALUE_INPUTS.map((k) => value.evidence?.[k]);
  return {
    status: weakestStatus(marks) ?? 'assumed',
    unmarked: VALUE_INPUTS.filter((_, i) => !isEvidenceStatus(marks[i])),
  };
}

/**
 * Portfolio evidence: the weakest headline status across the workloads, and how many
 * workloads have at least one value input with no recorded (or no valid) mark.
 * `status` is `undefined` only for an empty portfolio.
 */
export function portfolioEvidence(values: ReadonlyArray<WorkloadValue>): { status: EvidenceStatus | undefined; unmarkedWorkloads: number } {
  const each = values.map(headlineEvidence);
  return {
    status: weakestStatus(each.map((e) => e.status)),
    unmarkedWorkloads: each.filter((e) => e.unmarked.length > 0).length,
  };
}

/**
 * Headline evidence status for a workload value: the weakest input mark,
 * including the defensible-value inputs (harm from misses, quality-floor pass
 * rate — audit C3/C4). Never `undefined`: a value with no evidence block, or
 * with an unmarked input, is `assumed` (see `headlineEvidence` for which inputs
 * are unmarked).
 */
export function headlineEvidenceStatus(value: WorkloadValue): EvidenceStatus {
  return headlineEvidence(value).status;
}

/**
 * Display metadata for an evidence mark — quiet, token-colored text next to a
 * ratio. `measured` is the only positive proof (value green); `projected` is a
 * conditional estimate (shape amber); `assumed` is an unverified claim
 * (gate purple — a governance/methodology statement, not a fact).
 */
export const EVIDENCE_META: Record<
  EvidenceStatus,
  { label: string; color: string; title: string }
> = {
  measured: {
    label: 'Measured value',
    color: TOKEN_COLOR.value,
    title: 'Measured value comes from production data, not from assumptions.',
  },
  projected: {
    label: 'Projected value',
    color: TOKEN_COLOR.shape,
    title: 'Projected value is a forward-looking estimate that has not been measured yet.',
  },
  assumed: {
    label: COPY.estimatedValue,
    color: TOKEN_COLOR.gate,
    title: COPY.estimatedValueExplanation,
  },
};

const INPUT_NAMES: Record<ValueInput, string> = {
  revenue_protected: 'revenue protected',
  cost_avoided: 'cost avoided',
  harm_from_misses: 'harm from misses',
  quality_floor_pass_rate: 'quality-floor pass rate',
};

/** "harm from misses and quality-floor pass rate": the inputs' plain names, joined for a sentence. */
export function inputList(unmarked: readonly string[]): string {
  const names = unmarked.map((k) => (Object.hasOwn(INPUT_NAMES, k) ? INPUT_NAMES[k as ValueInput] : k.replace(/_/g, ' ')));
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "No valid provenance is recorded for X and Y, so this value counts as estimated until a source is recorded." */
function unmarkedSentence(unmarked: readonly string[]): string {
  return `No valid provenance is recorded for ${inputList(unmarked)}, so this value counts as estimated until a source is recorded.`;
}

/**
 * Short screen-reader text for a mark inside a button whose aria-label replaces its content:
 * "value evidence: estimated". Worded unlike the mark's own label ("Estimated value"), so the
 * row is never a second control with the evidence button's name.
 */
export function evidenceAriaText(status: EvidenceStatus, unmarked: readonly string[] = []): string {
  const word = EVIDENCE_META[isEvidenceStatus(status) ? status : 'assumed'].label.split(' ')[0].toLowerCase();
  const text = `value evidence: ${word}`;
  return unmarked.length ? `${text}, no valid provenance recorded for ${inputList(unmarked)}` : text;
}

/**
 * The explanation text: the status's own sentence, unless inputs have no recorded provenance. Then
 * it names them (one value) or counts the workloads (portfolio) instead, because "rests on stated
 * assumptions" would claim an assumption that was never recorded.
 */
export function evidenceExplanation(status: EvidenceStatus, unmarked?: readonly string[], unmarkedWorkloads?: number): string {
  if (unmarked?.length) return unmarkedSentence(unmarked);
  if (!unmarkedWorkloads) return EVIDENCE_META[status].title;
  const who = unmarkedWorkloads === 1 ? 'One workload has' : `${unmarkedWorkloads} workloads have`;
  return `This portfolio value counts as estimated. ${who} value inputs with no recorded provenance; those inputs count as estimated until a source is recorded.`;
}
