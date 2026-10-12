// Read-only SRMD exchange contract (harness). Nothing here describes the real
// SRMD: its API, export format, schema, auth and field authority are unknown.
// Every shape below is an invented placeholder for contract testing only.

export const SRMD_LABEL = 'simulated counterpart, contract unverified';

export type Maturity = 'implemented' | 'simulated' | 'integration-tested' | 'customer-validated';
export const MATURITY_ORDER: readonly Maturity[] = ['implemented', 'simulated', 'integration-tested', 'customer-validated'];
export type Provenance = 'simulated' | 'observed';

export const CAPABILITIES = [
  'cost_records',
  'tags',
  'account_mapping',
  'credits_refunds',
  'shared_cost_allocation',
  'migrations',
  'control_totals',
  'lineage_ids',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export interface CapabilityReport extends Envelope {
  capabilities: Record<Capability, { status: CapabilityStatus; reason: string }>;
}

/** Stamped on the descriptor and on every response. */
export interface Envelope {
  provenance: Provenance;
  label: string;
  maturity: Maturity;
}
export type SrmdResult<T> =
  | (Envelope & { status: 'ok'; data: T })
  | (Envelope & { status: 'unsupported'; capability: Capability; reason: string });

/** A cost measure definition. Different definitions are never coerced into one. */
export interface Measure {
  name: string;
  includesCredits: boolean;
  amortized: boolean;
}

/** provider record -> SRMD record -> Ratio ref. The provider id may be absent. */
export interface Lineage {
  providerRecordId: string | null;
  srmdRecordId: string;
  ratioRef: string;
  upstreamSystem: string;
  observedAt: string;
}

interface CostFields {
  provider: string;
  billingAccountId: string;
  resourceId?: string;
  billingPeriod: string; // YYYY-MM
  currency: string;
  /** Exact integer nano-units (same scale as src/costsource/aiSpendRatio.ts). */
  amountNanos: bigint;
  measure: Measure;
}
export interface SrmdCostRecord extends CostFields, Envelope {
  kind: 'usage' | 'credit' | 'shared';
  /** null = tags missing (unknown), distinct from an empty tag set. */
  tags: Record<string, string> | null;
  lateArrival: boolean;
  shared: { allocatedTo: string[]; rule: 'unspecified' } | null;
  lineage: Lineage;
}
export interface ProviderCostRecord extends CostFields {
  providerRecordId: string;
  /** Absent means 'usage'. */
  kind?: SrmdCostRecord['kind'];
}
export interface TagKey {
  key: string;
  required: boolean;
}
export interface ControlTotal {
  billingAccountId: string;
  billingPeriod: string;
  currency: string;
  measure: Measure;
  totalNanos: bigint;
}
export interface CostQuery {
  billingPeriod?: string;
}

/** The ONLY read methods an adapter may have. discoverCapabilities is the sole other member. */
export const READ_METHODS = ['listCostRecords', 'listTagTaxonomy', 'listAccountMappings', 'listMigrations', 'getControlTotals'] as const;

/**
 * Read-only by construction: no method creates, updates, deletes or syncs anything.
 * Private helpers must live outside the adapter object (module-scope functions or
 * #private fields); the contract suite rejects any other function-valued member.
 */
export interface SrmdAdapter {
  readonly descriptor: Envelope & { id: string };
  discoverCapabilities(): Promise<CapabilityReport>;
  listCostRecords(query?: CostQuery): Promise<SrmdResult<SrmdCostRecord[]>>;
  listTagTaxonomy(): Promise<SrmdResult<TagKey[]>>;
  listAccountMappings(): Promise<SrmdResult<never[]>>;
  listMigrations(): Promise<SrmdResult<never[]>>;
  getControlTotals(): Promise<SrmdResult<ControlTotal[]>>;
}
