// GET /api/v1/reports/facts: everything decided BEFORE the database. Same
// existing live-data Bearer auth, gateway and server-side tenant binding as
// GET /api/v1/costs/published (the factory is shared); the pool factory is a
// spy that fails the test if it is ever called on these paths.
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiHandler } from 'next';
import { createReportFactsRoute, parseReportFactsQuery, REPORT_FACTS_QUERY_MESSAGE } from './reportFactsRoute';
import { ROUTE_MESSAGES } from './publishedCostsRoute';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';
import routeFromPages from '../../../pages/api/v1/reports/facts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const READER_URL = 'postgres://reader@127.0.0.1:1/ratio';
const BASE_ENV = { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: READER_URL };
const ENGAGEMENT = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');

let poolFor: ReturnType<typeof vi.fn>;
const route = (env: Record<string, string | undefined> = BASE_ENV): NextApiHandler => createReportFactsRoute({ env, poolFor: poolFor as never, logger: () => undefined });
let addr = 0;
const ip = () => `10.78.${Math.floor(++addr / 250) % 250}.${addr % 250}`;
const code = (b: unknown) => (b as { error?: { code?: string } })?.error?.code;

beforeEach(() => {
  poolFor = vi.fn(() => {
    throw new Error('the database must not be touched on this path');
  });
  for (const k of ['info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('query: exactly one period=YYYY-MM, fixed message, never echoed', () => {
  it('accepts a month and normalizes it to the billing-period date', () => {
    expect(parseReportFactsQuery({ period: '2024-09' })).toEqual({ ok: true, value: { period: '2024-09-01' } });
  });
  it('refuses missing, malformed, repeated or extra parameters', () => {
    for (const q of [{}, { period: '2024-9' }, { period: '1999-12' }, { period: '2024-13' }, { period: ['2024-09', '2024-10'] }, { period: '2024-09', tenant: TENANT }, { from: '2024-09' }]) {
      expect(parseReportFactsQuery(q as Record<string, string>), JSON.stringify(q)).toEqual({ ok: false, message: REPORT_FACTS_QUERY_MESSAGE });
    }
  });
});

describe('auth, method and configuration (shared with the published-costs route)', () => {
  it('anonymous, wrong token, weak token ⇒ refused before any DB work', async () => {
    expect((await call(route(), makeReq({ query: { period: '2024-09' }, remoteAddress: ip() }))).statusCode).toBe(401);
    expect((await call(route(), makeReq({ headers: { authorization: 'Bearer nope' }, query: { period: '2024-09' }, remoteAddress: ip() }))).statusCode).toBe(401);
    const weak = await call(route({ ...BASE_ENV, RATIO_API_TOKEN: 'weak' }), makeReq({ headers: bearer('weak'), query: { period: '2024-09' }, remoteAddress: ip() }));
    expect([weak.statusCode, code(weak.body)]).toEqual([503, 'weak_token']);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('GET only; no tenant binding or reader URL ⇒ 503 not_configured; bad query ⇒ 400 without echo; all no-store', async () => {
    const post = await call(route(), makeReq({ method: 'POST', headers: bearer(), query: { period: '2024-09' }, remoteAddress: ip() }));
    expect(post.statusCode).toBe(405);
    for (const env of [{ ...BASE_ENV, RATIO_API_TENANT_ID: undefined }, { ...BASE_ENV, RATIO_READER_DATABASE_URL: '' }]) {
      const res = await call(route(env), makeReq({ headers: bearer(), query: { period: '2024-09' }, remoteAddress: ip() }));
      expect(res.body).toEqual({ error: { code: 'not_configured', message: ROUTE_MESSAGES.notConfigured } });
      expect(res.statusCode).toBe(503);
    }
    const bad = await call(route(), makeReq({ headers: bearer(), query: { period: '<b>EVIL</b>' }, remoteAddress: ip() }));
    expect([bad.statusCode, code(bad.body)]).toEqual([400, 'invalid_request']);
    expect(JSON.stringify(bad.body)).not.toContain('EVIL');
    expect(bad.headers['cache-control']).toBe('no-store');
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('engagement mode: tenant from the engagement config; a separate RATIO_API_TENANT_ID fails closed', async () => {
    const env = { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: ENGAGEMENT, RATIO_READER_DATABASE_URL: READER_URL, RATIO_API_TENANT_ID: TENANT };
    const res = await call(route(env), makeReq({ headers: bearer(), query: { period: '2024-09' }, remoteAddress: ip() }));
    expect([res.statusCode, code(res.body)]).toEqual([503, 'not_configured']);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('a database failure is a generic 500 (no detail), never partial facts', async () => {
    const broken = { connect: vi.fn(async () => Promise.reject(new Error('db down SECRET-DETAIL'))) };
    const r = createReportFactsRoute({ env: BASE_ENV, poolFor: () => broken as never, logger: () => undefined });
    const res = await call(r, makeReq({ headers: bearer(), query: { period: '2024-09' }, remoteAddress: ip() }));
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-DETAIL');
  });

  it('pages/api/v1/reports/facts.ts is the factory default and refuses an anonymous request', async () => {
    const saved = process.env.RATIO_API_TOKEN;
    delete process.env.RATIO_API_TOKEN;
    try {
      expect((await call(routeFromPages, makeReq({ query: { period: '2024-09' }, remoteAddress: ip() }))).statusCode).toBe(401);
    } finally {
      if (saved !== undefined) process.env.RATIO_API_TOKEN = saved;
    }
  });
});
