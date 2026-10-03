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

// --- fetch ------------------------------------------------------------------

export type FetchLike = typeof fetch;

/** Default per-request timeout for connector calls. A health probe must never hang. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** fetch with a timeout and a typed, secret-free error on non-2xx. */
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
    throw new Error(`${label} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    // Body is truncated: provider error bodies can be large XML/HTML pages.
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${label} returned ${res.status}${body ? `: ${body}` : ''}`);
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
      // Not a single JSON document — NDJSON (one object per line).
      if (trimmed.startsWith('{')) {
        return trimmed
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, unknown>);
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

const KNOWN_COLUMNS = new Set(Object.values(COLUMNS_BY_VERSION).flat());

/** Columns a row must carry for its cost to be meaningful; others default safely. */
const REQUIRED_COLUMNS = ['BilledCost', 'ChargePeriodStart'] as const;

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toIsoDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  // BigQuery returns TIMESTAMP as epoch seconds (possibly fractional) strings.
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?(E\d+)?$/i.test(v))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }
  const d = new Date(String(v).replace(' UTC', 'Z'));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function toStringValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

/**
 * A loose record from an export → a `RawSourceRow`. Only FOCUS columns are kept
 * (provider-specific `x_*` columns are dropped — Ratio adds its own). Columns a
 * real export leaves null (e.g. ResourceId on a tax line) become '' / 0 rather
 * than undefined, so the canonical upgrade never sees a hole. Returns null for a
 * record missing the columns that make a cost row meaningful.
 */
export function coerceFocusRecord(rec: Record<string, unknown>): RawSourceRow | null {
  for (const col of REQUIRED_COLUMNS) {
    if (rec[col] === undefined || rec[col] === null || rec[col] === '') return null;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (!KNOWN_COLUMNS.has(key)) continue;
    if (NUMERIC_COLUMNS.has(key)) out[key] = toNumber(value);
    else if (DATE_COLUMNS.has(key)) out[key] = toIsoDate(value);
    else if (NULLABLE_COLUMNS.has(key)) out[key] = value === '' || value == null ? null : toStringValue(value);
    else out[key] = toStringValue(value);
  }

  // Fill the v1.0 core so the row satisfies the type even when the export left
  // optional-in-practice columns out entirely.
  for (const col of COLUMNS_BY_VERSION['1.0']) {
    if (out[col] === undefined) out[col] = NUMERIC_COLUMNS.has(col) ? 0 : '';
  }
  if (!out.EffectiveCost) out.EffectiveCost = out.BilledCost;
  if (!out.BillingCurrency) out.BillingCurrency = 'USD';
  return out as unknown as RawSourceRow;
}

/** True when a row's charge period starts inside the half-open window. */
export function inWindow(row: RawSourceRow, window: CostWindow): boolean {
  const t = Date.parse(row.ChargePeriodStart);
  if (Number.isNaN(t)) return true; // unparseable — keep rather than silently drop cost
  return t >= Date.parse(window.start) && t < Date.parse(window.end);
}

/** Export text → coerced, window-filtered FOCUS rows. */
export function rowsFromExportText(text: string, window: CostWindow): RawSourceRow[] {
  return parseExportText(text)
    .map(coerceFocusRecord)
    .filter((r): r is RawSourceRow => r !== null && inWindow(r, window));
}

// --- object selection (bucket / container listings) ----------------------------

export interface ExportObject {
  key: string;
  lastModified: string; // ISO 8601 or RFC 1123
  size: number;
}

const DATA_FILE = /\.(csv|csv\.gz|gz|json|ndjson|jsonl)$/i;

function dirOf(key: string): string {
  const i = key.lastIndexOf('/');
  return i === -1 ? '' : key.slice(0, i);
}

/** Tokens a provider puts in the path of the month a window starts in. */
function monthTokens(window: CostWindow): string[] {
  const d = new Date(window.start);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  // AWS: BILLING_PERIOD=2026-10 · Azure: 20261001-20261031 · generic: 2026-10 / 202610
  return [`${y}-${m}`, `${y}${m}01`, `${y}${m}`];
}

/**
 * Pick the export files to read from a listing. Cloud FOCUS exports land as one
 * directory per run (with manifests alongside); re-runs overwrite a period in a
 * NEW directory. So: keep data files, prefer the ones whose path names the
 * window's month, then take every file in the most recently written directory.
 */
export function selectExportObjects(objects: ExportObject[], window: CostWindow): ExportObject[] {
  const data = objects.filter(
    (o) => DATA_FILE.test(o.key) && !/manifest/i.test(o.key) && o.size > 0,
  );
  if (data.length === 0) return [];

  const tokens = monthTokens(window);
  const forMonth = data.filter((o) => tokens.some((t) => o.key.includes(t)));
  const pool = forMonth.length > 0 ? forMonth : data;

  const latest = pool.reduce((a, b) => (Date.parse(b.lastModified) > Date.parse(a.lastModified) ? b : a));
  const dir = dirOf(latest.key);
  return pool.filter((o) => dirOf(o.key) === dir).sort((a, b) => a.key.localeCompare(b.key));
}

/** Upper bound on export files read per fetch — protects the route from a runaway listing. */
export const MAX_EXPORT_FILES = 50;

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
