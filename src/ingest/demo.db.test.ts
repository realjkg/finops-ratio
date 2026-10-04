// The owner's eight acceptance demonstrations (BOUNDARY v2), automated against
// the COMMITTED synthetic fixture, real Postgres, real S3 (SeaweedFS), real
// LOGIN roles, the CLI in-process and — for the kill test — a real child
// process terminated with SIGKILL. Synthetic data only: this demonstrates the
// mechanism, not a real provider export.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './db/testing/harness';
import { createWorkerPool } from './worker/db';
import { runSync } from './worker/pipeline';
import { S3FocusExportSource } from './sources/s3/S3FocusExportSource';
import { S3EvidenceStore } from './evidence/S3EvidenceStore';
import { FIXTURE_LOCATION, generateSyntheticExport } from './fixtures/syntheticFocus';
import { batchesOf, checkpointOf, connect, createLogin, expireLeases, publishedTotals, runsOf, seedTenantSource, type Login, type SeededSource } from './testing/db';
import { createTestBucket, requireTestS3Endpoint, testS3Env, type TestBucket } from './testing/s3';

// Fail the whole file at collection time (not "skipped" tests) when no S3 endpoint is configured.
requireTestS3Endpoint();
import { cli, committedControlTotals, committedObjects, COMMITTED_FIXTURE_DIR, spawnCli } from './testing/cli';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let db: TestDatabase;
let worker: Login;
let reader: Login;
let workerPool: Pool;
let evidence: TestBucket;
const buckets: TestBucket[] = [];

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  worker = await createLogin(db, ['ratio_worker']);
  reader = await createLogin(db, ['ratio_reader']);
  workerPool = createWorkerPool(worker.url, { max: 4 });
  evidence = await createTestBucket('ev');
});
afterAll(async () => {
  await workerPool?.end();
  for (const b of buckets) await b.destroy();
  await evidence?.destroy();
  await worker?.drop();
  await reader?.drop();
  await db?.close();
});

const CONTROL = committedControlTotals();
const expected = (variant: 'base' | 'restatement') =>
  Object.fromEntries(Object.entries(CONTROL[variant]).map(([p, v]) => [p, { rows: v.rowCount, total: v.billedTotal }]));
const env = (extra: Record<string, string> = {}) => ({ RATIO_DATABASE_URL: worker.url, ...testS3Env(evidence), ...extra });
/**
 * Seeds the COMMITTED data files (byte-for-byte) under the scope's root. The
 * manifests list bucket-relative keys, so they are regenerated for the root
 * prefix (identical otherwise — syntheticFocus.test.ts proves committed
 * manifests equal the generator's).
 */
async function seedCommitted(bucket: TestBucket, variant: 'base' | 'restatement'): Promise<void> {
  await bucket.putUnderRoot(committedObjects(variant).filter((o) => o.key.endsWith('.csv.gz')));
  const manifests = generateSyntheticExport({ variant, prefix: bucket.at(FIXTURE_LOCATION.prefix) }).objects.filter((o) => o.key.endsWith('Manifest.json'));
  await bucket.putAll(manifests);
}
/** Source location of the committed fixture once uploaded under the scope's root. */
const fixtureLocation = (bucket: TestBucket) => ({ bucket: bucket.name, prefix: bucket.at(FIXTURE_LOCATION.prefix), exportName: FIXTURE_LOCATION.exportName });

async function fixtureSource(): Promise<{ s: SeededSource; bucket: TestBucket }> {
  const bucket = await createTestBucket('demo');
  buckets.push(bucket);
  await seedCommitted(bucket, 'base');
  const s = await seedTenantSource(db.pool, { config: { layout: 'aws-data-exports', ...fixtureLocation(bucket) } });
  return { s, bucket };
}

/** What a genuine ratio_reader LOGIN sees through the published view. */
async function readerView(tenantId: string | null): Promise<{ rows: number; total: string | null; batches: string[] }> {
  const c = await connect(reader.url);
  try {
    await c.query('BEGIN');
    if (tenantId !== null) await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [tenantId]);
    const r = await c.query(`SELECT count(*)::int AS n, sum(billed_cost)::text AS total, coalesce(array_agg(DISTINCT batch_id::text), '{}') AS b FROM ratio.cost_facts_published`);
    await c.query('COMMIT');
    return { rows: r.rows[0].n, total: r.rows[0].total, batches: (r.rows[0].b as string[]).sort() };
  } finally {
    await c.end();
  }
}

const sync = (s: SeededSource, extra: Record<string, string> = {}) => cli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], env(extra));

describe('owner acceptance demonstration (synthetic fixture)', () => {
  it('demo 1: fixture ingested; original bytes stored with hash (re-hashing the evidence object)', async () => {
    const { s } = await fixtureSource();
    const r = await sync(s);
    expect(r.code).toBe(0);
    const arts = await db.pool.query(
      `SELECT a.artifact_name, a.sha256, a.byte_size::int AS size, a.evidence_key, b.billing_period::text AS period
       FROM ratio.ingest_artifacts a JOIN ratio.ingest_batches b ON b.tenant_id = a.tenant_id AND b.id = a.batch_id
       WHERE a.tenant_id = $1 ORDER BY 1`,
      [s.tenantId],
    );
    const committedData = committedObjects('base').filter((o) => o.key.endsWith('.csv.gz'));
    expect(arts.rows).toHaveLength(committedData.length);
    for (const a of arts.rows) {
      const stored = await evidence.get(evidence.at(a.evidence_key));
      expect(sha(stored)).toBe(a.sha256);
      expect(a.evidence_key).toBe(`evidence/${s.tenantId}/${s.sourceId}/${a.sha256}`);
      expect(stored.length).toBe(a.size);
      const ym = a.period.slice(0, 7);
      const original = fs.readFileSync(
        path.join(COMMITTED_FIXTURE_DIR, 'base', FIXTURE_LOCATION.prefix, FIXTURE_LOCATION.exportName, 'data', `BILLING_PERIOD=${ym}`, a.artifact_name),
      );
      expect(stored.equals(original)).toBe(true);
    }
  });

  it('demo 2: the parser creates a staged revision that nobody can read until it is published', async () => {
    const { s, bucket } = await fixtureSource();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let reached!: (info: { batchId: string; rowsInserted: number }) => void;
    const atChunk = new Promise<{ batchId: string; rowsInserted: number }>((r) => (reached = r));
    const run = runSync({
      pool: workerPool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new S3FocusExportSource({ client: bucket.client, location: fixtureLocation(bucket) }),
      evidence: new S3EvidenceStore({ client: evidence.client, bucket: evidence.name, prefix: evidence.root }),
      mode: 'sync',
      settings: { limits: { insertChunkRows: 10 } },
      hooks: {
        afterChunk: async (info) => {
          if (info.rowsInserted === 10) {
            reached(info);
            await released;
          }
        },
      },
    });
    const info = await atChunk;
    const b = (await batchesOf(db.pool, s.tenantId, s.sourceId)).find((x) => x.id === info.batchId)!;
    expect(b.status).toBe('staged');
    const facts = await db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`, [s.tenantId, b.id]);
    expect(facts.rows[0].n).toBe(10);
    expect(await readerView(s.tenantId)).toEqual({ rows: 0, total: null, batches: [] });
    release();
    expect((await run).status).toBe('succeeded');
    expect(await publishedTotals(db.pool, s.tenantId, s.sourceId)).toEqual(expected('base'));
  });

  it('demo 3: validation passes (reconciled) or yields an inspectable quarantine', async () => {
    const { s, bucket } = await fixtureSource();
    expect((await sync(s)).code).toBe(0);
    expect((await batchesOf(db.pool, s.tenantId, s.sourceId)).map((b) => [b.period, b.status, b.reconciliation])).toEqual([
      ['2026-07-01', 'published', 'reconciled'],
      ['2026-08-01', 'published', 'reconciled'],
    ]);
    await bucket.putAll(generateSyntheticExport({ variant: 'corrupt', prefix: bucket.at(FIXTURE_LOCATION.prefix) }).objects);
    const bad = await sync(s);
    expect(bad.code).toBe(1);
    const q = (await batchesOf(db.pool, s.tenantId, s.sourceId)).find((b) => b.status === 'quarantined')!;
    expect(q.period).toBe('2026-08-01');
    const show = await cli(['quarantine', 'show', '--tenant', s.tenantId, '--batch', q.id, '--json'], env());
    expect(show.code).toBe(0);
    const res = show.record.results as {
      batch: { status: string; quarantineReason: string; artifacts: Array<{ sha256: string; evidenceKey: string }> };
      errors: Array<{ artifactSha256: string; rowOrdinal: string; column: string; code: string; message: string }>;
    };
    expect(res.batch.status).toBe('quarantined');
    expect(res.batch.quarantineReason).toContain('UNPARSEABLE_NUMBER');
    expect(res.errors[0]).toMatchObject({ column: 'BilledCost', code: 'UNPARSEABLE_NUMBER' });
    expect(Number(res.errors[0].rowOrdinal)).toBeGreaterThan(0);
    expect(res.batch.artifacts.map((a) => a.sha256)).toContain(res.errors[0].artifactSha256);
    expect(await publishedTotals(db.pool, s.tenantId, s.sourceId)).toEqual(expected('base'));
  });

  it('demo 4: reprocessing the same artifacts yields no duplicate published facts', async () => {
    const { s } = await fixtureSource();
    expect((await sync(s)).code).toBe(0);
    expect((await sync(s)).code).toBe(0);
    expect((await cli(['replay', '--tenant', s.tenantId, '--source', s.sourceKey, '--period', '2026-07'], env())).code).toBe(0);
    expect((await cli(['backfill', '--tenant', s.tenantId, '--source', s.sourceKey, '--from', '2026-07', '--to', '2026-08'], env())).code).toBe(0);
    const batches = await batchesOf(db.pool, s.tenantId, s.sourceId);
    expect(batches.map((b) => [b.period, b.status])).toEqual([
      ['2026-07-01', 'published'],
      ['2026-08-01', 'published'],
    ]);
    expect(await publishedTotals(db.pool, s.tenantId, s.sourceId)).toEqual(expected('base'));
    const v = await readerView(s.tenantId);
    const totalRows = Object.values(CONTROL.base).reduce((a, x) => a + x.rowCount, 0);
    expect(v.rows).toBe(totalRows);
  });

  it('demo 5 + 6: SIGKILL mid-load exposes no partial data; restart fails visibly before lease expiry and completes after, without advancing the checkpoint in between', async () => {
    const { s, bucket } = await fixtureSource();
    expect((await sync(s)).code).toBe(0);
    const baseView = await readerView(s.tenantId);
    const cpBefore = await checkpointOf(db.pool, s.tenantId, s.sourceId);
    await seedCommitted(bucket, 'restatement');

    const child = spawnCli(['sync', '--tenant', s.tenantId, '--source', s.sourceKey], {
      ...env(),
      NODE_ENV: 'test',
      RATIO_TEST_PAUSE_AFTER_ROWS: '20',
      RATIO_INSERT_CHUNK_ROWS: '10',
    });
    let staged: Array<{ id: string }>;
    try {
      const paused = await child.waitForEvent('test.paused');
      expect(Number(paused.rowsInserted)).toBeGreaterThanOrEqual(20);
      staged = (await batchesOf(db.pool, s.tenantId, s.sourceId)).filter((b) => b.status === 'staged');
      expect(staged).toHaveLength(1);
      const stagedRows = await db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`, [s.tenantId, staged[0].id]);
      expect(stagedRows.rows[0].n).toBeGreaterThanOrEqual(20);
      expect(await readerView(s.tenantId)).toEqual(baseView);

      expect(child.child.kill('SIGKILL')).toBe(true);
      expect(await child.exited).toEqual({ code: null, signal: 'SIGKILL' });
    } finally {
      // A failed assertion above must not leave the paused worker running (it holds a lease and a connection).
      if (child.child.exitCode === null && child.child.signalCode === null) {
        child.child.kill('SIGKILL');
        await child.exited;
      }
    }

    // demo 5: nothing partial is visible; previous revision intact; checkpoint untouched.
    expect(await readerView(s.tenantId)).toEqual(baseView);
    expect(await publishedTotals(db.pool, s.tenantId, s.sourceId)).toEqual(expected('base'));
    expect(await checkpointOf(db.pool, s.tenantId, s.sourceId)).toEqual(cpBefore);
    const killed = (await runsOf(db.pool, s.tenantId, s.sourceId)).at(-1)!;
    expect(killed.status).toBe('running');

    // demo 6a: immediate restart fails visibly (lease still held by the dead process); nothing changes.
    const early = await sync(s);
    expect(early.code).toBe(4);
    expect(early.record.pass).toBe(false);
    expect(await checkpointOf(db.pool, s.tenantId, s.sourceId)).toEqual(cpBefore);
    expect(await readerView(s.tenantId)).toEqual(baseView);

    // demo 6b: after the lease expires the restart completes safely.
    await expireLeases(db.pool, s.tenantId, s.sourceId);
    const late = await sync(s);
    expect(late.code).toBe(0);
    expect(await publishedTotals(db.pool, s.tenantId, s.sourceId)).toEqual(expected('restatement'));
    const runs = await runsOf(db.pool, s.tenantId, s.sourceId);
    expect(runs.find((r) => r.id === killed.id)).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED' });
    expect((await batchesOf(db.pool, s.tenantId, s.sourceId)).map((b) => b.id)).not.toContain(staged[0].id);
    expect((await checkpointOf(db.pool, s.tenantId, s.sourceId))?.['2026-07-01']).not.toEqual(cpBefore?.['2026-07-01']);
  });

  it('demo 7: the app (ratio_reader) reads the latest accepted revision; staged and quarantined data are inaccessible', async () => {
    const { s, bucket } = await fixtureSource();
    expect((await sync(s)).code).toBe(0);
    await seedCommitted(bucket, 'restatement');
    expect((await sync(s)).code).toBe(0);
    const latest = await readerView(s.tenantId);
    const totalRestated = Object.values(CONTROL.restatement).reduce((a, x) => a + x.rowCount, 0);
    expect(latest.rows).toBe(totalRestated);
    const published = (await batchesOf(db.pool, s.tenantId, s.sourceId)).filter((b) => b.status === 'published').map((b) => b.id).sort();
    expect(latest.batches).toEqual(published);

    await bucket.putAll(generateSyntheticExport({ variant: 'corrupt', prefix: bucket.at(FIXTURE_LOCATION.prefix) }).objects);
    expect((await sync(s)).code).toBe(1);
    expect(await readerView(s.tenantId)).toEqual(latest);

    const c = await connect(reader.url);
    try {
      for (const table of ['cost_facts', 'ingest_batches', 'ingest_validation_errors', 'ingest_artifacts', 'sync_runs', 'period_publications']) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [s.tenantId]);
        await expect(c.query(`SELECT * FROM ratio.${table} LIMIT 1`), table).rejects.toMatchObject({ code: '42501' });
        await c.query('ROLLBACK');
      }
    } finally {
      await c.end();
    }
    const quarantined = (await batchesOf(db.pool, s.tenantId, s.sourceId)).filter((b) => b.status === 'quarantined');
    expect(quarantined).toHaveLength(1);
    expect(latest.batches).not.toContain(quarantined[0].id);
  });

  it('demo 8: tenant-bound access fails closed', async () => {
    const { s: a } = await fixtureSource();
    const { s: b } = await fixtureSource();
    expect((await sync(a)).code).toBe(0);
    expect((await sync(b)).code).toBe(0);

    expect(await readerView(null)).toEqual({ rows: 0, total: null, batches: [] });
    const viewB = await readerView(b.tenantId);
    const aBatches = (await batchesOf(db.pool, a.tenantId, a.sourceId)).map((x) => x.id);
    for (const id of aBatches) expect(viewB.batches).not.toContain(id);

    const wc = await connect(worker.url);
    try {
      const none = await wc.query(`SELECT (SELECT count(*) FROM ratio.cost_facts) + (SELECT count(*) FROM ratio.ingest_batches) + (SELECT count(*) FROM ratio.sources) AS n`);
      expect(Number(none.rows[0].n)).toBe(0);
      await wc.query('BEGIN');
      await wc.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [b.tenantId]);
      const cross = await wc.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1`, [a.tenantId]);
      expect(cross.rows[0].n).toBe(0);
      await expect(wc.query(`UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = now() WHERE tenant_id = $1 RETURNING id`, [a.tenantId])).resolves.toMatchObject({ rowCount: 0 });
      await wc.query('ROLLBACK');
    } finally {
      await wc.end();
    }

    // The CLI for tenant B cannot reach tenant A's source (a different source key only A has).
    const onlyA = await seedTenantSource(db.pool, { tenantId: a.tenantId, sourceKey: 'only-in-a', config: { layout: 'aws-data-exports', bucket: 'unused-bucket', prefix: FIXTURE_LOCATION.prefix, exportName: FIXTURE_LOCATION.exportName } });
    const crossCli = await cli(['sync', '--tenant', b.tenantId, '--source', onlyA.sourceKey], env());
    expect(crossCli.code).toBe(1);
    expect(crossCli.out.concat(crossCli.err).join('\n')).toContain('SOURCE_NOT_FOUND');
    const malformed = await cli(['sync', '--tenant', `${a.tenantId}' OR '1'='1`, '--source', a.sourceKey], env());
    expect(malformed.code).toBe(2);
    expect(await publishedTotals(db.pool, a.tenantId, a.sourceId)).toEqual(expected('base'));
  });
});
