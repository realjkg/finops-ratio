// A worker acting for tenant A cannot read or change tenant B through any
// worker path, and malformed tenants are refused before any query.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource, type FakePeriod } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync } from './pipeline';
import { replayBatch } from './replay';
import { showBatch } from './quarantine';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { batchesOf, seedTenantSource, snapshotTenant, type SeededSource } from '../testing/db';
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

async function syncAs(s: { tenantId: string; sourceKey: string }, source: FakeFocusSource, evidence = new MemoryEvidenceStore()) {
  return runSync({ pool: t.pool, tenantId: s.tenantId, sourceKey: s.sourceKey, source, evidence, mode: 'sync', hooks: noSleep });
}

describe('tenant escape', () => {
  let a: SeededSource;
  let b: SeededSource;
  let bOnly: SeededSource;
  beforeAll(async () => {
    a = await seedTenantSource(t.db.pool);
    b = await seedTenantSource(t.db.pool);
    bOnly = await seedTenantSource(t.db.pool, { tenantId: b.tenantId, sourceKey: 'b-only-source' });
    await syncAs(b, new FakeFocusSource([period('r/b.csv.gz', csvGz(rowsOf(P, 2, '50.00', 'b')))]));
    const bad = new FakeFocusSource([period('r/q.csv.gz', csvGz([focusRow(P, { BilledCost: '?' })]))]);
    await syncAs(b, bad);
    await syncAs(a, new FakeFocusSource([period('r/a.csv.gz', csvGz(rowsOf(P, 1, '1.00', 'a')))]));
  });

  it('T1 B source keys, batch ids and quarantine reports are NOT_FOUND for tenant A; A syncs never change B', async () => {
    const before = await snapshotTenant(t.db.pool, b.tenantId);
    const bBatches = await batchesOf(t.db.pool, b.tenantId, b.sourceId);
    expect(bBatches.map((x) => x.status)).toEqual(['published', 'quarantined']);

    await expect(syncAs({ tenantId: a.tenantId, sourceKey: bOnly.sourceKey }, new FakeFocusSource([]))).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    for (const batch of bBatches) {
      await expect(replayBatch({ pool: t.pool, tenantId: a.tenantId, sourceKey: a.sourceKey, batchId: batch.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(showBatch(t.pool, a.tenantId, batch.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    const evidence = new MemoryEvidenceStore();
    const r = await syncAs(a, new FakeFocusSource([period('r2/a.csv.gz', csvGz(rowsOf(P, 3, '2.00', 'a')))]), evidence);
    expect(r.status).toBe('succeeded');
    for (const key of evidence.objects.keys()) expect(key.startsWith(`evidence/${a.tenantId}/${a.sourceId}/`)).toBe(true);
    expect(evidence.objects.size).toBeGreaterThan(0);

    expect(await snapshotTenant(t.db.pool, b.tenantId)).toEqual(before);
  });

  it('T2 malformed or missing tenant ids are refused before any query', async () => {
    const runsBefore = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.sync_runs`);
    for (const bad of ['', 'not-a-uuid', `${a.tenantId}' OR '1'='1`, a.tenantId.toUpperCase() + 'x']) {
      await expect(syncAs({ tenantId: bad, sourceKey: a.sourceKey }, new FakeFocusSource([]))).rejects.toMatchObject({ code: 'INVALID_TENANT' });
      await expect(replayBatch({ pool: t.pool, tenantId: bad, sourceKey: a.sourceKey, batchId: a.tenantId })).rejects.toMatchObject({ code: 'INVALID_TENANT' });
      await expect(showBatch(t.pool, bad, a.tenantId)).rejects.toMatchObject({ code: 'INVALID_TENANT' });
    }
    const runsAfter = await t.db.pool.query(`SELECT count(*)::int AS n FROM ratio.sync_runs`);
    expect(runsAfter.rows[0].n).toBe(runsBefore.rows[0].n);
  });
});
