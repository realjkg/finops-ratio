// Email channel: builds an RFC 5322 message and hands it to an injected,
// SMTP-like MailTransport. No SMTP is implemented here and no socket is opened.
//
// TRUST BOUNDARY: the subject comes from alert text (untrusted); recipients,
// the sender and the display name come from tenant config (validated, not
// trusted). Header injection is closed three ways:
//   - addresses use a deliberately narrow grammar (ASCII dot-atom subset, DNS
//     domain, no quoted strings, no comments, no IP-literal domains, no angle
//     brackets); anything else is REFUSED, never repaired;
//   - the display name is refused if it holds a control character, `<` or `>`;
//     otherwise it is emitted as a quoted-string (ASCII) or an RFC 2047
//     encoded-word (UTF-8), so it cannot end the field;
//   - the subject is cleaned of every control character and line break, then
//     emitted as plain ASCII (short, no `=?`) or as folded encoded-words.
// There is no Cc or Bcc support, so those headers cannot be forged by field
// content. The body is base64, so no body line can be mistaken for a header.
// A recipient cap bounds fan-out. Time comes from the caller; the Message-ID
// is derived from a caller-supplied seed, not from randomness.
//
// Uses node:crypto for the Message-ID hash, so this module is server-only.

import { createHash } from 'node:crypto';
import type { AlertEvent } from './alertEvent';
import { raceTimeout } from './ssrf';
import type { AlertChannel, ChannelResult, Clock, MailEnvelope, MailTransport, SendContext, Sleep } from './types';

export const MAX_EMAIL_RECIPIENTS = 20;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_DISPLAY_NAME_CHARS = 70;
export const MAX_ADDRESS_CHARS = 254;
export const MAX_EMAIL_TEXT_BYTES = 32 * 1024;
export const MAX_EMAIL_RAW_BYTES = 128 * 1024;
export const DEFAULT_MAIL_TIMEOUT_MS = 30_000;
export const EMAIL_TRUNCATION_MARK = '\n[truncated]';

const LOCAL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Parse an address into `local@domain` (domain lower-cased) or null. ASCII only
 * (internationalized domains must already be punycode), a dot-atom local part
 * of letters, digits and `._+-`, and a DNS domain with at least two labels.
 */
export function parseEmailAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ADDRESS_CHARS) return null;
  const at = raw.indexOf('@');
  if (at < 1 || at !== raw.lastIndexOf('@')) return null;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1).toLowerCase();
  if (!LOCAL_RE.test(local) || local.includes('..')) return null;
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => DOMAIN_LABEL_RE.test(l))) return null;
  if (!TLD_RE.test(labels[labels.length - 1])) return null;
  return `${local}@${domain}`;
}

export type EmailErrorCode =
  | 'from_invalid'
  | 'name_invalid'
  | 'recipients_empty'
  | 'too_many_recipients'
  | 'recipient_invalid'
  | 'date_invalid'
  | 'message_too_large';

export type EmailBuild =
  | { readonly ok: true; readonly envelope: MailEnvelope }
  | { readonly ok: false; readonly code: EmailErrorCode };

export interface EmailInput {
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  /** Send time, epoch milliseconds (injected clock). */
  readonly dateMs: number;
  /** Stable seed for the Message-ID (for example tenant, dedupe key, severity, occurredAt). */
  readonly messageIdSeed: string;
}

const utf8 = new TextEncoder();

function isControl(unit: number): boolean {
  return unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029;
}

/** Replace every control character and line break with a space, collapse, trim. */
export function cleanSubject(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const unit = raw.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdfff) {
      const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
      if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += raw[i] + raw[i + 1];
        i += 1;
      } // a lone surrogate is dropped
      continue;
    }
    out += isControl(unit) ? ' ' : raw[i];
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/** UTF-8 B-encoded words of at most 60 characters, split between code points. */
export function encodeWords(text: string): string[] {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of Array.from(text)) {
    const n = utf8.encode(ch).length;
    if (bytes + n > 36 && chunk !== '') {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk !== '') words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`);
}

/** Header value tokens joined by single spaces, folded before 78 columns at token boundaries. */
function foldHeader(name: string, tokens: readonly string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  for (const t of tokens) {
    if (line.length + 1 + t.length > 78 && line !== `${name}:`) {
      lines.push(line);
      line = ` ${t}`;
    } else {
      line += ` ${t}`;
    }
  }
  lines.push(line);
  return lines.join('\r\n');
}

function subjectTokens(subject: string): string[] {
  const cleaned = cleanSubject(subject);
  const capped = Array.from(cleaned).length > MAX_SUBJECT_CHARS
    ? Array.from(cleaned).slice(0, MAX_SUBJECT_CHARS - 1).join('') + '…'
    : cleaned;
  const text = capped === '' ? 'Ratio alert' : capped;
  if (isPrintableAscii(text) && text.length <= 60 && !text.includes('=?')) return text.split(' ');
  return encodeWords(text);
}

/** Whether a display name is acceptable: bounded, no control characters, no angle brackets. */
export function isValidDisplayName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || Array.from(name).length > MAX_DISPLAY_NAME_CHARS) return false;
  for (let i = 0; i < name.length; i += 1) {
    const u = name.charCodeAt(i);
    if (isControl(u) || (u >= 0xd800 && u <= 0xdfff && !isPairedSurrogate(name, i))) return false;
    if (name[i] === '<' || name[i] === '>') return false;
  }
  return true;
}

/** Display-name tokens: a quoted-string, or encoded-words; null when the name is refused. */
function nameTokens(name: string): string[] | null {
  if (!isValidDisplayName(name)) return null;
  if (isPrintableAscii(name)) return [`"${name.replace(/[\\"]/g, '\\$&')}"`];
  return encodeWords(name);
}

function isPairedSurrogate(s: string, i: number): boolean {
  const u = s.charCodeAt(i);
  if (u >= 0xd800 && u <= 0xdbff) {
    const n = s.charCodeAt(i + 1);
    return n >= 0xdc00 && n <= 0xdfff;
  }
  const p = s.charCodeAt(i - 1);
  return u >= 0xdc00 && u <= 0xdfff && p >= 0xd800 && p <= 0xdbff;
}

function rfc5322Date(ms: number): string {
  return new Date(ms).toUTCString().replace(/ GMT$/, ' +0000');
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a code point boundary, with a visible marker. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8.encode(text).length <= maxBytes) return { text, truncated: false };
  const budget = maxBytes - utf8.encode(EMAIL_TRUNCATION_MARK).length;
  let out = '';
  let bytes = 0;
  for (const ch of Array.from(text)) {
    const n = utf8.encode(ch).length;
    if (bytes + n > budget) break;
    out += ch;
    bytes += n;
  }
  return { text: out + EMAIL_TRUNCATION_MARK, truncated: true };
}

/** Build the message. Refuses (never repairs) a bad sender, name or recipient. */
export function buildEmailMessage(input: EmailInput): EmailBuild {
  const from = parseEmailAddress(input.from);
  if (from === null) return { ok: false, code: 'from_invalid' };

  let fromTokens: string[] = [`<${from}>`];
  if (input.fromName !== undefined) {
    const name = nameTokens(input.fromName);
    if (name === null) return { ok: false, code: 'name_invalid' };
    fromTokens = [...name, `<${from}>`];
  }

  if (!Array.isArray(input.to) || input.to.length === 0) return { ok: false, code: 'recipients_empty' };
  if (input.to.length > MAX_EMAIL_RECIPIENTS) return { ok: false, code: 'too_many_recipients' };
  const recipients: string[] = [];
  for (const r of input.to) {
    const addr = parseEmailAddress(r);
    if (addr === null) return { ok: false, code: 'recipient_invalid' };
    if (!recipients.some((x) => x.toLowerCase() === addr.toLowerCase())) recipients.push(addr);
  }

  if (!Number.isFinite(input.dateMs) || input.dateMs < Date.UTC(2000, 0, 1) || input.dateMs > Date.UTC(2100, 0, 1)) {
    return { ok: false, code: 'date_invalid' };
  }

  const body = truncateUtf8(input.text.replace(/\r\n|\r|\n/g, '\n'), MAX_EMAIL_TEXT_BYTES).text;
  const encoded = Buffer.from(body.replace(/\n/g, '\r\n'), 'utf8').toString('base64');
  const bodyLines = (encoded.match(/.{1,76}/g) ?? []).join('\r\n');

  const domain = from.slice(from.indexOf('@') + 1);
  const hash = createHash('sha256').update(input.messageIdSeed).digest('hex').slice(0, 32);
  const messageId = `<${hash}@${domain}>`;

  const headers = [
    `Date: ${rfc5322Date(input.dateMs)}`,
    foldHeader('From', fromTokens),
    foldHeader('To', recipients.map((r, i) => (i < recipients.length - 1 ? `<${r}>,` : `<${r}>`))),
    foldHeader('Subject', subjectTokens(input.subject)),
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  const raw = `${headers.join('\r\n')}\r\n\r\n${bodyLines}\r\n`;
  if (utf8.encode(raw).length > MAX_EMAIL_RAW_BYTES) return { ok: false, code: 'message_too_large' };

  return { ok: true, envelope: Object.freeze({ from, to: Object.freeze(recipients), raw, messageId }) };
}

/** Plain-text rendering of an event for mail. Untrusted text is plain text here, so it needs no escaping. */
export function emailTextForEvent(event: AlertEvent): string {
  const lines: string[] = [event.title, ''];
  if (event.body !== '') lines.push(event.body, '');
  lines.push(`Severity: ${event.severity}`, `Tenant: ${event.tenant}`, `Occurred: ${event.occurredAt}`);
  if (event.resources.length > 0) {
    lines.push('', 'Resources:');
    for (const r of event.resources) lines.push(`  - ${r.kind} ${r.id}${r.label === undefined ? '' : ` (${r.label})`}`);
  }
  if (event.links.length > 0) {
    lines.push('', 'Links:');
    for (const l of event.links) lines.push(`  - ${l.label}: ${l.url}`);
  }
  lines.push('', `Reference: ${event.dedupeKey}`);
  return lines.join('\n');
}

export interface EmailChannelConfig {
  readonly id: string;
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
}

export interface EmailChannelDeps {
  /** Absent means email cannot be sent (fail closed). */
  readonly mail: MailTransport | undefined;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly timeoutMs?: number;
}

const SEVERITY_TAG = { info: 'INFO', warning: 'WARNING', critical: 'CRITICAL' } as const;

export function createEmailChannel(cfg: EmailChannelConfig, deps: EmailChannelDeps): AlertChannel {
  return {
    kind: 'email',
    id: cfg.id,
    async send(event: AlertEvent, ctx: SendContext): Promise<ChannelResult> {
      if (event.tenant !== ctx.tenant) return { ok: false, code: 'internal_error', retryable: false };
      const mail = deps.mail;
      if (mail === undefined) return { ok: false, code: 'mail_transport_missing', retryable: false };

      const built = buildEmailMessage({
        from: cfg.from,
        fromName: cfg.fromName,
        to: cfg.to,
        subject: `[Ratio ${SEVERITY_TAG[event.severity]}] ${event.title}`,
        text: emailTextForEvent(event),
        dateMs: deps.clock.now(),
        messageIdSeed: `${event.tenant}\u0000${event.dedupeKey}\u0000${event.severity}\u0000${event.occurredAt}`,
      });
      if (!built.ok) return { ok: false, code: 'mail_message_invalid', retryable: false, detail: built.code };

      const abort = new AbortController();
      const timeoutMs = deps.timeoutMs ?? DEFAULT_MAIL_TIMEOUT_MS;
      try {
        const raced = await raceTimeout(Promise.resolve().then(() => mail(built.envelope, abort.signal)), timeoutMs, deps.sleep);
        if (raced.timedOut) {
          abort.abort();
          return { ok: false, code: 'timeout', retryable: true };
        }
        const res = raced.value;
        if (res && res.accepted === true) return { ok: true };
        if (res && res.transient === true) return { ok: false, code: 'mail_temporary_failure', retryable: true };
        return { ok: false, code: 'mail_rejected', retryable: false };
      } catch {
        abort.abort();
        return { ok: false, code: 'transport_error', retryable: true };
      }
    },
  };
}
