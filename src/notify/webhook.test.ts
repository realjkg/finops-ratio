// Signed webhook: known-answer HMAC, sign/verify, tamper, replay window,
// wrong secret, rotation, constant-time compare, and channel behavior.

import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { parseAlertEvent } from './alertEvent';
import type { HttpChannelDeps } from './httpDelivery';
import {
  DEFAULT_TOLERANCE_SEC, MAX_VERIFY_BODY_BYTES, WEBHOOK_DELIVERY_HEADER, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER,
  buildWebhookBody, constantTimeEqual, createWebhookChannel, deliveryId, hmacSha256Hex, signWebhook, verifyWebhookSignature,
} from './webhook';
import { PUBLIC_IP_2, SIGNING_SECRET, T0, WEBHOOK_URL, makeClock, makeHttp, makeResolver, makeSecrets, makeSleep, rawEvent, secretsAbsent } from './testKit';

const SECRET = 'a-signing-secret-of-16+chars';
const BODY = '{"hello":"world"}';
const NOW = 1_780_000_000;

function signed(body = BODY, ts = NOW, secret = SECRET) {
  const s = signWebhook(secret, ts, body);
  return { timestamp: s.timestamp, signature: s.signature, body };
}

describe('HMAC signing', () => {
  it('matches the RFC 4231 test case 2 known answer', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
  it('signs "<timestamp>.<body>" as v1=<hex>', () => {
    const s = signWebhook(SECRET, NOW + 0.9, BODY);
    expect(s.timestamp).toBe(String(NOW));
    expect(s.signature).toBe(`v1=${createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex')}`);
  });
});

describe('verifyWebhookSignature', () => {
  const v = (o: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
    verifyWebhookSignature({ secrets: SECRET, nowSec: NOW, ...signed(), ...o });

  it('accepts a valid delivery, including a Uint8Array body', () => {
    expect(v()).toEqual({ ok: true });
    expect(v({ body: new TextEncoder().encode(BODY) })).toEqual({ ok: true });
  });
  it('rejects a tampered body, timestamp or signature byte', () => {
    expect(v({ body: BODY + ' ' })).toEqual({ ok: false, code: 'signature_mismatch' });
    expect(v({ body: '{"hello":"w0rld"}' })).toEqual({ ok: false, code: 'signature_mismatch' });
    expect(v({ timestamp: String(NOW + 1) })).toEqual({ ok: false, code: 'signature_mismatch' });
    const sig = signed().signature;
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect(v({ signature: flipped })).toEqual({ ok: false, code: 'signature_mismatch' });
  });
  it('rejects a wrong secret', () => {
    expect(v({ secrets: 'another-secret-16-chars-long' })).toEqual({ ok: false, code: 'signature_mismatch' });
  });
  it('enforces the replay window at the boundary', () => {
    const at = (skew: number) => v({ ...signed(BODY, NOW - skew) });
    expect(at(DEFAULT_TOLERANCE_SEC).ok).toBe(true);
    expect(at(DEFAULT_TOLERANCE_SEC + 1)).toEqual({ ok: false, code: 'stale_timestamp' });
    const future = (skew: number) => v({ ...signed(BODY, NOW + skew) });
    expect(future(DEFAULT_TOLERANCE_SEC).ok).toBe(true);
    expect(future(DEFAULT_TOLERANCE_SEC + 1)).toEqual({ ok: false, code: 'future_timestamp' });
  });
  it('re-signing an old body under a fresh timestamp is impossible without the secret', () => {
    const old = signed(BODY, NOW - 10_000);
    expect(v({ body: old.body, signature: old.signature, timestamp: String(NOW) })).toEqual({ ok: false, code: 'signature_mismatch' });
  });
  it('honors a custom tolerance and refuses invalid configuration', () => {
    expect(v({ ...signed(BODY, NOW - 30), toleranceSec: 30 }).ok).toBe(true);
    expect(v({ ...signed(BODY, NOW - 31), toleranceSec: 30 })).toEqual({ ok: false, code: 'stale_timestamp' });
    for (const bad of [{ toleranceSec: 0 }, { toleranceSec: 3601 }, { toleranceSec: Number.NaN }, { secrets: [] }, { secrets: '' }, { secrets: ['a', 'b', 'c', 'd', 'e'] }, { nowSec: Number.NaN }]) {
      expect(v(bad as never)).toEqual({ ok: false, code: 'config_invalid' });
    }
  });
  it('validates header formats with fixed codes', () => {
    expect(v({ timestamp: undefined })).toEqual({ ok: false, code: 'missing_timestamp' });
    expect(v({ timestamp: '' })).toEqual({ ok: false, code: 'missing_timestamp' });
    for (const t of ['abc', '-5', '1.5', '01', '1e9', ' 17', '1'.repeat(13)]) expect(v({ timestamp: t })).toEqual({ ok: false, code: 'bad_timestamp' });
    expect(v({ signature: undefined })).toEqual({ ok: false, code: 'missing_signature' });
    for (const s of ['abc', 'v2=' + 'a'.repeat(64), 'v1=' + 'a'.repeat(63), 'v1=' + 'g'.repeat(64), 'sha256=' + 'a'.repeat(64)]) {
      expect(v({ signature: s })).toEqual({ ok: false, code: 'bad_signature_format' });
    }
  });
  it('refuses an oversized body before hashing', () => {
    expect(v({ body: 'a'.repeat(MAX_VERIFY_BODY_BYTES + 1) })).toEqual({ ok: false, code: 'body_too_large' });
  });
  it('supports key rotation: old or new secret, and multiple signature tokens', () => {
    const oldSig = signed(BODY, NOW, 'old-secret-16-chars-xx');
    expect(v({ ...oldSig, secrets: ['new-secret-16-chars-xx', 'old-secret-16-chars-xx'] }).ok).toBe(true);
    const two = `${signed(BODY, NOW, 'other-secret-16-chars').signature} ${signed().signature}`;
    expect(v({ signature: two }).ok).toBe(true);
    expect(v({ signature: `${two},${two},${two},${two},${two}` })).toEqual({ ok: false, code: 'bad_signature_format' });
  });
  it('result and codes never contain the secret', () => {
    expect(secretsAbsent(v({ secrets: 'CANARY-secret-16-chars' }))).toBe(true);
  });
});

describe('constantTimeEqual', () => {
  it('compares equal and unequal bytes, and different lengths', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([4, 2, 3]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('createWebhookChannel', () => {
  function setup(secrets: Record<string, string | Error> = { 'notify/hook-url': WEBHOOK_URL, 'notify/hook-secret': SIGNING_SECRET }, status = 200) {
    const clock = makeClock(T0);
    const sleeper = makeSleep(clock);
    const resolver = makeResolver({ 'alerts.customer.example': [PUBLIC_IP_2] });
    const http = makeHttp(() => ({ status, bodyBytes: 0 }));
    const store = makeSecrets(secrets);
    const deps: HttpChannelDeps & { clock: typeof clock } = {
      secrets: store.store, resolve: resolver.resolve, http: http.transport, sleep: sleeper.sleep, clock,
      policy: { allowedHosts: ['alerts.customer.example'] },
    };
    return { channel: createWebhookChannel({ id: 'hook-main', urlHandle: 'notify/hook-url', secretHandle: 'notify/hook-secret' }, deps), http, store, resolver };
  }
  const ev = () => { const r = parseAlertEvent(rawEvent()); if (!r.ok) throw new Error('fixture'); return r.event; };
  const ctx = { tenant: 'acme', attempt: 1 };

  it('sends a body that a receiver verifies with the same secret', async () => {
    const s = setup();
    expect(await s.channel.send(ev(), ctx)).toMatchObject({ ok: true, host: 'alerts.customer.example' });
    const req = s.http.requests[0];
    expect(req.address).toBe(PUBLIC_IP_2);
    expect(req.body).toBe(buildWebhookBody(ev()));
    const h = req.headers;
    expect(h[WEBHOOK_TIMESTAMP_HEADER]).toBe(String(Math.floor(T0 / 1000)));
    expect(h[WEBHOOK_DELIVERY_HEADER]).toBe(deliveryId('acme', 'budget_hard:wl-001:2026-06', 'critical'));
    expect(verifyWebhookSignature({ secrets: SIGNING_SECRET, timestamp: h[WEBHOOK_TIMESTAMP_HEADER], signature: h[WEBHOOK_SIGNATURE_HEADER], body: req.body, nowSec: T0 / 1000 + 5 })).toEqual({ ok: true });
    expect(verifyWebhookSignature({ secrets: 'wrong-secret-16-chars', timestamp: h[WEBHOOK_TIMESTAMP_HEADER], signature: h[WEBHOOK_SIGNATURE_HEADER], body: req.body, nowSec: T0 / 1000 }).ok).toBe(false);
    expect(Object.values(h).join('|')).not.toContain(SIGNING_SECRET);
    expect(JSON.parse(req.body).id).toBe(h[WEBHOOK_DELIVERY_HEADER]);
  });
  it('delivery id is stable per alert and differs by tenant, key or severity', () => {
    expect(deliveryId('a', 'k', 'info')).toBe(deliveryId('a', 'k', 'info'));
    expect(new Set([deliveryId('a', 'k', 'info'), deliveryId('b', 'k', 'info'), deliveryId('a', 'j', 'info'), deliveryId('a', 'k', 'warning')]).size).toBe(4);
  });
  it('fails closed on missing or short secrets and never leaks them', async () => {
    expect(await setup({ 'notify/hook-secret': SIGNING_SECRET }).channel.send(ev(), ctx)).toEqual({ ok: false, code: 'secret_missing', retryable: false });
    expect(await setup({ 'notify/hook-url': WEBHOOK_URL }).channel.send(ev(), ctx)).toEqual({ ok: false, code: 'secret_missing', retryable: false });
    const short = setup({ 'notify/hook-url': WEBHOOK_URL, 'notify/hook-secret': 'short' });
    expect(await short.channel.send(ev(), ctx)).toEqual({ ok: false, code: 'secret_invalid', retryable: false });
    expect(short.http.requests).toHaveLength(0);
    const down = await setup({ 'notify/hook-url': new Error(WEBHOOK_URL), 'notify/hook-secret': SIGNING_SECRET }).channel.send(ev(), ctx);
    expect(down).toEqual({ ok: false, code: 'secret_unavailable', retryable: true });
    expect(secretsAbsent(down)).toBe(true);
  });
  it('applies the SSRF guard and cross-tenant refusal', async () => {
    const s = setup({ 'notify/hook-url': 'https://10.0.0.1/x', 'notify/hook-secret': SIGNING_SECRET });
    expect(await s.channel.send(ev(), ctx)).toMatchObject({ code: 'ssrf_denied', detail: 'blocked_private' });
    expect(s.http.requests).toHaveLength(0);
    const t = setup();
    expect(await t.channel.send(ev(), { tenant: 'other', attempt: 1 })).toMatchObject({ code: 'internal_error' });
  });
  it('redirect responses are not followed', async () => {
    const s = setup(undefined, 302);
    expect(await s.channel.send(ev(), ctx)).toMatchObject({ code: 'redirect_blocked', retryable: false });
    expect(s.http.requests).toHaveLength(1);
  });
});
