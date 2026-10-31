// Report facts end to end against a real Postgres 16 and S3 (SeaweedFS):
//   - the public FOCUS 1.0 sample imported by the REAL operator path
//     (`source add` + `import-file`, worker CLI in process), read back through
//     GET /api/v1/reports/facts as a ratio_reader login: exact values equal
//     fixtures/focus-1.0-sample/control-totals.json ("1k", AWS 2024-09);
//   - SYNTHETIC tenants published by the real worker library: restatement
//     (superseded rows never counted), a quarantined period (N/A, never 0),
//     two currencies (never summed), rows without EffectiveCost (partial),
//     two sources (never added together), tenant isolation.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { workerTestDb, type WorkerTestDb } from '../../ingest/testing/workerSetup';
import { createLogin, seedTenantSource, type Login } from '../../ingest/testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from '../../ingest/testing/s3';
import { cli } from '../../ingest/testing/cli';
import { runSync } from '../../ingest/worker/pipeline';
import { FakeFocusSource } from '../../ingest/sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../../ingest/evidence/MemoryEvidenceStore';
import { csvGz, focusRow, rowsOf } from '../../ingest/testing/focusCsv';
import { createReportFactsRoute } from './reportFactsRoute';
import { closeReaderPools } from './readerPool';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';
import { NA_REASONS, type ReportFacts } from '../../reports/reportFacts';

requireTestS3Endpoint();

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-1.0-sample');
const SAMPLE_FILE = path.join(FIXTURE_DIR, 'focus_sample.csv');
const CONTROLS = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'control-totals.json'), 'utf8'))['1k'];
const AWS_SEP = CONTROLS.totals.find((x: { billingPeriod: string }) => x.billingPeriod === '2024-09-01');
const NOW = new Date('2026-10-30T12:00:00.000Z');

let t: WorkerTestDb;
let owner: Login;
let reader: Login;
let evidence: TestBucket;
let drop: TestBucket;
const A = { tenant: crypto.randomUUID(), sourceId: '', batchId: '', publishedAt: '', artifactSha256: '' };
const C = { tenant: '', sourceId: '' };
const D = { tenant: crypto.randomUUID() };

async function sync(tenantId: string, sourceKey: string, periods: ConstructorParameters<typeof FakeFocusSource>[0], then?: ConstructorParameters<typeof FakeFocusSource>[0]) {
  const source = new FakeFocusSource(periods);
  const evidenceStore = new MemoryEvidenceStore();
  await runSync({ pool: t.pool, tenantId, sourceKey, source, evidence: evidenceStore, mode: 'sync' });
  if (then) {
    source.setPeriods(then);
    await runSync({ pool: t.pool, tenantId, sourceKey, source, evidence: evidenceStore, mode: 'sync' });
  }
}

beforeAll(async () => {
  t = await workerTestDb();
  owner = await createLogin(t.db, ['ratio_owner']);
  reader = await createLogin(t.db, ['ratio_reader']);
  evidence = await createTestBucket('ev');
  drop = await createTestBucket('drop');

  // Tenant A: the public sample through `source add` + `import-file` (no --period: 2024-10 holds
  // one Oracle row only and is quarantined PROVIDER_MISMATCH by the existing provider policy).
  const env = { RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: owner.url, ...testS3Env(evidence) };
  expect((await cli(['source', 'add', '--tenant', A.tenant, '--key', 'focus-aws', '--providers', 'AWS', '--bucket', drop.name, '--prefix', drop.at(A.tenant)], env)).code).toBe(0);
  await cli(['import-file', '--tenant', A.tenant, '--source', 'focus-aws', '--file', SAMPLE_FILE], env);
  // Ground truth as the test superuser: the publication pointer and the staged artifact the facts came from.
  const b = await t.db.pool.query(
    `SELECT p.source_id::text AS sid, p.batch_id::text AS bid, to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, a.sha256
       FROM ratio.period_publications p JOIN ratio.ingest_artifacts a ON a.tenant_id = p.tenant_id AND a.batch_id = p.batch_id WHERE p.tenant_id = $1`,
    [A.tenant],
  );
  expect(b.rows).toHaveLength(1);
  Object.assign(A, { sourceId: b.rows[0].sid, batchId: b.rows[0].bid, publishedAt: b.rows[0].at, artifactSha256: b.rows[0].sha256 });

  // Tenant C (SYNTHETIC): 2026-06 restated once (first set superseded); 2026-04 quarantined (bad
  // amount); 2026-05 quarantined (one batch may not mix billing currencies: MIXED_BILLING_CURRENCY).
  const s = await seedTenantSource(t.db.pool);
  Object.assign(C, { tenant: s.tenantId, sourceId: s.sourceId });
  const P = '2026-06-01';
  const final = [
    focusRow(P, { BilledCost: '0.10', EffectiveCost: '0.08', ResourceId: 'u1' }),
    focusRow(P, { BilledCost: '0.20', EffectiveCost: '', ResourceId: 'u2' }),
    focusRow(P, { BilledCost: '-0.05', EffectiveCost: '-0.05', ChargeCategory: 'Credit', ResourceId: 'c1' }),
  ];
  const april = [
    { billingPeriod: '2026-04-01', artifacts: [{ name: 'apr/a.csv.gz', bytes: csvGz([focusRow('2026-04-01', { BilledCost: 'not-a-number' })]) }] },
    { billingPeriod: '2026-05-01', artifacts: [{ name: 'may/a.csv.gz', bytes: csvGz([focusRow('2026-05-01', { ResourceId: 'm1' }), focusRow('2026-05-01', { BillingCurrency: 'EUR', ResourceId: 'm2' })]) }] },
  ];
  await sync(C.tenant, s.sourceKey, [...april, { billingPeriod: P, artifacts: [{ name: 'jun/a.csv.gz', bytes: csvGz(rowsOf(P, 4, '9.99', 'old')) }] }], [
    ...april,
    { billingPeriod: P, artifacts: [{ name: 'jun/b.csv.gz', bytes: csvGz(final) }] },
  ]);

  // Tenant D (SYNTHETIC): two sources publish the same period, one in USD and one in EUR.
  for (const [key, currency] of [['focus-one', 'USD'], ['focus-two', 'EUR']]) {
    const sd = await seedTenantSource(t.db.pool, { tenantId: D.tenant, sourceKey: key });
    const rows = rowsOf('2026-07-01', 2, '1.50', key).map((r) => ({ ...r, BillingCurrency: currency }));
    await sync(sd.tenantId, sd.sourceKey, [{ billingPeriod: '2026-07-01', artifacts: [{ name: `${key}.csv.gz`, bytes: csvGz(rows) }] }]);
  }
}, 180_000);

afterAll(async () => {
  await closeReaderPools();
  await owner?.drop();
  await reader?.drop();
  await t?.close();
  await evidence?.destroy();
  await drop?.destroy();
});
beforeEach(() => {
  for (const k of ['info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function facts(tenantId: string, period: string): Promise<ReportFacts> {
  const route = createReportFactsRoute({
    env: { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: tenantId, RATIO_READER_DATABASE_URL: reader.url },
    logger: () => undefined,
    now: () => NOW,
  });
  const res = await call(route, makeReq({ headers: bearer(), query: { period } }));
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body as ReportFacts;
}

describe('public FOCUS 1.0 sample (AWS 2024-09) imported through import-file', () => {
  it('billed, effective, credits and row count equal control-totals.json exactly; one source, so per-currency totals are combined', async () => {
    const f = await facts(A.tenant, '2024-09');
    expect(f.totals).toEqual({
      status: 'available',
      value: [
        {
          currency: 'USD',
          rowCount: AWS_SEP.rowCount,
          billedCost: AWS_SEP.billedCost,
          effectiveCost: { status: 'available', value: AWS_SEP.effectiveCost },
          credits: { status: 'available', value: { rowCount: '1', billedCost: '-2.61370000000', effectiveCost: { status: 'available', value: '-3.00000000000' } } },
          adjustments: { status: 'not_available', reason: NA_REASONS.noAdjustmentRows },
          byChargeCategory: [
            { chargeCategory: 'Credit', rowCount: '1', billedCost: '-2.61370000000', effectiveCost: { status: 'available', value: '-3.00000000000' } },
            { chargeCategory: 'Usage', rowCount: '941', billedCost: '20.62033861840', effectiveCost: { status: 'available', value: '16.00000000000' } },
          ],
        },
      ],
    });
  });

  it('identifies the import (source id, batch, staged artifact sha256), the period, freshness and the unavailable trust fields', async () => {
    const f = await facts(A.tenant, '2024-09');
    expect(f.sources).toHaveLength(1);
    expect(f.sources[0]).toMatchObject({ sourceId: A.sourceId, providers: ['AWS'], focusVersions: ['1.0'] });
    expect(f.sources[0].batches).toEqual([
      expect.objectContaining({ batchId: A.batchId, status: 'published', publishedAt: A.publishedAt, rowCount: AWS_SEP.rowCount, artifacts: [{ sha256: A.artifactSha256, rowCount: AWS_SEP.rowCount }] }),
    ]);
    expect(f.sources[0].batches[0].reconciliation).toEqual({ status: 'not_available', reason: NA_REASONS.batchStatus });
    expect(f.period).toMatchObject({ month: '2024-09', state: 'closed', completeness: { status: 'available', value: 'charge periods cover the whole month' } });
    expect(f.freshness).toEqual({ asOf: NOW.toISOString(), latestPublishedAt: { status: 'available', value: A.publishedAt }, dataThrough: { status: 'available', value: '2024-10-01T00:00:00.000000Z' } });
    expect(f.currency.inData).toEqual(['USD']);
  });

  it('2024-10 (quarantined: Oracle row only) is N/A with the reason, never zero spend', async () => {
    const f = await facts(A.tenant, '2024-10');
    expect(f.sources).toEqual([]);
    expect(f.totals).toEqual({ status: 'not_available', reason: NA_REASONS.noPublished });
    expect(f.coverageGaps.map((g) => g.code)).toContain('NO_PUBLISHED_BATCH');
    expect(JSON.stringify(f)).not.toMatch(/"(billedCost|value|rowCount)":"0(\.0+)?"/);
  });
});

describe('SYNTHETIC tenants through the real worker library', () => {
  it('restated period: only the latest published rows; missing EffectiveCost is partial; Credit separate', async () => {
    const f = await facts(C.tenant, '2026-06');
    expect(f.sources.map((s) => s.sourceId)).toEqual([C.sourceId]);
    expect(f.sources[0].currencies).toHaveLength(1);
    expect(f.sources[0].currencies[0]).toMatchObject({
      currency: 'USD',
      rowCount: '3',
      billedCost: '0.25',
      effectiveCost: { status: 'partial', value: '0.03', rowsWithoutEffectiveCost: '1', reason: NA_REASONS.effectivePartial },
      credits: { status: 'available', value: { rowCount: '1', billedCost: '-0.05', effectiveCost: { status: 'available', value: '-0.05' } } },
    });
    expect(f.period.completeness).toEqual({ status: 'available', value: 'partial: charge periods do not cover the whole month' });
    expect(f.coverageGaps.map((g) => g.code)).toEqual(expect.arrayContaining(['EFFECTIVE_PARTIAL', 'PERIOD_PARTIAL']));
    const text = JSON.stringify(f);
    expect(text).not.toContain('9.99'); // the superseded rows
    expect(f.totals.status).toBe('available');
  });

  it('quarantined periods (bad amount; mixed currencies) are N/A, and another tenant never sees this tenant (or A) data', async () => {
    expect((await facts(C.tenant, '2026-04')).totals).toEqual({ status: 'not_available', reason: NA_REASONS.noPublished });
    expect((await facts(C.tenant, '2026-05')).totals).toEqual({ status: 'not_available', reason: NA_REASONS.noPublished });
    expect((await facts(C.tenant, '2024-09')).sources).toEqual([]);
    expect((await facts(A.tenant, '2026-06')).sources).toEqual([]);
  });

  it('two published sources in two currencies: listed separately, never added together', async () => {
    const f = await facts(D.tenant, '2026-07');
    expect(f.sources.map((s) => s.currencies.map((c) => [c.currency, c.billedCost]))).toEqual(expect.arrayContaining([[['USD', '3.00']], [['EUR', '3.00']]]));
    expect(f.currency.inData).toEqual(['EUR', 'USD']);
    expect(f.totals).toEqual({ status: 'not_available', reason: NA_REASONS.multiSource });
    expect(JSON.stringify(f)).not.toContain('"6.00"');
  });
});
