// Worker CLI end-to-end: real Postgres (as a ratio_worker login), real S3
// (SeaweedFS), synthetic fixture. Evidence records, exit codes, redaction.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSyntheticExport, FIXTURE_LOCATION } from './fixtures/syntheticFocus';
import { workerTestDb, type WorkerTestDb } from './testing/workerSetup';
import { batchesOf, publishedTotals, seedTenantSource, type SeededSource } from './testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Env, TEST_S3_SECRET_ACCESS_KEY, type TestBucket } from './testing/s3';

// Fail the whole file at collection time (not "skipped" tests) when no S3 endpoint is configured.
requireTestS3Endpoint();
import { cli } from './testing/cli';
import { csvGz, focusRow } from './testing/focusCsv';

let t: WorkerTestDb;
let evidence: TestBucket;
beforeAll(async () => {
  t = await workerTestDb();
  evidence = await createTestBucket('ev');
});
afterAll(async () => {
  await t?.close();
  await evidence?.destroy();
});

const buckets: TestBucket[] = [];
afterAll(async () => {
  for (const b of buckets) await b.destroy();
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { RATIO_DATABASE_URL: t.login.url, RATIO_MIGRATE_DATABASE_URL: t.db.url, ...testS3Env(evidence), ...extra };
}

/** Synthetic export objects placed under this scope's root in the shared test bucket. */
const fixtureObjects = (bucket: TestBucket, variant: 'base' | 'restatement' | 'corrupt') =>
  generateSyntheticExport({ variant, prefix: bucket.at(FIXTURE_LOCATION.prefix) }).objects;

async function seededExport(variant: 'base' = 'base'): Promise<{ s: SeededSource; bucket: TestBucket }> {
  const bucket = await createTestBucket('src');
  buckets.push(bucket);
  await bucket.putAll(fixtureObjects(bucket, variant));
  const s = await seedTenantSource(t.db.pool, {
    config: { layout: 'aws-data-exports', bucket: bucket.name, prefix: bucket.at(FIXTURE_LOCATION.prefix), exportName: FIXTURE_LOCATION.exportName },
  });
  return { s, bucket };
}

const totalsOf = (variant: 'base' | 'restatement') =>
  Object.fromEntries(Object.entries(generateSyntheticExport({ variant }).totals).map(([p, v]) => [p, { rows: v.rowCount, total: v.billedTotal }]));

describe('worker CLI (real Postgres + S3)', () => {
  it('K1 sync prints one evidence record, logs JSON without row contents or secrets, and appends RATIO_EVIDENCE_FILE (also for migrate)', async () => {
    const { s } = await seededExport();
    const evidenceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-evf-')), 'records.jsonl');
    const e = env({ RATIO_EVIDENCE_FILE: evidenceFile, RATIO_GIT_SHA: 'f'.repeat(40), RATIO_ARTIFACT_DIGEST: 'sha256:' + '1'.repeat(64) });
    const r = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], e);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.record).toMatchObject({
      type: 'ratio.evidence',
      command: 'sync',
      pass: true,
      exitCode: 0,
      gitSha: 'f'.repeat(40),
      artifactDigest: 'sha256:' + '1'.repeat(64),
      args: { tenant: s.tenantId, source: s.sourceKey },
    });
    const periods = (r.record.results as { periods: Array<{ billingPeriod: string; outcome: string }> }).periods;
    expect(periods.map((p) => [p.billingPeriod, p.outcome])).toEqual([
      ['2026-07-01', 'published'],
      ['2026-08-01', 'published'],
    ]);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(totalsOf('base'));
    for (const line of r.err) expect(() => JSON.parse(line)).not.toThrow();
    const all = r.out.concat(r.err).join('\n');
    for (const leak of ['SyntheticCloud', 'Synthetic Compute', TEST_S3_SECRET_ACCESS_KEY, t.login.url]) expect(all).not.toContain(leak);

    const st = await cli(['migrate', '--status', '--json'], e);
    expect(st.code).toBe(0);
    const lines = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.command, l.pass])).toEqual([
      ['sync', true],
      ['migrate', true],
    ]);
    fs.rmSync(path.dirname(evidenceFile), { recursive: true, force: true });
  });

  it('K2 backfill, replay --batch, replay --period and quarantine show via the CLI', async () => {
    const { s, bucket } = await seededExport();
    expect((await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env())).code).toBe(0);

    const bf = await cli(['backfill', '--tenant', s.tenantId, '--source', s.sourceKey, '--from', '2026-07', '--to', '2026-07'], env());
    expect(bf.code).toBe(0);
    expect((bf.record.results as { periods: unknown[] }).periods).toEqual([expect.objectContaining({ billingPeriod: '2026-07-01', outcome: 'unchanged' })]);

    await bucket.putAll(fixtureObjects(bucket, 'restatement'));
    expect((await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env())).code).toBe(0);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(totalsOf('restatement'));
    const jul = (await batchesOf(t.db.pool, s.tenantId, s.sourceId)).filter((b) => b.period === '2026-07-01');
    expect(jul.map((b) => b.status)).toEqual(['superseded', 'published']);

    const back = await cli(['replay', '--tenant', s.tenantId, '--source', s.sourceKey, '--batch', jul[0].id], env());
    expect(back.code).toBe(0);
    expect(back.record.results).toMatchObject({ outcome: 'republished', batchId: jul[0].id });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(totalsOf('base'));

    const re = await cli(['replay', '--tenant', s.tenantId, '--source', s.sourceKey, '--period', '2026-07'], env());
    expect(re.code).toBe(0);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(totalsOf('restatement'));

    await bucket.putAll(fixtureObjects(bucket, 'corrupt'));
    const bad = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env());
    expect(bad.code).toBe(1);
    expect(bad.record.pass).toBe(false);
    const q = (await batchesOf(t.db.pool, s.tenantId, s.sourceId)).find((b) => b.status === 'quarantined')!;
    const show = await cli(['quarantine', 'show', '--tenant', s.tenantId, '--batch', q.id, '--json'], env());
    expect(show.code).toBe(0);
    const res = show.record.results as { batch: { status: string; validationErrorCount: string }; errors: Array<{ code: string; column: string | null; rowOrdinal: string | null; artifactSha256: string }> };
    expect(res.batch.status).toBe('quarantined');
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]).toMatchObject({ code: 'UNPARSEABLE_NUMBER', column: 'BilledCost' });
    expect(res.errors[0].artifactSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('K3 a fake source is refused by the CLI outside NODE_ENV=test + RATIO_ALLOW_FAKE_SOURCE=1', async () => {
    const s = await seedTenantSource(t.db.pool, { kind: 'fake', config: { fixture: 'synthetic-base' } });
    for (const extra of [{}, { NODE_ENV: 'test' }, { RATIO_ALLOW_FAKE_SOURCE: '1' }, { NODE_ENV: 'production', RATIO_ALLOW_FAKE_SOURCE: '1' }]) {
      const r = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env(extra as Record<string, string>));
      expect(r.code, JSON.stringify(extra)).toBe(1);
      expect(r.out.concat(r.err).join('\n')).toContain('FAKE_SOURCE_NOT_ALLOWED');
    }
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);
    const ok = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env({ NODE_ENV: 'test', RATIO_ALLOW_FAKE_SOURCE: '1' }));
    expect(ok.code).toBe(0);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(totalsOf('base'));
  });

  it('K4 exit 4 while another run holds a live lease; S3 failures exit 1 with secrets redacted everywhere', async () => {
    const { s } = await seededExport();
    await t.db.pool.query(
      `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, lease_token, lease_expires_at, heartbeat_at)
       VALUES ($1, gen_random_uuid(), $2, 'scheduled', 'running', gen_random_uuid(), now() + interval '1 hour', now())`,
      [s.tenantId, s.sourceId],
    );
    const busy = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env());
    expect(busy.code).toBe(4);
    expect(busy.out.concat(busy.err).join('\n')).toContain('ALREADY_RUNNING');
    await t.db.pool.query(`UPDATE ratio.sync_runs SET status = 'failed', finished_at = now(), lease_token = NULL WHERE tenant_id = $1`, [s.tenantId]);

    const secret = 'S3cretKeyValueThatMustNeverLeak1234567890';
    const down = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env({ RATIO_SOURCE_S3_ENDPOINT: 'http://127.0.0.1:1', RATIO_SOURCE_S3_SECRET_ACCESS_KEY: secret, RATIO_MAX_ATTEMPTS: '1' }));
    expect(down.code).toBe(1);
    expect(down.out.concat(down.err).join('\n')).not.toContain(secret);
    const run = await t.db.pool.query(`SELECT status, error_code, error_detail, stats::text AS stats FROM ratio.sync_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`, [s.tenantId]);
    expect(run.rows[0]).toMatchObject({ status: 'failed', error_code: 'SOURCE_LIST_FAILED' });
    expect(String(run.rows[0].error_detail)).not.toContain(secret);
    expect(String(run.rows[0].stats)).not.toContain(secret);
  });

  it('K5 doctor --json exits 0 when healthy and 1 when not; replay-fixtures --json runs all scenarios in a fresh, retained, synthetic-labelled tenant', async () => {
    const { s } = await seededExport();
    expect((await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env())).code).toBe(0);
    const ok = await cli(['doctor', '--json', '--tenant', s.tenantId], env());
    expect(ok.code).toBe(0);
    expect(ok.record).toMatchObject({ command: 'doctor', pass: true });
    const bad = await cli(['doctor', '--json', '--tenant', s.tenantId], env({ RATIO_DATABASE_URL: t.db.url }));
    expect(bad.code).toBe(1);
    expect(bad.record.pass).toBe(false);

    // Orchestrator decision: no purge/delete path this cycle. Each invocation uses a
    // fresh fixture tenant whose data is left in place and recorded in the evidence.
    const fx = await createTestBucket('fx');
    buckets.push(fx);
    const tenants: string[] = [];
    for (let run = 0; run < 2; run++) {
      const r = await cli(['replay-fixtures', '--json'], env({ RATIO_ENV: 'test', RATIO_REPLAY_FIXTURES_BUCKET: fx.name }));
      const res = r.record.results as {
        tenantId: string;
        tenantSlug: string;
        scenarios: Array<{ name: string; pass: boolean; detail?: unknown }>;
        retained: { tenantId: string; sourcePrefix: string; note: string };
      };
      expect(res.scenarios.map((x) => [x.name, x.pass])).toEqual([
        ['clean_load', true],
        ['idempotent_rerun', true],
        ['restatement_supersession', true],
        ['reconciliation_variance_rejection', true],
        ['crash_mid_load_recovery', true],
        ['zombie_fencing', true],
      ]);
      expect(r.code).toBe(0);
      expect(r.record.pass).toBe(true);
      expect(res.tenantSlug).toMatch(/^fixture-\d{14}-[0-9a-f]{8}$/);
      expect(res.retained.tenantId).toBe(res.tenantId);
      const tenant = await t.db.pool.query(`SELECT slug FROM ratio.tenants WHERE id = $1`, [res.tenantId]);
      expect(tenant.rows).toEqual([{ slug: res.tenantSlug }]);
      const srcs = await t.db.pool.query(`SELECT display_name FROM ratio.sources WHERE tenant_id = $1`, [res.tenantId]);
      expect(srcs.rows.length).toBe(3);
      for (const x of srcs.rows) expect(x.display_name).toMatch(/SYNTHETIC/);
      const facts = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1`, [res.tenantId]);
      expect(facts.rows[0].n).toBeGreaterThan(0);
      expect((await fx.keys(`${res.retained.sourcePrefix}/`)).length).toBeGreaterThan(0);
      tenants.push(res.tenantId);
    }
    expect(new Set(tenants).size).toBe(2);
  });

  it('K6 (M-2) rejected values never appear in the CLI evidence record, logs, error_detail or stats', async () => {
    await t.db.pool.query(`
      CREATE FUNCTION public.s1_cli_poison() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.resource_id LIKE 'clipoison-%' THEN RAISE EXCEPTION 'value % is not allowed here', NEW.resource_id USING ERRCODE = 'P0001'; END IF;
        RETURN NEW;
      END $fn$`);
    await t.db.pool.query(`CREATE TRIGGER s1_cli_poison BEFORE INSERT ON ratio.cost_facts FOR EACH ROW EXECUTE FUNCTION public.s1_cli_poison()`);
    for (const [label, row] of [
      ['year-0000', focusRow('2026-07-01', { ChargePeriodStart: '0000-07-02T00:00:00Z', ResourceId: 'yearzero-CELLVALUE' })],
      ['pg-rejected', focusRow('2026-07-01', { ResourceId: 'clipoison-CELLVALUE' })],
    ] as const) {
      const bucket = await createTestBucket('k6');
      buckets.push(bucket);
      const root = bucket.at('exp/focus-export');
      const dataKey = `${root}/data/BILLING_PERIOD=2026-07/run-1/focus-export-00001.csv.gz`;
      await bucket.put(dataKey, csvGz([row]));
      await bucket.put(`${root}/metadata/BILLING_PERIOD=2026-07/focus-export-Manifest.json`, JSON.stringify({ dataFiles: [dataKey] }));
      const s = await seedTenantSource(t.db.pool, { config: { layout: 'aws-data-exports', bucket: bucket.name, prefix: bucket.at('exp'), exportName: 'focus-export' } });
      const r = await cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env());
      expect(r.code, label).toBe(1);
      const printed = r.out.concat(r.err).join('\n');
      expect(printed, label).not.toContain('CELLVALUE');
      expect(printed, label).not.toContain('0000-07-02');
      expect(printed, label).not.toContain('not allowed here');
      const run = await t.db.pool.query(`SELECT coalesce(error_detail, '') || stats::text AS t FROM ratio.sync_runs WHERE tenant_id = $1`, [s.tenantId]);
      expect(run.rows[0].t, label).not.toContain('CELLVALUE');
      expect(run.rows[0].t, label).not.toContain('not allowed here');
    }
  });
});

