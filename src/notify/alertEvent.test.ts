// Alert event validation: caps at and past the limit, control-character
// stripping, strictness, and fixed error text.

import { describe, it, expect } from 'vitest';
import {
  ALERT_EVENT_ERROR_TEXT,
  ALERT_LIMITS,
  parseAlertEvent,
  sanitizeText,
  type AlertEventErrorCode,
} from './alertEvent';
import { rawEvent } from './testKit';

function codeOf(input: unknown): AlertEventErrorCode | 'ok' {
  const r = parseAlertEvent(input);
  return r.ok ? 'ok' : r.code;
}

describe('parseAlertEvent: accepted shapes', () => {
  it('accepts a full valid event and freezes it', () => {
    const r = parseAlertEvent(rawEvent());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.tenant).toBe('acme');
    expect(r.event.severity).toBe('critical');
    expect(r.event.occurredAt).toBe('2026-06-01T11:59:00.000Z');
    expect(r.event.resources).toEqual([{ kind: 'workload', id: 'wl-001', label: 'Support bot' }]);
    expect(Object.isFrozen(r.event)).toBe(true);
    expect(Object.isFrozen(r.event.resources)).toBe(true);
  });

  it('accepts a minimal event and defaults body, resources and links', () => {
    const r = parseAlertEvent({
      tenant: 't1',
      dedupeKey: 'k',
      severity: 'info',
      title: 'Hello',
      occurredAt: '2026-06-01T00:00:00Z',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.body).toBe('');
    expect(r.event.resources).toEqual([]);
    expect(r.event.links).toEqual([]);
    expect(r.event.occurredAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it.each(['info', 'warning', 'critical'])('accepts severity %s', (severity) => {
    expect(codeOf(rawEvent({ severity }))).toBe('ok');
  });
});

describe('parseAlertEvent: tenant and dedupe key', () => {
  it('accepts a tenant at 64 characters and refuses 65', () => {
    expect(codeOf(rawEvent({ tenant: 'a'.repeat(ALERT_LIMITS.tenantChars) }))).toBe('ok');
    expect(codeOf(rawEvent({ tenant: 'a'.repeat(ALERT_LIMITS.tenantChars + 1) }))).toBe('tenant_invalid');
  });

  it.each(['', ' acme', 'acme corp', 'ac/me', '-acme', 'acmé', 'acme\n', 5, null, undefined])('refuses tenant %j', (tenant) => {
    expect(codeOf(rawEvent({ tenant }))).toBe('tenant_invalid');
  });

  it('accepts a dedupe key at 200 characters and refuses 201', () => {
    expect(codeOf(rawEvent({ dedupeKey: 'k'.repeat(ALERT_LIMITS.dedupeKeyChars) }))).toBe('ok');
    expect(codeOf(rawEvent({ dedupeKey: 'k'.repeat(ALERT_LIMITS.dedupeKeyChars + 1) }))).toBe('dedupe_key_invalid');
  });

  it.each(['', 'has space', 'a<b', 'a\r\nb', 'a|b', '\u0000', 'key‮', 7])('refuses dedupe key %j', (dedupeKey) => {
    expect(codeOf(rawEvent({ dedupeKey }))).toBe('dedupe_key_invalid');
  });
});

describe('parseAlertEvent: severity', () => {
  it.each(['CRITICAL', 'high', '', 'warn', 3, null, undefined, ['info']])('refuses severity %j', (severity) => {
    expect(codeOf(rawEvent({ severity }))).toBe('severity_invalid');
  });
});

describe('parseAlertEvent: title and body caps', () => {
  it('accepts a title at 200 characters and refuses 201', () => {
    expect(codeOf(rawEvent({ title: 't'.repeat(ALERT_LIMITS.titleChars) }))).toBe('ok');
    expect(codeOf(rawEvent({ title: 't'.repeat(ALERT_LIMITS.titleChars + 1) }))).toBe('title_too_long');
  });

  it('refuses an empty, blank or control-only title and a non-string title', () => {
    expect(codeOf(rawEvent({ title: '' }))).toBe('title_invalid');
    expect(codeOf(rawEvent({ title: '   \t ' }))).toBe('title_invalid');
    expect(codeOf(rawEvent({ title: '\u0000\u0007‮' }))).toBe('title_invalid');
    expect(codeOf(rawEvent({ title: 42 }))).toBe('title_invalid');
    expect(codeOf(rawEvent({ title: undefined }))).toBe('title_invalid');
  });

  it('accepts a body at 4000 characters and refuses 4001', () => {
    expect(codeOf(rawEvent({ body: 'b'.repeat(ALERT_LIMITS.bodyChars) }))).toBe('ok');
    expect(codeOf(rawEvent({ body: 'b'.repeat(ALERT_LIMITS.bodyChars + 1) }))).toBe('body_too_long');
  });

  it('refuses a non-string body and accepts an empty one', () => {
    expect(codeOf(rawEvent({ body: 5 }))).toBe('body_invalid');
    expect(codeOf(rawEvent({ body: '' }))).toBe('ok');
  });

  it('refuses a megabyte of text without processing it', () => {
    const huge = 'x'.repeat(1_000_000);
    expect(codeOf(rawEvent({ title: huge }))).toBe('title_too_long');
    expect(codeOf(rawEvent({ body: huge }))).toBe('body_too_long');
  });

  it('measures length after stripping, so invisible padding does not cause a refusal', () => {
    const padded = 'a'.repeat(ALERT_LIMITS.titleChars) + '​'.repeat(50);
    expect(codeOf(rawEvent({ title: padded }))).toBe('ok');
  });
});

describe('sanitizeText: control characters', () => {
  it('strips C0 controls, DEL and C1 controls', () => {
    expect(sanitizeText('a\u0000b\u0007c\u001bd\u007fe\u0080f\u009fg', false)).toBe('abcdefg');
  });

  it('turns every line-break form into a space in single-line text', () => {
    expect(sanitizeText('a\r\nb\rc\nd\u0085e f g\u000bh\u000ci', false)).toBe('a b c d e f g h i');
  });

  it('turns line-break forms into LF in multiline text and keeps tabs', () => {
    expect(sanitizeText('a\r\nb\rc d\te', true)).toBe('a\nb\nc\nd\te');
  });

  it('removes bidi overrides and isolates, zero-width characters, BOM and tag characters', () => {
    const hostile = 'pay‮⁦evil⁩​‍⁠﻿\u{e0041}ment';
    expect(sanitizeText(hostile, false)).toBe('payevilment');
  });

  it('drops lone surrogates and keeps astral characters', () => {
    expect(sanitizeText('a\ud800b\udc00c', false)).toBe('abc');
    expect(sanitizeText('ok \u{1f600}', false)).toBe('ok \u{1f600}');
  });

  it('normalizes to NFC', () => {
    expect(sanitizeText('é', false)).toBe('é');
  });

  it('collapses runs of spaces and blank lines and trims', () => {
    expect(sanitizeText('  a    b  ', false)).toBe('a b');
    expect(sanitizeText('a\n\n\n\n\nb  \n', true)).toBe('a\n\nb');
  });

  it('a CRLF in a title cannot forge a second line', () => {
    const r = parseAlertEvent(rawEvent({ title: 'Real title\r\nSeverity: info\r\nBcc: x@evil.example' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.title).toBe('Real title Severity: info Bcc: x@evil.example');
  });
});

describe('parseAlertEvent: occurredAt', () => {
  it.each(['2026-06-01T00:00:00Z', '2026-06-01T00:00:00.1Z', '2026-06-01T00:00:00.123Z', '2000-01-01T00:00:00Z', '2100-12-31T23:59:59Z'])(
    'accepts %s',
    (occurredAt) => {
      expect(codeOf(rawEvent({ occurredAt }))).toBe('ok');
    },
  );

  it.each([
    '2026-06-01',
    '2026-06-01T00:00:00',
    '2026-06-01T00:00:00+00:00',
    '2026-06-01 00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-06-01T24:00:00Z',
    '2026-06-01T00:60:00Z',
    '1999-12-31T23:59:59Z',
    '2101-01-01T00:00:00Z',
    'yesterday',
    '',
    1780000000,
    null,
    undefined,
  ])('refuses %j', (occurredAt) => {
    expect(codeOf(rawEvent({ occurredAt }))).toBe('occurred_at_invalid');
  });

  it('normalizes to toISOString form', () => {
    const r = parseAlertEvent(rawEvent({ occurredAt: '2026-06-01T00:00:00.5Z' }));
    if (r.ok) expect(r.event.occurredAt).toBe('2026-06-01T00:00:00.500Z');
    else throw new Error('expected ok');
  });
});

describe('parseAlertEvent: resources', () => {
  const res = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'workload', id: `wl-${i}` }));

  it('accepts 20 resources and refuses 21', () => {
    expect(codeOf(rawEvent({ resources: res(ALERT_LIMITS.resources) }))).toBe('ok');
    expect(codeOf(rawEvent({ resources: res(ALERT_LIMITS.resources + 1) }))).toBe('too_many_resources');
  });

  it('refuses a non-array and malformed elements', () => {
    expect(codeOf(rawEvent({ resources: 'wl-001' }))).toBe('resources_invalid');
    expect(codeOf(rawEvent({ resources: { kind: 'workload', id: 'x' } }))).toBe('resources_invalid');
    expect(codeOf(rawEvent({ resources: [null] }))).toBe('resource_invalid');
    expect(codeOf(rawEvent({ resources: ['wl-001'] }))).toBe('resource_invalid');
    expect(codeOf(rawEvent({ resources: [{ kind: 'workload', id: 'x', extra: 1 }] }))).toBe('resource_invalid');
  });

  it('validates kind, id and label caps', () => {
    expect(codeOf(rawEvent({ resources: [{ kind: 'Workload', id: 'x' }] }))).toBe('resource_invalid');
    expect(codeOf(rawEvent({ resources: [{ kind: 'a b', id: 'x' }] }))).toBe('resource_invalid');
    expect(codeOf(rawEvent({ resources: [{ kind: 'workload', id: '' }] }))).toBe('resource_invalid');
    expect(codeOf(rawEvent({ resources: [{ kind: 'workload', id: 'i'.repeat(ALERT_LIMITS.resourceIdChars) }] }))).toBe('ok');
    expect(codeOf(rawEvent({ resources: [{ kind: 'workload', id: 'i'.repeat(ALERT_LIMITS.resourceIdChars + 1) }] }))).toBe('resource_invalid');
    expect(codeOf(rawEvent({ resources: [{ kind: 'workload', id: 'x', label: 'l'.repeat(ALERT_LIMITS.resourceLabelChars) }] }))).toBe('ok');
    expect(codeOf(rawEvent({ resources: [{ kind: 'workload', id: 'x', label: 'l'.repeat(ALERT_LIMITS.resourceLabelChars + 1) }] }))).toBe('resource_invalid');
    expect(codeOf(rawEvent({ resources: [{ kind: 'k'.repeat(32), id: 'x' }] }))).toBe('ok');
    expect(codeOf(rawEvent({ resources: [{ kind: 'k'.repeat(33), id: 'x' }] }))).toBe('resource_invalid');
  });

  it('strips control characters from ids and labels', () => {
    const r = parseAlertEvent(rawEvent({ resources: [{ kind: 'workload', id: 'wl\r\n001', label: 'a‮b' }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.resources[0]).toEqual({ kind: 'workload', id: 'wl 001', label: 'ab' });
  });
});

describe('parseAlertEvent: links', () => {
  const link = (url: string, label = 'Open') => ({ label, url });

  it('accepts 5 links and refuses 6', () => {
    const five = Array.from({ length: ALERT_LIMITS.links }, (_, i) => link(`https://ratio.example.com/f/${i}`));
    expect(codeOf(rawEvent({ links: five }))).toBe('ok');
    expect(codeOf(rawEvent({ links: [...five, link('https://ratio.example.com/f/6')] }))).toBe('too_many_links');
  });

  it('refuses a non-array links value', () => {
    expect(codeOf(rawEvent({ links: 'https://x.example' }))).toBe('links_invalid');
  });

  it.each([
    'http://ratio.example.com/x',
    'https://user:pw@ratio.example.com/x',
    'https://user@ratio.example.com/x',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://ratio.example.com/x',
    '//ratio.example.com/x',
    '/relative',
    'https://',
    'https://ratio.example.com/a b',
    'https://ratio.example.com\\@evil.example/',
    'https://ratio.example.com/é',
    '',
  ])('refuses link url %j', (url) => {
    expect(codeOf(rawEvent({ links: [link(url)] }))).toBe('link_invalid');
  });

  it('accepts a URL of exactly 2048 characters and refuses 2049', () => {
    const base = 'https://ratio.example.com/';
    expect(codeOf(rawEvent({ links: [link(base + 'a'.repeat(ALERT_LIMITS.linkUrlChars - base.length))] }))).toBe('ok');
    expect(codeOf(rawEvent({ links: [link(base + 'a'.repeat(ALERT_LIMITS.linkUrlChars - base.length + 1))] }))).toBe('link_invalid');
  });

  it('caps link labels at 80 characters and refuses empty labels and extra keys', () => {
    expect(codeOf(rawEvent({ links: [link('https://ratio.example.com/x', 'l'.repeat(ALERT_LIMITS.linkLabelChars))] }))).toBe('ok');
    expect(codeOf(rawEvent({ links: [link('https://ratio.example.com/x', 'l'.repeat(ALERT_LIMITS.linkLabelChars + 1))] }))).toBe('link_invalid');
    expect(codeOf(rawEvent({ links: [link('https://ratio.example.com/x', '')] }))).toBe('link_invalid');
    expect(codeOf(rawEvent({ links: [{ label: 'x', url: 'https://ratio.example.com/x', rel: 'a' }] }))).toBe('link_invalid');
  });

  it('stores the normalized href', () => {
    const r = parseAlertEvent(rawEvent({ links: [link('https://RATIO.example.com/a')] }));
    if (r.ok) expect(r.event.links[0].url).toBe('https://ratio.example.com/a');
    else throw new Error('expected ok');
  });
});

describe('parseAlertEvent: strictness', () => {
  it('refuses unknown fields', () => {
    expect(codeOf(rawEvent({ extra: 1 }))).toBe('unknown_field');
    expect(codeOf(rawEvent({ Tenant: 'x' }))).toBe('unknown_field');
  });

  it('refuses an own __proto__ key (as produced by JSON.parse) and does not pollute prototypes', () => {
    const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true},"tenant":"acme"}');
    expect(codeOf(hostile)).toBe('unknown_field');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([null, undefined, 'event', 5, true, [], [rawEvent()], new Map(), new Date(), () => 1])('refuses a non-object input %#', (input) => {
    expect(codeOf(input)).toBe('malformed');
  });

  it('refuses class instances (non-plain objects)', () => {
    class Evt {
      tenant = 'acme';
    }
    expect(codeOf(new Evt())).toBe('malformed');
  });

  it('does not throw on hostile accessors or proxies', () => {
    const getter = rawEvent();
    Object.defineProperty(getter, 'title', {
      enumerable: true,
      get() {
        throw new Error('boom CANARY');
      },
    });
    expect(codeOf(getter)).toBe('malformed');
    const proxy = new Proxy(rawEvent(), {
      ownKeys() {
        throw new Error('trap CANARY');
      },
    });
    expect(codeOf(proxy)).toBe('malformed');
  });

  it('accepts null-prototype records', () => {
    const rec = Object.assign(Object.create(null) as Record<string, unknown>, rawEvent());
    expect(codeOf(rec)).toBe('ok');
  });
});

describe('parseAlertEvent: fixed error text', () => {
  it('has a distinct fixed message for every code', () => {
    const texts = Object.values(ALERT_EVENT_ERROR_TEXT);
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) expect(t).toMatch(/^alert event /);
  });

  it('never echoes the offending input in the message', () => {
    const canary = 'CANARY<script>alert(1)</script>';
    const cases: unknown[] = [
      rawEvent({ tenant: canary }),
      rawEvent({ dedupeKey: canary }),
      rawEvent({ severity: canary }),
      rawEvent({ title: undefined, body: canary }),
      rawEvent({ occurredAt: canary }),
      rawEvent({ resources: [{ kind: canary, id: 'x' }] }),
      rawEvent({ links: [{ label: canary, url: canary }] }),
      rawEvent({ [canary]: 1 }),
    ];
    for (const c of cases) {
      const r = parseAlertEvent(c);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe(ALERT_EVENT_ERROR_TEXT[r.code]);
        expect(r.message).not.toContain('CANARY');
      }
    }
  });
});
