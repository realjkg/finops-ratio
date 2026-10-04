// Parse ONLY the evidence copy (D6): re-hash while reading, gunzip, csv-parse,
// validate every row, insert valid rows into the staged batch in bounded
// chunks (each its own lease-fenced transaction). After the first validation
// error no further facts are inserted, but validation continues so the batch's
// error count is complete. A parse failure first drains the evidence stream so
// tampering is reported as EVIDENCE_INTEGRITY, never as a data problem.
import crypto from 'crypto';
import zlib from 'zlib';
import { Transform, Writable, type Readable } from 'stream';
import { pipeline as streamPipeline } from 'stream/promises';
import { parse, type Parser } from 'csv-parse';
import type { Pool } from 'pg';
import { IngestError } from '../errors';
import { isTransientError } from '../retry';
import { workerTransaction } from './tx';
import type { EvidenceStore } from '../evidence/types';
import { indexHeader, validateRow, type FactRow, type HeaderIndex } from '../focus/validate';
import { assertLease, type Lease } from './lease';
import type { WorkerHooks } from './types';
import type { WorkerLimits } from '../config';
import { idleWatchdog, withDeadline } from '../stall';

export const MAX_STORED_ERRORS = 1000;
const MAX_RECORD_BYTES = 1024 * 1024;

export interface ValidationErrorRow {
  artifactSha256: string;
  rowOrdinal: number | null;
  column: string | null;
  code: string;
  message: string;
}

export interface LoadState {
  rowsSeen: number;
  rowsInserted: number;
  errors: ValidationErrorRow[];
  errorCount: number;
  errorCodes: Map<string, number>;
  perArtifactRows: Map<string, number>;
  halted: boolean;
}

export function newLoadState(): LoadState {
  return { rowsSeen: 0, rowsInserted: 0, errors: [], errorCount: 0, errorCodes: new Map(), perArtifactRows: new Map(), halted: false };
}

export function addError(state: LoadState, e: ValidationErrorRow): void {
  state.errorCount++;
  state.errorCodes.set(e.code, (state.errorCodes.get(e.code) ?? 0) + 1);
  if (state.errors.length < MAX_STORED_ERRORS) state.errors.push({ ...e, message: e.message.slice(0, 1000) });
}

export interface LoadContext {
  pool: Pool;
  evidence: EvidenceStore;
  lease: Lease;
  batchId: string;
  billingPeriod: string;
  focusVersion: string | null;
  limits: WorkerLimits;
  hooks: WorkerHooks;
  maybeHeartbeat: () => Promise<void>;
  /** Idle limit for opening/reading the evidence copy (EVIDENCE_STALLED). */
  stallMs: number;
  /** Called whenever bytes or rows advance (keeps the lease renewing). */
  progress: () => void;
  /** Aborts the parse (e.g. maximum run duration exceeded). */
  signal?: AbortSignal;
}

export interface LoadArtifact {
  name: string;
  sha256: string;
  byteSize: number;
  evidenceKey: string;
  format: 'csv.gz' | 'csv' | 'unsupported';
}

const INSERT_SQL = `
INSERT INTO ratio.cost_facts (tenant_id, batch_id, source_id, artifact_sha256, row_ordinal, billing_period,
  charge_period_start, charge_period_end, billed_cost, effective_cost, list_cost, contracted_cost, billing_currency,
  provider_name, service_name, service_category, charge_category, resource_id, sub_account_id, billing_account_id,
  usage_quantity, usage_unit, pricing_quantity, pricing_unit, focus_version, extra_columns)
SELECT $1, $2, $3, $4, u.ord, $5, u.cps, u.cpe, u.bc, u.ec, u.lc, u.cc, u.cur, u.pn, u.sn, u.sc, u.chc, u.rid, u.sub, u.ba,
       u.uq, u.uu, u.pq, u.pu, $6, u.extra
FROM unnest($7::bigint[], $8::timestamptz[], $9::timestamptz[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[],
            $14::text[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[], $20::text[], $21::text[],
            $22::numeric[], $23::text[], $24::numeric[], $25::text[], $26::jsonb[])
  AS u(ord, cps, cpe, bc, ec, lc, cc, cur, pn, sn, sc, chc, rid, sub, ba, uq, uu, pq, pu, extra)`;

async function insertChunk(ctx: LoadContext, artifactSha256: string, rows: Array<{ ordinal: number; fact: FactRow }>): Promise<void> {
  const col = <K extends keyof FactRow>(k: K) => rows.map((r) => r.fact[k]);
  await workerTransaction(ctx.pool, ctx.lease.tenantId, async (c) => {
    await assertLease(c, ctx.lease, 'SHARE');
    await c.query(INSERT_SQL, [
      ctx.lease.tenantId,
      ctx.batchId,
      ctx.lease.sourceId,
      artifactSha256,
      ctx.billingPeriod,
      ctx.focusVersion,
      rows.map((r) => r.ordinal),
      col('chargePeriodStart'),
      col('chargePeriodEnd'),
      col('billedCost'),
      col('effectiveCost'),
      col('listCost'),
      col('contractedCost'),
      col('billingCurrency'),
      col('providerName'),
      col('serviceName'),
      col('serviceCategory'),
      col('chargeCategory'),
      col('resourceId'),
      col('subAccountId'),
      col('billingAccountId'),
      col('usageQuantity'),
      col('usageUnit'),
      col('pricingQuantity'),
      col('pricingUnit'),
      rows.map((r) => JSON.stringify(r.fact.extraColumns)),
    ]);
  });
}

function csvErrorRow(e: unknown, sha: string, recordsSoFar: number): ValidationErrorRow {
  const code = (e as { code?: unknown })?.code;
  const kind = typeof code === 'string' && /^[A-Z_]{3,64}$/.test(code) ? code : 'CSV_ERROR';
  return {
    artifactSha256: sha,
    rowOrdinal: recordsSoFar > 0 ? recordsSoFar : null,
    column: null,
    code: 'CSV_PARSE_ERROR',
    // csv-parse messages can quote cell content; only its code and our position are kept.
    message: `CSV syntax error (${kind}) after data record ${recordsSoFar}`,
  };
}

/** Streams and re-hashes an evidence object without parsing it (EVIDENCE_INTEGRITY on mismatch). */
async function verifyEvidenceOnly(ctx: LoadContext, art: LoadArtifact): Promise<void> {
  let raw: Readable;
  try {
    raw = await withDeadline(ctx.evidence.open(art.evidenceKey, { signal: ctx.signal }), ctx.stallMs, 'EVIDENCE_STALLED', 'opening the evidence copy', ctx.signal);
  } catch (e) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    if (e instanceof IngestError) throw e;
    throw new IngestError('EVIDENCE_STORE_FAILED', 'reading the evidence copy failed', { retryable: isTransientError(e), cause: e });
  }
  const hasher = crypto.createHash('sha256');
  let bytes = 0;
  const watchdog = idleWatchdog(ctx.stallMs, 'EVIDENCE_STALLED', 'the evidence copy', () => ctx.progress(), ctx.signal);
  try {
    await streamPipeline(
      raw,
      watchdog.stream,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          hasher.update(chunk);
          bytes += chunk.length;
          cb();
        },
      }),
    );
  } catch (e) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    if (e instanceof IngestError) throw e;
    throw new IngestError('EVIDENCE_STORE_FAILED', 'reading the evidence copy failed', { retryable: isTransientError(e), cause: e });
  }
  if (bytes !== art.byteSize || hasher.digest('hex') !== art.sha256) {
    throw new IngestError('EVIDENCE_INTEGRITY', `evidence object for ${art.name} does not match its recorded sha256/size`);
  }
}

/** Loads one artifact from evidence into the staged batch, recording validation errors in `state`. */
export async function loadArtifact(ctx: LoadContext, art: LoadArtifact, state: LoadState): Promise<void> {
  if (art.format === 'unsupported') {
    // Never parsed, but still re-hashed: the load is the authority on every artifact a
    // new batch references (the capture's HEAD-metadata fast path relies on it).
    await verifyEvidenceOnly(ctx, art);
    addError(state, {
      artifactSha256: art.sha256,
      rowOrdinal: null,
      column: null,
      code: 'UNSUPPORTED_FORMAT',
      message: 'only CSV (.csv) and gzip CSV (.csv.gz) FOCUS artifacts are supported; Parquet and other formats are refused',
    });
    state.perArtifactRows.set(art.name, 0);
    return;
  }

  let raw: Readable;
  try {
    // The run's abort signal reaches the evidence request (review M5, third round).
    raw = await withDeadline(ctx.evidence.open(art.evidenceKey, { signal: ctx.signal }), ctx.stallMs, 'EVIDENCE_STALLED', 'opening the evidence copy', ctx.signal);
  } catch (e) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    if (e instanceof IngestError) throw e;
    throw new IngestError('EVIDENCE_STORE_FAILED', 'reading the evidence copy failed', { retryable: isTransientError(e), cause: e });
  }
  const hasher = crypto.createHash('sha256');
  let bytes = 0;
  const hashT = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hasher.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  let rawError: unknown = null;
  const hashDone = new Promise<void>((resolve, reject) => {
    hashT.on('end', resolve);
    hashT.on('error', reject);
  });
  hashDone.catch(() => undefined);
  raw.on('error', (e) => {
    rawError = e;
    hashT.destroy(e);
  });
  // Idle watchdog between the evidence stream and the parser. Slow downstream
  // inserts touch() it, so only a source of bytes that goes silent trips it.
  const watchdog = idleWatchdog(ctx.stallMs, 'EVIDENCE_STALLED', 'the evidence copy', () => ctx.progress(), ctx.signal);
  watchdog.stream.on('error', (e) => {
    raw.destroy();
    hashT.destroy(e);
  });
  raw.pipe(watchdog.stream).pipe(hashT);

  const parser: Parser = parse({ bom: true, relax_column_count: false, skip_empty_lines: true, max_record_size: MAX_RECORD_BYTES });
  let gunzip: zlib.Gunzip | null = null;
  if (art.format === 'csv.gz') {
    gunzip = zlib.createGunzip();
    gunzip.on('error', (e) => parser.destroy(Object.assign(new IngestError('INVALID_GZIP', 'artifact is not valid gzip data'), { cause: e })));
    hashT.pipe(gunzip).pipe(parser);
  } else {
    hashT.pipe(parser);
  }
  hashT.on('error', (e) => parser.destroy(e));

  const drain = async () => {
    if (gunzip) {
      hashT.unpipe(gunzip);
      gunzip.destroy();
    } else hashT.unpipe(parser);
    parser.destroy();
    hashT.resume();
    await hashDone;
  };

  let header: HeaderIndex | null = null;
  let ordinal = 0;
  let pending: Array<{ ordinal: number; fact: FactRow }> = [];
  let pendingBytes = 0;
  const chunkRows = ctx.limits.insertChunkRows;
  const flush = async () => {
    if (!pending.length) return;
    const rows = pending;
    pending = [];
    pendingBytes = 0;
    try {
      await insertChunk(ctx, art.sha256, rows);
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (!(e instanceof IngestError) && typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code)) {
        // Backstop: Postgres rejected a value the validator accepted (data exception,
        // class 22). Quarantine with a code-only message — pg's text may quote the value.
        const first = rows[0].ordinal;
        const last = rows[rows.length - 1].ordinal;
        addError(state, {
          artifactSha256: art.sha256,
          rowOrdinal: first,
          column: null,
          code: 'DB_REJECTED_VALUE',
          message: `the database rejected a value in data records ${first}-${last} (SQLSTATE ${code})`,
        });
        return;
      }
      throw e;
    }
    state.rowsInserted += rows.length;
    watchdog.touch();
    ctx.progress();
    await ctx.maybeHeartbeat();
    if (ctx.hooks.afterChunk) {
      await ctx.hooks.afterChunk({ runId: ctx.lease.runId, batchId: ctx.batchId, artifactSha256: art.sha256, chunkRows: rows.length, rowsInserted: state.rowsInserted });
    }
  };

  let parseError: unknown = null;
  let stoppedEarly = false;
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (!header) {
        const h = indexHeader(record);
        if (!h.ok) {
          for (const e of h.errors) addError(state, { artifactSha256: art.sha256, rowOrdinal: null, column: e.column, code: e.code, message: e.message });
          stoppedEarly = true;
          break;
        }
        header = h.index;
        continue;
      }
      ordinal++;
      state.rowsSeen++;
      if (state.rowsSeen > ctx.limits.maxRowsPerBatch) {
        addError(state, { artifactSha256: art.sha256, rowOrdinal: ordinal, column: null, code: 'ROW_LIMIT_EXCEEDED', message: `batch exceeds the configured limit of ${ctx.limits.maxRowsPerBatch} rows` });
        state.halted = true;
        stoppedEarly = true;
        break;
      }
      const v = validateRow(record, header, ctx.billingPeriod);
      if (!v.ok) {
        for (const e of v.errors) addError(state, { artifactSha256: art.sha256, rowOrdinal: ordinal, column: e.column, code: e.code, message: e.message });
        pending = [];
        pendingBytes = 0;
        continue;
      }
      if (state.errorCount > 0) continue;
      pending.push({ ordinal, fact: v.fact });
      for (const field of record) pendingBytes += field.length;
      // Bounded by rows AND bytes: 1000 records of ~1 MiB would otherwise be held at once (sixth review).
      if (pending.length >= chunkRows || pendingBytes >= ctx.limits.maxChunkBytes) await flush();
    }
  } catch (e) {
    const isParseProblem = (e instanceof IngestError && e.code === 'INVALID_GZIP') || isCsvError(e);
    if (rawError || !isParseProblem) {
      // Infrastructure failure, stall, lease loss, DB error in a chunk, or a hook: stop reading and propagate.
      watchdog.stop();
      raw.destroy();
      hashT.destroy();
      if (rawError && !(e instanceof IngestError && e.code === 'LEASE_LOST')) {
        throw new IngestError('EVIDENCE_STORE_FAILED', 'reading the evidence copy failed', { retryable: isTransientError(rawError), cause: rawError });
      }
      throw e;
    }
    parseError = e;
    stoppedEarly = true;
  }

  if (stoppedEarly) {
    try {
      await drain();
    } catch (e) {
      throw new IngestError('EVIDENCE_STORE_FAILED', 'reading the evidence copy failed', { retryable: isTransientError(rawError ?? e), cause: e });
    }
  } else {
    try {
      await hashDone;
    } catch (e) {
      throw new IngestError('EVIDENCE_STORE_FAILED', 'reading the evidence copy failed', { retryable: isTransientError(rawError ?? e), cause: e });
    }
  }
  if (bytes !== art.byteSize || hasher.digest('hex') !== art.sha256) {
    throw new IngestError('EVIDENCE_INTEGRITY', `evidence object for ${art.name} does not match its recorded sha256/size`);
  }

  if (parseError) {
    if (parseError instanceof IngestError && parseError.code === 'INVALID_GZIP') {
      addError(state, { artifactSha256: art.sha256, rowOrdinal: null, column: null, code: 'INVALID_GZIP', message: 'artifact is not valid gzip data' });
    } else {
      addError(state, csvErrorRow(parseError, art.sha256, ordinal));
    }
  } else if (!header && !state.halted) {
    addError(state, { artifactSha256: art.sha256, rowOrdinal: null, column: null, code: 'MISSING_HEADER', message: 'artifact has no header row' });
  }
  if (state.errorCount === 0) await flush();
  state.perArtifactRows.set(art.name, ordinal);
}

function isCsvError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('CSV_');
}
