// One active run per (tenant, source); different tenants run concurrently and
// stay isolated; takeover after lease expiry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, expireLeases, publishedAs, publishedTotals, runsOf, seedTenantSource, type SeededSource } from '../testing/db';
import { csvGz, rowsOf } from '../testing/focusCsv';

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
});
