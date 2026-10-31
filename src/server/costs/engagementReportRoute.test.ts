// GET /api/v1/reports/engagement?period=YYYY-MM&format=xlsx|pdf|json: everything decided
// BEFORE the database (same shared factory, auth, gateway and tenant binding
// as /api/v1/reports/facts). The pool factory is a spy that fails the test if
// it is ever called on these paths.
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiHandler } from 'next';
import { createEngagementReportRoute, ENGAGEMENT_REPORT_QUERY_MESSAGE, parseEngagementReportQuery } from './engagementReportRoute';
import { ROUTE_MESSAGES } from './publishedCostsRoute';
import { bearer, call, makeReq, TEST_API_TOKEN } from './testing/http';
import routeFromPages from '../../../pages/api/v1/reports/engagement';

const TENANT = '11111111-1111-4111-8111-111111111111';
const READER_URL = 'postgres://reader@127.0.0.1:1/ratio';
const BASE_ENV = { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: TENANT, RATIO_READER_DATABASE_URL: READER_URL };
const ENGAGEMENT = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');
const Q = { period: '2024-09', format: 'xlsx' };

let poolFor: ReturnType<typeof vi.fn>;
const route = (env: Record<string, string | undefined> = BASE_ENV): NextApiHandler => createEngagementReportRoute({ env, poolFor: poolFor as never, logger: () => undefined });
let addr = 0;
const ip = () => `10.79.${Math.floor(++addr / 250) % 250}.${addr % 250}`;
const code = (b: unknown) => (b as { error?: { code?: string } })?.error?.code;

beforeEach(() => {
  poolFor = vi.fn(() => {
    throw new Error('the database must not be touched on this path');
  });
  for (const k of ['info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('query: period=YYYY-MM and format=xlsx|pdf|json (exact allowlist), nothing else; fixed message', () => {
  it('accepts exactly the two parameters, for each allowed format', () => {
    for (const format of ['xlsx', 'pdf', 'json'] as const) expect(parseEngagementReportQuery({ ...Q, format })).toEqual({ ok: true, value: { period: '2024-09-01', format } });
  });
  it('refuses a missing or unknown format, a bad period, repeats and extra parameters', () => {
    for (const q of [{ period: '2024-09' }, { ...Q, format: 'csv' }, { ...Q, format: 'PDF' }, { ...Q, format: 'json ' }, { ...Q, format: 'XLSX' }, { ...Q, period: '2024-9' }, { ...Q, format: ['xlsx', 'xlsx'] }, { ...Q, tenant: TENANT }, {}]) {
      expect(parseEngagementReportQuery(q as Record<string, string>), JSON.stringify(q)).toEqual({ ok: false, message: ENGAGEMENT_REPORT_QUERY_MESSAGE });
    }
  });
});

describe('auth, method and configuration (shared with the published-costs route)', () => {
  it('anonymous, wrong token, weak token ⇒ refused before any DB work', async () => {
    expect((await call(route(), makeReq({ query: Q, remoteAddress: ip() }))).statusCode).toBe(401);
    expect((await call(route(), makeReq({ headers: { authorization: 'Bearer nope' }, query: Q, remoteAddress: ip() }))).statusCode).toBe(401);
    const weak = await call(route({ ...BASE_ENV, RATIO_API_TOKEN: 'weak' }), makeReq({ headers: bearer('weak'), query: Q, remoteAddress: ip() }));
    expect([weak.statusCode, code(weak.body)]).toEqual([503, 'weak_token']);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('GET only (405); no tenant binding ⇒ 503 not_configured; bad query ⇒ 400 without echo; all no-store', async () => {
    const post = await call(route(), makeReq({ method: 'POST', headers: bearer(), query: Q, remoteAddress: ip() }));
    expect([post.statusCode, post.headers.allow]).toEqual([405, 'GET']);
    const nc = await call(route({ ...BASE_ENV, RATIO_API_TENANT_ID: undefined }), makeReq({ headers: bearer(), query: Q, remoteAddress: ip() }));
    expect([nc.statusCode, nc.body]).toEqual([503, { error: { code: 'not_configured', message: ROUTE_MESSAGES.notConfigured } }]);
    const bad = await call(route(), makeReq({ headers: bearer(), query: { period: '2024-09', format: '<b>EVIL</b>' }, remoteAddress: ip() }));
    expect([bad.statusCode, code(bad.body)]).toEqual([400, 'invalid_request']);
    expect(JSON.stringify(bad.body)).not.toContain('EVIL');
    expect(bad.headers['cache-control']).toBe('no-store');
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('engagement mode: the tenant comes from the config; a separate RATIO_API_TENANT_ID fails closed', async () => {
    const env = { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: ENGAGEMENT, RATIO_READER_DATABASE_URL: READER_URL, RATIO_API_TENANT_ID: TENANT };
    const res = await call(route(env), makeReq({ headers: bearer(), query: Q, remoteAddress: ip() }));
    expect([res.statusCode, code(res.body)]).toEqual([503, 'not_configured']);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('a database failure is a generic 500 with no workbook and no detail', async () => {
    const broken = { connect: vi.fn(async () => Promise.reject(new Error('db down SECRET-DETAIL'))) };
    const r = createEngagementReportRoute({ env: BASE_ENV, poolFor: () => broken as never, logger: () => undefined });
    const res = await call(r, makeReq({ headers: bearer(), query: Q, remoteAddress: ip() }));
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('SECRET-DETAIL');
  });

  it('pages/api/v1/reports/engagement.ts is the factory default and refuses an anonymous request', async () => {
    const saved = process.env.RATIO_API_TOKEN;
    delete process.env.RATIO_API_TOKEN;
    try {
      expect((await call(routeFromPages, makeReq({ query: Q, remoteAddress: ip() }))).statusCode).toBe(401);
    } finally {
      if (saved !== undefined) process.env.RATIO_API_TOKEN = saved;
    }
  });
});
