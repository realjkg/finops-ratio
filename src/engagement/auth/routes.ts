// R2 A2: the engagement sign-in routes (pages/api/auth/*), engagement mode only
// (404 otherwise). They never read, use or reveal RATIO_API_TOKEN.
//   POST /api/auth/login    local credentials (bootstrap/recovery path). Login
//                           CSRF: exact Origin, no cross-site fetch metadata,
//                           JSON body. Uniform 401 for every failure, same
//                           scrypt work; throttled per user name and client.
//                           Always mints a new session (fixation).
//   POST /api/auth/logout   session + Origin + CSRF token; revoked server-side.
//   GET  /api/auth/session  principal id, display name and CSRF token only.
// Every response is no-store with fixed messages; a session store failure is
// 503 (fail closed). Audit events carry ids and outcome only, never a
// password, token, CSRF value or user name typed at a failed sign-in.
// Throttle: per process, in memory (one app instance per engagement), keyed by
// the normalized user name and by the client, which RATIO_TRUSTED_PROXY_HOPS
// (required, 0..5) locates in X-Forwarded-For (IPv6 by /64). At most
// MAX_CONCURRENT_LOGINS sign-ins do scrypt work at once. SERVER-ONLY.
import { createHash } from 'node:crypto';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { engagementConfigFromEnv, engagementMode } from '@/engagement/config';
import { sendError } from '@/server/gateway/withGateway';
import { clientIp } from '@/server/gateway/liveDataAuth';
import { runAuditHook } from './authz';
import { directoryFromEnv, type Directory, type Instance } from './directory';
import { authSettings, checkStateChange, clearedSessionCookie, csrfFor, resolveSessionPrincipal, sameOrigin, sessionCookie, sessionToken } from './http';
import { authenticateLocal } from './identity';
import { sessionStore, SessionStoreError, type EngagementSessionStore } from './session';

type Env = Record<string, string | undefined>;
export const AUTH_MESSAGES = Object.freeze({
  signInFailed: 'Sign-in failed. Check the user name and password.',
  signInRequired: 'Sign-in required',
  locked: 'Too many failed sign-in attempts. Try again later.',
  forbidden: 'Request verification failed. Reload and try again.',
  notConfigured: 'Sign-in is not configured on this server',
  unavailable: 'Sign-in is temporarily unavailable',
  busy: 'Sign-in is busy. Try again in a moment.',
});
export interface AuthAuditEvent {
  event: 'auth'; action: 'login' | 'logout' | 'session' | 'oidc_start' | 'oidc_callback'; outcome: 'success' | 'denied'; status: number;
  principalKind: 'user' | 'none'; principalId: string | null; tenantId: string; engagementId: string;
}
const WINDOW_MS = 15 * 60_000;
const LIMITS = { u: 5, ip: 20 } as const;

type Entry = { start: number; count: number };
const live = (e: Entry, now: number) => e.start + WINDOW_MS > now;
const isBlocked = (k: string, e: Entry, now: number) => live(e, now) && e.count >= LIMITS[k.startsWith('ip:') ? 'ip' : 'u'];

/**
 * Failed sign-ins per key (`u:` user name, `ip:` client) in a fixed 15-minute
 * window, at most maxKeys keys. A blocked key is never evicted: room is made
 * from an ended window first, then an under-limit key, oldest first; when
 * every key is blocked, a new key is refused (fail closed).
 */
export class LoginThrottle {
  private keys = new Map<string, Entry>();
  constructor(private readonly maxKeys = 10_000) {}
  private makeRoom(now: number): boolean {
    if (this.keys.size < this.maxKeys) return true;
    for (const pick of [(_k: string, e: Entry) => !live(e, now), (k: string, e: Entry) => !isBlocked(k, e, now)]) {
      for (const [k, e] of this.keys) if (pick(k, e)) { this.keys.delete(k); return true; }
    }
    return false;
  }
  blocked(keys: string[], now: number): number {
    let retry = 0;
    for (const k of keys) {
      const e = this.keys.get(k);
      if (e && isBlocked(k, e, now)) retry = Math.max(retry, Math.ceil((e.start + WINDOW_MS - now) / 1000));
    }
    const full = this.keys.size >= this.maxKeys && ![...this.keys].some(([k, e]) => !isBlocked(k, e, now));
    return full && keys.some((k) => !this.keys.has(k)) ? Math.max(retry, 60) : retry;
  }
  fail(keys: string[], now: number): void {
    for (const k of keys) {
      const e = this.keys.get(k);
      if (e) this.keys.set(k, live(e, now) ? { start: e.start, count: e.count + 1 } : { start: now, count: 1 });
      else if (this.makeRoom(now)) this.keys.set(k, { start: now, count: 1 });
    }
  }
  clear(key: string): void { this.keys.delete(key); }
  size(): number { return this.keys.size; }
}
const sharedThrottle = new LoginThrottle();

export const MAX_CONCURRENT_LOGINS = 4;
/** A global cap on sign-ins doing scrypt work at once (memory and CPU). */
export class LoginGate {
  private n = 0;
  constructor(private readonly max = MAX_CONCURRENT_LOGINS) {}
  tryEnter(): boolean { if (this.n >= this.max) return false; this.n += 1; return true; }
  leave(): void { this.n = Math.max(0, this.n - 1); }
}
const sharedGate = new LoginGate();

/** IPv6 addresses are keyed by their /64 (one subscriber); anything unparsable stays as is. */
function v6Prefix(ip: string): string {
  const [h, t = ''] = ip.split('::');
  const part = (s: string) => (s ? s.split(':').flatMap((x) => (x.includes('.') ? ['0', '0'] : [x])) : []);
  const head = part(h);
  const tail = ip.includes('::') ? part(t) : [];
  const all = ip.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (all.length !== 8 || !all.every((x) => /^[0-9a-f]{1,4}$/i.test(x))) return ip;
  return `${all.slice(0, 4).map((x) => parseInt(x, 16).toString(16)).join(':')}::/64`;
}
/** The client of a sign-in: the socket (hops 0) or the Nth X-Forwarded-For entry from the right; left entries are ignored. */
export function signInClient(req: NextApiRequest, hops: number): string {
  const ip = clientIp(req, hops > 0 ? { RATIO_TRUSTED_PROXY_HOPS: String(hops) } : {});
  return ip.includes(':') ? v6Prefix(ip) : ip;
}

export interface AuthRouteDeps {
  env?: Env; now?: () => number; store?: (file: string) => EngagementSessionStore;
  throttle?: LoginThrottle; gate?: LoginGate; audit?: (e: AuthAuditEvent) => void | Promise<void>;
  /** Test seam: the local credential check (default authenticateLocal). */
  authenticate?: typeof authenticateLocal;
}
interface Ctx { hops: number; origin: string; instance: Instance; directory: Directory; store: EngagementSessionStore; now: number; audit(action: AuthAuditEvent['action'], status: number, id?: string): void }

function route(methods: string, action: AuthAuditEvent['action'], deps: AuthRouteDeps, body: (req: NextApiRequest, res: NextApiResponse, ctx: Ctx) => Promise<void> | void): NextApiHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const env = deps.env ?? process.env;
    try {
      if (!engagementMode(env)) return sendError(res, 404, 'not_found', 'Not found');
    } catch {
      return sendError(res, 503, 'not_configured', AUTH_MESSAGES.notConfigured);
    }
    const settings = authSettings(env);
    const cfg = engagementConfigFromEnv(env);
    const instance = cfg.ok ? { tenantId: cfg.config.tenantId, engagementId: cfg.config.engagementId } : null;
    const dir = instance ? directoryFromEnv(env, instance) : null;
    if (!settings || !instance || !dir?.ok) return sendError(res, 503, 'not_configured', AUTH_MESSAGES.notConfigured);
    if (req.method !== methods) { res.setHeader('Allow', methods); return sendError(res, 405, 'method_not_allowed', 'Method not allowed'); }
    const sink = deps.audit ?? ((e: AuthAuditEvent) => console.info(JSON.stringify(e)));
    const audit: Ctx['audit'] = (a, status, id) => runAuditHook(sink, { event: 'auth', action: a, outcome: status === 200 ? 'success' : 'denied', status, principalKind: id ? 'user' : 'none', principalId: id ?? null, ...instance });
    // Behind the TLS proxy every client would share one throttle bucket without the hop count: refuse instead.
    const hopsRaw = env.RATIO_TRUSTED_PROXY_HOPS;
    if (typeof hopsRaw !== 'string' || !/^[0-5]$/.test(hopsRaw)) { sendError(res, 503, 'not_configured', AUTH_MESSAGES.notConfigured); return audit(action, 503); }
    try {
      const store = (deps.store ?? sessionStore)(settings.stateFile);
      await body(req, res, { hops: Number(hopsRaw), origin: settings.origin, instance, directory: dir.directory, store, now: (deps.now ?? Date.now)(), audit });
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof SessionStoreError) return sendError(res, 503, 'session_store_unavailable', AUTH_MESSAGES.unavailable);
      console.error('{"event":"auth_route_failed"}');
      sendError(res, 500, 'internal_error', 'Internal error');
    }
  };
}

const view = (ctx: Ctx, id: string, token: string, expiresAt: number) => ({
  principal: { kind: 'user', id }, displayName: ctx.directory.users.get(id.toLowerCase())?.displayName, csrfToken: csrfFor(token), expiresAt,
});
const member = (ctx: Ctx, id: string) => ctx.directory.memberships.get(id)?.status === 'active';

export function createLoginRoute(deps: AuthRouteDeps = {}): NextApiHandler {
  const throttle = deps.throttle ?? sharedThrottle;
  const gate = deps.gate ?? sharedGate;
  return route('POST', 'login', deps, async (req, res, ctx) => {
    const deny = (status: number, code: string, message: string) => { sendError(res, status, code, message); ctx.audit('login', status); };
    if (!sameOrigin(req, ctx.origin)) return deny(403, 'forbidden', AUTH_MESSAGES.forbidden);
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return deny(415, 'unsupported_media_type', 'Send the sign-in as JSON');
    const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { username?: unknown; password?: unknown };
    const { username, password } = b;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || username.length > 128 || !password || password.length > 1024) {
      return deny(400, 'invalid_request', 'A user name and a password are required');
    }
    const name = username.trim(); // the same normalization for the lookup and the throttle key
    const userKey = `u:${createHash('sha256').update(name.toLowerCase()).digest('hex')}`; // never kept as typed
    const keys = [userKey, `ip:${signInClient(req, ctx.hops)}`];
    const retry = throttle.blocked(keys, ctx.now);
    if (retry > 0) { res.setHeader('Retry-After', String(retry)); return deny(429, 'rate_limited', AUTH_MESSAGES.locked); }
    if (!gate.tryEnter()) { res.setHeader('Retry-After', '1'); return deny(503, 'busy', AUTH_MESSAGES.busy); }
    let id: string | null;
    try { id = await (deps.authenticate ?? authenticateLocal)(ctx.directory, name, password); } finally { gate.leave(); }
    if (!id || !member(ctx, id)) { throttle.fail(keys, ctx.now); return deny(401, 'unauthorized', AUTH_MESSAGES.signInFailed); }
    throttle.clear(userKey);
    ctx.store.revoke(sessionToken(req)); // never keep a presented session (fixation)
    const { token, session } = ctx.store.create({ userId: id, ...ctx.instance }, ctx.now);
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.status(200).json(view(ctx, id, token, session.expiresAt));
    ctx.audit('login', 200, id);
  });
}

export function createSessionRoute(deps: AuthRouteDeps = {}): NextApiHandler {
  return route('GET', 'session', deps, (req, res, ctx) => {
    const token = sessionToken(req);
    const p = resolveSessionPrincipal(req, ctx);
    if (!p || !member(ctx, p.id)) { sendError(res, 401, 'unauthorized', AUTH_MESSAGES.signInRequired); return ctx.audit('session', 401); }
    res.status(200).json(view(ctx, p.id, token, ctx.store.get(token, ctx.now)?.expiresAt ?? ctx.now));
  });
}

export function createLogoutRoute(deps: AuthRouteDeps = {}): NextApiHandler {
  return route('POST', 'logout', deps, (req, res, ctx) => {
    const token = sessionToken(req);
    const p = resolveSessionPrincipal(req, ctx);
    if (!p) { res.setHeader('Set-Cookie', clearedSessionCookie()); sendError(res, 401, 'unauthorized', AUTH_MESSAGES.signInRequired); return ctx.audit('logout', 401); }
    if (checkStateChange(req, token, ctx.origin) !== 'ok') { sendError(res, 403, 'forbidden', AUTH_MESSAGES.forbidden); return ctx.audit('logout', 403, p.id); }
    ctx.store.revoke(token);
    res.setHeader('Set-Cookie', clearedSessionCookie());
    res.status(200).json({ signedOut: true });
    ctx.audit('logout', 200, p.id);
  });
}
