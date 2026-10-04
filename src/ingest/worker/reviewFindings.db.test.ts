// PR #54 review findings (Copilot), worker side:
//   H2  an artifact replaced between listing and read: the run re-lists and
//       publishes the bytes it actually read (evidence sha256 binds them);
//   M1  replay --period of a period the source does not list fails visibly;
//   M2  a CONTROL-mismatch quarantine is not forever: corrected controls for
//       the same data re-reconcile and publish (data-defect quarantines stay);
//   M3  replay --batch of the already-current batch still pins the period;
//   M4  replay treats a lost lease at finish (takeover) as LEASE_LOST.
import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { IngestError } from '../errors';
import type { ArtifactRef, PeriodListing, PeriodRange } from '../sources/types';
import type { Readable } from 'stream';
import { runSync, type RunSyncOptions } from './pipeline';
import { replayBatch } from './replay';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, checkpointOf, expireLeases, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, focusRow, rowsOf } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const period = (name: string, bytes: Buffer, control?: FakePeriod['control']): FakePeriod => ({ billingPeriod: P, artifacts: [{ name, bytes }], ...(control ? { control } : {}) });

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

/** A fake source that enforces the listed version on read, like S3 If-Match, and can replace an artifact right after listing. */
class RacyFakeSource extends FakeFocusSource {
  lists = 0;
  replaceAfterFirstList: FakePeriod[] | null = null;
  async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
    this.lists++;
    const out = await super.listPeriods(range);
    if (this.replaceAfterFirstList) {
      this.setPeriods(this.replaceAfterFirstList); // replaced between listing and GET
      this.replaceAfterFirstList = null;
    }
    return out;
  }
  async openArtifact(ref: ArtifactRef): Promise<Readable> {
    const current = (await super.listPeriods()).flatMap((l) => (l.ok ? l.set.artifacts : [])).find((a) => a.name === ref.name);
    if (current && current.version !== ref.version) {
      throw new IngestError('SOURCE_CHANGED', `artifact ${ref.name} changed since it was listed`, { retryable: true });
    }
    return super.openArtifact(ref);
  }
}

describe('H2: artifact replaced between listing and read', () => {
  it('the run re-lists, publishes the bytes it actually read, and the evidence sha256 binds them', async () => {
    const s = await seedTenantSource(t.db.pool);
    const OLD = csvGz(rowsOf(P, 2, '5.00'));
    const NEW = csvGz(rowsOf(P, 3, '1.00'));
    const source = new RacyFakeSource([period('r/a.csv.gz', OLD)]);
    source.replaceAfterFirstList = [period('r/a.csv.gz', NEW)];
    const r = await sync(s, source);
    expect(r.status).toBe('succeeded');
    expect(r.periods[0].outcome).toBe('published');
    expect(source.lists).toBeGreaterThanOrEqual(2); // re-listed after SOURCE_CHANGED
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '3.00' } });
    const arts = await t.db.pool.query(`SELECT sha256 FROM ratio.ingest_artifacts WHERE tenant_id = $1`, [s.tenantId]);
    expect(arts.rows.map((x) => x.sha256)).toEqual([sha(NEW)]);
  });
});

describe('M1: replay --period of a period the source does not list', () => {
  it('fails with PERIOD_NOT_FOUND (never a silent success)', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 1)))]);
    const r = await sync(s, source, { mode: 'replay_period', range: { from: '2026-09-01', to: '2026-09-01' } });
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('PERIOD_NOT_FOUND');
    expect(r.periods).toEqual([expect.objectContaining({ billingPeriod: '2026-09-01', outcome: 'failed', code: 'PERIOD_NOT_FOUND' })]);
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId)).at(-1)).toMatchObject({ status: 'failed', error_code: 'PERIOD_NOT_FOUND' });
  });
});

describe('M2: control-mismatch quarantines recover when the controls are corrected', () => {
  const DATA = csvGz(rowsOf(P, 3, '1.00'));

  it('wrong control -> quarantined; same wrong control again -> no new batch; corrected control -> published; unchanged afterwards', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period('r/a.csv.gz', DATA, { rowCount: 99, billedTotal: '3.00' })]);
    const q = await sync(s, source);
    expect(q.periods[0]).toMatchObject({ outcome: 'quarantined', code: 'RECONCILIATION_VARIANCE' });

    // The same wrong control again (forced re-run): stays quarantined, no duplicate batch.
    const again = await sync(s, source, { mode: 'backfill', range: { from: P, to: P } });
    expect(again.periods[0]).toMatchObject({ outcome: 'failed', code: 'BATCH_QUARANTINED' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['quarantined']);

    // The provider corrects only the control total: the same data re-reconciles and publishes.
    source.setPeriods([period('r/a.csv.gz', DATA, { rowCount: 3, billedTotal: '3.00' })]);
    const fixed = await sync(s, source);
    expect(fixed.status).toBe('succeeded');
    expect(fixed.periods[0]).toMatchObject({ outcome: 'published', reconciliation: 'reconciled' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '3.00' } });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['quarantined', 'published']);

    // Re-running with the corrected control finds the published batch (no third batch).
    const steady = await sync(s, source, { mode: 'backfill', range: { from: P, to: P } });
    expect(steady.periods[0].outcome).toBe('unchanged');
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId))).toHaveLength(2);
  });

  it('an UN-KEYED RECONCILIATION_VARIANCE quarantine (no [controls:...] recorded) stays quarantined (challenger Low 1)', async () => {
    const s = await seedTenantSource(t.db.pool);
    // Plant a control quarantine of this exact data whose reason carries no control key.
    const run = crypto.randomUUID();
    const batch = crypto.randomUUID();
    const dataFingerprint = sha(Buffer.from(sha(DATA))); // setFingerprint over the single artifact hash
    await t.db.pool.query(
      `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, status, started_at, finished_at)
       VALUES ($1, $2, $3, 'scheduled', 'failed', now(), now())`,
      [s.tenantId, run, s.sourceId],
    );
    await t.db.pool.query(
      `INSERT INTO ratio.ingest_batches (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status, is_provisional, control_row_count)
       VALUES ($1, $2, $3, $4, $5, $6, 'staged', false, 99)`,
      [s.tenantId, batch, s.sourceId, run, P, dataFingerprint],
    );
    await t.db.pool.query(`UPDATE ratio.ingest_batches SET status = 'quarantined', quarantine_reason = 'RECONCILIATION_VARIANCE: row count 3 != control 99' WHERE id = $1`, [batch]);

    const source = new FakeFocusSource([period('r/a.csv.gz', DATA, { rowCount: 3, billedTotal: '3.00' })]);
    const r = await sync(s, source);
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'BATCH_QUARANTINED', batchId: batch });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['quarantined']);
  });

  it('a DATA-defect quarantine stays quarantined whatever the controls say', async () => {
    const s = await seedTenantSource(t.db.pool);
    const BAD = csvGz([focusRow(P, { BilledCost: 'oops' })]);
    const source = new FakeFocusSource([period('r/a.csv.gz', BAD, { rowCount: 1 })]);
    expect((await sync(s, source)).periods[0]).toMatchObject({ outcome: 'quarantined', code: 'VALIDATION_FAILED' });
    source.setPeriods([period('r/a.csv.gz', BAD, { rowCount: 7, billedTotal: '1.00' })]);
    expect((await sync(s, source)).periods[0]).toMatchObject({ outcome: 'failed', code: 'BATCH_QUARANTINED' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['quarantined']);
  });
});

describe('M3: replay --batch of the already-current batch pins the period', () => {
  it('returns already_current, pins the checkpoint, and a later sync does not replace it', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 1, '100.00')))]);
    await sync(s, source);
    const [b1] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    const r = await replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b1.id });
    expect(r.outcome).toBe('already_current');
    expect((await checkpointOf(t.db.pool, s.tenantId, s.sourceId))?.[P]).toMatchObject({ batchId: b1.id, fingerprint: b1.fingerprint, pinned: true });

    source.setPeriods([period('r2/a.csv.gz', csvGz(rowsOf(P, 2, '1.00')))]);
    const later = await sync(s, source);
    expect(later.periods[0].outcome).toBe('skipped_pinned');
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '100.00' } });
  });
});

/** A worker pool whose finishing UPDATE of sync_runs is preceded by a takeover (another token) from the admin connection. */
function takeoverBeforeFinish(pool: Pool, admin: Pool): Pool {
  const wrapClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
            if (typeof text === 'string' && /UPDATE ratio\.sync_runs SET status = \$3, finished_at/.test(text)) {
              const runId = (args[1] as unknown[])[0];
              await admin.query(`UPDATE ratio.sync_runs SET lease_token = gen_random_uuid() WHERE id = $1`, [runId]);
            }
            return (target.query as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'connect') return async () => wrapClient(await target.connect());
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe('M4: replay after a takeover', () => {
  it('finishRun() == false (the run was taken over) is LEASE_LOST, for both outcomes', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 1, '100.00')))]);
    await sync(s, source);
    source.setPeriods([period('r2/a.csv.gz', csvGz(rowsOf(P, 2, '1.00')))]);
    await sync(s, source);
    const [b1, b2] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    const pool = takeoverBeforeFinish(t.pool, t.db.pool);
    await expect(replayBatch({ pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b2.id })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    // The taken-over run is still `running` under the other token; let its lease lapse before the next replay.
    await expireLeases(t.db.pool, s.tenantId, s.sourceId);
    await expect(replayBatch({ pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b1.id })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
});
