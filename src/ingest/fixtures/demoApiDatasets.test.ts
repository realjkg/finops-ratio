// The demo's synthetic API-connection datasets: deterministic, drift-checked against the committed
// JSON, and every row passes the repo's FOCUS validator (src/ingest/focus/validate.ts).
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

  it('is clearly fictional and synthetic', () => {
    expect(d.meta.synthetic).toBe(true);
    for (const name of ['ProviderName', 'BillingAccountName', 'InvoiceIssuerName']) expect(col(d, name).every((v) => /Example/.test(v)), name).toBe(true);
    expect(d.meta.name).toMatch(/^Example /);
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
});
