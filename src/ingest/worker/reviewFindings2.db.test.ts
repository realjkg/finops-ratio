// PR #54 second Copilot review (fffe3f1), worker side:
//   H1  finishRun is fenced on lease expiry too; an expired run is never
//       finished (LEASE_LOST) and the next acquisition abandons it;
//   M1  a manifest re-listed after SOURCE_CHANGED is captured as evidence;
//   M3  MAX_RUN_SECONDS bounds the source listing (abort signal passed down);
//   M4  the batch byte cap is enforced on CAPTURED bytes, not listed sizes;
//   M5  a change to one per-artifact control count is never "unchanged".
import crypto from 'crypto';
import type { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { IngestError } from '../errors';
import type { ArtifactRef, PeriodListing, PeriodRange, ListOptions } from '../sources/types';
import { runSync, type RunSyncOptions } from './pipeline';
import { replayBatch } from './replay';
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
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}, evidence = new MemoryEvidenceStore()) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence, mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

describe('H1: finishing an expired run', () => {
  class ExpiringSource extends FakeFocusSource {
    constructor(
      private readonly s: SeededSource,
      private readonly fail: boolean,
    ) {
      super([]);
    }
    async listPeriods(): Promise<PeriodListing[]> {
      await expireLeases(t.db.pool, this.s.tenantId, this.s.sourceId); // a long listing: the lease ran out
      if (this.fail) throw new IngestError('SOURCE_LIST_FAILED', 'listing failed');
      return []; // empty listing: nothing else would notice the lost lease
    }
  }

  for (const fail of [false, true]) {
    it(`lease expires during ${fail ? 'a failing' : 'an empty'} listing: finishing is LEASE_LOST, the run is never finished, the next acquisition abandons it`, async () => {
      const s = await seedTenantSource(t.db.pool);
      await expect(sync(s, new ExpiringSource(s, fail))).rejects.toMatchObject({ code: 'LEASE_LOST' });
      const [run] = await runsOf(t.db.pool, s.tenantId, s.sourceId);
      expect(run.status).toBe('running');
      await sync(s, new FakeFocusSource([]));
      const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
      expect(runs[0]).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED' });
      expect(runs[1]).toMatchObject({ status: 'succeeded' });
    });
  }
});

describe('H1: a failure finish on an expired lease is LEASE_LOST too', () => {
  it('runSync: the lease expires during the listing, then a run-level error (checkpoint read): LEASE_LOST, the run is never finished, the next acquisition abandons it', async () => {
    const s = await seedTenantSource(t.db.pool);
    let failNextConnect = false;
    // One connection attempt fails (a DB blip right after a long listing); finishing still reaches the DB.
    const pool = new Proxy(t.pool, {
      get(target, prop) {
        if (prop === 'connect' && failNextConnect) {
          failNextConnect = false;
          return () => Promise.reject(new Error('connection refused'));
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    class SlowListing extends FakeFocusSource {
      async listPeriods(): Promise<PeriodListing[]> {
        await expireLeases(t.db.pool, s.tenantId, s.sourceId);
        failNextConnect = true;
        return [];
      }
    }
    await expect(sync(s, new SlowListing([]), { pool })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId))[0].status).toBe('running');
    await sync(s, new FakeFocusSource([]));
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED' });
  });

  it('replay --batch: the lease expires, then the publish fails: LEASE_LOST, the replay run is never finished, the next acquisition abandons it', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 2, '1.00')) }] }]);
    await sync(s, source);
    source.setPeriods([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 3, '1.00')) }] }]);
    await sync(s, source);
    const [b1] = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    const hooks = {
      beforePublishStep: async () => {
        await expireLeases(t.db.pool, s.tenantId, s.sourceId);
        throw new Error('publish step failed');
      },
    };
    await expect(replayBatch({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, batchId: b1.id, hooks })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const replayRun = () => runsOf(t.db.pool, s.tenantId, s.sourceId).then((rs) => rs.find((r) => r.run_kind === 'replay')!);
    expect((await replayRun()).status).toBe('running');
    await sync(s, source);
    expect(await replayRun()).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED' });
  });
});

describe('M1: the re-listed manifest is evidence too', () => {
  /** Versioned fake with real manifest bytes; data AND manifest are replaced right after the first listing. */
  class RacyManifestSource extends FakeFocusSource {
    replaceAfterFirstList: FakePeriod[] | null = null;
    manifests: Buffer[] = [];
    async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
      const out = (await super.listPeriods(range)).map((l) => {
        if (!l.ok) return l;
        const bytes = Buffer.from(JSON.stringify({ control: l.set.control ?? null, files: l.set.artifacts.map((a) => [a.name, a.version]) }));
        this.manifests.push(bytes);
        return { ...l, set: { ...l.set, manifest: { name: 'e-Manifest.json', bytes } } };
      });
      if (this.replaceAfterFirstList) {
        this.setPeriods(this.replaceAfterFirstList);
        this.replaceAfterFirstList = null;
      }
      return out;
    }
    async openArtifact(ref: ArtifactRef): Promise<Readable> {
      const current = (await super.listPeriods()).flatMap((l) => (l.ok ? l.set.artifacts : [])).find((a) => a.name === ref.name);
      if (current && current.version !== ref.version) throw new IngestError('SOURCE_CHANGED', `artifact ${ref.name} changed since it was listed`, { retryable: true });
      return super.openArtifact(ref);
    }
  }

  it('manifest B (the one the published batch was built from) is captured and listed in the run evidence, next to A', async () => {
    const s = await seedTenantSource(t.db.pool);
    const OLD = csvGz(rowsOf(P, 2, '5.00'));
    const NEW = csvGz(rowsOf(P, 3, '1.00'));
    const source = new RacyManifestSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: OLD }], control: { rowCount: 2 } }]);
    source.replaceAfterFirstList = [{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: NEW }], control: { rowCount: 3 } }];
    const evidence = new MemoryEvidenceStore();
    const r = await sync(s, source, {}, evidence);
    expect(r.status).toBe('succeeded');
    expect(r.periods[0]).toMatchObject({ outcome: 'published', reconciliation: 'reconciled' });
    const [a, b] = source.manifests;
    const keys = r.manifestEvidence.map((k) => k.split('/').pop());
    expect(keys).toContain(sha(a));
    expect(keys).toContain(sha(b));
    // The evidence holds B, and B binds what was published (its control = the published row count).
    const keyB = r.manifestEvidence.find((k) => k.endsWith(sha(b)))!;
    const chunks: Buffer[] = [];
    for await (const c of await evidence.open(keyB)) chunks.push(Buffer.from(c as Buffer));
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8')).control).toEqual({ rowCount: 3 });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '3.00' } });
  });
});

describe('M3: MAX_RUN_SECONDS bounds the source listing', () => {
  class EndlessListing extends FakeFocusSource {
    pages = 0;
    pagesAfterAbort = 0;
    sawSignal = false;
    async listPeriods(_range?: PeriodRange, opts?: ListOptions): Promise<PeriodListing[]> {
      this.sawSignal = !!opts?.signal;
      for (;;) {
        if (opts?.signal?.aborted) {
          this.pagesAfterAbort++;
          throw opts.signal.reason;
        }
        this.pages++;
        await new Promise((r) => setTimeout(r, 50)); // one "page"
      }
    }
  }

  it('an endlessly paginating listing is aborted at the deadline: the run fails MAX_RUN_EXCEEDED and the listing stops', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new EndlessListing([]);
    const started = Date.now();
    const r = await sync(s, source, { settings: { maxRunSeconds: 1, leaseTtlSeconds: 30 } as RunSyncOptions['settings'] });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(source.sawSignal).toBe(true);
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('MAX_RUN_EXCEEDED');
    const pages = source.pages;
    await new Promise((res) => setTimeout(res, 300));
    expect(source.pages).toBe(pages); // nothing keeps paginating after the run returned
    expect((await runsOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'failed', error_code: 'MAX_RUN_EXCEEDED' });
  });
});

describe('M4: the batch byte cap holds for CAPTURED bytes', () => {
  class UnderReporting extends FakeFocusSource {
    async listPeriods(range?: PeriodRange): Promise<PeriodListing[]> {
      return (await super.listPeriods(range)).map((l) => (l.ok ? { ...l, set: { ...l.set, artifacts: l.set.artifacts.map((a) => ({ ...a, byteSize: 1 })) } } : l));
    }
  }

  it('sizes under-reported by the listing: capture stops at the remaining allowance, nothing is staged or published', async () => {
    const s = await seedTenantSource(t.db.pool);
    const A = csvGz(rowsOf(P, 40, '1.00', 'a'));
    const B = csvGz(rowsOf(P, 40, '1.00', 'b'));
    const cap = Math.floor((A.length + B.length) * 0.75); // each fits alone, together they do not
    expect(A.length).toBeLessThan(cap);
    const source = new UnderReporting([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }] }]);
    const r = await sync(s, source, { settings: { limits: { maxBatchBytes: cap } } as RunSyncOptions['settings'] });
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE' });
    expect(await batchesOf(t.db.pool, s.tenantId, s.sourceId)).toEqual([]);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });
});

describe('M5: a changed per-artifact control count is never "unchanged"', () => {
  it('same data, one artifact count changed (set total unchanged): the period fails CONTROL_VARIANCE_ON_UNCHANGED, the published batch stays', async () => {
    const s = await seedTenantSource(t.db.pool);
    const A = csvGz(rowsOf(P, 2, '1.00', 'a'));
    const B = csvGz(rowsOf(P, 3, '1.00', 'b'));
    const arts = [{ name: 'r/a.csv.gz', bytes: A }, { name: 'r/b.csv.gz', bytes: B }];
    const source = new FakeFocusSource([{ billingPeriod: P, artifacts: arts, control: { rowCount: 5, artifactRowCounts: { 'r/a.csv.gz': 2, 'r/b.csv.gz': 3 } } }]);
    expect((await sync(s, source)).periods[0]).toMatchObject({ outcome: 'published', reconciliation: 'reconciled' });
    source.setPeriods([{ billingPeriod: P, artifacts: arts, control: { rowCount: 5, artifactRowCounts: { 'r/a.csv.gz': 3, 'r/b.csv.gz': 2 } } }]);
    const r = await sync(s, source);
    expect(r.periods[0].outcome).not.toBe('unchanged');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'CONTROL_VARIANCE_ON_UNCHANGED' });
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['published']);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 5, total: '5.00' } });
  });
});
