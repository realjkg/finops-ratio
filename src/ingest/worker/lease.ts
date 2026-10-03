// Run leases (rule 7): one active run per (tenant, source), acquired under a
// transaction-scoped advisory lock; heartbeats extend only a live lease; every
// write a run makes is fenced on (run id, lease token, running, unexpired).
import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { IngestError } from '../errors';
import { workerTransaction } from './tx';

export interface SourceRow {
  tenantId: string;
  id: string;
  sourceKey: string;
  kind: 'focus_file' | 'fake';
  enabled: boolean;
  config: Record<string, unknown>;
  declaredFocusVersion: string | null;
}

export interface Lease {
  tenantId: string;
  sourceId: string;
  runId: string;
  token: string;
  ttlSeconds: number;
}

export type RunKind = 'scheduled' | 'backfill' | 'replay';

export async function loadSource(c: PoolClient, sourceKey: string): Promise<SourceRow> {
  const r = await c.query(
    `SELECT tenant_id::text, id::text, source_key, kind, enabled, config, declared_focus_version
     FROM ratio.sources WHERE source_key = $1`,
    [sourceKey],
  );
  if (r.rowCount !== 1) throw new IngestError('SOURCE_NOT_FOUND', 'no such source for this tenant');
  const s = r.rows[0];
  return {
    tenantId: s.tenant_id,
    id: s.id,
    sourceKey: s.source_key,
    kind: s.kind,
    enabled: s.enabled,
    config: s.config,
    declaredFocusVersion: s.declared_focus_version,
  };
}

/** Deletes every staged batch of the source (children first, while still staged). */
export async function deleteStagedBatches(c: PoolClient, sourceId: string): Promise<number> {
  const ids = (await c.query(`SELECT id FROM ratio.ingest_batches WHERE source_id = $1 AND status = 'staged' FOR UPDATE`, [sourceId])).rows.map((r) => r.id as string);
  if (!ids.length) return 0;
  await c.query(`DELETE FROM ratio.cost_facts WHERE batch_id = ANY($1::uuid[])`, [ids]);
  await c.query(`DELETE FROM ratio.ingest_validation_errors WHERE batch_id = ANY($1::uuid[])`, [ids]);
  await c.query(`DELETE FROM ratio.ingest_artifacts WHERE batch_id = ANY($1::uuid[])`, [ids]);
  await c.query(`DELETE FROM ratio.ingest_batches WHERE id = ANY($1::uuid[]) AND status = 'staged'`, [ids]);
  return ids.length;
}

/**
 * What an expiring run committed before it lost its lease (challenger L1):
 * batches it created that left 'staged' (published, superseded or
 * quarantined), publications it made (also a replay's), and the checkpoint if
 * it wrote it last. null when it committed nothing. Lets operators tell a run
 * whose work stands (LEASE_EXPIRED_AFTER_COMMIT) from one that did nothing.
 */
async function committedWorkOf(c: PoolClient, sourceId: string, runId: string): Promise<string | null> {
  const r = await c.query(
    `SELECT (SELECT count(*) FROM ratio.ingest_batches WHERE source_id = $1 AND run_id = $2 AND status <> 'staged')::int AS batches,
            (SELECT count(*) FROM ratio.period_publications WHERE source_id = $1 AND published_by_run_id = $2)::int AS publications,
            EXISTS (SELECT 1 FROM ratio.source_checkpoints WHERE source_id = $1 AND last_run_id = $2) AS checkpoint`,
    [sourceId, runId],
  );
  const { batches, publications, checkpoint } = r.rows[0] as { batches: number; publications: number; checkpoint: boolean };
  if (!batches && !publications && !checkpoint) return null;
  return `${batches} ${batches === 1 ? 'batch' : 'batches'} published/superseded/quarantined, ${publications} ${publications === 1 ? 'publication' : 'publications'}, checkpoint ${checkpoint ? 'written' : 'not written'}`;
}

/**
 * Claims the single running slot of (tenant, source). A live lease ⇒
 * ALREADY_RUNNING. An expired one ⇒ that run is marked abandoned and every
 * staged batch of the source is deleted (decision: discard at next acquisition).
 */
export async function acquireRun(
  pool: Pool,
  tenantId: string,
  sourceKey: string,
  opts: { kind: RunKind; ttlSeconds: number; periodFrom?: string; periodTo?: string; stats?: Record<string, unknown> },
): Promise<{ lease: Lease; source: SourceRow; abandoned: string[]; discardedBatches: number }> {
  try {
    return await acquireRunTx(pool, tenantId, sourceKey, opts);
  } catch (e) {
    // lock_timeout while waiting for another (possibly stuck) run's lock: fail visibly, change nothing.
    if ((e as { code?: unknown })?.code === '55P03') throw new IngestError('LOCK_TIMEOUT', 'timed out waiting for a lock held by another run on this source', { cause: e });
    throw e;
  }
}

async function acquireRunTx(
  pool: Pool,
  tenantId: string,
  sourceKey: string,
  opts: { kind: RunKind; ttlSeconds: number; periodFrom?: string; periodTo?: string; stats?: Record<string, unknown> },
): Promise<{ lease: Lease; source: SourceRow; abandoned: string[]; discardedBatches: number }> {
  return workerTransaction(pool, tenantId, async (c) => {
    const source = await loadSource(c, sourceKey);
    if (!source.enabled) throw new IngestError('SOURCE_DISABLED', 'source is disabled');
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`ratio.sync:${source.tenantId}:${source.id}`]);
    const running = await c.query(
      `SELECT id::text, lease_expires_at > clock_timestamp() AS live FROM ratio.sync_runs
       WHERE source_id = $1 AND status = 'running' FOR UPDATE`,
      [source.id],
    );
    const abandoned: string[] = [];
    for (const r of running.rows) {
      if (r.live) throw new IngestError('ALREADY_RUNNING', 'another run holds a live lease on this source');
      const committed = await committedWorkOf(c, source.id, r.id);
      await c.query(
        `UPDATE ratio.sync_runs SET status = 'abandoned', finished_at = clock_timestamp(), error_code = $2, error_detail = $3
         WHERE id = $1 AND status = 'running'`,
        committed
          ? [r.id, 'LEASE_EXPIRED_AFTER_COMMIT', `lease expired after the run committed work (${committed}); that work stands; run abandoned by a later acquisition`]
          : [r.id, 'LEASE_EXPIRED', 'lease expired without completion; run abandoned by a later acquisition'],
      );
      abandoned.push(r.id);
    }
    const discardedBatches = await deleteStagedBatches(c, source.id);
    const runId = crypto.randomUUID();
    const token = crypto.randomUUID();
    await c.query(
      `INSERT INTO ratio.sync_runs (tenant_id, id, source_id, run_kind, period_from, period_to, status, lease_token, lease_expires_at, heartbeat_at, attempt, started_at, stats)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, clock_timestamp() + make_interval(secs => $8), clock_timestamp(), 1, clock_timestamp(), $9)`,
      [source.tenantId, runId, source.id, opts.kind, opts.periodFrom ?? null, opts.periodTo ?? null, token, opts.ttlSeconds, JSON.stringify(opts.stats ?? {})],
    );
    return { lease: { tenantId: source.tenantId, sourceId: source.id, runId, token, ttlSeconds: opts.ttlSeconds }, source, abandoned, discardedBatches };
  });
}

/** Inside a tenant transaction: verifies (and locks) the lease or throws LEASE_LOST. */
export async function assertLease(c: PoolClient, lease: Pick<Lease, 'runId' | 'token'>, lock: 'UPDATE' | 'SHARE'): Promise<void> {
  const r = await c.query(
    `SELECT 1 FROM ratio.sync_runs WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp()
     FOR ${lock === 'UPDATE' ? 'UPDATE' : 'SHARE'}`,
    [lease.runId, lease.token],
  );
  if (r.rowCount !== 1) throw new IngestError('LEASE_LOST', 'this run no longer holds its lease (expired or taken over)');
}

/** Extends a LIVE lease. Never revives an expired or taken-over one. */
export async function heartbeat(pool: Pool, tenantId: string, runId: string, token: string, ttlSeconds: number): Promise<void> {
  await workerTransaction(pool, tenantId, async (c) => {
    const r = await c.query(
      `UPDATE ratio.sync_runs SET lease_expires_at = clock_timestamp() + make_interval(secs => $3), heartbeat_at = clock_timestamp()
       WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp()`,
      [runId, token, ttlSeconds],
    );
    if (r.rowCount !== 1) throw new IngestError('LEASE_LOST', 'this run no longer holds its lease (expired or taken over)');
  });
}

/** Records a retry on the run (fenced). */
export async function recordRetry(pool: Pool, lease: Lease, entry: Record<string, unknown>): Promise<void> {
  await workerTransaction(pool, lease.tenantId, async (c) => {
    const r = await c.query(
      `UPDATE ratio.sync_runs SET attempt = attempt + 1,
         stats = jsonb_set(stats, '{retries}', coalesce(stats->'retries', '[]'::jsonb) || jsonb_build_array($3::jsonb))
       WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp()`,
      [lease.runId, lease.token, JSON.stringify(entry)],
    );
    if (r.rowCount !== 1) throw new IngestError('LEASE_LOST', 'this run no longer holds its lease (expired or taken over)');
  });
}

/**
 * Finishes the run. Fenced like every other lease write — token,
 * status='running' AND a live lease — so neither a zombie whose run was taken
 * over nor a run whose lease has already expired can finish it (returns
 * false: callers treat that as LEASE_LOST; the next acquisition abandons it).
 */
export async function finishRun(
  pool: Pool,
  lease: Lease,
  outcome: { status: 'succeeded' | 'failed'; errorCode?: string | null; errorDetail?: string | null; stats: Record<string, unknown> },
): Promise<boolean> {
  return workerTransaction(pool, lease.tenantId, async (c) => {
    const r = await c.query(
      `UPDATE ratio.sync_runs SET status = $3, finished_at = clock_timestamp(), error_code = $4, error_detail = $5,
         stats = stats || $6::jsonb
       WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp()`,
      [lease.runId, lease.token, outcome.status, outcome.errorCode ?? null, outcome.errorDetail ?? null, JSON.stringify(outcome.stats)],
    );
    return r.rowCount === 1;
  });
}
