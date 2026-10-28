// R3: stages an operator's FOCUS CSV / CSV.gz file into the existing export
// layout (sources/s3/layout.ts) so the existing worker (runSync: validator,
// quarantine, reconciliation, publish) ingests it. Pure: no I/O.
// Ported from the acceptance run's planStaging (scripts/local/acceptance.mjs):
// split by BillingPeriodStart month, map the unquoted literal NULL token to an
// empty field, keep every other field's raw bytes, gzip each period's file.
// This is NOT a FOCUS parser: it only splits records; validation stays in the worker.
//
// Controls: the operator's controls go into the manifest's `x-ratio-control`
// for exactly one period. Per-file row counts are deliberately NOT written: the
// worker would derive a set-level control from them (pipeline.ts
// effectiveControl), i.e. reconcile the file against itself. Without operator
// controls a period therefore lands `unverified`, never `reconciled`.
//
// Errors name the record number and column, never a cell value.
import crypto from 'crypto';
import zlib from 'zlib';
import { IngestError } from '../errors';
import { isDecimalString } from '../focus/decimal';
import { dataPrefix, periodMetadataPrefix, type ExportLocation } from '../sources/s3/layout';

/** Largest CSV (after decompression) one import accepts. */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const GZIP_LEVEL = 6;
const PERIOD_RE = /^([0-9]{4})-(0[1-9]|1[0-2])-01(?:[ T]00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

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
  /** The source's declared providers (currency check of the control). */
  providers?: readonly string[];
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

export interface StagedFile {
  /** Per input: name, sha256 of its CSV bytes (after decompression), data rows. */
  files: Array<{ name: string; sha256: string; dataRows: number }>;
  plan: StagePlan;
  objects: StagedObject[];
  periods: Array<{ billingPeriod: string; records: number }>;
  nullTokensReplaced: Record<string, number>;
}

const invalid = (m: string): never => {
  throw new IngestError('IMPORT_FILE_INVALID', m);
};

/** The CSV bytes of an import file: `.csv` as is, `.csv.gz` decompressed (bounded). */
export function decodeImportFile(bytes: Buffer, fileName: string): Buffer {
  const n = fileName.toLowerCase();
  if (n.endsWith('.csv.gz')) {
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) invalid('the file is named .csv.gz but is not gzip data');
    try {
      return zlib.gunzipSync(bytes, { maxOutputLength: MAX_IMPORT_BYTES });
    } catch {
      return invalid(`the file could not be decompressed (corrupt gzip, or larger than ${MAX_IMPORT_BYTES} bytes)`);
    }
  }
  if (!n.endsWith('.csv')) invalid('the file must be a FOCUS .csv or .csv.gz file');
  if (bytes.length > MAX_IMPORT_BYTES) invalid(`the file is larger than ${MAX_IMPORT_BYTES} bytes`);
  return bytes;
}

interface Field {
  raw: string;
  value: string;
  quoted: boolean;
}

/**
 * RFC 4180 records with each field's raw text and record number (the acceptance tokenizer; CRLF accepted
 * as a record end). Empty lines are skipped, as the worker's parser does (skip_empty_lines).
 */
function* csvRecords(text: string, where: string): Generator<[Field[], number]> {
  let rec: Field[] = [];
  let start = 0;
  let quoted = false;
  let inQuotes = false;
  let afterQuote = false;
  let n = 1;
  const end = (at: number) => {
    const raw = text.slice(start, at);
    rec.push({ raw, value: quoted ? raw.slice(1, -1).replaceAll('""', '"') : raw, quoted });
    quoted = false;
    afterQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else {
          inQuotes = false;
          afterQuote = true;
        }
      }
      continue;
    }
    if (c === ',') {
      end(i);
      start = i + 1;
    } else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      const blank = rec.length === 0 && i === start;
      end(i);
      if (!blank) yield [rec, n];
      rec = [];
      n++;
      if (c === '\r') i++;
      start = i + 1;
    } else if (c === '\r') invalid(`${where}, record ${n}: a carriage return outside a line ending`);
    else if (afterQuote) invalid(`${where}, record ${n}: characters after a closing quote`);
    else if (c === '"') {
      if (i !== start) invalid(`${where}, record ${n}: a stray quote inside an unquoted field`);
      inQuotes = true;
      quoted = true;
    }
  }
  if (inQuotes) invalid(`${where}, record ${n}: unterminated quoted field at the end of the file`);
  if (start < text.length || rec.length) {
    end(text.length);
    yield [rec, n];
  }
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const isNullToken = (f: Field) => !f.quoted && f.value === 'NULL';

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
  header: string;
  columns: string[];
  byPeriod: Map<string, string[]>;
  dataRows: number;
  currencyMismatches: number;
}

function parseFile(bytes: Buffer, opts: StageOptions, control: StageControl | undefined, nullTokens: Record<string, number>, where: string): ParsedFile {
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalid(`${where} is not valid UTF-8`);
  }
  // One leading byte order mark, as the worker's parser accepts it (bom: true); it is not staged.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length === 0) invalid(`${where} is empty`);
  const out: ParsedFile = { header: '', columns: [], byPeriod: new Map(), dataRows: 0, currencyMismatches: 0 };
  let iStart = -1;
  let iProvider = -1;
  let iCurrency = -1;
  let first = true;
  for (const [rec, r] of csvRecords(text, where)) {
    if (first) {
      first = false;
      out.columns = rec.map((f) => f.value);
      out.header = rec.map((f) => f.raw).join(',');
      if (new Set(out.columns).size !== out.columns.length) invalid(`${where}: the header has a duplicate column name`);
      iStart = out.columns.indexOf('BillingPeriodStart');
      if (iStart < 0) invalid(`${where}: the header lacks the required column BillingPeriodStart`);
      iProvider = out.columns.includes('ProviderName') ? out.columns.indexOf('ProviderName') : out.columns.indexOf('ServiceProviderName');
      iCurrency = out.columns.indexOf('BillingCurrency');
      continue;
    }
    if (rec.length !== out.columns.length) invalid(`${where}, record ${r} has ${rec.length} fields, the header has ${out.columns.length}`);
    out.dataRows++;
    const m = isNullToken(rec[iStart]) ? null : PERIOD_RE.exec(rec[iStart].value);
    if (!m) invalid(`${where}, record ${r}: BillingPeriodStart is not the first of a month at midnight`);
    const ym = `${m![1]}-${m![2]}`;
    if (opts.period !== undefined && `${ym}-01` !== opts.period) continue;
    if (control?.currency !== undefined && opts.providers && iProvider >= 0 && iCurrency >= 0 && opts.providers.includes(rec[iProvider].value) && rec[iCurrency].value !== control.currency) {
      out.currencyMismatches++;
    }
    const line = rec
      .map((f, i) => {
        if (!isNullToken(f)) return f.raw;
        nullTokens[out.columns[i]] = (nullTokens[out.columns[i]] ?? 0) + 1;
        return '';
      })
      .join(',');
    if (!out.byPeriod.has(ym)) out.byPeriod.set(ym, []);
    out.byPeriod.get(ym)!.push(line);
  }
  if (out.dataRows === 0) invalid(`${where} has a header but no data rows`);
  return out;
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
  const nullTokens: Record<string, number> = {};
  const parsed = inputs.map((f, i) => parseFile(f.bytes, opts, control, nullTokens, inputs.length > 1 ? `file ${i + 1}` : 'the file'));
  const yms = [...new Set(parsed.flatMap((p) => [...p.byPeriod.keys()]))].sort();
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
  const plan: StagePlan = { header: parsed[0].header, columns: parsed[0].columns, periods: [], nullTokens, nullToEmpty: true, splitByPeriod: true };
  const objects: StagedObject[] = [];
  for (const ym of yms) {
    const period = `${ym}-01`;
    const files = parsed.map((p, i) => ({ i, header: p.header, records: p.byPeriod.get(ym) })).filter((f) => f.records !== undefined);
    plan.periods.push({ ym, files: files.map((f) => ({ records: f.records!, level: GZIP_LEVEL })) });
    const dataFiles: string[] = [];
    for (const f of files) {
      const key = `${dataPrefix(opts.location, period)}${executionId}/${exportName}-${String(f.i + 1).padStart(5, '0')}.csv.gz`;
      const body = zlib.gzipSync(Buffer.from(`${f.header}\n${f.records!.map((l) => `${l}\n`).join('')}`, 'utf8'), { level: GZIP_LEVEL });
      objects.push({ kind: 'data', key, body, sha256: sha256(body), billingPeriod: period });
      dataFiles.push(`s3://${bucket}/${key}`);
    }
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
  return {
    files: inputs.map((f, i) => ({ name: f.name, sha256: fileShas[i], dataRows: parsed[i].dataRows })),
    plan,
    objects,
    periods: plan.periods.map((p) => ({ billingPeriod: `${p.ym}-01`, records: p.files.reduce((n, f) => n + f.records.length, 0) })),
    nullTokensReplaced: nullTokens,
  };
}
