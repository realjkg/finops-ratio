// Pre-merge Lows (challenger approval round):
//   1. redactor: short-token leak cases restored as tests; case-insensitive
//      free-text Bearer / Basic; digit / base64 thresholds; more key names
//   2. proxy warning only for multi-hop X-Forwarded-For
//   3. Content-Length early reject
//   4. token strength: >= 32 chars AND >= 10 distinct characters; gateway
//      routes warn once instead of refusing

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { redactUpstreamText } from './transports/redact';
import { fetchChecked } from './transports/focusExport';
import { createHttpFocusTransport } from './transports/httpFocusTransport';

const ENV_KEYS = ['RATIO_API_TOKEN', 'RATIO_TRUSTED_PROXY_HOPS', 'KUBERNETES_FOCUS_ENDPOINT', 'AI_PROVIDER', 'CM_PROVIDER'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string | number) {
      res.headers[k.toLowerCase()] = String(v);
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}
function req(query: Record<string, string>, headers: Record<string, string> = {}, extra: { method?: string; body?: unknown } = {}) {
  return {
    method: extra.method ?? 'GET',
    url: '/api',
    query,
    headers,
    body: extra.body,
    socket: { remoteAddress: '192.0.2.9' },
  } as unknown as NextApiRequest;
}
type H = (a: NextApiRequest, b: NextApiResponse) => unknown;
async function hit(path: string, r: NextApiRequest) {
  const { default: h } = (await import(path)) as { default: H };
  const res = makeRes();
  await h(r, res as unknown as NextApiResponse);
  return res;
}

// ---------------------------------------------------------------------------
describe('1. redactor: short-token leak cases', () => {
  const cases: Array<[string, string, string]> = [
    ['lowercase bearer', 'auth failed: bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['uppercase BEARER', 'auth failed: BEARER abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['lowercase short bearer with digit', 'auth failed: bearer abc123short', 'abc123short'],
    ['Bearer abc123short', 'denied for Bearer abc123short', 'abc123short'],
    ['Bearer tok_9f8e7d6c5b', 'denied for Bearer tok_9f8e7d6c5b', 'tok_9f8e7d6c5b'],
    ['Basic dXNlcjpwYXNz', 'denied for Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['lowercase basic base64', 'denied for basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['JSON "token"', '{"token":"tk-short-1"}', 'tk-short-1'],
    ['session_token=', 'x session_token=sess-SECRET-7 y', 'sess-SECRET-7'],
    ['private_token=glpat-', 'private_token=glpat-AbCdEf123456', 'glpat-AbCdEf123456'],
    ['access_key=', 'access_key=ak-SECRET-9', 'ak-SECRET-9'],
    ['JSON access_key', '{"access_key": "ak-SECRET-10"}', 'ak-SECRET-10'],
  ];
  it.each(cases)('redacts %s', (_n, input, secret) => {
    expect(redactUpstreamText(input, 10_000)).not.toContain(secret);
  });

  it.each(['Basic Support plan', 'Bearer of costs', 'the Bearer token was rejected', 'Basic tier limits apply'])(
    'still leaves prose unchanged: %s',
    (text) => {
      expect(redactUpstreamText(text, 10_000)).toBe(text);
    },
  );

  it('the stub "Authorization: Bearer abc" never reaches the server log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn(async () => new Response('request echo: Authorization: Bearer abc', { status: 401 })) as unknown as typeof fetch;
    await expect(fetchChecked(f, 'https://x.example/p', {}, 'Feed')).rejects.toThrow(/401/);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('request echo');
    expect(logged).not.toMatch(/Bearer abc\b/);
  });
});

// ---------------------------------------------------------------------------
describe('2. proxy warning only for multi-hop X-Forwarded-For', () => {
  const TOKEN = 'live-token-0123456789abcdef-0123456789';
  const warnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c) => String(c[0]).includes('RATIO_TRUSTED_PROXY_HOPS'));

  it('a single hop (Next adds one itself) does not warn', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await hit('../../pages/api/costsource/health', req({ sourceId: 'kubernetes' }, { 'x-forwarded-for': '203.0.113.7' }));
    expect(warnings(warn)).toHaveLength(0);
  });

  it('more than one hop warns once', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await hit('../../pages/api/costsource/health', req({ sourceId: 'kubernetes' }, { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }));
    await hit('../../pages/api/costsource/health', req({ sourceId: 'kubernetes' }, { 'x-forwarded-for': '2.2.2.2, 203.0.113.7' }));
    expect(warnings(warn)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('3. Content-Length early reject', () => {
  it('a response advertising a too-large Content-Length is rejected before its body is read', async () => {
    const pull = vi.fn(() => {
      throw new Error('body must not be read');
    });
    // highWaterMark 0: the stream only pulls when someone actually reads it.
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const t = createHttpFocusTransport({
      endpoint: 'https://ncm.example/api/cost',
      label: 'Nutanix',
      maxObjectBytes: 64,
      fetch: vi.fn(async () => new Response(body, { headers: { 'content-length': '1000' } })) as unknown as typeof fetch,
    });
    await expect(t.fetchExportRows({ start: '2026-06-01', end: '2026-07-01' })).rejects.toThrow(
      'export too large: Nutanix (1000 > 64)',
    );
    expect(pull).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('4. token strength', () => {
  const MESSAGE = 'RATIO_API_TOKEN is too weak to serve live cost data (≥32 chars, ≥10 distinct)';
  const LOW_ENTROPY = 'abababababababababababababababababab'; // 36 chars, 2 distinct

  it('a long token with fewer than 10 distinct characters refuses live data (503)', async () => {
    process.env.RATIO_API_TOKEN = LOW_ENTROPY;
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await hit(
      '../../pages/api/costsource/rows',
      req({ sourceId: 'kubernetes', start: '2026-06-01', end: '2026-07-01' }, { authorization: `Bearer ${LOW_ENTROPY}` }),
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
    // Sandbox unaffected.
    expect((await hit('../../pages/api/costsource/rows', req({ sourceId: 'pointfive-sandbox', start: '2026-06-01', end: '2026-07-01' }))).statusCode).toBe(200);
  });

  it('a short token gets the same message', async () => {
    process.env.RATIO_API_TOKEN = 'short-token';
    const res = await hit('../../pages/api/costsource/health', req({ sourceId: 'kubernetes' }, { authorization: 'Bearer short-token' }));
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: MESSAGE });
  });

  it('gateway routes (AI chat) are NOT refused, but warn once about the weak token', async () => {
    process.env.RATIO_API_TOKEN = LOW_ENTROPY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = {
      messages: [{ role: 'user', content: 'hi' }],
      context: {
        initiatives: [],
        summary: { totalMonthlySpend: 0, projectedSavings: 0, initiativesActive: 0, pendingApproval: 0 },
        asOf: '2026-06-01T00:00:00.000Z',
      },
    };
    for (let i = 0; i < 2; i += 1) {
      const res = await hit('../../pages/api/v1/ai/chat', req({}, { authorization: `Bearer ${LOW_ENTROPY}` }, { method: 'POST', body }));
      expect(res.statusCode).toBe(200);
    }
    const weak = warn.mock.calls.filter((c) => /RATIO_API_TOKEN/.test(String(c[0])) && /weak/i.test(String(c[0])));
    expect(weak).toHaveLength(1);
  });
});
