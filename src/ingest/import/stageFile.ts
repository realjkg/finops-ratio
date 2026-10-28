// R3: stages an operator's FOCUS CSV / CSV.gz file into the existing export
// layout (sources/s3/layout.ts) so the existing worker (runSync: validator,
// quarantine, reconciliation, publish) ingests it. Pure: no I/O.
// Ported from the acceptance run's planStaging (scripts/local/acceptance.mjs):
// split by BillingPeriodStart month, map the unquoted literal NULL token to an
// empty field, keep every other field's raw bytes, gzip each period's file.
// This is NOT a FOCUS parser: it only splits records; validation stays in the worker.
//
// Memory (review B2): the input is tokenized as BYTES in one pass; records are
// never copied into strings. Each (file, period) output is written through a
// small scratch buffer into gzip members of at most `gzipMemberBytes` bytes
// (RFC 1952 allows a series of members; the worker's zlib.createGunzip reads
// them as one stream). Peak memory is the input plus the compressed output.
//
// Controls: the operator's controls go into the manifest's `x-ratio-control`
// for exactly one period. Per-file row counts are deliberately NOT written: the
// worker would derive a set-level control from them (pipeline.ts
// effectiveControl), i.e. reconcile the file against itself. Without operator
// controls a period therefore lands `unverified`, never `reconciled`.
//
// Errors name the file number, record number and column, never a cell value.
import { isUtf8 } from 'buffer';
import crypto from 'crypto';
import zlib from 'zlib';
import { IngestError } from '../errors';
import { isDecimalString } from '../focus/decimal';
import { dataPrefix, periodMetadataPrefix, type ExportLocation } from '../sources/s3/layout';

const MiB = 1024 * 1024;
/**
 * Largest delivery (decompressed CSV bytes, all files together) one import accepts. Derived from the
 * measured peak RSS of the whole `import-file` path at this size (docs/evidence/R3/green.txt), which
 * must stay within IMPORT_RSS_BUDGET_BYTES: three quarters of the worker container's mem_limit (512m,
 * infrastructure/engagement/compose.yaml). Larger deliveries are refused (IMPORT_TOO_LARGE, CLI exit 5)
 * before they are read. Pinned by stageFile.test.ts and importFile.db.test.ts.
 */
export const MAX_IMPORT_BYTES = 128 * MiB;
/** Peak RSS the import path must stay within at MAX_IMPORT_BYTES. */
export const IMPORT_RSS_BUDGET_BYTES = 384 * MiB;
const GZIP_MEMBER_BYTES = 1 * MiB;
const GZIP_LEVEL = 6;
const PERIOD_RE = /^([0-9]{4})-(0[1-9]|1[0-2])-01(?:[ T]00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const QUOTE = 0x22;
const COMMA = 0x2c;
const LF = 0x0a;
const CR = 0x0d;
const NEWLINE = Buffer.from('\n');

export interface StageControl {
  rowCount?: number;
  /** Exact decimal string; needs `currency`. */
  billedTotal?: string;
  currency?: string;
}

export interface StageOptions {
  location: ExportLocation;
  /** 'YYYY-MM-01': stage only this period. */
  period?: string;
  /** Controls for the declared providers' rows of the ONE staged period. */
  control?: StageControl;
  /** The source's declared providers (control currency check and the preview). */
  providers?: readonly string[];
  /** Largest uncompressed size of one gzip member (default 1 MiB; tests use small values). */
  gzipMemberBytes?: number;
}

export interface StagedObject {
  kind: 'data' | 'manifest';
  key: string;
  body: Buffer;
  sha256: string;
  /** 'YYYY-MM-01' */
  billingPeriod: string;
}

/** The text-level plan; the same shape as the acceptance run's planStaging (its lossless check reads it). */
export interface StagePlan {
  header: string;
  columns: string[];
  periods: Array<{ ym: string; files: Array<{ records: string[]; level: number }> }>;
  nullTokens: Record<string, number>;
  nullToEmpty: true;
  splitByPeriod: true;
}

/** Declared providers' rows of one staged period, before validation (the restatement report). */
export interface PeriodPreview {
  billingPeriod: string;
  rows: number;
  /** Exact BilledCost sum per BillingCurrency; null when a value is not a plain decimal (NULL, empty). */
  billed: Record<string, string | null>;
}

export interface StagedFile {
  /** Per input: name, sha256 of its CSV bytes (after decompression), data rows, CSV bytes. */
  files: Array<{ name: string; sha256: string; dataRows: number; bytes: number }>;
  /** Rebuilt on access from the staged data objects (tests and the lossless check only). */
  readonly plan: StagePlan;
  objects: StagedObject[];
  periods: Array<{ billingPeriod: string; records: number }>;
  /** Only when `providers` is given. */
  preview: PeriodPreview[];
  nullTokensReplaced: Record<string, number>;
}

const invalid = (m: string): never => {
  throw new IngestError('IMPORT_FILE_INVALID', m);
};
/** IMPORT_TOO_LARGE (CLI exit 5): refused before more than `max` bytes are held. */
export const tooLarge = (max: number): never => {
  throw new IngestError('IMPORT_TOO_LARGE', `the delivery is larger than the import cap of ${max} bytes (decompressed CSV, all files together); split it into smaller files by billing period`);
};

/** The CSV bytes of an import file: `.csv` as is, `.csv.gz` decompressed, both bounded by `max`. */
export function decodeImportFile(bytes: Buffer, fileName: string, max: number = MAX_IMPORT_BYTES): Buffer {
  const n = fileName.toLowerCase();
  if (n.endsWith('.csv.gz')) {
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) invalid('the file is named .csv.gz but is not gzip data');
    try {
      return zlib.gunzipSync(bytes, { maxOutputLength: Math.max(1, max) });
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') return tooLarge(max);
      return invalid('the file could not be decompressed (corrupt gzip)');
    }
  }
  if (!n.endsWith('.csv')) invalid('the file must be a FOCUS .csv or .csv.gz file');
  if (bytes.length > max) tooLarge(max);
  return bytes;
}

/** One record as byte offsets into the input (reused between records). */
interface Rec {
  starts: number[];
  ends: number[];
  quoted: boolean[];
  count: number;
  start: number;
  end: number;
  n: number;
}

/**
 * RFC 4180 records over bytes (the acceptance tokenizer; CRLF accepted as a record end). Empty
 * lines are skipped, as the worker's parser does (skip_empty_lines). UTF-8 needs no decoding to
 * split: its multi-byte sequences never contain the ASCII delimiters.
 */
function scan(b: Buffer, from: number, where: string, onRecord: (r: Rec) => void): void {
  const r: Rec = { starts: [], ends: [], quoted: [], count: 0, start: from, end: from, n: 1 };
  let fieldStart = from;
  let quoted = false;
  let inQuotes = false;
  let afterQuote = false;
  const endField = (at: number) => {
    r.starts[r.count] = fieldStart;
    r.ends[r.count] = at;
    r.quoted[r.count] = quoted;
    r.count++;
    quoted = false;
    afterQuote = false;
  };
  for (let i = from; i < b.length; i++) {
    const c = b[i];
    if (inQuotes) {
      if (c === QUOTE) {
        if (b[i + 1] === QUOTE) i++;
        else {
          inQuotes = false;
          afterQuote = true;
        }
      }
      continue;
    }
    if (c === COMMA) {
      endField(i);
      fieldStart = i + 1;
    } else if (c === LF || (c === CR && b[i + 1] === LF)) {
      const blank = r.count === 0 && i === fieldStart;
      endField(i);
      r.end = i;
      if (!blank) onRecord(r);
      r.count = 0;
      r.n++;
      if (c === CR) i++;
      fieldStart = i + 1;
      r.start = fieldStart;
    } else if (c === CR) invalid(`${where}, record ${r.n}: a carriage return outside a line ending`);
    else if (afterQuote) invalid(`${where}, record ${r.n}: characters after a closing quote`);
    else if (c === QUOTE) {
      if (i !== fieldStart) invalid(`${where}, record ${r.n}: a stray quote inside an unquoted field`);
      inQuotes = true;
      quoted = true;
    }
  }
  if (inQuotes) invalid(`${where}, record ${r.n}: unterminated quoted field at the end of the file`);
  if (fieldStart < b.length || r.count) {
    endField(b.length);
    r.end = b.length;
    onRecord(r);
  }
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const valueOf = (b: Buffer, r: Rec, k: number) => (r.quoted[k] ? b.toString('utf8', r.starts[k] + 1, r.ends[k] - 1).replaceAll('""', '"') : b.toString('utf8', r.starts[k], r.ends[k]));
/** The unquoted literal NULL token (a quoted "NULL" is data). */
const isNullToken = (b: Buffer, r: Rec, k: number) =>
  !r.quoted[k] && r.ends[k] - r.starts[k] === 4 && b[r.starts[k]] === 0x4e && b[r.starts[k] + 1] === 0x55 && b[r.starts[k] + 2] === 0x4c && b[r.starts[k] + 3] === 0x4c;

const ZERO = BigInt(0);
const TEN = BigInt(10);

/** Exact decimal (FOCUS form, exponent allowed) as a scaled integer. */
function scaled(s: string): { v: bigint; scale: number } {
  const m = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(s)!;
  const frac = m[3] ?? '';
  const exp = Number(m[4] ?? 0);
  let v = BigInt(`${m[2]}${frac}` || '0');
  let scale = frac.length - exp;
  if (scale < 0) {
    v *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { v: m[1] === '-' ? -v : v, scale };
}
function formatScaled(v: bigint, scale: number): string {
  const neg = v < ZERO;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, '0');
  const out = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return neg ? `-${out}` : out;
}

class DecimalSum {
  private v = ZERO;
  private scale = 0;
  private unknown = false;
  add(s: string | null): void {
    if (s === null || !isDecimalString(s)) {
      this.unknown = true;
      return;
    }
    const x = scaled(s);
    if (x.scale > this.scale) {
      this.v *= TEN ** BigInt(x.scale - this.scale);
      this.scale = x.scale;
    }
    this.v += x.v * TEN ** BigInt(this.scale - x.scale);
  }
  value(): string | null {
    return this.unknown ? null : formatScaled(this.v, this.scale);
  }
}

/** Writes one (file, period) output as gzip members of bounded uncompressed size. */
class GzipMembers {
  private readonly scratch: Buffer;
  private pos = 0;
  private readonly members: Buffer[] = [];
  records = 0;
  constructor(size: number) {
    this.scratch = Buffer.allocUnsafe(size);
  }
  write(src: Buffer, s: number, e: number): void {
    while (s < e) {
      const n = Math.min(e - s, this.scratch.length - this.pos);
      src.copy(this.scratch, this.pos, s, s + n);
      this.pos += n;
      s += n;
      if (this.pos === this.scratch.length) this.flush();
    }
  }
  private flush(): void {
    this.members.push(zlib.gzipSync(this.scratch.subarray(0, this.pos), { level: GZIP_LEVEL }));
    this.pos = 0;
  }
  finish(): Buffer {
    if (this.pos > 0 || this.members.length === 0) this.flush();
    return Buffer.concat(this.members);
  }
}

function checkControl(c: StageControl): void {
  const bad = (m: string): never => {
    throw new IngestError('IMPORT_CONTROL_INVALID', m);
  };
  if (c.rowCount !== undefined && (!Number.isSafeInteger(c.rowCount) || c.rowCount < 0)) bad('the control row count must be a non-negative integer');
  if (c.billedTotal !== undefined && !isDecimalString(c.billedTotal)) bad('the control billed total must be a plain decimal');
  if (c.billedTotal !== undefined && c.currency === undefined) bad('a control billed total needs its currency (--currency)');
  if (c.currency !== undefined && !CURRENCY_RE.test(c.currency)) bad('the control currency must be an ISO 4217 code (three upper-case letters)');
}

interface ParsedFile {
  header: Buffer;
  columns: string[];
  writers: Map<string, GzipMembers>;
  dataRows: number;
  currencyMismatches: number;
}

interface Shared {
  nullTokens: Record<string, number>;
  preview: Map<string, { rows: number; billed: Map<string, DecimalSum> }>;
}

function parseFile(b: Buffer, opts: StageOptions, control: StageControl | undefined, shared: Shared, where: string): ParsedFile {
  if (!isUtf8(b)) invalid(`${where} is not valid UTF-8`);
  // One leading byte order mark, as the worker's parser accepts it (bom: true); it is not staged.
  const from = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  if (b.length === from) invalid(`${where} is empty`);
  const memberBytes = opts.gzipMemberBytes ?? GZIP_MEMBER_BYTES;
  const out: ParsedFile = { header: Buffer.alloc(0), columns: [], writers: new Map(), dataRows: 0, currencyMismatches: 0 };
  let first = true;
  let iStart = -1;
  let iProvider = -1;
  let iCurrency = -1;
  let iBilled = -1;
  scan(b, from, where, (rec) => {
    if (first) {
      first = false;
      out.columns = Array.from({ length: rec.count }, (_, k) => valueOf(b, rec, k));
      out.header = b.subarray(rec.start, rec.end);
      if (new Set(out.columns).size !== out.columns.length) invalid(`${where}: the header has a duplicate column name`);
      iStart = out.columns.indexOf('BillingPeriodStart');
      if (iStart < 0) invalid(`${where}: the header lacks the required column BillingPeriodStart`);
      iProvider = out.columns.includes('ProviderName') ? out.columns.indexOf('ProviderName') : out.columns.indexOf('ServiceProviderName');
      iCurrency = out.columns.indexOf('BillingCurrency');
      iBilled = out.columns.indexOf('BilledCost');
      return;
    }
    if (rec.count !== out.columns.length) invalid(`${where}, record ${rec.n} has ${rec.count} fields, the header has ${out.columns.length}`);
    out.dataRows++;
    const m = isNullToken(b, rec, iStart) ? null : PERIOD_RE.exec(valueOf(b, rec, iStart));
    if (!m) invalid(`${where}, record ${rec.n}: BillingPeriodStart is not the first of a month at midnight`);
    const ym = `${m![1]}-${m![2]}`;
    if (opts.period !== undefined && `${ym}-01` !== opts.period) return;
    if (opts.providers && iProvider >= 0) {
      const p = shared.preview.get(ym) ?? { rows: 0, billed: new Map() };
      shared.preview.set(ym, p);
      if (opts.providers.includes(valueOf(b, rec, iProvider))) {
        p.rows++;
        const currency = iCurrency >= 0 ? valueOf(b, rec, iCurrency) : '';
        if (control?.currency !== undefined && iCurrency >= 0 && currency !== control.currency) out.currencyMismatches++;
        if (iCurrency >= 0 && iBilled >= 0) {
          if (!p.billed.has(currency)) p.billed.set(currency, new DecimalSum());
          p.billed.get(currency)!.add(isNullToken(b, rec, iBilled) ? null : valueOf(b, rec, iBilled));
        }
      }
    }
    let w = out.writers.get(ym);
    if (!w) {
      w = new GzipMembers(memberBytes);
      w.write(out.header, 0, out.header.length);
      w.write(NEWLINE, 0, 1);
      out.writers.set(ym, w);
    }
    // The record's raw bytes, with each NULL token cut out (an empty field remains).
    let seg = rec.start;
    for (let k = 0; k < rec.count; k++) {
      if (!isNullToken(b, rec, k)) continue;
      w.write(b, seg, rec.starts[k]);
      seg = rec.ends[k];
      shared.nullTokens[out.columns[k]] = (shared.nullTokens[out.columns[k]] ?? 0) + 1;
    }
    w.write(b, seg, rec.end);
    w.write(NEWLINE, 0, 1);
    w.records++;
  });
  if (out.dataRows === 0) invalid(`${where} has a header but no data rows`);
  return out;
}

/** Raw record strings of one staged CSV body (header excluded). */
function recordsOf(csv: Buffer): string[] {
  const records: string[] = [];
  let header = true;
  scan(csv, 0, 'a staged file', (r) => {
    if (header) header = false;
    else records.push(csv.toString('utf8', r.start, r.end));
  });
  return records;
}

export interface StageInput {
  /** Operator- or connector-facing name; used only in messages. */
  name: string;
  /** CSV bytes (already decompressed). */
  bytes: Buffer;
}

/**
 * Stages one or more FOCUS CSV files (one delivery) into per-period data files
 * plus one manifest per period. `opts.provenance` is carried verbatim in each
 * manifest's `x-ratio-import` (the manifest is captured as evidence by the worker).
 */
export function stageFile(input: Buffer | StageInput[], opts: StageOptions & { provenance?: Record<string, unknown> }): StagedFile {
  const inputs = Buffer.isBuffer(input) ? [{ name: 'file', bytes: input }] : input;
  if (inputs.length === 0) invalid('nothing to import');
  const control = opts.control && Object.values(opts.control).some((v) => v !== undefined) ? opts.control : undefined;
  if (control) checkControl(control);
  if (control && !opts.providers?.length) {
    throw new IngestError('IMPORT_CONTROL_INVALID', "controls apply to the source's declared providers, and none were given");
  }
  const fileShas = inputs.map((f) => sha256(f.bytes));
  const twin = fileShas.findIndex((s, i) => fileShas.indexOf(s) !== i);
  if (twin >= 0) throw new IngestError('IMPORT_FILE_DUPLICATE', `file ${twin + 1} has the same bytes as file ${fileShas.indexOf(fileShas[twin]) + 1}; supply each file of a delivery once`);
  const shared: Shared = { nullTokens: {}, preview: new Map() };
  const parsed = inputs.map((f, i) => parseFile(f.bytes, opts, control, shared, inputs.length > 1 ? `file ${i + 1}` : 'the file'));
  const yms = [...new Set(parsed.flatMap((p) => [...p.writers.keys()]))].sort();
  if (yms.length === 0) throw new IngestError('IMPORT_PERIOD_NOT_IN_FILE', `the file has no rows for billing period ${opts.period?.slice(0, 7)}`);
  if (control && yms.length !== 1) {
    throw new IngestError('IMPORT_CONTROL_SCOPE', `the file covers ${yms.length} billing periods: controls apply to one period, so name it with --period YYYY-MM`);
  }
  const mismatches = parsed.reduce((n, p) => n + p.currencyMismatches, 0);
  if (mismatches > 0) {
    throw new IngestError('IMPORT_CONTROL_CURRENCY_MISMATCH', `${mismatches} row(s) of the declared providers in this period bill in a currency other than the control currency`);
  }

  const executionId = `import-${sha256(Buffer.from(fileShas.join('\n'))).slice(0, 12)}`;
  const { bucket, exportName } = opts.location;
  const objects: StagedObject[] = [];
  const periods: StagedFile['periods'] = [];
  for (const ym of yms) {
    const period = `${ym}-01`;
    const dataFiles: string[] = [];
    let records = 0;
    parsed.forEach((p, i) => {
      const w = p.writers.get(ym);
      if (!w) return;
      records += w.records;
      const key = `${dataPrefix(opts.location, period)}${executionId}/${exportName}-${String(i + 1).padStart(5, '0')}.csv.gz`;
      const body = w.finish();
      objects.push({ kind: 'data', key, body, sha256: sha256(body), billingPeriod: period });
      dataFiles.push(`s3://${bucket}/${key}`);
    });
    periods.push({ billingPeriod: period, records });
    const [y, mo] = ym.split('-').map(Number);
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    const manifest = {
      exportName,
      executionId,
      billingPeriod: { start: `${period}T00:00:00.000Z`, end: `${next}-01T00:00:00.000Z` },
      dataFiles,
      ...(control ? { 'x-ratio-control': control } : {}),
      'x-ratio-import': { ...opts.provenance, files: fileShas, period },
    };
    const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    objects.push({ kind: 'manifest', key: `${periodMetadataPrefix(opts.location, period)}${exportName}-Manifest.json`, body, sha256: sha256(body), billingPeriod: period });
  }
  const header = parsed[0].header.toString('utf8');
  const columns = parsed[0].columns;
  const nullTokens = shared.nullTokens;
  return {
    files: inputs.map((f, i) => ({ name: f.name, sha256: fileShas[i], dataRows: parsed[i].dataRows, bytes: f.bytes.length })),
    get plan(): StagePlan {
      return {
        header,
        columns,
        periods: yms.map((ym) => ({
          ym,
          files: objects.filter((o) => o.kind === 'data' && o.billingPeriod === `${ym}-01`).map((o) => ({ records: recordsOf(zlib.gunzipSync(o.body)), level: GZIP_LEVEL })),
        })),
        nullTokens,
        nullToEmpty: true,
        splitByPeriod: true,
      };
    },
    objects,
    periods,
    preview: opts.providers
      ? yms.map((ym) => {
          const p = shared.preview.get(ym);
          return { billingPeriod: `${ym}-01`, rows: p?.rows ?? 0, billed: Object.fromEntries([...(p?.billed ?? new Map<string, DecimalSum>())].map(([c, s]) => [c, s.value()])) };
        })
      : [],
    nullTokensReplaced: nullTokens,
  };
}
