// S3FocusExportSource + S3EvidenceStore against a real S3-compatible store
// (SeaweedFS locally). Requires RATIO_TEST_S3_ENDPOINT; fails without it.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3FocusExportSource } from './S3FocusExportSource';
import { S3EvidenceStore } from '../../evidence/S3EvidenceStore';
import { runSync } from '../../worker/pipeline';
import { generateSyntheticExport } from '../../fixtures/syntheticFocus';
import { createTestBucket, requireTestS3Endpoint, type TestBucket } from '../../testing/s3';

// Fail the whole file at collection time (not "skipped" tests) when no S3 endpoint is configured.
requireTestS3Endpoint();
import { workerTestDb, noSleep, type WorkerTestDb } from '../../testing/workerSetup';
import { batchesOf, publishedTotals, seedTenantSource } from '../../testing/db';
import { csvGz, rowsOf } from '../../testing/focusCsv';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
// Every scope lives under its own unique root inside the shared test bucket.
const loc = (b: TestBucket) => ({ bucket: b.name, prefix: b.at('exports/x'), exportName: 'focus-export' });
const DATA = (b: TestBucket, ym: string) => b.at(`exports/x/focus-export/data/BILLING_PERIOD=${ym}/run-1/`);
const META = (b: TestBucket, ym: string) => b.at(`exports/x/focus-export/metadata/BILLING_PERIOD=${ym}/`);
const manifest = (doc: unknown) => Buffer.from(JSON.stringify(doc));

let source: TestBucket;
let evidenceBucket: TestBucket;
let t: WorkerTestDb;
beforeAll(async () => {
  source = await createTestBucket('src');
  evidenceBucket = await createTestBucket('ev');
  t = await workerTestDb();
});
afterAll(async () => {
  await t?.close();
  await source?.destroy();
  await evidenceBucket?.destroy();
});

describe('S3FocusExportSource (AWS Data Exports layout)', () => {
  it('X1 lists periods, honours the range, reads manifests and refuses unsafe or ambiguous ones', async () => {
    const jul = [DATA(source, '2026-07') + 'focus-export-00001.csv.gz', DATA(source, '2026-07') + 'focus-export-00002.csv.gz'];
    const julBytes = [csvGz(rowsOf('2026-07-01', 2)), csvGz(rowsOf('2026-07-01', 3))];
    await source.put(jul[0], julBytes[0]);
    await source.put(jul[1], julBytes[1]);
    await source.put(META(source, '2026-07') + 'focus-export-Manifest.json', manifest({ dataFiles: jul.map((k) => `s3://${source.name}/${k}`), 'x-ratio-control': { rowCount: 5 } }));
    await source.put(DATA(source, '2026-08') + 'a.csv.gz', csvGz(rowsOf('2026-08-01', 1)));
    await source.put(META(source, '2026-08') + 'focus-export-Manifest.json', manifest({ dataFiles: [`s3://someone-elses-bucket/${DATA(source, '2026-08')}a.csv.gz`] }));
    await source.put(DATA(source, '2026-09') + 'a.csv.gz', csvGz(rowsOf('2026-09-01', 1)));
    await source.put(META(source, '2026-09') + 'focus-export-Manifest.json', manifest({ dataFiles: [DATA(source, '2026-09') + 'a.csv.gz'] }));
    await source.put(META(source, '2026-09') + 'run-2/focus-export-Manifest.json', manifest({ dataFiles: [DATA(source, '2026-09') + 'a.csv.gz'] }));
    await source.put(META(source, '2026-10') + 'notes.txt', 'not a manifest');
    await source.put(META(source, '2026-11') + 'focus-export-Manifest.json', manifest({ dataFiles: [DATA(source, '2026-11') + 'gone.csv.gz'] }));
    await source.put(META(source, '2026-12') + 'focus-export-Manifest.json', manifest({ dataFiles: [DATA(source, '2026-12') + '../../../../../secrets/x.csv.gz'] }));

    const src = new S3FocusExportSource({ client: source.client, location: loc(source) });
    const all = await src.listPeriods();
    const summary = Object.fromEntries(all.map((p) => [p.ok ? p.set.billingPeriod : p.billingPeriod, p.ok ? 'ok' : p.code]));
    expect(summary).toEqual({
      '2026-07-01': 'ok',
      '2026-08-01': 'MANIFEST_INVALID',
      '2026-09-01': 'MANIFEST_AMBIGUOUS',
      '2026-10-01': 'MANIFEST_MISSING',
      '2026-11-01': 'MANIFEST_INVALID',
      '2026-12-01': 'MANIFEST_INVALID',
    });
    const jul7 = all[0];
    expect(jul7.ok).toBe(true);
    if (!jul7.ok) return;
    expect(jul7.set.artifacts.map((a) => [a.name, a.byteSize])).toEqual([
      ['run-1/focus-export-00001.csv.gz', julBytes[0].length],
      ['run-1/focus-export-00002.csv.gz', julBytes[1].length],
    ]);
    expect(jul7.set.control).toEqual({ rowCount: 5 });
    expect(jul7.set.manifest?.bytes.length).toBeGreaterThan(0);
    expect(jul7.set.listingFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const ranged = await src.listPeriods({ from: '2026-07-01', to: '2026-08-01' });
    expect(ranged.map((p) => (p.ok ? p.set.billingPeriod : p.billingPeriod))).toEqual(['2026-07-01', '2026-08-01']);

    const stream = await src.openArtifact(jul7.set.artifacts[1]);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(sha(Buffer.concat(chunks))).toBe(sha(julBytes[1]));
  });
});

describe('S3EvidenceStore', () => {
  it('X2 content-addressed put is idempotent; a size conflict is refused; objects re-hash to their key', async () => {
    const store = new S3EvidenceStore({ client: evidenceBucket.client, bucket: evidenceBucket.name, prefix: evidenceBucket.root });
    const bytes = Buffer.from('evidence bytes ' + crypto.randomUUID());
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-ev-')), 'f');
    fs.writeFileSync(file, bytes);
    const key = `evidence/${crypto.randomUUID()}/${crypto.randomUUID()}/${sha(bytes)}`;
    expect(await store.put(key, file, { sha256: sha(bytes), byteSize: bytes.length })).toBe('stored');
    expect(await store.put(key, file, { sha256: sha(bytes), byteSize: bytes.length })).toBe('exists');
    expect(sha(await evidenceBucket.get(evidenceBucket.at(key)))).toBe(key.split('/').pop());
    await expect(store.put(key, file, { sha256: sha(bytes), byteSize: bytes.length + 1 })).rejects.toMatchObject({ code: 'EVIDENCE_CONFLICT' });
    const opened = await store.open(key);
    const chunks: Buffer[] = [];
    for await (const c of opened) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('S3 source → evidence → published facts', () => {
  it('X3 the synthetic gzip export is read end-to-end and totals equal its control totals', async () => {
    const bucket = await createTestBucket('x3');
    try {
      const exp = generateSyntheticExport({ variant: 'base', prefix: bucket.at('exports/x'), exportName: 'focus-export' });
      await bucket.putAll(exp.objects);
      const s = await seedTenantSource(t.db.pool, { config: { layout: 'aws-data-exports', ...loc(bucket) } });
      const r = await runSync({
        pool: t.pool,
        tenantId: s.tenantId,
        sourceKey: s.sourceKey,
        source: new S3FocusExportSource({ client: bucket.client, location: loc(bucket) }),
        evidence: new S3EvidenceStore({ client: evidenceBucket.client, bucket: evidenceBucket.name, prefix: evidenceBucket.root }),
        mode: 'sync',
        hooks: noSleep,
      });
      expect(r.status).toBe('succeeded');
      const totals = await publishedTotals(t.db.pool, s.tenantId, s.sourceId);
      expect(totals).toEqual(Object.fromEntries(Object.entries(exp.totals).map(([p, v]) => [p, { rows: v.rowCount, total: v.billedTotal }])));
      expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).every((b) => b.reconciliation === 'reconciled')).toBe(true);
      const arts = await t.db.pool.query(`SELECT sha256, evidence_key FROM ratio.ingest_artifacts WHERE tenant_id = $1`, [s.tenantId]);
      expect(arts.rows.length).toBe(exp.objects.filter((o) => o.key.endsWith('.csv.gz')).length);
      for (const a of arts.rows) expect(sha(await evidenceBucket.get(evidenceBucket.at(a.evidence_key)))).toBe(a.sha256);
      const manifests = r.manifestEvidence;
      expect(manifests.length).toBe(Object.keys(exp.manifestsByKey).length);
      for (const k of manifests) expect(sha(await evidenceBucket.get(evidenceBucket.at(k)))).toBe(k.split('/').pop());
    } finally {
      await bucket.destroy();
    }
  });

  it('X4 a tampered evidence object (same size, different bytes) fails EVIDENCE_INTEGRITY and publishes nothing', async () => {
    const bucket = await createTestBucket('x4');
    try {
      const bytes = csvGz(rowsOf('2026-07-01', 3));
      await bucket.put(DATA(bucket, '2026-07') + 'a.csv.gz', bytes);
      await bucket.put(META(bucket, '2026-07') + 'focus-export-Manifest.json', manifest({ dataFiles: [DATA(bucket, '2026-07') + 'a.csv.gz'] }));
      const s = await seedTenantSource(t.db.pool, { config: { layout: 'aws-data-exports', ...loc(bucket) } });
      const forged = Buffer.from(bytes);
      forged[forged.length - 9] ^= 0xff;
      await evidenceBucket.put(evidenceBucket.at(`evidence/${s.tenantId}/${s.sourceId}/${sha(bytes)}`), forged);
      const r = await runSync({
        pool: t.pool,
        tenantId: s.tenantId,
        sourceKey: s.sourceKey,
        source: new S3FocusExportSource({ client: bucket.client, location: loc(bucket) }),
        evidence: new S3EvidenceStore({ client: evidenceBucket.client, bucket: evidenceBucket.name, prefix: evidenceBucket.root }),
        mode: 'sync',
        hooks: noSleep,
      });
      expect(r.status).toBe('failed');
      expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'EVIDENCE_INTEGRITY' });
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
      expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['staged']);
    } finally {
      await bucket.destroy();
    }
  });

  it('X5 a parquet artifact is captured as evidence and the batch quarantined UNSUPPORTED_FORMAT', async () => {
    const bucket = await createTestBucket('x5');
    try {
      const parquet = Buffer.from('PAR1 synthetic not-really-parquet PAR1');
      await bucket.put(DATA(bucket, '2026-07') + 'part-00000.snappy.parquet', parquet);
      await bucket.put(META(bucket, '2026-07') + 'focus-export-Manifest.json', manifest({ dataFiles: [DATA(bucket, '2026-07') + 'part-00000.snappy.parquet'] }));
      const s = await seedTenantSource(t.db.pool, { config: { layout: 'aws-data-exports', ...loc(bucket) } });
      const r = await runSync({
        pool: t.pool,
        tenantId: s.tenantId,
        sourceKey: s.sourceKey,
        source: new S3FocusExportSource({ client: bucket.client, location: loc(bucket) }),
        evidence: new S3EvidenceStore({ client: evidenceBucket.client, bucket: evidenceBucket.name, prefix: evidenceBucket.root }),
        mode: 'sync',
        hooks: noSleep,
      });
      expect(r.periods[0]).toMatchObject({ outcome: 'quarantined' });
      const b = (await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0];
      expect(b.status).toBe('quarantined');
      expect(b.quarantine_reason).toContain('UNSUPPORTED_FORMAT');
      expect(sha(await evidenceBucket.get(evidenceBucket.at(`evidence/${s.tenantId}/${s.sourceId}/${sha(parquet)}`)))).toBe(sha(parquet));
    } finally {
      await bucket.destroy();
    }
  });

  it('X6 (H2) an object replaced between listing and GET: SeaweedFS honours If-Match (412 -> SOURCE_CHANGED); the run re-lists and publishes what it read', async () => {
    const bucket = await createTestBucket('x6');
    try {
      const key = DATA(bucket, '2026-07') + 'a.csv.gz';
      const OLD = csvGz(rowsOf('2026-07-01', 2, '5.00'));
      const NEW = csvGz(rowsOf('2026-07-01', 3, '1.00'));
      await bucket.put(key, OLD);
      await bucket.put(META(bucket, '2026-07') + 'focus-export-Manifest.json', manifest({ dataFiles: [key] }));

      // Direct: a GET conditional on the listed ETag of a since-replaced object is refused.
      const direct = new S3FocusExportSource({ client: bucket.client, location: loc(bucket) });
      const [listing] = await direct.listPeriods();
      if (!listing.ok) throw new Error('listing failed');
      await bucket.put(key, NEW);
      await expect(direct.openArtifact(listing.set.artifacts[0])).rejects.toMatchObject({ code: 'SOURCE_CHANGED', retryable: true });

      // Through the pipeline: replaced right after the first listing.
      await bucket.put(key, OLD);
      let replaced = false;
      class Racy extends S3FocusExportSource {
        async listPeriods(range?: Parameters<S3FocusExportSource['listPeriods']>[0]) {
          const out = await super.listPeriods(range);
          if (!replaced) {
            replaced = true;
            await bucket.put(key, NEW);
          }
          return out;
        }
      }
      const s = await seedTenantSource(t.db.pool, { config: { layout: 'aws-data-exports', ...loc(bucket) } });
      const r = await runSync({
        pool: t.pool,
        tenantId: s.tenantId,
        sourceKey: s.sourceKey,
        source: new Racy({ client: bucket.client, location: loc(bucket) }),
        evidence: new S3EvidenceStore({ client: evidenceBucket.client, bucket: evidenceBucket.name, prefix: evidenceBucket.root }),
        mode: 'sync',
        hooks: noSleep,
      });
      expect(r.status).toBe('succeeded');
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ '2026-07-01': { rows: 3, total: '3.00' } });
      const arts = await t.db.pool.query(`SELECT sha256, evidence_key FROM ratio.ingest_artifacts WHERE tenant_id = $1`, [s.tenantId]);
      expect(arts.rows.map((a) => a.sha256)).toEqual([sha(NEW)]);
      expect(sha(await evidenceBucket.get(evidenceBucket.at(arts.rows[0].evidence_key)))).toBe(sha(NEW));
    } finally {
      await bucket.destroy();
    }
  });
});
