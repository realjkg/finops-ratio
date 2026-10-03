// The error path itself must be total: ANY thrown JS value — including ones
// whose rendering throws (Object.create(null), throwing toString / getters,
// hostile Proxies) — still produces the generic 500 envelope + requestId,
// through withGateway and through a non-gateway route.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withGateway } from './gateway/withGateway';
import { SlidingWindowRateLimiter } from './gateway/rateLimit';
import { MockCostSourceClient } from '@/costsource/MockCostSourceClient';
import { redactErrorText } from '@/costsource/transports/redact';
import rowsHandler from '../../pages/api/costsource/rows';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FALLBACK = '[unrenderable thrown value]';

const hostileProxy = () =>
  new Proxy(
    {},
    {
      get() {
        throw new Error('get trap');
      },
      getPrototypeOf() {
        throw new Error('getPrototypeOf trap');
      },
      has() {
        throw new Error('has trap');
      },
      ownKeys() {
        throw new Error('ownKeys trap');
      },
    },
  );

function errorWithThrowingMessage(): Error {
  const e = new Error('x');
  Object.defineProperty(e, 'message', {
    get() {
      throw new Error('message getter');
    },
  });
  return e;
}

/** [label, thrown value factory, expected rendering in the log (or null for "anything")] */
const THROWN: Array<[string, () => unknown, string | null]> = [
  ['Object.create(null)', () => Object.create(null), FALLBACK],
  ['object with throwing toString', () => ({ toString: () => { throw new Error('ts'); } }), FALLBACK],
  ['object with non-callable toString', () => ({ toString: 1, valueOf: 2 }), FALLBACK],
  ['hostile Proxy', hostileProxy, FALLBACK],
  ['Error with throwing message getter', errorWithThrowingMessage, FALLBACK],
  ['Error whose message is an unrenderable object', () => Object.assign(new Error('x'), { message: Object.create(null) }), FALLBACK],
  ['Symbol', () => Symbol('sym-desc'), 'Symbol(sym-desc)'],
  ['BigInt', () => BigInt(42), '42'],
  ['undefined', () => undefined, 'undefined'],
  ['null', () => null, 'null'],
];

let errSpy: { mock: { calls: unknown[][] } };
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

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

function req(): NextApiRequest {
  return {
    method: 'GET',
    url: '/api/costsource/rows',
    query: { sourceId: 'pointfive-sandbox', start: '2026-06-01', end: '2026-07-01' },
    headers: { 'x-forwarded-for': '192.0.2.90' },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function loggedError(requestId: string): string {
  const line = errSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes(requestId));
  expect(line).toBeDefined();
  return String((JSON.parse(line as string) as { error: unknown }).error);
}

describe('redactErrorText is total', () => {
  it.each(THROWN)('%s', (_l, make, expected) => {
    const out = redactErrorText(make());
    expect(typeof out).toBe('string');
    if (expected !== null) expect(out).toBe(expected);
  });
});

describe('withGateway: unrenderable throws still get the generic 500', () => {
  it.each(THROWN)('%s', async (_l, make, expected) => {
    const handler = withGateway(
      () => {
        throw make();
      },
      { methods: ['GET'], env: {}, limiter: new SlidingWindowRateLimiter(), logger: () => {} },
    );
    const res = makeRes();
    await expect(handler(req(), res as unknown as NextApiResponse)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: { code: string; message: string; requestId: string } };
    expect(body.error).toEqual({ code: 'internal_error', message: 'Internal error', requestId: expect.stringMatching(UUID) });
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
    if (expected !== null) expect(loggedError(body.error.requestId)).toBe(expected);
  });
});

describe('non-gateway route: unrenderable throws still get the generic 500', () => {
  it.each(THROWN)('%s', async (_l, make, expected) => {
    vi.spyOn(MockCostSourceClient.prototype, 'fetchCostRows').mockImplementation(() => Promise.reject(make()));
    const res = makeRes();
    await expect(rowsHandler(req(), res as unknown as NextApiResponse)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: string; requestId: string };
    expect(body).toEqual({ error: 'Internal error', requestId: expect.stringMatching(UUID) });
    expect(res.headers['x-request-id']).toBe(body.requestId);
    if (expected !== null) expect(loggedError(body.requestId)).toBe(expected);
  });
});
