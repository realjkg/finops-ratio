// R3: one ingestion path for file imports AND (later rows) managed connectors.
// stageAndSync: delivery bytes → normalizer (normalizer.ts; pass-through for
// FOCUS) → staging into the source's ratio-file-drop layout (stageFile.ts) →
// the EXISTING pipeline (runSync: evidence capture, validator, provider check,
// quarantine, reconciliation, publish/supersede) over exactly the staged
// periods. No new parser and no new publish path. Idempotent: the same bytes
// stage to the same objects, so a re-delivery is `unchanged`; a changed
// delivery for a published period supersedes it via the existing restatement path.
// importFile (`cli import-file`) is a thin wrapper that reads one local file.
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { IngestError } from '../errors';
import type { EvidenceStore } from '../evidence/types';
import { declaredProviders } from '../focus/provider';
import { validateLocation } from '../sources/s3/layout';
import type { FocusSource } from '../sources/types';
import { loadSource, type SourceRow } from '../worker/lease';
import { runSync, type LogFn, type RunSyncOptions } from '../worker/pipeline';
import { workerTransaction } from '../worker/tx';
import type { PeriodResult, RunResult } from '../worker/types';
import { collect, normalizerFor, type MappingReport } from './normalizer';
import { MAX_IMPORT_BYTES, decodeImportFile, stageFile, type StageControl } from './stageFile';

export const NO_CONTROL_NOTE = 'unverified (no control total supplied)';
export const VARIANCE_NOTE =
  'not published: the supplied control totals do not match the rows of the declared providers in this file (a partial or different delivery); see: cli quarantine show --batch <batchId>';

export interface DeliveryObject {
  name: string;
  bytes?: Buffer;
  stream?: Readable;
}

export interface StageAndSyncOptions {
  pool: Pool;
  tenantId: string;
  sourceKey: string;
  objects: DeliveryObject[];
  /** Native kind of the delivery; 'focus-export' (default) passes through. */
  sourceKind?: string;
  schemaVersion?: string;
  /** 'YYYY-MM-01': stage only this period. */
  period?: string;
  control?: StageControl;
  /** Carried verbatim in every staged manifest's x-ratio-import. */
  provenance?: Record<string, unknown>;
  sourceClient: () => S3Client;
  source: (row: SourceRow) => FocusSource;
  evidence: EvidenceStore;
  settings?: RunSyncOptions['settings'];
  hooks?: RunSyncOptions['hooks'];
  log?: LogFn;
  secrets?: readonly string[];
}

export type ImportPeriodResult = PeriodResult & { reconciliationNote?: string };

export interface StageAndSyncResult extends Omit<RunResult, 'periods'> {
  periods: ImportPeriodResult[];
  files: Array<{ sha256: string; dataRows: number }>;
  nullTokensReplaced: Record<string, number>;
  normalization: MappingReport[];
  staged: Array<{ billingPeriod: string; records: number }>;
}

export async function stageAndSync(o: StageAndSyncOptions): Promise<StageAndSyncResult> {
  const row = await workerTransaction(o.pool, o.tenantId, (c) => loadSource(c, o.sourceKey));
  if (row.kind !== 'focus_file' || row.config.layout !== 'ratio-file-drop') {
    throw new IngestError('IMPORT_SOURCE_NOT_FILE_DROP', `source ${o.sourceKey} is not a file-import source (register one with: cli source add)`);
  }
  if (!row.enabled) throw new IngestError('SOURCE_DISABLED', `source ${o.sourceKey} is disabled`);
  const location = validateLocation(row.config);
  const providers = declaredProviders(row.config);
  if (!providers) throw new IngestError('SOURCE_CONFIG_INVALID', 'source config providers must be a non-empty list of known providers');

  const normalizer = normalizerFor(o.sourceKind ?? 'focus-export', o.schemaVersion ?? '1.0');
  const inputs: Array<{ name: string; bytes: Buffer }> = [];
  const normalization: MappingReport[] = [];
  for (const obj of o.objects) {
    const { csv, report } = await normalizer.normalize(obj.stream ?? Readable.from(obj.bytes ?? Buffer.alloc(0)));
    inputs.push({ name: obj.name, bytes: await collect(csv, MAX_IMPORT_BYTES) });
    normalization.push(report);
  }
  const staged = stageFile(inputs, { location, period: o.period, control: o.control, providers, provenance: { ...o.provenance, normalization } });

  // Duplicate guard: the same bytes already held by a published or staged batch of ANOTHER source of
  // this tenant would be counted twice. Existing worker grants (SELECT, RLS-bound), no migration.
  const shas = staged.objects.filter((x) => x.kind === 'data').map((x) => x.sha256);
  const dup = await workerTransaction(o.pool, o.tenantId, (c) =>
    c.query(
      `SELECT 1 FROM ratio.ingest_artifacts a JOIN ratio.ingest_batches b ON b.tenant_id = a.tenant_id AND b.id = a.batch_id
       WHERE a.sha256 = ANY($1::text[]) AND a.source_id <> $2 AND b.status IN ('published', 'staged') LIMIT 1`,
      [shas, row.id],
    ),
  );
  if (dup.rowCount) throw new IngestError('DUPLICATE_ARTIFACT', 'this file (or a billing period of it) is already imported under another source of this tenant; refused to avoid double counting');

  // Data first, manifests last: a manifest never names an object that is not there yet.
  const client = o.sourceClient();
  for (const obj of [...staged.objects.filter((x) => x.kind === 'data'), ...staged.objects.filter((x) => x.kind === 'manifest')]) {
    await client.send(new PutObjectCommand({ Bucket: location.bucket, Key: obj.key, Body: obj.body, ContentType: obj.kind === 'data' ? 'application/gzip' : 'application/json' }));
  }
  o.log?.('import.staged', { periods: staged.periods.length, objects: staged.objects.length });

  const run = await runSync({
    pool: o.pool,
    tenantId: o.tenantId,
    sourceKey: o.sourceKey,
    source: o.source,
    evidence: o.evidence,
    mode: 'backfill',
    range: { from: staged.periods[0].billingPeriod, to: staged.periods[staged.periods.length - 1].billingPeriod },
    settings: o.settings,
    hooks: o.hooks,
    log: o.log,
    secrets: o.secrets,
  });
  const hasControl = !!o.control && Object.values(o.control).some((v) => v !== undefined);
  return {
    ...run,
    periods: run.periods.map((p) => {
      if (p.outcome === 'quarantined' && p.code === 'RECONCILIATION_VARIANCE') return { ...p, reconciliationNote: VARIANCE_NOTE };
      return p.reconciliation === 'unverified' && !hasControl ? { ...p, reconciliationNote: NO_CONTROL_NOTE } : p;
    }),
    files: staged.files.map((f) => ({ sha256: f.sha256, dataRows: f.dataRows })),
    nullTokensReplaced: staged.nullTokensReplaced,
    normalization,
    staged: staged.periods,
  };
}

function readFile(filePath: string): Buffer {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new IngestError('IMPORT_FILE_UNREADABLE', 'the --file path is not a regular file');
    if (st.size > MAX_IMPORT_BYTES) throw new IngestError('IMPORT_FILE_INVALID', `the file is larger than ${MAX_IMPORT_BYTES} bytes`);
    return fs.readFileSync(filePath);
  } catch (e) {
    if (e instanceof IngestError) throw e;
    const code = (e as { code?: unknown }).code;
    throw new IngestError('IMPORT_FILE_UNREADABLE', `the --file could not be read (${typeof code === 'string' ? code : 'error'})`);
  }
}

/** `cli import-file`: one local FOCUS .csv / .csv.gz file through stageAndSync. */
export async function importFile(o: Omit<StageAndSyncOptions, 'objects' | 'sourceKind' | 'schemaVersion'> & { filePath: string }): Promise<StageAndSyncResult> {
  const name = path.basename(o.filePath);
  const bytes = decodeImportFile(readFile(o.filePath), name);
  return stageAndSync({ ...o, objects: [{ name, bytes }] });
}
