// A COMMIT that PostgreSQL answers with a ROLLBACK command tag (the
// transaction was already aborted, e.g. by a statement error some code
// caught) discards every write. It must never be reported as success: the run
// fails visibly, the checkpoint does not advance and nothing is published.
//
// The swallowed error is injected with a pool wrapper: right after a chosen
// statement runs inside the worker's transaction, a failing statement is
// executed and its error swallowed — exactly the shape of a caught query error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
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

/** A pool whose clients swallow a failing statement right after any statement matching `after`. */
function swallowingPool(pool: Pool, after: RegExp): { pool: Pool; injected: () => number } {
  let injected = 0;
  const wrapClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            const r = await (target.query as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
            if (typeof text === 'string' && after.test(text)) {
              injected += 1;
              await target.query('SELECT 1 / 0').catch(() => undefined); // the caught error
            }
            return r;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  const wrapped = new Proxy(pool, {
    get(target, prop) {
      if (prop === 'connect') return async () => wrapClient(await target.connect());
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { pool: wrapped, injected: () => injected };
}

async function visibleState(s: SeededSource) {
  const pubs = await t.db.pool.query(`SELECT to_jsonb(p)::text AS j FROM ratio.period_publications p WHERE tenant_id = $1 ORDER BY 1`, [s.tenantId]);
  const batches = await t.db.pool.query(`SELECT id, status, published_at, superseded_at FROM ratio.ingest_batches WHERE tenant_id = $1 ORDER BY created_at, id`, [s.tenantId]);
  const cp = await t.db.pool.query(`SELECT periods::text AS periods, last_run_id::text AS last_run_id, updated_at FROM ratio.source_checkpoints WHERE tenant_id = $1`, [s.tenantId]);
  return {
    view: await publishedAs(t.db.pool, 'ratio_reader', s.tenantId),
    totals: await publishedTotals(t.db.pool, s.tenantId, s.sourceId),
    pubs: pubs.rows.map((r) => r.j),
    batches: batches.rows.map((r) => JSON.stringify(r)),
    checkpoint: cp.rows.map((r) => JSON.stringify(r)),
  };
}

function sync(pool: Pool, s: SeededSource, source: FakeFocusSource, evidence: MemoryEvidenceStore, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence, mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

describe('COMMIT answered with ROLLBACK is a failure, never a success', () => {
  it('publish path: a caught error after the checkpoint write fails the run; nothing is published, the checkpoint is unchanged', async () => {
    const s = await seedTenantSource(t.db.pool);
    const evidence = new MemoryEvidenceStore();
    const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 2, '5.00')))]);
    expect((await sync(t.pool, s, source, evidence)).status).toBe('succeeded');
    const before = await visibleState(s);
    expect(before.view.rows).toBe(2);

    source.setPeriods([period('r2/a.csv.gz', csvGz(rowsOf(P, 3, '1.00')))]);
    const w = swallowingPool(t.pool, /INSERT INTO ratio\.source_checkpoints/);
    const r = await sync(w.pool, s, source, evidence);
    expect(w.injected()).toBeGreaterThan(0);
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ billingPeriod: P, outcome: 'failed', code: 'COMMIT_ROLLED_BACK' });
    const after = await visibleState(s);
    expect(after.view).toEqual(before.view);
    expect(after.totals).toEqual(before.totals);
    expect(after.pubs).toEqual(before.pubs);
    expect(after.checkpoint).toEqual(before.checkpoint);
    // Pre-existing batches unchanged; the new one exists only as staged (as after any failed publish, P1).
    expect(after.batches.slice(0, before.batches.length)).toEqual(before.batches);
    expect(after.batches.slice(before.batches.length).map((b) => JSON.parse(b).status)).toEqual(['staged']);
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs.find((x) => x.id === r.runId)).toMatchObject({ status: 'failed', error_code: 'COMMIT_ROLLED_BACK' });
    // A later clean run publishes normally.
    const again = await sync(t.pool, s, source, evidence);
    expect(again.status).toBe('succeeded');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '3.00' } });
  });

  it('checkpoint path (unchanged period, refreshCheckpoint): a caught error fails the run and the checkpoint does not advance', async () => {
    const s = await seedTenantSource(t.db.pool);
    const evidence = new MemoryEvidenceStore();
    const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 2, '5.00')))]);
    expect((await sync(t.pool, s, source, evidence)).status).toBe('succeeded');
    const before = await visibleState(s);
    const cpBefore = await checkpointOf(t.db.pool, s.tenantId, s.sourceId);

    const w = swallowingPool(t.pool, /INSERT INTO ratio\.source_checkpoints/);
    const r = await sync(w.pool, s, source, evidence, { mode: 'backfill', range: { from: P, to: P } });
    expect(w.injected()).toBeGreaterThan(0);
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ billingPeriod: P, outcome: 'failed', code: 'COMMIT_ROLLED_BACK' });
    expect(await visibleState(s)).toEqual(before);
    expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toEqual(cpBefore);
  });

  it('run bookkeeping: a caught error inside the finishing transaction is not reported as a finished run', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 2, '5.00')))]);
    const w = swallowingPool(t.pool, /UPDATE ratio\.sync_runs SET status/);
    await expect(sync(w.pool, s, source, new MemoryEvidenceStore())).rejects.toMatchObject({ code: 'COMMIT_ROLLED_BACK' });
    expect(w.injected()).toBeGreaterThan(0);
    // The run row was never finished: it stays running until its lease expires (then it is abandoned).
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs.map((x) => x.status)).toEqual(['running']);
  });

  // The quarantine transaction (validation errors, fact deletion, staged -> quarantined):
  // a caught error after each of its state-changing statements. After an earlier
  // statement the NEXT statement already fails (25P02, transaction aborted); after
  // the last one only the COMMIT reply tells — both must fail the run visibly.
  for (const [name, after, code] of [
    ['validation errors inserted', /INSERT INTO ratio\.ingest_validation_errors/, 'DB_25P02'],
    ['staged facts deleted', /DELETE FROM ratio\.cost_facts WHERE batch_id = \$1/, 'DB_25P02'],
    ['batch marked quarantined (last statement before COMMIT)', /UPDATE ratio\.ingest_batches SET status = 'quarantined'/, 'COMMIT_ROLLED_BACK'],
  ] as Array<[string, RegExp, string]>) {
    it(`quarantine path (${name}): the run fails, the batch stays staged, nothing is recorded or published`, async () => {
      const s = await seedTenantSource(t.db.pool);
      const evidence = new MemoryEvidenceStore();
      const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 1, '4.00')))]);
      expect((await sync(t.pool, s, source, evidence)).status).toBe('succeeded');
      const before = await visibleState(s);

      source.setPeriods([period('r2/a.csv.gz', csvGz([focusRow(P, { BilledCost: 'oops' })]))]);
      const w = swallowingPool(t.pool, after);
      const r = await sync(w.pool, s, source, evidence);
      expect(w.injected()).toBeGreaterThan(0);
      expect(r.status).toBe('failed');
      expect(r.periods[0]).toMatchObject({ billingPeriod: P, outcome: 'failed', code });
      const after2 = await visibleState(s);
      expect(after2.view).toEqual(before.view);
      expect(after2.totals).toEqual(before.totals);
      expect(after2.pubs).toEqual(before.pubs);
      expect(after2.checkpoint).toEqual(before.checkpoint);
      expect(after2.batches.slice(0, before.batches.length)).toEqual(before.batches);
      expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['published', 'staged']);
      const errs = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.ingest_validation_errors WHERE tenant_id = $1`, [s.tenantId]);
      expect(errs.rows[0].n).toBe(0);
      const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
      expect(runs.find((x) => x.id === r.runId)).toMatchObject({ status: 'failed', error_code: code });
    });
  }
});
