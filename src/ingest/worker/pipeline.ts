// Source → evidence → staged batch → (quarantine | publish), per billing period.
// sync (incremental), backfill (explicit range) and replay --period (re-ingest,
// ignores checkpoint) share this pipeline. See DESIGN.md §4 for the full flow.
import crypto from 'crypto';
import type { Pool } from 'pg';
import { IngestError, errorCodeOf, messageOf } from '../errors';
import { redact, redactDeep } from '../redact';
import { withRetry } from '../retry';
import { resolveSettings, type WorkerLimits, type WorkerSettings } from '../config';
import { withTenantTransaction } from '../db/tenant';
import type { EvidenceStore } from '../evidence/types';
import { classifyArtifact } from '../sources/s3/layout';
import type { FocusSource, PeriodArtifactSet, PeriodListing, PeriodRange } from '../sources/types';
import { captureArtifact, captureManifest, type CapturedArtifact } from './capture';
import { acquireRun, finishRun, heartbeat, recordRetry, type Lease, type SourceRow } from './lease';
import { addError, loadArtifact, newLoadState } from './load';
import {
  aggregateBatch,
  discardStagedBatch,
  finalizeStaged,
  numericEquals,
  publishBatch,
  quarantineBatch,
  readCheckpoint,
  refreshCheckpoint,
  stageBatch,
  type CheckpointEntry,
} from './publish';
import { SUCCESS_OUTCOMES, SimulatedCrash, canonicalTenant, type PeriodResult, type RunResult, type WorkerHooks } from './types';

export type RunMode = 'sync' | 'backfill' | 'replay_period';
export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export interface RunSyncOptions {
  pool: Pool;
  tenantId: string;
  sourceKey: string;
  /** A source instance, or a factory resolving one from the (RLS-visible) source row. */
  source: FocusSource | ((row: SourceRow) => FocusSource);
  evidence: EvidenceStore;
  mode: RunMode;
  range?: PeriodRange;
  settings?: Partial<Omit<WorkerSettings, 'limits'>> & { limits?: Partial<WorkerLimits> };
  hooks?: WorkerHooks;
  log?: LogFn;
  /** Extra literal secrets to redact from anything persisted. */
  secrets?: readonly string[];
}

const SOURCE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function setFingerprint(shas: string[]): string {
  return crypto.createHash('sha256').update([...shas].sort().join('\n')).digest('hex');
}

const RUN_KIND = { sync: 'scheduled', backfill: 'backfill', replay_period: 'replay' } as const;

export async function runSync(opts: RunSyncOptions): Promise<RunResult> {
  const tenantId = canonicalTenant(opts.tenantId);
  if (typeof opts.sourceKey !== 'string' || !SOURCE_KEY_RE.test(opts.sourceKey)) throw new IngestError('INVALID_SOURCE_KEY', 'source key is invalid');
  if ((opts.mode === 'backfill' || opts.mode === 'replay_period') && !opts.range) throw new IngestError('INVALID_RANGE', `${opts.mode} needs a period range`);
  if (opts.range && opts.range.from > opts.range.to) throw new IngestError('INVALID_RANGE', 'range from is after to');
  const settings = resolveSettings(opts.settings);
  const hooks = opts.hooks ?? {};
  const log: LogFn = opts.log ?? (() => undefined);
  const secrets = opts.secrets ?? [];
  const clean = (s: string) => redact(s, secrets);

  const { lease, source: sourceRow, abandoned, discardedBatches } = await acquireRun(opts.pool, tenantId, opts.sourceKey, {
    kind: RUN_KIND[opts.mode],
    ttlSeconds: settings.leaseTtlSeconds,
    periodFrom: opts.range?.from,
    periodTo: opts.range?.to,
  });
  log('run.started', { runId: lease.runId, mode: opts.mode, abandonedRuns: abandoned.length, discardedStagedBatches: discardedBatches });

  // Background heartbeat so a long capture/parse of one large artifact cannot
  // outlive the lease. It never revives an expired lease (heartbeat is fenced);
  // a failure only means the next fenced write will report LEASE_LOST. Stopped
  // on every exit path, including a simulated crash (a dead process is silent).
  const beat = setInterval(() => {
    void heartbeat(opts.pool, lease.tenantId, lease.runId, lease.token, settings.leaseTtlSeconds).then(
      () => {
        lastBeat = Date.now();
      },
      () => undefined,
    );
  }, Math.max(1000, Math.floor((settings.leaseTtlSeconds * 1000) / 3)));
  beat.unref();
  let lastBeat = Date.now();
  const maybeHeartbeat = async () => {
    if (Date.now() - lastBeat >= (settings.leaseTtlSeconds * 1000) / 3) {
      await heartbeat(opts.pool, lease.tenantId, lease.runId, lease.token, settings.leaseTtlSeconds);
      lastBeat = Date.now();
    }
  };

  const periods: PeriodResult[] = [];
  const manifestEvidence: string[] = [];
  let attempts = 1;
  const stats = () =>
    redactDeep({ periods, manifestEvidence, mode: opts.mode, abandonedRuns: abandoned, discardedStagedBatches: discardedBatches }, secrets) as Record<string, unknown>;

  try {
    return await runPeriods();
  } finally {
    clearInterval(beat);
  }

  async function runPeriods(): Promise<RunResult> {
    try {
      const source = typeof opts.source === 'function' ? opts.source(sourceRow) : opts.source;
      const retryOpts = {
        maxAttempts: settings.maxAttempts,
        baseMs: settings.retryBaseMs,
        maxMs: settings.retryMaxMs,
        sleep: hooks.sleep,
        random: hooks.random,
      };
      const onRetry = (period: string | null) => async ({ attempt, error }: { attempt: number; error: unknown }) => {
        attempts = attempt;
        const code = errorCodeOf(error);
        log('run.retry', { runId: lease.runId, attempt, code, period });
        await recordRetry(opts.pool, lease, { attempt, code, period, at: new Date().toISOString() });
      };

      let listings: PeriodListing[];
      try {
        listings = await withRetry(() => source.listPeriods(opts.range), { ...retryOpts, onRetry: onRetry(null) });
      } catch (e) {
        if (e instanceof IngestError && e.code === 'LEASE_LOST') throw e;
        const code = e instanceof IngestError ? e.code : 'SOURCE_LIST_FAILED';
        await finishRun(opts.pool, lease, { status: 'failed', errorCode: code, errorDetail: clean(`listing the source failed: ${messageOf(e)}`), stats: stats() });
        log('run.finished', { runId: lease.runId, status: 'failed', code });
        return { runId: lease.runId, status: 'failed', periods, errorCode: code, attempts, manifestEvidence };
      }

      const checkpoint = await withTenantTransaction(opts.pool, lease.tenantId, (c) => readCheckpoint(c, lease.sourceId));

      for (const listing of listings) {
        const period = listing.ok ? listing.set.billingPeriod : listing.billingPeriod;
        const manifest = listing.ok ? listing.set.manifest : listing.manifest;
        if (manifest) {
          try {
            manifestEvidence.push(await withRetry(() => captureManifest(opts.evidence, lease.tenantId, lease.sourceId, manifest.bytes), { ...retryOpts, onRetry: onRetry(period) }));
          } catch (e) {
            if (e instanceof SimulatedCrash || (e instanceof IngestError && e.code === 'LEASE_LOST')) throw e;
            periods.push({ billingPeriod: period, outcome: 'failed', code: errorCodeOf(e), message: clean(messageOf(e)) });
            continue;
          }
        }
        if (!listing.ok) {
          periods.push({ billingPeriod: period, outcome: 'failed', code: listing.code, message: clean(listing.message) });
          log('period.failed', { runId: lease.runId, period, code: listing.code });
          continue;
        }
        const prev = checkpoint[period];
        if (opts.mode !== 'replay_period' && prev?.pinned) {
          periods.push({ billingPeriod: period, outcome: 'skipped_pinned', batchId: prev.batchId });
          log('period.skipped', { runId: lease.runId, period, reason: 'pinned' });
          continue;
        }
        if (opts.mode === 'sync' && prev?.listing && prev.listing === listing.set.listingFingerprint) {
          periods.push({ billingPeriod: period, outcome: 'skipped_unchanged', batchId: prev.batchId, artifactSetFingerprint: prev.fingerprint });
          log('period.skipped', { runId: lease.runId, period, reason: 'unchanged' });
          continue;
        }
        try {
          const result = await withRetry(
            () => processPeriod({ pool: opts.pool, lease, source, evidence: opts.evidence, set: listing.set, settings, hooks, log, mode: opts.mode, maybeHeartbeat, clean, sourceRow }),
            { ...retryOpts, onRetry: onRetry(period) },
          );
          periods.push(result);
        } catch (e) {
          if (e instanceof SimulatedCrash) throw e;
          if (e instanceof IngestError && e.code === 'LEASE_LOST') throw e;
          periods.push({ billingPeriod: period, outcome: 'failed', code: errorCodeOf(e), message: clean(messageOf(e)) });
          log('period.failed', { runId: lease.runId, period, code: errorCodeOf(e) });
        }
      }
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e; // a "dead process" finishes nothing
      if (e instanceof IngestError && e.code === 'LEASE_LOST') {
        log('run.lease_lost', { runId: lease.runId });
        // Only finishes if the run was not taken over (conditioned on token + running).
        await finishRun(opts.pool, lease, { status: 'failed', errorCode: 'LEASE_LOST', errorDetail: 'lease lost during the run', stats: stats() }).catch(() => false);
        throw e;
      }
      const code = errorCodeOf(e);
      await finishRun(opts.pool, lease, { status: 'failed', errorCode: code, errorDetail: clean(messageOf(e)), stats: stats() }).catch(() => false);
      log('run.finished', { runId: lease.runId, status: 'failed', code });
      throw e;
    }

    const failed = periods.find((p) => !SUCCESS_OUTCOMES.has(p.outcome));
    const status = failed ? 'failed' : 'succeeded';
    const errorCode = failed?.code ?? (failed ? 'PERIOD_FAILED' : undefined);
    const errorDetail = failed
      ? clean(
          periods
            .filter((p) => !SUCCESS_OUTCOMES.has(p.outcome))
            .map((p) => `${p.billingPeriod} ${p.outcome}${p.code ? ` ${p.code}` : ''}${p.message ? `: ${p.message}` : ''}`)
            .join('; '),
        )
      : null;
    const finished = await finishRun(opts.pool, lease, { status, errorCode: errorCode ?? null, errorDetail, stats: stats() });
    if (!finished) throw new IngestError('LEASE_LOST', 'run was taken over before it could finish');
    log('run.finished', { runId: lease.runId, status, code: errorCode ?? null, periods: periods.map((p) => ({ period: p.billingPeriod, outcome: p.outcome, code: p.code ?? null })) });
    return { runId: lease.runId, status, periods, ...(errorCode ? { errorCode } : {}), attempts, manifestEvidence };
  }
}

interface PeriodCtx {
  pool: Pool;
  lease: Lease;
  source: FocusSource;
  evidence: EvidenceStore;
  set: PeriodArtifactSet;
  settings: WorkerSettings;
  hooks: WorkerHooks;
  log: LogFn;
  mode: RunMode;
  maybeHeartbeat: () => Promise<void>;
  clean: (s: string) => string;
  sourceRow: SourceRow;
}

function quarantineReason(code: string, detail: string, codes?: Map<string, number>): string {
  const summary = codes && codes.size ? ` (${[...codes.entries()].map(([c, n]) => `${c} x${n}`).join(', ')})` : '';
  return `${code}: ${detail}${summary}`;
}

async function processPeriod(ctx: PeriodCtx): Promise<PeriodResult> {
  const { set, lease, settings } = ctx;
  const period = set.billingPeriod;
  const limits = settings.limits;

  // Size gate from the listing (nothing downloaded yet).
  const total = set.artifacts.reduce((a, x) => a + x.byteSize, 0);
  if (set.artifacts.length > limits.maxArtifactsPerSet || set.artifacts.some((a) => a.byteSize > limits.maxArtifactBytes) || total > limits.maxBatchBytes) {
    return { billingPeriod: period, outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE', message: 'artifact set exceeds the configured size limits' };
  }

  // Raw evidence first.
  const captured: CapturedArtifact[] = [];
  for (const ref of [...set.artifacts].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    captured.push(
      await captureArtifact({ source: ctx.source, evidence: ctx.evidence, ref, tenantId: lease.tenantId, sourceId: lease.sourceId, tmpDir: settings.tmpDir, maxBytes: limits.maxArtifactBytes }),
    );
    await ctx.maybeHeartbeat();
  }
  const fingerprint = setFingerprint(captured.map((c) => c.sha256));

  // Existing batch for exactly this artifact set?
  const existing = await withTenantTransaction(ctx.pool, lease.tenantId, async (c) => {
    const r = await c.query(
      `SELECT id::text, status, row_count::text AS row_count, loaded_billed_total::text AS total, reconciliation
       FROM ratio.ingest_batches WHERE source_id = $1 AND billing_period = $2 AND artifact_set_fingerprint = $3`,
      [lease.sourceId, period, fingerprint],
    );
    return r.rows[0] as { id: string; status: string; row_count: string; total: string; reconciliation: string } | undefined;
  });
  const entry = (batchId: string) => (): CheckpointEntry => ({ fingerprint, listing: set.listingFingerprint, batchId, pinned: false });

  if (existing?.status === 'published') {
    if (set.control && (await controlDisagrees(ctx.pool, set.control, existing.row_count, existing.total))) {
      return { billingPeriod: period, outcome: 'failed', code: 'CONTROL_VARIANCE_ON_UNCHANGED', batchId: existing.id, message: 'artifacts are unchanged but the control totals no longer match the published batch' };
    }
    await refreshCheckpoint(ctx.pool, lease, period, entry(existing.id));
    return { billingPeriod: period, outcome: 'unchanged', batchId: existing.id, artifactSetFingerprint: fingerprint, rowCount: existing.row_count, billedTotal: existing.total };
  }
  if (existing?.status === 'superseded') {
    if (set.control && (await controlDisagrees(ctx.pool, set.control, existing.row_count, existing.total))) {
      return { billingPeriod: period, outcome: 'failed', code: 'CONTROL_VARIANCE_ON_UNCHANGED', batchId: existing.id, message: 'artifacts match a retained batch but the control totals do not' };
    }
    await publishBatch(ctx.pool, lease, { batchId: existing.id, billingPeriod: period, checkpoint: entry(existing.id) }, ctx.hooks);
    ctx.log('period.republished', { runId: lease.runId, period, batchId: existing.id });
    return { billingPeriod: period, outcome: 'republished', batchId: existing.id, artifactSetFingerprint: fingerprint, rowCount: existing.row_count, billedTotal: existing.total };
  }
  if (existing?.status === 'quarantined') {
    return { billingPeriod: period, outcome: 'failed', code: 'BATCH_QUARANTINED', batchId: existing.id, message: 'this exact artifact set was already quarantined' };
  }
  if (existing?.status === 'staged') await discardStagedBatch(ctx.pool, lease, existing.id);

  // Stage. Byte-identical duplicates within one set are recorded once (unique sha per batch).
  const batchId = crypto.randomUUID();
  const unique = new Map<string, CapturedArtifact>();
  for (const c of captured) if (!unique.has(c.sha256)) unique.set(c.sha256, c);
  await stageBatch(ctx.pool, lease, {
    batchId,
    billingPeriod: period,
    fingerprint,
    control: set.control,
    artifacts: [...unique.values()].map((c) => ({ name: c.ref.name, sha256: c.sha256, byteSize: c.byteSize, evidenceKey: c.evidenceKey })),
  });
  ctx.log('batch.staged', { runId: lease.runId, period, batchId, artifacts: unique.size });

  const state = newLoadState();
  const quarantine = async (code: string, detail: string, extra: { reconciliation?: 'variance'; rowCount?: string; billedTotal?: string } = {}): Promise<PeriodResult> => {
    await quarantineBatch(
      ctx.pool,
      lease,
      { batchId, billingPeriod: period, reason: ctx.clean(quarantineReason(code, detail, state.errorCodes)), errors: state.errors, errorCount: state.errorCount, perArtifactRows: state.perArtifactRows, ...extra },
      ctx.hooks,
    );
    ctx.log('batch.quarantined', { runId: lease.runId, period, batchId, code, errors: state.errorCount });
    return { billingPeriod: period, outcome: 'quarantined', code, batchId, artifactSetFingerprint: fingerprint, ...(extra.reconciliation ? { reconciliation: extra.reconciliation } : {}) };
  };

  if (captured.length === 0) return quarantine('EMPTY_ARTIFACT_SET', 'the manifest lists no data files');
  if (unique.size !== captured.length) return quarantine('DUPLICATE_ARTIFACT', 'two artifacts in the set have identical bytes');

  const focusVersion = ctx.sourceRow.declaredFocusVersion ?? '1.0';
  for (const c of [...unique.values()]) {
    await loadArtifact(
      { pool: ctx.pool, evidence: ctx.evidence, lease, batchId, billingPeriod: period, focusVersion, limits, hooks: ctx.hooks, maybeHeartbeat: ctx.maybeHeartbeat },
      { name: c.ref.name, sha256: c.sha256, byteSize: c.byteSize, evidenceKey: c.evidenceKey, format: classifyArtifact(c.ref.name) },
      state,
    );
    if (state.halted) break;
  }
  if (state.errorCount > 0) {
    const first = [...state.errorCodes.keys()][0];
    const code = state.errorCodes.has('ROW_LIMIT_EXCEEDED') ? 'ROW_LIMIT_EXCEEDED' : first === 'UNSUPPORTED_FORMAT' ? 'UNSUPPORTED_FORMAT' : 'VALIDATION_FAILED';
    return quarantine(code, `${state.errorCount} validation error(s)`);
  }

  // Reconcile in Postgres.
  const agg = await aggregateBatch(ctx.pool, lease, batchId);
  if (agg.rowCount !== String(state.rowsInserted)) {
    throw new IngestError('INTERNAL_COUNT_MISMATCH', `loaded ${agg.rowCount} rows but parsed ${state.rowsInserted}`);
  }
  if (agg.rowCount === '0') return quarantine('EMPTY_BATCH', 'the artifact set contains no data rows', { rowCount: '0', billedTotal: '0' });
  if (agg.currencies > 1) {
    addError(state, { artifactSha256: [...unique.keys()][0], rowOrdinal: null, column: 'BillingCurrency', code: 'MIXED_BILLING_CURRENCY', message: `${agg.currencies} billing currencies in one batch` });
    return quarantine('MIXED_BILLING_CURRENCY', 'a batch must have a single billing currency', { rowCount: agg.rowCount, billedTotal: agg.billedTotal });
  }
  const verdict = await reconcile(ctx.pool, set.control, agg, state.perArtifactRows);
  if (verdict.variance) {
    return quarantine('RECONCILIATION_VARIANCE', verdict.detail, { reconciliation: 'variance', rowCount: agg.rowCount, billedTotal: agg.billedTotal });
  }
  await finalizeStaged(ctx.pool, lease, { batchId, rowCount: agg.rowCount, billedTotal: agg.billedTotal, reconciliation: verdict.reconciliation, perArtifactRows: state.perArtifactRows });

  if (ctx.hooks.beforePublish) await ctx.hooks.beforePublish({ runId: lease.runId, batchId, billingPeriod: period });
  await publishBatch(ctx.pool, lease, { batchId, billingPeriod: period, checkpoint: entry(batchId) }, ctx.hooks);
  ctx.log('batch.published', { runId: lease.runId, period, batchId, rows: agg.rowCount, reconciliation: verdict.reconciliation });
  return { billingPeriod: period, outcome: 'published', batchId, artifactSetFingerprint: fingerprint, rowCount: agg.rowCount, billedTotal: agg.billedTotal, reconciliation: verdict.reconciliation };
}

async function controlDisagrees(pool: Pool, control: NonNullable<PeriodArtifactSet['control']>, rowCount: string, total: string): Promise<boolean> {
  if (control.rowCount !== undefined && String(control.rowCount) !== rowCount) return true;
  if (control.billedTotal !== undefined && !(await numericEquals(pool, control.billedTotal, total))) return true;
  return false;
}

async function reconcile(
  pool: Pool,
  control: PeriodArtifactSet['control'],
  agg: { rowCount: string; billedTotal: string },
  perArtifactRows: Map<string, number>,
): Promise<{ variance: boolean; reconciliation: 'reconciled' | 'unverified'; detail: string }> {
  if (!control) return { variance: false, reconciliation: 'unverified', detail: 'no control totals' };
  const problems: string[] = [];
  if (control.rowCount !== undefined && String(control.rowCount) !== agg.rowCount) problems.push(`row count ${agg.rowCount} vs control ${control.rowCount}`);
  if (control.billedTotal !== undefined && !(await numericEquals(pool, control.billedTotal, agg.billedTotal))) problems.push(`billed total ${agg.billedTotal} vs control ${control.billedTotal}`);
  for (const [name, expected] of Object.entries(control.artifactRowCounts ?? {})) {
    const got = perArtifactRows.get(name);
    if (got !== expected) problems.push(`artifact rows ${got ?? 'missing'} vs control ${expected}`);
  }
  if (problems.length) return { variance: true, reconciliation: 'unverified', detail: problems.join('; ') };
  const complete = control.rowCount !== undefined && control.billedTotal !== undefined;
  return { variance: false, reconciliation: complete ? 'reconciled' : 'unverified', detail: complete ? 'control totals match' : 'partial control matched' };
}
