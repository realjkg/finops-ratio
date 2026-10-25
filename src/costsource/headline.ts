// Headline eligibility (pilot P0). A source whose role is unconfirmed
// (`roleConfirmed: false`, e.g. the synthetic ServiceNow sandbox) stays
// visible per source but never contributes to a headline total or savings.
import type { CostFinding, CostSourceDescriptor } from './CostSourceClient';
import { COST_SOURCES, findingsFor } from './seed';

export const HEADLINE_EXCLUSION_REASON = 'Source role unconfirmed; excluded from headline totals';

export function isHeadlineEligible(source: Pick<CostSourceDescriptor, 'roleConfirmed'>): boolean {
  return source.roleConfirmed !== false;
}

/** Findings of configured, role-confirmed sources: the only ones headline savings may sum. */
export function headlineFindings(): CostFinding[] {
  return COST_SOURCES.filter((s) => s.configured && isHeadlineEligible(s) && s.capabilities.includes('findings')).flatMap((s) => findingsFor(s.id));
}

/** Headline monthly savings per workload (findings without a workload are skipped). */
export function savingsByWorkload(): Map<string, number> {
  const totals = new Map<string, number>();
  for (const f of headlineFindings()) {
    if (f.workloadId) totals.set(f.workloadId, (totals.get(f.workloadId) ?? 0) + f.estimatedMonthlySavings);
  }
  return totals;
}
