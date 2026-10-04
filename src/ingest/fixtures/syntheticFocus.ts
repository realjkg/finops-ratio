// Deterministic SYNTHETIC FOCUS 1.0 export generator in the AWS Data Exports
// layout. Not real provider data: provider "SyntheticCloud", invented ids and
// amounts. Money is generated and summed as BigInt (units of 1e-10) and printed
// with exactly 10 decimal places — no JS floating point anywhere.
//
// Variants:
//   base         2026-07 (2 files, deliberate duplicate legitimate rows) + 2026-08 (1 file), control totals
//   restatement  2026-07 re-exported under a new run (changed amounts + a credit), 2026-08 unchanged
//   nocontrol    base data, manifests without control totals
//   variance     2026-08 only: one extra row, but the manifest still carries base's control totals
//   corrupt      2026-08 only: one row with an unparseable BilledCost
import zlib from 'zlib';

export type FixtureVariant = 'base' | 'restatement' | 'nocontrol' | 'variance' | 'corrupt';
export const COMMITTED_VARIANTS = ['base', 'restatement'] as const;
export const FIXTURE_LOCATION = { prefix: 'ratio-synthetic', exportName: 'focus-export' } as const;

export interface GeneratedExport {
  variant: FixtureVariant;
  /** Bucket-relative objects (data .csv.gz + manifests). */
  objects: Array<{ key: string; bytes: Buffer }>;
  /** Uncompressed CSV text per data object key. */
  csvByKey: Record<string, string>;
  /** Manifest JSON text per manifest key. */
  manifestsByKey: Record<string, string>;
  /** Exact totals of the data each manifest points to (empty for 'corrupt'). */
  totals: Record<string, { rowCount: number; billedTotal: string }>;
}

export const COLUMNS = [
  'AvailabilityZone', 'BilledCost', 'BillingAccountId', 'BillingAccountName', 'BillingCurrency', 'BillingPeriodEnd',
  'BillingPeriodStart', 'ChargeCategory', 'ChargeClass', 'ChargeDescription', 'ChargeFrequency', 'ChargePeriodEnd',
  'ChargePeriodStart', 'CommitmentDiscountCategory', 'CommitmentDiscountId', 'CommitmentDiscountName',
  'CommitmentDiscountStatus', 'CommitmentDiscountType', 'ConsumedQuantity', 'ConsumedUnit', 'ContractedCost',
  'ContractedUnitPrice', 'EffectiveCost', 'InvoiceIssuerName', 'ListCost', 'ListUnitPrice', 'PricingCategory',
  'PricingQuantity', 'PricingUnit', 'ProviderName', 'PublisherName', 'RegionId', 'RegionName', 'ResourceId',
  'ResourceName', 'ResourceType', 'ServiceCategory', 'ServiceName', 'SkuId', 'SkuPriceId', 'SubAccountId',
  'SubAccountName', 'Tags', 'x_CostCategories', 'x_Discounts', 'x_Operation', 'x_ServiceCode', 'x_UsageType',
] as const;

const SCALE = BigInt('10000000000');

/** Exact fixed-point formatting with 10 decimal places. */
export function formatUnits(u: bigint): string {
  const neg = u < BigInt(0);
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${a / SCALE}.${(a % SCALE).toString().padStart(10, '0')}`;
}

/** xorshift32 — integer-only PRNG (deterministic across platforms). */
function rng(seed: string): () => number {
  let s = 2166136261;
  for (let i = 0; i < seed.length; i++) s = Math.imul(s ^ seed.charCodeAt(i), 16777619) >>> 0;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

const SERVICES = [
  { name: 'Synthetic Compute', category: 'Compute', code: 'SynCompute', unit: 'Hours', op: 'RunInstances' },
  { name: 'Synthetic Object Storage', category: 'Storage', code: 'SynStorage', unit: 'GB-Mo', op: 'PutObject' },
  { name: 'Synthetic Inference', category: 'AI and Machine Learning', code: 'SynInference', unit: '1K Tokens', op: 'InvokeModel' },
  { name: 'Synthetic Network', category: 'Networking', code: 'SynNetwork', unit: 'GB', op: 'DataTransfer' },
];

type Row = Record<(typeof COLUMNS)[number], string>;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function nextMonth(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
}

function makeRow(period: string, r: () => number, i: number, billedUnits?: bigint): { row: Row; billed: bigint } {
  const svc = SERVICES[r() % SERVICES.length];
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = 1 + (r() % days);
  const start = `${period.slice(0, 8)}${pad2(day)}T00:00:00Z`;
  const end = day === days ? `${nextMonth(period)}T00:00:00Z` : `${period.slice(0, 8)}${pad2(day + 1)}T00:00:00Z`;
  const qty = BigInt(1 + (r() % 500));
  const unitPrice = BigInt(r() % 40_000_000) + BigInt(1); // ≤ 0.004 per unit, in 1e-10 units
  const billed = billedUnits ?? qty * unitPrice;
  const list = billed + billed / BigInt(5);
  const account = `syn-sub-${(r() % 3) + 1}`;
  const resource = `syn-res-${svc.code.toLowerCase()}-${r() % 50}`;
  const row: Row = {
    AvailabilityZone: `syn-zone-${(r() % 2) + 1}a`,
    BilledCost: formatUnits(billed),
    BillingAccountId: 'syn-billing-account-001',
    BillingAccountName: 'Synthetic Billing Account',
    BillingCurrency: 'USD',
    BillingPeriodEnd: `${nextMonth(period)}T00:00:00Z`,
    BillingPeriodStart: `${period}T00:00:00Z`,
    ChargeCategory: billed < BigInt(0) ? 'Credit' : 'Usage',
    ChargeClass: '',
    ChargeDescription: `${svc.name} usage, synthetic line ${i}`,
    ChargeFrequency: 'Usage-Based',
    ChargePeriodEnd: end,
    ChargePeriodStart: start,
    CommitmentDiscountCategory: '',
    CommitmentDiscountId: '',
    CommitmentDiscountName: '',
    CommitmentDiscountStatus: '',
    CommitmentDiscountType: '',
    ConsumedQuantity: qty.toString(),
    ConsumedUnit: svc.unit,
    ContractedCost: formatUnits(billed),
    ContractedUnitPrice: formatUnits(unitPrice),
    EffectiveCost: formatUnits(billed),
    InvoiceIssuerName: 'SyntheticCloud',
    ListCost: formatUnits(list),
    ListUnitPrice: formatUnits(unitPrice + unitPrice / BigInt(5)),
    PricingCategory: 'Standard',
    PricingQuantity: qty.toString(),
    PricingUnit: svc.unit,
    ProviderName: 'SyntheticCloud',
    PublisherName: 'SyntheticCloud',
    RegionId: 'syn-region-1',
    RegionName: 'Synthetic Region One',
    ResourceId: resource,
    ResourceName: resource,
    ResourceType: svc.category,
    ServiceCategory: svc.category,
    ServiceName: svc.name,
    SkuId: `SYN-SKU-${svc.code}`,
    SkuPriceId: `SYN-PRICE-${svc.code}-${r() % 5}`,
    SubAccountId: account,
    SubAccountName: `Synthetic ${account}`,
    Tags: JSON.stringify({ env: r() % 2 ? 'prod' : 'dev', team: `team-${r() % 4}`, note: 'synthetic, "quoted"' }),
    x_CostCategories: '{}',
    x_Discounts: '',
    x_Operation: svc.op,
    x_ServiceCode: svc.code,
    x_UsageType: `SYN:${svc.code}:Usage`,
  };
  return { row, billed };
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(rows: Row[]): string {
  return [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvField(r[c])).join(','))].join('\n') + '\n';
}

interface FileSpec {
  rows: Row[];
  billed: bigint[];
}

function july(variant: FixtureVariant): FileSpec[] {
  const r = rng('ratio-synthetic-2026-07');
  const f1: FileSpec = { rows: [], billed: [] };
  const f2: FileSpec = { rows: [], billed: [] };
  const push = (f: FileSpec, x: { row: Row; billed: bigint }) => {
    f.rows.push(x.row);
    f.billed.push(x.billed);
  };
  for (let i = 0; i < 28; i++) {
    // Rows 0 and 1 carry 0.1 and 0.2 exactly (classic float trap).
    const fixed = i === 0 ? BigInt(1_000_000_000) : i === 1 ? BigInt(2_000_000_000) : undefined;
    push(f1, makeRow('2026-07-01', r, i, fixed));
  }
  // Deliberate duplicate legitimate rows: line 3 occurs three times in file 1.
  push(f1, { row: { ...f1.rows[3] }, billed: f1.billed[3] });
  push(f1, { row: { ...f1.rows[3] }, billed: f1.billed[3] });
  for (let i = 28; i < 52; i++) push(f2, makeRow('2026-07-01', r, i));
  // ... and line 7 of file 1 also appears, byte-identical, in file 2.
  push(f2, { row: { ...f1.rows[7] }, billed: f1.billed[7] });

  if (variant === 'restatement') {
    // Provider restated July: five lines re-rated, plus a credit line.
    for (let i = 10; i < 15; i++) {
      const b = f1.billed[i] + BigInt(12_345_000_000); // +1.2345
      f1.billed[i] = b;
      f1.rows[i] = { ...f1.rows[i], BilledCost: formatUnits(b), EffectiveCost: formatUnits(b), ContractedCost: formatUnits(b), ListCost: formatUnits(b + b / BigInt(5)) };
    }
    const credit = makeRow('2026-07-01', rng('ratio-synthetic-2026-07-credit'), 999, -BigInt(125_000_000_000)); // -12.5
    push(f2, credit);
  }
  return [f1, f2];
}

function august(variant: FixtureVariant): FileSpec[] {
  const r = rng('ratio-synthetic-2026-08');
  const f: FileSpec = { rows: [], billed: [] };
  for (let i = 0; i < 40; i++) {
    const x = makeRow('2026-08-01', r, i);
    f.rows.push(x.row);
    f.billed.push(x.billed);
  }
  if (variant === 'variance') {
    const x = makeRow('2026-08-01', rng('ratio-synthetic-2026-08-extra'), 40);
    f.rows.push(x.row);
    f.billed.push(x.billed);
  }
  if (variant === 'corrupt') f.rows[9] = { ...f.rows[9], BilledCost: 'twelve dollars' };
  return [f];
}

const RUN_IDS: Record<string, string> = {
  '2026-07:base': 'exec-20260802T040000Z-01',
  '2026-07:restatement': 'exec-20260903T040000Z-02',
  '2026-08:base': 'exec-20260902T040000Z-01',
  '2026-08:variance': 'exec-20260904T040000Z-03',
  '2026-08:corrupt': 'exec-20260905T040000Z-04',
};

export function generateSyntheticExport(opts: { variant: FixtureVariant; prefix?: string; exportName?: string }): GeneratedExport {
  const prefix = opts.prefix ?? FIXTURE_LOCATION.prefix;
  const exportName = opts.exportName ?? FIXTURE_LOCATION.exportName;
  const root = prefix ? `${prefix}/${exportName}` : exportName;
  const v = opts.variant;
  const out: GeneratedExport = { variant: v, objects: [], csvByKey: {}, manifestsByKey: {}, totals: {} };
  const baseAug = august('base');
  const periods: Array<{ period: string; files: FileSpec[]; run: string; control: { rowCount?: number; billedTotal?: string } | null }> = [];
  const totalsOf = (files: FileSpec[]) => ({
    rowCount: files.reduce((a, f) => a + f.rows.length, 0),
    billedTotal: formatUnits(files.reduce((a, f) => a + f.billed.reduce((x, y) => x + y, BigInt(0)), BigInt(0))),
  });

  if (v === 'base' || v === 'restatement' || v === 'nocontrol') {
    const jul = july(v === 'restatement' ? 'restatement' : 'base');
    periods.push({ period: '2026-07-01', files: jul, run: RUN_IDS[v === 'restatement' ? '2026-07:restatement' : '2026-07:base'], control: v === 'nocontrol' ? null : totalsOf(jul) });
    periods.push({ period: '2026-08-01', files: baseAug, run: RUN_IDS['2026-08:base'], control: v === 'nocontrol' ? null : totalsOf(baseAug) });
  } else if (v === 'variance') {
    periods.push({ period: '2026-08-01', files: august('variance'), run: RUN_IDS['2026-08:variance'], control: totalsOf(baseAug) });
  } else {
    const files = august('corrupt');
    periods.push({ period: '2026-08-01', files, run: RUN_IDS['2026-08:corrupt'], control: { rowCount: files[0].rows.length } });
  }

  for (const p of periods) {
    const ym = p.period.slice(0, 7);
    const dataKeys: string[] = [];
    p.files.forEach((f, idx) => {
      const key = `${root}/data/BILLING_PERIOD=${ym}/${p.run}/${exportName}-${String(idx + 1).padStart(5, '0')}.csv.gz`;
      const csv = toCsv(f.rows);
      out.csvByKey[key] = csv;
      out.objects.push({ key, bytes: zlib.gzipSync(Buffer.from(csv, 'utf8'), { level: 9 }) });
      dataKeys.push(key);
    });
    const manifest: Record<string, unknown> = {
      'x-ratio-synthetic': 'SYNTHETIC fixture generated by src/ingest/fixtures/syntheticFocus.ts; not real provider data',
      exportName,
      executionId: p.run,
      billingPeriod: { start: `${p.period}T00:00:00.000Z`, end: `${nextMonth(p.period)}T00:00:00.000Z` },
      dataFiles: dataKeys,
    };
    if (p.control) manifest['x-ratio-control'] = p.control;
    const mkey = `${root}/metadata/BILLING_PERIOD=${ym}/${exportName}-Manifest.json`;
    const text = JSON.stringify(manifest, null, 2) + '\n';
    out.manifestsByKey[mkey] = text;
    out.objects.push({ key: mkey, bytes: Buffer.from(text, 'utf8') });
    if (v !== 'corrupt') out.totals[p.period] = totalsOf(p.files);
  }
  out.objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}
