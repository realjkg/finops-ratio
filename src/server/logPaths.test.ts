// Server logs record the request PATHNAME only — never the query string, which
// can carry session ids, OAuth tokens or SAS signatures. Covers the gateway's
// per-request log, its 500 log, and the shared non-gateway 500 / 4xx-detail logs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withGateway } from './gateway/withGateway';
import { SlidingWindowRateLimiter } from './gateway/rateLimit';
import { logClientErrorDetail, logInternalError, sendInternalError } from './gateway/internalError';
import rowsHandler from '../../pages/api/costsource/rows';

const QUERY = '?sessionId=SESSVALUE123&access_token=ATVALUE456&sig=SIGVALUE789&x=PLAINVALUE0';
const VALUES = ['SESSVALUE123', 'ATVALUE456', 'SIGVALUE789', 'PLAINVALUE0'];

let lines: string[];
beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'log').mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

function expectNoQueryValues() {
  const all = lines.join('\n');
  expect(lines.length).toBeGreaterThan(0);
  for (const v of VALUES) expect(all).not.toContain(v);
  expect(all).not.toContain('sessionId=');
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = String(v);
    },
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(p: unknown) {
      res.body = p;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function req(url: string, extra: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'GET',
    url,
    query: {},
    headers: { 'x-forwarded-for': '192.0.2.44' },
    socket: { remoteAddress: '127.0.0.1' },
    ...extra,
  } as unknown as NextApiRequest;
}

describe('logs never contain the query string', () => {
  it('gateway: a throwing request logs the pathname only (500 log + request log)', async () => {
    const handler = withGateway(
      () => {
        throw new Error('boom');
      },
      { methods: ['GET'], env: {}, limiter: new SlidingWindowRateLimiter() },
    );
    const res = makeRes();
    await handler(req(`/api/v1/finio/export${QUERY}`), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(500);
    expectNoQueryValues();
    const parsed = lines.map((l) => JSON.parse(l) as { path?: string });
    expect(parsed.every((p) => p.path === '/api/v1/finio/export')).toBe(true);
  });

  it('gateway: a normal request with ?sessionId= is logged without it', async () => {
    const handler = withGateway(
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
      { methods: ['GET'], env: {}, limiter: new SlidingWindowRateLimiter() },
    );
    const res = makeRes();
    await handler(req(`/api/v1/finio/export${QUERY}`), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(200);
    expectNoQueryValues();
    expect(JSON.parse(lines[0]).path).toBe('/api/v1/finio/export');
  });

  it('non-gateway: sendInternalError logs the pathname only', () => {
    const res = makeRes();
    sendInternalError(req(`/api/costsource/rows${QUERY}`), res as unknown as NextApiResponse, new Error('x'));
    expectNoQueryValues();
    expect(JSON.parse(lines[0]).path).toBe('/api/costsource/rows');
  });

  it('logInternalError / logClientErrorDetail strip a query from ctx.path', () => {
    logInternalError(new Error('x'), { method: 'GET', path: `/a/b${QUERY}` });
    logClientErrorDetail(409, new Error('y'), { method: 'GET', path: `/a/b${QUERY}` });
    expectNoQueryValues();
    for (const l of lines) expect(JSON.parse(l).path).toBe('/a/b');
  });

  it('rows route 4xx detail log (unknown source) carries no query values', async () => {
    const saved = process.env.RATIO_API_TOKEN;
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    try {
      const res = makeRes();
      await rowsHandler(
        req(`/api/costsource/rows${QUERY}`, {
          query: { sourceId: 'no-such-source', start: '2026-06-01', end: '2026-07-01' },
          headers: { authorization: 'Bearer right-token-0123456789abcdef-0123456789', 'x-forwarded-for': '192.0.2.45' },
        }),
        res as unknown as NextApiResponse,
      );
      expect(res.statusCode).toBe(404);
      expectNoQueryValues();
    } finally {
      if (saved === undefined) delete process.env.RATIO_API_TOKEN;
      else process.env.RATIO_API_TOKEN = saved;
    }
  });
});
