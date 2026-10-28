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
// importFile (`cli import-file`) is a thin wrapper that reads local files.
import fs from 'fs';
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
import { checkImportMetadata, sameDecimal, scopeWindow, type ImportMetadata } from './metadata';
import { collect, normalizerFor, type MappingReport } from './normalizer';
import { MAX_IMPORT_BYTES, decodeImportFile, stageFile, tooLarge, type PeriodPreview, type StageControl, type StageInput, type StageOptions, type StagedFile } from './stageFile';

export const NO_CONTROL_NOTE = 'unverified (no control total supplied)';
export const VARIANCE_NOTE =
  'not published: the supplied control totals do not match the rows of the declared providers in this file (a partial or different delivery); see: cli quarantine show --batch <batchId>';
export const OVERLAP_MESSAGE = 'another source already published this billing period for an overlapping provider; both are COUNTED TWICE until the R4 exclusion policy applies';
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
  /** The implementation-metadata record (metadata.ts); default: the one stored on the source. */
  metadata?: { metadata: ImportMetadata; sha256: string };
  sourceClient: () => S3Client;
  source: (row: SourceRow) => FocusSource;
  evidence: EvidenceStore;
  settings?: RunSyncOptions['settings'];
  hooks?: RunSyncOptions['hooks'];
  log?: LogFn;
  secrets?: readonly string[];
}

export type ImportPeriodResult = PeriodResult & { reconciliationNote?: string; overlapWarning?: string };

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
  metadataSha256: string | null;
  /**
   * OVERLAP (R4 dependency): staged periods another source already published for an overlapping
   * provider with other bytes. Both are counted until R4's exclusion policy exists; this CLI output
   * (overlapNotice, overlapWarnings, the period's overlapWarning, a warn log line) is the only record.
   */
  overlapNotice: string | null;
  overlapWarnings: Array<{ billingPeriod: string; otherSource: string; message: string }>;
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

/** The metadata record's control for one billing month, or a note why it cannot be one. */
export function metadataControl(m: ImportMetadata, providers: readonly string[], flags: StageControl | undefined): { period?: string; control?: StageControl; note?: string } {
  const bt = m.financial.billed_cost_total;
  if (bt === 'unknown') return {};
  if (flags?.billedTotal !== undefined && (bt[flags.currency!] === undefined || !sameDecimal(bt[flags.currency!], flags.billedTotal))) {
    fail('IMPORT_CONTROL_CONFLICT', 'the --control-billed/--currency flags disagree with the metadata financial.billed_cost_total');
  }
  const entries = Object.entries(bt);
  if (entries.length !== 1 || providers.length !== 1) return { note: 'unverified (the metadata control total spans several currencies or providers; supply per-period controls with --control-billed)' };
  const end = scopeWindow(m.scope).endMs;
  const ym = m.scope.period_start.slice(0, 7);
  const [y, mo] = ym.split('-').map(Number);
  if (end > Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) + 14 * 3600_000) {
    return { note: 'unverified (the metadata control total covers more than one billing month; supply per-period controls with --control-billed)' };
  }
  return { period: `${ym}-01`, control: { billedTotal: entries[0][1], currency: entries[0][0] }, note: `unverified (the metadata control total applies to billing period ${ym} alone; import it with --period ${ym} to reconcile)` };
}

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

  const stored = row.config.metadata;
  const meta = o.metadata ?? (stored !== undefined ? { metadata: checkImportMetadata(stored), sha256: String(row.config.metadataSha256) } : undefined);
  const provenance: Record<string, unknown> = { ...o.provenance };
  let fromMeta: ReturnType<typeof metadataControl> = {};
  if (meta) {
    const m = meta.metadata;
    if (!providers.includes(m.provider)) fail('METADATA_MISMATCH', 'the metadata provider is not one of the providers this source declares');
    fromMeta = metadataControl(m, providers, control);
    Object.assign(provenance, { metadata: m, metadataSha256: meta.sha256 });
    if (m.overlap.also_present_in_other_source === 'yes') {
      const rel = m.overlap.related_source!;
      const relRow = rel === o.sourceKey ? null : await workerTransaction(o.pool, o.tenantId, (c) => loadSource(c, rel)).catch(() => null);
      if (!relRow) fail('IMPORT_RELATED_SOURCE_NOT_FOUND', 'metadata overlap.related_source must name another registered source of this tenant');
      provenance.overlap = { alsoPresentInOtherSource: 'yes', relatedSource: rel, relatedSourceId: relRow!.id };
    }
  }
  // Review M2: a row count alone would make the worker report `reconciled` with the billed total unchecked.
  if (control && control.rowCount !== undefined && control.billedTotal === undefined) {
    fail('IMPORT_CONTROL_INVALID', 'a control row count needs the control billed total (--control-billed with --currency): a row count alone cannot reconcile a period');
  }

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
  let staged: StagedFile | null = stageFile(inputs, {
    location,
    period: o.period,
    control,
    providers,
    provenance: { ...provenance, normalization },
    controlIfSinglePeriod: fromMeta.control && { period: fromMeta.period!, control: fromMeta.control },
    scope: meta && scopeWindow(meta.metadata.scope),
  });
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

  // Same periods already published by another source for an overlapping provider, with other bytes:
  // reported, never silently deduplicated (the exclusion policy belongs to R4).
  const overlaps = await workerTransaction(o.pool, o.tenantId, (c) =>
    c.query(
      `SELECT DISTINCT s.source_key, b.billing_period::text AS period FROM ratio.ingest_batches b
       JOIN ratio.sources s ON s.tenant_id = b.tenant_id AND s.id = b.source_id
       WHERE b.status = 'published' AND b.source_id <> $1 AND b.billing_period = ANY($2::date[])
         AND ((s.config -> 'providers') ?| $3::text[] OR (s.config ->> 'layout' = 'aws-data-exports' AND 'AWS' = ANY($3::text[])))
       ORDER BY 2, 1`,
      [row.id, staged!.periods.map((p) => p.billingPeriod), providers],
    ),
  );
  const overlapWarnings = overlaps.rows.map((x: { source_key: string; period: string }) => ({
    billingPeriod: x.period,
    otherSource: x.source_key,
    message: OVERLAP_MESSAGE,
  }));

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
    metadataSha256: meta?.sha256 ?? null,
    overlapNotice: overlapWarnings.length
      ? `OVERLAP: ${overlapWarnings.length} billing period/source pair(s) are also published by another source for an overlapping provider and are COUNTED TWICE until the R4 exclusion policy exists (this output is the only record); see overlapWarnings`
      : null,
    overlapWarnings,
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

  // Data first, manifests last: a manifest never names an object that is not there yet.
  const client = o.sourceClient();
  for (const obj of [...staged.objects.filter((x) => x.kind === 'data'), ...staged.objects.filter((x) => x.kind === 'manifest')]) {
    await client.send(new PutObjectCommand({ Bucket: location.bucket, Key: obj.key, Body: obj.body, ContentType: obj.kind === 'data' ? 'application/gzip' : 'application/json' }));
  }
  o.log?.('import.staged', { periods: staged.periods.length, objects: staged.objects.length, restatements: restatements.length });
  if (overlapWarnings.length) o.log?.('import.overlap', { level: 'warn', pairs: overlapWarnings.length, detail: 'counted twice until the R4 exclusion policy exists' });
  const out = common(staged);
  const hasControl = staged.controlApplied;
  const range = { from: staged.periods[0].billingPeriod, to: staged.periods[staged.periods.length - 1].billingPeriod };
  staged = null;

  const run = await runSync({
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
  });
  for (const x of restatements) x.applied = run.periods.some((p) => p.billingPeriod === x.billingPeriod && p.outcome === 'published');
  return {
    ...run,
    periods: run.periods.map((p): ImportPeriodResult => {
      if (p.outcome === 'quarantined' && p.code === 'RECONCILIATION_VARIANCE') return { ...p, reconciliationNote: VARIANCE_NOTE };
      const prev = published.get(p.billingPeriod);
      // Review M3: controls on unchanged data are never silently dropped.
      if (hasControl && p.outcome === 'failed' && p.code === 'CONTROL_VARIANCE_ON_UNCHANGED') return { ...p, reconciliation: 'unverified', reconciliationNote: UNCHANGED_VARIANCE_NOTE };
      if (hasControl && p.outcome === 'unchanged' && prev && prev.batch_id === p.batchId && prev.reconciliation !== 'reconciled') {
        return { ...p, reconciliation: 'unverified', reconciliationNote: UNCHANGED_CONTROL_NOTE };
      }
      return p.reconciliation === 'unverified' && !hasControl ? { ...p, reconciliationNote: fromMeta.note ?? NO_CONTROL_NOTE } : p;
    }).map((p) => (overlapWarnings.some((w) => w.billingPeriod === p.billingPeriod) ? { ...p, overlapWarning: OVERLAP_MESSAGE } : p)),
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
