// Headline eligibility (pilot P0). A source whose role is unconfirmed
// (`roleConfirmed: false`, e.g. the synthetic ServiceNow sandbox) stays
// visible per source but never contributes to a headline total or savings.
import type { CostSourceDescriptor } from './CostSourceClient';

export const HEADLINE_EXCLUSION_REASON = 'Source role unconfirmed; excluded from headline totals';

export function isHeadlineEligible(source: Pick<CostSourceDescriptor, 'roleConfirmed'>): boolean {
  return source.roleConfirmed !== false;
}
