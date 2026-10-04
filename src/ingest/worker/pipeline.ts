// Source → evidence → staged batch → (quarantine | publish), per billing period.
// sync (incremental), backfill (explicit range) and replay --period (re-ingest,
// ignores checkpoint) share this pipeline. See DESIGN.md §4 for the full flow.
import crypto from 'crypto';
import type { Pool } from 'pg';
import { IngestError, errorCodeOf, messageOf } from '../errors';
import { redact, redactDeep } from '../redact';
import { withRetry } from '../retry';
import { resolveSettings, syntheticProvidersOptIn, type WorkerLimits, type WorkerSettings } from '../config';
import { workerTransaction } from './tx';
import type { EvidenceStore } from '../evidence/types';
import { classifyArtifact } from '../sources/s3/layout';
import type { FocusSource, PeriodArtifactSet, PeriodListing, PeriodRange } from '../sources/types';
import { captureArtifact, captureManifest, type CapturedArtifact } from './capture';
import { acquireRun, finishRun, heartbeat, recordRetry, type Lease, type SourceRow } from './lease';
import { addError, loadArtifact, newLoadState } from './load';
import { PROVIDER_MISMATCH, providerPolicyFor } from '../focus/provider';
import {
  aggregateBatch,
  discardStagedBatch,
  finalizeStaged,
  numericEquals,
  publishBatch,
  quarantineBatch,
  readCheckpoint,
  refreshCheckpoint,
  recordRejectedListing,
  type RejectedListing,
  stageBatch,
  type CheckpointEntry,
} from './publish';
import { SUCCESS_OUTCOMES, SimulatedCrash, canonicalTenant, type PeriodResult, type RunResult, type WorkerHooks } from './types';
import { assertPeriodRange, periodsBetween } from './periods';

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

/** 'YYYY-MM-01' of the following month. */
function setFingerprint(shas: string[]): string {
  return crypto.createHash('sha256').update([...shas].sort().join('\n')).digest('hex');
}

const RUN_KIND = { sync: 'scheduled', backfill: 'backfill', replay_period: 'replay' } as const;

export async function runSync(opts: RunSyncOptions): Promise<RunResult> {
  const tenantId = canonicalTenant(opts.tenantId);
  if (typeof opts.sourceKey !== 'string' || !SOURCE_KEY_RE.test(opts.sourceKey)) throw new IngestError('INVALID_SOURCE_KEY', 'source key is invalid');
  if ((opts.mode === 'backfill' || opts.mode === 'replay_period') && !opts.range) throw new IngestError('INVALID_RANGE', `${opts.mode} needs a period range`);
  // Bounded (2000-01..9999-12), well-formed and not inverted (review H2, third round).
  if (opts.range) assertPeriodRange(opts.range);
  // The synthetic-provider opt-in (issue #62 D1; Copilot F3): an explicit `false` is a pure override.
  // Every other path (default or an explicit request) is decided by THIS PROCESS's validated opt-in:
  // RATIO_ALLOW_SYNTHETIC_PROVIDERS=1 with RATIO_ENV explicitly development or test. A caller cannot
  // enable synthetic providers by asking: an explicit request without the opt-in fails closed here,
  // before any I/O. (No injected env: a caller could assert any env it likes.)
  const requested = opts.settings?.allowSyntheticProviders;
  let allowSyntheticProviders = false;
  if (requested !== false) {
    allowSyntheticProviders = syntheticProvidersOptIn(process.env);
    if (requested !== undefined && !allowSyntheticProviders) {
      throw new IngestError(
        'SYNTHETIC_PROVIDERS_NOT_ALLOWED',
        'allowSyntheticProviders was requested, but this process has no RATIO_ALLOW_SYNTHETIC_PROVIDERS=1 with RATIO_ENV explicitly development or test',
      );
    }
  }
  const settings = resolveSettings({ ...opts.settings, allowSyntheticProviders });
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
  // outlive the lease — but ONLY while the run makes progress (bytes read, rows
  // inserted, steps finished) and only up to the maximum run duration. A hung
  // run therefore loses its lease and another worker can take over (its later
  // writes are fenced). The heartbeat never revives an expired lease. Stopped on
  // every exit path, including a simulated crash (a dead process is silent).
  const runStart = Date.now();
  let lastProgress = Date.now();
  const progress = () => {
    lastProgress = Date.now();
  };
  // Maximum run duration: the run aborts itself (MAX_RUN_EXCEEDED) — streams are
  // destroyed and no further period starts — instead of streaming on until its
  // next fenced write.
  const runAbort = new AbortController();
  const maxRunTimer = setTimeout(
    () => runAbort.abort(new IngestError('MAX_RUN_EXCEEDED', `run exceeded the maximum duration of ${settings.maxRunSeconds} s`)),
    settings.maxRunSeconds * 1000,
  );
  maxRunTimer.unref();
  const checkRun = () => {
    if (runAbort.signal.aborted) throw runAbort.signal.reason;
  };
  const mayRenew = () => Date.now() - lastProgress < settings.stallTimeoutSeconds * 1000 && Date.now() - runStart < settings.maxRunSeconds * 1000;
  const beat = setInterval(() => {
    if (!mayRenew()) return;
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
    checkRun();
    if (mayRenew() && Date.now() - lastBeat >= (settings.leaseTtlSeconds * 1000) / 3) {
      await heartbeat(opts.pool, lease.tenantId, lease.runId, lease.token, settings.leaseTtlSeconds);
      lastBeat = Date.now();
    }
  };

  const periods: PeriodResult[] = [];
  const manifestEvidence: string[] = [];
  /** Verifying an existing manifest object feeds progress and is under the idle watchdog. */
  const manifestWatch = { onProgress: progress, stallMs: settings.stallTimeoutSeconds * 1000 };
  let attempts = 1;
  const stats = () =>
    redactDeep({ periods, manifestEvidence, mode: opts.mode, abandonedRuns: abandoned, discardedStagedBatches: discardedBatches }, secrets) as Record<string, unknown>;

  try {
    return await runPeriods();
  } finally {
    clearInterval(beat);
    clearTimeout(maxRunTimer);
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
        // An abort (MAX_RUN_SECONDS) ends a backoff at once and is never retried.
        signal: runAbort.signal,
      };
      // One run-wide counter for every retry (listing, manifests, periods): the returned
      // attempts, each retry record and sync_runs.attempt (+1 per retry) agree (sixth review).
      const onRetry = (period: string | null) => async ({ error }: { attempt: number; error: unknown }) => {
        attempts += 1;
        const attempt = attempts;
        const code = errorCodeOf(error);
        log('run.retry', { runId: lease.runId, attempt, code, period });
        await recordRetry(opts.pool, lease, { attempt, code, period, at: new Date().toISOString() });
      };

      let listings: PeriodListing[];
      try {
        // The run's deadline bounds the listing too: the signal reaches every request (review M3).
        listings = await withRetry(() => source.listPeriods(opts.range, { signal: runAbort.signal, progress }), { ...retryOpts, onRetry: onRetry(null) });
      } catch (e) {
        if (e instanceof IngestError && e.code === 'LEASE_LOST') throw e;
        const code = e instanceof IngestError ? e.code : 'SOURCE_LIST_FAILED';
        const finished = await finishRun(opts.pool, lease, { status: 'failed', errorCode: code, errorDetail: clean(`listing the source failed: ${messageOf(e)}`), stats: stats() });
        if (!finished) throw new IngestError('LEASE_LOST', 'run lost its lease before it could finish');
        log('run.finished', { runId: lease.runId, status: 'failed', code });
        return { runId: lease.runId, status: 'failed', periods, errorCode: code, attempts, manifestEvidence };
      }

      const checkpoint = await workerTransaction(opts.pool, lease.tenantId, (c) => readCheckpoint(c, lease.sourceId));

      // replay --period names exactly one period: if the source does not list it,
      // that is a failure, never a silent "nothing to do" success.
      if (opts.mode === 'replay_period' && opts.range) {
        const listed = new Set(listings.map((l) => (l.ok ? l.set.billingPeriod : l.billingPeriod)));
        for (const p of periodsBetween(opts.range.from, opts.range.to)) {
          if (!listed.has(p)) {
            periods.push({ billingPeriod: p, outcome: 'failed', code: 'PERIOD_NOT_FOUND', message: `the source lists no period ${p}` });
            log('period.failed', { runId: lease.runId, period: p, code: 'PERIOD_NOT_FOUND' });
          }
        }
      }

      for (const listing of listings) {
        const period = listing.ok ? listing.set.billingPeriod : listing.billingPeriod;
        const manifest = listing.ok ? listing.set.manifest : listing.manifest;
        if (manifest) {
          try {
            manifestEvidence.push(await withRetry(() => captureManifest(opts.evidence, lease.tenantId, lease.sourceId, manifest.bytes, runAbort.signal, manifestWatch), { ...retryOpts, onRetry: onRetry(period) }));
          } catch (e) {
            if (e instanceof SimulatedCrash || (e instanceof IngestError && e.code === 'LEASE_LOST')) throw e;
            periods.push({ billingPeriod: period, outcome: 'failed', code: errorCodeOf(e), message: clean(messageOf(e)) });
            continue;
          }
        }
        if (runAbort.signal.aborted) {
        periods.push({ billingPeriod: period, outcome: 'failed', code: 'MAX_RUN_EXCEEDED', message: messageOf(runAbort.signal.reason) });
        continue;
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
          // An artifact replaced between listing and read (SOURCE_CHANGED, e.g. an
          // S3 If-Match 412) makes the retry RE-LIST the period, so the batch is
          // always built from one consistent listing (manifest + data versions).
          let set = listing.set;
          const result = await withRetry(
            async () => {
              try {
                return await processPeriod({ pool: opts.pool, lease, source, evidence: opts.evidence, set, settings, hooks, log, mode: opts.mode, maybeHeartbeat, progress, signal: runAbort.signal, clean, sourceRow, rejected: prev?.rejected });
              } catch (e) {
                if (e instanceof IngestError && e.code === 'SOURCE_CHANGED') {
                  const fresh = (await source.listPeriods({ from: period, to: period }, { signal: runAbort.signal, progress })).find((l) => (l.ok ? l.set.billingPeriod : l.billingPeriod) === period);
                  if (!fresh) throw new IngestError('PERIOD_NOT_FOUND', `period ${period} is no longer listed by the source`);
                  // The re-listed manifest is what the batch will be built from: evidence first (review M1).
                  const freshManifest = fresh.ok ? fresh.set.manifest : fresh.manifest;
                  if (freshManifest) manifestEvidence.push(await captureManifest(opts.evidence, lease.tenantId, lease.sourceId, freshManifest.bytes, runAbort.signal, manifestWatch));
                  if (!fresh.ok) throw new IngestError(fresh.code, clean(fresh.message));
                  set = fresh.set;
                  log('period.relisted', { runId: lease.runId, period });
                }
                throw e;
              }
            },
            { ...retryOpts, onRetry: onRetry(period) },
          );
          periods.push(result);
          progress();
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
      // A finish that matched no row (lease expired or taken over) is LEASE_LOST; a finish that could not reach the DB leaves e (review H1).
      const finished = await finishRun(opts.pool, lease, { status: 'failed', errorCode: code, errorDetail: clean(messageOf(e)), stats: stats() }).catch(() => null);
      if (finished === false) throw new IngestError('LEASE_LOST', `run lost its lease before it could record its failure (${code})`);
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
  progress: () => void;
  signal: AbortSignal;
  clean: (s: string) => string;
  sourceRow: SourceRow;
  /** The period's checkpointed capture-time rejection, if any (challenger L3). */
  rejected?: RejectedListing;
}

/** The one quarantine cause that depends on the CONTROLS rather than the data. */
const CONTROL_QUARANTINE_CODE = 'RECONCILIATION_VARIANCE';

/** Stable key of a set's effective controls ('none' without controls); 16 hex chars of sha256. */
function controlKey(control: ArtifactSetControlLike | undefined): string {
  if (!control) return 'none';
  const per = control.artifactRowCounts ? Object.keys(control.artifactRowCounts).sort().map((k) => [k, control.artifactRowCounts![k]]) : null;
  const canonical = JSON.stringify({ rowCount: control.rowCount ?? null, billedTotal: control.billedTotal ?? null, artifactRowCounts: per });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * For a control-mismatch quarantine, the control key it was judged against;
 * null for anything else — a data-defect cause, or a reason without a
 * recorded key (none can exist: every control quarantine records its key), which
 * therefore stays quarantined like any other terminal quarantine.
 */
function controlQuarantineKey(reason: string | null): string | null {
  const m = reason ? /^RECONCILIATION_VARIANCE \[controls:([0-9a-f]{16}|none)\]/.exec(reason) : null;
  return m ? m[1] : null;
}

interface ArtifactSetControlLike {
  rowCount?: number;
  billedTotal?: string;
  artifactRowCounts?: Record<string, number>;
}

function quarantineReason(code: string, detail: string, codes?: Map<string, number>): string {
  const summary = codes && codes.size ? ` (${[...codes.entries()].map(([c, n]) => `${c} x${n}`).join(', ')})` : '';
  return `${code}: ${detail}${summary}`;
}

async function processPeriod(ctx: PeriodCtx): Promise<PeriodResult> {
  const { set, lease, settings } = ctx;
  const period = set.billingPeriod;
  const control = effectiveControl(set);
  const limits = settings.limits;

  // Names are stored redacted and key the artifact rows: names that redact alike would
  // collide at staging. Refused before anything is downloaded, whatever the source.
  if (new Set(set.artifacts.map((a) => redact(a.name))).size !== set.artifacts.length) {
    return { billingPeriod: period, outcome: 'failed', code: 'MANIFEST_INVALID', message: 'two artifact names are identical once redacted (as stored)' };
  }
  // Size gate from the listing (nothing downloaded yet).
  const total = set.artifacts.reduce((a, x) => a + x.byteSize, 0);
  if (set.artifacts.length > limits.maxArtifactsPerSet || set.artifacts.some((a) => a.byteSize > limits.maxArtifactBytes) || total > limits.maxBatchBytes) {
    return { billingPeriod: period, outcome: 'failed', code: 'ARTIFACT_SET_TOO_LARGE', message: 'artifact set exceeds the configured size limits' };
  }
  // This exact listing already overran the limits at capture (its sizes were
  // under-reported) and the limits are no higher: fail fast, download nothing
  // (challenger L3). Raised limits or a changed listing are tried again.
  // replay --period is the operator's explicit re-ingest: it always downloads again (round-2 L1).
  const rejected = ctx.mode === 'replay_period' ? undefined : ctx.rejected;
  if (rejected && rejected.listing === set.listingFingerprint && limits.maxArtifactBytes <= rejected.maxArtifactBytes && limits.maxBatchBytes <= rejected.maxBatchBytes) {
    return { billingPeriod: period, outcome: 'failed', code: rejected.code, message: 'this unchanged listing already exceeded the configured size limits when captured; not downloaded again' };
  }

  // Raw evidence first.
  // The listed sizes are only the source's claim: the batch cap is enforced on
  // the bytes actually captured — each capture may use at most what is left of
  // maxBatchBytes (review M4).
  const captured: CapturedArtifact[] = [];
  let capturedBytes = 0;
  for (const ref of [...set.artifacts].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const remaining = limits.maxBatchBytes - capturedBytes;
    const cap = Math.min(limits.maxArtifactBytes, remaining);
    let c: CapturedArtifact;
    try {
      c = await captureArtifact({
        source: ctx.source,
        evidence: ctx.evidence,
        ref,
        tenantId: lease.tenantId,
        sourceId: lease.sourceId,
        tmpDir: settings.tmpDir,
        maxBytes: cap,
        stallMs: settings.stallTimeoutSeconds * 1000,
        progress: ctx.progress,
        signal: ctx.signal,
      });
    } catch (e) {
      if (!(e instanceof IngestError && e.code === 'ARTIFACT_TOO_LARGE')) throw e;
      const err = cap < limits.maxArtifactBytes ? new IngestError('ARTIFACT_SET_TOO_LARGE', 'the captured artifact set exceeds the configured batch byte limit (listed sizes were lower)') : e;
      // Checkpointed by listing fingerprint and limits, so an unchanged listing is not downloaded again (challenger L3).
      await recordRejectedListing(ctx.pool, lease, period, {
        listing: set.listingFingerprint,
        code: err.code as RejectedListing['code'],
        maxArtifactBytes: limits.maxArtifactBytes,
        maxBatchBytes: limits.maxBatchBytes,
      });
      throw err;
    }
    capturedBytes += c.byteSize;
    captured.push(c);
    ctx.progress();
    await ctx.maybeHeartbeat();
  }
  const dataFingerprint = setFingerprint(captured.map((c) => c.sha256));
  const findBatch = (fp: string) =>
    workerTransaction(ctx.pool, lease.tenantId, async (c) => {
      const r = await c.query(
        `SELECT id::text, status, row_count::text AS row_count, loaded_billed_total::text AS total, reconciliation, quarantine_reason
         FROM ratio.ingest_batches WHERE source_id = $1 AND billing_period = $2 AND artifact_set_fingerprint = $3`,
        [lease.sourceId, period, fp],
      );
      return r.rows[0] as { id: string; status: string; row_count: string; total: string; reconciliation: string; quarantine_reason: string | null } | undefined;
    });

  // Existing batch for exactly this artifact set? A batch is keyed on its DATA
  // (the artifact hashes). Exception (review M2): when this data was
  // quarantined only because its CONTROLS did not match, and the listing now
  // carries different controls, the same data is re-reconciled in a new batch
  // keyed on (data, controls) — quarantined batches are terminal and immutable,
  // so this is the only way back without a schema change. A data-defect
  // quarantine stays: other controls cannot fix bad data.
  const currentControls = controlKey(control);
  let fingerprint = dataFingerprint;
  let existing = await findBatch(dataFingerprint);
  if (existing?.status === 'quarantined') {
    const quarantinedControls = controlQuarantineKey(existing.quarantine_reason);
    if (quarantinedControls !== null && quarantinedControls !== currentControls) {
      const quarantinedBatchId = existing.id;
      fingerprint = crypto.createHash('sha256').update(`${dataFingerprint}\ncontrols:${currentControls}`).digest('hex');
      existing = await findBatch(fingerprint);
      ctx.log('period.rereconcile', { runId: lease.runId, period, quarantinedBatchId });
    }
  }
  const entry = (batchId: string) => (): CheckpointEntry => ({ fingerprint, listing: set.listingFingerprint, batchId, pinned: false });

  if (existing?.status === 'published') {
    if (control && (await controlDisagrees(ctx.pool, lease.tenantId, control, existing))) {
      return { billingPeriod: period, outcome: 'failed', code: 'CONTROL_VARIANCE_ON_UNCHANGED', batchId: existing.id, message: 'artifacts are unchanged but the control totals no longer match the published batch' };
    }
    await refreshCheckpoint(ctx.pool, lease, period, entry(existing.id));
    return { billingPeriod: period, outcome: 'unchanged', batchId: existing.id, artifactSetFingerprint: fingerprint, rowCount: existing.row_count, billedTotal: existing.total };
  }
  if (existing?.status === 'superseded') {
    if (control && (await controlDisagrees(ctx.pool, lease.tenantId, control, existing))) {
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
    control,
    artifacts: [...unique.values()].map((c) => ({ name: c.ref.name, sha256: c.sha256, byteSize: c.byteSize, evidenceKey: c.evidenceKey })),
  });
  ctx.log('batch.staged', { runId: lease.runId, period, batchId, artifacts: unique.size });

  const state = newLoadState();
  const quarantine = async (code: string, detail: string, extra: { reconciliation?: 'variance'; rowCount?: string; billedTotal?: string } = {}): Promise<PeriodResult> => {
    // A control-mismatch quarantine records WHICH controls it was judged against
    // (first in the reason, so no truncation can drop it): see the M2 lookup above.
    const label = code === CONTROL_QUARANTINE_CODE ? `${code} [controls:${currentControls}]` : code;
    // validation_error_count covers every stored error, provider exclusions included (issue #62).
    const errorCount = state.errorCount + state.excludedCount;
    await quarantineBatch(
      ctx.pool,
      lease,
      { batchId, billingPeriod: period, reason: ctx.clean(quarantineReason(label, detail, state.errorCodes)), errors: state.errors, errorCount, perArtifactRows: state.perArtifactRows, ...extra },
      ctx.hooks,
    );
    ctx.log('batch.quarantined', { runId: lease.runId, period, batchId, code, errors: errorCount });
    return { billingPeriod: period, outcome: 'quarantined', code, batchId, artifactSetFingerprint: fingerprint, ...(extra.reconciliation ? { reconciliation: extra.reconciliation } : {}) };
  };

  if (captured.length === 0) return quarantine('EMPTY_ARTIFACT_SET', 'the manifest lists no data files');
  if (unique.size !== captured.length) return quarantine('DUPLICATE_ARTIFACT', 'two artifacts in the set have identical bytes');

  const focusVersion = ctx.sourceRow.declaredFocusVersion ?? '1.0';
  const providerPolicy = providerPolicyFor(ctx.sourceRow, { allowSyntheticProviders: settings.allowSyntheticProviders });
  for (const c of [...unique.values()]) {
    await loadArtifact(
      {
        pool: ctx.pool,
        evidence: ctx.evidence,
        lease,
        batchId,
        billingPeriod: period,
        focusVersion,
        limits,
        hooks: ctx.hooks,
        maybeHeartbeat: ctx.maybeHeartbeat,
        stallMs: settings.stallTimeoutSeconds * 1000,
        progress: ctx.progress,
        signal: ctx.signal,
        providerPolicy,
      },
      { name: c.ref.name, sha256: c.sha256, byteSize: c.byteSize, evidenceKey: c.evidenceKey, format: classifyArtifact(c.ref.name) },
      state,
    );
    if (state.halted) break;
  }
  if (state.errorCount > 0) {
    // The batch code comes from the hard errors; provider exclusions are listed in the summary only.
    const first = [...state.errorCodes.keys()].find((c) => c !== PROVIDER_MISMATCH);
    const code = state.errorCodes.has('ROW_LIMIT_EXCEEDED') ? 'ROW_LIMIT_EXCEEDED' : first === 'UNSUPPORTED_FORMAT' ? 'UNSUPPORTED_FORMAT' : 'VALIDATION_FAILED';
    return quarantine(code, `${state.errorCount + state.excludedCount} validation error(s)`);
  }

  // Reconcile in Postgres.
  const agg = await aggregateBatch(ctx.pool, lease, batchId);
  if (agg.rowCount !== String(state.rowsInserted)) {
    throw new IngestError('INTERNAL_COUNT_MISMATCH', `loaded ${agg.rowCount} rows but parsed ${state.rowsInserted}`);
  }
  if (agg.rowCount === '0' && state.excludedCount > 0) {
    // Every row was excluded by the provider check: never published (issue #62).
    return quarantine(PROVIDER_MISMATCH, `every data row (${state.excludedCount}) has a ProviderName not allowed for source type ${providerPolicy?.sourceType}`, { rowCount: '0', billedTotal: '0' });
  }
  if (agg.rowCount === '0') return quarantine('EMPTY_BATCH', 'the artifact set contains no data rows', { rowCount: '0', billedTotal: '0' });
  if (agg.currencies > 1) {
    addError(state, { artifactSha256: [...unique.keys()][0], rowOrdinal: null, column: 'BillingCurrency', code: 'MIXED_BILLING_CURRENCY', message: `${agg.currencies} billing currencies in one batch` });
    return quarantine('MIXED_BILLING_CURRENCY', 'a batch must have a single billing currency', { rowCount: agg.rowCount, billedTotal: agg.billedTotal });
  }
  const verdict = await reconcile(ctx.pool, control, agg, state.perArtifactRows);
  if (verdict.variance) {
    // A stored `variance` needs a set-level control (schema); partial per-artifact controls quarantine without one.
    return quarantine('RECONCILIATION_VARIANCE', verdict.detail, {
      ...(hasSetControl(control) ? { reconciliation: 'variance' as const } : {}),
      rowCount: agg.rowCount,
      billedTotal: agg.billedTotal,
    });
  }
  await finalizeStaged(ctx.pool, lease, {
    batchId,
    rowCount: agg.rowCount,
    billedTotal: agg.billedTotal,
    reconciliation: verdict.reconciliation,
    perArtifactRows: state.perArtifactRows,
    errors: state.errors,
    errorCount: state.excludedCount,
  });
  const excluded = state.excludedCount > 0 ? { excludedRows: String(state.excludedCount) } : {};

  if (ctx.hooks.beforePublish) await ctx.hooks.beforePublish({ runId: lease.runId, batchId, billingPeriod: period });
  await publishBatch(ctx.pool, lease, { batchId, billingPeriod: period, checkpoint: entry(batchId) }, ctx.hooks);
  ctx.log('batch.published', { runId: lease.runId, period, batchId, rows: agg.rowCount, reconciliation: verdict.reconciliation, ...excluded });
  return { billingPeriod: period, outcome: 'published', batchId, artifactSetFingerprint: fingerprint, rowCount: agg.rowCount, billedTotal: agg.billedTotal, reconciliation: verdict.reconciliation, ...excluded };
}

/**
 * Control as stored on the batch: per-artifact counts that cover EVERY artifact
 * of the set also define the set-level control row count (their sum).
 */
function effectiveControl(set: PeriodArtifactSet): PeriodArtifactSet['control'] {
  const c = set.control;
  if (!c) return undefined;
  const out = { ...c };
  const per = c.artifactRowCounts;
  if (out.rowCount === undefined && per && set.artifacts.length > 0 && set.artifacts.every((a) => Object.prototype.hasOwnProperty.call(per, a.name))) {
    out.rowCount = set.artifacts.reduce((sum, a) => sum + per[a.name], 0);
  }
  return out;
}

const hasSetControl = (c: PeriodArtifactSet['control']) => !!c && (c.rowCount !== undefined || c.billedTotal !== undefined);

/**
 * Whether the listing's controls disagree with an existing batch of the same
 * data: set-level row count and billed total, AND every per-artifact row count
 * against the stored ingest_artifacts.row_count — exactly what reconcile()
 * checks for a new batch (review M5).
 */
async function controlDisagrees(
  pool: Pool,
  tenantId: string,
  control: NonNullable<PeriodArtifactSet['control']>,
  batch: { id: string; row_count: string; total: string },
): Promise<boolean> {
  if (control.rowCount !== undefined && String(control.rowCount) !== batch.row_count) return true;
  if (control.billedTotal !== undefined && !(await numericEquals(pool, control.billedTotal, batch.total))) return true;
  const per = Object.entries(control.artifactRowCounts ?? {});
  if (per.length) {
    const stored = await workerTransaction(pool, tenantId, async (c) => {
      const r = await c.query(`SELECT artifact_name, row_count::text AS row_count FROM ratio.ingest_artifacts WHERE batch_id = $1`, [batch.id]);
      return new Map(r.rows.map((x: { artifact_name: string; row_count: string | null }) => [x.artifact_name, x.row_count]));
    });
    // Stored names are redacted (setArtifactRowCounts writes redact(name)): look them up the same way (challenger L2).
    for (const [name, expected] of per) if (stored.get(redact(name)) !== String(expected)) return true;
  }
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
  // reconciled ⇔ at least one set-level control and every present control matches (amended 0001 CHECK).
  const any = control.rowCount !== undefined || control.billedTotal !== undefined;
  return { variance: false, reconciliation: any ? 'reconciled' : 'unverified', detail: any ? 'control totals match' : 'no set-level control' };
}
