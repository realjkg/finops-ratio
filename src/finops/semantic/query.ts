// Typed, bounded ViewQuery validator (S1). One request shape for every consumer: the report route, the
// future AI tool registry and A2A. No SQL text and no URL is ever accepted: views, measures, group-bys
// and filter keys come from the registry allowlists, and each filter value is re-shaped by a strict
// pattern (S2 binds them only as parameters). Error messages are FIXED strings that never echo input.
// The tenant and the business-unit reach come from `Scope`, which the authorization layer (R2) produces;
// the caller can never name a tenant, and a BU-scoped caller is rejected (never silently narrowed) when
// it asks for another BU, the unallocated line or a tenant-wide view.
import { DIMENSIONS, VIEWS, VIEW_IDS, type Dimension, type ViewId } from './views';

export const DEFAULT_LIMIT = 100, MAX_LIMIT = 500, MAX_GROUP_BY = 3, MAX_MEASURES = 8, MAX_FILTER_VALUES = 10, MAX_RANGE_MONTHS = 12, MAX_CURSOR_CHARS = 512;

/** Produced by the authorization layer, never by the caller. wildcard: every business unit of the tenant. */
export interface Scope { tenantId: string; wildcard: boolean; businessUnits: readonly string[]; teams: readonly string[] }

/** period is 'YYYY-MM' inclusive; businessUnits is the BU predicate the executor applies server-side. */
export interface ValidViewQuery {
  tenantId: string; view: ViewId; period: { from: string; to: string }; measures: string[]; groupBy: Dimension[];
  filters: Partial<Record<Dimension, string[]>>; limit: number; cursor: { view: ViewId; after: string[] } | null; businessUnits: '*' | string[];
}
export type ViewQueryResult = { ok: true; value: ValidViewQuery } | { ok: false; message: string };

export const VIEW_QUERY_MESSAGES = {
  shape: 'query must be a plain object with only these keys: view, period, measures, groupBy, filters, limit, cursor',
  view: 'view is not a known view',
  period: `period must be YYYY-MM or {from, to} between 2000-01 and 9999-12, from not after to, at most ${MAX_RANGE_MONTHS} months`,
  measures: `measures must list 1 to ${MAX_MEASURES} distinct measures of the view`,
  groupBy: `groupBy must list at most ${MAX_GROUP_BY} distinct dimensions of the view`,
  filters: `filters may only name dimensions of the view, each with one value or 1 to ${MAX_FILTER_VALUES} values`,
  filterValue: 'a filter value is not allowed',
  limit: `limit must be an integer from 1 to ${MAX_LIMIT}`,
  cursor: 'cursor is not valid',
  scope: 'scope is not valid',
  scopeView: 'this view needs tenant-wide scope',
  scopeBusinessUnit: 'a business unit or the unallocated line outside the caller scope was requested',
} as const;
const M = VIEW_QUERY_MESSAGES;

const TOP_KEYS = new Set(['view', 'period', 'measures', 'groupBy', 'filters', 'limit', 'cursor']);
const VIEW_SET = new Set<string>(VIEW_IDS);
const MONTH_RE = /^([2-9]\d{3})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const SQL_RE = /--|\b(select|insert|update|delete|drop|union|alter|create|exec|execute|truncate|grant|revoke|merge|call)\b/i;
const CURSOR_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const isToken = (v: string) => TOKEN_RE.test(v) && !SQL_RE.test(v);
const VALUE: Record<(typeof DIMENSIONS)[Dimension], (v: string) => boolean> = {
  month: (v) => MONTH_RE.test(v), currency: (v) => /^[A-Z]{3}$/.test(v), uuid: (v) => UUID_RE.test(v), identity: (v) => /^I[1-8]$/.test(v), token: isToken,
  basis: (v) => v === 'billed' || v === 'effective', chargeCategory: (v) => ['Usage', 'Purchase', 'Tax', 'Credit', 'Adjustment'].includes(v),
  status: (v) => ['reconciled', 'unreconciled', 'not_reconcilable', 'not_applicable'].includes(v),
};

const fail = (message: string): ViewQueryResult => ({ ok: false, message });
const isPlain = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const strings = (x: unknown, max: number): x is string[] => Array.isArray(x) && x.length <= max && x.every((s) => typeof s === 'string');
const monthIndex = (m: string) => parseInt(m.slice(0, 4), 10) * 12 + parseInt(m.slice(5), 10);

function validScope(s: unknown): s is Scope {
  if (!isPlain(s) || typeof s.tenantId !== 'string' || !UUID_RE.test(s.tenantId) || typeof s.wildcard !== 'boolean') return false;
  if (!strings(s.businessUnits, 1000) || !strings(s.teams, 1000) || ![...s.businessUnits, ...s.teams].every(isToken)) return false;
  return !(s.wildcard && s.businessUnits.length > 0); // wildcard and a list together are ambiguous
}

function period(p: unknown): { from: string; to: string } | null {
  if (isPlain(p) && Object.keys(p).length !== 2) return null;
  const [from, to] = isPlain(p) ? [p.from, p.to] : [p, p];
  if (typeof from !== 'string' || typeof to !== 'string' || !MONTH_RE.test(from) || !MONTH_RE.test(to)) return null;
  const span = monthIndex(to) - monthIndex(from);
  return span >= 0 && span < MAX_RANGE_MONTHS ? { from, to } : null;
}

export function encodeViewCursor(view: ViewId, after: readonly string[]): string {
  return btoa(JSON.stringify([view, ...after])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCursor(c: unknown, view: ViewId): ValidViewQuery['cursor'] {
  if (typeof c !== 'string' || c.length === 0 || c.length > MAX_CURSOR_CHARS || !B64URL_RE.test(c)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
  if (!strings(parsed, 5) || parsed.length < 2 || parsed[0] !== view || !parsed.slice(1).every((x) => CURSOR_PART_RE.test(x))) return null;
  return { view, after: parsed.slice(1) };
}

export function validateViewQuery(input: unknown, scope: Scope): ViewQueryResult {
  if (!validScope(scope)) return fail(M.scope);
  if (!isPlain(input)) return fail(M.shape);
  const keys = Object.keys(input);
  if (keys.length > TOP_KEYS.size || !keys.every((k) => TOP_KEYS.has(k))) return fail(M.shape);
  const q = input;
  if (typeof q.view !== 'string' || q.view.length > 64 || !VIEW_SET.has(q.view)) return fail(M.view);
  const [view, buScoped] = [q.view as ViewId, !scope.wildcard];
  const def = VIEWS[view];
  if (buScoped && (def.scopeLevel === 'tenant' || scope.businessUnits.length === 0)) return fail(M.scopeView);
  const p = period(q.period);
  if (!p) return fail(M.period);
  const measures = q.measures;
  if (!strings(measures, MAX_MEASURES) || measures.length === 0 || new Set(measures).size !== measures.length || !measures.every((m) => def.measures.includes(m))) return fail(M.measures);
  if (buScoped && measures.some((m) => m.startsWith('unallocated'))) return fail(M.scopeBusinessUnit);
  const groupBy = q.groupBy ?? [];
  if (!strings(groupBy, MAX_GROUP_BY) || new Set(groupBy).size !== groupBy.length || !groupBy.every((d) => (def.dimensions as readonly string[]).includes(d))) return fail(M.groupBy);
  const [filters, rawFilters]: [ValidViewQuery['filters'], unknown] = [{}, q.filters ?? {}];
  if (!isPlain(rawFilters) || Object.keys(rawFilters).length > def.dimensions.length) return fail(M.filters);
  for (const k of Object.keys(rawFilters)) {
    if (!(def.dimensions as readonly string[]).includes(k)) return fail(M.filters);
    const raw = rawFilters[k];
    const values = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_FILTER_VALUES) return fail(M.filters);
    const check = VALUE[DIMENSIONS[k as Dimension]];
    if (!values.every((v) => typeof v === 'string' && v.length <= 64 && check(v))) return fail(M.filterValue);
    filters[k as Dimension] = [...new Set(values as string[])];
  }
  const bu = filters.businessUnit;
  if (buScoped && bu && !bu.every((b) => b !== 'unallocated' && scope.businessUnits.includes(b))) return fail(M.scopeBusinessUnit);
  const limit = q.limit ?? DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(M.limit);
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor, view);
  if (q.cursor !== undefined && !cursor) return fail(M.cursor);
  const businessUnits = buScoped ? [...(bu ?? scope.businessUnits)] : '*';
  return { ok: true, value: { tenantId: scope.tenantId, view, period: p, measures: [...measures], groupBy: [...groupBy] as Dimension[], filters, limit, cursor, businessUnits } };
}
