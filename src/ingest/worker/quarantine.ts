// `quarantine show`: an inspectable view of one batch (any status) — totals,
// control values, artifacts with sha256/size/evidence key, and the stored
// validation errors. Read-only, tenant-scoped (RLS), no row contents.
import type { Pool } from 'pg';
import { IngestError } from '../errors';
import { workerTransaction } from './tx';
import { canonicalTenant } from './types';

export interface QuarantineReport {
  batch: {
    id: string;
    sourceKey: string;
    billingPeriod: string;
    status: string;
    quarantineReason: string | null;
    reconciliation: string;
    rowCount: string;
    loadedBilledTotal: string;
    controlRowCount: string | null;
    controlBilledTotal: string | null;
    isProvisional: boolean;
    validationErrorCount: string;
    storedErrorCount: number;
    artifactSetFingerprint: string;
    runId: string;
    createdAt: string;
    artifacts: Array<{ name: string; sha256: string; byteSize: string; rowCount: string | null; evidenceKey: string }>;
  };
  errors: Array<{ ordinal: number; artifactSha256: string; rowOrdinal: string | null; column: string | null; code: string; message: string }>;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function showBatch(pool: Pool, tenantId: string, batchId: string): Promise<QuarantineReport> {
  const tenant = canonicalTenant(tenantId);
  if (typeof batchId !== 'string' || !UUID_RE.test(batchId)) throw new IngestError('INVALID_BATCH', 'batch id must be a UUID');
  return workerTransaction(pool, tenant, async (c) => {
    const b = await c.query(
      `SELECT b.id::text, s.source_key, b.billing_period::text AS period, b.status, b.quarantine_reason, b.reconciliation,
              b.row_count::text AS row_count, b.loaded_billed_total::text AS loaded, b.control_row_count::text AS control_rows,
              b.control_billed_total::text AS control_total, b.is_provisional, b.validation_error_count::text AS error_count,
              b.artifact_set_fingerprint AS fp, b.run_id::text AS run_id, b.created_at
       FROM ratio.ingest_batches b JOIN ratio.sources s ON s.tenant_id = b.tenant_id AND s.id = b.source_id
       WHERE b.id = $1`,
      [batchId.toLowerCase()],
    );
    if (b.rowCount !== 1) throw new IngestError('NOT_FOUND', 'no such batch for this tenant');
    const row = b.rows[0];
    const arts = await c.query(
      `SELECT artifact_name, sha256, byte_size::text AS size, row_count::text AS rows, evidence_key
       FROM ratio.ingest_artifacts WHERE batch_id = $1 ORDER BY artifact_name`,
      [row.id],
    );
    const errs = await c.query(
      `SELECT error_ordinal, artifact_sha256, row_ordinal::text AS row_ordinal, column_name, code, message
       FROM ratio.ingest_validation_errors WHERE batch_id = $1 ORDER BY error_ordinal`,
      [row.id],
    );
    return {
      batch: {
        id: row.id,
        sourceKey: row.source_key,
        billingPeriod: row.period,
        status: row.status,
        quarantineReason: row.quarantine_reason,
        reconciliation: row.reconciliation,
        rowCount: row.row_count,
        loadedBilledTotal: row.loaded,
        controlRowCount: row.control_rows,
        controlBilledTotal: row.control_total,
        isProvisional: row.is_provisional,
        validationErrorCount: row.error_count,
        storedErrorCount: errs.rowCount ?? 0,
        artifactSetFingerprint: row.fp,
        runId: row.run_id,
        createdAt: new Date(row.created_at).toISOString(),
        artifacts: arts.rows.map((a) => ({ name: a.artifact_name, sha256: a.sha256, byteSize: a.size, rowCount: a.rows, evidenceKey: a.evidence_key })),
      },
      errors: errs.rows.map((e) => ({
        ordinal: e.error_ordinal,
        artifactSha256: e.artifact_sha256,
        rowOrdinal: e.row_ordinal,
        column: e.column_name,
        code: e.code,
        message: e.message,
      })),
    };
  });
}
