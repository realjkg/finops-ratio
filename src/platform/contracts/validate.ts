// Pure validators for the platform contracts (docs/adr/ADR-0001). No I/O, clock, network, dynamic code or float:
// amounts and token counts are exact, canonical decimal strings. A problem names the key path and the rule, never the
// value, so a rejected record cannot echo an identifier or content into a log. Objects are strict: an unknown key is a
// problem, which keeps raw prompt or response text from riding along in a contract that has no field for it.
import { isZeroDecimal, subDecimal, sumDecimal } from '../../finops/semantic/decimal';
import { ISO_4217 } from './iso4217';

export type Problems = string[];
/** Marker carried by every check; check:bundle refuses it in client files. */
export const CONTRACTS_ORIGIN = 'ratio-platform-contracts';
/**
 * `desc` is the canonical description the schema pin hashes: structure, enums and rule ids (`name@version`). Problem
 * text is not part of it, so rewording a label needs no new schema version; changing what a rule accepts needs a new
 * rule version AND changes the golden corpus result (schemaPin.test.ts).
 */
export type Check = ((v: unknown, at: string, p: Problems) => void) & { readonly desc: string; readonly origin: string };
export interface Field { check: Check; optional: boolean }
export type Result<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const mk = (desc: string, fn: (v: unknown, at: string, p: Problems) => void): Check => Object.assign(fn, { desc, origin: CONTRACTS_ORIGIN });
export const req = (check: Check): Field => ({ check, optional: false });
export const opt = (check: Check): Field => ({ check, optional: true });
export const rule = (id: string, what: string, ok: (v: unknown) => boolean): Check => mk(id, (v, at, p) => { if (!ok(v)) p.push(`${at}: ${what}`); });
export const oneOf = <T extends string>(xs: readonly T[]): Check => rule(`oneOf:${xs.join('|')}`, `one of ${xs.join('|')}`, (v) => typeof v === 'string' && (xs as readonly string[]).includes(v));
export const literal = (x: string): Check => rule(`eq:${x}`, `equals ${x}`, (v) => v === x);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const PRINTABLE_KEY = /^[A-Za-z0-9_]{1,64}$/;

export const obj = (shape: Record<string, Field>): Check =>
  mk(`{${Object.keys(shape).sort().map((k) => `${k}${shape[k].optional ? '?' : ''}:${shape[k].check.desc}`).join(',')}}`, (v, at, p) => {
    if (!isRecord(v)) return void p.push(`${at}: object`);
    for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(shape, k)) p.push(PRINTABLE_KEY.test(k) ? `${at}.${k}: unknown key` : `${at}: unknown key (not printed)`);
    for (const [k, f] of Object.entries(shape)) {
      if (v[k] === undefined) { if (!f.optional) p.push(`${at}.${k}: missing`); } else f.check(v[k], `${at}.${k}`, p);
    }
  });

/** An array; `unique` refuses repeated items (compared by their JSON form). */
export const arr = (item: Check, min = 0, max = 10000, unique = false): Check =>
  mk(`[${item.desc}]{${min},${max}}${unique ? 'unique' : ''}`, (v, at, p) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) return void p.push(`${at}: array of ${min} to ${max} items`);
    v.forEach((x, i) => item(x, `${at}[${i}]`, p));
    if (unique && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) p.push(`${at}: duplicate items`);
  });
export const set = (item: Check, min = 0, max = 10000) => arr(item, min, max, true);

/** A discriminated union on `kind`; each variant is a strict object whose `kind` is fixed. */
export const byKind = (variants: Record<string, Record<string, Field>>): Check => {
  const checks = Object.fromEntries(Object.entries(variants).map(([k, s]) => [k, obj({ kind: req(literal(k)), ...s })]));
  return mk(Object.keys(checks).sort().map((k) => `${k}${checks[k].desc}`).join('|'), (v, at, p) => {
    const kind = isRecord(v) && typeof v.kind === 'string' && Object.prototype.hasOwnProperty.call(checks, v.kind) ? v.kind : null;
    if (kind === null) return void p.push(`${at}.kind: one of ${Object.keys(checks).join('|')}`);
    checks[kind](v, at, p);
  });
};

/** A validator: the strict shape first, then every named cross-field rule (`name@version`) on a well-shaped value. */
export const validator = <T>(check: Check, rules: Record<string, (v: T, p: Problems) => void> = {}) => Object.assign(
  (v: unknown): Result<T> => {
    const p: Problems = [];
    check(v, '$', p);
    if (p.length === 0) for (const r of Object.values(rules)) r(v as T, p);
    return p.length ? { ok: false, problems: p } : { ok: true, value: v as T };
  },
  { desc: `${check.desc}#${Object.keys(rules).sort().join(',')}`, origin: CONTRACTS_ORIGIN },
);

// ---- primitives -------------------------------------------------------------------------------------------------
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const validYmd = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const ymd = (s: string) => validYmd(parseInt(s.slice(0, 4), 10), parseInt(s.slice(5, 7), 10), parseInt(s.slice(8, 10), 10));
/** A calendar date, YYYY-MM-DD (UTC calendar; Feb 29 only in leap years). Dates compare as strings. */
export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(v);
/** An instant in UTC: YYYY-MM-DDTHH:MM:SS[.fraction]Z. Offsets other than Z, leap seconds and 24:00 are refused. */
export const isIsoInstant = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$/.test(v) && ymd(v);
/** Sortable key of a valid instant (fraction padded to nanoseconds), so '…:00.75Z' sorts after '…:00.5Z'. */
const instantKey = (s: string) => s.slice(0, 19) + (s.length > 20 ? s.slice(20, -1) : '').padEnd(9, '0');
export const instantBefore = (a: string, b: string) => instantKey(a) < instantKey(b);

const CANONICAL_DECIMAL = /^-?(0|[1-9]\d{0,39})(\.\d{1,40})?$/;
/** Canonical signed decimal string: no '+', no leading zeros, no exponent or grouping, never negative zero. */
export const isMoney = (v: unknown): v is string => typeof v === 'string' && CANONICAL_DECIMAL.test(v) && !(v.startsWith('-') && isZeroDecimal(v));
/** Canonical non-negative decimal string (unit quantities, prices). */
export const isQuantity = (v: unknown): v is string => isMoney(v) && !v.startsWith('-');
/** Canonical non-negative integer string (token counts are whole tokens). */
export const isTokenCount = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v);
export const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** Opaque identifiers: no spaces, no control characters, no '@' (so no email address can be an id), bounded. */
export const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(v);
/** Model ids may carry an '@' revision (e.g. `model@20260901`) but never an email-shaped value. */
export const isModelId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$/.test(v) && !/@[^@]*\.[A-Za-z]{2,}$/.test(v) && v.split('@').length <= 2;
export const isReasonCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v);
export const isSha256Hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/** Human actor: keyed HMAC-SHA256 under the tenant's pseudonymization key `keyId` (rotation = new keyId). */
export const isPseudonymousRef = (v: unknown): v is string => typeof v === 'string' && /^ps1:[a-z0-9-]{1,32}:[0-9a-f]{64}$/.test(v);
/** Content digest: keyed HMAC-SHA256 (a plain hash of a short prompt can be reversed by guessing). */
export const isContentDigest = (v: unknown): v is string => typeof v === 'string' && /^hm1:[a-z0-9-]{1,32}:[0-9a-f]{64}$/.test(v);
export const isServiceRef = (v: unknown): v is string => typeof v === 'string' && /^svc:[A-Za-z0-9._-]{1,128}$/.test(v);
export const isAgentRef = (v: unknown): v is string => typeof v === 'string' && /^agt:[A-Za-z0-9._-]{1,128}$/.test(v);
/** A positive ISO 8601 duration (at least one non-zero component). */
export const isDuration = (v: unknown): v is string => typeof v === 'string' && /^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/.test(v) && /[1-9]/.test(v);

export const C = {
  date: rule('date@1', 'ISO date YYYY-MM-DD', isIsoDate),
  instant: rule('instant@1', 'UTC instant ending in Z', isIsoInstant),
  money: rule('money@2', 'canonical decimal string', isMoney),
  quantity: rule('quantity@2', 'canonical non-negative decimal string', isQuantity),
  tokens: rule('tokens@1', 'canonical non-negative integer string', isTokenCount),
  count: rule('count@1', 'non-negative safe integer', isCount),
  positive: rule('positive@1', 'positive safe integer', (v) => isCount(v) && v > 0),
  id: rule('id@2', 'identifier', isId),
  model: rule('model@1', 'model identifier', isModelId),
  reason: rule('reason@1', 'reason code', isReasonCode),
  sha256: rule('sha256@1', 'sha256 hex', isSha256Hex),
  digest: rule('digest@1', 'keyed content digest hm1:<keyId>:<hex>', isContentDigest),
  currency: rule('currency@2', 'ISO 4217 currency code', (v) => typeof v === 'string' && ISO_4217.has(v)),
  duration: rule('duration@2', 'positive ISO 8601 duration', isDuration),
  bool: rule('bool@1', 'boolean', (v) => typeof v === 'boolean'),
};

/** Actor references by type: humans only as pseudonyms; services and agents by registered id; unknown has none. */
export const ACTOR_TYPES = ['human', 'service', 'agent', 'unknown'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export function checkActor(actorType: ActorType, actorRef: string | undefined, p: Problems): void {
  const ok = actorType === 'human' ? isPseudonymousRef(actorRef)
    : actorType === 'service' ? isServiceRef(actorRef)
    : actorType === 'agent' ? isAgentRef(actorRef)
    : actorRef === undefined;
  if (!ok) p.push(`$.actorRef: does not match actorType ${actorType}`);
}

export { isZeroDecimal };
/** Exact: sum(parts) + rest === total, all in one currency (the caller guarantees one currency). */
export const sumsExactly = (parts: readonly string[], rest: string, total: string) => isZeroDecimal(subDecimal(sumDecimal([...parts, rest]), total));
/** Same sign as `of`, or zero. */
export const sameSignOrZero = (x: string, of: string) => isZeroDecimal(x) || x.startsWith('-') === of.startsWith('-');
