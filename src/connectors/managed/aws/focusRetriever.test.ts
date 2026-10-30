// M1a: AWS Data Exports FOCUS retrieval as a registered managed retriever, against a SYNTHETIC
// in-process fake S3 (testing/fakeS3.ts) holding the public FOCUS 1.0 sample (CC BY 4.0,
// fixtures/focus-1.0-sample) or SYNTHETIC files built here from the documented column lists.
// Manifest field names and the layout follow the durable source (src/ingest/sources/s3/layout.ts)
// and are NOT VERIFIED against a real AWS export (docs/connectors/aws.md).
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import zlib from 'zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizerFor, collect } from '../../../ingest/import/normalizer';
import { probeManaged } from '../health';
import { managedRegistry } from '../registry';
import { runManagedFetch, type StageRequest } from '../runtime';
import { SecretValue } from '../secrets/resolve';
import { AWS_FOCUS_KIND, awsFocusRetriever, inspectHeader, parseFocusParams } from './focusRetriever';
import { FakeS3 } from './testing/fakeS3';

const SAMPLE = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'fixtures', 'focus-1.0-sample', 'focus_sample.csv'));
const SAMPLE_GZ = zlib.gzipSync(SAMPLE);
const BUCKET = 'synthetic-export-bucket';
const PREFIX = 'exports/synthetic';
const EXPORT = 'focus-synthetic';
const ROOT = `${PREFIX}/${EXPORT}/`;
const KEY_ID = 'SYNTHETICKEYID0001';
const SECRET_KEY = 'SYNTHETIC-secret-access-key-0001';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
// FOCUS 1.2 = 1.0 + the 1.1 and 1.2 additions (contracts focus-1.x-columns.json); FOCUS_1_2_AWS adds three x_ columns.
const ADDED = ['CapacityReservationId', 'CapacityReservationStatus', 'CommitmentDiscountQuantity', 'CommitmentDiscountUnit', 'ServiceSubcategory', 'SkuMeter', 'SkuPriceDetails', 'BillingAccountType', 'InvoiceId', 'PricingCurrency', 'PricingCurrencyContractedUnitPrice', 'PricingCurrencyEffectiveCost', 'PricingCurrencyListUnitPrice', 'SubAccountType'];
const sampleHeader = SAMPLE.toString('utf8', 0, SAMPLE.indexOf(10)).split(',').map((c) => c.replace(/"/g, ''));
const sampleRow = SAMPLE.toString('utf8', SAMPLE.indexOf(10) + 1, SAMPLE.indexOf(10, SAMPLE.indexOf(10) + 1));
/** SYNTHETIC FOCUS 1.2 (FOCUS_1_2_AWS-shaped) file: the sample's first row plus empty 1.1/1.2/x_ columns. */
const focus12 = (lower = false) => {
  const header = [...sampleHeader, ...ADDED, 'x_Discounts', 'x_Operation', 'x_ServiceCode'];
  return Buffer.from(`${(lower ? header.map((h) => h.toLowerCase()) : header).join(',')}\n${sampleRow}${','.repeat(ADDED.length + 3)}\n`);
};

const s3 = new FakeS3(BUCKET);
const secret = new SecretValue('aws/focus', JSON.stringify({ kind: 'static', accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY }));
let params: Record<string, unknown>;
const retriever = (p: Record<string, unknown> = {}) => awsFocusRetriever({ params: { ...params, ...p }, secret, registerSecret: () => undefined });
const dataKey = (ym: string, file = 'part-00001.csv.gz', run = 'run-1') => `${ROOT}data/BILLING_PERIOD=${ym}/${run}/${file}`;
const manifestKey = (ym: string, name = `${EXPORT}-Manifest.json`) => `${ROOT}metadata/BILLING_PERIOD=${ym}/${name}`;
function deliver(ym: string, files: Array<{ name: string; bytes?: Buffer }> = [{ name: 'part-00001.csv.gz', bytes: SAMPLE_GZ }], o: { manifest?: string; run?: string; at?: Date; extra?: Record<string, unknown> } = {}) {
  for (const f of files) if (f.bytes) s3.put(dataKey(ym, f.name, o.run), f.bytes, o.at);
  const doc = { billingPeriod: { start: `${ym}-01T00:00:00.000Z` }, dataFiles: files.map((f) => `s3://${BUCKET}/${dataKey(ym, f.name, o.run)}`), ...o.extra };
  s3.put(manifestKey(ym, o.manifest), JSON.stringify(doc), o.at);
}
const codeOf = (f: () => unknown) => {
  try {
    f();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

/** runManagedFetch with an in-memory originals store and a recording stage (the real pipeline is in the .db test). */
async function fetchAll(p: Record<string, unknown> = {}, range?: { from: string; to: string }) {
  const stored = new Map<string, Buffer>();
  const staged: StageRequest[] = [];
  const r = await runManagedFetch({
    tenantId: TENANT, sourceKey: 'aws-focus', sourceId: SOURCE, spec: { connector: 'aws-data-exports', params: { ...params, ...p }, secretRef: 'aws/focus' }, range,
    resolveSecret: () => secret, originals: { putBytes: async (k, b) => (stored.has(k) ? 'exists' : (stored.set(k, b), 'stored')) },
    stage: async (req) => {
      staged.push(req);
      return { status: 'succeeded' };
    },
  });
  return { r, staged, stored };
}

beforeAll(async () => {
  await s3.start();
  params = { bucket: BUCKET, prefix: PREFIX, exportName: EXPORT, region: 'us-east-1', table: 'FOCUS_1_0_AWS', endpoint: s3.endpoint };
});
afterAll(async () => {
  await s3.stop();
});
beforeEach(() => {
  s3.objects.clear();
  s3.requests.length = 0;
  s3.deny = undefined;
  s3.pageSize = 1000;
});

describe('registration and params', () => {
  it('is registered for aws-data-exports, with gzip-aware normalizers for both FOCUS tables', () => {
    expect(managedRegistry.factory('aws-data-exports')).toBe(awsFocusRetriever);
    expect(normalizerFor(AWS_FOCUS_KIND, '1.0').schemaVersion).toBe('1.0');
    expect(normalizerFor(AWS_FOCUS_KIND, '1.2').schemaVersion).toBe('1.2');
    expect(retriever().describe()).toEqual({ connector: 'aws-data-exports', sourceKind: AWS_FOCUS_KIND, schemaVersion: '1.0', dataset: 'FOCUS_1_0_AWS' });
    expect(retriever({ table: 'FOCUS_1_2_AWS' }).describe()).toMatchObject({ schemaVersion: '1.2', dataset: 'FOCUS_1_2_AWS' });
  });

  it('refuses unknown keys, other tables, a missing region, a non-https endpoint and an unproven manifest selection rule', () => {
    expect(codeOf(() => parseFocusParams({ ...params, accessKeyId: 'x' }))).toBe('PARAMS_INVALID');
    expect(codeOf(() => parseFocusParams({ ...params, table: 'COST_AND_USAGE_REPORT' }))).toBe('TABLE_UNSUPPORTED');
    expect(codeOf(() => parseFocusParams({ ...params, region: undefined }))).toBe('PARAMS_INVALID');
    expect(codeOf(() => parseFocusParams({ ...params, exportName: '../x' }))).toBe('PARAMS_INVALID');
    expect(codeOf(() => parseFocusParams({ ...params, endpoint: 'http://s3.example.test' }))).toBe('PARAMS_INVALID');
    expect(codeOf(() => parseFocusParams({ ...params, endpoint: 'https://user:pw@s3.example.test' }))).toBe('PARAMS_INVALID');
    expect(parseFocusParams({ ...params, endpoint: 'https://s3.example.test' }).endpoint).toBe('https://s3.example.test');
    expect(codeOf(() => parseFocusParams({ ...params, manifestSelection: 'newest' }))).toBe('PARAMS_INVALID');
    expect(codeOf(() => parseFocusParams({ ...params, manifestSelection: 'latest-complete' }))).toBe('MANIFEST_SELECTION_UNPROVEN');
    expect(parseFocusParams({ ...params, manifestSelection: 'latest-complete', manifestSelectionEvidence: `sha256:${'a'.repeat(64)}` }).manifestSelection).toBe('latest-complete');
    expect(parseFocusParams(params).manifestSelection).toBe('single');
    expect(codeOf(() => awsFocusRetriever({ params, secret: undefined, registerSecret: () => undefined }))).toBe('SECRET_INVALID');
  });
});

describe('listDeliveries and open', () => {
  it('one delivery per period from its manifest: every listed file once, sizes declared, read with If-Match, identity with the ETag', async () => {
    deliver('2024-09', [{ name: 'part-00001.csv.gz', bytes: SAMPLE_GZ }, { name: 'part-00002.csv.gz', bytes: zlib.gzipSync(SAMPLE.subarray(0, 2000)) }]);
    s3.put(dataKey('2024-09', 'stale.csv.gz', 'run-0'), SAMPLE_GZ); // not in the manifest: never read
    s3.pageSize = 1; // listings are paged to the end
    const r = retriever();
    const [d] = await r.listDeliveries();
    expect(d).toMatchObject({ billingPeriod: '2024-09-01', completion: 'complete' });
    expect(d.id).toMatch(/^aws-focus 2024-09 manifest-sha256:[0-9a-f]{64} selection:single$/);
    expect(d.objects.map((o) => [o.name, o.size])).toEqual([['run-1/part-00001.csv.gz', SAMPLE_GZ.length], ['run-1/part-00002.csv.gz', expect.any(Number)]]);
    const opened = await r.open(d.objects[0].ref);
    expect(opened.bytes.equals(SAMPLE_GZ)).toBe(true);
    expect(opened.identity).toEqual({ kind: 'object', bucket: BUCKET, key: dataKey('2024-09'), etag: s3.objects.get(dataKey('2024-09'))!.etag });
    const get = s3.requests.find((q) => q.path.endsWith('part-00001.csv.gz'))!;
    expect(String(get.headers['if-match'])).toContain(s3.objects.get(dataKey('2024-09'))!.etag);
    expect(s3.gets().some((k) => k.endsWith('stale.csv.gz'))).toBe(false);
  });

  it('through the runtime: originals captured byte-identical, each file handed to stage exactly once; a rewritten manifest is a new revision', async () => {
    deliver('2024-09');
    const a = await fetchAll();
    expect(a.r.status).toBe('succeeded');
    expect(a.staged).toHaveLength(1);
    expect(a.staged[0]).toMatchObject({ sourceKind: AWS_FOCUS_KIND, schemaVersion: '1.0', period: '2024-09-01' });
    expect(a.staged[0].objects.map((o) => o.bytes.equals(SAMPLE_GZ))).toEqual([true]);
    expect(a.r.deliveries[0].originals).toMatchObject([{ byteSize: SAMPLE_GZ.length, identity: { kind: 'object', key: dataKey('2024-09') } }]);
    expect([...a.stored.values()].map((b) => b.equals(SAMPLE_GZ))).toEqual([true]);
    // A refresh rewrites the manifest (OVERWRITE_REPORT): same period, a new manifest hash, the new file only.
    deliver('2024-09', [{ name: 'part-00009.csv.gz', bytes: zlib.gzipSync(SAMPLE.subarray(0, 3000)) }], { run: 'run-2' });
    const b = await fetchAll();
    expect(b.staged).toHaveLength(1);
    expect(b.staged[0].objects).toHaveLength(1);
    expect(b.r.deliveries[0].delivery).not.toBe(a.r.deliveries[0].delivery);
  });

  it('several manifests for one period stay MANIFEST_AMBIGUOUS by default: nothing is opened or staged', async () => {
    deliver('2024-09', undefined, { manifest: 'Manifest.json', run: 'run-1' });
    deliver('2024-09', undefined, { manifest: 'other/Manifest.json', run: 'run-2' });
    const { r, staged, stored } = await fetchAll();
    expect(r.status).toBe('failed');
    expect(r.deliveries).toMatchObject([{ billingPeriod: '2024-09-01', outcome: 'failed', code: 'MANIFEST_AMBIGUOUS', originals: [] }]);
    expect(staged).toEqual([]);
    expect(stored.size).toBe(0);
    expect(s3.gets().filter((k) => k.includes('/data/'))).toEqual([]);
  });

  it('latest-complete (only with recorded evidence): the newest manifest whose files all exist; an incomplete newer one is skipped; a tie stays ambiguous', async () => {
    const proven = { manifestSelection: 'latest-complete', manifestSelectionEvidence: `sha256:${'b'.repeat(64)}` };
    deliver('2024-09', undefined, { manifest: 'a/Manifest.json', run: 'run-1', at: new Date('2026-10-01T00:00:00Z') });
    deliver('2024-09', [{ name: 'part-00001.csv.gz', bytes: zlib.gzipSync(SAMPLE.subarray(0, 4000)) }], { manifest: 'b/Manifest.json', run: 'run-2', at: new Date('2026-10-02T00:00:00Z') });
    deliver('2024-09', [{ name: 'never-written.csv.gz' }], { manifest: 'c/Manifest.json', run: 'run-3', at: new Date('2026-10-03T00:00:00Z') });
    const [d] = await retriever(proven).listDeliveries();
    expect(d.id).toContain('selection:latest-complete');
    expect(d.objects.map((o) => o.name)).toEqual(['run-2/part-00001.csv.gz']);
    deliver('2024-09', undefined, { manifest: 'd/Manifest.json', run: 'run-4', at: new Date('2026-10-02T00:00:00Z') });
    const { r } = await fetchAll(proven);
    expect(r.deliveries).toMatchObject([{ outcome: 'failed', code: 'MANIFEST_AMBIGUOUS' }]);
  });

  it('a manifest naming a missing file is MANIFEST_INVALID: nothing published', async () => {
    deliver('2024-09', [{ name: 'part-00001.csv.gz', bytes: SAMPLE_GZ }, { name: 'missing.csv.gz' }]);
    const { r, staged } = await fetchAll();
    expect(r.deliveries).toMatchObject([{ outcome: 'failed', code: 'MANIFEST_INVALID' }]);
    expect(staged).toEqual([]);
  });

  it('a lower-case billing_period= partition is LAYOUT_CASE_MISMATCH, never a silent empty run', async () => {
    s3.put(`${ROOT}metadata/billing_period=2024-09/${EXPORT}-Manifest.json`, '{"dataFiles":[]}');
    s3.put(`${ROOT}data/billing_period=2024-09/part.csv.gz`, SAMPLE_GZ);
    const { r, staged } = await fetchAll();
    expect(r.status).toBe('failed');
    expect(r.deliveries).toMatchObject([{ billingPeriod: '2024-09-01', outcome: 'failed', code: 'LAYOUT_CASE_MISMATCH' }]);
    expect(staged).toEqual([]);
  });

  it('an empty export fails EXPORT_EMPTY; a month of the range without a delivery is PERIOD_NOT_DELIVERED', async () => {
    expect((await fetchAll()).r).toMatchObject({ status: 'failed', error: { code: 'EXPORT_EMPTY' } });
    deliver('2024-09');
    const { r, staged } = await fetchAll({}, { from: '2024-08', to: '2024-09' });
    expect(r.deliveries.map((d) => [d.billingPeriod, d.outcome, d.code])).toEqual([['2024-08-01', 'failed', 'PERIOD_NOT_DELIVERED'], ['2024-09-01', 'staged', undefined]]);
    expect(staged.map((s) => s.period)).toEqual(['2024-09-01']);
    expect((await fetchAll({}, { from: '2020-01', to: '2024-09' })).r).toMatchObject({ status: 'failed', error: { code: 'RANGE_TOO_LONG' } });
  });

  it('Parquet or ZIP data files are FORMAT_UNSUPPORTED before any data file is read', async () => {
    deliver('2024-09', [{ name: 'part-00001.snappy.parquet', bytes: Buffer.from('PAR1synthetic') }]);
    deliver('2024-10', [{ name: 'part-00001.csv.zip', bytes: Buffer.from('PK\u0003\u0004synthetic') }]);
    const { r, staged } = await fetchAll();
    expect(r.deliveries.map((d) => d.code)).toEqual(['FORMAT_UNSUPPORTED', 'FORMAT_UNSUPPORTED']);
    expect(staged).toEqual([]);
    expect(s3.gets().filter((k) => k.includes('/data/'))).toEqual([]);
  });

  it('a manifest declaring another table than params.table is FOCUS_TABLE_MISMATCH', async () => {
    deliver('2024-09', undefined, { extra: { exportArn: 'arn:aws:bcm-data-exports:us-east-1:000000000000:export/synthetic', queryStatement: 'SELECT * FROM FOCUS_1_2_AWS' } });
    expect((await fetchAll()).r.deliveries).toMatchObject([{ code: 'FOCUS_TABLE_MISMATCH' }]);
    expect((await fetchAll({ table: 'FOCUS_1_2_AWS' })).r.deliveries).toMatchObject([{ outcome: 'staged' }]);
  });

  it('deliveryEvidence: declared versions, the manifest identity and its controls as aggregate (never proof)', async () => {
    deliver('2024-09', undefined, { extra: { 'x-ratio-control': { rowCount: 7 } } });
    const r = retriever({ table: 'FOCUS_1_2_AWS' });
    const [d] = await r.listDeliveries();
    const ev = r.deliveryEvidence(d.id)!;
    expect(ev.versions).toMatchObject({ provider: 'AWS', dataset: 'FOCUS_1_2_AWS', exportSchemaVersion: '1.2', sourceFocusVersion: 'unknown', observedSchema: 'unknown', apiVersion: 'unknown' });
    expect(ev.inventory).toMatchObject({ billingPeriod: '2024-09-01', completion: 'complete', revision: expect.stringMatching(/^manifest-sha256:[0-9a-f]{64}$/) });
    expect(ev.manifest).toMatchObject({ key: manifestKey('2024-09'), selection: 'single', etag: expect.any(String) });
    expect(ev.aggregateControls).toEqual({ control: 'aggregate', proof: false, rowCount: 7 });
  });
});

describe('normalizer (gzip, FOCUS version and header checks at staging)', () => {
  const run = async (version: '1.0' | '1.2', bytes: Buffer) => {
    const { csv, report } = await normalizerFor(AWS_FOCUS_KIND, version).normalize(Readable.from([bytes]));
    return { csv: await collect(csv, 1 << 30), report: report as unknown as { versions: Record<string, unknown> } };
  };
  const err = (p: Promise<unknown>) => p.then(() => undefined, (e) => (e as { code?: string }).code);

  it('decompresses the original and records observed and declared versions separately', async () => {
    const a = await run('1.0', SAMPLE_GZ);
    expect(a.csv.equals(SAMPLE)).toBe(true);
    expect(a.report.versions).toMatchObject({ provider: 'AWS', dataset: 'FOCUS_1_0_AWS', exportSchemaVersion: '1.0', sourceFocusVersion: '1.0', observedSchema: { columns: sampleHeader } });
    const b = await run('1.2', zlib.gzipSync(focus12()));
    expect(b.report.versions).toMatchObject({ exportSchemaVersion: '1.2', sourceFocusVersion: '1.2' });
    expect((b.report.versions.observedSchema as { columns: string[] }).columns).toContain('x_ServiceCode');
  });

  it('refuses a version mismatch, lower-case headers, Parquet, ZIP and corrupt gzip with specific codes', async () => {
    expect(await err(run('1.0', zlib.gzipSync(focus12())))).toBe('FOCUS_VERSION_MISMATCH');
    expect(await err(run('1.2', SAMPLE_GZ))).toBe('FOCUS_VERSION_MISMATCH');
    expect(await err(run('1.2', zlib.gzipSync(focus12(true))))).toBe('HEADER_CASE_MISMATCH');
    expect(await err(run('1.0', Buffer.from('PAR1synthetic')))).toBe('FORMAT_UNSUPPORTED');
    expect(await err(run('1.0', Buffer.from('PK\u0003\u0004synthetic')))).toBe('FORMAT_UNSUPPORTED');
    expect(await err(run('1.0', SAMPLE_GZ.subarray(0, 40)))).toBe('IMPORT_FILE_INVALID');
  });

  it('inspectHeader: 1.0 by its required columns, 1.2 by any 1.1/1.2 addition, unknown otherwise', () => {
    expect(inspectHeader(sampleHeader, '1.0')).toEqual({ observed: '1.0' });
    expect(inspectHeader(['Foo', 'Bar'], '1.0')).toMatchObject({ observed: 'unknown', problem: { code: 'FOCUS_VERSION_UNKNOWN' } });
    expect(inspectHeader([...sampleHeader, 'SkuMeter'], '1.2')).toMatchObject({ observed: '1.1', problem: { code: 'FOCUS_VERSION_MISMATCH' } });
  });
});

describe('probe (auth -> scope -> data -> contract)', () => {
  it('all four stages pass on a readable export whose header matches the table: connected', async () => {
    deliver('2024-08');
    deliver('2024-09');
    const h = await probeManaged(retriever(), { secrets: [SECRET_KEY] });
    expect(h).toMatchObject({ connected: true, state: 'source-access-verified', stages: { auth: { ok: true }, scope: { ok: true }, data: { ok: true }, contract: { ok: true } } });
    // The contract stage reads only the head of one data file (a ranged GET), never a whole month.
    const ranged = s3.requests.filter((q) => q.headers.range);
    expect(ranged).toHaveLength(1);
    expect(ranged[0].path).toContain('BILLING_PERIOD=2024-09');
  });

  it('listing denied: auth passes, scope fails, not connected', async () => {
    s3.deny = () => ({ status: 403, code: 'AccessDenied' });
    const h = await probeManaged(retriever(), { secrets: [] });
    expect(h).toMatchObject({ connected: false, state: 'auth-verified', stages: { auth: { ok: true }, scope: { ok: false, code: 'SCOPE_DENIED' }, data: { ok: null } } });
  });

  it('a rejected key fails auth; a version mismatch fails the contract stage; an empty export fails data', async () => {
    s3.deny = () => ({ status: 403, code: 'InvalidAccessKeyId' });
    expect((await probeManaged(retriever(), { secrets: [] })).stages.auth).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
    s3.deny = undefined;
    expect((await probeManaged(retriever(), { secrets: [] })).stages.data).toMatchObject({ ok: false, code: 'EXPORT_EMPTY' });
    deliver('2024-09');
    const h = await probeManaged(retriever({ table: 'FOCUS_1_2_AWS' }), { secrets: [] });
    expect(h).toMatchObject({ connected: false, state: 'degraded', stages: { data: { ok: true }, contract: { ok: false, code: 'FOCUS_VERSION_MISMATCH' } } });
  });
});
