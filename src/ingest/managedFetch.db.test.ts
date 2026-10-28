// M0a end to end: the worker command `fetch` runs a registered managed retriever
// (a SYNTHETIC fixture retriever registered by this test, never shipped) through
// the real pipeline: secret by name from RATIO_SECRETS_DIR, ORIGINAL bytes into
// the evidence bucket, then stageAndSync (staging, evidence, validator,
// publish) on real Postgres and S3. Data: the public FOCUS 1.0 sample, whose
// 2024-09 AWS controls were computed for this exact file (control-totals.json).
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedRegistry } from '../connectors/managed/registry';
import type { ManagedRetriever } from '../connectors/managed/runtime';
import { workerTestDb, type WorkerTestDb } from './testing/workerSetup';
import { createLogin, publishedTotals, type Login } from './testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from './testing/s3';
import { cli } from './testing/cli';

requireTestS3Endpoint();

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'focus-1.0-sample');
const SAMPLE = fs.readFileSync(path.join(FIXTURE_DIR, 'focus_sample.csv'));
const CONTROLS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'control-totals.json'), 'utf8'))['1k'];
const AWS_SEP = CONTROLS.totals.find((t: { billingPeriod: string }) => t.billingPeriod === '2024-09-01');
const SECRET = 'SYNTHETIC-managed-secret-41d9e2';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const seen: { secret?: string; opened: number } = { opened: 0 };
// SYNTHETIC fixture retriever: serves the sample file as one complete delivery for 2024-09.
managedRegistry.register('synthetic-fixture', ({ secret }) => {
  seen.secret = secret?.reveal();
  const r: ManagedRetriever = {
    describe: () => ({ connector: 'synthetic-fixture', sourceKind: 'focus-export', schemaVersion: '1.0', dataset: 'FOCUS 1.0 sample (public)' }),
    probe: async () => ({}),
    listDeliveries: async () => [{ id: 'sample-2024-09', billingPeriod: '2024-09-01', completion: 'complete', objects: [{ name: 'part-1', ref: 'focus_sample.csv' }] }],
    open: async (ref) => {
      seen.opened += 1;
      return { bytes: SAMPLE, identity: { kind: 'object', bucket: 'synthetic-provider-bucket', key: String(ref), etag: 'synthetic-etag' } };
    },
  };
  return r;
});

let t: WorkerTestDb;
let owner: Login;
let evidence: TestBucket;
let src: TestBucket;
let tmp: string;
beforeAll(async () => {
  t = await workerTestDb();
  owner = await createLogin(t.db, ['ratio_owner']);
  evidence = await createTestBucket('ev');
  src = await createTestBucket('managed');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-managed-'));
  fs.mkdirSync(path.join(tmp, 'secrets', 'synthetic'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'secrets', 'synthetic', 'key'), `${SECRET}\n`, { mode: 0o600 });
});
afterAll(async () => {
  await owner?.drop();
  await t?.close();
  await evidence?.destroy();
  await src?.destroy();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function engagementFile(connector: string, secretRef = 'synthetic/key'): string {
  const f = path.join(tmp, `engagement-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(f, JSON.stringify({ sources: [{ id: 'managed-aws', retrieval: { kind: 'managed', connector, params: {}, secretRef } }] }));
  return f;
}
const env = (config: string) => ({
  RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: owner.url, ...testS3Env(evidence), RATIO_ENGAGEMENT_CONFIG: config, RATIO_SECRETS_DIR: path.join(tmp, 'secrets'),
});

async function provision(tenant: string) {
  const r = await cli(['source', 'add', '--tenant', tenant, '--key', 'managed-aws', '--providers', 'AWS', '--bucket', src.name, '--prefix', src.at(tenant)], env(engagementFile('synthetic-fixture')));
  expect(r.code).toBe(0);
  return (await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1 AND source_key = 'managed-aws'`, [tenant])).rows[0].id as string;
}

describe('managed fetch (worker command)', () => {
  it('captures the original, stages it through the import pipeline and publishes the period; a re-fetch is unchanged', async () => {
    const tenant = crypto.randomUUID();
    const sid = await provision(tenant);
    const e = env(engagementFile('synthetic-fixture'));
    const r = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], e);
    expect(r.code).toBe(0);
    expect(seen.secret).toBe(SECRET);
    expect(r.record).toMatchObject({ command: 'fetch', pass: true, results: { status: 'succeeded', connector: 'synthetic-fixture', sourceKey: 'managed-aws' } });
    const d = (r.record.results as { deliveries: Array<Record<string, unknown>> }).deliveries;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ delivery: 'sample-2024-09', outcome: 'staged', completion: 'complete', originals: [{ sha256: sha(SAMPLE), byteSize: SAMPLE.length, stored: 'stored' }] });
    expect((d[0].result as { periods: unknown[] }).periods).toMatchObject([{ billingPeriod: '2024-09-01', outcome: 'published', rowCount: AWS_SEP.rowCount, billedTotal: AWS_SEP.billedCost }]);
    expect(await publishedTotals(t.db.pool, tenant, sid)).toEqual({ '2024-09-01': { rows: Number(AWS_SEP.rowCount), total: AWS_SEP.billedCost } });

    // The ORIGINAL is in the evidence bucket, byte-identical.
    const originalKey = (await evidence.keys()).find((k) => k.endsWith(`connector-originals/${tenant}/${sid}/${sha(SAMPLE)}`));
    expect(originalKey).toBeDefined();
    expect(sha(await evidence.get(originalKey!))).toBe(sha(SAMPLE));
    // The staged manifest carries the retrieval provenance.
    const manifestKey = (await src.keys(`${src.at(tenant)}/`)).find((k) => k.includes('/metadata/BILLING_PERIOD=2024-09/'))!;
    expect(JSON.parse((await src.get(manifestKey)).toString('utf8'))['x-ratio-import']).toMatchObject({ connector: 'synthetic-fixture', delivery: 'sample-2024-09', originals: [{ sha256: sha(SAMPLE) }], period: '2024-09-01' });
    // Only the delivery's period was staged.
    expect((await src.keys(`${src.at(tenant)}/`)).some((k) => k.includes('BILLING_PERIOD=2024-10'))).toBe(false);

    const again = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], e);
    expect(again.code).toBe(0);
    expect(((again.record.results as { deliveries: Array<{ result: { periods: Array<{ outcome: string }> }; originals: Array<{ stored: string }> }> }).deliveries[0])).toMatchObject({ result: { periods: [{ outcome: 'unchanged' }] }, originals: [{ stored: 'exists' }] });
    for (const line of [...r.out, ...r.err, ...again.out, ...again.err]) expect(line).not.toContain(SECRET);
  });

  it('an unregistered connector or a missing secret fails with its code and stages nothing', async () => {
    const tenant = crypto.randomUUID();
    await provision(tenant);
    const before = seen.opened;
    const a = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile('opencost')));
    expect(a.code).toBe(1);
    expect(a.record).toMatchObject({ pass: false, results: { status: 'failed', error: { code: 'CONNECTOR_NOT_REGISTERED' } } });
    const b = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile('synthetic-fixture', 'synthetic/absent')));
    expect(b.code).toBe(1);
    expect(b.record).toMatchObject({ results: { status: 'failed', error: { code: 'SECRET_MISSING' } } });
    expect(seen.opened).toBe(before);
    expect(await src.keys(`${src.at(tenant)}/`)).toEqual([]);
  });

  it('usage: --from needs --to; a source missing from the engagement config fails', async () => {
    const tenant = crypto.randomUUID();
    const u = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws', '--from', '2024-09'], env(engagementFile('synthetic-fixture')));
    expect(u.code).toBe(2);
    await provision(tenant);
    const f = path.join(tmp, 'empty.json');
    fs.writeFileSync(f, JSON.stringify({ sources: [] }));
    const m = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(f));
    expect(m.code).toBe(1);
    expect(m.record).toMatchObject({ results: { error: { code: 'SOURCE_NOT_IN_ENGAGEMENT_CONFIG' } } });
  });
});
