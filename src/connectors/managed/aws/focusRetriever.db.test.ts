// M1a end to end: `cli fetch` runs the REGISTERED aws-data-exports retriever against a SYNTHETIC
// AWS Data Exports layout written to the test S3 store (SeaweedFS), with the source's own
// credentials from RATIO_SECRETS_DIR (never the worker's RATIO_SOURCE_S3_* or AWS_* env). Data:
// the public FOCUS 1.0 sample (CC BY 4.0), whose 2024-09 AWS controls are pinned in
// fixtures/focus-1.0-sample/control-totals.json. Manifest shape: NOT VERIFIED against AWS.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cli } from '../../../ingest/testing/cli';
import { batchesOf, createLogin, publishedTotals, type Login } from '../../../ingest/testing/db';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createTestBucket, listKeys, requireTestS3Endpoint, testS3Env, TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY, type TestBucket } from '../../../ingest/testing/s3';
import { workerTestDb, type WorkerTestDb } from '../../../ingest/testing/workerSetup';

const endpoint = requireTestS3Endpoint();
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'fixtures', 'focus-1.0-sample');
const SAMPLE = fs.readFileSync(path.join(FIXTURE_DIR, 'focus_sample.csv'));
const AWS_SEP = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'control-totals.json'), 'utf8'))['1k'].totals.find((x: { billingPeriod: string }) => x.billingPeriod === '2024-09-01');
const EXPORT = 'focus-synthetic';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
// A SHORT export prefix of its own in the shared test bucket (deleted in afterAll): R1's credential
// heuristic refuses any params value of 40+ characters of [A-Za-z0-9+/_=-], which the per-run test
// root exceeds (a compatibility risk for real S3 prefixes; see the PR).
const EXPORT_ROOT = `m1a-${crypto.randomBytes(4).toString('hex')}`;

let t: WorkerTestDb;
let owner: Login;
let evidence: TestBucket;
let staging: TestBucket;
let exports: TestBucket;
let tmp: string;
beforeAll(async () => {
  t = await workerTestDb();
  owner = await createLogin(t.db, ['ratio_owner']);
  evidence = await createTestBucket('ev');
  staging = await createTestBucket('stage');
  exports = await createTestBucket('awsexp');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-m1a-'));
  fs.mkdirSync(path.join(tmp, 'secrets', 'aws'), { recursive: true });
  // The source's own key pair (the test store accepts any pair; what matters is that it comes from this file).
  fs.writeFileSync(path.join(tmp, 'secrets', 'aws', 'focus'), JSON.stringify({ kind: 'static', accessKeyId: TEST_S3_ACCESS_KEY_ID, secretAccessKey: TEST_S3_SECRET_ACCESS_KEY }), { mode: 0o600 });
});
afterAll(async () => {
  await owner?.drop();
  await t?.close();
  for (const b of [evidence, staging, exports]) await b?.destroy();
  if (exports) for (const k of await listKeys(exports.client, exports.name, `${EXPORT_ROOT}/`)) await exports.client.send(new DeleteObjectCommand({ Bucket: exports.name, Key: k }));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const exportPrefix = (tenant: string) => `${EXPORT_ROOT}/${tenant.slice(0, 8)}`;
const root = (tenant: string) => `${exportPrefix(tenant)}/${EXPORT}`;
async function deliver(tenant: string, ym: string, files: Array<{ name: string; bytes?: Buffer }>, partition = 'BILLING_PERIOD') {
  const keys = files.map((f) => `${root(tenant)}/data/${partition}=${ym}/run-1/${f.name}`);
  for (const [i, f] of files.entries()) if (f.bytes) await exports.put(keys[i], f.bytes);
  await exports.put(`${root(tenant)}/metadata/${partition}=${ym}/${EXPORT}-Manifest.json`, JSON.stringify({ billingPeriod: { start: `${ym}-01T00:00:00.000Z` }, dataFiles: keys.map((k) => `s3://${exports.name}/${k}`) }));
}
function engagementFile(tenant: string, params: Record<string, unknown> = {}): string {
  const f = path.join(tmp, `engagement-${crypto.randomBytes(4).toString('hex')}.json`);
  const p = { bucket: exports.name, prefix: exportPrefix(tenant), exportName: EXPORT, region: 'us-east-1', table: 'FOCUS_1_0_AWS', endpoint, ...params };
  fs.writeFileSync(f, JSON.stringify({ tenantId: tenant, sources: [{ id: 'aws-focus', retrieval: { kind: 'managed', connector: 'aws-data-exports', params: p, secretRef: 'aws/focus' } }] }));
  return f;
}
// The export is read with the client built from the secret file (the unit tests prove env AWS_* is ignored).
const env = (config: string) => ({ RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: owner.url, ...testS3Env(evidence), RATIO_ENGAGEMENT_CONFIG: config, RATIO_SECRETS_DIR: path.join(tmp, 'secrets') });
async function provision(tenant: string): Promise<string> {
  const r = await cli(['source', 'add', '--tenant', tenant, '--key', 'aws-focus', '--providers', 'AWS', '--bucket', staging.name, '--prefix', staging.at(tenant)], env(engagementFile(tenant)));
  expect(r.code).toBe(0);
  return (await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1 AND source_key = 'aws-focus'`, [tenant])).rows[0].id as string;
}
const fetch = (tenant: string, params: Record<string, unknown> = {}, extra: string[] = []) => cli(['fetch', '--tenant', tenant, '--source', 'aws-focus', ...extra], env(engagementFile(tenant, params)));
type Deliveries = Array<{ delivery: string; outcome: string; code?: string; originals: Array<{ sha256: string; stored: string }>; result?: { periods: Array<Record<string, unknown>>; normalization?: unknown } }>;
const deliveriesOf = (r: Awaited<ReturnType<typeof cli>>) => (r.record.results as { deliveries: Deliveries }).deliveries;

/** The sample without one 2024-09 AWS row: a restated delivery for the same period. */
function restated(): { bytes: Buffer; rows: number } {
  const lines = SAMPLE.toString('utf8').split('\n');
  const header = lines[0].split(',').map((v) => v.replace(/"/g, ''));
  const [iStart, iProv] = [header.indexOf('BillingPeriodStart'), header.indexOf('ProviderName')];
  const drop = lines.findIndex((l, i) => i > 0 && l.split(',').length === header.length && l.split(',')[iStart].includes('2024-09-01') && l.split(',')[iProv] === '"AWS"');
  expect(drop).toBeGreaterThan(0);
  return { bytes: Buffer.from(lines.filter((_, i) => i !== drop).join('\n'), 'utf8'), rows: Number(AWS_SEP.rowCount) - 1 };
}

describe('aws-data-exports FOCUS retrieval through cli fetch', () => {
  it('stages every manifest file once, keeps the gzip original as evidence, records versions; a re-run is unchanged; a restatement supersedes only with --restate', async () => {
    const tenant = crypto.randomUUID();
    const sid = await provision(tenant);
    const gz = zlib.gzipSync(SAMPLE);
    await deliver(tenant, '2024-09', [{ name: 'part-00001.csv.gz', bytes: gz }]);
    const r = await fetch(tenant);
    expect(r.code).toBe(0);
    const [d] = deliveriesOf(r);
    expect(d).toMatchObject({ outcome: 'staged', originals: [{ sha256: sha(gz), stored: 'stored' }] });
    expect(d.delivery).toMatch(/^aws-focus 2024-09 manifest-sha256:[0-9a-f]{64} selection:single$/);
    expect(d.result!.periods).toMatchObject([{ billingPeriod: '2024-09-01', outcome: 'published', rowCount: AWS_SEP.rowCount, billedTotal: AWS_SEP.billedCost }]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({ '2024-09-01': { rows: Number(AWS_SEP.rowCount), total: AWS_SEP.billedCost } });
    // The ORIGINAL (gzip bytes as delivered) is in the evidence store.
    const ok = (await evidence.keys()).find((k) => k.endsWith(`connector-originals/${tenant}/${sid}/${sha(gz)}`));
    expect(sha(await evidence.get(ok!))).toBe(sha(gz));
    // Declared (export table) and observed (header) versions are separate fields of the staged record.
    const mk = (await staging.keys(`${staging.at(tenant)}/`)).find((k) => k.includes('/metadata/BILLING_PERIOD=2024-09/'))!;
    const imp = JSON.parse((await staging.get(mk)).toString('utf8'))['x-ratio-import'];
    expect(imp).toMatchObject({ connector: 'aws-data-exports', dataset: 'FOCUS_1_0_AWS', delivery: d.delivery, normalization: [{ normalizer: 'aws-focus-export', versions: { exportSchemaVersion: '1.0', sourceFocusVersion: '1.0', observedSchema: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } } }] });

    const again = await fetch(tenant);
    expect(again.code).toBe(0);
    expect(deliveriesOf(again)[0]).toMatchObject({ originals: [{ stored: 'exists' }], result: { periods: [{ outcome: 'unchanged' }] } });

    // AWS rewrites the period (a refresh): without --restate nothing changes (exit 3); with it the old batch is superseded.
    const next = restated();
    await deliver(tenant, '2024-09', [{ name: 'part-00001.csv.gz', bytes: zlib.gzipSync(next.bytes) }]);
    const refused = await fetch(tenant);
    expect(refused.code).toBe(3);
    expect(deliveriesOf(refused)[0]).toMatchObject({ outcome: 'refused', code: 'PERIOD_ALREADY_PUBLISHED' });
    expect((await publishedTotals(t.db.pool, tenant, sid))['2024-09-01'].rows).toBe(Number(AWS_SEP.rowCount));
    const restate = await fetch(tenant, {}, ['--restate']);
    expect(restate.code).toBe(0);
    expect((await publishedTotals(t.db.pool, tenant, sid))['2024-09-01'].rows).toBe(next.rows);
    expect((await batchesOf(t.db.pool, tenant, sid)).map((b) => b.status)).toEqual(['superseded', 'published']);
  });

  it('a manifest naming a missing file, a lower-case partition and a version mismatch each fail with their code; nothing is published', async () => {
    const tenant = crypto.randomUUID();
    const sid = await provision(tenant);
    await deliver(tenant, '2024-09', [{ name: 'part-00001.csv.gz', bytes: zlib.gzipSync(SAMPLE) }, { name: 'missing.csv.gz' }]);
    await deliver(tenant, '2024-10', [{ name: 'part-00001.csv.gz', bytes: zlib.gzipSync(SAMPLE) }], 'billing_period');
    const r = await fetch(tenant);
    expect(r.code).toBe(1);
    expect(deliveriesOf(r).map((d) => [d.outcome, d.code])).toEqual([['failed', 'MANIFEST_INVALID'], ['failed', 'LAYOUT_CASE_MISMATCH']]);
    expect(await staging.keys(`${staging.at(tenant)}/`)).toEqual([]);
    // The export is FOCUS 1.0, configured as the 1.2 table: refused at staging, the original is kept as evidence.
    await deliver(tenant, '2024-09', [{ name: 'part-00001.csv.gz', bytes: zlib.gzipSync(SAMPLE) }]);
    const m = await fetch(tenant, { table: 'FOCUS_1_2_AWS' }, ['--from', '2024-09', '--to', '2024-09']);
    expect(m.code).toBe(1);
    expect(deliveriesOf(m)).toMatchObject([{ outcome: 'failed', code: 'FOCUS_VERSION_MISMATCH', originals: [{ stored: 'stored' }] }]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({});
  });
});
