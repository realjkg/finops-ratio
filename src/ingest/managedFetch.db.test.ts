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

const seen: { secret?: string; opened: number; refs: string[]; range?: unknown } = { opened: 0, refs: [] };
const serve: { bytes: Buffer; delivery: string; key: string; list?: Array<{ id: string; period: string; ref: string; bytes: Buffer }>; honorRange?: boolean } = { bytes: SAMPLE, delivery: 'sample-2024-09', key: 'focus_sample.csv' };
// SYNTHETIC fixture retriever, registered in this test process only (never shipped) under an id R1
// names (the worker refuses connectors outside MANAGED_CONNECTORS, like R1): serves the sample file
// as one complete delivery for 2024-09.
const FIXTURE_CONNECTOR = 'opencost';
managedRegistry.register(FIXTURE_CONNECTOR, ({ secret }) => {
  seen.secret = secret?.reveal();
  const r: ManagedRetriever = {
    describe: () => ({ connector: FIXTURE_CONNECTOR, sourceKind: 'focus-export', schemaVersion: '1.0', dataset: 'FOCUS 1.0 sample (public)' }),
    probe: async () => ({}),
    listDeliveries: async (range) => {
      seen.range = range;
      return serve.list
        ? serve.list.filter((d) => !serve.honorRange || !range || (d.period.slice(0, 7) >= range.from && d.period.slice(0, 7) <= range.to)).map((d) => ({ id: d.id, billingPeriod: d.period, completion: 'complete' as const, objects: [{ name: 'part-1', ref: d.ref }] }))
        : [{ id: serve.delivery, billingPeriod: '2024-09-01', completion: 'complete', objects: [{ name: 'part-1', ref: serve.key }] }];
    },
    open: async (ref) => {
      seen.opened += 1;
      seen.refs.push(String(ref));
      const bytes = serve.list?.find((d) => d.ref === ref)?.bytes ?? serve.bytes;
      return { bytes, identity: { kind: 'object', bucket: 'synthetic-provider-bucket', key: String(ref), etag: 'synthetic-etag' } };
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

async function provision(tenant: string, providers = 'AWS') {
  const r = await cli(['source', 'add', '--tenant', tenant, '--key', 'managed-aws', '--providers', providers, '--bucket', src.name, '--prefix', src.at(tenant)], env(engagementFile(tenant)));
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
    const unq = (v: string) => v.replace(/^"|"$/g, '');
    const header = lines[0].split(',').map(unq);
    const iStart = header.indexOf('BillingPeriodStart');
    expect(iStart).toBeGreaterThanOrEqual(0);
    const drop = lines.findIndex((l, i) => i > 0 && l.split(',').length === header.length && unq(l.split(',')[iStart]).startsWith('2024-09-01'));
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

  // Delta review (rv149b BLOCKER): --from/--to reach the runtime and the retriever as 'YYYY-MM', so the
  // --from month itself is in range (it was refused DELIVERY_OUT_OF_RANGE when compared with 'YYYY-MM-01').
  describe('--from/--to through the CLI', () => {
    const sepRows = (drop: boolean) => {
      // The sample with one 2024-09 row removed: a changed delivery for an already-published period.
      if (!drop) return SAMPLE;
      const lines = SAMPLE.toString('utf8').split('\n');
      const unq = (v: string) => v.replace(/^"|"$/g, '');
      const header = lines[0].split(',').map(unq);
      const i = header.indexOf('BillingPeriodStart');
      const d = lines.findIndex((l, n) => n > 0 && l.split(',').length === header.length && unq(l.split(',')[i]).startsWith('2024-09-01'));
      return Buffer.from(lines.filter((_, n) => n !== d).join('\n'), 'utf8');
    };
    const list = (bytes: { aug?: Buffer; sep?: Buffer; oct?: Buffer } = {}) => [
      { id: 'aug', period: '2024-08-01', ref: 'aug', bytes: bytes.aug ?? SAMPLE },
      { id: 'sep', period: '2024-09-01', ref: 'sep', bytes: bytes.sep ?? SAMPLE },
      { id: 'oct', period: '2024-10-01', ref: 'oct', bytes: bytes.oct ?? SAMPLE },
    ];
    // The sample's providers: 2024-09 holds AWS, Microsoft and Oracle rows, 2024-10 one Oracle row.
    const ALL = 'AWS,Microsoft,Oracle';
    const fetchRange = (tenant: string, extra: string[]) => cli(['fetch', '--tenant', tenant, '--source', 'managed-aws', ...extra], env(engagementFile(tenant)));
    const outcomes = (r: { record: { results: Record<string, unknown> } }) => ((r.record.results as { deliveries?: Array<{ delivery: string; outcome: string; code?: string }> }).deliveries ?? []).map((d) => `${d.delivery}:${d.outcome}:${d.code ?? ''}`);
    const reset = () => {
      seen.refs = [];
      seen.range = undefined;
    };

    it('a single-month range (--from X --to X) stages that month and opens nothing else', async () => {
      const tenant = crypto.randomUUID();
      const sid = await provision(tenant, ALL);
      serve.list = list();
      reset();
      try {
        const r = await fetchRange(tenant, ['--from', '2024-09', '--to', '2024-09']);
        expect(outcomes(r)).toEqual(['aug:refused:DELIVERY_OUT_OF_RANGE', 'sep:staged:', 'oct:refused:DELIVERY_OUT_OF_RANGE']);
        expect(seen.range).toEqual({ from: '2024-09', to: '2024-09' });
        expect(seen.refs).toEqual(['sep']);
        expect(Object.keys(await publishedTotals(t.db.pool, tenant, sid))).toEqual(['2024-09-01']);
        expect(r.code).toBe(1); // the two refused deliveries make the run fail; nothing outside the range was opened
      } finally {
        serve.list = undefined;
      }
    });

    it('a multi-month range stages both edge months and refuses the month outside', async () => {
      const tenant = crypto.randomUUID();
      const sid = await provision(tenant, ALL);
      serve.list = list();
      reset();
      try {
        const r = await fetchRange(tenant, ['--from', '2024-09', '--to', '2024-10']);
        expect(outcomes(r)).toEqual(['aug:refused:DELIVERY_OUT_OF_RANGE', 'sep:staged:', 'oct:staged:']);
        expect(seen.refs).toEqual(['sep', 'oct']);
        expect(Object.keys(await publishedTotals(t.db.pool, tenant, sid)).sort()).toEqual(['2024-09-01', '2024-10-01']);
        serve.list = list().filter((d) => d.id !== 'aug');
        reset();
        const ok = await fetchRange(tenant, ['--from', '2024-09', '--to', '2024-10']);
        expect(ok.code).toBe(0);
        expect(outcomes(ok)).toEqual(['sep:staged:', 'oct:staged:']);
      } finally {
        serve.list = undefined;
      }
    });

    it('an inverted or malformed range is a usage error (exit 2) and the connector never runs', async () => {
      const tenant = crypto.randomUUID();
      await provision(tenant, ALL);
      reset();
      const before = seen.opened;
      for (const flags of [['--from', '2024-10', '--to', '2024-09'], ['--from', '2024-9', '--to', '2024-10'], ['--from', '2024-13', '--to', '2024-13'], ['--from', '2024-09-01', '--to', '2024-09'], ['--to', '2024-09']]) {
        const r = await fetchRange(tenant, flags);
        expect(r.code, flags.join(' ')).toBe(2);
      }
      expect(seen.opened).toBe(before);
      expect(seen.range).toBeUndefined();
    });

    it('--restate with a range supersedes only the range: nothing outside it is opened or superseded', async () => {
      const tenant = crypto.randomUUID();
      const sid = await provision(tenant, ALL);
      serve.list = list().filter((d) => d.id !== 'aug');
      try {
        expect((await fetchRange(tenant, [])).code).toBe(0);
        const before = await publishedTotals(t.db.pool, tenant, sid);
        // Every month changes upstream; only 2024-09 is restated. A retriever that honors the range
        // lists only 2024-09, so the run succeeds.
        serve.list = list({ aug: sepRows(true), sep: sepRows(true), oct: sepRows(true) });
        serve.honorRange = true;
        reset();
        const r = await fetchRange(tenant, ['--from', '2024-09', '--to', '2024-09', '--restate']);
        expect(r.code).toBe(0);
        expect(outcomes(r)).toEqual(['sep:staged:']);
        expect(seen.refs).toEqual(['sep']);
        const after = await publishedTotals(t.db.pool, tenant, sid);
        expect(after['2024-09-01'].rows).toBe(before['2024-09-01'].rows - 1);
        expect(after['2024-10-01']).toEqual(before['2024-10-01']);
        const superseded = await t.db.pool.query(`SELECT billing_period::text AS p FROM ratio.ingest_batches WHERE source_id = $1 AND status = 'superseded'`, [sid]);
        expect(superseded.rows.map((x) => String(x.p).slice(0, 7))).toEqual(['2024-09']);
      } finally {
        serve.list = undefined;
        serve.honorRange = false;
      }
    });
  });
});
