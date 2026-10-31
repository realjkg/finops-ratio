// R2 A2: POST /api/auth/login, POST /api/auth/logout, GET /api/auth/session.
// SYNTHETIC users; passwords generated at run time. Every console line and
// audit event is captured and checked for credentials at the end.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextApiHandler, NextApiRequest } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRoute } from '@/rbac/matrix';
import { csrfFor, SESSION_COOKIE } from './http';
import { hashPassword } from './password';
import { createLoginRoute, createLogoutRoute, createSessionRoute, LoginThrottle, AUTH_MESSAGES, type AuthAuditEvent, type AuthRouteDeps } from './routes';
import { EngagementSessionStore, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from './session';
import loginPage from '../../../pages/api/auth/login';
import logoutPage from '../../../pages/api/auth/logout';
import sessionPage from '../../../pages/api/auth/session';

type TestRes = { statusCode: number; body: unknown; headers: Record<string, string>; headersSent: boolean };
/** A minimal fake response (the costs testing helper is outside the import boundary for this module). */
function makeRes(): TestRes {
  const r = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>, headersSent: false,
    setHeader(k: string, v: string | number) { r.headers[k.toLowerCase()] = String(v); return r; },
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; r.headersSent = true; return r; } };
  return r;
}
const ORIGIN = 'https://ratio.example.test';
const CONFIG = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');
const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-routes-'));
const USERS = path.join(dir, 'users.json');
const pw = { v: randomBytes(18).toString('base64url'), off: randomBytes(18).toString('base64url'), nom: randomBytes(18).toString('base64url') };
const T0 = Date.UTC(2026, 10, 1, 12);
let now = T0;
let store: EngagementSessionStore;
let throttle: LoginThrottle;
let audits: AuthAuditEvent[] = [];
const logs: string[] = [];
const seen: string[] = [];
const env = (o: Record<string, string | undefined> = {}) => ({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: CONFIG, RATIO_ENGAGEMENT_USERS: USERS, RATIO_ENGAGEMENT_ORIGIN: ORIGIN, RATIO_ENGAGEMENT_STATE: path.join(dir, 's.sqlite'), RATIO_API_TOKEN: 'MACHINE-TOKEN-NEVER-SHOWN-0123456789abcdef', ...o });
const deps = (e = env()): AuthRouteDeps => ({ env: e, now: () => now, store: () => store, throttle, audit: (a) => { audits.push(a); } });
let ip = 0;
function req(o: { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; ip?: string } = {}): NextApiRequest {
  return {
    method: o.method ?? 'GET', url: '/api/auth/x', query: {}, body: o.body,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...(o.headers ?? {}) },
    cookies: o.token === undefined ? {} : { [SESSION_COOKIE]: o.token },
    socket: { remoteAddress: o.ip ?? `10.3.${Math.floor((ip += 1) / 250)}.${ip % 250}` },
  } as unknown as NextApiRequest;
}
async function call(h: NextApiHandler, r: NextApiRequest): Promise<TestRes> {
  const res = makeRes();
  await h(r, res as never);
  const t = /^__Host-ratio_session=([a-f0-9]{64});/.exec(res.headers['set-cookie'] ?? '')?.[1];
  if (t) seen.push(t, csrfFor(t));
  return res;
}
const login = (u: string, p: string, o: Parameters<typeof req>[0] = {}, e?: Record<string, string | undefined>) => call(createLoginRoute(deps(e ? env(e) : undefined)), req({ method: 'POST', body: { username: u, password: p }, ...o }));
const session = (token?: string) => call(createSessionRoute(deps()), req({ token }));
const logout = (token: string, headers: Record<string, string> = {}) => call(createLogoutRoute(deps()), req({ method: 'POST', token, headers }));
const tokenOf = (r: TestRes) => /^__Host-ratio_session=([a-f0-9]{64});/.exec(r.headers['set-cookie'] ?? '')?.[1] ?? '';
const err = (r: TestRes) => (r.body as { error?: { code: string; message: string } }).error;
async function writeUsers(fn: (d: any) => void = () => {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const d = {
    version: 1,
    users: [{ id: 'v', displayName: 'SYNTHETIC Viewer', status: 'active' }, { id: 'off', displayName: 'SYNTHETIC Off', status: 'suspended' }, { id: 'nom', displayName: 'SYNTHETIC No member', status: 'active' }],
    localCredentials: [{ userId: 'v', passwordHash: await hashPassword(pw.v) }, { userId: 'off', passwordHash: await hashPassword(pw.off) }, { userId: 'nom', passwordHash: await hashPassword(pw.nom) }],
    memberships: [{ userId: 'v', tenantId: T, engagementId: E, role: 'viewer', status: 'active' }, { userId: 'off', tenantId: T, engagementId: E, role: 'viewer', status: 'active' }],
  };
  fn(d);
  fs.writeFileSync(USERS, JSON.stringify(d));
}

beforeAll(() => writeUsers());
beforeEach(() => {
  now = T0;
  store = new EngagementSessionStore(':memory:');
  throttle = new LoginThrottle();
  audits = [];
  for (const k of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterAll(() => {
  const all = logs.join('\n') + JSON.stringify(audits);
  for (const s of [pw.v, pw.off, pw.nom, 'MACHINE-TOKEN-NEVER-SHOWN', ...seen]) expect(all).not.toContain(s);
  expect(all).not.toMatch(/scrypt\$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mode, configuration and classification', () => {
  it('404 outside engagement mode; 503 for http origin, missing state or a bad users file; never a cookie; matrix rows exist', async () => {
    for (const h of [createLoginRoute, createLogoutRoute, createSessionRoute]) expect((await call(h(deps(env({ RATIO_MODE: undefined }))), req({ method: 'POST' }))).statusCode).toBe(404);
    for (const e of [{ RATIO_ENGAGEMENT_ORIGIN: 'http://ratio.example.test' }, { RATIO_ENGAGEMENT_STATE: undefined }, { RATIO_ENGAGEMENT_USERS: path.join(dir, 'missing.json') }]) {
      const r = await login('v', pw.v, {}, e);
      expect([r.statusCode, err(r)?.code, r.headers['set-cookie']]).toEqual([503, 'not_configured', undefined]);
    }
    for (const p of ['/api/auth/login', '/api/auth/logout', '/api/auth/session']) expect(findRoute(p), p).toMatchObject({ group: 'session', status: 'enforced', legacyService: '-' });
    expect([loginPage, logoutPage, sessionPage].every((h) => typeof h === 'function')).toBe(true);
  });

  it('every response is no-store; wrong methods are 405 with Allow', async () => {
    const r = await call(createLoginRoute(deps()), req({ method: 'GET' }));
    expect([r.statusCode, r.headers.allow, r.headers['cache-control']]).toEqual([405, 'POST', 'no-store']);
    expect((await call(createSessionRoute(deps()), req({ method: 'POST' }))).headers.allow).toBe('GET');
    expect((await call(createLogoutRoute(deps()), req({ method: 'GET' }))).statusCode).toBe(405);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in: __Host- cookie, principal and CSRF token, no-store, audit with ids only', async () => {
    const r = await login('V', pw.v);
    expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toBe(`${SESSION_COOKIE}=${tokenOf(r)}; Path=/; Max-Age=${SESSION_ABSOLUTE_MS / 1000}; Secure; HttpOnly; SameSite=Strict`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ principal: { kind: 'user', id: 'v' }, displayName: 'SYNTHETIC Viewer', csrfToken: csrfFor(tokenOf(r)), expiresAt: T0 + SESSION_ABSOLUTE_MS });
    expect(audits).toEqual([{ event: 'auth', action: 'login', outcome: 'success', status: 200, principalKind: 'user', principalId: 'v', tenantId: T, engagementId: E }]);
  });

  it('wrong password, unknown, suspended and member-less users all get the identical 401 and a denial audit without a name', async () => {
    const rs = await Promise.all([login('v', `${pw.v}x`), login('ghost', pw.v), login('off', pw.off), login('nom', pw.nom)]);
    for (const r of rs) expect([r.statusCode, r.body, r.headers['set-cookie']]).toEqual([401, { error: { code: 'unauthorized', message: AUTH_MESSAGES.signInFailed } }, undefined]);
    expect(audits.every((a) => a.outcome === 'denied' && a.principalId === null && a.status === 401)).toBe(true);
  });

  it('login CSRF: wrong or missing Origin, cross-site fetch metadata or a non-JSON body are refused before any password work', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }] as Array<Record<string, string>>) {
      expect((await login('v', pw.v, { headers })).statusCode, JSON.stringify(headers)).toBe(403);
    }
    expect((await login('v', pw.v, { headers: { 'content-type': 'text/plain' } })).statusCode).toBe(415);
    for (const body of [undefined, 'x', { username: 'v' }, { username: 'v', password: 1 }, { username: 'u'.repeat(129), password: 'p' }]) {
      expect((await call(createLoginRoute(deps()), req({ method: 'POST', body }))).statusCode).toBe(400);
    }
  });

  it('throttles per user name (5) and per client (20) within 15 min, for any name; a correct password does not bypass it', async () => {
    for (let i = 0; i < 5; i += 1) expect((await login('v', 'wrong-password-123')).statusCode).toBe(401);
    const locked = await login('v', pw.v);
    expect([locked.statusCode, err(locked)?.code, locked.headers['set-cookie']]).toEqual([429, 'rate_limited', undefined]);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    now += 15 * 60_000;
    expect((await login('v', pw.v)).statusCode).toBe(200);
    for (let i = 0; i < 20; i += 1) await login(`ghost${i}`, 'wrong-password-123', { ip: '10.9.9.9' });
    expect((await login('v', pw.v, { ip: '10.9.9.9' })).statusCode).toBe(429);
    expect((await login('v', pw.v, { ip: '10.9.9.8' })).statusCode).toBe(200);
  });

  it('the throttle memory is bounded', () => {
    const t = new LoginThrottle(100);
    for (let i = 0; i < 1000; i += 1) t.fail([`ip:${i}`], T0);
    expect(t.size()).toBeLessThanOrEqual(100);
    const u = ['u:k'];
    for (let round = 0; round < 2; round += 1) { // a new window starts after the old one ends, and blocks again
      const start = T0 + round * 15 * 60_000;
      for (let i = 0; i < 5; i += 1) t.fail(u, start + i);
      expect(t.blocked(u, start + 10), String(round)).toBeGreaterThan(0);
    }
  });

  it('session fixation: a presented session is revoked and a new one minted', async () => {
    const first = tokenOf(await login('v', pw.v));
    const second = tokenOf(await login('v', pw.v, { token: first }));
    expect(second).not.toBe(first);
    expect((await session(first)).statusCode).toBe(401);
    expect((await session(second)).statusCode).toBe(200);
  });
});

describe('GET /api/auth/session and POST /api/auth/logout', () => {
  it('session: 401 without, with a tampered, idle or expired cookie; 200 with principal, display name and CSRF only', async () => {
    const t = tokenOf(await login('v', pw.v));
    expect((await session()).statusCode).toBe(401);
    expect((await session(`${t.slice(0, 63)}${t[63] === 'a' ? 'b' : 'a'}`)).statusCode).toBe(401);
    const ok = await session(t);
    expect([ok.statusCode, ok.body, ok.headers['cache-control']]).toEqual([200, { principal: { kind: 'user', id: 'v' }, displayName: 'SYNTHETIC Viewer', csrfToken: csrfFor(t), expiresAt: T0 + SESSION_ABSOLUTE_MS }, 'no-store']);
    now += SESSION_IDLE_MS;
    expect((await session(t)).statusCode).toBe(401);
  });

  it('directory changes apply on the next request: suspension, membership removal; another tenant\'s session is refused', async () => {
    const t = tokenOf(await login('v', pw.v));
    await writeUsers((d) => { d.users[0].status = 'suspended'; });
    expect((await session(t)).statusCode).toBe(401);
    await writeUsers((d) => { d.memberships[0].status = 'suspended'; });
    expect((await session(t)).statusCode).toBe(401);
    await writeUsers();
    expect((await session(t)).statusCode).toBe(200);
    const foreign = store.create({ userId: 'v', tenantId: '22222222-2222-4222-8222-222222222222', engagementId: E }, now).token;
    seen.push(foreign);
    expect((await session(foreign)).statusCode).toBe(401);
  });

  it('logout needs the Origin and the session CSRF token, revokes on the server and clears the cookie', async () => {
    const t = tokenOf(await login('v', pw.v));
    const other = tokenOf(await login('v', pw.v, { ip: '10.7.7.7' }));
    expect((await logout(t)).statusCode).toBe(403);
    expect((await logout(t, { 'x-ratio-csrf': csrfFor(other) })).statusCode).toBe(403); // replayed from another session
    expect((await logout(t, { 'x-ratio-csrf': csrfFor(t), origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await session(t)).statusCode).toBe(200);
    const out = await logout(t, { 'x-ratio-csrf': csrfFor(t) });
    expect([out.statusCode, out.headers['set-cookie']]).toEqual([200, `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`]);
    expect((await session(t)).statusCode).toBe(401);
    expect((await logout(t, { 'x-ratio-csrf': csrfFor(t) })).statusCode).toBe(401);
    expect(audits.filter((a) => a.action === 'logout').map((a) => [a.outcome, a.status])).toEqual([['denied', 403], ['denied', 403], ['denied', 403], ['success', 200], ['denied', 401]]);
  });

  it('a session store failure fails closed: 503, no cookie, no principal', async () => {
    const t = tokenOf(await login('v', pw.v));
    store.close();
    for (const r of [await session(t), await login('v', pw.v), await logout(t, { 'x-ratio-csrf': csrfFor(t) })]) {
      expect([r.statusCode, err(r)?.code, r.headers['set-cookie']]).toEqual([503, 'session_store_unavailable', undefined]);
    }
  });

  it('a throwing or rejecting audit sink never changes the response', async () => {
    const r = await call(createLoginRoute({ ...deps(), audit: () => { throw new Error('SINK'); } }), req({ method: 'POST', body: { username: 'v', password: pw.v } }));
    expect(r.statusCode).toBe(200);
    const s = await call(createSessionRoute({ ...deps(), audit: async () => { throw new Error('SINK'); } }), req({ token: tokenOf(r) }));
    expect(s.statusCode).toBe(200);
    const unhandled: unknown[] = [];
    const on = (x: unknown) => { unhandled.push(x); };
    process.on('unhandledRejection', on);
    try {
      const sink = { ...deps(), audit: async () => { throw new Error('SINK'); } };
      expect((await call(createSessionRoute(sink), req())).statusCode).toBe(401);
      expect((await call(createLoginRoute(sink), req({ method: 'POST', body: { username: 'v', password: 'wrong-password-123' } }))).statusCode).toBe(401);
      await new Promise((res) => setTimeout(res, 20));
      expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', on); }
  });
});
