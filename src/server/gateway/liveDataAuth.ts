// Live-data access gate — deny by default.
//
// Only the two OFFLINE sandbox sources (bundled seed data, no credentials, no
// network) may be served anonymously. Every other source id — live connectors,
// PointFive, and ids that do not exist — requires a configured RATIO_API_TOKEN
// and a matching `Authorization: Bearer <token>`, regardless of whether the
// gateway would otherwise enforce auth. Unknown ids are rejected with 401 BEFORE
// any lookup, so anonymous callers cannot probe which live sources exist.
//
// SERVER-ONLY (token comparison uses node:crypto). The client-safe sandbox
// allowlist lives in @/costsource/sandboxSources.
//
// Token strength is the real control: a configured RATIO_API_TOKEN shorter
// than MIN_LIVE_TOKEN_LENGTH refuses live data outright (503).
//
// Failed attempts — and ONLY failed attempts — are counted per client IP with
// the standard-tier sliding window, through ONE shared accounting used by every
// route that checks live-data auth (rows / findings / health / sources /
// v1 connectors). Over the limit, requests that would otherwise be 401 get 429;
// a request presenting a VALID token always passes (a lockout is never a
// denial of service for the legitimate holder). The client IP is the SOCKET
// address (IPv4-mapped IPv6 normalized); X-Forwarded-For is client-controlled
// and ignored unless RATIO_TRUSTED_PROXY_HOPS=N (integer >= 1) declares N
// trusted proxies, in which case the Nth hop from the right is used. The count
// is per process (each serverless instance counts on its own); a shared store
// is a deployment item.

import type { NextApiRequest, NextApiResponse } from 'next';
import { isOfflineSandboxSource, OFFLINE_SANDBOX_SOURCE_IDS } from '@/costsource/sandboxSources';
import { checkAuth, type AuthOutcome } from './auth';
import { SlidingWindowRateLimiter, STANDARD_TIER_LIMIT, WINDOW_MS } from './rateLimit';

export { isOfflineSandboxSource, OFFLINE_SANDBOX_SOURCE_IDS };

type LiveDataEnv = Record<string, string | undefined>;

/** Minimum RATIO_API_TOKEN length for serving live cost data. */
export const MIN_LIVE_TOKEN_LENGTH = 32;
export const WEAK_TOKEN_MESSAGE = 'RATIO_API_TOKEN must be at least 32 characters to serve live cost data';
export const THROTTLED_MESSAGE = 'Too many failed authentication attempts';

/**
 * Require a configured RATIO_API_TOKEN and a matching Bearer token. With no
 * token configured the request is refused (secure default), never allowed.
 * (Pure check — no accounting; routes use evaluateLiveDataAuth.)
 */
export function requireLiveDataAuth(
  authHeader: string | string[] | undefined,
  env: LiveDataEnv = process.env,
): AuthOutcome {
  const token = env.RATIO_API_TOKEN?.trim() || null;
  return checkAuth(authHeader, { enforce: true, token });
}

/** Sandbox sources pass anonymously; every other source id needs live-data auth. */
export function authorizeSourceAccess(
  sourceId: string,
  authHeader: string | string[] | undefined,
  env: LiveDataEnv = process.env,
): AuthOutcome {
  if (isOfflineSandboxSource(sourceId)) return { ok: true, tenant: 'anonymous' };
  return requireLiveDataAuth(authHeader, env);
}

// --- client identity -------------------------------------------------------------

function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip;
}

function trustedHops(env: LiveDataEnv): number | null {
  const raw = env.RATIO_TRUSTED_PROXY_HOPS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const hops = Number(raw);
  return Number.isSafeInteger(hops) && hops >= 1 ? hops : null;
}

/**
 * Client IP for rate limiting. The socket remote address, unless
 * RATIO_TRUSTED_PROXY_HOPS=N (integer >= 1) is set: then the Nth entry from the
 * RIGHT of X-Forwarded-For (the address the outermost trusted proxy saw). Hops
 * left of that are client-forgeable and never used. A malformed N, or an XFF
 * with fewer than N entries, falls back to the socket address; a missing
 * socket address is the shared key 'unknown'.
 */
export function clientIp(req: NextApiRequest, env: LiveDataEnv = process.env): string {
  const socketIp = normalizeIp(req.socket?.remoteAddress || 'unknown');
  const hops = trustedHops(env);
  if (hops === null) return socketIp;
  const header = req.headers?.['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return socketIp;
  const entries = value.split(',').map((e) => e.trim()).filter(Boolean);
  return entries.length >= hops ? normalizeIp(entries[entries.length - hops]) : socketIp;
}

let warnedUntrustedXff = false;

/** One-time operator hint: XFF is arriving but is (correctly) being ignored. */
function warnUntrustedXff(req: NextApiRequest, env: LiveDataEnv): void {
  if (warnedUntrustedXff || trustedHops(env) !== null) return;
  if (!req.headers?.['x-forwarded-for']) return;
  warnedUntrustedXff = true;
  console.warn(
    JSON.stringify({
      tag: 'live-data-auth',
      warning:
        'X-Forwarded-For received but RATIO_TRUSTED_PROXY_HOPS is unset: failed-auth limiting keys on the socket address. ' +
        'Set RATIO_TRUSTED_PROXY_HOPS=N if the app runs behind N trusted proxies.',
    }),
  );
}

// --- shared failed-auth accounting ----------------------------------------------

// Counts FAILED authentications only, per client IP. Process-wide.
const failedAuth = new SlidingWindowRateLimiter(STANDARD_TIER_LIMIT, WINDOW_MS);

export type LiveAuthResult =
  | { kind: 'ok' }
  | { kind: 'weak-token' }
  | { kind: 'absent' }
  | { kind: 'unauthorized'; code: 'unauthorized'; message: string }
  | { kind: 'throttled'; retryAfterSec: number };

/**
 * The ONE live-data auth evaluation every route uses:
 *   - weak configured token (< 32 chars) → 'weak-token' (live data refused);
 *   - no Authorization header and `countAbsent` false → 'absent' (not an
 *     auth attempt; e.g. an anonymous registry read);
 *   - valid token → 'ok' (never throttled);
 *   - otherwise a failed attempt: 'throttled' when the client is over the
 *     limit, else counted and 'unauthorized'.
 */
export function evaluateLiveDataAuth(
  req: NextApiRequest,
  opts: { countAbsent: boolean },
  env: LiveDataEnv = process.env,
): LiveAuthResult {
  warnUntrustedXff(req, env);
  const configured = env.RATIO_API_TOKEN?.trim();
  if (configured && configured.length < MIN_LIVE_TOKEN_LENGTH) return { kind: 'weak-token' };

  const header = req.headers?.authorization;
  const present = Array.isArray(header) ? header.length > 0 : Boolean(header);
  if (!present && !opts.countAbsent) return { kind: 'absent' };

  const auth = requireLiveDataAuth(header, env);
  if (auth.ok) return { kind: 'ok' };

  const ip = clientIp(req, env);
  const state = failedAuth.peek(ip);
  if (!state.allowed) return { kind: 'throttled', retryAfterSec: state.retryAfterSec };
  failedAuth.take(ip);
  return { kind: 'unauthorized', code: auth.code, message: auth.message };
}

/**
 * Deny-by-default gate for the costsource live-data routes (rows / findings /
 * health). Sandbox ids pass. Otherwise 503 (weak token), 429 (throttled
 * failure), 401 (failure), or allowed. Returns true when the handler may
 * proceed; otherwise the response has been sent.
 */
export function gateSourceAccess(
  req: NextApiRequest,
  res: NextApiResponse,
  sourceId: string,
  env: LiveDataEnv = process.env,
): boolean {
  if (isOfflineSandboxSource(sourceId)) return true;
  const result = evaluateLiveDataAuth(req, { countAbsent: true }, env);
  switch (result.kind) {
    case 'ok':
      return true;
    case 'weak-token':
      res.status(503).json({ error: WEAK_TOKEN_MESSAGE });
      return false;
    case 'throttled':
      res.setHeader('Retry-After', String(result.retryAfterSec));
      res.status(429).json({ error: THROTTLED_MESSAGE });
      return false;
    case 'unauthorized':
      res.status(401).json({ error: result.message });
      return false;
    case 'absent':
      // Unreachable with countAbsent: true; refuse defensively.
      res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });
      return false;
  }
}
