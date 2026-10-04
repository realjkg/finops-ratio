// Issue #62, challenger M-A (fresh review at 12a0c97): replay-fixtures must
// never hang. When every period quarantines (here: the synthetic-provider
// opt-in is off, so every SyntheticCloud row is excluded ⇒ PROVIDER_MISMATCH),
// the zombie_fencing scenario never reaches beforePublish. It must report
// pass:false promptly, and the admin client must always be ended.
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runReplayFixtures } from './replayFixtures';
import { workerTestDb, type WorkerTestDb } from '../testing/workerSetup';
import { createTestBucket, requireTestS3Endpoint, type TestBucket } from '../testing/s3';
import { requireTestDatabaseUrl } from '../db/testing/requireTestDatabaseUrl';
import { Client } from 'pg';

requireTestS3Endpoint();

let t: WorkerTestDb;
let fx: TestBucket;
const prefixes: string[] = [];
beforeAll(async () => {
  t = await workerTestDb();
  fx = await createTestBucket('fx62');
});
afterAll(async () => {
  for (const prefix of prefixes) for (const k of await fx.keys(`${prefix}/`)) await fx.client.send(new DeleteObjectCommand({ Bucket: fx.name, Key: k }));
  await fx?.destroy();
  await t?.close();
});

async function adminConnections(): Promise<number> {
  // Scoped to THIS test database: K5 (cliWorker.db.test.ts) runs replay-fixtures with the same
  // application_name in parallel against the same cluster (challenger L-1).
  const r = await t.db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'ratio-replay-fixtures' AND datname = current_database()`);
  return r.rows[0].n;
}

describe('L-1 the connection count is scoped to this test database (no collision with K5 or any other database)', () => {
  it('ignores an idle ratio-replay-fixtures session connected to a different database', async () => {
    // The challenger's reproduction: an idle session with the same application_name, in `postgres`.
    const url = new URL(requireTestDatabaseUrl(process.env));
    url.pathname = '/postgres';
    const other = new Client({ connectionString: url.toString(), application_name: 'ratio-replay-fixtures' });
    await other.connect();
    try {
      const seen = await t.db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'ratio-replay-fixtures' AND datname = 'postgres'`);
      expect(seen.rows[0].n).toBeGreaterThanOrEqual(1);
      expect(await adminConnections()).toBe(0);
    } finally {
      await other.end();
    }
  });
});

describe('M-A replay-fixtures under a policy that quarantines everything', () => {
  // The per-test timeout IS the bound: a hang fails this test instead of passing it.
  it('returns pass:false promptly (zombie_fencing included) and ends its admin client', { timeout: 60_000 }, async () => {
    const started = Date.now();
    const r = await runReplayFixtures({
      workerPool: t.pool,
      adminUrl: t.db.url,
      sourceClient: fx.client,
      bucket: fx.name,
      evidence: new MemoryEvidenceStore(),
      allowSyntheticProviders: false,
    });
    prefixes.push(r.retained.sourcePrefix);
    expect(r.pass).toBe(false);
    expect(r.scenarios.map((s) => s.name)).toEqual([
      'clean_load',
      'idempotent_rerun',
      'restatement_supersession',
      'reconciliation_variance_rejection',
      'crash_mid_load_recovery',
      'zombie_fencing',
    ]);
    const zombie = r.scenarios.find((s) => s.name === 'zombie_fencing')!;
    expect(zombie.pass).toBe(false);
    expect(zombie.detail).toMatchObject({ reachedPublish: false });
    expect(r.scenarios.find((s) => s.name === 'clean_load')!.pass).toBe(false);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(await adminConnections()).toBe(0);
  });
});

describe('F1 (Copilot r4178520620) a failing expireLease in zombie_fencing still releases the zombie', () => {
  it('the zombie is released, its run finishes (no running run, no live heartbeat), and the scenario fails promptly', { timeout: 60_000 }, async () => {
    const r = await runReplayFixtures({
      workerPool: t.pool,
      adminUrl: t.db.url,
      sourceClient: fx.client,
      bucket: fx.name,
      evidence: new MemoryEvidenceStore(),
      allowSyntheticProviders: true,
      testHooks: {
        beforeExpireLease: (sourceKey) => {
          if (sourceKey === 'fx-zombie') throw new Error('injected expireLease fault (F1)');
        },
      },
    });
    prefixes.push(r.retained.sourcePrefix);
    expect(r.pass).toBe(false);
    const byName = Object.fromEntries(r.scenarios.map((s) => [s.name, s]));
    // Every scenario before zombie_fencing is unaffected by the fault.
    for (const name of ['clean_load', 'idempotent_rerun', 'restatement_supersession', 'reconciliation_variance_rejection', 'crash_mid_load_recovery']) {
      expect(byName[name].pass, name).toBe(true);
    }
    expect(byName.zombie_fencing.pass).toBe(false);
    expect(JSON.stringify(byName.zombie_fencing.detail)).toContain('injected expireLease fault (F1)');
    // Released: the zombie's run is no longer running, and nothing heartbeats after the call returned.
    const heartbeats = async () =>
      (
        await t.db.pool.query(
          `SELECT r.status, r.heartbeat_at::text AS hb FROM ratio.sync_runs r JOIN ratio.sources s ON s.tenant_id = r.tenant_id AND s.id = r.source_id
           WHERE r.tenant_id = $1 AND s.source_key = 'fx-zombie' ORDER BY r.started_at`,
          [r.tenantId],
        )
      ).rows as Array<{ status: string; hb: string }>;
    const runs = await heartbeats();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.filter((x) => x.status === 'running')).toEqual([]);
    await new Promise((res) => setTimeout(res, 1500));
    expect(await heartbeats()).toEqual(runs);
    expect(await adminConnections()).toBe(0);
  });
});
