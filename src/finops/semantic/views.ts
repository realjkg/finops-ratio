// Unified FinOps view registry (S1): the named views every consumer (report pages, the future AI tool
// registry, A2A) queries through one typed ViewQuery. Pure declarations: no SQL, no I/O. Each view names
// its system of record, grain, keys, money fields (currency per row, bases kept separate, never summed
// across currencies), provenance and freshness fields, and what it still needs. S1 implements the
// validator and the reconciliation identities only; executors come in later slices (S2+).
// Owner sources are described in words, not table names, so a client import never carries reader SQL.

/** Filter/group-by dimensions and the shape each value must have. */
export const DIMENSIONS = {
  billingPeriod: 'month', currency: 'currency', sourceId: 'uuid', chargeCategory: 'chargeCategory', serviceCategory: 'token',
  basis: 'basis', businessUnit: 'token', workload: 'token', method: 'token', vendor: 'token', model: 'token', project: 'token',
  tokenCategory: 'token', resourceId: 'token', sourceRole: 'token', identity: 'identity', status: 'status',
} as const;
export type Dimension = keyof typeof DIMENSIONS;
export type MoneyBasis = 'billed' | 'effective' | 'estimated' | 'budget';

export interface ViewDefinition {
  id: ViewId;
  title: string;
  /** System of record the view is read from (an existing reader view, the engagement config, or derived). */
  ownerSource: string;
  grain: readonly string[];
  keys: readonly string[];
  /** null: the view carries no money. Each basis is its own field; bases are never added together. */
  money: { currencyField: 'currency'; bases: readonly MoneyBasis[] } | null;
  provenance: readonly string[];
  freshness: readonly string[];
  measures: readonly string[];
  dimensions: readonly Dimension[];
  /** 'tenant': only a tenant-wide scope may read it; 'business_unit': rows are limited to the caller's BUs. */
  scopeLevel: 'tenant' | 'business_unit';
  /** Prerequisites that do not exist yet (empty: the inputs exist on main). */
  needs: readonly string[];
}

const PROV = ['batchIds', 'artifactSha256', 'configSha256'] as const;
const FRESH = ['asOf', 'publishedAt', 'dataThrough'] as const;
const MONEY = (...bases: MoneyBasis[]) => ({ currencyField: 'currency' as const, bases });

const defs = [
  { id: 'published_costs', title: 'Published costs', ownerSource: 'published cost facts (reader view, tenant-scoped, immutable batches)', grain: ['period', 'source', 'currency', 'chargeCategory'], keys: ['sourceId', 'billingPeriod', 'currency', 'chargeCategory'], money: MONEY('billed', 'effective'), provenance: [...PROV, 'focusVersion'], freshness: FRESH, measures: ['billedCost', 'effectiveCost', 'rowCount', 'rowsWithoutEffectiveCost'], dimensions: ['billingPeriod', 'currency', 'sourceId', 'chargeCategory', 'serviceCategory'], scopeLevel: 'tenant', needs: ['R4 trust views (migration 0005) for source keys and batch status'] },
  { id: 'cost_by_business_unit', title: 'Cost by business unit', ownerSource: 'published cost facts plus the engagement attribution rules (tag, account map, export column)', grain: ['period', 'currency', 'basis', 'businessUnit', 'workload'], keys: ['businessUnit', 'workload', 'method'], money: MONEY('billed', 'effective'), provenance: PROV, freshness: FRESH, measures: ['allocatedBilledCost', 'allocatedEffectiveCost', 'unallocatedBilledCost', 'unallocatedEffectiveCost'], dimensions: ['billingPeriod', 'currency', 'basis', 'businessUnit', 'workload', 'method'], scopeLevel: 'business_unit', needs: ['R6 attribution', 'R2 team grants for BU scope'] },
  { id: 'budget_vs_actual', title: 'Budget vs actual', ownerSource: 'engagement config budgets plus cost by business unit', grain: ['period', 'workload'], keys: ['workload', 'businessUnit'], money: MONEY('budget', 'effective'), provenance: ['configSha256', 'batchIds'], freshness: ['asOf', 'dataThrough', 'periodState'], measures: ['budget', 'actualEffectiveCost', 'variance', 'forecast'], dimensions: ['billingPeriod', 'currency', 'businessUnit', 'workload'], scopeLevel: 'business_unit', needs: ['R7 budgets and forecast', 'R6 attribution'] },
  { id: 'outcomes_value', title: 'Outcomes and value', ownerSource: 'outcome ledger period counts or the R9 outcomes file', grain: ['period', 'workload', 'currency'], keys: ['workload', 'billingPeriod'], money: MONEY('effective'), provenance: ['outcomeBatchIds', 'outcomesFileSha256', 'configSha256'], freshness: ['asOf', 'dataAsOf'], measures: ['acceptedOutcomes', 'costPerAcceptedOutcome', 'validatedBenefit'], dimensions: ['billingPeriod', 'currency', 'businessUnit', 'workload'], scopeLevel: 'business_unit', needs: ['R9 outcomes'] },
  { id: 'ai_usage', title: 'AI usage', ownerSource: 'enrichment observations from AI vendor usage reports', grain: ['day', 'vendor', 'model', 'project'], keys: ['vendor', 'model', 'project', 'tokenCategory'], money: MONEY('estimated'), provenance: ['observationBatchIds', 'vendorReportWindow', 'paginationComplete'], freshness: ['asOf', 'observedThrough'], measures: ['tokens', 'estimatedCost'], dimensions: ['billingPeriod', 'currency', 'vendor', 'model', 'project', 'tokenCategory', 'businessUnit'], scopeLevel: 'business_unit', needs: ['E2 enrichment (migration 0006)', 'M6b AI usage connectors'] },
  { id: 'ai_billed_cost', title: 'AI billed cost', ownerSource: 'published cost facts in the AI and Machine Learning service category, or an AI vendor source', grain: ['period', 'source', 'currency', 'chargeCategory'], keys: ['sourceId', 'billingPeriod', 'currency', 'chargeCategory'], money: MONEY('billed', 'effective'), provenance: [...PROV, 'focusVersion'], freshness: FRESH, measures: ['billedCost', 'effectiveCost', 'rowCount'], dimensions: ['billingPeriod', 'currency', 'sourceId', 'chargeCategory', 'vendor'], scopeLevel: 'tenant', needs: ['M6a for vendor-billed AI'] },
  { id: 'inventory_mapping', title: 'Inventory mapping', ownerSource: 'enrichment observations from CMDB, Nutanix and OpenCost', grain: ['resource', 'version'], keys: ['resourceId', 'sourceId'], money: null, provenance: ['sourceWatermark', 'schemaHash', 'mappingVersion'], freshness: ['asOf', 'observedThrough'], measures: ['mappedResources', 'unmappedResources'], dimensions: ['sourceId', 'resourceId', 'businessUnit'], scopeLevel: 'tenant', needs: ['E2 enrichment (migration 0006)', 'M5/M7/M8 connectors'] },
  { id: 'source_registry', title: 'Source registry', ownerSource: 'engagement config sources metadata plus batch status', grain: ['source', 'period'], keys: ['sourceId'], money: MONEY('billed', 'effective'), provenance: ['configSha256', 'importMetadataSha256'], freshness: ['asOf', 'publishedAt'], measures: ['declaredControlTotal', 'rowCount', 'batchCount'], dimensions: ['billingPeriod', 'currency', 'sourceId', 'sourceRole', 'status'], scopeLevel: 'tenant', needs: ['R4 trust views (migration 0005)'] },
  { id: 'reconciliation_results', title: 'Reconciliation results', ownerSource: 'derived on read from the views above (identities I1 to I8); not stored', grain: ['identity', 'period', 'currency', 'basis'], keys: ['identity', 'billingPeriod', 'currency', 'basis'], money: MONEY('billed', 'effective'), provenance: ['batchIds', 'configSha256'], freshness: ['asOf'], measures: ['residual', 'resultCount'], dimensions: ['identity', 'billingPeriod', 'currency', 'basis', 'status'], scopeLevel: 'tenant', needs: [] },
] as const satisfies ReadonlyArray<Omit<ViewDefinition, 'id'> & { id: string }>;

export type ViewId = (typeof defs)[number]['id'];
export const VIEW_IDS: readonly ViewId[] = defs.map((d) => d.id);
const byId = {} as Record<ViewId, ViewDefinition>;
for (const d of defs) byId[d.id] = d;
export const VIEWS: Readonly<Record<ViewId, ViewDefinition>> = Object.freeze(byId);
