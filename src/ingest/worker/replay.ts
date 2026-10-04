// replay --batch: re-point a period at a retained batch (rollback or
// roll-forward). Fenced and atomic (the same publish transaction as a sync),
// recorded as a run_kind='replay' run, and PINS the period so scheduled syncs
// do not silently undo the operator's choice (replay --period unpins).
import type { Pool } from 'pg';
import { IngestError, errorCodeOf, messageOf } from '../errors';
import { redact } from '../redact';
import { resolveSettings, type WorkerSettings } from '../config';
import { workerTransaction } from './tx';
import { acquireRun, finishRun, loadSource } from './lease';
import { publishBatch, refreshCheckpoint, type CheckpointEntry } from './publish';
import { SimulatedCrash, canonicalTenant, type WorkerHooks } from './types';
import type { LogFn } from './pipeline';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ReplayBatchResult {
  runId: string;
  billingPeriod: string;
  batchId: string;
  outcome: 'republished' | 'already_current';
}

async function lookup(pool: Pool, tenantId: string, sourceKey: string, batchId: string) {
  return workerTransaction(pool, tenantId, async (c) => {
    const source = await loadSource(c, sourceKey);
    const r = await c.query(
      `SELECT id::text, billing_period::text AS period, status, artifact_set_fingerprint AS fingerprint
       FROM ratio.ingest_batches WHERE id = $1 AND source_id = $2`,
      [batchId, source.id],
    );
    if (r.rowCount !== 1) throw new IngestError('NOT_FOUND', 'no such batch for this tenant and source');
    return r.rows[0] as { id: string; period: string; status: string; fingerprint: string };
  });
}

export async function replayBatch(opts: {
  pool: Pool;
  tenantId: string;
  sourceKey: string;
  batchId: string;
  hooks?: WorkerHooks;
  settings?: Partial<Omit<WorkerSettings, 'limits'>>;
  log?: LogFn;
}): Promise<ReplayBatchResult> {
  const tenantId = canonicalTenant(opts.tenantId);
  if (typeof opts.batchId !== 'string' || !UUID_RE.test(opts.batchId)) throw new IngestError('INVALID_BATCH', 'batch id must be a UUID');
  const batchId = opts.batchId.toLowerCase();
  const settings = resolveSettings(opts.settings);
  const log = opts.log ?? (() => undefined);

  // Refuse before taking the lease (acquisition discards staged batches).
  const target = await lookup(opts.pool, tenantId, opts.sourceKey, batchId);
  if (target.status !== 'published' && target.status !== 'superseded') {
    throw new IngestError('BATCH_NOT_REPLAYABLE', `a ${target.status} batch cannot be published`);
  }

  const { lease } = await acquireRun(opts.pool, tenantId, opts.sourceKey, {
    kind: 'replay',
    ttlSeconds: settings.leaseTtlSeconds,
    periodFrom: target.period,
    periodTo: target.period,
    stats: { replayBatch: batchId },
  });
  try {
    const current = await workerTransaction(opts.pool, tenantId, async (c) => {
      const r = await c.query(`SELECT batch_id::text FROM ratio.period_publications WHERE source_id = $1 AND billing_period = $2`, [lease.sourceId, target.period]);
      return (r.rows[0]?.batch_id as string | undefined) ?? null;
    });
    // Either way the operator's choice is PINNED (review M3): a scheduled sync
    // must not replace the batch the operator named, current or not.
    const pin = (prev: Partial<CheckpointEntry> | null): CheckpointEntry => ({ fingerprint: target.fingerprint, listing: prev?.listing ?? null, batchId, pinned: true });
    let outcome: ReplayBatchResult['outcome'];
    if (current === batchId) {
      await refreshCheckpoint(opts.pool, lease, target.period, pin);
      outcome = 'already_current';
    } else {
      await publishBatch(opts.pool, lease, { batchId, billingPeriod: target.period, checkpoint: pin }, opts.hooks ?? {});
      outcome = 'republished';
    }
    // A run taken over before it could finish is LEASE_LOST, exactly as in runSync (review M4).
    const finished = await finishRun(opts.pool, lease, { status: 'succeeded', stats: { replayBatch: batchId, billingPeriod: target.period, outcome } });
    if (!finished) throw new IngestError('LEASE_LOST', 'run was taken over before it could finish');
    log('replay.done', { runId: lease.runId, period: target.period, batchId, outcome });
    return { runId: lease.runId, billingPeriod: target.period, batchId, outcome };
  } catch (e) {
    // A "dead process" finishes nothing: the run stays running until its lease expires,
    // exactly as in runSync (review M3, fifth round).
    if (e instanceof SimulatedCrash) throw e;
    if (e instanceof IngestError && e.code === 'LEASE_LOST') throw e;
    // A finish that matched no row (lease expired or taken over) is LEASE_LOST; a finish that could not reach the DB leaves e (review H1).
    const finished = await finishRun(opts.pool, lease, {
      status: 'failed',
      errorCode: errorCodeOf(e),
      errorDetail: redact(messageOf(e)),
      stats: { replayBatch: batchId, billingPeriod: target.period },
    }).catch(() => null);
    if (finished === false) throw new IngestError('LEASE_LOST', `run lost its lease before it could record its failure (${errorCodeOf(e)})`);
    throw e;
  }
}
