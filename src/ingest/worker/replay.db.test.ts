// Replay: re-point a period at a retained batch (rollback / roll-forward), and
// re-ingest a period from the source. Both fenced and atomic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
import { replayBatch } from './replay';
import { PUBLISH_STEPS } from './publish';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, checkpointOf, publishedAs, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, focusRow, rowsOf } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const period = (name: string, bytes: Buffer): FakePeriod => ({ billingPeriod: P, artifacts: [{ name, bytes }] });
const V1 = csvGz(rowsOf(P, 1, '100.00'));
const V2 = csvGz(rowsOf(P, 2, '30.00'));
const V3 = csvGz(rowsOf(P, 3, '1.00'));

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

async function twoRevisions() {
  const s = await seedTenantSource(t.db.pool);
  const source = new FakeFocusSource([period('r1/a.csv.gz', V1)]);
  await sync(s, source);
  source.setPeriods([period('r2/a.csv.gz', V2)]);
  await sync(s, source);
  const [b1, b2] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
  expect([b1.status, b2.status]).toEqual(['superseded', 'published']);
  return { s, source, b1, b2 };
}

describe('replay', () => {
  it('R1 rollback re-points the period at the retained batch, pins it against scheduled syncs, and rolls forward again', async () => {
    const { s, source, b1, b2 } = await twoRevisions();
    const back = await replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b1.id });
    expect(back).toMatchObject({ billingPeriod: P, batchId: b1.id, outcome: 'republished' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['published', 'superseded']);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '100.00' } });
    expect(await publishedAs(t.db.pool, 'ratio_reader', s.tenantId)).toMatchObject({ rows: 1, total: '100.00', batches: [b1.id] });
    expect((await checkpointOf(t.db.pool, s.tenantId, s.sourceId))?.[P]).toMatchObject({ fingerprint: b1.fingerprint, batchId: b1.id, pinned: true });
    const replayRun = (await runsOf(t.db.pool, s.tenantId, s.sourceId)).at(-1)!;
    expect(replayRun).toMatchObject({ run_kind: 'replay', status: 'succeeded' });

    const scheduled = await sync(s, source);
    expect(scheduled.periods[0].outcome).toBe('skipped_pinned');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '100.00' } });

    const fwd = await replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b2.id });
    expect(fwd.outcome).toBe('republished');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 2, total: '60.00' } });
    const again = await replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b2.id });
    expect(again.outcome).toBe('already_current');
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toHaveLength(2);
  });

  it('R2 replay --period re-ingests from the source ignoring the checkpoint and clears the pin', async () => {
    const { s, source, b1 } = await twoRevisions();
    await replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b1.id });
    source.setPeriods([period('r3/a.csv.gz', V3)]);
    const r = await sync(s, source, { mode: 'replay_period', range: { from: P, to: P } });
    expect(r.periods[0].outcome).toBe('published');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '3.00' } });
    expect((await checkpointOf(t.db.pool, s.tenantId, s.sourceId))?.[P]).toMatchObject({ pinned: false });
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId)).at(-1)).toMatchObject({ run_kind: 'replay', status: 'succeeded', period_from: P, period_to: P });
    const next = await sync(s, source);
    expect(next.periods[0].outcome).toBe('skipped_unchanged');
    // Re-ingesting identical bytes is idempotent.
    const same = await sync(s, source, { mode: 'replay_period', range: { from: P, to: P } });
    expect(same.periods[0].outcome).toBe('unchanged');
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toHaveLength(3);
  });

  it('R3 quarantined and staged batches are not replayable; other sources/tenants batches are NOT_FOUND', async () => {
    const { s, source } = await twoRevisions();
    source.setPeriods([period('r9/a.csv.gz', csvGz([focusRow(P, { BilledCost: 'zzz' })]))]);
    await sync(s, source);
    const q = (await batchesOf(t.db.pool, s.tenantId, s.sourceId)).find((b) => b.status === 'quarantined')!;
    await expect(replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: q.id })).rejects.toMatchObject({ code: 'BATCH_NOT_REPLAYABLE' });

    const crashSource = new FakeFocusSource([period('r10/a.csv.gz', csvGz(rowsOf(P, 4)))]);
    let stagedId = '';
    await expect(
      sync(s, crashSource, {
        settings: { limits: { insertChunkRows: 1 } },
        hooks: {
          afterChunk: async (info) => {
            stagedId = info.batchId;
            throw Object.assign(new Error('boom'), { code: '23514' });
          },
        },
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(stagedId).not.toBe('');
    await expect(replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: stagedId })).rejects.toMatchObject({ code: 'BATCH_NOT_REPLAYABLE' });

    const other = await twoRevisions();
    await expect(replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: other.b1.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sibling = await seedTenantSource(t.db.pool, { tenantId: s.tenantId, sourceKey: 'focus-second' });
    await expect(replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: sibling.sourceKey, batchId: other.b1.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const own = (await batchesOf(t.db.pool, s.tenantId, s.sourceId))[0];
    await expect(replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: sibling.sourceKey, batchId: own.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await publishedTotals(t.db.pool, other.s.tenantId, other.s.sourceId)).toEqual({ [P]: { rows: 2, total: '60.00' } });
  });

  for (const step of PUBLISH_STEPS) {
    it(`R4 replay failure injected at "${step}" changes nothing`, async () => {
      const { s, b1 } = await twoRevisions();
      const before = {
        totals: await publishedTotals(t.db.pool, s.tenantId, s.sourceId),
        batches: (await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status),
        cp: await checkpointOf(t.db.pool, s.tenantId, s.sourceId),
      };
      await expect(
        replayBatch({
          pool: t.pool,
          tenantId: s.tenantId,
          sourceKey: s.sourceKey,
          batchId: b1.id,
          hooks: {
            beforePublishStep: (st) => {
              if (st === step) throw new Error(`injected at ${st}`);
            },
          },
        }),
      ).rejects.toThrow(`injected at ${step}`);
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(before.totals);
      expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(before.batches);
      expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toEqual(before.cp);
      expect((await runsOf(t.db.pool, s.tenantId, s.sourceId)).at(-1)).toMatchObject({ run_kind: 'replay', status: 'failed' });
    });
  }
});
