// Fenced batch state transitions. Every transaction first re-verifies the
// run's lease; any failure rolls the whole transaction back, so readers of
// cost_facts_published never observe a partial publication.
//
// Children of a batch (facts, artifacts, validation errors) are written while
// the batch is still 'staged'; the status transition is the last write.
import type { Pool, PoolClient } from 'pg';
import { IngestError } from '../errors';
import { workerTransaction } from './tx';
import { redact } from '../redact';
import { assertLease, type Lease } from './lease';
import type { ValidationErrorRow } from './load';
import type { HookContext, PublishStep, WorkerHooks } from './types';
import type { ArtifactSetControl } from '../sources/types';

/**
 * The publish transaction, in order. Exported so failure-injection tests
 * follow whatever order the schema requires.
 */
export const PUBLISH_STEPS: readonly PublishStep[] = [
  'lock_run',
  'lock_period',
  'supersede_prior',
  'mark_published',
  'upsert_publication',
  'advance_checkpoint',
  'commit',
];

export interface CheckpointEntry {
  fingerprint: string;
  listing: string | null;
  batchId: string;
  pinned: boolean;
  /** A listing rejected at capture time (sizes under-reported), with the limits it was rejected under (challenger L3). */
  rejected?: RejectedListing;
}

export interface RejectedListing {
  listing: string;
  code: 'ARTIFACT_SET_TOO_LARGE' | 'ARTIFACT_TOO_LARGE';
  maxArtifactBytes: number;
  maxBatchBytes: number;
}

/** Reads a checkpoint entry; tolerates the legacy plain-string shape. */
export function parseCheckpointEntry(v: unknown): Partial<CheckpointEntry> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { fingerprint: v };
  if (typeof v === 'object') return v as Partial<CheckpointEntry>;
  return null;
}

export async function readCheckpoint(c: PoolClient, sourceId: string): Promise<Record<string, Partial<CheckpointEntry>>> {
  const r = await c.query(`SELECT periods FROM ratio.source_checkpoints WHERE source_id = $1`, [sourceId]);
  const periods = (r.rows[0]?.periods ?? {}) as Record<string, unknown>;
  const out: Record<string, Partial<CheckpointEntry>> = {};
  for (const [k, v] of Object.entries(periods)) {
    const e = parseCheckpointEntry(v);
    if (e) out[k] = e;
  }
  return out;
}

async function writeCheckpoint(c: PoolClient, lease: Lease, period: string, entry: CheckpointEntry | (Partial<CheckpointEntry> & { rejected: RejectedListing })): Promise<void> {
  await c.query(
    `INSERT INTO ratio.source_checkpoints (tenant_id, source_id, last_run_id, periods, updated_at)
     VALUES ($1, $2, $3, jsonb_build_object($4::text, $5::jsonb), clock_timestamp())
     ON CONFLICT (tenant_id, source_id) DO UPDATE
       SET periods = ratio.source_checkpoints.periods || EXCLUDED.periods, last_run_id = EXCLUDED.last_run_id, updated_at = EXCLUDED.updated_at`,
    [lease.tenantId, lease.sourceId, lease.runId, period, JSON.stringify(entry)],
  );
}

export async function stageBatch(
  pool: Pool,
  lease: Lease,
  b: {
    batchId: string;
    billingPeriod: string;
    fingerprint: string;
    control?: ArtifactSetControl;
    artifacts: Array<{ name: string; sha256: string; byteSize: number; evidenceKey: string }>;
  },
): Promise<void> {
  await workerTransaction(pool, lease.tenantId, async (c) => {
    await assertLease(c, lease, 'SHARE');
    await c.query(
      `INSERT INTO ratio.ingest_batches (tenant_id, id, source_id, run_id, billing_period, artifact_set_fingerprint, status,
         control_row_count, control_billed_total, is_provisional)
       VALUES ($1, $2, $3, $4, $5::date, $6, 'staged', $7, $8::numeric,
         $5::date >= date_trunc('month', now() AT TIME ZONE 'UTC')::date)`,
      [lease.tenantId, b.batchId, lease.sourceId, lease.runId, b.billingPeriod, b.fingerprint, b.control?.rowCount ?? null, b.control?.billedTotal ?? null],
    );
    for (const a of b.artifacts) {
      await c.query(
        `INSERT INTO ratio.ingest_artifacts (tenant_id, source_id, batch_id, artifact_name, sha256, byte_size, evidence_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [lease.tenantId, lease.sourceId, b.batchId, redact(a.name), a.sha256, a.byteSize, a.evidenceKey],
      );
    }
  });
}

/** Deletes one staged batch of this run (children first). Used before a retry of the same artifact set. */
export async function discardStagedBatch(pool: Pool, lease: Lease, batchId: string): Promise<void> {
  await workerTransaction(pool, lease.tenantId, async (c) => {
    await assertLease(c, lease, 'SHARE');
    const b = await c.query(`SELECT 1 FROM ratio.ingest_batches WHERE id = $1 AND status = 'staged' FOR UPDATE`, [batchId]);
    if (b.rowCount !== 1) return;
    await c.query(`DELETE FROM ratio.cost_facts WHERE batch_id = $1`, [batchId]);
    await c.query(`DELETE FROM ratio.ingest_validation_errors WHERE batch_id = $1`, [batchId]);
    await c.query(`DELETE FROM ratio.ingest_artifacts WHERE batch_id = $1`, [batchId]);
    await c.query(`DELETE FROM ratio.ingest_batches WHERE id = $1 AND status = 'staged'`, [batchId]);
  });
}

export interface Aggregates {
  rowCount: string;
  billedTotal: string;
  currencies: number;
}

export async function aggregateBatch(pool: Pool, lease: Lease, batchId: string): Promise<Aggregates> {
  return workerTransaction(pool, lease.tenantId, async (c) => {
    const r = await c.query(
      `SELECT count(*)::text AS n, coalesce(sum(billed_cost), 0)::text AS total, count(DISTINCT billing_currency)::int AS currencies
       FROM ratio.cost_facts WHERE batch_id = $1`,
      [batchId],
    );
    return { rowCount: r.rows[0].n, billedTotal: r.rows[0].total, currencies: r.rows[0].currencies };
  });
}

/** Exact numeric comparison done by Postgres (never JS floats). */
export async function numericEquals(pool: Pool, a: string, b: string): Promise<boolean> {
  const r = await pool.query(`SELECT $1::numeric = $2::numeric AS eq`, [a, b]);
  return r.rows[0].eq === true;
}

async function setArtifactRowCounts(c: PoolClient, batchId: string, perArtifactRows: Map<string, number>): Promise<void> {
  for (const [name, rows] of perArtifactRows) {
    await c.query(`UPDATE ratio.ingest_artifacts SET row_count = $3 WHERE batch_id = $1 AND artifact_name = $2`, [batchId, redact(name), rows]);
  }
}

/** Staged batch: records totals, per-artifact row counts and the reconciliation verdict (still staged). */
export async function finalizeStaged(
  pool: Pool,
  lease: Lease,
  b: { batchId: string; rowCount: string; billedTotal: string; reconciliation: 'reconciled' | 'unverified'; perArtifactRows: Map<string, number> },
): Promise<void> {
  await workerTransaction(pool, lease.tenantId, async (c) => {
    await assertLease(c, lease, 'SHARE');
    await setArtifactRowCounts(c, b.batchId, b.perArtifactRows);
    const r = await c.query(
      `UPDATE ratio.ingest_batches SET row_count = $2::bigint, loaded_billed_total = $3::numeric, reconciliation = $4
       WHERE id = $1 AND status = 'staged'`,
      [b.batchId, b.rowCount, b.billedTotal, b.reconciliation],
    );
    if (r.rowCount !== 1) throw new IngestError('BATCH_STATE_CHANGED', 'staged batch disappeared before finalization');
  });
}

export async function quarantineBatch(
  pool: Pool,
  lease: Lease,
  q: {
    batchId: string;
    billingPeriod: string;
    reason: string;
    errors: ValidationErrorRow[];
    errorCount: number;
    reconciliation?: 'variance';
    rowCount?: string;
    billedTotal?: string;
    perArtifactRows: Map<string, number>;
  },
  hooks: WorkerHooks,
): Promise<void> {
  const ctx: HookContext = { runId: lease.runId, batchId: q.batchId, billingPeriod: q.billingPeriod };
  await workerTransaction(pool, lease.tenantId, async (c) => {
    await assertLease(c, lease, 'UPDATE');
    await setArtifactRowCounts(c, q.batchId, q.perArtifactRows);
    if (q.errors.length) {
      await c.query(
        `INSERT INTO ratio.ingest_validation_errors (tenant_id, batch_id, error_ordinal, artifact_sha256, row_ordinal, column_name, code, message)
         SELECT $1, $2, u.ord, u.sha, u.row_ord, u.col, u.code, u.msg
         FROM unnest($3::int[], $4::text[], $5::bigint[], $6::text[], $7::text[], $8::text[]) AS u(ord, sha, row_ord, col, code, msg)`,
        [
          lease.tenantId,
          q.batchId,
          q.errors.map((_, i) => i + 1),
          q.errors.map((e) => e.artifactSha256),
          q.errors.map((e) => e.rowOrdinal),
          q.errors.map((e) => (e.column === null ? null : redact(e.column).slice(0, 256))),
          q.errors.map((e) => e.code),
          q.errors.map((e) => redact(e.message).slice(0, 1000)),
        ],
      );
    }
    await c.query(`DELETE FROM ratio.cost_facts WHERE batch_id = $1`, [q.batchId]);
    const r = await c.query(
      `UPDATE ratio.ingest_batches SET status = 'quarantined', quarantine_reason = $2, validation_error_count = $3,
         reconciliation = coalesce($4, reconciliation), row_count = coalesce($5::bigint, row_count),
         loaded_billed_total = coalesce($6::numeric, loaded_billed_total)
       WHERE id = $1 AND status = 'staged'`,
      [q.batchId, redact(q.reason).slice(0, 2000), q.errorCount, q.reconciliation ?? null, q.rowCount ?? null, q.billedTotal ?? null],
    );
    if (r.rowCount !== 1) throw new IngestError('BATCH_STATE_CHANGED', 'staged batch disappeared before quarantine');
    if (hooks.beforeQuarantineCommit) await hooks.beforeQuarantineCommit(ctx);
  });
}

/**
 * Makes `batchId` the published batch of its period in ONE transaction:
 * fencing, period lock, supersede prior, publish target, re-point, checkpoint.
 * Works for a fresh staged batch and for re-publishing a superseded one.
 */
export async function publishBatch(
  pool: Pool,
  lease: Lease,
  p: { batchId: string; billingPeriod: string; checkpoint: (prev: Partial<CheckpointEntry> | null) => CheckpointEntry },
  hooks: WorkerHooks,
): Promise<void> {
  const ctx: HookContext = { runId: lease.runId, batchId: p.batchId, billingPeriod: p.billingPeriod };
  const step = async (s: PublishStep) => {
    if (hooks.beforePublishStep) await hooks.beforePublishStep(s, ctx);
  };
  await workerTransaction(pool, lease.tenantId, async (c) => {
    for (const s of PUBLISH_STEPS) {
      await step(s);
      switch (s) {
        case 'lock_run':
          await assertLease(c, lease, 'UPDATE');
          break;
        case 'lock_period': {
          await c.query(`SELECT batch_id FROM ratio.period_publications WHERE source_id = $1 AND billing_period = $2 FOR UPDATE`, [lease.sourceId, p.billingPeriod]);
          const t = await c.query(
            `SELECT status FROM ratio.ingest_batches WHERE id = $1 AND source_id = $2 AND billing_period = $3 FOR UPDATE`,
            [p.batchId, lease.sourceId, p.billingPeriod],
          );
          if (t.rowCount !== 1) throw new IngestError('NOT_FOUND', 'batch not found for this source and period');
          if (t.rows[0].status !== 'staged' && t.rows[0].status !== 'superseded') {
            throw new IngestError('BATCH_NOT_REPLAYABLE', `a ${t.rows[0].status} batch cannot be published`);
          }
          break;
        }
        case 'supersede_prior':
          await c.query(
            `UPDATE ratio.ingest_batches SET status = 'superseded', superseded_at = clock_timestamp()
             WHERE source_id = $1 AND billing_period = $2 AND status = 'published' AND id <> $3`,
            [lease.sourceId, p.billingPeriod, p.batchId],
          );
          break;
        case 'mark_published': {
          const r = await c.query(
            `UPDATE ratio.ingest_batches SET status = 'published', published_at = clock_timestamp()
             WHERE id = $1 AND status IN ('staged', 'superseded')`,
            [p.batchId],
          );
          if (r.rowCount !== 1) throw new IngestError('BATCH_STATE_CHANGED', 'batch changed state during publication');
          break;
        }
        case 'upsert_publication':
          await c.query(
            `INSERT INTO ratio.period_publications (tenant_id, source_id, billing_period, batch_id, published_at, published_by_run_id)
             VALUES ($1, $2, $3, $4, clock_timestamp(), $5)
             ON CONFLICT (tenant_id, source_id, billing_period) DO UPDATE
               SET batch_id = EXCLUDED.batch_id, published_at = EXCLUDED.published_at, published_by_run_id = EXCLUDED.published_by_run_id`,
            [lease.tenantId, lease.sourceId, p.billingPeriod, p.batchId, lease.runId],
          );
          break;
        case 'advance_checkpoint': {
          const prev = (await readCheckpoint(c, lease.sourceId))[p.billingPeriod] ?? null;
          await writeCheckpoint(c, lease, p.billingPeriod, p.checkpoint(prev));
          break;
        }
        case 'commit':
          break;
      }
    }
  });
}

/** Records an unchanged period in the checkpoint (fenced); nothing visible changes. */
export async function refreshCheckpoint(pool: Pool, lease: Lease, period: string, make: (prev: Partial<CheckpointEntry> | null) => CheckpointEntry): Promise<void> {
  await workerTransaction(pool, lease.tenantId, async (c) => {
    await assertLease(c, lease, 'UPDATE');
    const prev = (await readCheckpoint(c, lease.sourceId))[period] ?? null;
    await writeCheckpoint(c, lease, period, make(prev));
  });
}

/**
 * Remembers that this exact listing was rejected at capture time under these
 * limits, keeping whatever else the period's entry holds (its published
 * batch, its pin). The next run fails it fast without downloading anything;
 * any publication of the period writes a fresh entry without it.
 */
export async function recordRejectedListing(pool: Pool, lease: Lease, period: string, rejected: RejectedListing): Promise<void> {
  await workerTransaction(pool, lease.tenantId, async (c) => {
    await assertLease(c, lease, 'UPDATE');
    const prev = (await readCheckpoint(c, lease.sourceId))[period] ?? {};
    await writeCheckpoint(c, lease, period, { ...prev, rejected });
  });
}
