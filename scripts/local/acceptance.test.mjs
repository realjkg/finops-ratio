// Slice 2b: pure tests of the FOCUS sample-data acceptance tooling
// (scripts/local/acceptance.mjs). No Docker, no database, no network.
// DESIGN: docs/evidence/slice-2b/DESIGN.md §8 (A1–A8).
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parse as parseCsvSync } from 'csv-parse/sync';
import {
  MUTATIONS,
  SAMPLE_NAMES,
  aggregateApiRows,
  artifactSetProblems,
  batchProblems,
  canonicalDecimal,
  compareAcceptance,
  copyPinnedFile,
  fetchPinnedFile,
  formatDecimal,
  localAcceptanceSettings,
  parseAcceptanceArgs,
  parseDecimal,
  pinnedUrl,
  planStaging,
  readDataset,
  resyncProblems,
  stageFocusSample,
  sumDecimals,
  syncProblems,
  tokenizeCsv,
  verifyDatasetBytes,
  verifyStagingLossless,
} from './acceptance.mjs';
import { LOCAL_NAMES } from './lib.mjs';
// The worker's OWN manifest parser and row validator (unchanged production code):
// the staged objects must pass them before any stack is involved.
import { parseManifest } from '../../src/ingest/sources/s3/layout';
import { indexHeader, validateRow } from '../../src/ingest/focus/validate';

const { Response, structuredClone } = globalThis;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DATASET = JSON.parse(read('fixtures/focus-1.0-sample/dataset.json'));
const PINNED = JSON.parse(read('fixtures/focus-1.0-sample/control-totals.json'));
const UPSTREAM_1K = fs.readFileSync(path.join(ROOT, DATASET.files['1k'].localPath));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const STAGED = stageFocusSample(UPSTREAM_1K);
const dataObjects = (staged, ym) => staged.objects.filter((o) => o.kind === 'data' && (!ym || o.key.includes(`BILLING_PERIOD=${ym}/`)));
const manifestOf = (staged, ym) => staged.objects.find((o) => o.kind === 'manifest' && o.key.includes(`BILLING_PERIOD=${ym}/`));
const gunzipText = (o) => zlib.gunzipSync(o.body).toString('utf8');
/** Data records (raw text, header dropped) of every data file of a period. */
const recordsOf = (staged, ym) => dataObjects(staged, ym).flatMap((o) => gunzipText(o).split('\n').slice(1, -1));
const fieldsOf = (line) => tokenizeCsv(Buffer.from(`${line}\n`))[0];
const HEADER = tokenizeCsv(UPSTREAM_1K)[0].map((f) => f.value);
const col = (name) => HEADER.indexOf(name);

describe('A1 settings and arguments', () => {
  it('has its own project and ports by default, overridable', () => {
    expect(localAcceptanceSettings({})).toEqual({ project: 'ratio-local-acceptance', pgPort: 54349, s3Port: 18363, appPort: 3120 });
    expect(
      localAcceptanceSettings({
        RATIO_LOCAL_ACCEPTANCE_PROJECT: 'acc-x',
        RATIO_LOCAL_ACCEPTANCE_PG_PORT: '55810',
        RATIO_LOCAL_ACCEPTANCE_S3_PORT: '55811',
        RATIO_LOCAL_ACCEPTANCE_APP_PORT: '55812',
      }),
    ).toEqual({ project: 'acc-x', pgPort: 55810, s3Port: 55811, appPort: 55812 });
  });

  it('refuses a project name or a port shared with the developer stack or local:test', () => {
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_PROJECT: 'ratio-local' })).toThrow(/project/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_PROJECT: 'ratio-local-test' })).toThrow(/project/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_PROJECT: 'x', RATIO_LOCAL_PROJECT: 'x' })).toThrow(/project/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_PG_PORT: '54329' })).toThrow(/54329/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_S3_PORT: '18353' })).toThrow(/18353/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_APP_PORT: '3110' })).toThrow(/3110/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_APP_PORT: '3100' })).toThrow(/3100/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_PG_PORT: '80' })).toThrow(/port/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_PG_PORT: '55810', RATIO_LOCAL_ACCEPTANCE_S3_PORT: '55810' })).toThrow(/55810/);
    expect(() => localAcceptanceSettings({ RATIO_LOCAL_ACCEPTANCE_PROJECT: 'Bad Name' })).toThrow(/RATIO_LOCAL_ACCEPTANCE_PROJECT/);
  });

  it('parses --dataset and --mutation strictly', () => {
    expect(parseAcceptanceArgs([])).toEqual({ dataset: '1k', mutation: null });
    expect(parseAcceptanceArgs(['--dataset', '10k'])).toEqual({ dataset: '10k', mutation: null });
    expect(parseAcceptanceArgs(['--mutation', 'drop-row', '--dataset', '1k'])).toEqual({ dataset: '1k', mutation: 'drop-row' });
    for (const bad of [['--dataset', '5k'], ['--dataset'], ['--mutation', 'nope'], ['--mutation'], ['--other'], ['10k'], ['--dataset', '1k', '--dataset', '10k']]) {
      expect(() => parseAcceptanceArgs(bad), bad.join(' ')).toThrow();
    }
  });

  it('names the sample source so it can never pass for tenant billing data', () => {
    expect(SAMPLE_NAMES.sourceKey).toBe('focus-sample');
    expect(SAMPLE_NAMES.tenantSlug).toBe('local-focus-sample');
    expect(SAMPLE_NAMES.displayName).toMatch(/FOCUS 1\.0 Sample Data.*FinOps Foundation.*CC BY 4\.0.*not tenant billing data/);
    expect(SAMPLE_NAMES.displayName.length).toBeLessThanOrEqual(200);
    expect(SAMPLE_NAMES.bucket).toBe(LOCAL_NAMES.sourceBucket);
    // Distinct from the synthetic fixture's source, so both can share a stack's buckets.
    expect(SAMPLE_NAMES.sourceKey).not.toBe(LOCAL_NAMES.sourceKey);
    expect(SAMPLE_NAMES.prefix).not.toBe(LOCAL_NAMES.fixturePrefix);
  });
});

describe('A2 strict CSV tokenizer (keeps raw bytes and quoting)', () => {
  it('splits fields, unescapes "" and records whether each field was quoted', () => {
    const [rec] = tokenizeCsv(Buffer.from('a,"b","c,d","e""f",NULL,"NULL",\n'));
    expect(rec.map((f) => [f.value, f.quoted, f.raw])).toEqual([
      ['a', false, 'a'],
      ['b', true, '"b"'],
      ['c,d', true, '"c,d"'],
      ['e"f', true, '"e""f"'],
      ['NULL', false, 'NULL'],
      ['NULL', true, '"NULL"'],
      ['', false, ''],
    ]);
  });

  it('handles a quoted newline and a last record without a newline', () => {
    const recs = tokenizeCsv(Buffer.from('x,"1\n2"\ny,3'));
    expect(recs.map((r) => r.map((f) => f.value))).toEqual([['x', '1\n2'], ['y', '3']]);
  });

  it('fails closed on CR, an unterminated quote, bytes after a closing quote, a stray quote, empty input and invalid UTF-8', () => {
    for (const bad of ['a,b\r\nc,d\n', 'a,"b\n', 'a,"b"c\n', 'a,b"c\n', '']) expect(() => tokenizeCsv(Buffer.from(bad)), JSON.stringify(bad)).toThrow();
    expect(() => tokenizeCsv(Buffer.from([0xff, 0xfe, 0x2c, 0x61, 0x0a]))).toThrow();
  });

  it('re-joining the raw fields reproduces every upstream record byte for byte', () => {
    const recs = tokenizeCsv(UPSTREAM_1K);
    expect(recs).toHaveLength(1001);
    expect(Buffer.from(recs.map((r) => r.map((f) => f.raw).join(',')).join('\n') + '\n').equals(UPSTREAM_1K)).toBe(true);
  });
});

describe('A3 staging the committed 1k file as an AWS Data Exports layout', () => {
  const root = `${SAMPLE_NAMES.prefix}/${SAMPLE_NAMES.exportName}`;
  const exec = `sample-${DATASET.files['1k'].sha256.slice(0, 12)}`;

  it('lays out one gzipped data file and one manifest per billing period', () => {
    expect(STAGED.objects.map((o) => [o.kind, o.key])).toEqual([
      ['data', `${root}/data/BILLING_PERIOD=2024-09/${exec}/${SAMPLE_NAMES.exportName}-00001.csv.gz`],
      ['manifest', `${root}/metadata/BILLING_PERIOD=2024-09/${SAMPLE_NAMES.exportName}-Manifest.json`],
      ['data', `${root}/data/BILLING_PERIOD=2024-10/${exec}/${SAMPLE_NAMES.exportName}-00001.csv.gz`],
      ['manifest', `${root}/metadata/BILLING_PERIOD=2024-10/${SAMPLE_NAMES.exportName}-Manifest.json`],
    ]);
    expect(STAGED.periods).toEqual([
      { billingPeriod: '2024-09-01', records: 999, dataFiles: 1 },
      { billingPeriod: '2024-10-01', records: 1, dataFiles: 1 },
    ]);
    for (const o of STAGED.objects) expect(o.sha256).toBe(sha256(o.body));
    expect(STAGED.mutation).toBeNull();
  });

  it('every data file is the upstream header plus its period’s records, in upstream order', () => {
    const headerLine = UPSTREAM_1K.toString('utf8').split('\n')[0];
    for (const o of dataObjects(STAGED)) {
      const text = gunzipText(o);
      expect(text.split('\n')[0]).toBe(headerLine);
      expect(text.endsWith('\n')).toBe(true);
    }
    expect(recordsOf(STAGED, '2024-09')).toHaveLength(999);
    expect(recordsOf(STAGED, '2024-10')).toHaveLength(1);
    expect(fieldsOf(recordsOf(STAGED, '2024-10')[0])[col('BillingPeriodStart')].value).toBe('2024-10-01 00:00:00');
  });

  it('turns every UNQUOTED NULL into an empty field and leaves every other field’s raw bytes alone', () => {
    const upstreamNulls = {};
    for (const rec of tokenizeCsv(UPSTREAM_1K).slice(1)) rec.forEach((f, i) => !f.quoted && f.value === 'NULL' && (upstreamNulls[HEADER[i]] = (upstreamNulls[HEADER[i]] ?? 0) + 1));
    expect(STAGED.nullTokensReplaced).toEqual(upstreamNulls);
    expect(STAGED.nullTokensReplaced.ChargeClass).toBe(1000);
    expect(STAGED.nullTokensReplaced.ContractedCost).toBe(7);
    for (const line of [...recordsOf(STAGED, '2024-09'), ...recordsOf(STAGED, '2024-10')]) {
      for (const f of fieldsOf(line)) expect(!f.quoted && f.value === 'NULL').toBe(false);
    }
  });

  it('is lossless: inverting the null mapping and merging the periods gives back the upstream records exactly', () => {
    expect(verifyStagingLossless(UPSTREAM_1K, STAGED.plan)).toEqual([]);
    // A changed byte, a dropped record, a duplicated record or a moved record is caught.
    const clone = () => structuredClone(STAGED.plan);
    const changed = clone();
    changed.periods[0].files[0].records[5] = changed.periods[0].files[0].records[5].replace(/,0\./, ',1.');
    expect(verifyStagingLossless(UPSTREAM_1K, changed).length).toBeGreaterThan(0);
    const dropped = clone();
    dropped.periods[0].files[0].records.pop();
    expect(verifyStagingLossless(UPSTREAM_1K, dropped).length).toBeGreaterThan(0);
    const duplicated = clone();
    duplicated.periods[0].files[0].records.push(duplicated.periods[0].files[0].records[0]);
    expect(verifyStagingLossless(UPSTREAM_1K, duplicated).length).toBeGreaterThan(0);
    const moved = clone();
    moved.periods[1].files[0].records.push(moved.periods[0].files[0].records.pop());
    expect(verifyStagingLossless(UPSTREAM_1K, moved).length).toBeGreaterThan(0);
    const reordered = clone();
    reordered.periods[0].files[0].records.reverse();
    expect(verifyStagingLossless(UPSTREAM_1K, reordered).length).toBeGreaterThan(0);
  });

  it('is deterministic (same bytes, same SHA-256s)', () => {
    expect(stageFocusSample(UPSTREAM_1K).objects.map((o) => o.sha256)).toEqual(STAGED.objects.map((o) => o.sha256));
  });

  it('the manifests pass the worker’s own parser, list the data file as an s3:// URI and carry NO control totals', () => {
    const location = { bucket: SAMPLE_NAMES.bucket, prefix: SAMPLE_NAMES.prefix, exportName: SAMPLE_NAMES.exportName };
    const listing = new Map(dataObjects(STAGED).map((o) => [o.key, { size: o.body.length, etag: o.sha256 }]));
    for (const [ym, next] of [['2024-09', '2024-10'], ['2024-10', '2024-11']]) {
      const m = manifestOf(STAGED, ym);
      const doc = JSON.parse(m.body.toString('utf8'));
      expect(doc.dataFiles).toEqual(dataObjects(STAGED, ym).map((o) => `s3://${SAMPLE_NAMES.bucket}/${o.key}`));
      expect(doc.billingPeriod).toEqual({ start: `${ym}-01T00:00:00.000Z`, end: `${next}-01T00:00:00.000Z` });
      expect(doc).not.toHaveProperty('x-ratio-control');
      const parsed = parseManifest(m.body, { location, billingPeriod: `${ym}-01`, listing });
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(parsed.artifacts).toHaveLength(1);
      expect(parsed.control).toBeUndefined();
    }
  });

  it('every staged row passes the worker’s own validator (and the unconverted sample does not)', () => {
    const validate = (staged, ym) => {
      const rows = dataObjects(staged, ym).flatMap((o) => parseCsvSync(gunzipText(o), { bom: true }));
      const index = indexHeader(rows[0]);
      expect(index.ok).toBe(true);
      const codes = new Set();
      for (const r of rows.slice(1)) {
        const v = validateRow(r, index.index, `${ym}-01`);
        if (!v.ok) v.errors.forEach((e) => codes.add(e.code));
      }
      return [...codes].sort();
    };
    expect(validate(STAGED, '2024-09')).toEqual([]);
    expect(validate(STAGED, '2024-10')).toEqual([]);
    expect(validate(stageFocusSample(UPSTREAM_1K, { mutation: 'skip-null-conversion' }), '2024-09')).toEqual(['UNPARSEABLE_NUMBER']);
    expect(validate(stageFocusSample(UPSTREAM_1K, { mutation: 'skip-period-split' }), '2024-09')).toEqual(['PERIOD_MISMATCH']);
  });

  it('only the UNQUOTED token is a null: a quoted "NULL" string and a quoted "" are kept byte for byte', () => {
    const header = '"BillingPeriodStart","BilledCost","Note","Other"\n';
    const plan = planStaging(Buffer.from(`${header}"2024-09-01 00:00:00",1,"NULL",NULL\n"2024-09-01 00:00:00",2,"",nULL\n`));
    expect(plan.periods[0].files[0].records).toEqual(['"2024-09-01 00:00:00",1,"NULL",', '"2024-09-01 00:00:00",2,"",nULL']);
    expect(plan.nullTokens).toEqual({ Other: 1 });
  });

  it('fails closed on a ragged record, a missing column or a period that is not a first-of-month midnight', () => {
    const header = '"BillingPeriodStart","BillingPeriodEnd","BilledCost","EffectiveCost","Id"\n';
    const ok = '"2024-09-01 00:00:00","2024-10-01 00:00:00",1,1,"a"\n';
    expect(() => planStaging(Buffer.from(header + ok))).not.toThrow();
    expect(() => planStaging(Buffer.from(header + '"2024-09-01 00:00:00",1,1,"a"\n'))).toThrow();
    expect(() => planStaging(Buffer.from('"BillingPeriodEnd","BilledCost"\n"x",1\n'))).toThrow(/BillingPeriodStart/);
    expect(() => planStaging(Buffer.from(header + '"2024-09-02 00:00:00","2024-10-01 00:00:00",1,1,"a"\n'))).toThrow();
    expect(() => planStaging(Buffer.from(header + 'NULL,"2024-10-01 00:00:00",1,1,"a"\n'))).toThrow();
    expect(() => planStaging(Buffer.from(header))).toThrow();
    expect(() => planStaging(Buffer.from('"A","A"\n1,2\n'))).toThrow(/duplicate/i);
  });
});

describe('A4 exact decimals (BigInt; Postgres sum(numeric) scale rule)', () => {
  it('parses and formats plain decimals only', () => {
    expect(parseDecimal('-12.340')).toEqual({ unscaled: -12340n, scale: 3 });
    expect(formatDecimal({ unscaled: -12340n, scale: 3 })).toBe('-12.340');
    expect(formatDecimal({ unscaled: 5n, scale: 4 })).toBe('0.0005');
    expect(formatDecimal({ unscaled: -5n, scale: 4 })).toBe('-0.0005');
    for (const bad of ['1e3', 'NaN', '1.', '.5', '', ' 1', '+1', null, 1.5]) expect(() => parseDecimal(bad), String(bad)).toThrow();
  });

  it('sums exactly at the largest scale seen', () => {
    expect(sumDecimals(['0.10', '0.2'])).toBe('0.30');
    expect(sumDecimals(['1', '0.001'])).toBe('1.001');
    expect(sumDecimals(['-1.5', '1.5'])).toBe('0.0');
    expect(sumDecimals(['-0.00000080000', '0.00000000001'])).toBe('-0.00000079999');
    expect(sumDecimals([])).toBe('0');
    expect(sumDecimals([...Array(10).fill('0.1'), '12345678901234567890.123456789012345678'])).toBe('12345678901234567891.123456789012345678');
  });

  it('canonical form is numeric::text (no leading zeros, no negative zero)', () => {
    expect(canonicalDecimal('007.50')).toBe('7.50');
    expect(canonicalDecimal('-0.000')).toBe('0.000');
    expect(canonicalDecimal('-12.30')).toBe('-12.30');
  });
});

describe('A5 API rows and totals vs the control', () => {
  const control = {
    totals: [
      { billingPeriod: '2024-09-01', billingCurrency: 'USD', rowCount: '2', billedCost: '1.35', effectiveCost: '1.00', effectiveCostNulls: '1', rowDigest: '' },
      { billingPeriod: '2024-10-01', billingCurrency: 'USD', rowCount: '1', billedCost: '0.24000000000', effectiveCost: '0.00000000000', effectiveCostNulls: '0', rowDigest: '' },
    ],
  };
  const digest = (lines) => sha256(Buffer.from([...lines].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join('')));
  control.totals[0].rowDigest = digest(['a\t1.10\t1.00\n', 'b\t0.25\t\\N\n']);
  control.totals[1].rowDigest = digest(['7\t0.24000000000\t0.00000000000\n']);
  const row = (o) => ({ billingPeriod: '2024-09-01', billingCurrency: 'USD', batchId: 'b1', artifactSha256: 'f'.repeat(64), effectiveCost: null, extraColumns: {}, ...o });
  const rows = [
    row({ rowOrdinal: '0', billedCost: '1.10', effectiveCost: '1.00', extraColumns: { Id: 'a' } }),
    row({ rowOrdinal: '1', billedCost: '0.25', effectiveCost: null, extraColumns: { Id: 'b' } }),
    row({ billingPeriod: '2024-10-01', batchId: 'b2', artifactSha256: 'e'.repeat(64), rowOrdinal: '0', billedCost: '0.24000000000', effectiveCost: '0.00000000000', extraColumns: { Id: '7' } }),
  ];
  const apiTotals = [
    { billingPeriod: '2024-09-01', billingCurrency: 'USD', rowCount: '2', billedCost: '1.35' },
    { billingPeriod: '2024-10-01', billingCurrency: 'USD', rowCount: '1', billedCost: '0.24000000000' },
  ];

  it('aggregates per (period, currency) exactly', () => {
    expect(aggregateApiRows(rows)).toEqual({
      '2024-09-01|USD': { rowCount: '2', billedCost: '1.35', effectiveCost: '1.00', effectiveCostNulls: '1', rowDigest: control.totals[0].rowDigest },
      '2024-10-01|USD': { rowCount: '1', billedCost: '0.24000000000', effectiveCost: '0.00000000000', effectiveCostNulls: '0', rowDigest: control.totals[1].rowDigest },
    });
  });

  it('equal ⇒ no problem', () => {
    expect(compareAcceptance({ control, apiTotals, rows })).toEqual([]);
  });

  it('every kind of difference is a problem', () => {
    const cases = {
      'api rowCount': { apiTotals: [{ ...apiTotals[0], rowCount: '3' }, apiTotals[1]] },
      'api rowCount as a number': { apiTotals: [{ ...apiTotals[0], rowCount: 2 }, apiTotals[1]] },
      'api billed value': { apiTotals: [{ ...apiTotals[0], billedCost: '1.36' }, apiTotals[1]] },
      'api billed scale': { apiTotals: [{ ...apiTotals[0], billedCost: '1.350' }, apiTotals[1]] },
      'api period missing': { apiTotals: [apiTotals[0]] },
      'api extra period': { apiTotals: [...apiTotals, { ...apiTotals[1], billingPeriod: '2024-11-01' }] },
      'api duplicate entry': { apiTotals: [...apiTotals, apiTotals[0]] },
      'api null totals': { apiTotals: null },
      'row billed': { rows: [row({ rowOrdinal: '0', billedCost: '1.11', effectiveCost: '1.00', extraColumns: { Id: 'a' } }), rows[1], rows[2]] },
      'row effective': { rows: [row({ rowOrdinal: '0', billedCost: '1.10', effectiveCost: '0.99', extraColumns: { Id: 'a' } }), rows[1], rows[2]] },
      'row effective null count': { rows: [rows[0], row({ rowOrdinal: '1', billedCost: '0.25', effectiveCost: '0', extraColumns: { Id: 'b' } }), rows[2]] },
      'row swapped values (digest)': {
        rows: [row({ rowOrdinal: '0', billedCost: '0.25', effectiveCost: '1.00', extraColumns: { Id: 'a' } }), row({ rowOrdinal: '1', billedCost: '1.10', effectiveCost: null, extraColumns: { Id: 'b' } }), rows[2]],
      },
      'row missing': { rows: [rows[0], rows[2]] },
      'row duplicated (same key)': { rows: [...rows, rows[0]] },
      'row missing Id': { rows: [row({ rowOrdinal: '0', billedCost: '1.10', effectiveCost: '1.00', extraColumns: {} }), rows[1], rows[2]] },
      'row billed not a decimal string': { rows: [row({ rowOrdinal: '0', billedCost: 1.1, effectiveCost: '1.00', extraColumns: { Id: 'a' } }), rows[1], rows[2]] },
      'row in another currency': { rows: [rows[0], rows[1], { ...rows[2], billingCurrency: 'EUR' }] },
    };
    for (const [name, change] of Object.entries(cases)) {
      const problems = compareAcceptance({ control, apiTotals, rows, ...change });
      expect(problems.length, name).toBeGreaterThan(0);
    }
  });

  it('the API artifact set must equal the staged data objects', () => {
    expect(artifactSetProblems(rows, ['f'.repeat(64), 'e'.repeat(64)])).toEqual([]);
    expect(artifactSetProblems(rows, ['f'.repeat(64)]).length).toBeGreaterThan(0);
    expect(artifactSetProblems(rows, ['f'.repeat(64), 'e'.repeat(64), 'd'.repeat(64)]).length).toBeGreaterThan(0);
  });

  it('first sync: every control period published with the control’s count and billed total, unverified; nothing else', () => {
    const rec = (periods, pass = true) => ({ type: 'ratio.evidence', pass, results: { periods } });
    const good = [
      { billingPeriod: '2024-09-01', outcome: 'published', rowCount: '2', billedTotal: '1.35', reconciliation: 'unverified' },
      { billingPeriod: '2024-10-01', outcome: 'published', rowCount: '1', billedTotal: '0.24000000000', reconciliation: 'unverified' },
    ];
    expect(syncProblems(rec(good), control)).toEqual([]);
    const bad = {
      quarantined: [{ ...good[0], outcome: 'quarantined', code: 'UNPARSEABLE_NUMBER' }, good[1]],
      count: [{ ...good[0], rowCount: '3' }, good[1]],
      billed: [{ ...good[0], billedTotal: '1.350' }, good[1]],
      reconciled: [{ ...good[0], reconciliation: 'reconciled' }, good[1]],
      missing: [good[0]],
      extra: [...good, { ...good[1], billingPeriod: '2024-11-01' }],
    };
    for (const [name, periods] of Object.entries(bad)) expect(syncProblems(rec(periods), control).length, name).toBeGreaterThan(0);
    expect(syncProblems(rec(good, false), control).length).toBeGreaterThan(0);
  });

  it('second sync: every control period skipped_unchanged; nothing else', () => {
    const rec = (periods) => ({ pass: true, results: { periods } });
    const good = [
      { billingPeriod: '2024-09-01', outcome: 'skipped_unchanged' },
      { billingPeriod: '2024-10-01', outcome: 'skipped_unchanged' },
    ];
    expect(resyncProblems(rec(good), control)).toEqual([]);
    expect(resyncProblems(rec([good[0], { ...good[1], outcome: 'published' }]), control).length).toBeGreaterThan(0);
    expect(resyncProblems(rec([good[0]]), control).length).toBeGreaterThan(0);
  });

  it('catalog: exactly one published, unverified, non-provisional batch per control period, with the control’s count and total', () => {
    const b = (o) => ({ billing_period: '2024-09-01', status: 'published', reconciliation: 'unverified', is_provisional: false, row_count: '2', loaded_billed_total: '1.35', ...o });
    const good = [b({}), b({ billing_period: '2024-10-01', row_count: '1', loaded_billed_total: '0.24000000000' })];
    expect(batchProblems(good, control)).toEqual([]);
    const bad = {
      quarantined: [...good, b({ status: 'quarantined' })],
      superseded: [...good, b({ status: 'superseded' })],
      provisional: [b({ is_provisional: true }), good[1]],
      reconciled: [b({ reconciliation: 'reconciled' }), good[1]],
      count: [b({ row_count: '3' }), good[1]],
      total: [b({ loaded_billed_total: '1.350' }), good[1]],
      missing: [good[0]],
    };
    for (const [name, batches] of Object.entries(bad)) expect(batchProblems(batches, control).length, name).toBeGreaterThan(0);
  });
});

describe('A6 mutations change the staged objects as DESIGN §6 says', () => {
  const clean09 = recordsOf(STAGED, '2024-09');
  const diffIdx = (a, b) => a.map((l, i) => (l !== b[i] ? i : -1)).filter((i) => i >= 0);
  const stage = (mutation) => stageFocusSample(UPSTREAM_1K, { mutation });

  it('the list of kinds is exactly the documented one', () => {
    expect([...MUTATIONS]).toEqual(['corrupt-billed', 'corrupt-effective', 'drop-row', 'double-ingest', 'shift-period', 'swap-billed', 'skip-null-conversion', 'skip-period-split']);
    expect(() => stage('nope')).toThrow(/mutation/);
  });

  for (const [kind, column] of [['corrupt-billed', 'BilledCost'], ['corrupt-effective', 'EffectiveCost']]) {
    it(`${kind}: one record of the largest period, ${column} + 1 in the last decimal place`, () => {
      const s = stage(kind);
      expect(s.mutation).toBe(kind);
      const m = recordsOf(s, '2024-09');
      const d = diffIdx(clean09, m);
      expect(d).toHaveLength(1);
      const before = fieldsOf(clean09[d[0]]);
      const after = fieldsOf(m[d[0]]);
      const changed = before.map((f, i) => (f.raw !== after[i].raw ? HEADER[i] : null)).filter(Boolean);
      expect(changed).toEqual([column]);
      const b = parseDecimal(before[col(column)].value);
      const a = parseDecimal(after[col(column)].value);
      expect(a.scale).toBe(b.scale);
      expect(a.unscaled - b.unscaled).toBe(1n);
      expect(recordsOf(s, '2024-10')).toEqual(recordsOf(STAGED, '2024-10'));
    });
  }

  it('drop-row: the last record of the largest period is gone', () => {
    const m = recordsOf(stage('drop-row'), '2024-09');
    expect(m).toEqual(clean09.slice(0, -1));
  });

  it('double-ingest: a second data file with the same records but different bytes, listed in the manifest', () => {
    const s = stage('double-ingest');
    const files = dataObjects(s, '2024-09');
    expect(files).toHaveLength(2);
    expect(files[0].sha256).not.toBe(files[1].sha256);
    expect(gunzipText(files[0])).toBe(gunzipText(files[1]));
    expect(gunzipText(files[0])).toBe(gunzipText(dataObjects(STAGED, '2024-09')[0]));
    expect(JSON.parse(manifestOf(s, '2024-09').body.toString()).dataFiles).toHaveLength(2);
    expect(s.periods[0]).toEqual({ billingPeriod: '2024-09-01', records: 1998, dataFiles: 2 });
  });

  it('shift-period: the latest period’s records are restated into the earliest period', () => {
    const s = stage('shift-period');
    expect(s.periods).toEqual([{ billingPeriod: '2024-09-01', records: 1000, dataFiles: 1 }]);
    expect(s.objects.some((o) => o.key.includes('BILLING_PERIOD=2024-10/'))).toBe(false);
    const moved = fieldsOf(recordsOf(s, '2024-09').at(-1));
    expect(moved[col('BillingPeriodStart')].value).toBe('2024-09-01 00:00:00');
    expect(moved[col('BillingPeriodEnd')].value).toBe('2024-10-01 00:00:00');
    expect(moved[col('Id')].raw).toBe(fieldsOf(recordsOf(STAGED, '2024-10')[0])[col('Id')].raw);
  });

  it('swap-billed: BilledCost swapped between two records whose values differ; the multiset is unchanged', () => {
    const m = recordsOf(stage('swap-billed'), '2024-09');
    const d = diffIdx(clean09, m);
    expect(d).toHaveLength(2);
    const billed = (lines) => lines.map((l) => fieldsOf(l)[col('BilledCost')].raw);
    expect(billed(m).sort()).toEqual(billed(clean09).sort());
    expect(billed(m)[d[0]]).toBe(billed(clean09)[d[1]]);
    expect(billed(m)[d[1]]).toBe(billed(clean09)[d[0]]);
  });

  it('skip-null-conversion: split by period, unquoted NULLs left in', () => {
    const s = stage('skip-null-conversion');
    expect(s.periods.map((p) => p.records)).toEqual([999, 1]);
    expect(recordsOf(s, '2024-09').some((l) => fieldsOf(l).some((f) => !f.quoted && f.value === 'NULL'))).toBe(true);
  });

  it('skip-period-split: every record in one file of the earliest period', () => {
    const s = stage('skip-period-split');
    expect(s.periods).toEqual([{ billingPeriod: '2024-09-01', records: 1000, dataFiles: 1 }]);
    expect(recordsOf(s, '2024-09').some((l) => fieldsOf(l)[col('BillingPeriodStart')].value === '2024-10-01 00:00:00')).toBe(true);
  });
});

describe('A7 pinned dataset files (no network in tests: the fetch is injected)', () => {
  const body = Buffer.from('a,b\n1,2\n');
  const pin = { bytes: body.length, sha256: sha256(body) };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-s2b-'));
  const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n !== 'f.csv');

  it('readDataset / pinnedUrl / verifyDatasetBytes', () => {
    const ds = readDataset(ROOT);
    expect(ds.commit).toBe('adbdd17a132984d6e8583c149c236d2199c3f5bc');
    expect(pinnedUrl(ds, '10k')).toBe('https://raw.githubusercontent.com/FinOps-Open-Cost-and-Usage-Spec/focus-sample-data/adbdd17a132984d6e8583c149c236d2199c3f5bc/FOCUS-1.0/focus_sample_10000.csv');
    expect(() => pinnedUrl(ds, '5k')).toThrow();
    expect(verifyDatasetBytes(UPSTREAM_1K, ds.files['1k'])).toEqual([]);
    expect(verifyDatasetBytes(Buffer.concat([UPSTREAM_1K, Buffer.from('x')]), ds.files['1k']).length).toBeGreaterThan(0);
    const flipped = Buffer.from(UPSTREAM_1K);
    flipped[100] ^= 1;
    expect(verifyDatasetBytes(flipped, ds.files['1k']).join(' ')).toMatch(/SHA-256/);
  });

  it('a matching body is written atomically; a second call finds it present', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'f.csv');
    const r = await fetchPinnedFile({ url: 'https://example.invalid/f.csv', pin, dest, timeoutMs: 1_000, fetchFn: async () => new Response(body) });
    expect(r).toBe('fetched');
    expect(fs.readFileSync(dest).equals(body)).toBe(true);
    expect(leftovers(dir)).toEqual([]);
    expect(await fetchPinnedFile({ url: 'https://example.invalid/f.csv', pin, dest, timeoutMs: 1_000, fetchFn: async () => { throw new Error('must not fetch'); } })).toBe('already-present');
  });

  it('refuses a wrong hash, a wrong size, an oversized body or an HTTP error, leaving no file', async () => {
    for (const [name, fetchFn] of [
      ['hash', async () => new Response(Buffer.from('a,b\n1,3\n'))],
      ['size', async () => new Response(Buffer.from('a,b\n1,2'))],
      ['oversized', async () => new Response(Buffer.concat([body, Buffer.alloc(1_000_000)]))],
      ['http', async () => new Response('nope', { status: 404 })],
    ]) {
      const dir = tmp();
      const dest = path.join(dir, 'f.csv');
      await expect(fetchPinnedFile({ url: 'https://example.invalid/f.csv', pin, dest, timeoutMs: 1_000, fetchFn }), name).rejects.toThrow();
      expect(fs.existsSync(dest), name).toBe(false);
      expect(leftovers(dir), name).toEqual([]);
    }
  });

  it('a corrupt cached copy is replaced only by a verified one', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'f.csv');
    fs.writeFileSync(dest, 'corrupt');
    expect(await fetchPinnedFile({ url: 'https://example.invalid/f.csv', pin, dest, timeoutMs: 1_000, fetchFn: async () => new Response(body) })).toBe('fetched');
    expect(fs.readFileSync(dest).equals(body)).toBe(true);
  });

  it('is bounded by a hard deadline, even when the fetch ignores its signal', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'f.csv');
    const t0 = Date.now();
    await expect(fetchPinnedFile({ url: 'https://example.invalid/f.csv', pin, dest, timeoutMs: 100, fetchFn: () => new Promise(() => undefined) })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('copyPinnedFile applies the same checks to a local clone', async () => {
    const dir = tmp();
    const src = path.join(dir, 'src.csv');
    const dest = path.join(dir, 'out', 'f.csv');
    fs.writeFileSync(src, body);
    expect(await copyPinnedFile({ src, pin, dest })).toBe('copied');
    expect(fs.readFileSync(dest).equals(body)).toBe(true);
    fs.writeFileSync(src, 'other');
    fs.rmSync(dest);
    await expect(copyPinnedFile({ src, pin, dest })).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('A9 local.mjs acceptance: the real path, no bypass (static)', () => {
  const src = read('scripts/local/local.mjs');
  const body = src.slice(src.indexOf('async function acceptance('), src.indexOf('// --- main'));

  it('is a command of local.mjs, on its own settings, after the preflight, inside runLocalTest with the interrupt', () => {
    expect(src).toMatch(/acceptance: \(_s, args\) => acceptance\(args\),/);
    expect(body).toMatch(/const settings = localAcceptanceSettings\(process\.env\);/);
    expect(body.indexOf("await preflight(settings, 'local:acceptance');")).toBeGreaterThan(0);
    expect(body.indexOf("await preflight(settings, 'local:acceptance');")).toBeLessThan(body.indexOf('runLocalTest({'));
    expect(body).toMatch(/runLocalTest\(\{[\s\S]*?down: \(\) => down\(settings, \{ volumes: true, timeoutMs: DOWN_TIMEOUT_MS \}\),[\s\S]*?signal: interrupt\.signal,/);
    expect(body).toMatch(/killLiveProcessGroups\(\);\s*summary\.steps\.timingsMs/);
  });

  it('checks the pin and runs the independent calculator before any stack exists', () => {
    expect(body).toMatch(/verifyDatasetBytes\(bytes, pin\)/);
    expect(body).toMatch(/run\('python3', \[CONTROL_CALCULATOR, '--expect-sha256', pin\.sha256, file\]/);
    expect(body.indexOf("run('python3'")).toBeLessThan(body.indexOf('runLocalTest({'));
    expect(body.indexOf('stageFocusSample(bytes')).toBeLessThan(body.indexOf('runLocalTest({'));
  });

  it('uses the real worker CLI twice and the real route; no fake source, no test hook, no control in the manifest', () => {
    expect(body.match(/syncRecord\(settings, secrets, SAMPLE_NAMES\.sourceKey\)/g)).toHaveLength(2);
    expect(src).toMatch(/workerCli\(settings, secrets, \['sync', '--tenant', secrets\.RATIO_LOCAL_TENANT_ID, '--source', sourceKey\]/);
    expect(body).toMatch(/startAppAndWait\(settings, secrets, \{ setApp, spawnGuard \}\)/);
    for (const forbidden of ['RATIO_ALLOW_FAKE_SOURCE', 'RATIO_TEST_', 'x-ratio-control', "'fake'", 'NODE_ENV: \'test\'']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
    const lib = read('scripts/local/acceptance.mjs');
    expect(lib).not.toMatch(/'x-ratio-control'\s*:/);
  });

  it('every comparison runs and fails the run', () => {
    for (const call of [
      'const syncIssues = syncProblems(first.record, control);',
      "fail('first sync', syncIssues)",
      "fail('second sync', resyncProblems(second.record, control))",
      'compareAcceptance({ control, apiTotals: totals, rows })',
      'artifactSetProblems(rows, dataShas)',
      "fail('catalog', batchProblems(catalog.batches, control))",
    ]) {
      expect(body, call).toContain(call);
    }
    expect(body).toMatch(/fail\('evidence re-hash', rehash\.filter\(\(r\) => r\.rehash !== r\.sha256\)/);
  });
});

describe('A8 wiring, pins and attribution', () => {
  it('npm scripts', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['local:acceptance']).toBe('node scripts/local/local.mjs acceptance');
    expect(scripts['sample:fetch']).toBe('node scripts/acceptance/fetch-focus-sample.mjs');
  });

  it('the fetched data and local state are gitignored; the committed CSV is never EOL-converted', () => {
    const ignore = read('.gitignore').split('\n');
    expect(ignore).toContain('.ratio-sample-data/');
    expect(ignore).toContain('.ratio-local/');
    expect(read('.gitattributes')).toMatch(/^fixtures\/focus-1\.0-sample\/\*\.csv -text$/m);
  });

  it('the committed 1k file is byte-identical to the pin (and so to upstream)', () => {
    const pin = DATASET.files['1k'];
    expect(UPSTREAM_1K.length).toBe(pin.bytes);
    expect(sha256(UPSTREAM_1K)).toBe(pin.sha256);
    // git's blob id of the same bytes, as listed by `git ls-tree` upstream.
    expect(crypto.createHash('sha1').update(`blob ${UPSTREAM_1K.length}\0`).update(UPSTREAM_1K).digest('hex')).toBe(pin.gitBlob);
    expect(PINNED['1k'].input).toEqual({ sha256: pin.sha256, bytes: pin.bytes, dataRows: pin.dataRows });
    expect(PINNED['10k'].input).toEqual({ sha256: DATASET.files['10k'].sha256, bytes: DATASET.files['10k'].bytes, dataRows: DATASET.files['10k'].dataRows });
    expect(DATASET.files['10k'].committed).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'fixtures', 'focus-1.0-sample', 'focus_sample_10000.csv'))).toBe(false);
  });

  it('NOTICE.md attributes the data and states the licence, the source, the commit and the changes', () => {
    const notice = read('fixtures/focus-1.0-sample/NOTICE.md');
    for (const needle of [
      'FinOps Foundation',
      'CC BY 4.0',
      'https://creativecommons.org/licenses/by/4.0/',
      'https://github.com/FinOps-Open-Cost-and-Usage-Spec/focus-sample-data',
      DATASET.commit,
      DATASET.files['1k'].sha256,
      '**Changes.**',
      'unmodified',
    ]) {
      expect(notice, needle).toContain(needle);
    }
  });
});
