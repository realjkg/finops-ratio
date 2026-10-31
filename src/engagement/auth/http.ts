// R2 A2a: the browser-session library the sign-in routes (A2b) and the
// customer-data routes (slice C) use. Framework-agnostic request shape.
// - Settings: a session is issued only when RATIO_ENGAGEMENT_ORIGIN is an
//   https origin and RATIO_ENGAGEMENT_STATE an absolute path; otherwise null
//   (routes answer 503, never a plain-http session).
// - Cookie: __Host- prefix (forces Secure, Path=/, no Domain), HttpOnly,
//   SameSite=Strict: the app is opened directly, never needs the session on a
//   cross-site navigation, and Strict also keeps it off cross-site top-level
//   GETs. Strict is defense in depth only: CSRF is enforced below.
// - CSRF: every state-changing method needs the configured Origin (Referer as
//   the fallback; cross-site fetch metadata refused) AND the session's CSRF
//   token in X-Ratio-CSRF. The CSRF token is derived from the session token
//   (synchronizer: nothing extra stored), so a token of another session fails.
// - The principal is re-resolved from the directory on every request.
// SERVER-ONLY.
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { Principal } from './authz';
import type { Directory, Instance } from './directory';
import { SESSION_ABSOLUTE_MS, type EngagementSessionStore } from './session';

type Env = Record<string, string | undefined>;
export interface RequestLike { method?: string; headers: Record<string, string | string[] | undefined>; cookies?: Partial<Record<string, string>> }
export interface AuthSettings { origin: string; stateFile: string }

export const SESSION_COOKIE = '__Host-ratio_session';
export const CSRF_HEADER = 'x-ratio-csrf';
const ATTRS = 'Path=/; Max-Age=%d; Secure; HttpOnly; SameSite=Strict';
const TOKEN_RE = /^[a-f0-9]{64}$/;
const header = (req: RequestLike, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

function httpsOrigin(v: string | undefined): v is string {
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.origin === v;
  } catch {
    return false;
  }
}

export function authSettings(env: Env): AuthSettings | null {
  const origin = env.RATIO_ENGAGEMENT_ORIGIN;
  const stateFile = env.RATIO_ENGAGEMENT_STATE;
  return httpsOrigin(origin) && stateFile && path.isAbsolute(stateFile) ? { origin, stateFile } : null;
}

export function sessionCookie(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error('invalid session token');
  return `${SESSION_COOKIE}=${token}; ${ATTRS.replace('%d', String(SESSION_ABSOLUTE_MS / 1000))}`;
}
export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; ${ATTRS.replace('%d', '0')}`;
export const sessionToken = (req: RequestLike): string => req.cookies?.[SESSION_COOKIE] ?? '';

/** The request comes from the configured origin: Origin header (or, without one, the Referer's origin), and no cross-site fetch metadata. */
export function sameOrigin(req: RequestLike, origin: string): boolean {
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return false;
  const o = header(req, 'origin');
  if (o !== undefined) return o === origin;
  const ref = header(req, 'referer');
  try {
    return ref !== undefined && new URL(ref).origin === origin;
  } catch {
    return false;
  }
}

/** The session's CSRF token: derived from the session token, so it is per session and nothing extra is stored. */
export const csrfFor = (token: string): string => createHash('sha256').update(`ratio-csrf\u0000${token}`).digest('hex');

export type StateChangeCheck = 'ok' | 'method' | 'origin' | 'csrf';
/** GET/HEAD change nothing; POST/PUT/PATCH/DELETE need Origin AND the session CSRF token; any other method is refused. */
export function checkStateChange(req: RequestLike, token: string, origin: string): StateChangeCheck {
  const method = (req.method ?? '').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return 'ok';
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'method';
  if (!sameOrigin(req, origin)) return 'origin';
  const supplied = header(req, CSRF_HEADER);
  const ok = typeof supplied === 'string' && TOKEN_RE.test(supplied) && TOKEN_RE.test(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfFor(token)));
  return ok ? 'ok' : 'csrf';
}

/**
 * The principal of this request's session, re-resolved now: a live session of
 * this instance's tenant and engagement whose user still exists (exact id) and
 * is active. Membership, role and teams are decided by authorize(). Throws
 * SessionStoreError when the store fails (the caller answers 503).
 */
export function resolveSessionPrincipal(req: RequestLike, ctx: { store: EngagementSessionStore; directory: Directory; instance: Instance; now: number }): Principal | null {
  const s = ctx.store.get(sessionToken(req), ctx.now);
  if (!s || s.tenantId !== ctx.instance.tenantId || s.engagementId !== ctx.instance.engagementId) return null;
  const user = ctx.directory.users.get(s.userId.toLowerCase());
  if (!user || user.id !== s.userId || user.status !== 'active') return null;
  return { kind: 'user', id: user.id, tenantId: s.tenantId, engagementId: s.engagementId };
}
