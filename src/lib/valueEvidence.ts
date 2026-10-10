// Value-evidence propagation — audit C2 ("confidence = the weakest input").
//
// The headline value ratio inherits the evidence status of its weakest input:
// a chain is as weak as its weakest link. Pure functions — no UI, no side
// effects — so both the surfaces and the agent read the same roll-up.

import type { EvidenceStatus, WorkloadValue } from '@/types';
import { TOKEN_HEX } from '@/lib/scales';

// Higher rank = weaker evidence. `measured` (ledger-verified) beats `projected`
// (forward-looking estimate) beats `assumed` (asserted, unverified).
const WEAKNESS_RANK: Record<EvidenceStatus, number> = {
  measured: 0,
  projected: 1,
  assumed: 2,
};

/**
 * Weakest status among the given marks. `undefined` entries are skipped (an
 * unmarked input is not "unknown weakness" — it simply doesn't vote); returns
 * `undefined` only when no input carries a mark at all.
 */
export function weakestStatus(
  statuses: ReadonlyArray<EvidenceStatus | undefined>,
): EvidenceStatus | undefined {
  let weakest: EvidenceStatus | undefined;
  for (const status of statuses) {
    if (status === undefined) continue;
    if (weakest === undefined || WEAKNESS_RANK[status] > WEAKNESS_RANK[weakest]) {
      weakest = status;
    }
  }
  return weakest;
}

/**
 * Headline evidence status for a workload value: the weakest input mark.
 * `undefined` when the value carries no evidence block (legacy shape) — the
 * UI renders that ratio unmarked rather than inventing a status.
 */
export function headlineEvidenceStatus(
  value: WorkloadValue,
): EvidenceStatus | undefined {
  if (!value.evidence) return undefined;
  return weakestStatus([value.evidence.revenue_protected, value.evidence.cost_avoided]);
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
    label: 'measured',
    color: TOKEN_HEX.value,
    title: 'Value evidence: measured from production data',
  },
  projected: {
    label: 'projected',
    color: TOKEN_HEX.shape,
    title: 'Value evidence: projected estimate, not yet measured',
  },
  assumed: {
    label: 'assumed',
    color: TOKEN_HEX.gate,
    title: 'Value evidence: assumed claim, not measured',
  },
};
