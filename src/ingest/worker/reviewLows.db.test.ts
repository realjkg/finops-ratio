// Challenger Lows on f22f1f6 (APPROVED), worker side:
//   L2  the per-artifact control check compares REDACTED names, exactly as
//       setArtifactRowCounts stores them (a legal name such as
//       `token=x.csv.gz` must not fail CONTROL_VARIANCE_ON_UNCHANGED forever);
//   L3  a capture-time size rejection (sizes under-reported by the listing)
//       is checkpointed by listing fingerprint and limits: the same listing
//       under the same limits fails fast without downloading anything;
//   L1  a run that committed work before its lease expired is abandoned as
//       LEASE_EXPIRED_AFTER_COMMIT (with what it committed), distinguishable
//       from a run that committed nothing (LEASE_EXPIRED).
import { Readable, Transform } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import type { ArtifactRef, PeriodListing, PeriodRange } from '../sources/types';
import { runSync, type RunSyncOptions } from './pipeline';
import { runDoctor } from './doctor';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, expireLeases, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, rowsOf } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const P2 = '2026-08-01';

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

describe('L2: per-artifact control counts are compared under the stored (redacted) name', () => {
  it('an artifact named token=x.csv.gz with a matching count is unchanged, not CONTROL_VARIANCE_ON_UNCHANGED', async () => {
    const s = await seedTenantSource(t.db.pool);
    const name = 'r/token=x.csv.gz';
    const source = new FakeFocusSource([
      { billingPeriod: P, artifacts: [{ name, bytes: csvGz(rowsOf(P, 2, '1.00')) }], control: { rowCount: 2, artifactRowCounts: { [name]: 2 } } },
    ]);
    expect((await sync(s, source)).periods[0]).toMatchObject({ outcome: 'published', reconciliation: 'reconciled' });
    // backfill re-processes the (unchanged) listing instead of skipping it by fingerprint.
    const again = await sync(s, source, { mode: 'backfill', range: { from: P, to: P } });
    expect(again.status).toBe('succeeded');
    expect(again.periods[0]).toMatchObject({ outcome: 'unchanged' });
    // ...and a genuinely different count under the same name is still caught.
    source.setPeriods([{ billingPeriod: P, artifacts: [{ name, bytes: csvGz(rowsOf(P, 2, '1.00')) }], control: { rowCount: 2, artifactRowCounts: { [name]: 3 } } }]);
    const changed = await sync(s, source, { mode: 'backfill', range: { from: P, to: P } });
    expect(changed.periods[0]).toMatchObject({ outcome: 'failed', code: 'CONTROL_VARIANCE_ON_UNCHANGED' });
  });
});

describe('L3: a capture-time size rejection is remembered for the same listing and limits', () => {
  /** Reports 1 byte per artifact and counts the bytes actually read. */
  class UnderReportingCounted extends FakeFocusSource {
    bytesRead = 0;
    async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
      return (await super.listPeriods(range)).map((l) => (l.ok ? { ...l, set: { ...l.set, artifacts: l.set.artifacts.map((a) => ({ ...a, byteSize: 1 })) } } : l));
    }
    async openArtifact(ref: ArtifactRef): Promise<Readable> {
      const inner = await super.openArtifact(ref);
      const count = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          this.bytesRead += chunk.length;
          cb(null, chunk);
        },
      });
      return inner.pipe(count);
    }
  }

  for (const kind of ['ARTIFACT_SET_TOO_LARGE', 'ARTIFACT_TOO_LARGE'] as const) {
    it(`${kind}: the second sync of the unchanged listing downloads 0 bytes and fails the same way; new limits or a new listing download again`, async () => {
      const s = await seedTenantSource(t.db.pool);
      const A = csvGz(rowsOf(P, 40, '1.00', 'a'));
      const B = csvGz(rowsOf(P, 40, '1.00', 'b'));
      const arts = [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }];
      const limits =
        kind === 'ARTIFACT_SET_TOO_LARGE'
          ? { maxBatchBytes: Math.floor((A.length + B.length) * 0.75) } // each fits alone, together they do not
          : { maxArtifactBytes: Math.floor(Math.min(A.length, B.length) / 2) }; // the first artifact alone is too large
      const settings = { limits } as RunSyncOptions['settings'];
      const source = new UnderReportingCounted([{ billingPeriod: P, artifacts: arts }]);

      const first = await sync(s, source, { settings });
      expect(first.periods[0]).toMatchObject({ outcome: 'failed', code: kind });
      expect(source.bytesRead).toBeGreaterThan(0);

      source.bytesRead = 0;
      const second = await sync(s, source, { settings });
      expect(second.status).toBe('failed');
      expect(second.periods[0]).toMatchObject({ outcome: 'failed', code: kind });
      expect(source.bytesRead).toBe(0);
      expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);

      // Raised limits: the listing is tried again (and now fits).
      source.bytesRead = 0;
      const raised = await sync(s, source);
      expect(source.bytesRead).toBe(A.length + B.length);
      expect(raised.periods[0]).toMatchObject({ outcome: 'published' });
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 80, total: '80.00' } });
    });
  }

  it('a changed listing is downloaded again under the old limits', async () => {
    const s = await seedTenantSource(t.db.pool);
    const A = csvGz(rowsOf(P, 40, '1.00', 'a'));
    const B = csvGz(rowsOf(P, 40, '1.00', 'b'));
    const settings = { limits: { maxBatchBytes: Math.floor((A.length + B.length) * 0.75) } } as RunSyncOptions['settings'];
    const source = new UnderReportingCounted([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }] }]);
    expect((await sync(s, source, { settings })).periods[0]).toMatchObject({ outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE' });
    source.setPeriods([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: A }] }]);
    source.bytesRead = 0;
    const r = await sync(s, source, { settings });
    expect(source.bytesRead).toBe(A.length);
    expect(r.periods[0]).toMatchObject({ outcome: 'published' });
  });
});

describe('L1: work committed before the lease was lost is visible on the abandoned run', () => {
  it('period 1 published, the lease expires before period 2 publishes: the run is abandoned as LEASE_EXPIRED_AFTER_COMMIT, naming what it committed', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([
      { billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2, '1.00')) }] },
      { billingPeriod: P2, artifacts: [{ name: 'r/b.csv.gz', bytes: csvGz(rowsOf(P2, 3, '1.00')) }] },
    ]);
    const hooks = {
      beforePublish: async ({ billingPeriod }: { billingPeriod: string }) => {
        if (billingPeriod === P2) await expireLeases(t.db.pool, s.tenantId, s.sourceId);
      },
    };
    await expect(sync(s, source, { hooks })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 2, total: '2.00' } });
    const [lost] = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(lost.status).toBe('running');

    await sync(s, new FakeFocusSource([]));
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs[0]).toMatchObject({ id: lost.id, status: 'abandoned', error_code: 'LEASE_EXPIRED_AFTER_COMMIT' });
    expect(runs[0].error_detail).toMatch(/committed work/);
    expect(runs[0].error_detail).toMatch(/1 batch/);
    expect(runs[0].error_detail).toMatch(/1 publication/);
  });

  it('a run that committed nothing is still plain LEASE_EXPIRED', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2, '1.00')) }] }]);
    const hooks = { beforePublish: () => expireLeases(t.db.pool, s.tenantId, s.sourceId).then(() => undefined) };
    await expect(sync(s, source, { hooks })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await sync(s, new FakeFocusSource([]));
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED' });
  });
});

// Second challenger round on cb559df (APPROVED): Lows L1-L3.
describe('round 2 L1: replay --period re-downloads despite a rejection memo', () => {
  class UnderReportingCounted extends FakeFocusSource {
    bytesRead = 0;
    async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
      return (await super.listPeriods(range)).map((l) => (l.ok ? { ...l, set: { ...l.set, artifacts: l.set.artifacts.map((a) => ({ ...a, byteSize: 1 })) } } : l));
    }
    async openArtifact(ref: ArtifactRef): Promise<Readable> {
      const inner = await super.openArtifact(ref);
      const count = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          this.bytesRead += chunk.length;
          cb(null, chunk);
        },
      });
      return inner.pipe(count);
    }
  }

  it("the operator's re-ingest really downloads again (and fails the same way); a later sync is fast again", async () => {
    const s = await seedTenantSource(t.db.pool);
    const A = csvGz(rowsOf(P, 40, '1.00', 'a'));
    const B = csvGz(rowsOf(P, 40, '1.00', 'b'));
    const settings = { limits: { maxBatchBytes: Math.floor((A.length + B.length) * 0.75) } } as RunSyncOptions['settings'];
    const source = new UnderReportingCounted([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }] }]);
    expect((await sync(s, source, { settings })).periods[0]).toMatchObject({ outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE' });

    source.bytesRead = 0;
    const replay = await sync(s, source, { settings, mode: 'replay_period', range: { from: P, to: P } });
    expect(source.bytesRead).toBeGreaterThan(0);
    expect(replay.periods[0]).toMatchObject({ outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE' });

    source.bytesRead = 0;
    expect((await sync(s, source, { settings })).periods[0]).toMatchObject({ outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE' });
    expect(source.bytesRead).toBe(0);
  });
});

describe('round 2 L2: NEVER_PUBLISHED has a first-publication grace window', () => {
  const doctor = (s: SeededSource, firstPublishGraceHours?: number) =>
    runDoctor({ workerUrl: t.login.url, migrateUrl: t.db.url, tenantIds: [s.tenantId], maxStalenessHours: 48, ...(firstPublishGraceHours === undefined ? {} : { firstPublishGraceHours }) });
  const check = (r: Awaited<ReturnType<typeof doctor>>, s: SeededSource) => r.checks.find((c) => c.name === `source:${s.tenantId}/${s.sourceKey}`)!;
  const ageSource = (s: SeededSource, hours: number) => t.db.pool.query(`UPDATE ratio.sources SET created_at = now() - make_interval(hours => $2) WHERE id = $1`, [s.sourceId, hours]);

  it('inside the default 48 h window: not reported (the source passes); data says it is in the grace window', async () => {
    const s = await seedTenantSource(t.db.pool);
    expect((await sync(s, new FakeFocusSource([]))).status).toBe('succeeded');
    await ageSource(s, 47);
    const r = await doctor(s);
    expect(check(r, s)).toMatchObject({ status: 'pass', data: expect.objectContaining({ publishedPeriods: 0, firstPublicationGrace: true }) });
    expect(r.pass).toBe(true);
  });

  it('outside the default window: NEVER_PUBLISHED fails', async () => {
    const s = await seedTenantSource(t.db.pool);
    expect((await sync(s, new FakeFocusSource([]))).status).toBe('succeeded');
    await ageSource(s, 49);
    const c = check(await doctor(s), s);
    expect(c).toMatchObject({ status: 'fail', data: expect.objectContaining({ firstPublicationGrace: false }) });
    expect(c.detail).toMatch(/NEVER_PUBLISHED/);
  });

  it('the window is configurable: 1 h with a 2 h old source fails; 0 disables the grace', async () => {
    const s = await seedTenantSource(t.db.pool);
    expect((await sync(s, new FakeFocusSource([]))).status).toBe('succeeded');
    await ageSource(s, 2);
    expect(check(await doctor(s, 1), s).detail).toMatch(/NEVER_PUBLISHED/);
    expect(check(await doctor(s, 3), s)).toMatchObject({ status: 'pass' });
    const fresh = await seedTenantSource(t.db.pool);
    expect((await sync(fresh, new FakeFocusSource([]))).status).toBe('succeeded');
    expect(check(await doctor(fresh, 0), fresh).detail).toMatch(/NEVER_PUBLISHED/);
  });
});

describe('round 2 L3: an abandoned run that only recorded a rejection memo', () => {
  it('memo for P, lease lost before P2 publishes: LEASE_EXPIRED, detail "checkpoint written (rejection memo only)"; no data committed', async () => {
    const s = await seedTenantSource(t.db.pool);
    const A = csvGz(rowsOf(P, 40, '1.00', 'a'));
    const B = csvGz(rowsOf(P, 40, '1.00', 'b'));
    class UnderReportingP extends FakeFocusSource {
      async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
        return (await super.listPeriods(range)).map((l) =>
          l.ok && l.set.billingPeriod === P ? { ...l, set: { ...l.set, artifacts: l.set.artifacts.map((a) => ({ ...a, byteSize: 1 })) } } : l,
        );
      }
    }
    const source = new UnderReportingP([
      { billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }] },
      { billingPeriod: P2, artifacts: [{ name: 'r/c.csv.gz', bytes: csvGz(rowsOf(P2, 2, '1.00')) }] },
    ]);
    const settings = { limits: { maxBatchBytes: Math.floor((A.length + B.length) * 0.75) } } as RunSyncOptions['settings'];
    const hooks = {
      beforePublish: async ({ billingPeriod }: { billingPeriod: string }) => {
        if (billingPeriod === P2) await expireLeases(t.db.pool, s.tenantId, s.sourceId);
      },
    };
    await expect(sync(s, source, { settings, hooks })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const [lost] = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    await sync(s, new FakeFocusSource([]));
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs[0]).toMatchObject({ id: lost.id, status: 'abandoned', error_code: 'LEASE_EXPIRED' });
    expect(runs[0].error_detail).toMatch(/checkpoint written \(rejection memo only\)/);
    expect(runs[0].error_detail).not.toMatch(/committed work/);
  });

  it('a memo AND a publication in the same run: still LEASE_EXPIRED_AFTER_COMMIT', async () => {
    const s = await seedTenantSource(t.db.pool);
    const A = csvGz(rowsOf(P2, 40, '1.00', 'a'));
    const B = csvGz(rowsOf(P2, 40, '1.00', 'b'));
    class UnderReportingP2 extends FakeFocusSource {
      async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
        return (await super.listPeriods(range)).map((l) =>
          l.ok && l.set.billingPeriod === P2 ? { ...l, set: { ...l.set, artifacts: l.set.artifacts.map((a) => ({ ...a, byteSize: 1 })) } } : l,
        );
      }
    }
    const P3 = '2026-09-01';
    const source = new UnderReportingP2([
      { billingPeriod: P, artifacts: [{ name: 'r/x.csv.gz', bytes: csvGz(rowsOf(P, 2, '1.00')) }] },
      { billingPeriod: P2, artifacts: [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }] },
      { billingPeriod: P3, artifacts: [{ name: 'r/c.csv.gz', bytes: csvGz(rowsOf(P3, 2, '1.00')) }] },
    ]);
    const settings = { limits: { maxBatchBytes: Math.floor((A.length + B.length) * 0.75) } } as RunSyncOptions['settings'];
    const hooks = {
      beforePublish: async ({ billingPeriod }: { billingPeriod: string }) => {
        if (billingPeriod === P3) await expireLeases(t.db.pool, s.tenantId, s.sourceId);
      },
    };
    await expect(sync(s, source, { settings, hooks })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await sync(s, new FakeFocusSource([]));
    const [lost] = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(lost).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED_AFTER_COMMIT' });
    expect(lost.error_detail).toMatch(/1 publication/);
  });

  it('a memo AND a progress-only checkpoint write (an unchanged refresh, no publication): LEASE_EXPIRED_AFTER_COMMIT, the memo counted', async () => {
    const s = await seedTenantSource(t.db.pool);
    const P3 = '2026-09-01';
    const X = csvGz(rowsOf(P, 2, '1.00', 'x'));
    expect((await sync(s, new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/x.csv.gz', bytes: X }] }]))).status).toBe('succeeded');
    const A = csvGz(rowsOf(P2, 40, '1.00', 'a'));
    const B = csvGz(rowsOf(P2, 40, '1.00', 'b'));
    class UnderReportingP2 extends FakeFocusSource {
      async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
        return (await super.listPeriods(range)).map((l) =>
          l.ok && l.set.billingPeriod === P2 ? { ...l, set: { ...l.set, artifacts: l.set.artifacts.map((a) => ({ ...a, byteSize: 1 })) } } : l,
        );
      }
    }
    const source = new UnderReportingP2([
      { billingPeriod: P, artifacts: [{ name: 'r/x.csv.gz', bytes: X }] }, // unchanged: refreshed (a progress write), nothing published
      { billingPeriod: P2, artifacts: [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }] }, // memo
      { billingPeriod: P3, artifacts: [{ name: 'r/c.csv.gz', bytes: csvGz(rowsOf(P3, 2, '1.00')) }] }, // lease lost here
    ]);
    const settings = { limits: { maxBatchBytes: Math.floor((A.length + B.length) * 0.75) } } as RunSyncOptions['settings'];
    const hooks = {
      beforePublish: async ({ billingPeriod }: { billingPeriod: string }) => {
        if (billingPeriod === P3) await expireLeases(t.db.pool, s.tenantId, s.sourceId);
      },
    };
    await expect(sync(s, source, { settings, hooks, mode: 'backfill', range: { from: P, to: P3 } })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const lostId = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[1].id;
    await sync(s, new FakeFocusSource([]));
    const lost = (await runsOf(t.db.pool, s.tenantId, s.sourceId)).find((r) => r.id === lostId)!;
    expect(lost).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED_AFTER_COMMIT' });
    expect(lost.error_detail).toMatch(/0 publications/);
    expect(lost.error_detail).toMatch(/checkpoint written and 1 rejection memo/);
  });
});

