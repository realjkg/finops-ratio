// SYNTHETIC test fixture (no real organization, no customer data). Test-only.
// Business units BU-A, BU-B and BU-C are invented labels. The split is chosen so that, on the public
// FOCUS 1.0 sample's AWS 2024-09 published facts (src/reports/fixtures/sampleFacts.ts: billed
// 18.00663861840, effective 13.00000000000, 942 rows), allocated + unallocated closes exactly.
import type { AllocationInput, AllocationSlice } from '../reconcile';
import type { Scope } from '../query';
import { assembleReportFacts } from '../../../reports/reportFacts';
import { sampleInput } from '../../../reports/fixtures/sampleFacts';

export const SYNTHETIC_LABEL = 'SYNTHETIC';
export const TENANT = '11111111-1111-4111-8111-111111111111';
export const CONFIG_SHA = 'c'.repeat(64);
export const TENANT_SCOPE: Scope = { tenantId: TENANT, wildcard: true, businessUnits: [], teams: [] };
export const BU_A_SCOPE: Scope = { tenantId: TENANT, wildcard: false, businessUnits: ['BU-A'], teams: ['team-a'] };

/** SYNTHETIC split of the sample's billed and effective totals (USD). */
export function syntheticSlices(): AllocationSlice[] {
  return [
    { currency: 'USD', basis: 'billed', lines: [{ businessUnit: 'BU-A', amount: '7.00000000000' }, { businessUnit: 'BU-B', amount: '4.50000000000' }, { businessUnit: 'BU-C', amount: '3.20000000000' }], unallocated: '3.30663861840' },
    { currency: 'USD', basis: 'effective', lines: [{ businessUnit: 'BU-A', amount: '6.00000000000' }, { businessUnit: 'BU-B', amount: '4.00000000000' }, { businessUnit: 'BU-C', amount: '2.50000000000' }], unallocated: '0.50000000000' },
  ];
}

export const sampleFacts = (o: Parameters<typeof sampleInput>[0] = {}) => assembleReportFacts(sampleInput(o));

export function allocationInput(o: Partial<AllocationInput> = {}): AllocationInput {
  return { scope: TENANT_SCOPE, published: sampleFacts(), allocation: { configSha256: CONFIG_SHA, slices: syntheticSlices() }, deltas: [], ...o };
}
