// PR #54 sixth Copilot review (re-review after 6412756), worker side:
//   M (load.ts:215)      fact chunks are bounded by BYTES as well as rows, so a
//                        chunk of large records flushes early (memory bounded);
//   M (pipeline.ts:155)  one run-wide retry counter: the returned attempts,
//                        each retry record and sync_runs.attempt agree.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import type { PeriodListing, PeriodRange } from '../sources/types';
import { runSync, type RunSyncOptions } from './pipeline';
import { workerTestDb, type WorkerTestDb } from '../testing/workerSetup';
import { publishedTotals, runsOf, seedTenantSource } from '../testing/db';
import { csvGz, focusRow } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';

describe('fact chunks are bounded by bytes as well as rows', () => {
  it('20 records of ~100 KB with a 250 KB chunk budget: inserts split into chunks of at most 3 rows (never the 1000-row default); all rows load', async () => {
    const s = await seedTenantSource(t.db.pool);
    const big = 'x'.repeat(100_000);
    const rows = Array.from({ length: 20 }, (_, i) => focusRow(P, { BilledCost: '1.00', ResourceId: `r-${i}`, Tags: big }));
    const chunks: number[] = [];
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rows) }] }]),
      evidence: new MemoryEvidenceStore(),
      mode: 'sync',
      settings: { limits: { insertChunkRows: 1000, maxChunkBytes: 250_000 } } as RunSyncOptions['settings'],
      hooks: { sleep: async () => undefined, afterChunk: ({ chunkRows }) => void chunks.push(chunkRows) },
    });
    expect(r.status).toBe('succeeded');
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(20);
    expect(chunks.length).toBeGreaterThanOrEqual(7); // split by bytes: 20 rows, at most 3 per chunk
    for (const n of chunks) expect(n).toBeLessThanOrEqual(3); // pending bytes never exceed the budget by more than one record
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 20, total: '20.00' } });
  });

  it('small records are still chunked by row count (the byte budget does not change normal batching)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const rows = Array.from({ length: 25 }, (_, i) => focusRow(P, { BilledCost: '1.00', ResourceId: `r-${i}` }));
    const chunks: number[] = [];
    await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rows) }] }]),
      evidence: new MemoryEvidenceStore(),
      mode: 'sync',
      settings: { limits: { insertChunkRows: 10 } } as RunSyncOptions['settings'],
      hooks: { sleep: async () => undefined, afterChunk: ({ chunkRows }) => void chunks.push(chunkRows) },
    });
    expect(chunks).toEqual([10, 10, 5]);
  });
});

describe('one run-wide retry counter', () => {
  it('2 listing retries + 1 artifact retry: attempts 4 in the result, retries [2,3,4] recorded, sync_runs.attempt 4', async () => {
    const s = await seedTenantSource(t.db.pool);
    const transient = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    class FlakyListing extends FakeFocusSource {
      lists = 0;
      async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
        if (++this.lists <= 2) throw transient();
        return super.listPeriods(range);
      }
    }
    const source = new FlakyListing([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz([focusRow(P, { BilledCost: '1.00' })]) }] }], {
      openFailure: (_name, call) => (call === 1 ? transient() : undefined),
    });
    const r = await runSync({
      pool: t.pool,
      tenantId: s.tenantId,
      sourceKey: s.sourceKey,
      source,
      evidence: new MemoryEvidenceStore(),
      mode: 'sync',
      settings: { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 1 } as RunSyncOptions['settings'],
      hooks: { sleep: async () => undefined },
    });
    expect(r.status).toBe('succeeded');
    expect(r.attempts).toBe(4);
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(run.attempt).toBe(4);
    const retries = (run.stats as { retries: Array<{ attempt: number; period: string | null }> }).retries;
    expect(retries.map((x) => [x.attempt, x.period])).toEqual([
      [2, null],
      [3, null],
      [4, P],
    ]);
  });
});
