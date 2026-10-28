// R3: one ingestion path for file imports AND (later rows) managed connectors.
// stageAndSync: delivery bytes → normalizer (normalizer.ts; pass-through for
// FOCUS) → staging into the source's ratio-file-drop layout (stageFile.ts) →
// the EXISTING pipeline (runSync: evidence capture, validator, provider check,
// quarantine, reconciliation, publish/supersede) over exactly the staged
// periods. No new parser and no new publish path. Idempotent: the same bytes
// stage to the same objects, so a re-delivery is `unchanged`.
//
// Restatement (review B1): a delivery is the COMPLETE content of every billing
// period it contains. A delivery whose content for an already-published period
// differs (a later part of a split file, stray rows of an earlier period, a
// corrected file) would supersede that period, so it is REFUSED before anything
// is written (status `refused`, PERIOD_ALREADY_PUBLISHED, CLI exit 3) unless
// `restate` is set; both outcomes report the published and the staged row
// counts and billed totals per period. Deliver the parts of one period together
// (several files form one delivery).
//
// Concurrency (review round 2 B1): the whole check + stage + sync of one import holds a session advisory
// lock on (tenant, source) taken BEFORE the restatement guard and before anything is staged. A second
// import of the same source meanwhile exits ALREADY_RUNNING (exit 4) having written nothing; its retry
// then sees the first import's published content (PERIOD_ALREADY_PUBLISHED, exit 3, or `unchanged`).
// The source's RUN LEASE (review round 3) is taken after the guard and BEFORE the first object is put, and
// the sync runs under it: while any other run (a sync, a backfill, a replay) holds a live lease the import
// exits ALREADY_RUNNING (exit 4) having written nothing to S3, and a sync started while the import stages
// is itself refused, so it never publishes a half-staged delivery. A staging failure finishes the run.
// Every period's manifest lives at one key, so the sync is also told the sha256 of each manifest this
// import staged: a period whose listed manifest is not this import's fails IMPORT_MANIFEST_REPLACED and
// publishes nothing, so an import never reports `published` for data it did not stage.
// importFile (`cli import-file`) is a thin wrapper that reads local files.
import fs from 'fs';
import { Readable } from 'stream';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import type { EvidenceStore } from '../evidence/types';
import { declaredProviders } from '../focus/provider';
import { validateLocation } from '../sources/s3/layout';
import type { FocusSource } from '../sources/types';
import { resolveSettings } from '../config';
import { IngestError, errorCodeOf, messageOf } from '../errors';
import { redact } from '../redact';
import { acquireRun, finishRun, loadSource, type SourceRow } from '../worker/lease';
import { runSync, type LogFn, type RunSyncOptions } from '../worker/pipeline';
import { workerTransaction } from '../worker/tx';
import { SimulatedCrash, type PeriodResult, type RunResult } from '../worker/types';
import { collect, normalizerFor, type MappingReport } from './normalizer';
import { MAX_IMPORT_BYTES, decodeImportFile, stageFile, tooLarge, type PeriodPreview, type StageControl, type StageInput, type StageOptions, type StagedFile } from './stageFile';

export const NO_CONTROL_NOTE = 'unverified (no control total supplied)';
export const VARIANCE_NOTE =
  'not published: the supplied control totals do not match the rows of the declared providers in this file (a partial or different delivery); see: cli quarantine show --batch <batchId>';
export const UNCHANGED_CONTROL_NOTE =
  'unverified: the data is unchanged and its published batch was published without these controls, so they are not recorded on it; re-import with --restate to reconcile it against them';
export const UNCHANGED_VARIANCE_NOTE =
  'unverified: the data is unchanged and the supplied controls do not match its published batch, which stays as it was; check the controls (a partial or different delivery?)';

export interface DeliveryObject {
  name: string;
  bytes?: Buffer;
  stream?: Readable;
  /** Loads the bytes when the delivery is staged (so the caller holds no copy). */
  load?: () => Promise<Buffer>;
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
  /** Supersede already-published periods whose content differs (and record controls on unchanged data). */
  restate?: boolean;
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

/** An already-published period whose content the delivery changes. */
export interface Restatement {
  billingPeriod: string;
  /** Whether this run superseded the published batch. */
  applied: boolean;
  published: { batchId: string; rowCount: string; billedTotal: string; reconciliation: string };
  /** The delivery's declared-provider rows of the period, before validation. */
  staged: { rows: number; billed: PeriodPreview['billed'] };
}

interface Common {
  files: Array<{ sha256: string; dataRows: number }>;
  nullTokensReplaced: Record<string, number>;
  normalization: MappingReport[];
  staged: Array<{ billingPeriod: string; records: number }>;
  restatements: Restatement[];
}

export interface StageAndSyncResult extends Omit<RunResult, 'periods'>, Common {
  periods: ImportPeriodResult[];
}

export interface ImportRefusal extends Common {
  status: 'refused';
  error: { code: 'PERIOD_ALREADY_PUBLISHED'; message: string };
}

const fail = (code: string, m: string): never => {
  throw new IngestError(code, m);
};

interface PublishedBatch {
  period: string;
  batch_id: string;
  row_count: string;
  total: string;
  reconciliation: string;
  shas: string[];
}

export async function stageAndSync(o: StageAndSyncOptions): Promise<StageAndSyncResult | ImportRefusal> {
  const row = await workerTransaction(o.pool, o.tenantId, (c) => loadSource(c, o.sourceKey));
  if (row.kind !== 'focus_file' || row.config.layout !== 'ratio-file-drop') {
    throw new IngestError('IMPORT_SOURCE_NOT_FILE_DROP', `source ${o.sourceKey} is not a file-import source (register one with: cli source add)`);
  }
  if (!row.enabled) throw new IngestError('SOURCE_DISABLED', `source ${o.sourceKey} is disabled`);
  const location = validateLocation(row.config);
  const providers = declaredProviders(row.config);
  if (!providers) throw new IngestError('SOURCE_CONFIG_INVALID', 'source config providers must be a non-empty list of known providers');
  const control = o.control && Object.values(o.control).some((v) => v !== undefined) ? o.control : undefined;
  // Review M2: a row count alone would make the worker report `reconciled` with the billed total unchecked.
  if (control && control.rowCount !== undefined && control.billedTotal === undefined) {
    fail('IMPORT_CONTROL_INVALID', 'a control row count needs the control billed total (--control-billed with --currency): a row count alone cannot reconcile a period');
  }
  const lock = await lockImport(o.pool, row);
  try {
    return await stageAndSyncLocked(o, row, location, providers, control);
  } finally {
    await lock.release();
  }
}

/** Session advisory lock (tenant, source) for one import, or ALREADY_RUNNING without waiting. */
async function lockImport(pool: Pool, row: SourceRow): Promise<{ release(): Promise<void> }> {
  const key = `ratio.import:${row.tenantId}:${row.id}`;
  const c = await pool.connect();
  let ok: boolean;
  try {
    ok = (await c.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [key])).rows[0].ok === true;
  } catch (e) {
    c.release(e as Error);
    throw e;
  }
  if (!ok) {
    c.release();
    throw new IngestError('ALREADY_RUNNING', 'another import of this source is in progress; nothing was written (run this import again when it has finished)');
  }
  return {
    async release() {
      try {
        await c.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
        c.release();
      } catch (e) {
        c.release(e as Error); // a broken session drops its locks with it
      }
    },
  };
}

async function stageAndSyncLocked(
  o: StageAndSyncOptions,
  row: SourceRow,
  location: ReturnType<typeof validateLocation>,
  providers: readonly string[],
  control: StageControl | undefined,
): Promise<StageAndSyncResult | ImportRefusal> {

  const normalizer = normalizerFor(o.sourceKind ?? 'focus-export', o.schemaVersion ?? '1.0');
  const inputs: StageInput[] = [];
  const normalization: MappingReport[] = [];
  let used = 0;
  for (const obj of o.objects) {
    const raw = obj.load ? await obj.load() : obj.bytes;
    const { csv, report } = await normalizer.normalize(obj.stream ?? Readable.from(raw ?? Buffer.alloc(0)));
    const bytes = await collect(csv, MAX_IMPORT_BYTES - used);
    used += bytes.length;
    inputs.push({ name: obj.name, bytes });
    normalization.push(report);
  }
  let staged: StagedFile | null = stageFile(inputs, { location, period: o.period, control, providers, provenance: { ...o.provenance, normalization } });
  inputs.length = 0; // review B2: the delivery bytes are not held past staging
  const dataOf = (period: string) => [...new Set(staged!.objects.filter((x) => x.kind === 'data' && x.billingPeriod === period).map((x) => x.sha256))].sort();

  // Duplicate guard (review M1): the same bytes already held by a published or staged batch of ANOTHER source
  // of this tenant whose declared providers OVERLAP this source's would be counted twice. A source with
  // disjoint providers publishes other rows of the same file (the [AWS] / [Microsoft] workflow). A source
  // without a declared list (another layout) counts as overlapping. Existing worker grants, no migration.
  const shas = staged.objects.filter((x) => x.kind === 'data').map((x) => x.sha256);
  const dup = await workerTransaction(o.pool, o.tenantId, (c) =>
    c.query(
      `SELECT 1 FROM ratio.ingest_artifacts a
       JOIN ratio.ingest_batches b ON b.tenant_id = a.tenant_id AND b.id = a.batch_id
       JOIN ratio.sources s ON s.tenant_id = a.tenant_id AND s.id = a.source_id
       WHERE a.sha256 = ANY($1::text[]) AND a.source_id <> $2 AND b.status IN ('published', 'staged')
         AND CASE s.config ->> 'layout'
               WHEN 'ratio-file-drop' THEN (s.config -> 'providers') ?| $3::text[]
               WHEN 'aws-data-exports' THEN 'AWS' = ANY($3::text[])
               ELSE true END
       LIMIT 1`,
      [shas, row.id, providers],
    ),
  );
  if (dup.rowCount) throw new IngestError('DUPLICATE_ARTIFACT', 'this file (or a billing period of it) is already imported under another source of this tenant with an overlapping provider; refused to avoid double counting');

  // Review B1: the published batch of every staged period, with its artifact set.
  const published = await workerTransaction(o.pool, o.tenantId, async (c) => {
    const r = await c.query(
      `SELECT b.billing_period::text AS period, b.id::text AS batch_id, b.row_count::text AS row_count, b.loaded_billed_total::text AS total, b.reconciliation,
              (SELECT array_agg(DISTINCT a.sha256 ORDER BY a.sha256) FROM ratio.ingest_artifacts a WHERE a.tenant_id = b.tenant_id AND a.batch_id = b.id) AS shas
       FROM ratio.ingest_batches b WHERE b.source_id = $1 AND b.status = 'published' AND b.billing_period = ANY($2::date[])`,
      [row.id, staged!.periods.map((p) => p.billingPeriod)],
    );
    return new Map((r.rows as PublishedBatch[]).map((x) => [x.period, x]));
  });
  const restatements: Restatement[] = [];
  for (const p of staged.preview) {
    const prev = published.get(p.billingPeriod);
    if (!prev || (prev.shas ?? []).join('\n') === dataOf(p.billingPeriod).join('\n')) continue;
    restatements.push({
      billingPeriod: p.billingPeriod,
      applied: false,
      published: { batchId: prev.batch_id, rowCount: prev.row_count, billedTotal: prev.total, reconciliation: prev.reconciliation },
      staged: { rows: p.rows, billed: p.billed },
    });
  }
  const common = (s: StagedFile): Common => ({
    files: s.files.map((f) => ({ sha256: f.sha256, dataRows: f.dataRows })),
    nullTokensReplaced: s.nullTokensReplaced,
    normalization,
    staged: s.periods,
    restatements,
  });
  if (restatements.length && !o.restate) {
    const list = restatements.map((x) => x.billingPeriod.slice(0, 7)).join(', ');
    return {
      status: 'refused',
      error: {
        code: 'PERIOD_ALREADY_PUBLISHED',
        message: `nothing was imported: billing period(s) ${list} are already published with different content, and a delivery replaces a period's content completely. Deliver all parts of a period together (several --file values), import other periods with --period YYYY-MM, or pass --restate to supersede the published content (see restatements for the published and the staged counts and totals)`,
      },
      ...common(staged),
    };
  }

  // Review round 3: the run lease is taken BEFORE anything is staged, so an import refused because another
  // run holds it (ALREADY_RUNNING / LOCK_TIMEOUT, exit 4) has written nothing to S3, and no sync can list
  // (and publish) a half-staged delivery while this import stages. The sync below runs under this lease.
  const range = { from: staged.periods[0].billingPeriod, to: staged.periods[staged.periods.length - 1].billingPeriod };
  const acquired = await acquireRun(o.pool, o.tenantId, o.sourceKey, { kind: 'backfill', ttlSeconds: resolveSettings(o.settings).leaseTtlSeconds, periodFrom: range.from, periodTo: range.to });
  o.log?.('run.started', { runId: acquired.lease.runId, mode: 'backfill', abandonedRuns: acquired.abandoned.length, discardedStagedBatches: acquired.discardedBatches });
  let run: RunResult;
  let out: Common;
  try {
    // Data first, manifests last: a manifest never names an object that is not there yet.
    const client = o.sourceClient();
    for (const obj of [...staged.objects.filter((x) => x.kind === 'data'), ...staged.objects.filter((x) => x.kind === 'manifest')]) {
      await client.send(new PutObjectCommand({ Bucket: location.bucket, Key: obj.key, Body: obj.body, ContentType: obj.kind === 'data' ? 'application/gzip' : 'application/json' }));
    }
    o.log?.('import.staged', { periods: staged.periods.length, objects: staged.objects.length, restatements: restatements.length });
    out = common(staged);
    const expectManifests = new Map(staged.objects.filter((x) => x.kind === 'manifest').map((x) => [x.billingPeriod, x.sha256]));
    staged = null;

    run = await runSync({
      pool: o.pool,
      tenantId: o.tenantId,
      sourceKey: o.sourceKey,
      source: o.source,
      evidence: o.evidence,
      mode: 'backfill',
      range,
      settings: o.settings,
      hooks: o.hooks,
      log: o.log,
      secrets: o.secrets,
      restateControls: o.restate === true,
      expectManifests,
      acquired,
    });
  } catch (e) {
    // Staging (or a check before the run started) failed: release the lease. Fenced like every lease write,
    // so a run that already finished, or was taken over, is left as it is.
    if (!(e instanceof SimulatedCrash)) {
      await finishRun(o.pool, acquired.lease, { status: 'failed', errorCode: errorCodeOf(e), errorDetail: redact(messageOf(e), o.secrets ?? []).slice(0, 1000), stats: { mode: 'backfill', import: true } }).catch(() => false);
    }
    throw e;
  }
  for (const x of restatements) x.applied = run.periods.some((p) => p.billingPeriod === x.billingPeriod && p.outcome === 'published');
  return {
    ...run,
    periods: run.periods.map((p): ImportPeriodResult => {
      if (p.outcome === 'quarantined' && p.code === 'RECONCILIATION_VARIANCE') return { ...p, reconciliationNote: VARIANCE_NOTE };
      const prev = published.get(p.billingPeriod);
      // Review M3: controls on unchanged data are never silently dropped.
      if (control && p.outcome === 'failed' && p.code === 'CONTROL_VARIANCE_ON_UNCHANGED') return { ...p, reconciliation: 'unverified', reconciliationNote: UNCHANGED_VARIANCE_NOTE };
      if (control && p.outcome === 'unchanged' && prev && prev.batch_id === p.batchId && prev.reconciliation !== 'reconciled') {
        return { ...p, reconciliation: 'unverified', reconciliationNote: UNCHANGED_CONTROL_NOTE };
      }
      return p.reconciliation === 'unverified' && !control ? { ...p, reconciliationNote: NO_CONTROL_NOTE } : p;
    }),
    ...out,
  };
}

/**
 * Refuses (IMPORT_TOO_LARGE) before anything is read when the files together exceed the cap, and
 * returns loaders that decode each file within what is left of it. File names never reach output.
 */
export function localDelivery(filePaths: readonly string[], max: number = MAX_IMPORT_BYTES): DeliveryObject[] {
  let total = 0;
  filePaths.forEach((p, i) => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      throw new IngestError('IMPORT_FILE_UNREADABLE', `file ${i + 1} could not be read (${typeof code === 'string' ? code : 'error'})`);
    }
    if (!st.isFile()) throw new IngestError('IMPORT_FILE_UNREADABLE', `file ${i + 1} is not a regular file`);
    total += st.size;
  });
  if (total > max) tooLarge(max);
  let used = 0;
  return filePaths.map((p, i) => ({
    name: `file ${i + 1}`,
    load: async () => {
      let raw: Buffer;
      try {
        raw = await fs.promises.readFile(p);
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        throw new IngestError('IMPORT_FILE_UNREADABLE', `file ${i + 1} could not be read (${typeof code === 'string' ? code : 'error'})`);
      }
      const bytes = await decodeImportFile(raw, p, max - used);
      used += bytes.length;
      return bytes;
    },
  }));
}

/** The staging part of `import-file` alone (no database, no S3): the memory test's real path. */
export async function stageLocalFiles(filePaths: readonly string[], opts: StageOptions): Promise<StagedFile> {
  const inputs: StageInput[] = [];
  for (const d of localDelivery(filePaths)) inputs.push({ name: d.name, bytes: await d.load!() });
  return stageFile(inputs, opts);
}

/** `cli import-file`: local FOCUS .csv / .csv.gz files, ONE delivery, through stageAndSync. */
export async function importFile(o: Omit<StageAndSyncOptions, 'objects' | 'sourceKind' | 'schemaVersion'> & { filePaths: readonly string[] }): Promise<StageAndSyncResult | ImportRefusal> {
  const { filePaths, ...rest } = o;
  return stageAndSync({ ...rest, objects: localDelivery(filePaths) });
}
