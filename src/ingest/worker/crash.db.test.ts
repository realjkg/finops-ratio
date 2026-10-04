// Crash mid-load (in-process simulation; the real SIGKILL is in demo.db.test.ts),
// recovery to a state identical to a clean run, and bounded retries.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
import { SimulatedCrash } from './types';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import {
  batchesOf,
  checkpointOf,
  expireLeases,
  publishedAs,
  publishedFactMultiset,
  publishedTotals,
  runsOf,
  seedTenantSource,
  type SeededSource,
} from '../testing/db';
import { csvGz, focusRow, rowsOf } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const period = (artifacts: Array<[string, Buffer]>): FakePeriod => ({ billingPeriod: P, artifacts: artifacts.map(([name, bytes]) => ({ name, bytes })) });

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

const crashAfterFirstChunk = { afterChunk: () => { throw new SimulatedCrash('process died'); } };

describe('crash and recovery', () => {
  it('C1 crash after N rows: nothing visible, checkpoint untouched; restart before expiry refused; after expiry recovery equals a clean run', async () => {
    const files: Array<[string, Buffer]> = [
      ['run-1/a.csv.gz', csvGz([...rowsOf(P, 7, '1.10', 'a'), focusRow(P, { BilledCost: '0.1' }), focusRow(P, { BilledCost: '0.1' })])],
      ['run-1/b.csv.gz', csvGz(rowsOf(P, 5, '0.2', 'b'))],
    ];
    const settings = { limits: { insertChunkRows: 3 } };

    const clean = await seedTenantSource(t.db.pool);
    await sync(clean, new FakeFocusSource([period(files)]), { settings });

    const s = await seedTenantSource(t.db.pool);
    await expect(sync(s, new FakeFocusSource([period(files)]), { settings, hooks: crashAfterFirstChunk })).rejects.toBeInstanceOf(SimulatedCrash);
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs.map((r) => r.status)).toEqual(['running']);
    const staged = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(staged.map((b) => b.status)).toEqual(['staged']);
    const partial = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1`, [s.tenantId]);
    expect(partial.rows[0].n).toBe(3);
    expect(await publishedAs(t.db.pool, 'ratio_reader', s.tenantId)).toEqual({ rows: 0, total: null, batches: [] });
    expect(await publishedAs(t.db.pool, 'ratio_worker', s.tenantId)).toEqual({ rows: 0, total: null, batches: [] });
    expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toBeNull();

    await expect(sync(s, new FakeFocusSource([period(files)]), { settings })).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
    expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toBeNull();

    await expireLeases(t.db.pool, s.tenantId, s.sourceId);
    const recovered = await sync(s, new FakeFocusSource([period(files)]), { settings });
    expect(recovered.status).toBe('succeeded');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual(await publishedTotals(t.db.pool, clean.tenantId, clean.sourceId));
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 14, total: '8.90' } });
    expect(await publishedFactMultiset(t.db.pool, s.tenantId, s.sourceId)).toEqual(await publishedFactMultiset(t.db.pool, clean.tenantId, clean.sourceId));
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId)).map((r) => [r.status, r.error_code])).toEqual([
      ['abandoned', 'LEASE_EXPIRED'],
      ['succeeded', null],
    ]);
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['published']);
  });

  it('C1b crash during a restatement keeps the previous revision readable', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period([['r1/a.csv.gz', csvGz(rowsOf(P, 2, '3.00'))]])]);
    await sync(s, source);
    const before = await publishedAs(t.db.pool, 'ratio_reader', s.tenantId);
    source.setPeriods([period([['r2/a.csv.gz', csvGz(rowsOf(P, 10, '1.00'))]])]);
    await expect(sync(s, source, { settings: { limits: { insertChunkRows: 2 } }, hooks: crashAfterFirstChunk })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await publishedAs(t.db.pool, 'ratio_reader', s.tenantId)).toEqual(before);
    expect(before).toMatchObject({ rows: 2, total: '6.00' });
  });

  it('C2 transient source errors are retried with backoff; attempts and retries are visible in sync_runs', async () => {
    const s = await seedTenantSource(t.db.pool);
    const sleeps: number[] = [];
    const source = new FakeFocusSource([period([['r/a.csv.gz', csvGz(rowsOf(P, 2))]])], {
      openFailure: (_name, call) => (call <= 2 ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) : undefined),
    });
    const r = await sync(s, source, {
      settings: { maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1000 },
      hooks: { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5 },
    });
    expect(r.status).toBe('succeeded');
    expect(r.attempts).toBe(3);
    expect(sleeps).toEqual([50, 100]);
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(run.attempt).toBe(3);
    const retries = (run.stats as { retries: Array<{ attempt: number; code: string; period: string }> }).retries;
    expect(retries.map((x) => [x.attempt, x.code, x.period])).toEqual([
      [2, 'SOURCE_READ_FAILED', P],
      [3, 'SOURCE_READ_FAILED', P],
    ]);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 2, total: '2.50' } });
  });

  it('C3 transient errors beyond the retry budget fail the period; checkpoint not advanced', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period([['r/a.csv.gz', csvGz(rowsOf(P, 2))]])], {
      openFailure: () => Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });
    const r = await sync(s, source, { settings: { maxAttempts: 2 } });
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'SOURCE_READ_FAILED' });
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(run).toMatchObject({ status: 'failed', attempt: 2, error_code: 'SOURCE_READ_FAILED' });
    expect(source.opened).toHaveLength(2);
    expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toBeNull();
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });

  it('C4 permanent (validation) errors are not retried', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period([['r/a.csv.gz', csvGz([focusRow(P, { BilledCost: 'x' })])]])]);
    const r = await sync(s, source, { settings: { maxAttempts: 5 } });
    expect(r.periods[0].outcome).toBe('quarantined');
    expect(source.opened).toHaveLength(1);
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(run.attempt).toBe(1);
    expect((run.stats as { retries?: unknown[] }).retries ?? []).toEqual([]);
  });
});
