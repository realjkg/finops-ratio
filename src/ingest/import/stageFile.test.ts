// R3: staging an operator's FOCUS CSV / CSV.gz file into the existing export
// layout (split by billing period, NULL token mapped to empty, one manifest per
// period carrying the operator's controls). Pure; no database, no S3.
// Fixture: the public FOCUS 1.0 Sample Data (fixtures/focus-1.0-sample, CC BY 4.0).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
// The acceptance run's own lossless proof (scripts/local/acceptance.mjs), reused unchanged.
import { verifyStagingLossless } from '../../../scripts/local/acceptance.mjs';
import { dataPrefix, parseManifest, periodMetadataPrefix, type ListingEntry } from '../sources/s3/layout';
import { decodeImportFile, stageFile, type StagedFile } from './stageFile';

const SAMPLE = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-1.0-sample', 'focus_sample.csv'));
const CONTROLS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-1.0-sample', 'control-totals.json'), 'utf8'))['1k'];
const LOC = { bucket: 'ratio-src', prefix: 'ratio-file-drop', exportName: 'focus-main' };

/** The manifest of one staged period, parsed by the worker's own manifest parser. */
function parsedManifest(staged: StagedFile, period: string) {
  const manifest = staged.objects.find((o) => o.kind === 'manifest' && o.billingPeriod === period);
  if (!manifest) throw new Error(`no manifest for ${period}`);
  expect(manifest.key.startsWith(periodMetadataPrefix(LOC, period))).toBe(true);
  const listing = new Map<string, ListingEntry>(staged.objects.filter((o) => o.kind === 'data').map((o) => [o.key, { size: o.body.length, etag: 'e' }]));
  return { doc: JSON.parse(manifest.body.toString('utf8')), parsed: parseManifest(manifest.body, { location: LOC, billingPeriod: period, listing }) };
}

describe('R3 stageFile: the public 1000-row sample', () => {
  it('splits into 2024-09 and 2024-10 without loss (byte re-join check of the acceptance run)', () => {
    const staged = stageFile(SAMPLE, { location: LOC });
    expect(staged.periods).toEqual([
      { billingPeriod: '2024-09-01', records: 999 },
      { billingPeriod: '2024-10-01', records: 1 },
    ]);
    expect(staged.periods.reduce((n, p) => n + p.records, 0)).toBe(CONTROLS.input.dataRows);
    expect(verifyStagingLossless(SAMPLE, staged.plan)).toEqual([]);
    expect(staged.files).toEqual([{ name: 'file', sha256: CONTROLS.input.sha256, dataRows: 1000 }]);
    expect(Object.values(staged.nullTokensReplaced).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // The uploaded objects are exactly the verified plan (header + that period's records), gzipped.
    for (const o of staged.objects.filter((x) => x.kind === 'data')) {
      expect(o.key.startsWith(dataPrefix(LOC, o.billingPeriod))).toBe(true);
      const p = staged.plan.periods.find((x) => `${x.ym}-01` === o.billingPeriod)!;
      expect(zlib.gunzipSync(o.body).toString('utf8')).toBe(`${staged.plan.header}\n${p.files[0].records.map((l) => `${l}\n`).join('')}`);
    }
  });

  it('a dropped record makes the lossless check fail (the check bites)', () => {
    const staged = stageFile(SAMPLE, { location: LOC });
    const plan = structuredClone(staged.plan);
    plan.periods[0].files[0].records.pop();
    expect(verifyStagingLossless(SAMPLE, plan).length).toBeGreaterThan(0);
  });

  it('is deterministic: the same file stages to the same bytes (re-import is unchanged)', () => {
    const a = stageFile(SAMPLE, { location: LOC });
    const b = stageFile(SAMPLE, { location: LOC });
    expect(b.objects.map((o) => [o.key, o.body.toString('base64')])).toEqual(a.objects.map((o) => [o.key, o.body.toString('base64')]));
  });

  it('reads a .csv.gz file to the same staging as the plain file', () => {
    const gz = zlib.gzipSync(SAMPLE);
    expect(decodeImportFile(gz, 'export.csv.gz').equals(SAMPLE)).toBe(true);
    expect(decodeImportFile(SAMPLE, 'export.csv').equals(SAMPLE)).toBe(true);
    expect(() => decodeImportFile(SAMPLE, 'export.csv.gz')).toThrow(expect.objectContaining({ code: 'IMPORT_FILE_INVALID' }));
    expect(() => decodeImportFile(SAMPLE, 'export.xlsx')).toThrow(expect.objectContaining({ code: 'IMPORT_FILE_INVALID' }));
  });
});

describe('R3 stageFile: the manifest carries the operator controls', () => {
  it('without controls: no x-ratio-control and no per-file row counts, so the worker sees NO control (unverified, never reconciled)', () => {
    const staged = stageFile(SAMPLE, { location: LOC });
    for (const period of ['2024-09-01', '2024-10-01']) {
      const { doc, parsed } = parsedManifest(staged, period);
      expect(doc['x-ratio-control']).toBeUndefined();
      expect(parsed).toEqual({ ok: true, artifacts: [expect.objectContaining({ byteSize: expect.any(Number) })] });
      expect(doc['x-ratio-import']).toEqual({ files: [CONTROLS.input.sha256], period });
    }
  });

  it('with controls for one period: only that period is staged and its manifest carries exactly those controls', () => {
    const t = CONTROLS.totals[0];
    const staged = stageFile(SAMPLE, { location: LOC, period: '2024-09-01', providers: ['AWS'], control: { rowCount: Number(t.rowCount), billedTotal: t.billedCost, currency: t.billingCurrency } });
    expect(staged.periods).toEqual([{ billingPeriod: '2024-09-01', records: 999 }]);
    expect(staged.objects.map((o) => o.billingPeriod)).toEqual(['2024-09-01', '2024-09-01']);
    const { doc, parsed } = parsedManifest(staged, '2024-09-01');
    expect(doc['x-ratio-control']).toEqual({ rowCount: 942, billedTotal: '18.00663861840', currency: 'USD' });
    expect(parsed.ok && parsed.control).toEqual({ rowCount: 942, billedTotal: '18.00663861840' });
  });

  it('refuses controls that cannot be scoped to exactly one period of the file', () => {
    expect(() => stageFile(SAMPLE, { location: LOC, control: { rowCount: 942 } })).toThrow(expect.objectContaining({ code: 'IMPORT_CONTROL_SCOPE' }));
  });

  it('refuses a billed control without its currency, and a currency the declared providers rows do not bill in', () => {
    expect(() => stageFile(SAMPLE, { location: LOC, period: '2024-09-01', providers: ['AWS'], control: { billedTotal: '1.00' } })).toThrow(expect.objectContaining({ code: 'IMPORT_CONTROL_INVALID' }));
    let err: unknown;
    try {
      stageFile(SAMPLE, { location: LOC, period: '2024-09-01', providers: ['AWS'], control: { billedTotal: '1.00', currency: 'EUR' } });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'IMPORT_CONTROL_CURRENCY_MISMATCH' });
    expect(String((err as Error).message)).not.toContain('USD');
  });

  it('refuses a period that is not in the file', () => {
    expect(() => stageFile(SAMPLE, { location: LOC, period: '2024-08-01' })).toThrow(expect.objectContaining({ code: 'IMPORT_PERIOD_NOT_IN_FILE' }));
  });
});

describe('R3 stageFile: operator-clear failures that never echo cell values', () => {
  const header = SAMPLE.subarray(0, SAMPLE.indexOf(10) + 1).toString('utf8');
  const firstRow = SAMPLE.subarray(SAMPLE.indexOf(10) + 1, SAMPLE.indexOf(10, SAMPLE.indexOf(10) + 1) + 1).toString('utf8');

  it('a BillingPeriodStart that is not a month start: IMPORT_FILE_INVALID naming the record and column, not the value', () => {
    const bad = firstRow.replace('"2024-09-01 00:00:00"', '"SECRET-CELL-9 00:00:00"');
    expect(bad).not.toBe(firstRow);
    let err: unknown;
    try {
      stageFile(Buffer.from(header + bad), { location: LOC });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'IMPORT_FILE_INVALID' });
    expect((err as Error).message).toContain('BillingPeriodStart');
    expect((err as Error).message).toContain('record 2');
    expect((err as Error).message).not.toContain('SECRET-CELL-9');
  });

  it('a ragged record, an unterminated quote, no data rows, a missing column, invalid UTF-8: IMPORT_FILE_INVALID', () => {
    const cases = [
      header + firstRow.replace(/\n$/, ',"extra"\n'),
      header + firstRow.replace(/\n$/, '') + ',"open\n',
      header,
      header.replace('"BillingPeriodStart"', '"Other"') + firstRow,
      Buffer.concat([Buffer.from(header), Buffer.from([0xff, 0xfe, 0x0a])]),
    ];
    for (const c of cases) expect(() => stageFile(Buffer.isBuffer(c) ? c : Buffer.from(c), { location: LOC })).toThrow(expect.objectContaining({ code: 'IMPORT_FILE_INVALID' }));
  });
});
