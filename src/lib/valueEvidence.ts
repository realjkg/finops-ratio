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

/**
 * Weakest status among the given marks. An unmarked input (`undefined`) counts
 * as `assumed`: missing provenance is the weakest evidence, never a mark that
 * silently drops out of the roll-up (owner decision, value-derivation note §4).
 * Returns `undefined` only for an empty list, where there is no input at all.
 */
export function weakestStatus(
  statuses: ReadonlyArray<EvidenceStatus | undefined>,
): EvidenceStatus | undefined {
  let weakest: EvidenceStatus | undefined;
  for (const raw of statuses) {
    const status: EvidenceStatus = raw ?? 'assumed';
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
    unmarked: VALUE_INPUTS.filter((_, i) => marks[i] === undefined),
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
