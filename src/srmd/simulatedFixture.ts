// INVENTED data for contract tests. Not a sample of any real export or system.
import { parseNanos } from './money';
import type { Measure, ProviderCostRecord } from './types';

export const EFFECTIVE: Measure = { name: 'EffectiveCost', includesCredits: true, amortized: true };
export const BILLED: Measure = { name: 'BilledCost', includesCredits: false, amortized: false };

const acct = { provider: 'cloud-a', billingAccountId: 'acct-0001' };

/** What a direct provider export (parallel path) would hold for the same bills. */
export const SIMULATED_PROVIDER_RECORDS: ProviderCostRecord[] = [
  { providerRecordId: 'prov-1001', ...acct, billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('120.5'), measure: EFFECTIVE },
  { providerRecordId: 'prov-1002', ...acct, billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('40.25'), measure: EFFECTIVE },
  { providerRecordId: 'prov-1003', ...acct, billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('9.99'), measure: EFFECTIVE },
  { providerRecordId: 'prov-1004', ...acct, resourceId: 'res-1', billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('5.5'), measure: EFFECTIVE },
  { providerRecordId: 'prov-1005', ...acct, billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('15'), measure: EFFECTIVE },
  { providerRecordId: 'prov-1006', ...acct, billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('7.1'), measure: EFFECTIVE },
  { providerRecordId: 'prov-1007', ...acct, billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('30'), measure: EFFECTIVE, kind: 'shared' },
  { providerRecordId: 'prov-1008', ...acct, billingPeriod: '2026-09', currency: 'USD', amountNanos: parseNanos('2.2'), measure: EFFECTIVE },
  { providerRecordId: 'prov-2001', provider: 'cloud-b', billingAccountId: 'acct-0002', billingPeriod: '2026-09', currency: 'EUR', amountNanos: parseNanos('80'), measure: EFFECTIVE },
];

export interface RawSrmd {
  id: string;
  providerRecordId: string | null;
  provider: string;
  billingAccountId: string;
  resourceId?: string;
  billingPeriod: string;
  currency: string;
  amount: string;
  measure: Measure;
  kind: 'usage' | 'credit' | 'shared';
  tags: Record<string, string> | null;
  late?: boolean;
}
const tagged = { cost_center: 'cc-synthetic-1' };
const base = { ...acct, billingPeriod: '2026-09', currency: 'USD', measure: EFFECTIVE, kind: 'usage' as const, tags: tagged };

export const RAW_SRMD: RawSrmd[] = [
  // Same record on both paths (duplicate across SRMD and the direct provider fixture).
  { ...base, id: 'srmd-s1', providerRecordId: 'prov-1001', amount: '120.5' },
  // Measure differs from the provider's definition for the same record: not comparable.
  { ...base, id: 'srmd-s2', providerRecordId: 'prov-1002', amount: '40.25', measure: BILLED },
  // No provider record id on the SRMD side; only an amount-and-bill-identity candidate.
  { ...base, id: 'srmd-s3', providerRecordId: null, amount: '9.99' },
  // A credit.
  { ...base, id: 'srmd-s4', providerRecordId: null, amount: '-15', kind: 'credit' },
  // Late arrival: observed after its period closed.
  { ...base, id: 'srmd-s5', providerRecordId: null, billingPeriod: '2026-08', amount: '7.1', late: true },
  // Shared cost, split over two SRMD records that both point at one provider record.
  { ...base, id: 'srmd-s6', providerRecordId: 'prov-1007', amount: '18', kind: 'shared' },
  { ...base, id: 'srmd-s10', providerRecordId: 'prov-1007', amount: '12', kind: 'shared' },
  // Tags missing.
  { ...base, id: 'srmd-s7', providerRecordId: null, amount: '3.3', tags: null },
  // Currency mismatch against the linked provider record (USD vs EUR).
  { ...base, id: 'srmd-s8', providerRecordId: 'prov-2001', provider: 'cloud-b', billingAccountId: 'acct-0002', amount: '87.2' },
  // Stale lineage id (no such provider record), recoverable by bill identity and resource.
  { ...base, id: 'srmd-s9', providerRecordId: 'prov-stale-9', resourceId: 'res-1', amount: '5.5' },
  // No id, equal amount, different measure definition: not comparable.
  { ...base, id: 'srmd-s11', providerRecordId: null, amount: '2.2', measure: BILLED },
];
