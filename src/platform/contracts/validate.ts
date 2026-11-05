// Pure validators for the platform contracts (docs/adr/ADR-0001). No I/O, clock, network, dynamic code or float:
// amounts and token counts are exact decimal strings. A problem names the key path and the rule, never the value,
// so a rejected record cannot echo an identifier or content into a log. Objects are strict: an unknown key is a
// problem, which keeps raw prompt or response text from riding along in a contract that has no field for it.
import { isDecimal, isZeroDecimal, subDecimal, sumDecimal } from '../../finops/semantic/decimal';

export type Problems = string[];
/** A check carries `desc`, a canonical description of what it accepts; the schema pin test hashes it. */
export type Check = ((v: unknown, at: string, p: Problems) => void) & { readonly desc: string };
export interface Field { check: Check; optional: boolean }
export type Result<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const mk = (desc: string, fn: (v: unknown, at: string, p: Problems) => void): Check => Object.assign(fn, { desc });
export const req = (check: Check): Field => ({ check, optional: false });
export const opt = (check: Check): Field => ({ check, optional: true });
export const rule = (what: string, ok: (v: unknown) => boolean): Check => mk(what, (v, at, p) => { if (!ok(v)) p.push(`${at}: ${what}`); });
export const oneOf = <T extends string>(xs: readonly T[]): Check => rule(`one of ${xs.join('|')}`, (v) => typeof v === 'string' && (xs as readonly string[]).includes(v));
export const literal = (x: string): Check => rule(`equals ${x}`, (v) => v === x);

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

export const arr = (item: Check, min = 0, max = 10000): Check =>
  mk(`[${item.desc}]{${min},${max}}`, (v, at, p) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) return void p.push(`${at}: array of ${min} to ${max} items`);
    v.forEach((x, i) => item(x, `${at}[${i}]`, p));
  });

/** A discriminated union on `kind`; each variant is a strict object whose `kind` is fixed. */
export const byKind = (variants: Record<string, Record<string, Field>>): Check => {
  const checks = Object.fromEntries(Object.entries(variants).map(([k, s]) => [k, obj({ kind: req(literal(k)), ...s })]));
  return mk(Object.keys(checks).sort().map((k) => `${k}${checks[k].desc}`).join('|'), (v, at, p) => {
    const kind = isRecord(v) && typeof v.kind === 'string' && Object.prototype.hasOwnProperty.call(checks, v.kind) ? v.kind : null;
    if (kind === null) return void p.push(`${at}.kind: one of ${Object.keys(checks).join('|')}`);
    checks[kind](v, at, p);
  });
};

/** A validator: the strict shape first, then the cross-field rules only on a well-shaped value. */
export const validator = <T>(check: Check, rules?: (v: T, p: Problems) => void) => Object.assign(
  (v: unknown): Result<T> => {
    const p: Problems = [];
    check(v, '$', p);
    if (p.length === 0 && rules) rules(v as T, p);
    return p.length ? { ok: false, problems: p } : { ok: true, value: v as T };
  },
  { desc: check.desc },
);

// ---- primitives -------------------------------------------------------------------------------------------------
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const validYmd = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const ymd = (s: string) => validYmd(parseInt(s.slice(0, 4), 10), parseInt(s.slice(5, 7), 10), parseInt(s.slice(8, 10), 10));
/** A calendar date, YYYY-MM-DD (UTC calendar; Feb 29 only in leap years). */
export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(v);
/** An instant in UTC: YYYY-MM-DDTHH:MM:SS[.fraction]Z. Offsets other than Z, leap seconds and 24:00 are refused. */
export const isIsoInstant = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$/.test(v) && ymd(v);
/** A signed exact decimal string (money). */
export const isMoney = (v: unknown): v is string => isDecimal(v);
/** A non-negative exact decimal string (token counts, units, prices). */
export const isQuantity = (v: unknown): v is string => isDecimal(v) && !v.startsWith('-');
export const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** Opaque identifiers: no spaces, no control characters, bounded. */
export const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,191}$/.test(v);
export const isReasonCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v);
export const isSha256Hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/** Human actor: keyed HMAC-SHA256 under the tenant's pseudonymization key `keyId` (rotation = new keyId). */
export const isPseudonymousRef = (v: unknown): v is string => typeof v === 'string' && /^ps1:[a-z0-9-]{1,32}:[0-9a-f]{64}$/.test(v);
/** Content digest: keyed HMAC-SHA256 (a plain hash of a short prompt can be reversed by guessing). */
export const isContentDigest = (v: unknown): v is string => typeof v === 'string' && /^hm1:[a-z0-9-]{1,32}:[0-9a-f]{64}$/.test(v);
export const isDuration = (v: unknown): v is string => typeof v === 'string' && /^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/.test(v);

export const C = {
  date: rule('ISO date YYYY-MM-DD', isIsoDate),
  instant: rule('UTC instant ending in Z', isIsoInstant),
  money: rule('exact decimal string', isMoney),
  quantity: rule('non-negative exact decimal string', isQuantity),
  count: rule('non-negative safe integer', isCount),
  positive: rule('positive safe integer', (v) => isCount(v) && v > 0),
  id: rule('identifier', isId),
  reason: rule('reason code', isReasonCode),
  sha256: rule('sha256 hex', isSha256Hex),
  digest: rule('keyed content digest hm1:<keyId>:<hex>', isContentDigest),
  currency: rule('ISO 4217 code', (v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v)),
  duration: rule('ISO 8601 duration', isDuration),
  bool: rule('boolean', (v) => typeof v === 'boolean'),
};

/** Actor references by type: humans only as pseudonyms; services and agents by registered id; unknown has none. */
export const ACTOR_TYPES = ['human', 'service', 'agent', 'unknown'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export function checkActor(actorType: ActorType, actorRef: string | undefined, p: Problems): void {
  const ok = actorType === 'human' ? isPseudonymousRef(actorRef)
    : actorType === 'service' ? typeof actorRef === 'string' && /^svc:[A-Za-z0-9._-]{1,128}$/.test(actorRef)
    : actorType === 'agent' ? typeof actorRef === 'string' && /^agt:[A-Za-z0-9._-]{1,128}$/.test(actorRef)
    : actorRef === undefined;
  if (!ok) p.push(`$.actorRef: does not match actorType ${actorType}`);
}

export { isZeroDecimal };
/** Exact: sum(parts) + rest === total, all in one currency (the caller guarantees one currency). */
export const sumsExactly = (parts: readonly string[], rest: string, total: string) => isZeroDecimal(subDecimal(sumDecimal([...parts, rest]), total));
