// Email: header-injection protection, recipient cap, encoding, truncation, channel.

import { describe, it, expect } from 'vitest';
import { parseAlertEvent } from './alertEvent';
import {
  MAX_EMAIL_RAW_BYTES, MAX_EMAIL_RECIPIENTS, MAX_EMAIL_TEXT_BYTES, buildEmailMessage, cleanSubject, createEmailChannel,
  emailTextForEvent, isValidDisplayName, parseEmailAddress, truncateUtf8, type EmailInput,
} from './email';
import { T0, makeClock, makeMail, makeSleep, rawEvent } from './testKit';

const base: EmailInput = { from: 'alerts@ratio.example.com', to: ['owner@acme.example'], subject: 'Hello', text: 'Body', dateMs: T0, messageIdSeed: 'seed' };
const build = (o: Partial<EmailInput> = {}) => buildEmailMessage({ ...base, ...o });
function headerBlock(raw: string): string[] { return raw.split('\r\n\r\n')[0].split('\r\n'); }
function decodeBody(raw: string): string { return Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'); }

describe('parseEmailAddress', () => {
  it.each(['a@b.example', 'first.last+tag@sub.example.com', 'A@EXAMPLE.COM', 'x@xn--bcher-kva.example'])('accepts %s', (a) => expect(parseEmailAddress(a)).not.toBeNull());
  it('lower-cases the domain only', () => expect(parseEmailAddress('Bob@EXAMPLE.com')).toBe('Bob@example.com'));
  it.each([
    '', 'a', 'a@b', '@b.example', 'a@', 'a@@b.example', 'a@b@c.example', 'a b@c.example', 'a@b c.example', '"a"@b.example', 'a(c)@b.example',
    '<a@b.example>', 'a@b.example>', 'a,b@c.example', 'a;b@c.example', 'a@[127.0.0.1]', 'a@127.0.0.1', 'a..b@c.example', '.a@c.example', 'a.@c.example',
    'a@-b.example', 'a@b-.example', 'a@b..example', 'a@b.123', 'a@b.e', 'é@b.example', 'a@bé.example', 'a\r\nBcc: x@evil.example@b.example',
    'a@b.example\r\nBcc: x@evil.example', 'a@b.example\nBcc: x@evil.example', 'a@b.example\u0000', 'a@b.example ', ' a@b.example', 'a%0d%0a@b.example',
  ])('refuses %j', (a) => expect(parseEmailAddress(a)).toBeNull());
  it('caps length at 254', () => {
    const ok = `${'a'.repeat(30)}@${'b'.repeat(50)}.${'c'.repeat(50)}.${'d'.repeat(50)}.${'e'.repeat(50)}.example`;
    expect(ok.length).toBeLessThanOrEqual(254);
    expect(parseEmailAddress(ok)).not.toBeNull();
    expect(parseEmailAddress(`${'a'.repeat(65)}@b.example`)).toBeNull();
    expect(parseEmailAddress(`a@${'b'.repeat(250)}.example`)).toBeNull();
    expect(parseEmailAddress(5)).toBeNull();
  });
});

describe('header injection via CRLF', () => {
  const INJECT = 'x\r\nBcc: attacker@evil.example';
  it('subject: CRLF cannot start a new header', () => {
    for (const s of [INJECT, 'x\nBcc: a@evil.example', 'x\rBcc: a@evil.example', 'x Bcc: a@evil.example', 'x\u0085Bcc: a@evil.example', '\r\n\r\nbody']) {
      const r = build({ subject: s });
      if (!r.ok) throw new Error('should build');
      const lines = headerBlock(r.envelope.raw);
      expect(lines.some((l) => /^Bcc:/i.test(l))).toBe(false);
      expect(lines.filter((l) => /^[A-Za-z-]+:/.test(l)).map((l) => l.split(':')[0])).toEqual(['Date', 'From', 'To', 'Subject', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'Auto-Submitted']);
      expect(r.envelope.raw.split('\r\n\r\n')).toHaveLength(2);
    }
  });
  it('display name: CRLF, controls and angle brackets are refused, not repaired', () => {
    for (const n of [INJECT, 'a\nb', 'a\u0000b', 'a<b', 'a>b', 'a b', '', 'n'.repeat(71)]) {
      expect(build({ fromName: n })).toEqual({ ok: false, code: 'name_invalid' });
    }
    expect(isValidDisplayName('n'.repeat(70))).toBe(true);
  });
  it('display name: quotes and backslashes are escaped inside the quoted string', () => {
    const r = build({ fromName: 'Ratio "Alerts" \\ team' });
    if (!r.ok) throw new Error('should build');
    expect(r.envelope.raw).toContain('From: "Ratio \\"Alerts\\" \\\\ team" <alerts@ratio.example.com>');
  });
  it('display name: non-ASCII becomes encoded-words', () => {
    const r = build({ fromName: 'Équipe Ratio' });
    if (!r.ok) throw new Error('should build');
    expect(headerBlock(r.envelope.raw).find((l) => l.startsWith('From:'))).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <alerts@ratio.example.com>$/);
  });
  it('recipient and sender: CRLF anywhere refuses the whole message', () => {
    expect(build({ to: ['a@b.example\r\nBcc: x@evil.example'] })).toEqual({ ok: false, code: 'recipient_invalid' });
    expect(build({ to: ['ok@b.example', 'a@b.example\nBcc: x@evil.example'] })).toEqual({ ok: false, code: 'recipient_invalid' });
    expect(build({ from: 'a@b.example\r\nBcc: x@evil.example' })).toEqual({ ok: false, code: 'from_invalid' });
  });
  it('body text cannot add headers (base64 body, blank line separates)', () => {
    const r = build({ text: 'hi\r\n\r\nBcc: a@evil.example' });
    if (!r.ok) throw new Error('should build');
    expect(r.envelope.raw).not.toContain('Bcc:');
    expect(decodeBody(r.envelope.raw)).toContain('Bcc: a@evil.example');
  });
  it('through the alert pipeline: a title with CRLF yields no extra header', async () => {
    const mail = makeMail();
    const clock = makeClock();
    const ch = createEmailChannel({ id: 'm', from: 'alerts@ratio.example.com', to: ['o@acme.example'] }, { mail: mail.transport, clock, sleep: makeSleep(clock).sleep });
    const p = parseAlertEvent(rawEvent({ title: 'T\r\nBcc: attacker@evil.example' }));
    if (!p.ok) throw new Error('fixture');
    expect(await ch.send(p.event, { tenant: 'acme', attempt: 1 })).toEqual({ ok: true });
    expect(mail.sent[0].raw).not.toMatch(/^Bcc:/mi);
  });
});

describe('subject encoding', () => {
  it('cleanSubject strips controls and collapses space', () => expect(cleanSubject(' a\r\n\tb\u0000  c ')).toBe('a b c'));
  it('short ASCII stays plain; non-ASCII or "=?" is encoded; long subjects fold under 78 columns', () => {
    const plain = build({ subject: 'Budget alert' }); if (!plain.ok) throw new Error();
    expect(plain.envelope.raw).toContain('Subject: Budget alert\r\n');
    const enc = build({ subject: 'Café =?evil?=' }); if (!enc.ok) throw new Error();
    expect(enc.envelope.raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    const long = build({ subject: 'word '.repeat(60) }); if (!long.ok) throw new Error();
    for (const l of headerBlock(long.envelope.raw)) expect(l.length).toBeLessThanOrEqual(78);
  });
  it('an empty subject becomes a fixed default', () => {
    const r = build({ subject: '\r\n' }); if (!r.ok) throw new Error();
    expect(r.envelope.raw).toContain('Subject: Ratio alert\r\n');
  });
});

describe('recipient cap and dedupe', () => {
  const addrs = (n: number) => Array.from({ length: n }, (_, i) => `u${i}@acme.example`);
  it('accepts 20 recipients and refuses 21 or none', () => {
    expect(build({ to: addrs(MAX_EMAIL_RECIPIENTS) }).ok).toBe(true);
    expect(build({ to: addrs(MAX_EMAIL_RECIPIENTS + 1) })).toEqual({ ok: false, code: 'too_many_recipients' });
    expect(build({ to: [] })).toEqual({ ok: false, code: 'recipients_empty' });
  });
  it('de-duplicates case-insensitively and only lists To', () => {
    const r = build({ to: ['A@acme.example', 'a@acme.example', 'b@acme.example'] }); if (!r.ok) throw new Error();
    expect(r.envelope.to).toEqual(['A@acme.example', 'b@acme.example']);
    expect(r.envelope.raw).not.toMatch(/^(Cc|Bcc):/mi);
  });
});

describe('message limits and format', () => {
  it('has CRLF line endings, a MIME header set and a stable Message-ID on the sender domain', () => {
    const a = build(); const b = build(); if (!a.ok || !b.ok) throw new Error();
    expect(a.envelope.messageId).toBe(b.envelope.messageId);
    expect(a.envelope.messageId).toMatch(/^<[0-9a-f]{32}@ratio\.example\.com>$/);
    expect(a.envelope.raw).toContain('Date: Mon, 01 Jun 2026 12:00:00 +0000');
    expect(a.envelope.raw).not.toMatch(/[^\r]\n/);
    expect(build({ messageIdSeed: 'other' })).not.toEqual(a);
  });
  it('truncates the text body at the cap with a marker and never splits a code point', () => {
    const r = build({ text: '€'.repeat(20_000) }); if (!r.ok) throw new Error();
    const text = decodeBody(r.envelope.raw).replace(/\r\n/g, '\n');
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_EMAIL_TEXT_BYTES);
    expect(text.endsWith('[truncated]')).toBe(true);
    expect(text).not.toContain('�');
    expect(truncateUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false });
    expect(MAX_EMAIL_RAW_BYTES).toBeGreaterThan(MAX_EMAIL_TEXT_BYTES);
  });
  it('refuses a bad date', () => {
    for (const d of [Number.NaN, 0, Date.UTC(2101, 0, 1)]) expect(build({ dateMs: d })).toEqual({ ok: false, code: 'date_invalid' });
  });
  it('emailTextForEvent lists severity, tenant, resources and links', () => {
    const p = parseAlertEvent(rawEvent()); if (!p.ok) throw new Error();
    const t = emailTextForEvent(p.event);
    expect(t).toContain('Severity: critical'); expect(t).toContain('workload wl-001 (Support bot)'); expect(t).toContain('Open in Ratio: https://ratio.example.com/findings/f-1');
  });
});

describe('createEmailChannel', () => {
  const ev = () => { const p = parseAlertEvent(rawEvent()); if (!p.ok) throw new Error(); return p.event; };
  const mk = (handler?: Parameters<typeof makeMail>[0], over: Partial<{ mail: undefined }> = {}, cfgTo: string[] = ['o@acme.example']) => {
    const clock = makeClock(); const sleeper = makeSleep(clock); const mail = makeMail(handler);
    const ch = createEmailChannel({ id: 'm', from: 'alerts@ratio.example.com', fromName: 'Ratio', to: cfgTo }, { mail: 'mail' in over ? undefined : mail.transport, clock, sleep: sleeper.sleep, timeoutMs: 1000 });
    return { ch, mail, sleeper };
  };
  const ctx = { tenant: 'acme', attempt: 1 };
  it('sends via the injected transport', async () => {
    const s = mk(); expect(await s.ch.send(ev(), ctx)).toEqual({ ok: true });
    expect(s.mail.sent[0].to).toEqual(['o@acme.example']); expect(s.mail.sent[0].from).toBe('alerts@ratio.example.com');
    expect(s.mail.sent[0].raw).toContain('Subject: [Ratio CRITICAL] Budget hard threshold crossed');
  });
  it('fails closed without a transport and on bad config', async () => {
    expect(await mk(undefined, { mail: undefined }).ch.send(ev(), ctx)).toEqual({ ok: false, code: 'mail_transport_missing', retryable: false });
    expect(await mk(undefined, {}, ['bad']).ch.send(ev(), ctx)).toMatchObject({ code: 'mail_message_invalid', retryable: false, detail: 'recipient_invalid' });
  });
  it('maps permanent, transient, throwing, and hung transports', async () => {
    expect(await mk(() => ({ accepted: false })).ch.send(ev(), ctx)).toEqual({ ok: false, code: 'mail_rejected', retryable: false });
    expect(await mk(() => ({ accepted: false, transient: true })).ch.send(ev(), ctx)).toEqual({ ok: false, code: 'mail_temporary_failure', retryable: true });
    const thrown = await mk(() => { throw new Error('smtp password=CANARY'); }).ch.send(ev(), ctx);
    expect(thrown).toEqual({ ok: false, code: 'transport_error', retryable: true });
    const hung = mk(() => new Promise(() => undefined));
    const pending = hung.ch.send(ev(), ctx);
    await new Promise((r) => setImmediate(r));
    hung.sleeper.fireTimers();
    expect(await pending).toEqual({ ok: false, code: 'timeout', retryable: true });
  });
  it('refuses a cross-tenant event', async () => {
    const p = parseAlertEvent(rawEvent({ tenant: 'other' })); if (!p.ok) throw new Error();
    expect(await mk().ch.send(p.event, ctx)).toMatchObject({ code: 'internal_error' });
  });
});
