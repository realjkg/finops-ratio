// Alert event model and strict validation (RFQ checklist item 2.5, src/notify/).
//
// TRUST BOUNDARY: everything handed to parseAlertEvent is untrusted, even when
// it comes from Ratio's own detection code, because titles, bodies and resource
// labels can carry customer-controlled text (resource names, tags). The parser
// is deny-by-default: unknown fields, wrong types, over-cap values and malformed
// identifiers are refused with a FIXED code and message that never echoes the
// input. Free text is normalized (NFC), stripped of control, bidi and invisible
// format characters, and measured AFTER stripping, so a channel never renders a
// forged line, a hidden mention or a reordered string.
//
// This module is pure: no I/O, no clock, no randomness.

export type Severity = 'info' | 'warning' | 'critical';
export const SEVERITIES: readonly Severity[] = Object.freeze(['info', 'warning', 'critical'] as const);

/** Hard caps. A value one past a cap is refused (never silently truncated). */
export const ALERT_LIMITS = Object.freeze({
  tenantChars: 64,
  dedupeKeyChars: 200,
  titleChars: 200,
  bodyChars: 4000,
  resources: 20,
  resourceKindChars: 32,
  resourceIdChars: 200,
  resourceLabelChars: 100,
  links: 5,
  linkLabelChars: 80,
  linkUrlChars: 2048,
});

export interface ResourceRef {
  /** Lower-case token such as `workload`, `account`, `cluster`. */
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
}

export interface AlertLink {
  readonly label: string;
  /** Absolute https URL, no userinfo. Rendered, never fetched by this module. */
  readonly url: string;
}

export interface AlertEvent {
  readonly tenant: string;
  /** Stable producer-defined key; the dispatcher suppresses repeats of it. */
  readonly dedupeKey: string;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  /** Normalized ISO 8601 UTC instant (`toISOString()` form). */
  readonly occurredAt: string;
  readonly resources: readonly ResourceRef[];
  readonly links: readonly AlertLink[];
}

export type AlertEventErrorCode =
  | 'malformed'
  | 'unknown_field'
  | 'tenant_invalid'
  | 'dedupe_key_invalid'
  | 'severity_invalid'
  | 'title_invalid'
  | 'title_too_long'
  | 'body_invalid'
  | 'body_too_long'
  | 'occurred_at_invalid'
  | 'resources_invalid'
  | 'too_many_resources'
  | 'resource_invalid'
  | 'links_invalid'
  | 'too_many_links'
  | 'link_invalid';

/** Fixed, input-free text for each code. */
export const ALERT_EVENT_ERROR_TEXT: Readonly<Record<AlertEventErrorCode, string>> = Object.freeze({
  malformed: 'alert event is malformed',
  unknown_field: 'alert event has an unsupported field',
  tenant_invalid: 'alert event tenant is invalid',
  dedupe_key_invalid: 'alert event dedupe key is invalid',
  severity_invalid: 'alert event severity is invalid',
  title_invalid: 'alert event title is invalid',
  title_too_long: 'alert event title is too long',
  body_invalid: 'alert event body is invalid',
  body_too_long: 'alert event body is too long',
  occurred_at_invalid: 'alert event time is invalid',
  resources_invalid: 'alert event resources are invalid',
  too_many_resources: 'alert event has too many resources',
  resource_invalid: 'alert event resource is invalid',
  links_invalid: 'alert event links are invalid',
  too_many_links: 'alert event has too many links',
  link_invalid: 'alert event link is invalid',
});

export type AlertEventParse =
  | { readonly ok: true; readonly event: AlertEvent }
  | { readonly ok: false; readonly code: AlertEventErrorCode; readonly message: string };

// --- text normalization -------------------------------------------------------

/** Code points removed outright: invisible format characters used to forge or hide text. */
function isInvisibleFormat(cp: number): boolean {
  return (
    cp === 0x00ad || // soft hyphen
    cp === 0x061c || // Arabic letter mark
    cp === 0x180e || // Mongolian vowel separator
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners, LRM, RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embeddings and overrides
    (cp >= 0x2060 && cp <= 0x206f) || // word joiner, invisible operators, bidi isolates
    cp === 0xfeff || // BOM / zero-width no-break space
    (cp >= 0xfff9 && cp <= 0xfffb) || // interlinear annotation
    cp === 0xfffe ||
    cp === 0xffff ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) ||
    (cp >= 0xe0000 && cp <= 0xe007f) // tag characters (invisible text smuggling)
  );
}

/**
 * Normalize untrusted text: NFC, drop C0/C1 controls, DEL, lone surrogates and
 * invisible format characters; line breaks (CR, LF, CRLF, NEL, LS, PS, VT, FF)
 * become `\n` in multiline fields and a single space in single-line fields.
 * Tabs are kept in multiline fields and become a space otherwise. Runs of
 * blank space are collapsed and the result is trimmed.
 */
export function sanitizeText(input: string, multiline: boolean): string {
  const text = input.normalize('NFC');
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    let piece: string;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = text.codePointAt(i) as number;
        i += 1;
        if (isInvisibleFormat(cp)) continue;
        piece = String.fromCodePoint(cp);
      } else {
        continue; // lone high surrogate
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      continue; // lone low surrogate
    } else if (unit === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) i += 1;
      piece = multiline ? '\n' : ' ';
    } else if (unit === 0x0a || unit === 0x0b || unit === 0x0c || unit === 0x85 || unit === 0x2028 || unit === 0x2029) {
      piece = multiline ? '\n' : ' ';
    } else if (unit === 0x09) {
      piece = multiline ? '\t' : ' ';
    } else if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || isInvisibleFormat(unit)) {
      continue;
    } else {
      piece = text[i];
    }
    out += piece;
  }
  if (!multiline) return out.replace(/ {2,}/g, ' ').trim();
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- field validators ---------------------------------------------------------

const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEDUPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@=+-]{0,199}$/;
const KIND_RE = /^[a-z][a-z0-9_.-]{0,31}$/;
const OCCURRED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function isValidTenantId(v: unknown): v is string {
  return typeof v === 'string' && TENANT_RE.test(v);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function onlyKeys(rec: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(rec).every((k) => allowed.includes(k));
}

/** Raw text longer than this is refused before any processing (bounds work). */
function rawTooLong(s: string, cap: number): boolean {
  return s.length > cap * 4 + 64;
}

/** Normalized instant, or null. Round-trips the calendar so `02-30` is refused. */
function parseInstant(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 30) return null;
  const m = OCCURRED_RE.exec(v);
  if (!m) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  if (iso.slice(0, 19) !== v.slice(0, 19)) return null;
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) return null;
  return iso;
}

/** Validate a display link URL: https, ASCII, no userinfo, bounded. Never fetched here. */
export function normalizeLinkUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > ALERT_LIMITS.linkUrlChars) return null;
  if (/[^\x21-\x7e]/.test(v) || v.includes('\\')) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hostname === '') return null;
  const href = u.href;
  return href.length <= ALERT_LIMITS.linkUrlChars ? href : null;
}

const EVENT_KEYS = ['tenant', 'dedupeKey', 'severity', 'title', 'body', 'occurredAt', 'resources', 'links'] as const;

function fail(code: AlertEventErrorCode): AlertEventParse {
  return { ok: false, code, message: ALERT_EVENT_ERROR_TEXT[code] };
}

function parseResources(v: unknown): { ok: true; value: ResourceRef[] } | { ok: false; code: AlertEventErrorCode } {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, code: 'resources_invalid' };
  if (v.length > ALERT_LIMITS.resources) return { ok: false, code: 'too_many_resources' };
  const out: ResourceRef[] = [];
  for (let i = 0; i < v.length; i += 1) {
    const r: unknown = v[i];
    if (!isPlainRecord(r) || !onlyKeys(r, ['kind', 'id', 'label'])) return { ok: false, code: 'resource_invalid' };
    const { kind, id, label } = r;
    if (typeof kind !== 'string' || !KIND_RE.test(kind)) return { ok: false, code: 'resource_invalid' };
    if (typeof id !== 'string' || rawTooLong(id, ALERT_LIMITS.resourceIdChars)) return { ok: false, code: 'resource_invalid' };
    const cleanId = sanitizeText(id, false);
    if (cleanId.length === 0 || cleanId.length > ALERT_LIMITS.resourceIdChars) return { ok: false, code: 'resource_invalid' };
    if (label === undefined) {
      out.push(Object.freeze({ kind, id: cleanId }));
      continue;
    }
    if (typeof label !== 'string' || rawTooLong(label, ALERT_LIMITS.resourceLabelChars)) return { ok: false, code: 'resource_invalid' };
    const cleanLabel = sanitizeText(label, false);
    if (cleanLabel.length === 0 || cleanLabel.length > ALERT_LIMITS.resourceLabelChars) return { ok: false, code: 'resource_invalid' };
    out.push(Object.freeze({ kind, id: cleanId, label: cleanLabel }));
  }
  return { ok: true, value: out };
}

function parseLinks(v: unknown): { ok: true; value: AlertLink[] } | { ok: false; code: AlertEventErrorCode } {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, code: 'links_invalid' };
  if (v.length > ALERT_LIMITS.links) return { ok: false, code: 'too_many_links' };
  const out: AlertLink[] = [];
  for (let i = 0; i < v.length; i += 1) {
    const l: unknown = v[i];
    if (!isPlainRecord(l) || !onlyKeys(l, ['label', 'url'])) return { ok: false, code: 'link_invalid' };
    if (typeof l.label !== 'string' || rawTooLong(l.label, ALERT_LIMITS.linkLabelChars)) return { ok: false, code: 'link_invalid' };
    const label = sanitizeText(l.label, false);
    if (label.length === 0 || label.length > ALERT_LIMITS.linkLabelChars) return { ok: false, code: 'link_invalid' };
    const url = normalizeLinkUrl(l.url);
    if (url === null) return { ok: false, code: 'link_invalid' };
    out.push(Object.freeze({ label, url }));
  }
  return { ok: true, value: out };
}

/**
 * Strict parse of an untrusted value into an AlertEvent. Never throws; never
 * echoes input. Required: tenant, dedupeKey, severity, title, occurredAt.
 * Optional: body (default ''), resources and links (default []).
 */
export function parseAlertEvent(input: unknown): AlertEventParse {
  try {
    if (!isPlainRecord(input)) return fail('malformed');
    if (!onlyKeys(input, EVENT_KEYS)) return fail('unknown_field');

    const { tenant, dedupeKey, severity, title, body, occurredAt } = input;
    if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) return fail('tenant_invalid');
    if (typeof dedupeKey !== 'string' || !DEDUPE_RE.test(dedupeKey)) return fail('dedupe_key_invalid');
    if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) return fail('severity_invalid');

    if (typeof title !== 'string') return fail('title_invalid');
    if (rawTooLong(title, ALERT_LIMITS.titleChars)) return fail('title_too_long');
    const cleanTitle = sanitizeText(title, false);
    if (cleanTitle.length === 0) return fail('title_invalid');
    if (cleanTitle.length > ALERT_LIMITS.titleChars) return fail('title_too_long');

    let cleanBody = '';
    if (body !== undefined) {
      if (typeof body !== 'string') return fail('body_invalid');
      if (rawTooLong(body, ALERT_LIMITS.bodyChars)) return fail('body_too_long');
      cleanBody = sanitizeText(body, true);
      if (cleanBody.length > ALERT_LIMITS.bodyChars) return fail('body_too_long');
    }

    const at = parseInstant(occurredAt);
    if (at === null) return fail('occurred_at_invalid');

    const resources = parseResources(input.resources);
    if (!resources.ok) return fail(resources.code);
    const links = parseLinks(input.links);
    if (!links.ok) return fail(links.code);

    const event: AlertEvent = Object.freeze({
      tenant,
      dedupeKey,
      severity: severity as Severity,
      title: cleanTitle,
      body: cleanBody,
      occurredAt: at,
      resources: Object.freeze(resources.value),
      links: Object.freeze(links.value),
    });
    return { ok: true, event };
  } catch {
    // A hostile accessor or Proxy threw while being read.
    return fail('malformed');
  }
}
