// Challenger M-1: a stalled source (or evidence read, or a hung step) must not
// hold the lease forever. The run fails visibly within a bounded time, the
// checkpoint does not advance, and the next sync succeeds.
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import type { ArtifactRef } from '../sources/types';
import { runSync, type RunSyncOptions } from './pipeline';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { checkpointOf, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, rowsOf } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const period = (): FakePeriod => ({ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 3, '2.00')) }] });
const neverEmits = () => new Readable({ read() {} });

/** A source whose artifact stream (or open call) never produces anything. */
class StallingSource extends FakeFocusSource {
  constructor(private readonly mode: 'stream' | 'open') {
    super([period()]);
  }
  async openArtifact(ref: ArtifactRef): Promise<Readable> {
    this.opened.push(ref.name);
    if (this.mode === 'open') return new Promise<Readable>(() => undefined);
    return neverEmits();
  }
}

/** Evidence store whose reads never produce anything (stores work normally). */
class StallingEvidence extends MemoryEvidenceStore {
  async open(): Promise<Readable> {
    return neverEmits();
  }
}

const BOUND_MS = 12_000;
/** Resolves with the run result, or fails the test if the run is still going after BOUND_MS. */
async function bounded<T>(p: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`run still in progress after ${BOUND_MS} ms (stalled run never ends)`)), BOUND_MS);
  });
  try {
    const value = await Promise.race([p, deadline]);
    return { value, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({
    pool: t.pool,
    tenantId: s.tenantId,
    sourceKey: s.sourceKey,
    source,
    evidence: new MemoryEvidenceStore(),
    mode: 'sync',
    ...extra,
    settings: { leaseTtlSeconds: 5, stallTimeoutSeconds: 1, maxAttempts: 1, ...extra.settings } as RunSyncOptions['settings'],
    hooks: { ...noSleep, ...extra.hooks },
  });
}

describe('stalled runs end visibly and release the source (M-1)', () => {
  for (const mode of ['stream', 'open'] as const) {
    it(`M1-${mode}: a source ${mode === 'stream' ? 'stream that never emits' : 'open that never resolves'} fails SOURCE_STALLED in bounded time; next sync succeeds`, async () => {
      const s = await seedTenantSource(t.db.pool);
      const { value: r } = await bounded(sync(s, new StallingSource(mode)));
      expect(r.status).toBe('failed');
      expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'SOURCE_STALLED' });
      expect((await runsOf(t.db.pool, s.tenantId, s.sourceId))[0]).toMatchObject({ status: 'failed', error_code: 'SOURCE_STALLED' });
      expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toBeNull();
      const next = await sync(s, new FakeFocusSource([period()]));
      expect(next.status).toBe('succeeded');
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '6.00' } });
    });
  }

  it('M1-evidence: an evidence read that never emits fails EVIDENCE_STALLED in bounded time; nothing published', async () => {
    const s = await seedTenantSource(t.db.pool);
    const { value: r } = await bounded(sync(s, new FakeFocusSource([period()]), { evidence: new StallingEvidence() }));
    expect(r.status).toBe('failed');
    expect(r.periods[0]).toMatchObject({ outcome: 'failed', code: 'EVIDENCE_STALLED' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
    expect(await checkpointOf(t.db.pool, s.tenantId, s.sourceId)).toBeNull();
    expect((await sync(s, new FakeFocusSource([period()]))).status).toBe('succeeded');
  });

  it('M1-heartbeat: a run that makes no progress stops renewing its lease, so another worker can take over', async () => {
    const s = await seedTenantSource(t.db.pool);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atHang = new Promise<void>((r) => (reached = r));
    const hung = sync(s, new FakeFocusSource([period()]), {
      hooks: {
        beforePublish: async () => {
          reached();
          await released; // simulates any step that hangs without progress
        },
      },
    });
    await atHang;
    // Bounded poll: the lease must expire (5 s TTL) because renewal stops after 1 s without progress.
    const start = Date.now();
    for (;;) {
      const r = await t.db.pool.query(`SELECT lease_expires_at < clock_timestamp() AS expired FROM ratio.sync_runs WHERE tenant_id = $1`, [s.tenantId]);
      if (r.rows[0].expired) break;
      if (Date.now() - start > BOUND_MS) throw new Error(`lease still renewed after ${BOUND_MS} ms without progress`);
      await new Promise((res) => setTimeout(res, 250));
    }
    const next = await sync(s, new FakeFocusSource([period()]));
    expect(next.status).toBe('succeeded');
    release();
    await expect(hung).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('M1-maxrun: renewal also stops after the maximum run duration, even while progressing', async () => {
    const s = await seedTenantSource(t.db.pool);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atHang = new Promise<void>((r) => (reached = r));
    const long = sync(s, new FakeFocusSource([period()]), {
      settings: { stallTimeoutSeconds: 3600, maxRunSeconds: 1 } as RunSyncOptions['settings'],
      hooks: {
        beforePublish: async () => {
          reached();
          await released;
        },
      },
    });
    await atHang;
    const start = Date.now();
    for (;;) {
      const r = await t.db.pool.query(`SELECT lease_expires_at < clock_timestamp() AS expired FROM ratio.sync_runs WHERE tenant_id = $1`, [s.tenantId]);
      if (r.rows[0].expired) break;
      if (Date.now() - start > BOUND_MS) throw new Error(`lease still renewed after ${BOUND_MS} ms past the maximum run duration`);
      await new Promise((res) => setTimeout(res, 250));
    }
    release();
    await expect(long).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
});
