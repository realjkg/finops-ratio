// Guarded HTTPS POST: pinning handed to the transport, redirects never followed,
// response and payload caps, timeouts, status classes, and result hygiene.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_REQUEST_BODY_BYTES,
  classifyStatus,
  drainCapped,
  parseRetryAfterMs,
  postGuarded,
  type HttpDeliveryDeps,
} from './httpDelivery';
import type { ChannelResult, PinnedHttpRequest } from './types';
import { PUBLIC_IP, SLACK_URL, flush, makeClock, makeHttp, makeResolver, makeSleep, secretsAbsent, type HttpHandler } from './testKit';

const HEADERS = { 'Content-Type': 'application/json' };

function setup(handler?: HttpHandler, extra: Partial<HttpDeliveryDeps> = {}) {
  const clock = makeClock();
  const sleeper = makeSleep(clock);
  const resolver = makeResolver({ 'hooks.slack.com': [PUBLIC_IP] });
  const http = makeHttp(handler);
  const deps: HttpDeliveryDeps = {
    resolve: resolver.resolve,
    http: http.transport,
    sleep: sleeper.sleep,
    policy: { allowedHosts: ['hooks.slack.com'] },
    ...extra,
  };
  return { deps, http, resolver, sleeper, clock };
}

function failure(r: ChannelResult) {
  if (r.ok) throw new Error('expected a failure');
  return r;
}

describe('postGuarded: request handed to the transport', () => {
  it('passes the checked address, SNI host, port and the no-redirect contract', async () => {
    const s = setup();
    const res = await postGuarded(SLACK_URL, '{"a":1}', HEADERS, s.deps);
    expect(res).toEqual({ ok: true, status: 200, host: 'hooks.slack.com' });
    expect(s.http.requests).toHaveLength(1);
    const req: PinnedHttpRequest = s.http.requests[0];
    expect(req.address).toBe(PUBLIC_IP);
    expect(req.family).toBe(4);
    expect(req.hostname).toBe('hooks.slack.com');
    expect(req.port).toBe(443);
    expect(req.method).toBe('POST');
    expect(req.redirect).toBe('manual');
    expect(req.url).toBe(SLACK_URL);
    expect(req.body).toBe('{"a":1}');
    expect(req.headers).toEqual(HEADERS);
    expect(req.timeoutMs).toBe(10_000);
    expect(req.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(req.signal.aborted).toBe(false);
  });

  it('does not echo the URL path or query in the result', async () => {
    const s = setup();
    const res = await postGuarded(SLACK_URL, '{}', HEADERS, s.deps);
    expect(secretsAbsent(res)).toBe(true);
  });

  it('resolves and re-checks DNS on every call, so a retry after a rebind is refused', async () => {
    const clock = makeClock();
    const sleeper = makeSleep(clock);
    const resolver = makeResolver({ 'hooks.slack.com': [[PUBLIC_IP], ['169.254.169.254']] });
    const http = makeHttp();
    const deps: HttpDeliveryDeps = { resolve: resolver.resolve, http: http.transport, sleep: sleeper.sleep, policy: {} };
    expect((await postGuarded(SLACK_URL, '{}', HEADERS, deps)).ok).toBe(true);
    const second = failure(await postGuarded(SLACK_URL, '{}', HEADERS, deps));
    expect(second).toMatchObject({ code: 'ssrf_denied', detail: 'blocked_metadata', retryable: false });
    expect(http.requests).toHaveLength(1);
    expect(resolver.calls).toHaveLength(2);
  });
});

describe('postGuarded: SSRF refusals never reach the transport', () => {
  it.each([
    ['http://hooks.slack.com/x', 'scheme_not_https', false],
    ['https://127.0.0.1/x', 'blocked_loopback', false],
    ['https://169.254.169.254/x', 'blocked_metadata', false],
    ['https://other.example.com/x', 'host_not_allowed', false],
    ['https://hooks.slack.com:6379/x', 'port_denied', false],
    ['https://user:pw@hooks.slack.com/x', 'userinfo_present', false],
    ['garbage', 'url_invalid', false],
  ] as const)('%s -> %s', async (url, detail, retryable) => {
    const s = setup();
    const res = failure(await postGuarded(url, '{}', HEADERS, s.deps));
    expect(res).toMatchObject({ code: 'ssrf_denied', detail, retryable });
    expect(s.http.requests).toHaveLength(0);
  });

  it('shows only the host of a refused URL', async () => {
    const s = setup();
    const res = failure(await postGuarded('https://user:CANARYPW@127.0.0.1/path?token=CANARY', '{}', HEADERS, s.deps));
    expect(res.host).toBe('127.0.0.1');
    expect(secretsAbsent(res)).toBe(true);
    expect(failure(await postGuarded('garbage', '{}', HEADERS, s.deps)).host).toBe('[invalid-host]');
  });

  it('a resolver failure or timeout is the only retryable SSRF class', async () => {
    const clock = makeClock();
    const sleeper = makeSleep(clock);
    const down = makeResolver({ 'hooks.slack.com': new Error('SERVFAIL') });
    const http = makeHttp();
    const deps: HttpDeliveryDeps = { resolve: down.resolve, http: http.transport, sleep: sleeper.sleep, policy: {} };
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, deps))).toMatchObject({ detail: 'dns_failed', retryable: true });
    expect(http.requests).toHaveLength(0);
  });
});

describe('postGuarded: redirects are never followed', () => {
  it.each([301, 302, 303, 307, 308])('a %i to a private target is reported as redirect_blocked and nothing else is requested', async (status) => {
    const s = setup(() => ({ status, bodyBytes: 0 }));
    const res = failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps));
    expect(res).toMatchObject({ code: 'redirect_blocked', retryable: false, status });
    expect(s.http.requests).toHaveLength(1);
    expect(s.http.requests.every((r) => r.hostname === 'hooks.slack.com')).toBe(true);
    expect(s.resolver.calls).toEqual(['hooks.slack.com']); // the redirect target was never resolved
  });
});

describe('postGuarded: status classes', () => {
  it.each([200, 201, 202, 204, 299])('%i succeeds', async (status) => {
    const s = setup(() => ({ status, bodyBytes: 0 }));
    expect(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps)).toMatchObject({ ok: true, status });
  });

  it.each([400, 401, 403, 404, 405, 410, 413, 422, 451])('%i is a permanent client error', async (status) => {
    const s = setup(() => ({ status, bodyBytes: 0 }));
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps))).toMatchObject({ code: 'http_client_error', retryable: false, status });
  });

  it.each([408, 425, 500, 502, 503, 504, 599])('%i is retryable', async (status) => {
    const s = setup(() => ({ status, bodyBytes: 0 }));
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps))).toMatchObject({ code: 'http_server_error', retryable: true, status });
  });

  it('429 is retryable and carries a parsed Retry-After', async () => {
    const s = setup(() => ({ status: 429, bodyBytes: 0, retryAfter: '30' }));
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps))).toMatchObject({
      code: 'http_rate_limited',
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it.each([100, 101, 199])('%i is an unexpected status', async (status) => {
    const s = setup(() => ({ status, bodyBytes: 0 }));
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps))).toMatchObject({ code: 'http_unexpected_status', retryable: false });
  });

  it('classifyStatus is a pure function of the response', () => {
    expect(classifyStatus({ status: 200, bodyBytes: 0 }, 'h', 10)).toEqual({ ok: true, status: 200, host: 'h' });
  });
});

describe('parseRetryAfterMs', () => {
  it.each([
    ['0', 0],
    ['1', 1000],
    [' 30 ', 30_000],
    ['9999999', 24 * 60 * 60_000],
  ])('%j -> %j', (value, ms) => {
    expect(parseRetryAfterMs(value)).toBe(ms);
  });

  it.each(['', '-1', '1.5', 'Wed, 21 Oct 2015 07:28:00 GMT', '12345678', '1e3', 'abc', undefined, 30])('%j is ignored', (value) => {
    expect(parseRetryAfterMs(value)).toBeUndefined();
  });
});

describe('postGuarded: response size cap', () => {
  it('accepts a response exactly at the cap and refuses one byte over', async () => {
    const at = setup(() => ({ status: 200, bodyBytes: DEFAULT_MAX_RESPONSE_BYTES }));
    expect((await postGuarded(SLACK_URL, '{}', HEADERS, at.deps)).ok).toBe(true);
    const over = setup(() => ({ status: 200, bodyBytes: DEFAULT_MAX_RESPONSE_BYTES + 1 }));
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, over.deps))).toMatchObject({ code: 'response_too_large', retryable: false });
  });

  it('refuses a transport-reported truncation and honors a smaller cap', async () => {
    const trunc = setup(() => ({ status: 200, bodyBytes: 10, bodyTruncated: true }));
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, trunc.deps)).code).toBe('response_too_large');
    const small = setup(() => ({ status: 200, bodyBytes: 11 }), { maxResponseBytes: 10 });
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, small.deps)).code).toBe('response_too_large');
    expect(small.http.requests[0].maxResponseBytes).toBe(10);
  });
});

describe('postGuarded: request payload cap', () => {
  it('accepts a body of exactly 128 KiB and refuses one byte more, counting bytes not characters', async () => {
    const s = setup();
    expect((await postGuarded(SLACK_URL, 'a'.repeat(MAX_REQUEST_BODY_BYTES), HEADERS, s.deps)).ok).toBe(true);
    const over = failure(await postGuarded(SLACK_URL, 'a'.repeat(MAX_REQUEST_BODY_BYTES + 1), HEADERS, s.deps));
    expect(over).toMatchObject({ code: 'payload_too_large', retryable: false });
    // 43,691 euro signs are 43,691 characters but 131,073 bytes.
    const multibyte = failure(await postGuarded(SLACK_URL, '€'.repeat(43_691), HEADERS, s.deps));
    expect(multibyte.code).toBe('payload_too_large');
    expect(s.http.requests).toHaveLength(1);
  });

  it('refuses an oversized body before any DNS lookup', async () => {
    const s = setup();
    await postGuarded(SLACK_URL, 'a'.repeat(MAX_REQUEST_BODY_BYTES + 1), HEADERS, s.deps);
    expect(s.resolver.calls).toEqual([]);
  });
});

describe('postGuarded: timeout and transport failures', () => {
  it('times out a hung transport on the injected sleep and aborts the request', async () => {
    const s = setup(() => new Promise(() => undefined), { timeoutMs: 2500 });
    const pending = postGuarded(SLACK_URL, '{}', HEADERS, s.deps);
    await flush();
    expect(s.http.requests).toHaveLength(1);
    expect(s.sleeper.timers.map((t) => t.ms)).toContain(2500);
    s.sleeper.fireTimers();
    const res = failure(await pending);
    expect(res).toMatchObject({ code: 'timeout', retryable: true, host: 'hooks.slack.com' });
    expect(s.http.requests[0].signal.aborted).toBe(true);
    expect(s.http.requests[0].timeoutMs).toBe(2500);
  });

  it('maps a throwing transport to a fixed code and never echoes its message', async () => {
    const s = setup(() => {
      throw new Error(`connect ECONNREFUSED ${SLACK_URL} token=CANARY`);
    });
    const res = failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps));
    expect(res).toMatchObject({ code: 'transport_error', retryable: true });
    expect(secretsAbsent(res)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ok'],
    ['string status', { status: '200', bodyBytes: 0 }],
    ['missing bodyBytes', { status: 200 }],
    ['status below 100', { status: 99, bodyBytes: 0 }],
    ['status above 599', { status: 600, bodyBytes: 0 }],
    ['fractional status', { status: 200.5, bodyBytes: 0 }],
    ['negative bodyBytes', { status: 200, bodyBytes: -1 }],
    ['NaN bodyBytes', { status: 200, bodyBytes: Number.NaN }],
  ])('treats a malformed transport response (%s) as a transport error', async (_name, value) => {
    const s = setup(() => value as never);
    expect(failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps))).toMatchObject({ code: 'transport_error', retryable: true });
  });

  it('never returns a response body: the result has only whitelisted keys', async () => {
    const s = setup(() => ({ status: 500, bodyBytes: 42, body: 'secret CANARY body' } as never));
    const res = failure(await postGuarded(SLACK_URL, '{}', HEADERS, s.deps));
    expect(Object.keys(res).sort()).toEqual(['code', 'host', 'ok', 'retryable', 'status']);
    expect(secretsAbsent(res)).toBe(true);
  });
});

describe('drainCapped (for transport authors)', () => {
  function streamOf(...chunks: number[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const n of chunks) controller.enqueue(new Uint8Array(n));
        controller.close();
      },
    });
  }

  it('counts and discards bytes up to the cap', async () => {
    expect(await drainCapped(streamOf(10, 10, 5), 25)).toEqual({ bytes: 25, truncated: false });
    expect(await drainCapped(streamOf(), 25)).toEqual({ bytes: 0, truncated: false });
    expect(await drainCapped(null, 25)).toEqual({ bytes: 0, truncated: false });
  });

  it('stops and cancels the stream one byte past the cap', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await drainCapped(stream, 25);
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(30);
    expect(cancelled).toBe(true);
  });
});
