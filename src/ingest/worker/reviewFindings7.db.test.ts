// PR #54 seventh Copilot review (0c0aa7d), worker side:
//   M2 (S3EvidenceStore.ts:133)  a new-object upload feeds run progress as the
//      SDK consumes the body, and a stalled upload fails EVIDENCE_STALLED;
//   M4 (doctor.ts:129)           replay --batch never contacts the source, so
//      it does not refresh doctor's freshness; replay --period does;
//   M5 (pipeline.ts:165)         an active listing feeds run progress (per page
//      and per manifest), so a long healthy listing keeps the lease.
import crypto from 'crypto';
import { Readable } from 'stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { S3EvidenceStore } from '../evidence/S3EvidenceStore';
import type { ListOptions, PeriodListing, PeriodRange } from '../sources/types';
import { runSync, type RunSyncOptions } from './pipeline';
import { replayBatch } from './replay';
import { runDoctor } from './doctor';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, focusRow, rowsOf } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Stall 1 s, lease 2 s: anything that runs > 3 s without progress loses the lease.
const tight = { stallTimeoutSeconds: 1, leaseTtlSeconds: 2, maxRunSeconds: 60 } as RunSyncOptions['settings'];

describe('M2: a new-object evidence upload feeds progress and is under the idle watchdog', () => {
  /** An S3 client over a Map whose PutObject consumes the body slowly ('slow') or stops after one chunk ('stall'). */
  function uploadClient(mode: 'slow' | 'stall', seen: { contentLength?: number; ifNoneMatch?: string; chunks: number }): S3Client {
    const objects = new Map<string, Buffer>();
    return {
      async send(cmd: unknown) {
        if (cmd instanceof HeadObjectCommand) {
          const o = objects.get(String(cmd.input.Key));
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          return { ContentLength: o.length, Metadata: {} };
        }
        if (cmd instanceof PutObjectCommand) {
          seen.contentLength = cmd.input.ContentLength;
          seen.ifNoneMatch = cmd.input.IfNoneMatch;
          const body = cmd.input.Body as Readable | Buffer;
          if (Buffer.isBuffer(body)) {
            objects.set(String(cmd.input.Key), body);
            return {};
          }
          const parts: Buffer[] = [];
          for await (const c of body) {
            parts.push(Buffer.from(c as Buffer));
            seen.chunks++;
            if (mode === 'stall') {
              // Stops reading: only the body stream being destroyed ends this request.
              await new Promise<never>((_, reject) => {
                body.once('close', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })));
                body.once('error', reject);
              });
            }
            await sleep(400);
          }
          objects.set(String(cmd.input.Key), Buffer.concat(parts));
          return {};
        }
        if (cmd instanceof GetObjectCommand) {
          const o = objects.get(String(cmd.input.Key));
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
          return { Body: Readable.from([o]), ContentLength: o.length };
        }
        throw new Error('unexpected command');
      },
    } as unknown as S3Client;
  }
  /** ~600 KB gzip that does not compress (random tags): ~10 read chunks of 64 KiB. */
  const bigArtifact = () => csvGz(Array.from({ length: 12 }, (_, i) => focusRow(P, { BilledCost: '1.00', ResourceId: `r-${i}`, Tags: crypto.randomBytes(40_000).toString('hex') })));

  it('an upload slower than stall + TTL that keeps consuming bytes keeps the lease: the period publishes; ContentLength and IfNoneMatch intact', async () => {
    const s = await seedTenantSource(t.db.pool);
    const bytes = bigArtifact();
    const seen = { chunks: 0 } as { contentLength?: number; ifNoneMatch?: string; chunks: number };
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes }] }]),
      evidence: new S3EvidenceStore({ client: uploadClient('slow', seen), bucket: 'ev' }),
      mode: 'sync',
      settings: tight,
      hooks: noSleep,
    });
    expect(seen.chunks * 0.4).toBeGreaterThan(3); // the upload really outlasted stall + TTL
    expect(seen.contentLength).toBe(bytes.length);
    expect(seen.ifNoneMatch).toBe('*');
    expect(r.status).toBe('succeeded');
    expect(r.periods[0]).toMatchObject({ outcome: 'published' });
  }, 30_000);

  it('an upload that stops consuming fails EVIDENCE_STALLED at the stall limit', async () => {
    const s = await seedTenantSource(t.db.pool);
    const seen = { chunks: 0 } as { contentLength?: number; ifNoneMatch?: string; chunks: number };
    const started = Date.now();
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: bigArtifact() }] }]),
      evidence: new S3EvidenceStore({ client: uploadClient('stall', seen), bucket: 'ev' }),
      mode: 'sync',
      settings: { stallTimeoutSeconds: 1, leaseTtlSeconds: 30, maxRunSeconds: 20, maxAttempts: 1 } as RunSyncOptions['settings'],
      hooks: noSleep,
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'EVIDENCE_STALLED' });
  }, 30_000);
});

describe('M4: replay --batch does not refresh doctor freshness; replay --period does', () => {
  const name = (s: SeededSource) => `source:${s.tenantId}/${s.sourceKey}`;
  const doctor = (s: SeededSource) => runDoctor({ workerUrl: t.login.url, migrateUrl: t.db.url, tenantIds: [s.tenantId], maxStalenessHours: 48 });

  it('a stale source followed by replay --batch is still STALE; a replay --period refreshes it', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }]);
    await runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', hooks: noSleep });
    await t.db.pool.query(`UPDATE ratio.sync_runs SET started_at = now() - interval '100 hours', finished_at = now() - interval '99 hours' WHERE source_id = $1`, [s.sourceId]);
    expect((await doctor(s)).checks.find((c) => c.name === name(s))!.detail).toMatch(/STALE/);

    const [b] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect((await replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b.id })).outcome).toBe('already_current');
    const afterBatch = (await doctor(s)).checks.find((c) => c.name === name(s))!;
    expect(afterBatch).toMatchObject({ status: 'fail' });
    expect(afterBatch.detail).toMatch(/STALE/);

    const r = await runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'replay_period', range: { from: P, to: P }, hooks: noSleep });
    expect(r.status).toBe('succeeded');
    expect((await doctor(s)).checks.find((c) => c.name === name(s))).toMatchObject({ status: 'pass' });
  });
});

describe('M5: an active listing feeds progress', () => {
  /** A listing that takes 10 "pages" of 400 ms (4 s > stall 1 s + TTL 2 s), reporting progress per page or not at all. */
  class SlowListing extends FakeFocusSource {
    constructor(
      periods: ConstructorParameters<typeof FakeFocusSource>[0],
      private readonly reports: boolean,
    ) {
      super(periods);
    }
    async listPeriods(range?: PeriodRange, opts?: ListOptions): Promise<PeriodListing[]> {
      for (let page = 0; page < 10; page++) {
        await sleep(400);
        if (this.reports) opts?.progress?.();
      }
      return super.listPeriods(range, opts);
    }
  }
  const set = [{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2)) }] }];

  it('a slow-paginating listing that reports each page keeps the lease: the period publishes', async () => {
    const s = await seedTenantSource(t.db.pool);
    const r = await runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source: new SlowListing(set, true), evidence: new MemoryEvidenceStore(), mode: 'sync', settings: tight, hooks: noSleep });
    expect(r.status).toBe('succeeded');
    expect(r.periods[0]).toMatchObject({ outcome: 'published' });
  }, 30_000);

  it('an idle listing (no progress) still stops renewal: LEASE_LOST', async () => {
    const s = await seedTenantSource(t.db.pool);
    await expect(
      runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source: new SlowListing(set, false), evidence: new MemoryEvidenceStore(), mode: 'sync', settings: tight, hooks: noSleep }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  }, 30_000);
});
