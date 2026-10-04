// Strict query validation for GET /api/v1/costs/published. Pure (no pg).
//
// Every accepted value is re-shaped into a typed, regex-checked value before
// it reaches SQL (where it is still only ever a bound parameter). Error
// messages are FIXED strings: caller input is never echoed.

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const MAX_CURSOR_CHARS = 512;

/** The keyset position: the last row of the previous page. */
export interface Cursor {
  billingPeriod: string; // 'YYYY-MM-01'
  sourceId: string; // canonical uuid
  artifactSha256: string; // 64 lower-case hex
  rowOrdinal: string; // non-negative bigint, decimal digits
}

export interface PublishedCostsQuery {
  /** Inclusive lower bound, 'YYYY-MM-01', or null. */
  from: string | null;
  /** Inclusive upper bound, 'YYYY-MM-01', or null. */
  to: string | null;
  limit: number;
  cursor: Cursor | null;
}

export type ParseResult = { ok: true; value: PublishedCostsQuery } | { ok: false; message: string };

export const QUERY_MESSAGES = {
  unknownParam: 'Unknown query parameter (allowed: period, from, to, limit, cursor)',
  repeatedParam: 'Each query parameter may be given at most once',
  period: 'period, from and to must be YYYY-MM between 2000-01 and 9999-12',
  periodCombination: 'Use either period or from/to, not both',
  range: 'from must not be after to',
  limit: `limit must be an integer from 1 to ${MAX_LIMIT}`,
  cursor: 'cursor is not valid',
} as const;

const ALLOWED = new Set(['period', 'from', 'to', 'limit', 'cursor']);
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const PERIOD_DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-01$/;
const LIMIT_RE = /^[1-9][0-9]{0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ORDINAL_RE = /^(0|[1-9][0-9]{0,18})$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BIGINT = BigInt('9223372036854775807');

const yearInRange = (y: string) => {
  const n = Number(y);
  return n >= 2000 && n <= 9999;
};

/** 'YYYY-MM' → 'YYYY-MM-01', or null. */
function month(value: string): string | null {
  const m = MONTH_RE.exec(value);
  if (!m || !yearInRange(m[1])) return null;
  return `${m[1]}-${m[2]}-01`;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.billingPeriod, c.sourceId, c.artifactSha256, c.rowOrdinal]), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): Cursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_CHARS || !BASE64URL_RE.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every((x) => typeof x === 'string')) return null;
  const [billingPeriod, sourceId, artifactSha256, rowOrdinal] = parsed as string[];
  const p = PERIOD_DATE_RE.exec(billingPeriod);
  if (!p || !yearInRange(p[1])) return null;
  if (!UUID_RE.test(sourceId) || !SHA256_RE.test(artifactSha256)) return null;
  if (!ORDINAL_RE.test(rowOrdinal) || BigInt(rowOrdinal) > MAX_BIGINT) return null;
  return { billingPeriod, sourceId, artifactSha256, rowOrdinal };
}

const fail = (message: string): ParseResult => ({ ok: false, message });

/** Validates a Next.js `req.query`. Only OWN enumerable keys are consulted. */
export function parsePublishedCostsQuery(query: Record<string, string | string[] | undefined>): ParseResult {
  const values: Record<string, string> = {};
  for (const key of Object.keys(query ?? {})) {
    const raw = query[key];
    if (raw === undefined) continue;
    if (!ALLOWED.has(key)) return fail(QUERY_MESSAGES.unknownParam);
    if (typeof raw !== 'string') return fail(QUERY_MESSAGES.repeatedParam);
    values[key] = raw;
  }

  let from: string | null = null;
  let to: string | null = null;
  if (values.period !== undefined) {
    if (values.from !== undefined || values.to !== undefined) return fail(QUERY_MESSAGES.periodCombination);
    const p = month(values.period);
    if (!p) return fail(QUERY_MESSAGES.period);
    from = p;
    to = p;
  } else {
    if (values.from !== undefined) {
      from = month(values.from);
      if (!from) return fail(QUERY_MESSAGES.period);
    }
    if (values.to !== undefined) {
      to = month(values.to);
      if (!to) return fail(QUERY_MESSAGES.period);
    }
    if (from && to && from > to) return fail(QUERY_MESSAGES.range);
  }

  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    if (!LIMIT_RE.test(values.limit)) return fail(QUERY_MESSAGES.limit);
    limit = Number(values.limit);
    if (limit < 1 || limit > MAX_LIMIT) return fail(QUERY_MESSAGES.limit);
  }

  let cursor: Cursor | null = null;
  if (values.cursor !== undefined) {
    cursor = decodeCursor(values.cursor);
    if (!cursor) return fail(QUERY_MESSAGES.cursor);
  }

  return { ok: true, value: { from, to, limit, cursor } };
}
