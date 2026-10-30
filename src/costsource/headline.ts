// Headline eligibility (pilot P0; fail closed since M0c). A source whose role is
// unconfirmed stays visible per source but never contributes to a headline
// total or savings. Eligible: `roleConfirmed: true`, or a billing-export kind of
// the demo seam whose role was never set to false. Allocation (kubernetes),
// inventory (nutanix), the synthetic ServiceNow allocation and any unknown kind
// are excluded unless explicitly confirmed. The engagement read model uses the
// source-role policy in src/connectors/managed/policy instead.
import type { CostFinding, CostSourceDescriptor } from './CostSourceClient';
import { COST_SOURCES, findingsFor } from './seed';

export const HEADLINE_EXCLUSION_REASON = 'Source role unconfirmed; excluded from headline totals';

// Deviation from the plan's D5 wording (literal `roleConfirmed === true`), stated
// on purpose: `pointfive` stays a billing-export kind here, so the offline
// pointfive-sandbox seed (no roleConfirmed) keeps counting in the demo headline.
// Setting roleConfirmed:true on that seed instead would change the public
// /api/costsource/sources golden (src/compat/golden/api.json). The live PointFive
// descriptor is roleConfirmed:false (pointfiveConfig.ts), so live PointFive rows
// never reach a headline total; the explicit false wins over the kind.
const BILLING_EXPORT_KINDS: ReadonlySet<string> = new Set(['cloud', 'synthetic_cloud', 'focus_file', 'pointfive']);

export function isHeadlineEligible(source: Pick<CostSourceDescriptor, 'roleConfirmed'> & { kind?: string }): boolean {
  if (source.roleConfirmed !== undefined) return source.roleConfirmed === true;
  return source.kind !== undefined && BILLING_EXPORT_KINDS.has(source.kind);
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
