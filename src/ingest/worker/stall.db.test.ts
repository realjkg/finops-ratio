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
import { csvGz, focusRow, rowsOf } from '../testing/focusCsv';
import crypto from 'crypto';

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

/** A stream that delivers `bytes` in `parts` pieces, one every `everyMs` (slow but steadily progressing). */
function trickle(bytes: Buffer, parts: number, everyMs: number): Readable {
  const size = Math.ceil(bytes.length / parts);
  let off = 0;
  let timer: NodeJS.Timeout | undefined;
  return new Readable({
    read() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (off >= bytes.length) {
          this.push(null);
          return;
        }
        this.push(bytes.subarray(off, off + size));
        off += size;
      }, everyMs);
    },
    destroy(err, cb) {
      if (timer) clearTimeout(timer);
      cb(err);
    },
  });
}

/** Samples, while `p` runs, whether the run's lease is live; returns all samples. */
async function leaseSamples<T>(tenantId: string, p: Promise<T>): Promise<{ value: T; samples: boolean[] }> {
  const samples: boolean[] = [];
  let done = false;
  const sampler = (async () => {
    while (!done) {
      const r = await t.db.pool.query(`SELECT lease_expires_at > clock_timestamp() AS live FROM ratio.sync_runs WHERE tenant_id = $1 AND status = 'running'`, [tenantId]);
      if (r.rowCount === 1) samples.push(r.rows[0].live);
      await new Promise((res) => setTimeout(res, 300));
    }
  })();
  try {
    return { value: await p, samples };
  } finally {
    done = true;
    await sampler;
  }
}

describe('slow but progressing runs survive (challenger M-3)', () => {
  const settings = { leaseTtlSeconds: 5, stallTimeoutSeconds: 3, maxAttempts: 1 } as RunSyncOptions['settings'];

  it('M3-a: a source trickling one chunk every 0.7 s for ~10 s (stall 3 s, TTL 5 s) succeeds and holds its lease throughout', async () => {
    const s = await seedTenantSource(t.db.pool);
    const bytes = csvGz(rowsOf(P, 3, '2.00'));
    class TricklingSource extends FakeFocusSource {
      async openArtifact(ref: ArtifactRef): Promise<Readable> {
        this.opened.push(ref.name);
        return trickle(bytes, 14, 700);
      }
    }
    const src = new TricklingSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes }] }]);
    const start = Date.now();
    const { value: r, samples } = await leaseSamples(s.tenantId, sync(s, src, { settings }));
    expect(Date.now() - start).toBeGreaterThan(8000);
    expect(r.status).toBe('succeeded');
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.every((x) => x)).toBe(true);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '6.00' } });
  });

  it('M3-b: an evidence read trickling one chunk every 0.7 s for ~10 s (stall 3 s, TTL 5 s) succeeds and holds its lease', async () => {
    const s = await seedTenantSource(t.db.pool);
    class TricklingEvidence extends MemoryEvidenceStore {
      async open(key: string): Promise<Readable> {
        return trickle(this.objects.get(key)!, 14, 700);
      }
    }
    const start = Date.now();
    const { value: r, samples } = await leaseSamples(s.tenantId, sync(s, new FakeFocusSource([period()]), { settings, evidence: new TricklingEvidence() }));
    expect(Date.now() - start).toBeGreaterThan(8000);
    expect(r.status).toBe('succeeded');
    expect(samples.every((x) => x)).toBe(true);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '6.00' } });
  });

  it('M3-c: slow downstream inserts plus a 0.8 x stall hook per chunk are not mistaken for an evidence stall', async () => {
    const s = await seedTenantSource(t.db.pool);
    // ~1500 rows with incompressible tags: far more compressed bytes than the stream
    // buffers hold, so the evidence stream is back-pressured while each chunk is
    // inserted (made slow, 1 s, by a test-only statement trigger) and its hook runs
    // (1.6 s = 0.8 x the 2 s stall limit). Only touch() after each insert keeps the
    // watchdog from firing: ~2.6 s pass between evidence bytes.
    const rows = Array.from({ length: 1500 }, (_, i) =>
      focusRow(P, { BilledCost: '1.00', ResourceId: `r-${i}`, Tags: JSON.stringify({ n: crypto.randomBytes(800).toString('hex') }) }),
    );
    const bytes = csvGz(rows);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    await t.db.pool.query(`CREATE FUNCTION public.s1_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN PERFORM pg_sleep(1.0); RETURN NULL; END $fn$`);
    await t.db.pool.query(`CREATE TRIGGER s1_slow_insert AFTER INSERT ON ratio.cost_facts FOR EACH STATEMENT EXECUTE FUNCTION public.s1_slow_insert()`);
    try {
      let chunks = 0;
      const r = await sync(s, new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes }] }]), {
        settings: { leaseTtlSeconds: 5, stallTimeoutSeconds: 2, maxAttempts: 1, limits: { insertChunkRows: 500 } } as RunSyncOptions['settings'],
        hooks: {
          afterChunk: async () => {
            chunks++;
            await new Promise((res) => setTimeout(res, 1600));
          },
        },
      });
      expect(r.periods[0].code).toBeUndefined();
      expect(r.status).toBe('succeeded');
      expect(chunks).toBe(3);
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1500, total: '1500.00' } });
    } finally {
      await t.db.pool.query(`DROP TRIGGER s1_slow_insert ON ratio.cost_facts`);
      await t.db.pool.query(`DROP FUNCTION public.s1_slow_insert()`);
    }
  });
});

