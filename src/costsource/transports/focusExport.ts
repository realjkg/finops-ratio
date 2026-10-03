// Shared FOCUS-export plumbing for the live connector transports.
//
// Every cloud / private-cloud / on-prem connector ends up holding the same
// thing: a blob of FOCUS-formatted export data (CSV, JSON, or NDJSON, possibly
// gzip-compressed). This module turns that blob into `RawSourceRow`s the
// existing version-negotiation shim (`normalizeRows`) already understands, and
// picks which export objects to read out of a bucket / container listing.
//
// Web-standard APIs only (fetch, TextDecoder, DecompressionStream) so the same
// code runs on Node 20+, edge runtimes, and in the browser bundle without
// pulling in a cloud SDK.

import type { CostWindow } from '../CostSourceClient';
import type { RawSourceRow } from '../focusRows';
import { COLUMNS_BY_VERSION } from '../focusVersions';
import { logUpstreamError, redactErrorText, statusReason } from './redact';

// --- fetch ------------------------------------------------------------------

export type FetchLike = typeof fetch;

/** Default per-request timeout for connector calls. A health probe must never hang. */
export const DEFAULT_TIMEOUT_MS = 30_000;

// Upstream-error hygiene helpers live in ./redact (shared with the PointFive,
// AI and change-management adapters); re-exported here for transport callers.
export { logUpstreamError, readJsonBody, statusReason } from './redact';

/**
 * fetch with a timeout and a typed, secret-free error on non-2xx. The thrown
 * message is label + status + a fixed reason — the upstream body (which can
 * echo credentials, presigned URLs, or tenant data) is only logged server-side.
 */
export async function fetchChecked(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`${label} unreachable: ${redactErrorText(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (body) logUpstreamError(label, res.status, body);
    throw new Error(`${label} returned ${res.status} (${statusReason(res.status)})`);
  }
  return res;
}

// --- decoding ---------------------------------------------------------------

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isParquet(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x52 && bytes[3] === 0x31
  );
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bytes of an export object → text, transparently gunzipping. Parquet is rejected loudly. */
export async function decodeExportBytes(bytes: Uint8Array, name: string): Promise<string> {
  if (isParquet(bytes)) {
    throw new Error(
      `${name} is Parquet; configure the export as CSV (gzip is fine) so Ratio can read it`,
    );
  }
  const raw = isGzip(bytes) ? await gunzip(bytes) : bytes;
  return new TextDecoder('utf-8').decode(raw);
}

// --- parsing ----------------------------------------------------------------

/** RFC 4180 CSV → records keyed by header. Handles quotes, escaped quotes, CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!header) return [];
  return body.map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h.trim()] = cells[idx] ?? '';
    });
    return rec;
  });
}

/** Text of a FOCUS export in any supported format → loose records. */
export function parseExportText(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
      if (parsed && typeof parsed === 'object') {
        // Common envelopes: { rows: [...] }, { data: [...] }, { items: [...] }
        for (const key of ['rows', 'data', 'items', 'records', 'value']) {
          const inner = (parsed as Record<string, unknown>)[key];
          if (Array.isArray(inner)) return inner as Record<string, unknown>[];
        }
        return [parsed as Record<string, unknown>];
      }
    } catch {
      // Not a single JSON document — NDJSON (one object per line). A bad line
      // throws a FIXED message: runtime JSON errors quote the input, which is
      // upstream content and must not reach API callers.
      if (trimmed.startsWith('{')) {
        return trimmed
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line, i) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              throw new Error(`export is not valid NDJSON (line ${i + 1})`);
            }
          });
      }
    }
  }
  return parseCsv(trimmed);
}

// --- coercion to RawSourceRow --------------------------------------------------

const NUMERIC_COLUMNS = new Set([
  'BilledCost',
  'EffectiveCost',
  'ListCost',
  'ContractedCost',
  'PricingQuantity',
  'UsageQuantity',
  'ConsumedQuantity',
]);

const DATE_COLUMNS = new Set([
  'BillingPeriodStart',
  'BillingPeriodEnd',
  'ChargePeriodStart',
  'ChargePeriodEnd',
]);

// Nullable string columns in the canonical model: an empty CSV cell is null.
const NULLABLE_COLUMNS = new Set([
  'CommitmentDiscountStatus',
  'SkuMeter',
  'CapacityReservationId',
  'CapacityReservationStatus',
]);

/** Currency columns: ISO-4217-shaped three-letter codes. */
const CURRENCY_COLUMNS = new Set(['BillingCurrency', 'PricingCurrency']);

const KNOWN_COLUMNS = new Set(Object.values(COLUMNS_BY_VERSION).flat());

/**
 * Columns a row must carry for its cost to be meaningful. A row missing any of
 * them is INVALID: the fetch fails loudly rather than dropping the row (a
 * dropped row is silently missing cost) or inventing a value (e.g. assuming USD).
 */
const REQUIRED_COLUMNS = ['BilledCost', 'ChargePeriodStart', 'BillingCurrency'] as const;

/** Options for row coercion. */
export interface FocusRecordOptions {
  /**
   * Accept epoch-second timestamps (BigQuery's REST TIMESTAMP encoding) in date
   * columns. Only the BigQuery transport sets this; everywhere else a bare
   * number is not a date.
   */
  allowEpochSeconds?: boolean;
  /**
   * Keep the FOCUS `Tags` column and every `x_*` extension column as supplied
   * (direct ingest). Connector exports drop provider `x_*` columns — Ratio adds
   * its own.
   */
  keepExtensions?: boolean;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Strict decimal: optional minus, digits, optional fraction, optional exponent. */
const DECIMAL_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** Strict decimal (number or decimal string) → finite number, else null. */
export function parseStrictDecimal(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && DECIMAL_RE.test(v.trim())) n = Number(v.trim());
  else return null;
  return Number.isFinite(n) ? n : null;
}

/**
 * Absent / empty numeric cells are 0; anything present must be a strict decimal
 * (no hex, no `Infinity`, no thousands separators) or a finite number.
 */
function toNumber(v: unknown, column: string): number {
  if (isBlank(v)) return 0;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && DECIMAL_RE.test(v.trim())) n = Number(v.trim());
  else n = Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`${column} is not a number`);
  return n;
}

// ISO-8601 date or date-time. Offset-less date-times are UTC (never server
// local). `YYYY-MM-DD HH:MM:SS UTC` (BigQuery text) is accepted as UTC.
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|z|UTC|[+-]\d{2}:?\d{2})?$/;

/** Strict ISO-8601 → epoch ms (UTC), or null when invalid / impossible. */
export function parseIsoUtc(value: string): number | null {
  const m = ISO_DATE_RE.exec(value.trim());
  if (!m) return null;
  const [, ys, mos, ds, hs = '0', mis = '0', ss = '0', frac = '', off] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  const s = Number(ss);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Number(`${frac}000`.slice(0, 3));
  let t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (off && off !== 'Z' && off !== 'z' && off !== 'UTC') {
    const sign = off.startsWith('-') ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return null;
    t -= sign * (oh * 60 + om) * 60_000;
  }
  return t;
}

const EPOCH_MIN_MS = Date.UTC(2000, 0, 1);
const EPOCH_MAX_MS = Date.UTC(2100, 0, 1);

/**
 * Blank date cells are ''; anything present must be ISO-8601 (or, on the
 * BigQuery path only, epoch seconds within 2000-01-01..2100-01-01), else the
 * row is invalid. Output is always ISO-8601 UTC with milliseconds.
 */
function toIsoDate(v: unknown, column: string, opts: FocusRecordOptions): string {
  if (isBlank(v)) return '';
  if (opts.allowEpochSeconds && (typeof v === 'number' || (typeof v === 'string' && DECIMAL_RE.test(v.trim())))) {
    const ms = Number(typeof v === 'string' ? v.trim() : v) * 1000;
    if (!Number.isFinite(ms) || ms < EPOCH_MIN_MS || ms >= EPOCH_MAX_MS) {
      throw new Error(`${column} is not a valid date`);
    }
    return new Date(ms).toISOString();
  }
  const t = typeof v === 'string' ? parseIsoUtc(v) : null;
  if (t === null) throw new Error(`${column} is not a valid date`);
  return new Date(t).toISOString();
}

function toStringValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

function toCurrency(v: unknown, column: string): string {
  const s = toStringValue(v).trim();
  if (!/^[A-Z]{3}$/.test(s)) throw new Error(`${column} is not an ISO-4217 currency code`);
  return s;
}

function isExtensionColumn(key: string): boolean {
  return key === 'Tags' || key.startsWith('x_');
}

/**
 * A loose record from an export → a `RawSourceRow`. Only FOCUS columns are kept
 * (provider-specific `x_*` columns are dropped — Ratio adds its own — unless
 * `keepExtensions`). Optional columns a real export leaves null (e.g.
 * ResourceId on a tax line) become '' / 0 rather than undefined, so the
 * canonical upgrade never sees a hole.
 *
 * Normalization contract: dates → ISO-8601 UTC with milliseconds; numeric
 * strings → numbers; currencies → validated three-letter codes. Each row keeps
 * its own currency (mixed currencies are legitimate and never summed here).
 *
 * THROWS (with the reason) for an invalid record: a missing required column
 * (BilledCost / ChargePeriodStart / BillingCurrency), an unparseable number or
 * date, or an invalid currency. `validateFocusRecords` adds artifact + row.
 */
export function coerceFocusRecord(rec: Record<string, unknown>, opts: FocusRecordOptions = {}): RawSourceRow {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('row is not an object');
  for (const col of REQUIRED_COLUMNS) {
    if (isBlank(rec[col])) throw new Error(`missing required column ${col}`);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (opts.keepExtensions && isExtensionColumn(key)) {
      out[key] = value;
      continue;
    }
    if (!KNOWN_COLUMNS.has(key)) continue;
    if (NUMERIC_COLUMNS.has(key)) out[key] = toNumber(value, key);
    else if (DATE_COLUMNS.has(key)) out[key] = toIsoDate(value, key, opts);
    else if (CURRENCY_COLUMNS.has(key)) out[key] = isBlank(value) ? null : toCurrency(value, key);
    else if (NULLABLE_COLUMNS.has(key)) out[key] = value === '' || value == null ? null : toStringValue(value);
    else out[key] = toStringValue(value);
  }
  // An absent optional PricingCurrency stays absent (the canonical upgrade
  // derives it from BillingCurrency); never an explicit null.
  if (out.PricingCurrency === null) delete out.PricingCurrency;

  // Fill the v1.0 core so the row satisfies the type even when the export left
  // optional-in-practice columns out entirely.
  for (const col of COLUMNS_BY_VERSION['1.0']) {
    if (out[col] === undefined) out[col] = NUMERIC_COLUMNS.has(col) ? 0 : '';
  }
  // EffectiveCost defaults to BilledCost ONLY when the source omitted it — a
  // present 0 (fully discounted / credited usage) is a real value and is kept.
  if (isBlank(rec.EffectiveCost)) out.EffectiveCost = out.BilledCost;
  return out as unknown as RawSourceRow;
}

/** Throws unless both window bounds parse and start < end (half-open window). */
export function assertValidWindow(window: CostWindow): void {
  const start = Date.parse(window?.start);
  const end = Date.parse(window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end)) {
    throw new Error('invalid cost window: start and end must be valid timestamps with start < end');
  }
}

/**
 * True when a row's charge period starts inside the half-open window. A row it
 * cannot place is never kept or dropped silently: it throws. (Coerced rows are
 * already validated, so this only fires for rows that bypassed coercion.)
 */
export function inWindow(row: RawSourceRow, window: CostWindow): boolean {
  const t = Date.parse(row.ChargePeriodStart);
  if (Number.isNaN(t)) throw new Error('ChargePeriodStart is not a valid date');
  return t >= Date.parse(window.start) && t < Date.parse(window.end);
}

/**
 * The shared FOCUS row validator: every record is coerced, and an invalid one
 * throws `<artifact>: invalid FOCUS row N: <reason>` (1-based) — it is never
 * dropped or silently normalized. No window filtering.
 */
export function validateFocusRecords(
  records: Record<string, unknown>[],
  artifact: string,
  opts: FocusRecordOptions = {},
): RawSourceRow[] {
  return records.map((rec, i) => {
    try {
      return coerceFocusRecord(rec, opts);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${artifact}: invalid FOCUS row ${i + 1}: ${reason}`);
    }
  });
}

/**
 * Loose records → validated (see `validateFocusRecords`), window-filtered FOCUS
 * rows. Rows outside the window are filtered (selection, not loss).
 */
export function rowsFromRecords(
  records: Record<string, unknown>[],
  window: CostWindow,
  artifact: string,
  opts: FocusRecordOptions = {},
): RawSourceRow[] {
  assertValidWindow(window);
  return validateFocusRecords(records, artifact, opts).filter((r) => inWindow(r, window));
}

/** Export text → coerced, window-filtered FOCUS rows (throws on any invalid row). */
export function rowsFromExportText(text: string, window: CostWindow, artifact: string): RawSourceRow[] {
  return rowsFromRecords(parseExportText(text), window, artifact);
}

// --- object selection (bucket / container listings) ----------------------------

export interface ExportObject {
  key: string;
  lastModified: string; // ISO 8601 or RFC 1123
  size: number;
}

const DATA_FILE = /\.(csv|csv\.gz|gz|json|ndjson|jsonl)$/i;

export function dirOf(key: string): string {
  const i = key.lastIndexOf('/');
  return i === -1 ? '' : key.slice(0, i);
}

interface BillingMonth {
  y: number;
  m: number; // 0-based
}

/** Every billing month (UTC) intersecting the half-open window [start, end), as YYYY-MM. */
export function monthsInWindow(window: CostWindow): string[] {
  assertValidWindow(window);
  const start = new Date(window.start);
  const endMs = Date.parse(window.end);
  const months: BillingMonth[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  do {
    months.push({ y, m });
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  } while (Date.UTC(y, m, 1) < endMs);
  return months.map((mo) => `${mo.y}-${String(mo.m + 1).padStart(2, '0')}`);
}

function monthLabel(y: string, m: string): string | null {
  const mo = Number(m);
  return mo >= 1 && mo <= 12 ? `${y}-${m}` : null;
}

/**
 * Billing months (YYYY-MM) a key's DIRECTORY / partition segments name — never
 * the file name, so `costs_2026-05-31.csv` inside a June run is a June file.
 * Recognised segments: `BILLING_PERIOD=YYYY-MM` (AWS), `YYYYMMDD-YYYYMMDD`
 * (Azure; the start date's month), and generic `YYYY-MM` / `YYYYMM`.
 */
export function keyMonths(key: string): Set<string> {
  const months = new Set<string>();
  const segments = key.split('/').slice(0, -1);
  for (const seg of segments) {
    let m: RegExpExecArray | null;
    let label: string | null = null;
    if ((m = /^BILLING_PERIOD=(\d{4})-(\d{2})$/.exec(seg))) label = monthLabel(m[1], m[2]);
    else if ((m = /^(\d{4})(\d{2})\d{2}-\d{8}$/.exec(seg))) label = monthLabel(m[1], m[2]);
    else if ((m = /^(\d{4})-(\d{2})$/.exec(seg))) label = monthLabel(m[1], m[2]);
    else if ((m = /^(\d{4})(\d{2})$/.exec(seg))) label = monthLabel(m[1], m[2]);
    if (label) months.add(label);
  }
  return months;
}

/** Every file in the most recently written directory of a non-empty pool. */
function latestRun(pool: ExportObject[]): ExportObject[] {
  const latest = pool.reduce((a, b) => (Date.parse(b.lastModified) > Date.parse(a.lastModified) ? b : a));
  const dir = dirOf(latest.key);
  return pool.filter((o) => dirOf(o.key) === dir);
}

/** One selected export run: the billing month it serves and its directory. */
export interface ExportRun {
  month: string | null; // null only for an undated layout (fallback)
  dir: string;
  files: ExportObject[];
}

/**
 * Pick the export runs to read from a listing. Cloud FOCUS exports land as one
 * directory per run (with manifests alongside); re-runs overwrite a period in a
 * NEW directory. So: keep data files and, for EACH billing month the window
 * intersects, take that month's most recently written run directory.
 *
 * Throws naming the month when any intersecting month has no export. The only
 * fallback: when NO data file in the listing names ANY month (an undated
 * layout) and the window is inside one month, the latest run overall is used.
 */
export function selectExportRuns(objects: ExportObject[], window: CostWindow): ExportRun[] {
  const months = monthsInWindow(window);
  const data = objects.filter(
    (o) => DATA_FILE.test(o.key) && !/manifest/i.test(o.key) && o.size > 0,
  );
  if (data.length === 0) return [];

  const dated = data.some((o) => keyMonths(o.key).size > 0);
  if (!dated && months.length === 1) {
    const files = latestRun(data);
    return [{ month: null, dir: dirOf(files[0].key), files }];
  }

  const runs: ExportRun[] = [];
  for (const month of months) {
    const pool = data.filter((o) => keyMonths(o.key).has(month));
    if (pool.length === 0) {
      throw new Error(
        `no FOCUS export found for billing month ${month} in the requested window — refusing to return partial data`,
      );
    }
    const files = latestRun(pool);
    runs.push({ month, dir: dirOf(files[0].key), files });
  }
  return runs;
}

/** The data files of `selectExportRuns`, each key once, sorted. */
export function selectExportObjects(objects: ExportObject[], window: CostWindow): ExportObject[] {
  const picked = new Map<string, ExportObject>();
  for (const run of selectExportRuns(objects, window)) {
    for (const o of run.files) picked.set(o.key, o);
  }
  return [...picked.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Parse a manifest body with a FIXED error (never quotes the content). */
export function parseManifest(text: string, label: string, where: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new Error(`${label}: export run incomplete: manifest unreadable (${where})`);
}

/** Throws unless every manifest-listed key is present in the listing. */
export function assertManifestFilesPresent(listed: string[], listing: ExportObject[], label: string, where: string): void {
  const present = new Set(listing.map((o) => o.key));
  const missing = listed.filter((k) => !present.has(k));
  if (missing.length > 0) {
    throw new Error(
      `${label}: export run incomplete: manifest lists ${missing.length} file(s) not present in the listing (${where})`,
    );
  }
}

/** Upper bound on export files read per fetch — protects the route from a runaway listing. */
export const MAX_EXPORT_FILES = 50;

/** Throws when a selection exceeds MAX_EXPORT_FILES — a partial export is never read. */
export function assertExportFileCap(count: number, label: string): void {
  if (count > MAX_EXPORT_FILES) {
    throw new Error(
      `${label}: selected export has ${count} files, exceeding the cap of ${MAX_EXPORT_FILES} — refusing to return partial data`,
    );
  }
}

/** Error for a listing loop that hit its page cap while more pages remain. */
export function listingTruncatedError(label: string, maxPages: number): Error {
  return new Error(
    `${label}: listing still has more pages after ${maxPages} pages — refusing to proceed with a partial listing`,
  );
}


/** Tiny XML helper: every `<tag>…</tag>` value inside `xml` (no nesting needed). */
export function xmlValues(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decodeXml(m[1]));
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
