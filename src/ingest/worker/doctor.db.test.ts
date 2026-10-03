// `worker doctor`: read-only health checks with a non-zero result on any failure.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync } from './pipeline';
import { runDoctor, type DoctorCheck } from './doctor';
import { DEFAULT_MIGRATIONS_DIR } from '../db/migrationFiles';
import { workerTestDb, noSleep, type WorkerTestDb } from '../testing/workerSetup';
import { seedTenantSource, snapshotTenant, type SeededSource } from '../testing/db';
import { csvGz, focusRow, rowsOf } from '../testing/focusCsv';

let t: WorkerTestDb;
beforeAll(async () => {
  t = await workerTestDb();
});
afterAll(async () => {
  await t.close();
});

const P = '2026-07-01';
async function syncOk(s: SeededSource) {
  return runSync({
    pool: t.pool,
    tenantId: s.tenantId,
    sourceKey: s.sourceKey,
    source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz(rowsOf(P, 1)) }] }]),
    evidence: new MemoryEvidenceStore(),
    mode: 'sync',
    hooks: noSleep,
  });
}
const byName = (checks: DoctorCheck[], name: string) => checks.find((c) => c.name === name);

describe('doctor', () => {
  it('D1 healthy: every check passes', async () => {
    const s = await seedTenantSource(t.db.pool);
    await syncOk(s);
    const r = await runDoctor({ workerUrl: t.login.url, migrateUrl: t.db.url, tenantIds: [s.tenantId], maxStalenessHours: 48 });
    expect(r.pass).toBe(true);
    for (const name of ['db_connectivity', 'role_safety', 'migration_version', `source:${s.tenantId}/${s.sourceKey}`]) {
      expect(byName(r.checks, name), name).toMatchObject({ status: 'pass' });
    }
    const src = byName(r.checks, `source:${s.tenantId}/${s.sourceKey}`)!;
    expect(src.data).toMatchObject({ lastRunStatus: 'succeeded', publishedPeriods: 1 });
  });

  it('D1 superuser connection ⇒ role_safety fails', async () => {
    const r = await runDoctor({ workerUrl: t.db.url, migrateUrl: t.db.url, tenantIds: [], maxStalenessHours: 48 });
    expect(r.pass).toBe(false);
    expect(byName(r.checks, 'role_safety')).toMatchObject({ status: 'fail' });
    expect(byName(r.checks, 'db_connectivity')).toMatchObject({ status: 'pass' });
  });

  it('D1 schema behind the code ⇒ migration_version fails; ledger unavailable ⇒ fails (never skipped)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-doctor-'));
    try {
      for (const f of fs.readdirSync(DEFAULT_MIGRATIONS_DIR)) fs.copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, '9999_future.up.sql'), '-- ratio:phase expand\nSELECT 1;\n');
      const r = await runDoctor({ workerUrl: t.login.url, migrateUrl: t.db.url, tenantIds: [], maxStalenessHours: 48, migrationsDir: dir });
      expect(r.pass).toBe(false);
      expect(byName(r.checks, 'migration_version')).toMatchObject({ status: 'fail', data: expect.objectContaining({ problems: ['PENDING'] }) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const noLedger = await runDoctor({ workerUrl: t.login.url, tenantIds: [], maxStalenessHours: 48 });
    expect(noLedger.pass).toBe(false);
    expect(byName(noLedger.checks, 'migration_version')).toMatchObject({ status: 'fail' });
    expect(byName(noLedger.checks, 'migration_version')!.detail).toMatch(/MIGRATION_STATUS_UNAVAILABLE/);
  });

  it('D1 last run failed, stale data, or never succeeded ⇒ source check fails; disabled source skipped', async () => {
    const failed = await seedTenantSource(t.db.pool);
    await runSync({
      pool: t.pool,
      tenantId: failed.tenantId,
      sourceKey: failed.sourceKey,
      source: new FakeFocusSource([{ billingPeriod: P, artifacts: [{ name: 'r/a.csv.gz', bytes: csvGz([focusRow(P, { BilledCost: 'x' })]) }] }]),
      evidence: new MemoryEvidenceStore(),
      mode: 'sync',
      hooks: noSleep,
    });
    const stale = await seedTenantSource(t.db.pool);
    await syncOk(stale);
    await t.db.pool.query(`UPDATE ratio.sync_runs SET started_at = now() - interval '100 hours', finished_at = now() - interval '99 hours' WHERE tenant_id = $1`, [stale.tenantId]);
    const never = await seedTenantSource(t.db.pool);
    const disabled = await seedTenantSource(t.db.pool, { enabled: false });

    const snaps = await Promise.all([failed, stale, never, disabled].map((s) => snapshotTenant(t.db.pool, s.tenantId)));
    const r = await runDoctor({
      workerUrl: t.login.url,
      migrateUrl: t.db.url,
      tenantIds: [failed.tenantId, stale.tenantId, never.tenantId, disabled.tenantId],
      maxStalenessHours: 48,
    });
    expect(r.pass).toBe(false);
    expect(byName(r.checks, `source:${failed.tenantId}/${failed.sourceKey}`)).toMatchObject({ status: 'fail', data: expect.objectContaining({ lastRunStatus: 'failed' }) });
    expect(byName(r.checks, `source:${stale.tenantId}/${stale.sourceKey}`)).toMatchObject({ status: 'fail' });
    expect(byName(r.checks, `source:${stale.tenantId}/${stale.sourceKey}`)!.detail).toMatch(/STALE/);
    expect(byName(r.checks, `source:${never.tenantId}/${never.sourceKey}`)).toMatchObject({ status: 'fail' });
    expect(byName(r.checks, `source:${never.tenantId}/${never.sourceKey}`)!.detail).toMatch(/NEVER_SUCCEEDED/);
    expect(byName(r.checks, `source:${disabled.tenantId}/${disabled.sourceKey}`)).toMatchObject({ status: 'skip' });

    // Read-only: nothing changed for any tenant.
    const after = await Promise.all([failed, stale, never, disabled].map((s) => snapshotTenant(t.db.pool, s.tenantId)));
    expect(after).toEqual(snaps);
  });
});
