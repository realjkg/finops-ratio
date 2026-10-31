// Deterministic SYNTHETIC FOCUS 1.0 datasets for the demo's three simulated API connections:
// a public cloud API, a private cloud API (OpenStack-style) and an on-premise API (Kubernetes /
// OpenCost-style). Every vendor, account and resource is fictional ("Example ..."). Money is built
// and summed as BigInt in units of 1e-10 and printed as exact decimal strings: no floats.
// Missing data stays empty (FOCUS null) and each empty column is explained in naReasons, never 0.
//
//   npx tsx scripts/generate-demo-datasets.ts     (writes src/demo/apiDatasets/data/*.json)
//
// The browser never imports this file (src/ingest is server-only): it loads the committed JSON.
import { COLUMNS, formatUnits, rng } from './syntheticFocus';

/** The FOCUS 1.0 columns of the repo's synthetic export, without the AWS-specific x_ extensions. */
export const DATASET_COLUMNS: string[] = COLUMNS.filter((c) => !c.startsWith('x_'));
import type { ConnectionType, CurrencyTotals, Dataset } from '../../demo/apiDatasets/types';
export type { ConnectionType, CurrencyTotals, Dataset, DatasetMeta } from '../../demo/apiDatasets/types';

const U = BigInt('10000000000'); // 1 currency unit
const cents = (c: number) => (BigInt(c) * U) / BigInt(100);
const ZERO = BigInt(0);
const PERIOD = { start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' };
const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T00:00:00Z`;
const dayEnd = (d: number) => (d >= 30 ? PERIOD.end : day(d + 1));

import { COMMON_NA_REASONS } from '../../demo/apiDatasets/commonNaReasons';
export { COMMON_NA_REASONS };

interface Service { name: string; category: string; unit: string; code: string }
interface Spec {
  id: string; name: string; type: ConnectionType; apiStyle: string; provider: string; issuer: string; currency: string;
  account: [string, string]; subAccounts: string[]; regions: [string, string][]; services: Service[];
  seed: string; usageRows: number; lastImport: string; maxQty: number;
}
type Cells = Partial<Record<string, string>>;

function build(spec: Spec, extra: (ctx: Ctx) => void, naReasons: Record<string, string>, zeroBilledReason?: string): Dataset {
  const r = rng(spec.seed);
  const rows: Cells[] = [];
  const ctx: Ctx = { spec, r, rows, push: (c) => rows.push(c) };
  const base = (c: Cells): Cells => ({
    BillingAccountId: spec.account[0], BillingAccountName: spec.account[1], BillingCurrency: spec.currency,
    BillingPeriodStart: PERIOD.start, BillingPeriodEnd: PERIOD.end, ChargeFrequency: 'Usage-Based',
    InvoiceIssuerName: spec.issuer, ProviderName: spec.provider, PublisherName: spec.provider, ...c,
  });
  ctx.line = base;
  extra(ctx);
  // Chronological, with ties kept in generation order (Array.prototype.sort is stable).
  const sorted = rows.slice().sort((a, b) => (a.ChargePeriodStart ?? '').localeCompare(b.ChargePeriodStart ?? ''));
  const full: string[][] = sorted.map((c) => DATASET_COLUMNS.map((col) => c[col] ?? ''));
  const totals: Record<string, CurrencyTotals> = {};
  const bi = DATASET_COLUMNS.indexOf('BilledCost');
  const ei = DATASET_COLUMNS.indexOf('EffectiveCost');
  let billed = ZERO;
  let effective = ZERO;
  let naB = 0;
  let naE = 0;
  for (const row of full) {
    if (row[bi] === '') naB++; else billed += parseUnits(row[bi]);
    if (row[ei] === '') naE++; else effective += parseUnits(row[ei]);
  }
  totals[spec.currency] = { rows: full.length, billed: formatUnits(billed), effective: formatUnits(effective), naBilled: naB, naEffective: naE };
  return {
    meta: {
      id: spec.id, name: spec.name, connectionType: spec.type, apiStyle: spec.apiStyle, provider: spec.provider, currency: spec.currency,
      lastImport: spec.lastImport, billingPeriod: '2026-09', rowCount: full.length, controlTotals: totals,
      naReasons, ...(zeroBilledReason ? { zeroBilledReason } : {}), synthetic: true,
    },
    columns: DATASET_COLUMNS,
    rows: full,
  };
}

interface Ctx { spec: Spec; r: () => number; rows: Cells[]; push: (c: Cells) => void; line?: (c: Cells) => Cells }

/** Parses a plain decimal with up to 10 places into 1e-10 units (exact). */
export function parseUnits(v: string): bigint {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(v);
  if (!m) throw new Error(`not a plain decimal: ${v}`);
  const n = BigInt((m[2] || '0') + (m[3] ?? '').padEnd(10, '0'));
  return m[1] === '-' ? -n : n;
}

/** One usage line: list = qty x unit price; `factor` (out of 100) turns it into the contracted/effective cost. */
function usageLine(c: Ctx, i: number, opts: { committed?: boolean; billedZero?: boolean; ownedHardware?: boolean }): { cells: Cells; list: bigint; effective: bigint } {
  const { spec, r } = c;
  const svc = spec.services[r() % spec.services.length];
  const d = 1 + (r() % 30);
  const qty = BigInt(1 + (r() % spec.maxQty));
  const unit = BigInt(1 + (r() % 400)) * BigInt(1_000_000); // 0.0001 .. 0.04 per unit
  const list = qty * unit;
  const effective = opts.committed ? (list * BigInt(70)) / BigInt(100) : list;
  const [region, regionName] = spec.regions[r() % spec.regions.length];
  const sub = spec.subAccounts[r() % spec.subAccounts.length];
  const res = `example-${svc.code.toLowerCase()}-${String(r() % 40).padStart(2, '0')}`;
  const cells: Cells = c.line!({
    AvailabilityZone: `${region}a`,
    BilledCost: formatUnits(opts.billedZero ? ZERO : effective),
    ChargeCategory: 'Usage',
    ChargeDescription: `${svc.name}, synthetic line ${i}`,
    ChargePeriodStart: day(d), ChargePeriodEnd: dayEnd(d),
    ConsumedQuantity: qty.toString(), ConsumedUnit: svc.unit,
    // ContractedCost is the price before any commitment discount; the discount appears only in EffectiveCost.
    ContractedCost: formatUnits(list), EffectiveCost: formatUnits(effective), ListCost: formatUnits(list),
    ContractedUnitPrice: formatUnits(unit), ListUnitPrice: formatUnits(unit),
    PricingCategory: opts.committed ? 'Committed' : 'Standard', PricingQuantity: qty.toString(), PricingUnit: svc.unit,
    RegionId: region, RegionName: regionName, ResourceId: res, ResourceName: res, ResourceType: svc.category,
    ServiceCategory: svc.category, ServiceName: svc.name, SkuId: `EX-SKU-${svc.code}`, SkuPriceId: `EX-PRICE-${svc.code}-${r() % 5}`,
    SubAccountId: sub, SubAccountName: `Example ${sub}`,
    Tags: JSON.stringify({ env: r() % 2 ? 'prod' : 'dev', team: `team-${r() % 4}` }),
  });
  return { cells, list, effective };
}

function commitment(c: Ctx, p: { id: string; name: string; type: string; total: bigint; months: number; usageFrom: number; usageCount: number; note: string; svcIndex: number }): void {
  // A prepaid commitment: BilledCost covers `months` at once, EffectiveCost amortizes one month across the
  // covered usage (Used) plus the unused remainder, so Billed and Effective legitimately differ.
  const monthly = p.total / BigInt(p.months);
  let used = ZERO;
  for (let k = 0; k < p.usageCount; k++) {
    const { cells, effective } = usageLine(c, p.usageFrom + k, { committed: true, billedZero: true });
    used += effective;
    c.push({ ...cells, CommitmentDiscountCategory: 'Spend', CommitmentDiscountId: p.id, CommitmentDiscountName: p.name, CommitmentDiscountStatus: 'Used', CommitmentDiscountType: p.type });
  }
  if (used >= monthly) throw new Error(`commitment ${p.id}: used ${used} exceeds the monthly amortization ${monthly}`);
  const svc = c.spec.services[p.svcIndex];
  const common: Cells = { ChargePeriodStart: PERIOD.start, ChargePeriodEnd: PERIOD.end, ServiceName: svc.name, ServiceCategory: svc.category, CommitmentDiscountCategory: 'Spend', CommitmentDiscountId: p.id, CommitmentDiscountName: p.name, CommitmentDiscountType: p.type };
  c.push(c.line!({ ...common, ChargeCategory: 'Purchase', ChargeDescription: p.note, ChargeFrequency: 'One-Time', BilledCost: formatUnits(p.total), EffectiveCost: formatUnits(ZERO), ContractedCost: formatUnits(p.total), ListCost: formatUnits(p.total), PricingCategory: 'Standard', PricingQuantity: '1', PricingUnit: 'Commitments', ListUnitPrice: formatUnits(p.total), ContractedUnitPrice: formatUnits(p.total) }));
  c.push(c.line!({ ...common, ChargeCategory: 'Usage', ChargeDescription: `Unused part of ${p.name} this month`, BilledCost: formatUnits(ZERO), EffectiveCost: formatUnits(monthly - used), ContractedCost: formatUnits(monthly - used), ListCost: formatUnits(monthly - used), CommitmentDiscountStatus: 'Unused', PricingCategory: 'Committed', PricingQuantity: '1', PricingUnit: 'Months', ListUnitPrice: formatUnits(monthly - used), ContractedUnitPrice: formatUnits(monthly - used), ConsumedQuantity: '0', ConsumedUnit: 'Months' }));
}

const specs: Record<'public' | 'private' | 'onprem', Spec> = {
  public: {
    id: 'syn-public-cloud-api', name: 'Example Cloud billing API', type: 'public_cloud', apiStyle: 'Provider billing export API (REST)', provider: 'Example Cloud', issuer: 'Example Cloud Inc.',
    currency: 'USD', account: ['example-billing-0001', 'Example Billing Account'], subAccounts: ['example-sub-a', 'example-sub-b', 'example-sub-c'],
    regions: [['ex-east-1', 'Example East'], ['ex-west-1', 'Example West']],
    services: [
      { name: 'Example Compute', category: 'Compute', unit: 'Hours', code: 'Compute' }, { name: 'Example Object Storage', category: 'Storage', unit: 'GB-Mo', code: 'Storage' },
      { name: 'Example Database', category: 'Databases', unit: 'Hours', code: 'Database' }, { name: 'Example Inference', category: 'AI and Machine Learning', unit: '1K Tokens', code: 'Inference' },
    ],
    seed: 'ratio-demo-public-2026-09', usageRows: 96, lastImport: '2026-10-30T06:00:00Z', maxQty: 2000,
  },
  private: {
    id: 'syn-private-cloud-api', name: 'Example Private Cloud usage API', type: 'private_cloud', apiStyle: 'OpenStack-style usage and chargeback API', provider: 'Example Private Cloud', issuer: 'Example IT Chargeback',
    currency: 'EUR', account: ['example-tenant-0001', 'Example Private Tenant'], subAccounts: ['example-project-1', 'example-project-2', 'example-project-3', 'example-project-4'],
    regions: [['ex-dc-fra', 'Example DC Frankfurt'], ['ex-dc-ams', 'Example DC Amsterdam']],
    services: [
      { name: 'Example vCPU', category: 'Compute', unit: 'vCPU-Hours', code: 'Vcpu' }, { name: 'Example Memory', category: 'Compute', unit: 'GB-Hours', code: 'Memory' },
      { name: 'Example Block Storage', category: 'Storage', unit: 'GB-Mo', code: 'Block' }, { name: 'Example Floating IPs', category: 'Networking', unit: 'IP-Hours', code: 'Fip' },
    ],
    seed: 'ratio-demo-private-2026-09', usageRows: 100, lastImport: '2026-10-30T06:20:00Z', maxQty: 1500,
  },
  onprem: {
    id: 'syn-on-premise-api', name: 'Example Datacenter cost allocation API', type: 'on_premise', apiStyle: 'Kubernetes cost allocation API (OpenCost-style)', provider: 'Example Datacenter', issuer: 'Example Datacenter Ops',
    currency: 'USD', account: ['example-dc-cluster-01', 'Example DC Cluster 01'], subAccounts: ['example-ns-payments', 'example-ns-search', 'example-ns-data', 'example-ns-platform'],
    regions: [['ex-dc-hq', 'Example Datacenter HQ']],
    services: [
      { name: 'Example CPU allocation', category: 'Compute', unit: 'Core-Hours', code: 'Cpu' }, { name: 'Example RAM allocation', category: 'Compute', unit: 'GiB-Hours', code: 'Ram' },
      { name: 'Example Persistent volume', category: 'Storage', unit: 'GiB-Days', code: 'Pv' }, { name: 'Example GPU allocation', category: 'AI and Machine Learning', unit: 'GPU-Hours', code: 'Gpu' },
    ],
    seed: 'ratio-demo-onprem-2026-09', usageRows: 100, lastImport: '2026-10-30T06:40:00Z', maxQty: 1000,
  },
};

const adjustment = (c: Ctx, amount: bigint, description: string, cls: string): Cells =>
  c.line!({ ChargeCategory: 'Adjustment', ChargeClass: cls, ChargeDescription: description, ChargeFrequency: 'One-Time', ChargePeriodStart: day(28), ChargePeriodEnd: day(29), BilledCost: formatUnits(amount), EffectiveCost: formatUnits(amount), ContractedCost: formatUnits(amount), ListCost: formatUnits(ZERO), ServiceName: 'Adjustments', ServiceCategory: 'Other' });

export function generatePublicCloud(): Dataset {
  return build(specs.public, (c) => {
    commitment(c, { id: 'example-sp-0001', name: 'Example Compute Savings Plan', type: 'Savings Plan', total: cents(60000), months: 3, usageFrom: 1000, usageCount: 6, svcIndex: 0, note: 'Example Compute Savings Plan, 3 months, all upfront' });
    let taxable = ZERO;
    for (let i = 0; i < c.spec.usageRows; i++) {
      const { cells, effective } = usageLine(c, i, {});
      taxable += effective;
      c.push(cells);
    }
    for (const [amount, text] of [[cents(-2500), 'Example promotional credit'], [cents(-750), 'Example service-level credit']] as const) {
      c.push(c.line!({ ChargeCategory: 'Credit', ChargeDescription: text, ChargeFrequency: 'One-Time', ChargePeriodStart: PERIOD.start, ChargePeriodEnd: PERIOD.end, BilledCost: formatUnits(amount), EffectiveCost: formatUnits(amount), ContractedCost: formatUnits(amount), ListCost: formatUnits(ZERO), ServiceName: 'Credits', ServiceCategory: 'Other' }));
    }
    c.push(c.line!({ ChargeCategory: 'Tax', ChargeDescription: 'Example sales tax, 8% of standard usage', ChargeFrequency: 'Recurring', ChargePeriodStart: PERIOD.start, ChargePeriodEnd: PERIOD.end, BilledCost: formatUnits((taxable * BigInt(8)) / BigInt(100)), EffectiveCost: formatUnits((taxable * BigInt(8)) / BigInt(100)), ContractedCost: formatUnits((taxable * BigInt(8)) / BigInt(100)), ListCost: formatUnits((taxable * BigInt(8)) / BigInt(100)), ServiceName: 'Tax', ServiceCategory: 'Other' }));
    c.push(adjustment(c, cents(-314), 'Example billing correction for August', 'Correction'));
  }, { ...COMMON_NA_REASONS });
}

export function generatePrivateCloud(): Dataset {
  return build(specs.private, (c) => {
    commitment(c, { id: 'example-rc-0001', name: 'Example reserved capacity block', type: 'Reserved Capacity', total: cents(90000), months: 3, usageFrom: 1000, usageCount: 6, svcIndex: 0, note: 'Example reserved capacity block, billed quarterly' });
    for (let i = 0; i < c.spec.usageRows; i++) c.push(usageLine(c, i, {}).cells);
    c.push(c.line!({ ChargeCategory: 'Credit', ChargeDescription: 'Example internal chargeback credit', ChargeFrequency: 'One-Time', ChargePeriodStart: PERIOD.start, ChargePeriodEnd: PERIOD.end, BilledCost: formatUnits(cents(-4000)), EffectiveCost: formatUnits(cents(-4000)), ContractedCost: formatUnits(cents(-4000)), ListCost: formatUnits(ZERO), ServiceName: 'Credits', ServiceCategory: 'Other' }));
  }, { ...COMMON_NA_REASONS });
}

export function generateOnPremise(): Dataset {
  return build(specs.onprem, (c) => {
    for (let i = 0; i < c.spec.usageRows; i++) {
      const { cells } = usageLine(c, i, { billedZero: true });
      c.push({ ...cells, ChargeDescription: `${cells.ChargeDescription} (hardware depreciation share)`, PricingCategory: 'Other' });
    }
    // Idle capacity is reserved by the cluster itself, so its quantity is the capacity held; the cost is real.
    for (let k = 0; k < 4; k++) {
      const { cells, effective } = usageLine(c, 500 + k, { billedZero: true });
      c.push({ ...cells, SubAccountId: 'example-ns-idle', SubAccountName: 'Example idle capacity', ChargeDescription: 'Idle capacity share (held by the cluster, unallocated)', PricingCategory: 'Other', EffectiveCost: formatUnits(effective) });
    }
    // The one real invoice: power and cooling (Billed = Effective).
    const power = cents(180000);
    c.push(c.line!({ ChargeCategory: 'Usage', ChargeDescription: 'Example power and cooling invoice', ChargePeriodStart: PERIOD.start, ChargePeriodEnd: PERIOD.end, BilledCost: formatUnits(power), EffectiveCost: formatUnits(power), ContractedCost: formatUnits(power), ListCost: formatUnits(power), PricingCategory: 'Standard', PricingQuantity: '1', PricingUnit: 'Months', ListUnitPrice: formatUnits(power), ContractedUnitPrice: formatUnits(power), ConsumedQuantity: '1', ConsumedUnit: 'Months', ServiceName: 'Example Power and cooling', ServiceCategory: 'Other', ResourceId: 'example-dc-hall-1', ResourceName: 'example-dc-hall-1', ResourceType: 'Facility', SubAccountId: 'example-facilities', SubAccountName: 'Example facilities', RegionId: 'ex-dc-hq', RegionName: 'Example Datacenter HQ' }));
    c.push(adjustment(c, cents(-1234), 'Example metering correction for August', 'Correction'));
  }, { ...COMMON_NA_REASONS }, 'Owned hardware has no vendor invoice: its allocation is a true 0 billed (no vendor invoice) and carries its cost, priced at the rate card, in EffectiveCost (amortized).');
}

export const GENERATORS = { 'syn-public-cloud-api': generatePublicCloud, 'syn-private-cloud-api': generatePrivateCloud, 'syn-on-premise-api': generateOnPremise } as const;
export type DatasetId = keyof typeof GENERATORS;

/** Compact JSON, one row per line (small and reviewable). */
export function serializeDataset(d: Dataset): string {
  return `{"meta":${JSON.stringify(d.meta)},\n"columns":${JSON.stringify(d.columns)},\n"rows":[\n${d.rows.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
}
