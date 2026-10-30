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
const serve: { bytes: Buffer; delivery: string; key: string } = { bytes: SAMPLE, delivery: 'sample-2024-09', key: 'focus_sample.csv' };
// SYNTHETIC fixture retriever, registered in this test process only (never shipped) under an id R1
// names (the worker refuses connectors outside MANAGED_CONNECTORS, like R1): serves the sample file
// as one complete delivery for 2024-09.
const FIXTURE_CONNECTOR = 'opencost';
managedRegistry.register(FIXTURE_CONNECTOR, ({ secret }) => {
  seen.secret = secret?.reveal();
  const r: ManagedRetriever = {
    describe: () => ({ connector: FIXTURE_CONNECTOR, sourceKind: 'focus-export', schemaVersion: '1.0', dataset: 'FOCUS 1.0 sample (public)' }),
    probe: async () => ({}),
    listDeliveries: async () => [{ id: serve.delivery, billingPeriod: '2024-09-01', completion: 'complete', objects: [{ name: 'part-1', ref: serve.key }] }],
    open: async (ref) => {
      seen.opened += 1;
      return { bytes: serve.bytes, identity: { kind: 'object', bucket: 'synthetic-provider-bucket', key: String(ref), etag: 'synthetic-etag' } };
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

function engagementFile(tenantId: string, connector: string = FIXTURE_CONNECTOR, secretRef = 'synthetic/key', sourceId = 'managed-aws'): string {
  const f = path.join(tmp, `engagement-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(f, JSON.stringify({ tenantId, sources: [{ id: sourceId, retrieval: { kind: 'managed', connector, params: {}, secretRef } }] }));
  return f;
}
const env = (config: string) => ({
  RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: owner.url, ...testS3Env(evidence), RATIO_ENGAGEMENT_CONFIG: config, RATIO_SECRETS_DIR: path.join(tmp, 'secrets'),
});

async function provision(tenant: string) {
  const r = await cli(['source', 'add', '--tenant', tenant, '--key', 'managed-aws', '--providers', 'AWS', '--bucket', src.name, '--prefix', src.at(tenant)], env(engagementFile(tenant)));
  expect(r.code).toBe(0);
  return (await t.db.pool.query(`SELECT id::text FROM ratio.sources WHERE tenant_id = $1 AND source_key = 'managed-aws'`, [tenant])).rows[0].id as string;
}

describe('managed fetch (worker command)', () => {
  it('captures the original, stages it through the import pipeline and publishes the period; a re-fetch is unchanged', async () => {
    const tenant = crypto.randomUUID();
    const sid = await provision(tenant);
    const e = env(engagementFile(tenant));
    const r = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], e);
    expect(r.code).toBe(0);
    expect(seen.secret).toBe(SECRET);
    expect(r.record).toMatchObject({ command: 'fetch', pass: true, results: { status: 'succeeded', connector: FIXTURE_CONNECTOR, sourceKey: 'managed-aws' } });
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
    expect(JSON.parse((await src.get(manifestKey)).toString('utf8'))['x-ratio-import']).toMatchObject({ connector: FIXTURE_CONNECTOR, delivery: 'sample-2024-09', originals: [{ sha256: sha(SAMPLE) }], period: '2024-09-01' });
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
    const a = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant, 'nutanix')));
    expect(a.code).toBe(1);
    expect(a.record).toMatchObject({ pass: false, results: { status: 'failed', error: { code: 'CONNECTOR_NOT_REGISTERED' } } });
    const b = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant, FIXTURE_CONNECTOR, 'synthetic/absent')));
    expect(b.code).toBe(1);
    expect(b.record).toMatchObject({ results: { status: 'failed', error: { code: 'SECRET_MISSING' } } });
    expect(seen.opened).toBe(before);
    expect(await src.keys(`${src.at(tenant)}/`)).toEqual([]);
  });

  it('usage: --from needs --to (exit 2); a source missing from the engagement config is a configuration error (exit 2)', async () => {
    const tenant = crypto.randomUUID();
    const u = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws', '--from', '2024-09'], env(engagementFile(tenant)));
    expect(u.code).toBe(2);
    await provision(tenant);
    const m = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant, FIXTURE_CONNECTOR, 'synthetic/key', 'some-other-source')));
    expect(m.code).toBe(2);
    expect(m.record).toMatchObject({ results: { error: { code: 'SOURCE_NOT_IN_ENGAGEMENT_CONFIG' } } });
  });

  // Review rv149 (M3): a disabled source never contacts the provider: no retriever opened, no original written.
  it('a disabled source is refused before the connector runs', async () => {
    const tenant = crypto.randomUUID();
    const sid = await provision(tenant);
    await t.db.pool.query(`UPDATE ratio.sources SET enabled = false WHERE id = $1`, [sid]);
    const before = seen.opened;
    const r = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant)));
    expect(r.code).toBe(1);
    expect(r.record).toMatchObject({ pass: false, results: { error: { code: 'SOURCE_DISABLED' } } });
    expect(seen.opened).toBe(before);
    expect((await evidence.keys()).filter((k) => k.includes(`connector-originals/${tenant}/`))).toEqual([]);
  });

  // Review rv149 (M2): the config is bound to the tenant it names; a mismatch publishes nothing anywhere.
  it('an engagement config naming another tenant is refused (exit 2) before the connector runs', async () => {
    const tenant = crypto.randomUUID();
    await provision(tenant);
    const before = seen.opened;
    const r = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(crypto.randomUUID())));
    expect(r.code).toBe(2);
    expect(r.record).toMatchObject({ results: { status: 'failed', error: { code: 'ENGAGEMENT_TENANT_MISMATCH' } } });
    expect(seen.opened).toBe(before);
    expect(await src.keys(`${src.at(tenant)}/`)).toEqual([]);
  });

  // Review rv149 (M1): the secret (and each component of a structured secret) never reaches stdout,
  // stderr or the staged manifest, even when the connector puts it in a delivery id or object key.
  it('a secret in a delivery id or object key is redacted everywhere it is printed or stored', async () => {
    const tenant = crypto.randomUUID();
    await provision(tenant);
    const structured = JSON.stringify({ client_id: 'SYNTHETIC-client-7c21', private_key: SECRET });
    fs.writeFileSync(path.join(tmp, 'secrets', 'synthetic', 'json'), structured, { mode: 0o600 });
    Object.assign(serve, { delivery: `d-${SECRET}-SYNTHETIC-client-7c21`, key: `k?token=${SECRET}` });
    try {
      const r = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant, FIXTURE_CONNECTOR, 'synthetic/json')));
      expect(r.code).toBe(0);
      const manifestKey = (await src.keys(`${src.at(tenant)}/`)).find((k) => k.includes('/metadata/BILLING_PERIOD=2024-09/'))!;
      const manifest = (await src.get(manifestKey)).toString('utf8');
      expect(manifest).toContain('[redacted]');
      for (const text of [...r.out, ...r.err, manifest]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('SYNTHETIC-client-7c21');
      }
    } finally {
      Object.assign(serve, { delivery: 'sample-2024-09', key: 'focus_sample.csv' });
    }
  });

  // Review rv149 (M5): fetch maps failures to the same exit codes as import-file.
  it('exit codes: another import in progress is 4; a changed published period is 3 (refused, nothing written)', async () => {
    const tenant = crypto.randomUUID();
    const sid = await provision(tenant);
    const c = await t.db.pool.connect();
    await c.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`ratio.import:${tenant}:${sid}`]);
    try {
      const busy = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant)));
      expect(busy.code).toBe(4);
      expect(busy.record).toMatchObject({ exitCode: 4, results: { deliveries: [{ code: 'ALREADY_RUNNING' }] } });
    } finally {
      await c.query('SELECT pg_advisory_unlock_all()');
      c.release();
    }
    expect((await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant)))).code).toBe(0);
    // Drop one 2024-09 row: the delivery now changes the published period.
    const lines = SAMPLE.toString('utf8').split('\n');
    const header = lines[0].split(',');
    const iStart = header.indexOf('BillingPeriodStart');
    const drop = lines.findIndex((l, i) => i > 0 && l.split(',').length === header.length && l.split(',')[iStart].startsWith('2024-09-01'));
    expect(drop).toBeGreaterThan(0);
    serve.bytes = Buffer.from(lines.filter((_, i) => i !== drop).join('\n'), 'utf8');
    try {
      const refused = await cli(['fetch', '--tenant', tenant, '--source', 'managed-aws'], env(engagementFile(tenant)));
      expect(refused.code).toBe(3);
      expect(refused.record).toMatchObject({ exitCode: 3, results: { deliveries: [{ outcome: 'refused', code: 'PERIOD_ALREADY_PUBLISHED' }] } });
    } finally {
      serve.bytes = SAMPLE;
    }
  });
});
