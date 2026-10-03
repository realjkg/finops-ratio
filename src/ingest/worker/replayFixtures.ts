// `worker replay-fixtures`: runs the deterministic SYNTHETIC fixture scenarios
// (clean load, idempotent rerun, restatement supersession, reconciliation
// variance rejection, crash mid-load + recovery, zombie fencing) against an
// isolated tenant created for the run, through the real S3 source and evidence
// store, verifies each outcome, then deletes that tenant's database rows and
// the uploaded synthetic source objects. Evidence objects are retained (D6: no
// evidence deletion code in this cycle). Refused unless RATIO_ENV is staging/test
// (checked by the CLI before anything connects).
import crypto from 'crypto';
import { Client, type Pool } from 'pg';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { IngestError, errorCodeOf, messageOf } from '../errors';
import { redact } from '../redact';
import { withTenantTransaction } from '../db/tenant';
import { generateSyntheticExport, type FixtureVariant } from '../fixtures/syntheticFocus';
import { S3FocusExportSource } from '../sources/s3/S3FocusExportSource';
import type { EvidenceStore } from '../evidence/types';
import { runSync, type LogFn } from './pipeline';
import { SimulatedCrash } from './types';

export interface ScenarioResult {
  name: string;
  pass: boolean;
  detail?: unknown;
}

export interface ReplayFixturesResult {
  pass: boolean;
  tenantId: string;
  scenarios: ScenarioResult[];
  cleanup: { pass: boolean; detail?: string };
}

const EXPORT = 'focus-export';
const SOURCES = ['fx-main', 'fx-crash', 'fx-zombie'] as const;

export async function runReplayFixtures(opts: {
  workerPool: Pool;
  adminUrl: string;
  sourceClient: S3Client;
  bucket: string;
  evidence: EvidenceStore;
  log?: LogFn;
  secrets?: readonly string[];
}): Promise<ReplayFixturesResult> {
  const log = opts.log ?? (() => undefined);
  const tenantId = crypto.randomUUID();
  const prefixOf = (key: string) => `ratio-replay-fixtures/${tenantId}/${key}`;
  const scenarios: ScenarioResult[] = [];
  const admin = new Client({ connectionString: opts.adminUrl, application_name: 'ratio-replay-fixtures' });
  admin.on('error', () => undefined);
  await admin.connect();

  const asTenant = async <T>(c: Client, fn: () => Promise<T>): Promise<T> => {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [tenantId]);
      const r = await fn();
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  };

  const upload = async (sourceKey: string, variant: FixtureVariant) => {
    for (const o of generateSyntheticExport({ variant, prefix: prefixOf(sourceKey), exportName: EXPORT }).objects) {
      await opts.sourceClient.send(new PutObjectCommand({ Bucket: opts.bucket, Key: o.key, Body: o.bytes }));
    }
  };
  const expected = (variant: FixtureVariant) =>
    Object.fromEntries(Object.entries(generateSyntheticExport({ variant }).totals).map(([p, t]) => [p, { rows: t.rowCount, total: t.billedTotal }]));

  const totals = (sourceKey: string) =>
    withTenantTransaction(opts.workerPool, tenantId, async (c) => {
      const r = await c.query(
        `SELECT v.billing_period::text AS p, count(*)::int AS n, sum(v.billed_cost)::text AS total
         FROM ratio.cost_facts_published v JOIN ratio.sources s ON s.tenant_id = v.tenant_id AND s.id = v.source_id
         WHERE s.source_key = $1 GROUP BY 1 ORDER BY 1`,
        [sourceKey],
      );
      return Object.fromEntries(r.rows.map((x) => [x.p, { rows: x.n, total: x.total }]));
    });
  const batchStatuses = (sourceKey: string) =>
    withTenantTransaction(opts.workerPool, tenantId, async (c) => {
      const r = await c.query(
        `SELECT b.billing_period::text AS p, b.status, b.reconciliation FROM ratio.ingest_batches b
         JOIN ratio.sources s ON s.tenant_id = b.tenant_id AND s.id = b.source_id WHERE s.source_key = $1 ORDER BY b.created_at, b.id`,
        [sourceKey],
      );
      return r.rows.map((x) => `${x.p}:${x.status}:${x.reconciliation}`);
    });
  const expireLease = (sourceKey: string) =>
    withTenantTransaction(opts.workerPool, tenantId, async (c) => {
      const r = await c.query(
        `UPDATE ratio.sync_runs r SET lease_expires_at = clock_timestamp() - interval '1 second'
         FROM ratio.sources s WHERE s.tenant_id = r.tenant_id AND s.id = r.source_id AND s.source_key = $1 AND r.status = 'running'`,
        [sourceKey],
      );
      return r.rowCount ?? 0;
    });
  const sync = (sourceKey: string, extra: Partial<Parameters<typeof runSync>[0]> = {}) =>
    runSync({
      pool: opts.workerPool,
      tenantId,
      sourceKey,
      source: new S3FocusExportSource({ client: opts.sourceClient, location: { bucket: opts.bucket, prefix: prefixOf(sourceKey), exportName: EXPORT } }),
      evidence: opts.evidence,
      mode: 'sync',
      log,
      secrets: opts.secrets,
      ...extra,
    });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const scenario = async (name: string, fn: () => Promise<{ pass: boolean; detail?: unknown }>) => {
    try {
      const r = await fn();
      scenarios.push({ name, ...r });
    } catch (e) {
      scenarios.push({ name, pass: false, detail: { error: errorCodeOf(e), message: redact(messageOf(e), opts.secrets ?? []).slice(0, 500) } });
    }
    log('replay_fixtures.scenario', { name, pass: scenarios.at(-1)!.pass });
  };

  let cleanup: ReplayFixturesResult['cleanup'];
  try {
    await asTenant(admin, async () => {
      await admin.query(`INSERT INTO ratio.tenants (id, slug) VALUES ($1, $2)`, [tenantId, `fixture-${tenantId.slice(0, 8)}`]);
      for (const key of SOURCES) {
        await admin.query(
          `INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, declared_focus_version, config)
           VALUES ($1, $2, $3, 'focus_file', 'Synthetic replay fixture', 'public_cloud', '1.0', $4)`,
          [tenantId, crypto.randomUUID(), key, JSON.stringify({ layout: 'aws-data-exports', bucket: opts.bucket, prefix: prefixOf(key), exportName: EXPORT })],
        );
      }
    });
    for (const key of SOURCES) await upload(key, 'base');

    await scenario('clean_load', async () => {
      const r = await sync('fx-main');
      const t = await totals('fx-main');
      return { pass: r.status === 'succeeded' && same(t, expected('base')), detail: { status: r.status, totals: t } };
    });
    await scenario('idempotent_rerun', async () => {
      const before = await batchStatuses('fx-main');
      const r = await sync('fx-main');
      const after = await batchStatuses('fx-main');
      const t = await totals('fx-main');
      const pass = r.status === 'succeeded' && r.periods.every((p) => p.outcome === 'skipped_unchanged') && same(before, after) && same(t, expected('base'));
      return { pass, detail: { outcomes: r.periods.map((p) => p.outcome), batches: after.length } };
    });
    await scenario('restatement_supersession', async () => {
      await upload('fx-main', 'restatement');
      const r = await sync('fx-main');
      const t = await totals('fx-main');
      const statuses = await batchStatuses('fx-main');
      const july = statuses.filter((s) => s.startsWith('2026-07-01'));
      const pass = r.status === 'succeeded' && same(t, expected('restatement')) && july.length === 2 && july[0].includes(':superseded:') && july[1].includes(':published:');
      return { pass, detail: { totals: t, july } };
    });
    await scenario('reconciliation_variance_rejection', async () => {
      const before = await totals('fx-main');
      await upload('fx-main', 'variance');
      const r = await sync('fx-main');
      const aug = r.periods.find((p) => p.billingPeriod === '2026-08-01');
      const after = await totals('fx-main');
      const pass = r.status === 'failed' && aug?.outcome === 'quarantined' && aug.reconciliation === 'variance' && same(before, after);
      return { pass, detail: { outcome: aug?.outcome, code: aug?.code, totalsUnchanged: same(before, after) } };
    });
    await scenario('crash_mid_load_recovery', async () => {
      let crashed = false;
      try {
        await sync('fx-crash', {
          settings: { limits: { insertChunkRows: 10 } },
          hooks: {
            afterChunk: () => {
              throw new SimulatedCrash('simulated process death after the first chunk');
            },
          },
        });
      } catch (e) {
        crashed = e instanceof SimulatedCrash;
      }
      const visibleAfterCrash = await totals('fx-crash');
      let refused = false;
      try {
        await sync('fx-crash');
      } catch (e) {
        refused = e instanceof IngestError && e.code === 'ALREADY_RUNNING';
      }
      const expired = await expireLease('fx-crash');
      const r = await sync('fx-crash');
      const t = await totals('fx-crash');
      const pass = crashed && same(visibleAfterCrash, {}) && refused && expired === 1 && r.status === 'succeeded' && same(t, expected('base'));
      return { pass, detail: { crashed, visibleAfterCrash, refusedWhileLeaseLive: refused, recovered: r.status } };
    });
    await scenario('zombie_fencing', async () => {
      let release!: () => void;
      const released = new Promise<void>((res) => (release = res));
      let reached!: () => void;
      const atPublish = new Promise<void>((res) => (reached = res));
      const zombie = sync('fx-zombie', {
        hooks: {
          beforePublish: async () => {
            reached();
            await released;
          },
        },
      });
      const zombieOutcome = zombie.then(
        () => 'completed',
        (e) => (e instanceof IngestError ? e.code : 'ERROR'),
      );
      await atPublish;
      const expired = await expireLease('fx-zombie');
      const winner = await sync('fx-zombie');
      release();
      const z = await zombieOutcome;
      const t = await totals('fx-zombie');
      const pass = expired === 1 && winner.status === 'succeeded' && z === 'LEASE_LOST' && same(t, expected('base'));
      return { pass, detail: { zombie: z, winner: winner.status } };
    });
  } finally {
    cleanup = await cleanUp(admin, tenantId, opts, prefixOf);
    await admin.end().catch(() => undefined);
  }
  const pass = scenarios.length === 6 && scenarios.every((s) => s.pass) && cleanup.pass;
  return { pass, tenantId, scenarios, cleanup };
}

async function cleanUp(
  admin: Client,
  tenantId: string,
  opts: { sourceClient: S3Client; bucket: string; secrets?: readonly string[] },
  prefixOf: (k: string) => string,
): Promise<{ pass: boolean; detail?: string }> {
  const problems: string[] = [];
  try {
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('ratio.tenant_id', $1, true)`, [tenantId]);
    for (const table of ['cost_facts', 'ingest_validation_errors', 'period_publications', 'source_checkpoints', 'ingest_artifacts', 'ingest_batches', 'sync_runs', 'sources']) {
      await admin.query(`DELETE FROM ratio.${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await admin.query(`DELETE FROM ratio.tenants WHERE id = $1`, [tenantId]);
    await admin.query('COMMIT');
  } catch (e) {
    await admin.query('ROLLBACK').catch(() => undefined);
    problems.push(`database cleanup failed: ${errorCodeOf(e)} ${redact(messageOf(e), opts.secrets ?? []).slice(0, 300)}`);
  }
  try {
    for (const key of SOURCES) {
      let token: string | undefined;
      do {
        const r = await opts.sourceClient.send(new ListObjectsV2Command({ Bucket: opts.bucket, Prefix: `${prefixOf(key)}/`, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) await opts.sourceClient.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: o.Key }));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
    }
  } catch (e) {
    problems.push(`source object cleanup failed: ${errorCodeOf(e)}`);
  }
  return problems.length ? { pass: false, detail: problems.join('; ') } : { pass: true };
}
