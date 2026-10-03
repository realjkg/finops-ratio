// withGateway integration tests — the guard chain in isolation with a trivial
// handler. Covers method guard, auth pass/fail, the offline mock bypass, input
// validation, and the rate-limit 429 path. Lives under src/ so Next never
// compiles it as a deployed route (the Wave2b lesson).

import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withGateway, type GatewayHandler } from './withGateway';
import { SlidingWindowRateLimiter } from './rateLimit';

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  headersSent: boolean;
}

function makeRes(): NextApiResponse & FakeRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    setHeader(key: string, value: string | number) {
      res.headers[key.toLowerCase()] = String(value);
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
  return res as unknown as NextApiResponse & FakeRes;
}

function makeReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    url: '/api/v1/ai/chat',
    headers: opts.headers ?? {},
    body: opts.body,
  } as unknown as NextApiRequest;
}

const okHandler: GatewayHandler = (_req, res) => {
  res.status(200).json({ ok: true });
};

const noopLogger = () => {};
const acceptBody = () => ({ ok: true }) as const;

function errorBody(res: NextApiResponse & FakeRes): { code: string; message: string } {
  return (res.body as { error: { code: string; message: string } }).error;
}

describe('withGateway', () => {
  it('returns 405 on a disallowed method', async () => {
    const handler = withGateway(okHandler, {
      methods: ['POST'],
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
    });
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
    expect(errorBody(res).code).toBe('method_not_allowed');
    expect(res.headers.allow).toBe('POST');
  });

  it('bypasses auth for the offline mock (no token, mock provider)', async () => {
    const handler = withGateway(okHandler, {
      env: {}, // no RATIO_API_TOKEN, AI_PROVIDER unset → mock
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: acceptBody,
    });
    const res = makeRes();
    await handler(makeReq({ body: { valid: true } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a missing token with 401 when a token is configured', async () => {
    const handler = withGateway(okHandler, {
      env: { RATIO_API_TOKEN: 'secret' },
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
    });
    const res = makeRes();
    await handler(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(401);
    expect(errorBody(res).code).toBe('unauthorized');
  });

  it('rejects an invalid token with 401', async () => {
    const handler = withGateway(okHandler, {
      env: { RATIO_API_TOKEN: 'secret' },
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
    });
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: 'Bearer wrong' }, body: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid token', async () => {
    const handler = withGateway(okHandler, {
      env: { RATIO_API_TOKEN: 'secret' },
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: acceptBody,
    });
    const res = makeRes();
    await handler(
      makeReq({ headers: { authorization: 'Bearer secret' }, body: { valid: true } }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 with a structured envelope on invalid body', async () => {
    const handler = withGateway(okHandler, {
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: (body) =>
        body && (body as { valid?: boolean }).valid
          ? { ok: true }
          : { ok: false, message: 'bad body' },
    });
    const res = makeRes();
    await handler(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(errorBody(res).code).toBe('invalid_request');
    expect(errorBody(res).message).toBe('bad body');
  });

  it('returns 429 with Retry-After once the rate limit is exceeded', async () => {
    const handler = withGateway(okHandler, {
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(1, 60_000, () => 1000),
      validateBody: acceptBody,
    });
    const first = makeRes();
    await handler(makeReq({ body: { valid: true } }), first);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('1');

    const second = makeRes();
    await handler(makeReq({ body: { valid: true } }), second);
    expect(second.statusCode).toBe(429);
    expect(errorBody(second).code).toBe('rate_limited');
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('returns a 500 envelope (no stack trace) when the handler throws', async () => {
    const throwing: GatewayHandler = () => {
      throw new Error('boom');
    };
    const handler = withGateway(throwing, {
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: acceptBody,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ body: { valid: true } }), res);
    expect(res.statusCode).toBe(500);
    // Generic envelope: the thrown message never reaches the caller.
    const body = errorBody(res) as { code: string; message: string; requestId?: string };
    expect(body).toEqual({ code: 'internal_error', message: 'Internal error', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain('boom');
    // ...but it IS in the structured server log, keyed by the same requestId.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(logged.requestId).toBe(body.requestId);
    expect(logged.error).toBe('boom');
    errSpy.mockRestore();
  });

  it('500: requestId is a random UUID, echoed in X-Request-Id, unique per request', async () => {
    const throwing: GatewayHandler = () => {
      throw new Error('kaboom');
    };
    const handler = withGateway(throwing, {
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: acceptBody,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = makeRes();
    const b = makeRes();
    await handler(makeReq({ body: { valid: true } }), a);
    await handler(makeReq({ body: { valid: true } }), b);
    const idA = (a.body as { error: { requestId: string } }).error.requestId;
    const idB = (b.body as { error: { requestId: string } }).error.requestId;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(idA).toMatch(UUID);
    expect(idB).toMatch(UUID);
    expect(idA).not.toBe(idB);
    expect(a.headers['x-request-id']).toBe(idA);
    expect(b.headers['x-request-id']).toBe(idB);
    errSpy.mockRestore();
  });

  it('500: the server log line is structured JSON with the redacted message and request context', async () => {
    const throwing: GatewayHandler = () => {
      throw new Error('upstream said Bearer abc.def.SECRETTOKEN123 at https://h.example/p?sig=SASSECRET');
    };
    const handler = withGateway(throwing, {
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: acceptBody,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ body: { valid: true } }), res);
    const line = String(errSpy.mock.calls[0][0]);
    const logged = JSON.parse(line) as Record<string, unknown>;
    expect(logged).toMatchObject({ tag: 'gateway', event: 'unhandled_error', method: 'POST', path: '/api/v1/ai/chat', status: 500 });
    expect(logged.error).toContain('upstream said');
    expect(line).not.toContain('SECRETTOKEN123');
    expect(line).not.toContain('SASSECRET');
    expect(JSON.stringify(res.body)).not.toContain('upstream said');
    errSpy.mockRestore();
  });

  it('500: a non-Error throw is still generic to the caller', async () => {
    const throwing: GatewayHandler = () => {
      throw 'raw string detail';
    };
    const handler = withGateway(throwing, {
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: acceptBody,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ body: { valid: true } }), res);
    expect(res.statusCode).toBe(500);
    expect(errorBody(res).message).toBe('Internal error');
    expect(JSON.stringify(res.body)).not.toContain('raw string detail');
    expect(String(errSpy.mock.calls[0][0])).toContain('raw string detail');
    errSpy.mockRestore();
  });

  it('4xx envelopes produced by the gateway itself are unchanged (no requestId, no X-Request-Id)', async () => {
    const handler = withGateway(okHandler, {
      env: {},
      logger: noopLogger,
      limiter: new SlidingWindowRateLimiter(),
      validateBody: () => ({ ok: false, message: 'Body must have x' }),
    });
    const res = makeRes();
    await handler(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'invalid_request', message: 'Body must have x' } });
    expect(res.headers['x-request-id']).toBeUndefined();
  });
});

