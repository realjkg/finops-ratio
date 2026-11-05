// The demo's synthetic API-connection datasets: deterministic, drift-checked against the committed
// JSON, and every row passes the repo's FOCUS validator (src/ingest/focus/validate.ts). Names are
// fictional and allowlisted; no real brand, email, IP, URL, ARN or key-shaped string appears.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { indexHeader, validateRow } from '../focus/validate';
import { COLUMNS } from './syntheticFocus';
import { COMMON_NA_REASONS, DATASET_COLUMNS, GENERATORS, parseUnits, serializeDataset, type Dataset, type DatasetId } from './demoApiDatasets';

const DIR = path.resolve(__dirname, '..', '..', 'demo', 'apiDatasets', 'data');
const ids = Object.keys(GENERATORS) as DatasetId[];
const committed = (id: DatasetId): Dataset => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
const MONEY = ['BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost', 'ListUnitPrice', 'ContractedUnitPrice'];
const col = (d: Dataset, name: string) => d.rows.map((r) => r[d.columns.indexOf(name)]);
const sum = (values: string[]) => values.filter((v) => v !== '').reduce((s, v) => s + parseUnits(v), BigInt(0));

// Names shown in the demo are fictional and come from this allowlist only: category-style providers and
// issuers, fictional business units and services. Nothing here is a real company, product or customer.
const FICTIONAL_NAMES = new Set([
  'Public cloud billing API', 'Private cloud usage API', 'On-premises cost allocation API',
  'Public cloud', 'Private cloud', 'On-premises data center', 'Public cloud billing', 'Internal IT chargeback', 'Data center operations',
  'Corporate billing account', 'Shared services tenant', 'Primary cluster',
  'Payments', 'Search', 'Data platform', 'Analytics', 'Platform', 'Idle capacity', 'Facilities',
  'East 1', 'West 1', 'North data center', 'South data center', 'Headquarters data center',
  'Virtual machines', 'Object storage', 'Managed database', 'Model inference', 'vCPU', 'Memory', 'Block storage', 'Floating IPs',
  'CPU allocation', 'RAM allocation', 'Persistent volume', 'GPU allocation', 'Power and cooling', 'Credits', 'Tax', 'Adjustments',
  'Compute savings plan', 'Reserved capacity block', '',
]);
const NAME_COLUMNS = ['ProviderName', 'PublisherName', 'InvoiceIssuerName', 'BillingAccountName', 'SubAccountName', 'RegionName', 'ServiceName', 'CommitmentDiscountName'];
const ID_COLUMNS = ['BillingAccountId', 'SubAccountId', 'RegionId', 'AvailabilityZone', 'ResourceId', 'ResourceName', 'SkuId', 'SkuPriceId', 'CommitmentDiscountId'];
/** Neutral lower-case ids ("acct-0001-payments", "compute-07") or SKU codes ("SKU-COMPUTE", "PRICE-GPU-3"). */
const ID_SHAPE = /^([a-z][a-z0-9]*(-[a-z0-9]+)*|(SKU|PRICE)(-[A-Z0-9]+)+)$/;
/** Real cloud, software and hardware brands (plus the old "Example" placeholder prefix) that must not appear as a vendor, account, resource or description. */
const REAL_BRANDS = /\b(aws|amazon|azure|microsoft|google|gcp|oracle|oci|ibm|alibaba|aliyun|tencent|huawei|digitalocean|linode|akamai|vultr|ovh|hetzner|rackspace|cloudflare|heroku|vercel|netlify|snowflake|databricks|openai|anthropic|nvidia|intel|amd|dell|hpe?|lenovo|cisco|vmware|broadcom|nutanix|red ?hat|openshift|equinix|digital realty|servicenow|salesforce|sap|stripe|paypal|visa|mastercard|elastic|algolia|datadog|splunk|pointfive|example)\b/i;

describe.each(ids)('%s', (id) => {
  const d = committed(id);

  it('is deterministic and the committed file matches the generator', () => {
    expect(GENERATORS[id]()).toEqual(GENERATORS[id]());
    expect(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')).toBe(serializeDataset(GENERATORS[id]()));
  });

  it('uses only FOCUS 1.0 columns of the repo synthetic export, and every row passes the validator', () => {
    expect(d.columns).toEqual(DATASET_COLUMNS);
    expect(d.columns.every((c) => (COLUMNS as readonly string[]).includes(c) && !c.startsWith('x_'))).toBe(true);
    const header = indexHeader(d.columns);
    if (!header.ok) throw new Error(JSON.stringify(header.errors));
    for (const [i, row] of d.rows.entries()) {
      const result = validateRow(row, header.index, '2026-09-01');
      expect(result.ok ? [] : result.errors, `row ${i}`).toEqual([]);
    }
  });

  it('keeps money as exact 10-place decimal strings (never floats) and one currency per dataset', () => {
    for (const name of MONEY) for (const v of col(d, name)) expect(v === '' || /^-?\d+\.\d{10}$/.test(v), `${name}=${v}`).toBe(true);
    expect(new Set(col(d, 'BillingCurrency'))).toEqual(new Set([d.meta.currency]));
    expect(Object.keys(d.meta.controlTotals)).toEqual([d.meta.currency]);
  });

  it('control totals equal an independent exact BigInt sum', () => {
    const t = d.meta.controlTotals[d.meta.currency];
    expect(d.meta.rowCount).toBe(d.rows.length);
    expect(t.rows).toBe(d.rows.length);
    const fmt = (u: bigint) => `${u < BigInt(0) ? '-' : ''}${(u < BigInt(0) ? -u : u) / BigInt('10000000000')}.${((u < BigInt(0) ? -u : u) % BigInt('10000000000')).toString().padStart(10, '0')}`;
    expect(t.billed).toBe(fmt(sum(col(d, 'BilledCost'))));
    expect(t.effective).toBe(fmt(sum(col(d, 'EffectiveCost'))));
    expect([t.naBilled, t.naEffective]).toEqual([col(d, 'BilledCost').filter((v) => v === '').length, col(d, 'EffectiveCost').filter((v) => v === '').length]);
  });

  it('Billed and Effective differ, and credits are negative', () => {
    const t = d.meta.controlTotals[d.meta.currency];
    expect(t.billed).not.toBe(t.effective);
    const cat = col(d, 'ChargeCategory');
    for (const [i, c] of cat.entries()) if (c === 'Credit') expect(parseUnits(col(d, 'BilledCost')[i]) < BigInt(0)).toBe(true);
  });

  it('every empty cell is N/A with a documented reason, never a silent 0', () => {
    const reasons = { ...COMMON_NA_REASONS, ...d.meta.naReasons };
    for (const [c, name] of d.columns.entries()) {
      if (d.rows.some((r) => r[c] === '')) expect(reasons[name], `${name} is empty but has no reason`).toBeTruthy();
    }
    for (const required of ['BilledCost', 'EffectiveCost', 'BillingCurrency', 'ChargeCategory', 'ProviderName', 'ServiceName']) expect(col(d, required).every((v) => v !== ''), required).toBe(true);
  });

  it('is marked synthetic in its meta, and every name column holds an allowlisted fictional name', () => {
    expect(d.meta.synthetic).toBe(true);
    for (const name of NAME_COLUMNS) {
      for (const v of new Set(col(d, name))) expect(FICTIONAL_NAMES.has(v), `${name}=${v} is not in the fictional allowlist`).toBe(true);
    }
    for (const name of ID_COLUMNS) {
      for (const v of new Set(col(d, name))) expect(v === '' || ID_SHAPE.test(v), `${name}=${v} is not a neutral id`).toBe(true);
    }
    expect(FICTIONAL_NAMES.has(d.meta.name) && FICTIONAL_NAMES.has(d.meta.provider)).toBe(true);
  });
});

describe('across the three connections', () => {
  const all = ids.map(committed);
  it('covers a public, a private and an on-premise connection, with a non-USD currency', () => {
    expect(all.map((d) => d.meta.connectionType)).toEqual(['public_cloud', 'private_cloud', 'on_premise']);
    expect(all.some((d) => d.meta.currency !== 'USD')).toBe(true);
    expect(new Set(all.map((d) => d.meta.id)).size).toBe(3);
  });
  it('commitment amortization is exact: covered usage plus the unused part equals one month of the prepaid purchase', () => {
    for (const d of [committed('syn-public-cloud-api'), committed('syn-private-cloud-api')]) {
      const idc = d.columns.indexOf('CommitmentDiscountId'); const cat = d.columns.indexOf('ChargeCategory');
      const purchase = d.rows.filter((r) => r[cat] === 'Purchase');
      expect(purchase).toHaveLength(1);
      const covered = d.rows.filter((r) => r[idc] === purchase[0][idc] && r[cat] === 'Usage');
      const monthly = parseUnits(purchase[0][d.columns.indexOf('BilledCost')]) / BigInt(3);
      expect(sum(covered.map((r) => r[d.columns.indexOf('EffectiveCost')]))).toBe(monthly);
      expect(purchase[0][d.columns.indexOf('EffectiveCost')]).toBe('0.0000000000');
    }
  });
  it('stays small: under 300 KB in total', () => {
    const bytes = ids.reduce((s, id) => s + fs.statSync(path.join(DIR, `${id}.json`)).size, 0);
    expect(bytes).toBeLessThan(300 * 1024);
  });
  it('holds no credential-shaped strings', () => {
    const text = ids.map((id) => fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')).join('\n');
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}|-----BEGIN|api[_-]?key|secret|password|bearer\s/i);
  });
  it('holds no email address, IP address, URL, ARN, cloud resource path or key-shaped token', () => {
    const text = ids.map((id) => fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')).join('\n');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // email
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // IPv4
    expect(text).not.toMatch(/\b[0-9a-f]{1,4}(:[0-9a-f]{1,4}){7}\b/i); // IPv6
    expect(text).not.toMatch(/https?:\/\/|www\./i); // URL
    expect(text).not.toMatch(/\barn:|\/subscriptions\/|projects\/[\w-]+\/|\bgs:\/\/|\bs3:\/\//i); // ARN / Azure / GCP resource paths
    expect(text).not.toMatch(/\b[A-Za-z0-9+/]{40,}={0,2}|\b(sk|pk|ghp|xox[abp])[-_][A-Za-z0-9]{16,}/); // long base64 / API-key-shaped tokens
  });
  it('names no real cloud, software or hardware brand (the API style column only names open API styles)', () => {
    const d = ids.map(committed);
    for (const ds of d) {
      const values = [ds.meta.name, ds.meta.provider, ...NAME_COLUMNS.flatMap((c) => col(ds, c)), ...ID_COLUMNS.flatMap((c) => col(ds, c)), ...col(ds, 'ChargeDescription'), ...col(ds, 'Tags')];
      for (const v of new Set(values)) expect(v, `${ds.meta.id}: ${v}`).not.toMatch(REAL_BRANDS);
    }
  });
});

// Strict FOCUS 1.0 conformance (the repo's validateRow is deliberately lenient: it needs only five columns).
describe.each(ids)('%s: strict FOCUS 1.0', (id) => {
  const d = committed(id);
  const rows = d.rows.map((r) => Object.fromEntries(d.columns.map((c, i) => [c, r[i]])) as Record<string, string>);
  const MANDATORY = ['BilledCost', 'BillingAccountId', 'BillingCurrency', 'BillingPeriodEnd', 'BillingPeriodStart', 'ChargeCategory', 'ChargeDescription', 'ChargeFrequency',
    'ChargePeriodEnd', 'ChargePeriodStart', 'ContractedCost', 'EffectiveCost', 'InvoiceIssuerName', 'ListCost', 'ProviderName', 'PublisherName', 'ServiceCategory', 'ServiceName'];
  const SETS: Record<string, string[]> = {
    ChargeCategory: ['Usage', 'Purchase', 'Tax', 'Credit', 'Adjustment'], ChargeClass: ['', 'Correction'], ChargeFrequency: ['One-Time', 'Recurring', 'Usage-Based'],
    PricingCategory: ['', 'Standard', 'Dynamic', 'Committed', 'Other'], CommitmentDiscountCategory: ['', 'Spend', 'Usage'], CommitmentDiscountStatus: ['', 'Used', 'Unused'],
    ServiceCategory: ['AI and Machine Learning', 'Analytics', 'Business Applications', 'Compute', 'Databases', 'Developer Tools', 'Multicloud', 'Identity', 'Integration', 'Internet of Things', 'Management and Governance', 'Media', 'Migration', 'Mobile', 'Networking', 'Security', 'Storage', 'Web', 'Other'],
  };

  it('has every mandatory column non-null on every row (ListCost and ContractedCost included, never N/A)', () => {
    for (const [i, r] of rows.entries()) for (const c of MANDATORY) expect(r[c], `row ${i} ${c}`).not.toBe('');
  });
  it('uses only allowed values for the enumerated columns', () => {
    for (const [i, r] of rows.entries()) for (const [c, set] of Object.entries(SETS)) expect(set, `row ${i} ${c}=${r[c]}`).toContain(r[c]);
  });
  it('fills the conditional pricing and consumption columns on every Usage and Purchase row that is not a correction', () => {
    for (const [i, r] of rows.entries()) {
      if (!['Usage', 'Purchase'].includes(r.ChargeCategory) || r.ChargeClass === 'Correction') continue;
      for (const c of ['PricingCategory', 'PricingQuantity', 'PricingUnit']) expect(r[c], `row ${i} ${c}`).not.toBe('');
      if (r.ChargeCategory === 'Usage') for (const c of ['ConsumedQuantity', 'ConsumedUnit']) expect(r[c], `row ${i} ${c}`).not.toBe('');
    }
  });
  it('keeps the Commitment columns all-or-none, with a Status only on Usage lines', () => {
    for (const [i, r] of rows.entries()) {
      const set = ['CommitmentDiscountId', 'CommitmentDiscountName', 'CommitmentDiscountType', 'CommitmentDiscountCategory'].map((c) => r[c] !== '');
      expect(new Set(set).size, `row ${i}`).toBe(1);
      expect(r.CommitmentDiscountStatus !== '', `row ${i} status`).toBe(set[0] && r.ChargeCategory === 'Usage');
    }
  });
  it('prices Usage and Purchase lines coherently: Contracted <= List, and a commitment discount only in EffectiveCost', () => {
    for (const [i, r] of rows.entries()) {
      if (r.ChargeCategory === 'Tax') expect([r.ListCost, r.ContractedCost], `tax row ${i}`).toEqual([r.BilledCost, r.BilledCost]);
      if (!['Usage', 'Purchase', 'Tax'].includes(r.ChargeCategory)) continue;
      expect(parseUnits(r.ContractedCost) <= parseUnits(r.ListCost), `row ${i}`).toBe(true);
      if (r.CommitmentDiscountStatus === 'Used') {
        expect(r.ContractedCost, `row ${i}`).toBe(r.ListCost); // the pre-commitment price
        expect(parseUnits(r.EffectiveCost) < parseUnits(r.ListCost), `row ${i}`).toBe(true);
        expect(r.ContractedUnitPrice, `row ${i}`).toBe(r.ListUnitPrice);
      }
    }
  });
  it('gives every priced line a unit price consistent with its quantity, and one unit for priced and consumed', () => {
    for (const [i, r] of rows.entries()) {
      if (r.PricingQuantity === '') continue;
      expect([r.ListUnitPrice !== '', r.ContractedUnitPrice !== ''], `row ${i}`).toEqual([true, true]);
      if (r.PricingQuantity === '1') expect(r.ListUnitPrice, `row ${i}`).toBe(r.ListCost); // a single-quantity line: unit price = cost
      if (r.ConsumedUnit !== '' && r.ChargeDescription.startsWith('Unused part')) expect(r.PricingUnit, `row ${i}`).toBe(r.ConsumedUnit);
    }
  });
  it('keeps BilledCost a true zero only where it is explained', () => {
    for (const [i, r] of rows.entries()) {
      if (r.ChargeCategory !== 'Usage' || parseUnits(r.BilledCost) !== BigInt(0)) continue;
      const prepaid = r.CommitmentDiscountStatus !== '';
      expect(prepaid || Boolean(d.meta.zeroBilledReason), `row ${i}`).toBe(true);
    }
    expect(Boolean(d.meta.zeroBilledReason)).toBe(id === 'syn-on-premise-api');
    if (id === 'syn-on-premise-api') {
      const alloc = rows.filter((r) => /hardware depreciation|Idle capacity/.test(r.ChargeDescription));
      expect(alloc.length).toBeGreaterThan(50);
      for (const r of alloc) expect([r.BilledCost, parseUnits(r.EffectiveCost) > BigInt(0)]).toEqual(['0.0000000000', true]);
      expect(d.meta.zeroBilledReason).toMatch(/true \$?0 billed|no vendor invoice/);
    }
  });
  it('uses a category-style provider and a plain connection name in its identifying meta fields', () => {
    expect(d.meta.provider).toBe({ public_cloud: 'Public cloud', private_cloud: 'Private cloud', on_premise: 'On-premises data center' }[d.meta.connectionType]);
    expect(d.meta.name).toMatch(/^(Public cloud|Private cloud|On-premises) .*API$/);
    expect(d.meta.name).not.toMatch(/example|synthetic|sample/i);
    expect(d.meta.billingPeriod).toBe('2026-09');
  });
});
