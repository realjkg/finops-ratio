// R3: staging an operator's FOCUS CSV / CSV.gz file into the existing export
// layout (split by billing period, NULL token mapped to empty, one manifest per
// period carrying the operator's controls). Pure; no database, no S3.
// Fixture: the public FOCUS 1.0 Sample Data (fixtures/focus-1.0-sample, CC BY 4.0).
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
// The acceptance run's own lossless proof (scripts/local/acceptance.mjs), reused unchanged.
import { verifyStagingLossless } from '../../../scripts/local/acceptance.mjs';
import { dataPrefix, parseManifest, periodMetadataPrefix, type ListingEntry } from '../sources/s3/layout';
import { MAX_IMPORT_BYTES, IMPORT_RSS_BUDGET_BYTES, decodeImportFile, stageFile, type StagedFile } from './stageFile';

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
    expect(staged.files).toEqual([{ name: 'file', sha256: CONTROLS.input.sha256, dataRows: 1000, bytes: SAMPLE.length }]);
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
    expect(() => stageFile(SAMPLE, { location: LOC, providers: ['AWS'], control: { rowCount: 942 } })).toThrow(expect.objectContaining({ code: 'IMPORT_CONTROL_SCOPE' }));
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

// Review round 1. SYNTHETIC rows built in the test (not billing data): the header is a
// minimal FOCUS-shaped subset, enough for the staging layer, which does not validate FOCUS.
const MINI_HEADER = 'BillingPeriodStart,ProviderName,BillingCurrency,BilledCost';
const mini = (rows: string[], header = MINI_HEADER) => Buffer.from(`${[header, ...rows].join('\n')}\n`);
const dataBodies = (s: StagedFile) => s.objects.filter((o) => o.kind === 'data').map((o) => zlib.gunzipSync(o.body).toString('utf8'));
const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
  return 'no error';
};

describe('R3 stageFile review: input forms the worker accepts', () => {
  it('strips exactly one leading U+FEFF (the worker parses with bom: true), also when BillingPeriodStart is the first column', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(dataBodies(stageFile(Buffer.concat([bom, SAMPLE]), { location: LOC }))).toEqual(dataBodies(stageFile(SAMPLE, { location: LOC })));
    const first = mini(['2024-09-01,AWS,USD,1.5']);
    const staged = stageFile(Buffer.concat([bom, first]), { location: LOC });
    expect(staged.periods).toEqual([{ billingPeriod: '2024-09-01', records: 1 }]);
    expect(staged.plan.columns[0]).toBe('BillingPeriodStart');
    expect(dataBodies(staged)).toEqual([first.toString('utf8')]);
    expect(codeOf(() => stageFile(Buffer.concat([bom, bom, first]), { location: LOC }))).toBe('IMPORT_FILE_INVALID');
  });

  it('accepts trailing blank lines like the worker (skip_empty_lines) and stages the same records', () => {
    for (const tail of ['\n', '\n\n', '\r\n', '\r\n\r\n']) {
      expect(dataBodies(stageFile(Buffer.concat([SAMPLE, Buffer.from(tail)]), { location: LOC }))).toEqual(dataBodies(stageFile(SAMPLE, { location: LOC })));
    }
  });

  it('messages read "the file, record N" (one input) and "file K, record N" (several inputs)', () => {
    const ragged = mini(['2024-09-01,AWS,USD']);
    let err: unknown;
    try {
      stageFile(ragged, { location: LOC });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/^the file, record 2 has 3 fields, the header has 4$/);
    err = undefined;
    try {
      stageFile([{ name: 'a', bytes: mini(['2024-09-01,AWS,USD,1']) }, { name: 'b', bytes: ragged }], { location: LOC });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/^file 2, record 2 has 3 fields/);
  });

  it('refuses the same bytes supplied twice in one delivery, before staging anything', () => {
    const f = mini(['2024-09-01,AWS,USD,1']);
    expect(codeOf(() => stageFile([{ name: 'a', bytes: f }, { name: 'b', bytes: Buffer.from(f) }], { location: LOC }))).toBe('IMPORT_FILE_DUPLICATE');
  });
});

describe('R3 stageFile review: record and control checks that must bite', () => {
  it('BillingPeriodStart must be day 01 at midnight', () => {
    for (const v of ['2024-09-15', '2024-09-15 00:00:00', '2024-09-01 00:00:01', '2024-09-01T12:00:00Z', '2024-13-01']) {
      expect(codeOf(() => stageFile(mini([`${v},AWS,USD,1`]), { location: LOC }))).toBe('IMPORT_FILE_INVALID');
    }
    for (const v of ['2024-09-01', '2024-09-01 00:00:00', '2024-09-01T00:00:00Z', '2024-09-01T00:00:00.000+00:00']) {
      expect(stageFile(mini([`${v},AWS,USD,1`]), { location: LOC }).periods).toEqual([{ billingPeriod: '2024-09-01', records: 1 }]);
    }
  });

  it('refuses a negative or fractional control row count and a non-decimal billed total', () => {
    const at = (control: Record<string, unknown>) => codeOf(() => stageFile(mini(['2024-09-01,AWS,USD,1']), { location: LOC, providers: ['AWS'], control }));
    for (const rowCount of [-1, 1.5, Number.NaN]) expect(at({ rowCount })).toBe('IMPORT_CONTROL_INVALID');
    for (const billedTotal of ['12,5', '1.2.3', '', ' 1', 'NaN']) expect(at({ billedTotal, currency: 'USD' })).toBe('IMPORT_CONTROL_INVALID');
    expect(at({ rowCount: 1, billedTotal: '1', currency: 'USD' })).toBe('no error');
  });

  it('requires the declared providers whenever a control is given', () => {
    const f = mini(['2024-09-01,AWS,USD,1']);
    expect(codeOf(() => stageFile(f, { location: LOC, control: { billedTotal: '1', currency: 'USD' } }))).toBe('IMPORT_CONTROL_INVALID');
    expect(codeOf(() => stageFile(f, { location: LOC, control: { rowCount: 1 } }))).toBe('IMPORT_CONTROL_INVALID');
  });

  it('empties only the UNQUOTED NULL token; a quoted "NULL" is data and stays byte-equal', () => {
    const staged = stageFile(mini(['2024-09-01,AWS,USD,NULL', '2024-09-01,"NULL",USD,1']), { location: LOC });
    expect(dataBodies(staged)).toEqual([`${MINI_HEADER}\n2024-09-01,AWS,USD,\n2024-09-01,"NULL",USD,1\n`]);
    expect(staged.nullTokensReplaced).toEqual({ BilledCost: 1 });
  });

  it('checks the control currency on the declared providers rows only', () => {
    const f = mini(['2024-09-01,AWS,USD,1', '2024-09-01,Microsoft,EUR,2']);
    const control = { billedTotal: '1', currency: 'USD' };
    expect(codeOf(() => stageFile(f, { location: LOC, providers: ['AWS'], control }))).toBe('no error');
    expect(codeOf(() => stageFile(f, { location: LOC, providers: ['AWS', 'Microsoft'], control }))).toBe('IMPORT_CONTROL_CURRENCY_MISMATCH');
  });

  it('refuses a header with a duplicate column name', () => {
    expect(codeOf(() => stageFile(mini(['2024-09-01,AWS,USD,1'], 'BillingPeriodStart,ProviderName,BillingCurrency,ProviderName'), { location: LOC }))).toBe('IMPORT_FILE_INVALID');
  });
});

// Review round 1, PR #143 (B1 report, B2 memory).
describe('R3 stageFile review: a preview of the declared providers rows per staged period', () => {
  it('counts and sums (exactly, per currency) the declared providers rows, for the restatement report', () => {
    const staged = stageFile(SAMPLE, { location: LOC, providers: ['AWS'] });
    expect(staged.preview).toEqual([
      { billingPeriod: '2024-09-01', rows: Number(CONTROLS.totals[0].rowCount), billed: { USD: CONTROLS.totals[0].billedCost } },
      { billingPeriod: '2024-10-01', rows: 0, billed: {} },
    ]);
    const f = mini(['2024-09-01,AWS,USD,0.1', '2024-09-01,AWS,USD,0.20', '2024-09-01,AWS,EUR,-1e-2', '2024-09-01,AWS,EUR,NULL', '2024-09-01,Microsoft,USD,5']);
    expect(stageFile(f, { location: LOC, providers: ['AWS'] }).preview).toEqual([{ billingPeriod: '2024-09-01', rows: 4, billed: { USD: '0.30', EUR: null } }]);
  });
});

describe('R3 stageFile review: bounded memory', () => {
  it('writes each period as gzip members of bounded size that the worker decompressor (zlib.createGunzip) reads back exactly', async () => {
    const one = stageFile(SAMPLE, { location: LOC });
    const many = stageFile(SAMPLE, { location: LOC, gzipMemberBytes: 4096 });
    const gunzipStream = (b: Buffer) =>
      new Promise<string>((resolve, reject) => {
        const parts: Buffer[] = [];
        const g = zlib.createGunzip();
        g.on('data', (d: Buffer) => parts.push(d)).on('end', () => resolve(Buffer.concat(parts).toString('utf8'))).on('error', reject);
        g.end(b);
      });
    const sep = many.objects.find((o) => o.kind === 'data' && o.billingPeriod === '2024-09-01')!;
    let members = 0;
    for (let i = 0; i + 1 < sep.body.length; i++) if (sep.body[i] === 0x1f && sep.body[i + 1] === 0x8b && sep.body[i + 2] === 8) members++;
    expect(members).toBeGreaterThan(100);
    expect(await Promise.all(many.objects.filter((o) => o.kind === 'data').map((o) => gunzipStream(o.body)))).toEqual(dataBodies(one));
    expect(verifyStagingLossless(SAMPLE, many.plan)).toEqual([]);
  });

  it('decodeImportFile refuses more than the cap with IMPORT_TOO_LARGE, also for a gzip that inflates past it', () => {
    expect(codeOf(() => decodeImportFile(Buffer.alloc(1001, 0x41), 'x.csv', 1000))).toBe('IMPORT_TOO_LARGE');
    expect(codeOf(() => decodeImportFile(zlib.gzipSync(Buffer.alloc(1001, 0x41)), 'x.csv.gz', 1000))).toBe('IMPORT_TOO_LARGE');
    expect(decodeImportFile(zlib.gzipSync(Buffer.alloc(1000, 0x41)), 'x.csv.gz', 1000).length).toBe(1000);
  });

  it('the RSS budget leaves a quarter of the worker container limit (compose.yaml) as margin', () => {
    const compose = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'infrastructure', 'engagement', 'compose.yaml'), 'utf8');
    const worker = compose.slice(compose.indexOf('\n  worker:'));
    const m = /\n {4}mem_limit: ([0-9]+)m\n/.exec(worker)!;
    expect(IMPORT_RSS_BUDGET_BYTES).toBeLessThanOrEqual(Number(m[1]) * 1024 * 1024 * 0.75);
    expect(MAX_IMPORT_BYTES).toBeLessThan(IMPORT_RSS_BUDGET_BYTES);
  });

  // The real staging path (read, decode, stage) on a SYNTHETIC file just under the cap, built by repeating the
  // public sample's records, in a child process with a constrained V8 heap. Its peak RSS must leave the worker
  // container (infrastructure/engagement/compose.yaml mem_limit) the margin the cap was derived from.
  it(
    'stages a file just under the cap with --max-old-space-size=96 and a peak RSS inside the container budget',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-stage-mem-'));
      try {
        const file = path.join(dir, 'near-cap.csv');
        const header = SAMPLE.subarray(0, SAMPLE.indexOf(10) + 1);
        const body = SAMPLE.subarray(SAMPLE.indexOf(10) + 1);
        const fd = fs.openSync(file, 'w');
        let size = fs.writeSync(fd, header);
        while (size + body.length <= MAX_IMPORT_BYTES - 1024) size += fs.writeSync(fd, body);
        fs.closeSync(fd);
        const child = path.resolve(__dirname, '..', 'testing', 'stageMemoryChild.ts');
        const r = spawnSync(process.execPath, ['--max-old-space-size=96', '--import', 'tsx', child, file], { encoding: 'utf8', timeout: 170_000 });
        expect(r.status, r.stderr.slice(-2000)).toBe(0);
        const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
        expect(out.bytes).toBe(size);
        expect(out.maxRssBytes).toBeLessThanOrEqual(IMPORT_RSS_BUDGET_BYTES);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
