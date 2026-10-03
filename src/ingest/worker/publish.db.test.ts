// Partial-publication and fencing guarantees of the publish/quarantine
// transactions, with failures injected at every step and zombie workers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync, type RunSyncOptions } from './pipeline';
import { PUBLISH_STEPS } from './publish';
import { heartbeat } from './lease';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import {
  batchesOf,
  checkpointOf,
  expireLeases,
  publishedAs,
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
const period = (name: string, bytes: Buffer, control?: FakePeriod['control']): FakePeriod => ({ billingPeriod: P, artifacts: [{ name, bytes }], control });

function sync(s: SeededSource, source: FakeFocusSource, extra: Partial<RunSyncOptions> = {}) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence: new MemoryEvidenceStore(), mode: 'sync', ...extra, hooks: { ...noSleep, ...extra.hooks } });
}

async function visibleState(s: SeededSource) {
  const pubs = await t.db.pool.query(`SELECT to_jsonb(p)::text AS j FROM ratio.period_publications p WHERE tenant_id = $1 ORDER BY 1`, [s.tenantId]);
  const statuses = await t.db.pool.query(`SELECT id, status, published_at, superseded_at FROM ratio.ingest_batches WHERE tenant_id = $1 ORDER BY created_at, id`, [s.tenantId]);
  return {
    view: await publishedAs(t.db.pool, 'ratio_reader', s.tenantId),
    totals: await publishedTotals(t.db.pool, s.tenantId, s.sourceId),
    pubs: pubs.rows.map((r) => r.j),
    checkpoint: await checkpointOf(t.db.pool, s.tenantId, s.sourceId),
    batches: statuses.rows.map((r) => JSON.stringify(r)),
  };
}

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  return { release, reached, released, arrived };
}

describe('publish transaction: no partial publication', () => {
  it('publish steps are the documented, complete sequence', () => {
    expect([...PUBLISH_STEPS].sort()).toEqual(['advance_checkpoint', 'commit', 'lock_period', 'lock_run', 'mark_published', 'supersede_prior', 'upsert_publication']);
    expect(PUBLISH_STEPS[0]).toBe('lock_run');
    expect(PUBLISH_STEPS.at(-1)).toBe('commit');
  });

  for (const step of PUBLISH_STEPS) {
    it(`P1 failure injected at "${step}" leaves view, publications, batches and checkpoint unchanged; a later run recovers`, async () => {
      const s = await seedTenantSource(t.db.pool);
      const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 2, '5.00')))]);
      await sync(s, source);
      const before = await visibleState(s);
      expect(before.view.rows).toBe(2);

      source.setPeriods([period('r2/a.csv.gz', csvGz(rowsOf(P, 3, '1.00')))]);
      const r = await sync(s, source, {
        hooks: {
          beforePublishStep: (st) => {
            if (st === step) throw new Error(`injected failure at ${st}`);
          },
        },
      });
      expect(r.status).toBe('failed');
      expect(r.periods[0].outcome).toBe('failed');
      const after = await visibleState(s);
      expect(after.view).toEqual(before.view);
      expect(after.totals).toEqual(before.totals);
      expect(after.pubs).toEqual(before.pubs);
      expect(after.checkpoint).toEqual(before.checkpoint);
      // Pre-existing batches unchanged; the new one exists only as staged.
      expect(after.batches.slice(0, before.batches.length)).toEqual(before.batches);
      const all = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
      expect(all.map((b) => b.status)).toEqual(['published', 'staged']);

      const ok = await sync(s, source);
      expect(ok.periods[0].outcome).toBe('published');
      expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 3, total: '3.00' } });
      expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['superseded', 'published']);
    });
  }

  it('P2 failure inside the quarantine transaction leaves the batch staged (never published) and the view unchanged', async () => {
    const s = await seedTenantSource(t.db.pool);
    const source = new FakeFocusSource([period('r1/a.csv.gz', csvGz(rowsOf(P, 1, '4.00')))]);
    await sync(s, source);
    const before = await visibleState(s);
    source.setPeriods([period('r2/a.csv.gz', csvGz([focusRow(P, { BilledCost: 'oops' })]))]);
    const r = await sync(s, source, {
      hooks: {
        beforeQuarantineCommit: () => {
          throw new Error('injected quarantine failure');
        },
      },
    });
    expect(r.status).toBe('failed');
    const after = await visibleState(s);
    expect(after.view).toEqual(before.view);
    expect(after.pubs).toEqual(before.pubs);
    expect(after.checkpoint).toEqual(before.checkpoint);
    const all = await batchesOf(t.db.pool, s.tenantId, s.sourceId);
    expect(all.map((b) => b.status)).toEqual(['published', 'staged']);
    const errs = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.ingest_validation_errors WHERE tenant_id = $1`, [s.tenantId]);
    expect(errs.rows[0].n).toBe(0);
  });
});

describe('zombie fencing', () => {
  it('P3 run A loses its lease, run B takes over and publishes, A then fails at publish and cannot touch its run row', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    const sourceA = new FakeFocusSource([period('rA/a.csv.gz', csvGz(rowsOf(P, 2, '100.00')))]);
    const sourceB = new FakeFocusSource([period('rB/a.csv.gz', csvGz(rowsOf(P, 1, '1.00')))]);
    const runA = sync(s, sourceA, {
      hooks: {
        beforePublish: async () => {
          g.reached();
          await g.released;
        },
      },
    });
    await g.arrived;
    const aRun = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    expect(aRun.status).toBe('running');
    expect(await expireLeases(t.db.pool, s.tenantId, s.sourceId)).toBe(1);

    const b = await sync(s, sourceB);
    expect(b.status).toBe('succeeded');
    expect(b.periods[0].outcome).toBe('published');
    g.release();
    await expect(runA).rejects.toMatchObject({ code: 'LEASE_LOST' });

    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 1, total: '1.00' } });
    const runs = await runsOf(t.db.pool, s.tenantId, s.sourceId);
    expect(runs.map((r) => [r.id === aRun.id ? 'A' : 'B', r.status])).toEqual([
      ['A', 'abandoned'],
      ['B', 'succeeded'],
    ]);
    expect(runs[0].error_code).toBe('LEASE_EXPIRED');
    const pub = await t.db.pool.query(`SELECT published_by_run_id FROM ratio.period_publications WHERE tenant_id = $1`, [s.tenantId]);
    expect(pub.rows[0].published_by_run_id).toBe(b.runId);
  });

  it('P4 an expired lease without takeover still fails at publish; heartbeat cannot revive it', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    const runA = sync(s, new FakeFocusSource([period('rA/a.csv.gz', csvGz(rowsOf(P, 2)))]), {
      hooks: {
        beforePublish: async () => {
          g.reached();
          await g.released;
        },
      },
    });
    await g.arrived;
    await expireLeases(t.db.pool, s.tenantId, s.sourceId);
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    await expect(heartbeat(t.pool, s.tenantId, run.id, run.lease_token!, 300)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const still = await t.db.pool.query(`SELECT lease_expires_at < clock_timestamp() AS expired FROM ratio.sync_runs WHERE id = $1`, [run.id]);
    expect(still.rows[0].expired).toBe(true);
    g.release();
    await expect(runA).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
    expect((await batchesOf(t.db.pool, s.tenantId, s.sourceId)).map((b) => b.status)).toEqual(['staged']);
  });

  it('L4 heartbeat extends a live lease', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    const runA = sync(s, new FakeFocusSource([period('rA/a.csv.gz', csvGz(rowsOf(P, 1)))]), {
      hooks: {
        beforePublish: async () => {
          g.reached();
          await g.released;
        },
      },
    });
    await g.arrived;
    const run = (await runsOf(t.db.pool, s.tenantId, s.sourceId))[0];
    const before = await t.db.pool.query(`SELECT lease_expires_at FROM ratio.sync_runs WHERE id = $1`, [run.id]);
    await heartbeat(t.pool, s.tenantId, run.id, run.lease_token!, 3600);
    const after = await t.db.pool.query(`SELECT lease_expires_at, heartbeat_at FROM ratio.sync_runs WHERE id = $1`, [run.id]);
    expect(after.rows[0].lease_expires_at.getTime()).toBeGreaterThan(before.rows[0].lease_expires_at.getTime());
    await expect(heartbeat(t.pool, s.tenantId, run.id, '00000000-0000-4000-8000-000000000000', 300)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    g.release();
    expect((await runA).status).toBe('succeeded');
  });

  it('P5 a zombie cannot insert further chunks after takeover', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    const bytes = csvGz(rowsOf(P, 6, '2.00'));
    let chunks = 0;
    const runA = sync(s, new FakeFocusSource([period('r/a.csv.gz', bytes)]), {
      settings: { limits: { insertChunkRows: 2 } },
      hooks: {
        afterChunk: async () => {
          chunks++;
          if (chunks === 1) {
            g.reached();
            await g.released;
          }
        },
      },
    });
    await g.arrived;
    await expireLeases(t.db.pool, s.tenantId, s.sourceId);
    const b = await sync(s, new FakeFocusSource([period('r/a.csv.gz', bytes)]), { settings: { limits: { insertChunkRows: 2 } } });
    expect(b.periods[0].outcome).toBe('published');
    g.release();
    await expect(runA).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(chunks).toBe(1);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({ [P]: { rows: 6, total: '12.00' } });
    const facts = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1`, [s.tenantId]);
    expect(facts.rows[0].n).toBe(6);
  });

  it('P6 an expired lease stops a zombie at its next chunk even without a takeover', async () => {
    const s = await seedTenantSource(t.db.pool);
    const g = gate();
    let chunks = 0;
    const runA = sync(s, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 6, '2.00')))]), {
      settings: { limits: { insertChunkRows: 2 } },
      hooks: {
        afterChunk: async () => {
          chunks++;
          if (chunks === 1) {
            g.reached();
            await g.released;
          }
        },
      },
    });
    await g.arrived;
    await expireLeases(t.db.pool, s.tenantId, s.sourceId);
    g.release();
    await expect(runA).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(chunks).toBe(1);
    const facts = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.cost_facts WHERE tenant_id = $1`, [s.tenantId]);
    expect(facts.rows[0].n).toBe(2);
    expect(await publishedTotals(t.db.pool, s.tenantId, s.sourceId)).toEqual({});
  });
});

