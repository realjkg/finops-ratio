// M0b: credential redaction for original capture and the evidence record: by NAME
// anywhere in a key (key=value, JSON, headers, URL query, maps), by value pattern
// (PEM, Bearer/Basic, AWS key id, JWT, URL userinfo) and for long mixed-class
// opaque runs outside paths. Locators stay; pagination tokens become a sha256.
import { createHash } from 'crypto';

export const REDACTED = '[redacted]';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LOCATOR_RE = new RegExp(`^(?:[0-9a-f]{64}|sha256:[0-9a-f]{64}|${UUID}|connector-originals/${UUID}/${UUID}/[0-9a-f]{64})$`);
const SECRET_RE = /secret|token|passw(?:or)?d|pwd|api_?key|(?:access|account|private|session|shared|subscription|signing|client|master|storage|encryption)_?key|authori[sz]ation|signature|assertion|credential|cookie|(?:^|_)(?:sig|sas|auth)(?:_|$)|^(?:auth_|device_|user_)?code$/;
const PAGINATION_RE = /^(?:(?:next|page|continuation|skip|resume|sync)_?(?:page_)?token|(?:next_)?(?:cursor|marker)|continuation)$/;
const REFERENCE_RE = /_(?:ref|refs|name|names|id|ids|url|uri|endpoint|path|type|kind|count|scope|scopes|expiry|expires|expiration)$/;
const PARAM_MAP_RE = /^(?:params|filters|headers|query)$/;

/** From the name alone. In a request-parameter map a bare `key` is an API key. */
export function classifyName(name: string, inParams = false): 'secret' | 'pagination' | 'keep' {
  const n = name.replace(/^\$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[-.\s]+/g, '_');
  if (PAGINATION_RE.test(n)) return 'pagination';
  if (REFERENCE_RE.test(n)) return 'keep';
  return SECRET_RE.test(n) || (inParams && n === 'key') ? 'secret' : 'keep';
}

export const hashValue = (v: string) => (/^sha256:[0-9a-f]{64}$/.test(v) ? v : `sha256:${createHash('sha256').update(v).digest('hex')}`);

// Every pattern is anchored by a lookbehind or a literal and bounded, so redaction stays linear on hostile input.
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]{0,64}-----[\s\S]*?(?:-----END [A-Z ]{0,64}-----|$)/g, REDACTED],
  [/\b(?:Bearer|Basic)\s{1,8}[A-Za-z0-9._~+/=-]{8,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.?[\w-]*/g, REDACTED],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]{1,256}@/gi, `$1${REDACTED}@`],
];
const KV = /(?<![\w.$-])(["']?)([A-Za-z$][\w.$-]{0,63})\1(\s{0,16}[=:]\s{0,16})(["']?)/g;
const VALUE = /(?:(?:Digest|SharedKey|Token|AWS4-HMAC-SHA256)\s+)?[^\s&;,"'<>)}\]]*/y;
const LINE = /[^\r\n]*/y; // a whole Authorization or Cookie header value
const QUOTED: Record<string, RegExp> = { '"': /(?:\\[\s\S]|[^"\\]){0,8192}/y, "'": /(?:\\[\s\S]|[^'\\]){0,8192}/y };
// 40+ chars, no '.' and not touching '/' or '.': a path, file name or host is never a candidate.
const RUN = /(^|[^A-Za-z0-9+/=_.-])([A-Za-z0-9+/=_-]{40,})(?![A-Za-z0-9+/=_.-])/g;
const WORDLIKE = /^(?:[a-z0-9]+(?:[-_=][a-z0-9]+)*|[A-Z][a-z]+)$/;
const opaque = (r: string) => /[A-Z]/.test(r) && /[a-z]/.test(r) && /\d/.test(r) && !/^[0-9a-fA-F]+$/.test(r) && !r.split('/').some((seg) => WORDLIKE.test(seg) || LOCATOR_RE.test(seg));

/** Name-based redaction of key=value / "key":"value" / Header: value pairs. */
function redactPairs(s: string, count: { n: number }): string {
  let out = '';
  let last = 0;
  KV.lastIndex = 0;
  for (let m = KV.exec(s); m; m = KV.exec(s)) {
    const kind = classifyName(m[2]);
    const start = m.index + m[0].length;
    if (kind === 'keep' || s.startsWith(REDACTED, start)) continue;
    const re = m[4] ? QUOTED[m[4]] : /authori[sz]ation|cookie/i.test(m[2]) && m[3].includes(':') ? LINE : VALUE;
    re.lastIndex = start;
    const v = re.exec(s)?.[0] ?? '';
    if (v === '' || (kind === 'pagination' && hashValue(v) === v)) continue;
    count.n += 1;
    out += s.slice(last, start) + (kind === 'secret' ? REDACTED : hashValue(v));
    last = start + v.length;
    KV.lastIndex = last;
  }
  return out + s.slice(last);
}

export function redactString(s: string, count: { n: number }, locator = false): string {
  let out = s;
  for (const [re, to] of VALUE_PATTERNS) out = out.replace(re, (...a) => ((count.n += 1), to.replace('$1', String(a[1]))));
  out = redactPairs(out, count);
  return locator ? out : out.replace(RUN, (all, p: string, r: string) => (opaque(r) ? ((count.n += 1), `${p}${REDACTED}`) : all));
}

interface Ctx { locator?: boolean; inParams?: boolean; isParams?: boolean }

/** Deep redaction; `name` is the key the value sits under. Originals are locators (no opaque-run rule). */
export function redactDeep<T>(v: T, count: { n: number }, ctx: Ctx = {}, name?: string): T {
  if (typeof v === 'string') {
    const kind = name === undefined ? 'keep' : classifyName(name, ctx.inParams);
    if (kind === 'keep' || v === '' || v === REDACTED || hashValue(v) === v) return redactString(v, count, ctx.locator) as T;
    count.n += 1;
    return (kind === 'secret' ? REDACTED : hashValue(v)) as T;
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, count, ctx, name)) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, count, { locator: ctx.locator || k === 'originals', inParams: ctx.isParams, isParams: PARAM_MAP_RE.test(k) }, k)])) as T;
  }
  return v;
}
