// R2 slice C: in engagement mode the report routes (/api/v1/reports/facts and
// /api/v1/reports/engagement json|xlsx|pdf) accept a named-user session and
// decide access with authorize(): active user, this tenant and engagement,
// ACTIVE membership, reports:read (facts, json) or reports:export (xlsx, pdf).
// Deny by default; uniform 401/403; the database is never reached on a denial.
// The machine-token path is unchanged. SYNTHETIC users; no DB (the pool
// factory is a spy that throws, so an allowed request ends in the generic 500).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextApiHandler, NextApiRequest } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@/engagement/auth/http';
import { EngagementSessionStore, SESSION_IDLE_MS } from '@/engagement/auth/session';
import type { ReportAuditEvent } from '@/engagement/auth/reportAccess';
import { createEngagementReportRoute } from './engagementReportRoute';
import { createReportFactsRoute } from './reportFactsRoute';
import { bearer, makeRes, TEST_API_TOKEN, type TestRes } from './testing/http';

const CONFIG = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');
const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const OTHER_T = '22222222-2222-4222-8222-222222222222';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-report-'));
const USERS = path.join(dir, 'users.json');
const T0 = Date.UTC(2026, 10, 1, 12);
const env = { RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: CONFIG, RATIO_ENGAGEMENT_USERS: USERS, RATIO_ENGAGEMENT_ORIGIN: 'https://ratio.example.test',
  RATIO_ENGAGEMENT_STATE: path.join(dir, 's.sqlite'), RATIO_READER_DATABASE_URL: 'postgres://reader@127.0.0.1:1/ratio', RATIO_API_TOKEN: TEST_API_TOKEN };
let store: EngagementSessionStore;
let poolFor: ReturnType<typeof vi.fn>;
let audits: ReportAuditEvent[];
let now = T0;
const logs: string[] = [];
const tokens: string[] = [];
const deps = (e: Record<string, string | undefined> = env) => ({ env: e, poolFor: poolFor as never, logger: () => undefined, now: () => new Date(now), access: { store: () => store, now: () => now, audit: (a: ReportAuditEvent) => { audits.push(a); } } });
const facts = (e?: Record<string, string | undefined>) => createReportFactsRoute(deps(e));
const report = (e?: Record<string, string | undefined>) => createEngagementReportRoute(deps(e));
function req(o: { token?: string; query?: Record<string, string>; method?: string; headers?: Record<string, string> } = {}): NextApiRequest {
  return { method: o.method ?? 'GET', url: '/api/v1/reports/x', query: o.query ?? { period: '2024-09' }, body: undefined, headers: { ...(o.headers ?? {}) },
    cookies: o.token === undefined ? {} : { [SESSION_COOKIE]: o.token }, socket: { remoteAddress: '10.0.0.9' } } as unknown as NextApiRequest;
}
async function call(h: NextApiHandler, r: NextApiRequest): Promise<TestRes> {
  const res = makeRes();
  await h(r, res);
  return res;
}
const session = (userId: string, o: { tenantId?: string; engagementId?: string } = {}) => {
  const t = store.create({ userId, tenantId: o.tenantId ?? T, engagementId: o.engagementId ?? E }, now).token;
  tokens.push(t);
  return t;
};
const code = (r: TestRes) => (r.body as { error?: { code?: string } })?.error?.code;
const Q = (format: string) => ({ period: '2024-09', format });

beforeAll(() => {
  const m = (userId: string, role: string, status = 'active') => ({ userId, tenantId: T, engagementId: E, role, status });
  fs.writeFileSync(USERS, JSON.stringify({
    version: 1,
    users: ['v', 'a', 'c', 'ms'].map((id) => ({ id, displayName: `SYNTHETIC ${id}`, status: 'active' })).concat([{ id: 'off', displayName: 'SYNTHETIC off', status: 'suspended' }]),
    memberships: [m('v', 'viewer'), m('a', 'analyst'), m('c', 'connector_manager'), m('ms', 'analyst', 'suspended'), m('off', 'analyst')],
  }));
});
beforeEach(() => {
  now = T0;
  store = new EngagementSessionStore(':memory:');
  audits = [];
  poolFor = vi.fn(() => { throw new Error('DB REACHED'); });
  for (const k of ['info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterAll(() => {
  const all = logs.join('\n') + JSON.stringify(audits);
  for (const t of [...tokens, TEST_API_TOKEN]) expect(all).not.toContain(t);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('session access to the report routes (engagement mode)', () => {
  it('no, tampered, expired, foreign-tenant or foreign-engagement session, or a suspended user ⇒ 401 before the database; no-store', async () => {
    const live = session('a');
    const cases = [undefined, `${live.slice(0, 63)}${live[63] === 'a' ? 'b' : 'a'}`, session('a', { tenantId: OTHER_T }), session('a', { engagementId: 'other' }), session('off')];
    for (const [h, query] of [[facts(), { period: '2024-09' }], [report(), Q('json')]] as const) {
      for (const token of cases) {
        const r = await call(h, req({ token, query }));
        expect([r.statusCode, code(r), r.headers['cache-control']], String(token)).toEqual([401, 'unauthorized', 'no-store']);
      }
    }
    now = T0 + SESSION_IDLE_MS;
    expect((await call(report(), req({ token: live, query: Q('json') }))).statusCode).toBe(401);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('role matrix: reports:read for facts and json, reports:export for xlsx and pdf; a suspended membership is refused', async () => {
    const want: Array<[string, string, boolean]> = [
      ['v', 'facts', true], ['v', 'json', true], ['v', 'xlsx', false], ['v', 'pdf', false],
      ['a', 'facts', true], ['a', 'json', true], ['a', 'xlsx', true], ['a', 'pdf', true],
      ['c', 'facts', false], ['c', 'json', false], ['c', 'xlsx', false], ['ms', 'json', false], ['ms', 'facts', false],
    ];
    for (const [user, format, allowed] of want) {
      poolFor.mockClear();
      const r = format === 'facts' ? await call(facts(), req({ token: session(user) })) : await call(report(), req({ token: session(user), query: Q(format) }));
      expect([r.statusCode, poolFor.mock.calls.length > 0], `${user} ${format}`).toEqual(allowed ? [500, true] : [403, false]);
      if (!allowed) expect(r.body, `${user} ${format}`).toEqual({ error: { code: 'forbidden', message: 'Not permitted' } });
    }
  });

  it('audit: one event per request with user, tenant, engagement, format, permission and outcome; nothing else', async () => {
    await call(report(), req({ token: session('a'), query: Q('xlsx') }));
    await call(report(), req({ token: session('v'), query: Q('pdf') }));
    await call(facts(), req());
    const base = { event: 'report_access', tenantId: T, engagementId: E };
    expect(audits).toEqual([
      { ...base, principalKind: 'user', principalId: 'a', format: 'xlsx', permission: 'reports:export', outcome: 'allow', status: 200 },
      { ...base, principalKind: 'user', principalId: 'v', format: 'pdf', permission: 'reports:export', outcome: 'deny', status: 403 },
      { ...base, principalKind: 'none', principalId: null, format: 'facts', permission: 'reports:read', outcome: 'deny', status: 401 },
    ]);
  });

  it('authentication comes before the query and the method: a bad query or POST is 400/405 only for an authorized caller', async () => {
    expect((await call(report(), req({ query: { period: '2024-09', format: 'csv' } }))).statusCode).toBe(401);
    expect((await call(report(), req({ token: session('a'), query: { period: '2024-09', format: 'csv' } }))).statusCode).toBe(400);
    expect((await call(report(), req({ method: 'POST', query: Q('json') }))).statusCode).toBe(401);
    const post = await call(report(), req({ method: 'POST', token: session('a'), query: Q('json') }));
    expect([post.statusCode, post.headers.allow]).toEqual([405, 'GET']);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('fails closed: a session store failure or an invalid directory ⇒ 503, never data', async () => {
    const t = session('a');
    store.close();
    expect((await call(report(), req({ token: t, query: Q('json') }))).statusCode).toBe(503);
    store = new EngagementSessionStore(':memory:');
    const r = await call(report({ ...env, RATIO_ENGAGEMENT_USERS: path.join(dir, 'missing.json') }), req({ token: session('a'), query: Q('json') }));
    expect([r.statusCode, code(r)]).toEqual([503, 'not_configured']);
    expect(poolFor).not.toHaveBeenCalled();
  });
});

describe('the machine-token path is separate and unchanged', () => {
  it('a Bearer request never falls back to a session: a wrong token with a valid session cookie is 401', async () => {
    const r = await call(report(), req({ token: session('a'), query: Q('json'), headers: bearer('wrong-token-of-sufficient-length-0123456789') }));
    expect(r.statusCode).toBe(401);
    expect(poolFor).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it('the valid machine token still reads (reaches the database) without any session', async () => {
    const r = await call(report(), req({ query: Q('json'), headers: bearer() }));
    expect([r.statusCode, poolFor.mock.calls.length > 0]).toEqual([500, true]);
  });

  it('outside engagement mode a session cookie grants nothing (machine path: 401)', async () => {
    const plain = { RATIO_API_TOKEN: TEST_API_TOKEN, RATIO_API_TENANT_ID: '11111111-1111-4111-8111-111111111111', RATIO_READER_DATABASE_URL: env.RATIO_READER_DATABASE_URL };
    expect((await call(report(plain), req({ token: session('a'), query: Q('json') }))).statusCode).toBe(401);
    expect(poolFor).not.toHaveBeenCalled();
  });

  it('published costs (/api/v1/costs/published) stay machine-token only: no session path', async () => {
    const { createPublishedCostsRoute } = await import('./publishedCostsRoute');
    const r = await call(createPublishedCostsRoute(deps()), req({ token: session('a'), query: { period: '2024-09' } }));
    expect(r.statusCode).toBe(401);
    expect(poolFor).not.toHaveBeenCalled();
  });
});
