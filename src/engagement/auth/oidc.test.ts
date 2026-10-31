// R2 B: OIDC sign-in (Authorization Code + PKCE) with openid-client against a
// SYNTHETIC in-process IdP (the fetch is injected; no network). The external
// identity (connection, issuer, subject) maps to a user only through an
// explicit binding; anything else is not_provisioned with no session.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextApiHandler, NextApiRequest } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRoute } from '@/rbac/matrix';
import { SESSION_COOKIE } from './http';
import { createOidcCallbackRoute, createOidcStartRoute, OIDC_TX_COOKIE, OidcTransactionStore, type OidcRouteDeps } from './oidc';
import type { AuthAuditEvent } from './routes';
import { EngagementSessionStore } from './session';
import startPage from '../../../pages/api/auth/oidc/start';
import callbackPage from '../../../pages/api/auth/oidc/callback';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ORIGIN = 'https://ratio.example.test';
const CALLBACK = `${ORIGIN}/api/auth/oidc/callback`;
const ISS = 'https://idp.example.test/tenant-a';
const CLIENT_ID = 'ratio-synthetic-client';
const SECRET_ENV = 'RATIO_OIDC_CLIENT_SECRET_IDP_A';
const CLIENT_SECRET = randomBytes(24).toString('base64url'); // SYNTHETIC, generated at run time
const CONFIG = path.resolve(__dirname, '../../../fixtures/engagement/example/engagement.json');
const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-oidc-'));
const USERS = path.join(dir, 'users.json');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const OTHER_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

type TestRes = { statusCode: number; body: unknown; headers: Record<string, string | string[]>; headersSent: boolean };
function makeRes(): TestRes {
  const r = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string | string[]>, headersSent: false,
    setHeader(k: string, v: string | string[]) { r.headers[k.toLowerCase()] = v; return r; },
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; r.headersSent = true; return r; },
    end() { r.headersSent = true; return r; } };
  return r;
}
const logs: string[] = [];
const secretsSeen: string[] = [CLIENT_SECRET];
let audits: AuthAuditEvent[] = [];
let sessions: EngagementSessionStore;
let txs: OidcTransactionStore;
let codes: Map<string, { nonce: string; challenge: string; sub: string; redirect: string }>;
let tamper: { iss?: string; aud?: string; exp?: number; nonce?: string; key?: typeof privateKey; email?: string } = {};
let idpDown = false;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims: Record<string, unknown>, key = privateKey) {
  const head = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${sign('sha256', Buffer.from(head), key).toString('base64url')}`;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const mockIdp = async (url: string, opts: { method: string; headers: Record<string, string>; body?: unknown }): Promise<Response> => {
  if (idpDown) throw new Error('connect ECONNREFUSED');
  const u = new URL(url);
  if (u.href === `${ISS}/.well-known/openid-configuration`) {
    return json({ issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks`, response_types_supported: ['code'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] });
  }
  if (u.href === `${ISS}/jwks`) return json({ keys: [JWK] });
  if (u.href === `${ISS}/token` && opts.method === 'POST') {
    const p = new URLSearchParams(String(opts.body));
    const basic = opts.headers.authorization ?? '';
    const authed = (p.get('client_id') === CLIENT_ID && p.get('client_secret') === CLIENT_SECRET) || basic === `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64')}`;
    const c = codes.get(p.get('code') ?? '');
    codes.delete(p.get('code') ?? ''); // single use at the IdP too
    if (!authed || !c || p.get('redirect_uri') !== c.redirect || createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: tamper.iss ?? ISS, aud: tamper.aud ?? CLIENT_ID, sub: c.sub, nonce: tamper.nonce ?? c.nonce, iat: now, exp: tamper.exp ?? now + 300, ...(tamper.email ? { email: tamper.email } : {}) };
    return json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 300, id_token: idToken(claims, tamper.key) });
  }
  return json({ error: 'not_found' }, 404);
};

const env = (o: Record<string, string | undefined> = {}) => ({ RATIO_MODE: 'engagement', RATIO_ENGAGEMENT_CONFIG: CONFIG, RATIO_ENGAGEMENT_USERS: USERS, RATIO_ENGAGEMENT_ORIGIN: ORIGIN,
  RATIO_ENGAGEMENT_STATE: path.join(dir, 's.sqlite'), RATIO_TRUSTED_PROXY_HOPS: '1', [SECRET_ENV]: CLIENT_SECRET, ...o });
const deps = (o: Record<string, string | undefined> = {}): OidcRouteDeps => ({ env: env(o), now: () => Date.now(), store: () => sessions, transactions: () => txs, fetch: mockIdp as never, audit: (a) => { audits.push(a); }, configCache: new Map() });
function req(o: { url?: string; cookies?: Record<string, string> } = {}): NextApiRequest {
  const u = new URL(o.url ?? '/api/auth/oidc/start?connection=idp-a', ORIGIN);
  return { method: 'GET', url: u.pathname + u.search, query: Object.fromEntries(u.searchParams), headers: {}, cookies: o.cookies ?? {}, socket: { remoteAddress: '10.0.0.2' } } as unknown as NextApiRequest;
}
async function call(h: NextApiHandler, r: NextApiRequest) {
  const res = makeRes();
  await h(r, res as never);
  return res;
}
const cookiesOf = (r: TestRes) => ([] as string[]).concat(r.headers['set-cookie'] ?? []);
const cookieVal = (r: TestRes, name: string) => cookiesOf(r).map((c) => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find((v) => v !== undefined);
/** start → the IdP "authenticates" `sub` → the callback URL the browser would load. */
async function begin(sub: string, d = deps()) {
  const s = await call(createOidcStartRoute(d), req());
  const loc = new URL(String(s.headers.location));
  const code = randomBytes(16).toString('base64url');
  codes.set(code, { nonce: loc.searchParams.get('nonce')!, challenge: loc.searchParams.get('code_challenge')!, sub, redirect: loc.searchParams.get('redirect_uri')! });
  secretsSeen.push(code, cookieVal(s, OIDC_TX_COOKIE)!);
  return { start: s, loc, tx: cookieVal(s, OIDC_TX_COOKIE)!, callbackUrl: `/api/auth/oidc/callback?code=${code}&state=${loc.searchParams.get('state')}` };
}
const finish = (b: Awaited<ReturnType<typeof begin>>, d = deps(), cookies: Record<string, string> = { [OIDC_TX_COOKIE]: b.tx }) => call(createOidcCallbackRoute(d), req({ url: b.callbackUrl, cookies }));
const writeUsers = (fn: (d: any) => void = () => {}) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const d = {
    version: 1,
    users: [{ id: 'v', displayName: 'SYNTHETIC Viewer', status: 'active' }, { id: 'off', displayName: 'SYNTHETIC Off', status: 'suspended' }],
    identityConnections: [{ id: 'idp-a', tenantId: T, protocol: 'oidc', issuer: ISS, clientId: CLIENT_ID, clientSecretRef: SECRET_ENV, provisioning: 'invite-only', enabled: true },
      { id: 'idp-off', tenantId: T, protocol: 'oidc', issuer: 'https://idp.example.test/off', clientId: CLIENT_ID, clientSecretRef: SECRET_ENV, provisioning: 'invite-only', enabled: false }],
    bindings: [{ connectionId: 'idp-a', issuer: ISS, subject: 'sub-v', userId: 'v', approvedBy: 'operator', approvedAt: '2026-11-01T00:00:00Z' },
      { connectionId: 'idp-a', issuer: ISS, subject: 'sub-off', userId: 'off', approvedBy: 'operator', approvedAt: '2026-11-01T00:00:00Z' }],
    memberships: [{ userId: 'v', tenantId: T, engagementId: E, role: 'viewer', status: 'active' }, { userId: 'off', tenantId: T, engagementId: E, role: 'viewer', status: 'active' }],
  };
  fn(d);
  fs.writeFileSync(USERS, JSON.stringify(d));
};

beforeAll(() => writeUsers());
beforeEach(() => {
  sessions = new EngagementSessionStore(':memory:');
  txs = new OidcTransactionStore(':memory:');
  codes = new Map();
  tamper = {};
  idpDown = false;
  audits = [];
  for (const k of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterAll(() => {
  const all = logs.join('\n') + JSON.stringify(audits);
  for (const s of secretsSeen) expect(all).not.toContain(s);
  expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no JWT
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/auth/oidc/start', () => {
  it('redirects to the registered IdP with code + PKCE S256, state, nonce and the exact callback; sets a short-lived Lax transaction cookie', async () => {
    const { start, loc, tx } = await begin('sub-v');
    expect(start.statusCode).toBe(302);
    expect(loc.origin + loc.pathname).toBe(`${ISS}/authorize`);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: CALLBACK, scope: 'openid', code_challenge_method: 'S256' });
    for (const k of ['state', 'nonce', 'code_challenge']) expect(loc.searchParams.get(k), k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.has('client_secret')).toBe(false);
    expect(cookiesOf(start)).toEqual([`${OIDC_TX_COOKIE}=${tx}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`]);
    expect(start.headers['cache-control']).toBe('no-store');
  });

  it('unknown or disabled connection ⇒ 400; missing client secret or hop count ⇒ 503; IdP unreachable ⇒ 503; outside engagement mode ⇒ 404; matrix rows', async () => {
    for (const c of ['idp-b', 'idp-off', '']) expect((await call(createOidcStartRoute(deps()), req({ url: `/api/auth/oidc/start?connection=${c}` }))).statusCode, c).toBe(400);
    expect((await call(createOidcStartRoute(deps({ [SECRET_ENV]: undefined })), req())).statusCode).toBe(503);
    expect((await call(createOidcStartRoute(deps({ RATIO_TRUSTED_PROXY_HOPS: undefined })), req())).statusCode).toBe(503);
    idpDown = true;
    const down = await call(createOidcStartRoute(deps()), req());
    expect([down.statusCode, cookiesOf(down)]).toEqual([503, []]);
    for (const h of [createOidcStartRoute, createOidcCallbackRoute]) expect((await call(h(deps({ RATIO_MODE: undefined })), req())).statusCode).toBe(404);
    for (const p of ['/api/auth/oidc/start', '/api/auth/oidc/callback']) expect(findRoute(p), p).toMatchObject({ group: 'session', status: 'enforced', legacyService: '-' });
    expect([startPage, callbackPage].every((h) => typeof h === 'function')).toBe(true);
  });
});

describe('GET /api/auth/oidc/callback', () => {
  it('a bound, active member gets the same server session as local sign-in; the transaction cookie is cleared; audit has ids only', async () => {
    const r = await finish(await begin('sub-v'));
    expect([r.statusCode, r.headers.location]).toEqual([303, '/']);
    const token = cookieVal(r, SESSION_COOKIE)!;
    secretsSeen.push(token);
    expect(sessions.get(token)).toMatchObject({ userId: 'v', tenantId: T, engagementId: E });
    expect(cookiesOf(r)).toContain(`${OIDC_TX_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    expect(audits.at(-1)).toEqual({ event: 'auth', action: 'oidc_callback', outcome: 'success', status: 200, principalKind: 'user', principalId: 'v', tenantId: T, engagementId: E });
  });

  it('replayed callback, missing or foreign transaction cookie (login CSRF), or tampered state ⇒ 401 with no session', async () => {
    const b = await begin('sub-v');
    expect((await finish(b)).statusCode).toBe(303);
    expect(cookieVal(await finish(b), SESSION_COOKIE)).toBeUndefined();
    expect((await finish(b)).statusCode).toBe(401); // replay: the transaction was consumed
    const c = await begin('sub-v');
    expect((await finish(c, deps(), {})).statusCode).toBe(401); // no transaction cookie in this browser
    const other = await begin('sub-v');
    expect((await finish(c, deps(), { [OIDC_TX_COOKIE]: other.tx })).statusCode).toBe(401); // another browser's transaction: state mismatch
    const d = await begin('sub-v');
    d.callbackUrl = d.callbackUrl.replace(/state=[^&]+/, `state=${randomBytes(32).toString('base64url')}`);
    expect((await finish(d)).statusCode).toBe(401);
    expect(sessions.count()).toBe(1);
  });

  it('the library rejects a wrong issuer, wrong audience, expired token, wrong nonce or a bad signature ⇒ 401, no session', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const t of [{ iss: 'https://idp.example.test/tenant-b' }, { aud: 'someone-else' }, { exp: now - 3600 }, { nonce: 'not-the-nonce' }, { key: OTHER_KEY }]) {
      tamper = t;
      const r = await finish(await begin('sub-v'));
      expect([r.statusCode, cookieVal(r, SESSION_COOKIE)], JSON.stringify(Object.keys(t))).toEqual([401, undefined]);
    }
    expect(sessions.count()).toBe(0);
  });

  it('an unbound subject, a suspended bound user or a binding removed meanwhile ⇒ uniform not_provisioned, no session; email never links', async () => {
    tamper = { email: 'v@example.test' };
    const results = [await finish(await begin('sub-unbound')), await finish(await begin('sub-off'))];
    const b = await begin('sub-v');
    writeUsers((d) => { d.bindings.shift(); });
    results.push(await finish(b));
    writeUsers();
    for (const r of results) {
      expect([r.statusCode, r.body, cookieVal(r, SESSION_COOKIE)]).toEqual([403, { error: { code: 'not_provisioned', message: 'This account is not provisioned for this engagement' } }, undefined]);
    }
    expect(audits.filter((a) => a.action === 'oidc_callback').map((a) => [a.status, a.principalId])).toEqual([[403, null], [403, null], [403, null]]);
    expect(sessions.count()).toBe(0);
  });

  it('a connection disabled between start and callback ⇒ 401; a presented session is replaced (fixation)', async () => {
    const b = await begin('sub-v');
    writeUsers((d) => { d.identityConnections[0].enabled = false; });
    expect((await finish(b)).statusCode).toBe(401);
    writeUsers();
    const old = sessions.create({ userId: 'v', tenantId: T, engagementId: E }).token;
    const c = await begin('sub-v');
    const r = await finish(c, deps(), { [OIDC_TX_COOKIE]: c.tx, [SESSION_COOKIE]: old });
    expect(r.statusCode).toBe(303);
    expect(sessions.get(old)).toBeNull();
  });
});
