// One active run per (tenant, source); different tenants run concurrently and
// stay isolated; takeover after lease expiry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, expireLeases, publishedAs, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, rowsOf } from '../testing/focusCsv';
import { SimulatedCrash } from './types';
import type { ArtifactRef } from '../sources/types';
import type { Readable } from 'stream';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
const period = (name: string, bytes: Buffer): FakePeriod => ({ billingPeriod: P, artifacts: [{ name, bytes }] });

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

function gate() {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  return { release, released };
}

describe('leases and concurrency', () => {
  it('L1 five workers started at once on the same source: exactly one runs, the rest are refused ALREADY_RUNNING', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    let inside = 0;
    const rejected: unknown[] = [];
    let settledEnough!: () => void;
    const fourRejectedAndOneInside = new Promise<void>((r) => (settledEnough = r));
    const check = () => {
      if (rejected.length === 4 && inside === 1) settledEnough();
    };
    const starts = Array.from({ length: 5 }, () =>
      sync(s, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 2)))]), {
        hooks: {
          beforePublish: async () => {
            inside++;
            check();
            await g.released;
          },
        },
      }),
    );
    for (const p of starts) {
      p.catch((e) => {
        rejected.push(e);
        check();
      });
    }
    // Deterministic: resolves only once 4 workers were refused while the 5th holds the lease.
    await fourRejectedAndOneInside;
    for (const r of rejected) expect(r).toMatchObject({ code: 'ALREADY_RUNNING' });
    const running = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.sync_runs WHERE tenant_id = $1 AND status = 'running'`, [s.tenantId]);
    expect(running.rows[0].n).toBe(1);
    expect(inside).toBe(1);
    g.release();
    const final = await Promise.allSettled(starts);
    expect(final.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 2, total: '2.50' } });
    expect(await runsOf(t.db.pool, s.tenantId, s.sourceId)).toHaveLength(1);
  });

  it('L2 two tenants run concurrently, both succeed, and each sees only its own facts', async () => {
    const a = await seedTenantSource(t.db.pool);
    const b = await seedTenantSource(t.db.pool);
    const g = gate();
    let arrived = 0;
    let bothInside!: () => void;
    const both = new Promise<void>((r) => (bothInside = r));
    const hooks = {
      beforePublish: async () => {
        arrived++;
        if (arrived === 2) bothInside();
        await g.released;
      },
    };
    const ra = sync(a, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 2, '1.00', 'tenant-a')))]), { hooks });
    const rb = sync(b, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 3, '7.00', 'tenant-b')))]), { hooks });
    await both;
    g.release();
    expect((await ra).status).toBe('succeeded');
    expect((await rb).status).toBe('succeeded');
    expect(await publishedAs(t.db.pool, 'ratio_reader', a.tenantId)).toMatchObject({ rows: 2, total: '2.00' });
    expect(await publishedAs(t.db.pool, 'ratio_reader', b.tenantId)).toMatchObject({ rows: 3, total: '21.00' });
    const leak = await t.db.pool.query(
      `SELECT count(*)::int AS n FROM ratio.cost_facts WHERE (tenant_id = $1 AND resource_id LIKE 'tenant-b%') OR (tenant_id = $2 AND resource_id LIKE 'tenant-a%')`,
      [a.tenantId, b.tenantId],
    );
    expect(leak.rows[0].n).toBe(0);
  });

  it('L3 acquiring after expiry marks the dead run abandoned (LEASE_EXPIRED) and deletes its staged batches', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    const dead = sync(s, new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 4)))]), {
      hooks: {
        beforePublish: async () => {
          reached();
          await g.released;
        },
      },
    });
    await arrived;
    const staged = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(staged.map((b) => b.status)).toEqual(['staged']);
    await expireLeases(t.db.pool, s.tenantId, s.sourceId);

    const next = await sync(s, new FakeFocusSource([period('r2/a.csv.gz', csvGz(rowsOf(P, 1)))]));
    expect(next.status).toBe('succeeded');
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs[0]).toMatchObject({ status: 'abandoned', error_code: 'LEASE_EXPIRED' });
    const after = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(after.map((b) => b.id)).not.toContain(staged[0].id);
    expect(after.map((b) => b.status)).toEqual(['published']);
    const orphanFacts = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1 AND batch_id = $2`, [s.tenantId, staged[0].id]);
    expect(orphanFacts.rows[0].n).toBe(0);
    g.release();
    await expect(dead).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('L5 a background heartbeat keeps a long-running run\'s lease alive', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    const run = sync(s, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 1)))]), {
      settings: { leaseTtlSeconds: 5 },
      hooks: {
        beforePublish: async () => {
          reached();
          await g.released;
        },
      },
    });
    await arrived;
    const first = await t.db.pool.query(`SELECT heartbeat_at, lease_expires_at FROM ratio.sync_runs WHERE tenant_id = $1`, [s.tenantId]);
    // Poll (no fixed sleep) until the heartbeat has moved the lease forward.
    for (;;) {
      const now = await t.db.pool.query(`SELECT heartbeat_at, lease_expires_at FROM ratio.sync_runs WHERE tenant_id = $1`, [s.tenantId]);
      if (now.rows[0].lease_expires_at.getTime() > first.rows[0].lease_expires_at.getTime()) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    g.release();
    expect((await run).status).toBe('succeeded');
  });

  it('L6 a crashed (simulated dead) run stops heartbeating, so its lease expires', async () => {
    const s = await seedTenantSource(t.db.pool);
    await expect(
      sync(s, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 3)))]), {
        settings: { leaseTtlSeconds: 5, limits: { insertChunkRows: 1 } },
        hooks: {
          afterChunk: () => {
            throw new SimulatedCrash();
          },
        },
      }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    // Poll until the 5 s lease has expired; a still-running heartbeat would keep extending it forever.
    for (;;) {
      const r = await t.db.pool.query(`SELECT lease_expires_at < clock_timestamp() AS expired FROM ratio.sync_runs WHERE tenant_id = $1`, [s.tenantId]);
      if (r.rows[0].expired) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    const recovered = await sync(s, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 3)))]));
    expect(recovered.status).toBe('succeeded');
  });

  it('L1 (challenger) acquiring source X never deletes source Y\'s staged batch in the same tenant', async () => {
    const x = await seedTenantSource(t.db.pool, { sourceKey: 'src-x' });
    const y = await seedTenantSource(t.db.pool, { tenantId: x.tenantId, sourceKey: 'src-y' });
    const g = gate();
    let reached!: () => void;
    const yPaused = new Promise<void>((r) => (reached = r));
    let chunks = 0;
    const runY = sync(y, new FakeFocusSource([period('y/a.csv.gz', csvGz(rowsOf(P, 4, '3.00', 'y')))]), {
      settings: { limits: { insertChunkRows: 2 } },
      hooks: {
        afterChunk: async () => {
          chunks++;
          if (chunks === 1) {
            reached();
            await g.released;
          }
        },
      },
    });
    await yPaused;
    const yStaged = await batchesOf(t.db.pool, y.tenantId, y.sourceId);
    expect(yStaged.map((b) => b.status)).toEqual(['staged']);
    const rx = await sync(x, new FakeFocusSource([period('x/a.csv.gz', csvGz(rowsOf(P, 1, '1.00', 'x')))]));
    expect(rx.status).toBe('succeeded');
    const stillThere = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE batch_id = $1`, [yStaged[0].id]);
    expect(stillThere.rows[0].n).toBe(2);
    g.release();
    expect((await runY).status).toBe('succeeded');
    expect(await publishedTotals(t.db.pool, y.tenantId, y.sourceId)).toEqual({ [P]: { rows: 4, total: '12.00' } });
    expect(await publishedTotals(t.db.pool, x.tenantId, x.sourceId)).toEqual({ [P]: { rows: 1, total: '1.00' } });
  });

  it('L2 (challenger) a zombie whose lease expired cannot record a retry (attempt and retries unchanged)', async () => {
    const s = await seedTenantSource(t.db.pool);
    class ExpiringFailingSource extends FakeFocusSource {
      calls = 0;
      async openArtifact(ref: ArtifactRef): Promise<Readable> {
        this.calls++;
        if (this.calls === 1) {
          await expireLeases(t.db.pool, s.tenantId, s.sourceId);
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        return super.openArtifact(ref);
      }
    }
    const src = new ExpiringFailingSource([period('r/a.csv.gz', csvGz(rowsOf(P, 1)))]);
    await expect(sync(s, src, { settings: { maxAttempts: 3 } })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(run.attempt).toBe(1);
    expect((run.stats as { retries?: unknown[] }).retries ?? []).toEqual([]);
    expect(src.calls).toBe(1);
  });
});

