import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CONNECTIONS, importSample } from './index';
import { formatMoney, groupNaColumns, parseUnits, percentRounded, reconcile, totalsByCurrency } from './reconcile';
import type { Dataset } from './types';

const DIR = path.join(__dirname, 'data');
const load = (id: string): Dataset => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
afterEach(() => vi.unstubAllGlobals());

describe('connection summaries', () => {
  it('equal the metadata of the committed fixtures', () => {
    for (const c of CONNECTIONS) {
      const { meta } = load(c.id);
      expect({ id: c.id, name: c.name, connectionType: c.connectionType, apiStyle: c.apiStyle, currency: c.currency, lastImport: c.lastImport, rowCount: c.rowCount })
        .toEqual({ id: meta.id, name: meta.name, connectionType: meta.connectionType, apiStyle: meta.apiStyle, currency: meta.currency, lastImport: meta.lastImport, rowCount: meta.rowCount });
    }
    expect(CONNECTIONS.map((c) => c.connectionType)).toEqual(['public_cloud', 'private_cloud', 'on_premise']);
  });
  it('are loaded lazily: the module has no static import of the data files', () => {
    const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/^import .* from '\.\/data\//m);
    expect(src.match(/import\('\.\/data\//g)).toHaveLength(3);
  });
});

describe('reconcile', () => {
  it('matches the control totals of every fixture, and Billed differs from Effective', () => {
    for (const c of CONNECTIONS) {
      const r = reconcile(load(c.id));
      expect([r.matchesControl, r.rows, r.currency]).toEqual([true, c.rowCount, c.currency]);
      expect(r.billed).not.toBe(r.effective);
    }
  });
  it('detects a tampered row (mutation)', () => {
    const d = load('syn-public-cloud-api');
    const i = d.columns.indexOf('BilledCost');
    d.rows[5][i] = '99.0000000000';
    expect(reconcile(d).matchesControl).toBe(false);
    const dropped = load('syn-public-cloud-api');
    dropped.rows.pop();
    expect(reconcile(dropped).matchesControl).toBe(false);
  });
  it('counts an empty cell as N/A (left out of the sum), not as 0', () => {
    const d = load('syn-private-cloud-api');
    const e = d.columns.indexOf('EffectiveCost');
    const before = parseUnits(reconcile(d).effective);
    const removed = parseUnits(d.rows[3][e]);
    d.rows[3][e] = '';
    const r = reconcile(d);
    expect([r.naEffective, parseUnits(r.effective)]).toEqual([1, before - removed]);
    expect(r.matchesControl).toBe(false);
  });
  it('explains every N/A column and never merges currencies', () => {
    const all = CONNECTIONS.map((c) => reconcile(load(c.id)));
    const priv = all[1];
    expect(priv.naColumns.find((c) => c.column === 'ChargeClass')).toEqual({ column: 'ChargeClass', rows: priv.rows, reason: 'Not applicable: the line is not a correction' });
    expect(priv.naColumns.some((c) => ['ListCost', 'ContractedCost', 'EffectiveCost', 'BilledCost'].includes(c.column))).toBe(false);
    const totals = totalsByCurrency(all);
    expect(totals.map((t) => t.currency)).toEqual(['EUR', 'USD']);
    expect(parseUnits(totals[1].billed)).toBe(parseUnits(all[0].billed) + parseUnits(all[2].billed));
    expect(totals[0].billed).toBe(all[1].billed);
    const mixed = load('syn-public-cloud-api');
    mixed.rows[0][mixed.columns.indexOf('BillingCurrency')] = 'EUR';
    expect(() => reconcile(mixed)).toThrow(/currencies are never added/);
  });
  it('reports the commitment: covered plus unused equals one month of the prepaid purchase', () => {
    const r = reconcile(load('syn-public-cloud-api'));
    expect(r.commitment).not.toBeNull();
    expect(parseUnits(r.commitment!.usedEffective) + parseUnits(r.commitment!.unusedEffective)).toBe(parseUnits(r.commitment!.purchaseBilled) / BigInt(3));
    expect(reconcile(load('syn-on-premise-api')).commitment).toBeNull();
  });
  it('formats money to cents from exact decimals', () => {
    expect([formatMoney('2830.2211680000', 'USD'), formatMoney('-0.0049000000', 'EUR'), formatMoney('0.0050000000', 'EUR'), formatMoney('1234567.8950000000', 'GBP')])
      .toEqual(['USD 2,830.22', 'EUR 0.00', 'EUR 0.01', 'GBP 1,234,567.90']);
  });
});

describe('display helpers', () => {
  it('rounds percentages half up in integer arithmetic (private cloud 76.53% is 77%)', () => {
    const r = reconcile(load('syn-private-cloud-api'));
    const c = r.commitment!;
    const unused = parseUnits(c.unusedEffective); const total = unused + parseUnits(c.usedEffective);
    expect((unused * BigInt(10000)) / total).toBe(BigInt(7653));
    expect(percentRounded(unused, total)).toBe(77);
    expect([percentRounded(BigInt(1), BigInt(2)), percentRounded(BigInt(1), BigInt(3)), percentRounded(BigInt(2), BigInt(3)), percentRounded(BigInt(0), BigInt(5)), percentRounded(BigInt(1), BigInt(0))]).toEqual([50, 33, 67, 0, 0]);
    // One half-up rounding, not two: 49.4951% is 49%, 49.5% is 50%.
    expect([percentRounded(BigInt(494951), BigInt(1000000)), percentRounded(BigInt(495), BigInt(1000)), percentRounded(BigInt(494999), BigInt(1000000))]).toEqual([49, 50, 49]);
  });
  it('groups N/A columns by identical reason, whole-column cases apart from partial ones', () => {
    const g = groupNaColumns({ rows: 10, naColumns: [
      { column: 'A', rows: 10, reason: 'r1' }, { column: 'B', rows: 10, reason: 'r1' }, { column: 'C', rows: 3, reason: 'r1' }, { column: 'D', rows: 4, reason: 'r2' },
    ] });
    expect(g).toEqual({ whole: [{ reason: 'r1', columns: ['A', 'B'] }], partial: [{ reason: 'r1', columns: [{ column: 'C', rows: 3 }] }, { reason: 'r2', columns: [{ column: 'D', rows: 4 }] }] });
    const priv = groupNaColumns(reconcile(load('syn-private-cloud-api')));
    expect(priv.whole.flatMap((x) => x.columns)).toContain('ChargeClass');
    expect(priv.whole.length + priv.partial.length).toBeLessThan(reconcile(load('syn-private-cloud-api')).naColumns.length);
  });
});

describe('importSample', () => {
  it('loads the fixture without any network call', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network'); });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await importSample('syn-on-premise-api');
    expect([r.matchesControl, r.currency]).toEqual([true, 'USD']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rejects an unknown id, including inherited object keys', async () => {
    await expect(importSample('nope')).rejects.toThrow(/Unknown sample connection/);
    await expect(importSample('toString')).rejects.toThrow(/Unknown sample connection/);
  });
});
