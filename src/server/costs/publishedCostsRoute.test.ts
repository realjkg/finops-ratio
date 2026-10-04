// GET /api/v1/costs/published — everything decided BEFORE the database:
// authentication (the repo's existing live-data Bearer auth), the server-side
// tenant binding, configuration and input validation. The pool factory is a
// spy that fails the test if it is ever called on these paths.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiHandler } from 'next';
import { createPublishedCostsRoute, ROUTE_MESSAGES } from './publishedCostsRoute';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';
import { UnsafeReaderLoginError } from './readerLogin';
import routeFromPages from '../../../pages/api/v1/costs/published';

const TENANT = '11111111-1111-4111-8111-111111111111';
const READER_URL = 'postgres://reader@127.0.0.1:1/ratio';
const BASE_ENV = { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: READER_URL };

let poolFor: ReturnType<typeof vi.fn>;
function route(env: Record<string, string | undefined> = BASE_ENV): NextApiHandler {
  return createPublishedCostsRoute({ env, poolFor: poolFor as never, logger: () => undefined });
}

let addr = 0;
/** A unique client address per request, so the shared failed-auth counter never throttles unrelated tests. */
const ip = () => `10.77.${Math.floor(++addr / 250) % 250}.${addr % 250}`;

beforeEach(() => {
  poolFor = vi.fn(() => {
    throw new Error('the database must not be touched on this path');
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

describe('R1 authentication is required (existing live-data Bearer auth, deny by default)', () => {
  it('no RATIO_API_TOKEN configured ⇒ 401 even with a header, and no DB work', async () => {
    const res = await call(route({ ...BASE_ENV, RATIO_API_TOKEN: undefined }), makeReq({ headers: bearer(), remoteAddress: ip() }));
    expect(res.statusCode).toBe(401);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('no Authorization header ⇒ 401', async () => {
    const res = await call(route(), makeReq({ remoteAddress: ip() }));
    expect(res.statusCode).toBe(401);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('wrong token ⇒ 401; malformed scheme ⇒ 401', async () => {
    for (const authorization of [`Bearer ${TEST_API_TOKEN}x`, `Bearer ${TEST_API_TOKEN.slice(1)}`, `Basic ${TEST_API_TOKEN}`, TEST_API_TOKEN, 'Bearer ']) {
      const res = await call(route(), makeReq({ headers: { authorization }, remoteAddress: ip() }));
      expect(res.statusCode, authorization).toBe(401);
    }
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('a token in the query string is not a credential (unknown param ⇒ never served)', async () => {
    const res = await call(route(), makeReq({ query: { token: TEST_API_TOKEN }, remoteAddress: ip() }));
    expect(res.statusCode).toBe(401);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('a weak configured token refuses cost data (503 weak_token), even when presented correctly', async () => {
    const weak = 'short-token';
    const res = await call(route({ ...BASE_ENV, RATIO_API_TOKEN: weak }), makeReq({ headers: bearer(weak), remoteAddress: ip() }));
    expect(res.statusCode).toBe(503);
    expect(errorCode(res.body)).toBe('weak_token');
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('repeated failures from one client are throttled (429 + Retry-After); a valid token still passes', async () => {
    const client = '10.250.250.250';
    let last = 0;
    for (let i = 0; i < 1001; i += 1) {
      last = (await call(route(), makeReq({ headers: { authorization: 'Bearer wrong' }, remoteAddress: client }))).statusCode;
    }
    expect(last).toBe(429);
    const throttled = await call(route(), makeReq({ headers: { authorization: 'Bearer wrong' }, remoteAddress: client }));
    expect(throttled.statusCode).toBe(429);
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
    // The legitimate holder is never locked out: valid token, same client, gets past auth (here: to validation).
    const valid = await call(route(), makeReq({ headers: bearer(), query: { limit: '0' }, remoteAddress: client }));
    expect(valid.statusCode).toBe(400);
    expect(poolFor).not.toHaveBeenCalled();
  });
});

describe('R2 method and configuration', () => {
  it('only GET (405 + Allow: GET)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call(route(), makeReq({ method, headers: bearer(), remoteAddress: ip() }));
      expect(res.statusCode, method).toBe(405);
      expect(res.headers.allow).toBe('GET');
    }
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('no tenant binding ⇒ 503 not_configured (the tenant is never taken from the request)', async () => {
    for (const RATIO_API_TENANT_ID of [undefined, '', 'tnt_abc123', 'not-a-uuid', `${TENANT} `, `{${TENANT}}`, '11111111111141118111111111111111']) {
      const res = await call(route({ ...BASE_ENV, RATIO_API_TENANT_ID }), makeReq({ headers: bearer(), remoteAddress: ip() }));
      expect(res.statusCode, String(RATIO_API_TENANT_ID)).toBe(503);
      expect(errorCode(res.body)).toBe('not_configured');
      expect(JSON.stringify(res.body)).toBe(JSON.stringify({ error: { code: 'not_configured', message: ROUTE_MESSAGES.notConfigured } }));
    }
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('no reader database URL ⇒ 503 not_configured', async () => {
    for (const RATIO_READER_DATABASE_URL of [undefined, '', '   ']) {
      const res = await call(route({ ...BASE_ENV, RATIO_READER_DATABASE_URL }), makeReq({ headers: bearer(), remoteAddress: ip() }));
      expect(res.statusCode).toBe(503);
      expect(errorCode(res.body)).toBe('not_configured');
    }
    expect(poolFor).not.toHaveBeenCalled();
  });
});

describe('R3 input validation through the route (400, fixed message, no DB work)', () => {
  it('a tenant query parameter is refused, not honoured', async () => {
    const res = await call(route(), makeReq({ headers: bearer(), query: { tenant: '22222222-2222-4222-8222-222222222222' }, remoteAddress: ip() }));
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe('invalid_request');
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('bad values ⇒ 400 and the body never echoes them', async () => {
    const hostile = '<script>EVIL</script>';
    const queries: Array<Record<string, string | string[]>> = [{ limit: '0' }, { limit: '501' }, { period: hostile }, { from: '2026-08', to: '2026-07' }, { cursor: hostile }, { limit: ['1', '2'] }];
    for (const query of queries) {
      const res = await call(route(), makeReq({ headers: bearer(), query, remoteAddress: ip() }));
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expect(errorCode(res.body)).toBe('invalid_request');
      expect(JSON.stringify(res.body)).not.toContain('EVIL');
    }
    expect(poolFor).not.toHaveBeenCalled();
  });
});

describe('R5 an unsafe database login is a distinct, logged 503 (challenger Low 3)', () => {
  it('503 unsafe_db_login with a requestId (body + X-Request-Id); one unsafe_db_login event with reason codes, no role names; never logged as unhandled_error/500', async () => {
    const err = vi.mocked(console.error);
    const warn = vi.mocked(console.warn);
    const unsafe = new UnsafeReaderLoginError(
      ['connected role has unsafe capabilities: pg_monitor', 'connected role is a member of ratio_owner (could disable RLS)'],
      ['REFUSED_PREDEFINED_ROLE', 'OWNER_MEMBER'],
    );
    const pool = { connect: vi.fn(async () => Promise.reject(unsafe)) };
    const route = createPublishedCostsRoute({ env: BASE_ENV, poolFor: () => pool as never, logger: () => undefined });
    const res = await call(route, makeReq({ headers: bearer(), remoteAddress: ip() }));
    expect(res.statusCode).toBe(503);
    const body = res.body as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('unsafe_db_login');
    expect(body.error.message).toBe(ROUTE_MESSAGES.unsafeLogin);
    expect(body.error.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);

    const lines = [...err.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.filter((e) => e.event === 'unhandled_error')).toEqual([]);
    const ev = events.filter((e) => e.event === 'unsafe_db_login');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ tag: 'published-costs', status: 503, requestId: body.error.requestId, reasons: ['REFUSED_PREDEFINED_ROLE', 'OWNER_MEMBER'] });
    const text = lines.join('\n');
    expect(text).not.toMatch(/pg_monitor|ratio_owner|ratio_reader|ratio_worker|postgres:/);
  });
});

describe('R6 no response of the route is cacheable (Cache-Control: no-store), errors included', () => {
  it('401, 429, 503 weak token, 405, 400, 503 not_configured, 503 unsafe_db_login and 500 all carry no-store', async () => {
    const unsafe = { connect: vi.fn(async () => Promise.reject(new UnsafeReaderLoginError(['x'], ['UNCLASSIFIED']))) };
    const broken = { connect: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const throttledClient = '10.250.250.251';
    for (let i = 0; i < 1001; i += 1) await call(route(), makeReq({ headers: { authorization: 'Bearer wrong' }, remoteAddress: throttledClient }));
    const cases: Array<[string, () => Promise<{ statusCode: number; headers: Record<string, string> }>, number]> = [
      ['401', () => call(route(), makeReq({ remoteAddress: ip() })), 401],
      ['429', () => call(route(), makeReq({ headers: { authorization: 'Bearer wrong' }, remoteAddress: throttledClient })), 429],
      ['503 weak', () => call(route({ ...BASE_ENV, RATIO_API_TOKEN: 'weak' }), makeReq({ headers: bearer('weak'), remoteAddress: ip() })), 503],
      ['405', () => call(route(), makeReq({ method: 'POST', headers: bearer(), remoteAddress: ip() })), 405],
      ['400', () => call(route(), makeReq({ headers: bearer(), query: { limit: '0' }, remoteAddress: ip() })), 400],
      ['503 not_configured', () => call(route({ ...BASE_ENV, RATIO_API_TENANT_ID: undefined }), makeReq({ headers: bearer(), remoteAddress: ip() })), 503],
      [
        '503 unsafe_db_login',
        () => call(createPublishedCostsRoute({ env: BASE_ENV, poolFor: () => unsafe as never, logger: () => undefined }), makeReq({ headers: bearer(), remoteAddress: ip() })),
        503,
      ],
      ['500', () => call(createPublishedCostsRoute({ env: BASE_ENV, poolFor: () => broken as never, logger: () => undefined }), makeReq({ headers: bearer(), remoteAddress: ip() })), 500],
    ];
    for (const [name, run, status] of cases) {
      const res = await run();
      expect(res.statusCode, name).toBe(status);
      expect(res.headers['cache-control'], name).toBe('no-store');
    }
  });
});

describe('R4 the page route is the factory default', () => {
  it('pages/api/v1/costs/published.ts exports a handler that refuses an anonymous request', async () => {
    const saved = process.env.RATIO_API_TOKEN;
    delete process.env.RATIO_API_TOKEN;
    try {
      const res = await call(routeFromPages, makeReq({ remoteAddress: ip() }));
      expect(res.statusCode).toBe(401);
    } finally {
      if (saved === undefined) delete process.env.RATIO_API_TOKEN;
      else process.env.RATIO_API_TOKEN = saved;
    }
  });
});
