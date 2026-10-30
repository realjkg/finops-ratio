// M0c: demo headline eligibility fails CLOSED. A source counts only when its
// role is confirmed, or it is an offline/billing-export kind of the demo seam
// whose role was never set to false. Allocation (Kubernetes), inventory
// (Nutanix), the synthetic ServiceNow allocation and any unknown kind are out.
import { describe, expect, it } from 'vitest';
import type { CostSourceDescriptor } from './CostSourceClient';
import { isHeadlineEligible } from './headline';

const d = (kind: string | undefined, roleConfirmed?: boolean) => ({ kind, roleConfirmed }) as Pick<CostSourceDescriptor, 'kind' | 'roleConfirmed'>;

describe('isHeadlineEligible (fail closed)', () => {
  it('undefined role on an allocation, inventory, synthetic-allocation or unknown kind is not eligible', () => {
    for (const kind of ['kubernetes', 'nutanix', 'servicenow', 'something-new', undefined]) expect(isHeadlineEligible(d(kind)), String(kind)).toBe(false);
  });
  it('an explicit false is never eligible, whatever the kind', () => {
    for (const kind of ['cloud', 'synthetic_cloud', 'focus_file', 'pointfive']) expect(isHeadlineEligible(d(kind, false)), kind).toBe(false);
  });
  it('billing-export kinds of the demo seam stay eligible unless set false; an explicit true is eligible', () => {
    for (const kind of ['cloud', 'synthetic_cloud', 'focus_file', 'pointfive']) expect(isHeadlineEligible(d(kind)), kind).toBe(true);
    expect(isHeadlineEligible(d('kubernetes', true))).toBe(true);
  });
});
