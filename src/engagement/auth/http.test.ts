// R2 A2a: the browser-session library: https-only settings, the __Host-
// cookie, Origin/Referer checks, the per-session CSRF token and the
// per-request principal re-resolved from the directory. No routes yet.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateDirectory, type Directory } from './directory';
import { authSettings, checkStateChange, clearedSessionCookie, csrfFor, resolveSessionPrincipal, sameOrigin, SESSION_COOKIE, sessionCookie, type RequestLike } from './http';
import { EngagementSessionStore, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SessionStoreError } from './session';

const ORIGIN = 'https://ratio.example.test';
const T = '5f0c1a7e-2b3d-4c5e-8f60-71829a3b4c5d';
const E = 'example-focus-sample';
const INSTANCE = { tenantId: T, engagementId: E };
const T0 = Date.UTC(2026, 10, 1, 12);
/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate an untyped JSON document */
function dir(fn: (d: any) => void = () => {}): Directory {
  const d: any = {
    version: 1,
    users: [{ id: 'v', displayName: 'SYNTHETIC v', status: 'active' }, { id: 'w', displayName: 'SYNTHETIC w', status: 'active' }],
    memberships: [{ userId: 'v', tenantId: T, engagementId: E, role: 'viewer', status: 'active' }],
  };
  fn(d);
  const r = validateDirectory(d, INSTANCE);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.directory;
}
const req = (o: { method?: string; headers?: Record<string, string>; token?: string } = {}): RequestLike => ({
  method: o.method ?? 'GET', headers: { ...(o.headers ?? {}) }, cookies: o.token === undefined ? {} : { [SESSION_COOKIE]: o.token },
});

describe('settings and cookie', () => {
  it('requires an https origin (exact origin form) and an absolute state path; anything else is null (routes answer 503)', () => {
    expect(authSettings({ RATIO_ENGAGEMENT_ORIGIN: ORIGIN, RATIO_ENGAGEMENT_STATE: '/state/sessions.sqlite' })).toEqual({ origin: ORIGIN, stateFile: '/state/sessions.sqlite' });
    for (const env of [
      { RATIO_ENGAGEMENT_ORIGIN: 'http://ratio.example.test', RATIO_ENGAGEMENT_STATE: '/state/s.sqlite' },
      { RATIO_ENGAGEMENT_ORIGIN: `${ORIGIN}/`, RATIO_ENGAGEMENT_STATE: '/state/s.sqlite' },
      { RATIO_ENGAGEMENT_ORIGIN: `${ORIGIN}/app`, RATIO_ENGAGEMENT_STATE: '/state/s.sqlite' },
      { RATIO_ENGAGEMENT_ORIGIN: 'https://u:p@ratio.example.test', RATIO_ENGAGEMENT_STATE: '/state/s.sqlite' },
      { RATIO_ENGAGEMENT_ORIGIN: ORIGIN, RATIO_ENGAGEMENT_STATE: 'state/s.sqlite' },
      { RATIO_ENGAGEMENT_ORIGIN: ORIGIN },
      {},
    ]) expect(authSettings(env), JSON.stringify(env)).toBeNull();
  });

  it('the cookie is __Host- prefixed, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain; clearing expires it', () => {
    const token = randomBytes(32).toString('hex');
    expect(SESSION_COOKIE).toBe('__Host-ratio_session');
    expect(sessionCookie(token)).toBe(`__Host-ratio_session=${token}; Path=/; Max-Age=${SESSION_ABSOLUTE_MS / 1000}; Secure; HttpOnly; SameSite=Strict`);
    expect(clearedSessionCookie()).toBe('__Host-ratio_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict');
    expect(() => sessionCookie('not-a-token; Domain=evil.example')).toThrow();
  });
});

describe('Origin and CSRF', () => {
  const token = randomBytes(32).toString('hex');
  const csrf = csrfFor(token);
  it('Origin must equal the configured origin; Referer is the fallback; cross-site fetch metadata is refused', () => {
    expect(sameOrigin(req({ headers: { origin: ORIGIN } }), ORIGIN)).toBe(true);
    expect(sameOrigin(req({ headers: { referer: `${ORIGIN}/signin?x=1` } }), ORIGIN)).toBe(true);
    for (const headers of [{}, { origin: 'null' }, { origin: 'https://evil.example' }, { origin: `${ORIGIN}.evil.example` }, { referer: 'https://evil.example/' },
      { referer: `${ORIGIN}.evil.example/` }, { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, { origin: ORIGIN, 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example', referer: `${ORIGIN}/` }]) {
      expect(sameOrigin(req({ headers }), ORIGIN), JSON.stringify(headers)).toBe(false);
    }
  });

  it('the CSRF token is bound to the session token, differs from it and per session, and is never the token', () => {
    expect(csrf).toMatch(/^[a-f0-9]{64}$/);
    expect(csrf).not.toBe(token);
    expect(csrfFor(token)).toBe(csrf);
    expect(csrfFor(randomBytes(32).toString('hex'))).not.toBe(csrf);
  });

  it('every state-changing method needs the Origin AND the session CSRF token; GET/HEAD need neither', () => {
    const other = csrfFor(randomBytes(32).toString('hex'));
    for (const method of ['GET', 'HEAD']) expect(checkStateChange(req({ method }), token, ORIGIN)).toBe('ok');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      expect(checkStateChange(req({ method, headers: { origin: ORIGIN, 'x-ratio-csrf': csrf } }), token, ORIGIN), method).toBe(['OPTIONS', 'TRACE'].includes(method) ? 'method' : 'ok');
      if (['OPTIONS', 'TRACE'].includes(method)) continue;
      expect(checkStateChange(req({ method, headers: { origin: ORIGIN } }), token, ORIGIN), `${method} missing`).toBe('csrf');
      expect(checkStateChange(req({ method, headers: { origin: ORIGIN, 'x-ratio-csrf': other } }), token, ORIGIN), `${method} replayed from another session`).toBe('csrf');
      expect(checkStateChange(req({ method, headers: { origin: ORIGIN, 'x-ratio-csrf': csrf.toUpperCase() } }), token, ORIGIN), `${method} wrong`).toBe('csrf');
      expect(checkStateChange(req({ method, headers: { origin: 'https://evil.example', 'x-ratio-csrf': csrf } }), token, ORIGIN), `${method} cross-origin`).toBe('origin');
    }
  });
});

describe('resolveSessionPrincipal: re-resolved from the directory on every request', () => {
  const setup = () => {
    const store = new EngagementSessionStore(':memory:');
    return { store, token: store.create({ userId: 'v', ...INSTANCE }, T0).token };
  };
  const ctx = (store: EngagementSessionStore, d = dir(), now = T0 + 1) => ({ store, directory: d, instance: INSTANCE, now });

  it('a live session yields a user principal bound to the instance (no role copied into the session)', () => {
    const { store, token } = setup();
    expect(resolveSessionPrincipal(req({ token }), ctx(store))).toEqual({ kind: 'user', id: 'v', tenantId: T, engagementId: E });
  });

  it('no, tampered, expired, idle or revoked cookie ⇒ null', () => {
    const { store, token } = setup();
    expect(resolveSessionPrincipal(req(), ctx(store))).toBeNull();
    expect(resolveSessionPrincipal(req({ token: `${token.slice(0, 63)}${token[63] === 'a' ? 'b' : 'a'}` }), ctx(store))).toBeNull();
    expect(resolveSessionPrincipal(req({ token }), ctx(store, dir(), T0 + SESSION_IDLE_MS + 1))).toBeNull();
    const fresh = store.create({ userId: 'v', ...INSTANCE }, T0).token;
    store.revoke(fresh);
    expect(resolveSessionPrincipal(req({ token: fresh }), ctx(store))).toBeNull();
  });

  it('a suspended or removed user, or a session of another tenant or engagement, is refused on the next request', () => {
    const { store, token } = setup();
    expect(resolveSessionPrincipal(req({ token }), ctx(store, dir((d) => { d.users[0].status = 'suspended'; })))).toBeNull();
    expect(resolveSessionPrincipal(req({ token }), ctx(store, dir((d) => { d.users.shift(); d.memberships = []; })))).toBeNull();
    const foreignT = store.create({ userId: 'v', tenantId: '22222222-2222-4222-8222-222222222222', engagementId: E }, T0).token;
    const foreignE = store.create({ userId: 'v', tenantId: T, engagementId: 'other' }, T0).token;
    const wrongCase = store.create({ userId: 'V', ...INSTANCE }, T0).token;
    for (const t of [foreignT, foreignE, wrongCase]) expect(resolveSessionPrincipal(req({ token: t }), ctx(store))).toBeNull();
    expect(resolveSessionPrincipal(req({ token }), ctx(store))).not.toBeNull();
  });

  it('a store failure propagates as SessionStoreError (the route fails closed with 503), never as a principal', () => {
    const { store, token } = setup();
    store.close();
    expect(() => resolveSessionPrincipal(req({ token }), ctx(store))).toThrow(SessionStoreError);
  });
});
