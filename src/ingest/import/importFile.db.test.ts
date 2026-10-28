// R3 end to end: `source add` and `import-file` through the worker CLI, real
// Postgres (worker login for the import, an owner login for provisioning) and
// real S3 (SeaweedFS). Fixture: the public FOCUS 1.0 Sample Data. The sample is
// an EXTRACT: its totals are reconciled only against the control totals computed
// for this exact file (control-totals.json "1k"), never against an assumed bill.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workerTestDb, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, createLogin, publishedTotals, type Login } from '../testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from '../testing/s3';
import { cli } from '../testing/cli';
import { generateSyntheticExport } from '../fixtures/syntheticFocus';

requireTestS3Endpoint();

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-1.0-sample');
const SAMPLE_FILE = path.join(FIXTURE_DIR, 'focus_sample.csv');
const CONTROLS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'control-totals.json'), 'utf8'))['1k'];
const AWS_SEP = CONTROLS.totals.find((t: { billingPeriod: string }) => t.billingPeriod === '2024-09-01');

let t: WorkerTestDb;
let owner: Login;
let evidence: TestBucket;
let src: TestBucket;
let tmp: string;
beforeAll(async () => {
  t = await workerTestDb();
  owner = await createLogin(t.db, ['ratio_owner']);
  evidence = await createTestBucket('ev');
  src = await createTestBucket('drop');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-import-'));
});
afterAll(async () => {
  await owner?.drop();
  await t?.close();
  await evidence?.destroy();
  await src?.destroy();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: owner.url, ...testS3Env(evidence) });
const newTenant = () => crypto.randomUUID();

async function addSource(tenant: string, key: string, providers: string) {
  return cli(['source', 'add', '--tenant', tenant, '--key', key, '--providers', providers, '--bucket', src.name, '--prefix', src.at(tenant)], env());
}

async function sourceId(tenant: string, key: string): Promise<string> {
  const r = await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1 AND source_key = $2`, [tenant, key]);
  return r.rows[0].id;
}

type Period = { billingPeriod: string; outcome: string; code?: string; rowCount?: string; billedTotal?: string; reconciliation?: string; reconciliationNote?: string; excludedRows?: string };
const periodsOf = (r: Awaited<ReturnType<typeof cli>>) => (r.record.results as { periods: Period[] }).periods;

describe('R3 source add', () => {
  it('provisions a ratio-file-drop source with its declared providers, idempotently, and needs no raw SQL', async () => {
    const tenant = newTenant();
    const r = await addSource(tenant, 'focus-aws', 'AWS');
    expect(r.code).toBe(0);
    expect(r.record).toMatchObject({ command: 'source add', pass: true, results: { tenant, sourceKey: 'focus-aws', providers: ['AWS'], outcome: 'created' } });
    const row = await t.db.pool.query(`SELECT kind, config FROM ratio.sources WHERE tenant_id = $1 AND source_key = 'focus-aws'`, [tenant]);
    expect(row.rows[0]).toEqual({ kind: 'focus_file', config: { layout: 'ratio-file-drop', bucket: src.name, prefix: src.at(tenant), exportName: 'focus-aws', providers: ['AWS'] } });
    const again = await addSource(tenant, 'focus-aws', 'AWS');
    expect(again.code).toBe(0);
    expect(again.record.results).toMatchObject({ outcome: 'unchanged' });
  });

  it('refuses an unknown provider (usage, exit 2) and a changed declaration for an existing source (exit 1)', async () => {
    const tenant = newTenant();
    const bad = await addSource(tenant, 'focus-x', 'AWS,Amazon Web Services');
    expect(bad.code).toBe(2);
    expect(bad.record).toMatchObject({ pass: false, results: { error: { code: 'USAGE' } } });
    expect((await t.db.pool.query(`SELECT 1 FROM ratio.sources WHERE tenant_id = $1`, [tenant])).rowCount).toBe(0);
    expect((await addSource(tenant, 'focus-x', 'AWS')).code).toBe(0);
    const changed = await addSource(tenant, 'focus-x', 'AWS,Microsoft');
    expect(changed.code).toBe(1);
    expect(changed.record).toMatchObject({ results: { error: { code: 'SOURCE_EXISTS_DIFFERENT' } } });
  });
});

describe('R3 import-file (public FOCUS 1.0 sample)', () => {
  it('[AWS]: 2024-09 publishes with the file\'s control totals, non-AWS rows are excluded, 2024-10 (Oracle only) is quarantined; re-import is unchanged', async () => {
    const tenant = newTenant();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const sid = await sourceId(tenant, 'focus-aws');
    const r = await cli(['import-file', '--tenant', tenant, '--source', 'focus-aws', '--file', SAMPLE_FILE], env());
    // 2024-10 holds one Oracle row only: every row excluded, quarantined (existing behavior), so the run fails.
    expect(r.code).toBe(1);
    const periods = periodsOf(r);
    expect(periods.map((p) => [p.billingPeriod, p.outcome, p.code ?? null])).toEqual([
      ['2024-09-01', 'published', null],
      ['2024-10-01', 'quarantined', 'PROVIDER_MISMATCH'],
    ]);
    const sep = periods[0];
    expect(sep).toMatchObject({ rowCount: AWS_SEP.rowCount, billedTotal: AWS_SEP.billedCost, excludedRows: CONTROLS.excluded[0].rowCount });
    // No control supplied: never reconciled.
    expect(sep).toMatchObject({ reconciliation: 'unverified', reconciliationNote: 'unverified (no control total supplied)' });
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({ '2024-09-01': { rows: Number(AWS_SEP.rowCount), total: AWS_SEP.billedCost } });
    expect(r.record.results).toMatchObject({ files: [{ sha256: CONTROLS.input.sha256, dataRows: 1000 }] });
    // The (pass-through) normalization report travels with the batch in the staged manifest.
    const manifestKey = (await src.keys(`${src.at(tenant)}/`)).find((k) => k.includes('/metadata/BILLING_PERIOD=2024-09/'))!;
    expect(JSON.parse((await src.get(manifestKey)).toString('utf8'))['x-ratio-import']).toEqual({
      normalization: [{ normalizer: 'focus-passthrough', sourceKind: 'focus-export', schemaVersion: '*', unmappedColumns: [], defaultedFields: [] }],
      files: [CONTROLS.input.sha256],
      period: '2024-09-01',
    });

    const before = await batchesOf(t.db.pool, tenant, sid);
    const again = await cli(['import-file', '--tenant', tenant, '--source', 'focus-aws', '--file', SAMPLE_FILE], env());
    expect(periodsOf(again).map((p) => [p.billingPeriod, p.outcome, p.code ?? null])).toEqual([
      ['2024-09-01', 'unchanged', null],
      ['2024-10-01', 'failed', 'BATCH_QUARANTINED'],
    ]);
    expect(await batchesOf(t.db.pool, tenant, sid)).toEqual(before);
  });

  it('[AWS] with the exact file\'s controls for 2024-09 (as csv.gz): reconciled; re-import unchanged, exit 0', async () => {
    const tenant = newTenant();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const gz = path.join(tmp, 'sample.csv.gz');
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(SAMPLE_FILE)));
    const args = ['import-file', '--tenant', tenant, '--source', 'focus-aws', '--file', gz, '--period', '2024-09', '--control-rows', AWS_SEP.rowCount, '--control-billed', AWS_SEP.billedCost, '--currency', 'USD'];
    const r = await cli(args, env());
    expect(r.code).toBe(0);
    expect(periodsOf(r)).toEqual([expect.objectContaining({ billingPeriod: '2024-09-01', outcome: 'published', reconciliation: 'reconciled', rowCount: AWS_SEP.rowCount, billedTotal: AWS_SEP.billedCost })]);
    const sid = await sourceId(tenant, 'focus-aws');
    const before = await batchesOf(t.db.pool, tenant, sid);
    expect(before.map((b) => [b.period, b.status, b.reconciliation, b.control_rows, b.control_total])).toEqual([['2024-09-01', 'published', 'reconciled', AWS_SEP.rowCount, AWS_SEP.billedCost]]);
    const again = await cli(args, env());
    expect(again.code).toBe(0);
    expect(periodsOf(again).map((p) => p.outcome)).toEqual(['unchanged']);
    expect(await batchesOf(t.db.pool, tenant, sid)).toEqual(before);
  });

  it('a control that does not match the file quarantines the period as a variance (no assumed full bill)', async () => {
    const tenant = newTenant();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const r = await cli(['import-file', '--tenant', tenant, '--source', 'focus-aws', '--file', SAMPLE_FILE, '--period', '2024-09', '--control-rows', '999', '--control-billed', AWS_SEP.billedCost, '--currency', 'USD'], env());
    expect(r.code).toBe(1);
    expect(periodsOf(r)).toEqual([expect.objectContaining({ billingPeriod: '2024-09-01', outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE', reconciliation: 'variance' })]);
    // Partial delivery is never published as complete, and the operator is told why (no cell values).
    expect(periodsOf(r)[0].reconciliationNote).toMatch(/^not published: the supplied control totals do not match/);
  });

  it('[Microsoft]: publishes the 51 Microsoft rows of 2024-09', async () => {
    const tenant = newTenant();
    expect((await addSource(tenant, 'focus-azure', 'Microsoft')).code).toBe(0);
    const r = await cli(['import-file', '--tenant', tenant, '--source', 'focus-azure', '--file', SAMPLE_FILE, '--period', '2024-09'], env());
    expect(r.code).toBe(0);
    const [sep] = periodsOf(r);
    expect(sep).toMatchObject({ billingPeriod: '2024-09-01', outcome: 'published', rowCount: CONTROLS.excluded[0].providers.Microsoft, reconciliation: 'unverified' });
    expect(sep.excludedRows).toBe(String(942 + 6));
  });

  it('the same file under a second source of the tenant is refused DUPLICATE_ARTIFACT before anything is written', async () => {
    const tenant = newTenant();
    expect((await addSource(tenant, 'focus-a', 'AWS')).code).toBe(0);
    expect((await addSource(tenant, 'focus-b', 'AWS')).code).toBe(0);
    expect((await cli(['import-file', '--tenant', tenant, '--source', 'focus-a', '--file', SAMPLE_FILE, '--period', '2024-09'], env())).code).toBe(0);
    const keysBefore = await src.keys(`${src.at(tenant)}/`);
    const dup = await cli(['import-file', '--tenant', tenant, '--source', 'focus-b', '--file', SAMPLE_FILE, '--period', '2024-09'], env());
    expect(dup.code).toBe(1);
    expect(dup.record).toMatchObject({ pass: false, results: { error: { code: 'DUPLICATE_ARTIFACT' } } });
    expect(await batchesOf(t.db.pool, tenant, await sourceId(tenant, 'focus-b'))).toEqual([]);
    expect(await src.keys(`${src.at(tenant)}/`)).toEqual(keysBefore);
  });

  it('operator-clear failures: missing file and unknown source (exit 1), bad flags (exit 2); no cell values printed', async () => {
    const tenant = newTenant();
    expect((await addSource(tenant, 'focus-aws', 'AWS')).code).toBe(0);
    const missing = await cli(['import-file', '--tenant', tenant, '--source', 'focus-aws', '--file', path.join(tmp, 'nope.csv')], env());
    expect([missing.code, (missing.record.results as { error: { code: string } }).error.code]).toEqual([1, 'IMPORT_FILE_UNREADABLE']);
    const unknown = await cli(['import-file', '--tenant', tenant, '--source', 'no-such', '--file', SAMPLE_FILE], env());
    expect(unknown.code).toBe(1);
    for (const argv of [
      ['--control-billed', '1.5'],
      ['--control-rows', '-1'],
      ['--control-billed', 'abc', '--currency', 'USD'],
      ['--currency', 'usd', '--control-billed', '1'],
    ]) {
      const r = await cli(['import-file', '--tenant', tenant, '--source', 'focus-aws', '--file', SAMPLE_FILE, '--period', '2024-09', ...argv], env());
      expect(r.code).toBe(2);
    }
    const bad = path.join(tmp, 'bad.csv');
    const lines = fs.readFileSync(SAMPLE_FILE, 'utf8').split('\n');
    fs.writeFileSync(bad, `${lines[0]}\n${lines[1].replace('"2024-09-01 00:00:00"', '"CELL-VALUE-77"')}\n`);
    const r = await cli(['import-file', '--tenant', tenant, '--source', 'focus-aws', '--file', bad], env());
    expect(r.code).toBe(1);
    expect((r.record.results as { error: { code: string } }).error.code).toBe('IMPORT_FILE_INVALID');
    expect(r.out.concat(r.err).join('\n')).not.toContain('CELL-VALUE-77');
  });

  // SYNTHETIC fixtures (src/ingest/fixtures/syntheticFocus.ts, ProviderName SyntheticCloud, accepted
  // only under the test opt-in): one CSV per variant, every data file of every period concatenated.
  function syntheticCsv(variant: 'base' | 'restatement'): string {
    const exp = generateSyntheticExport({ variant });
    const files = Object.keys(exp.csvByKey).sort().map((k) => exp.csvByKey[k].replace(/\n$/, '').split('\n'));
    return `${[files[0][0], ...files.flatMap((f) => f.slice(1))].join('\n')}\n`;
  }

  it('a changed file for a published period supersedes it (old batch retained, excluded from totals); identical legitimate rows are kept', async () => {
    const tenant = newTenant();
    expect((await addSource(tenant, 'focus-syn', 'AWS')).code).toBe(0);
    const sid = await sourceId(tenant, 'focus-syn');
    const base = path.join(tmp, `base-${tenant}.csv`);
    const restated = path.join(tmp, `restatement-${tenant}.csv`);
    fs.writeFileSync(base, syntheticCsv('base'));
    fs.writeFileSync(restated, syntheticCsv('restatement'));
    const totals = (v: 'base' | 'restatement') => Object.fromEntries(Object.entries(generateSyntheticExport({ variant: v }).totals).map(([p, x]) => [p, { rows: x.rowCount, total: x.billedTotal }]));

    const first = await cli(['import-file', '--tenant', tenant, '--source', 'focus-syn', '--file', base], env());
    expect(first.code).toBe(0);
    // The base July files hold deliberately identical legitimate rows: none is collapsed.
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual(totals('base'));

    const second = await cli(['import-file', '--tenant', tenant, '--source', 'focus-syn', '--file', restated], env());
    expect(second.code).toBe(0);
    expect(periodsOf(second).map((p) => [p.billingPeriod, p.outcome])).toEqual([
      ['2026-07-01', 'published'],
      ['2026-08-01', 'unchanged'],
    ]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual(totals('restatement'));
    const july = (await batchesOf(t.db.pool, tenant, sid)).filter((b) => b.period === '2026-07-01').map((b) => b.status);
    expect(july).toEqual(['superseded', 'published']);
  });
});

