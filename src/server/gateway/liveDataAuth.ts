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
// Failed attempts are rate limited per client IP with the standard-tier
// sliding window. The client IP is the SOCKET address; X-Forwarded-For is
// client-controlled and ignored unless RATIO_TRUSTED_PROXY_HOPS=N (integer
// >= 1) declares N trusted proxies, in which case the Nth hop from the right
// is used. The count is per process (each serverless instance counts on its
// own); a shared store is a deployment item. After
// STANDARD_TIER_LIMIT failed authentications in a minute that client gets 429
// — for every non-sandbox request, even with the right token, so the limit
// cannot be used as a guessing oracle.

import type { NextApiRequest, NextApiResponse } from 'next';
import { isOfflineSandboxSource, OFFLINE_SANDBOX_SOURCE_IDS } from '@/costsource/sandboxSources';
import { checkAuth, type AuthOutcome } from './auth';
import { SlidingWindowRateLimiter, STANDARD_TIER_LIMIT, WINDOW_MS } from './rateLimit';

export { isOfflineSandboxSource, OFFLINE_SANDBOX_SOURCE_IDS };

type LiveDataEnv = Record<string, string | undefined>;

/**
 * Require a configured RATIO_API_TOKEN and a matching Bearer token. With no
 * token configured the request is refused (secure default), never allowed.
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

// --- failed-auth rate limiting ------------------------------------------------

// Counts FAILED authentications only, per client IP.
const failedAuth = new SlidingWindowRateLimiter(STANDARD_TIER_LIMIT, WINDOW_MS);

/**
 * Client IP for rate limiting. The socket remote address, unless
 * RATIO_TRUSTED_PROXY_HOPS=N (integer >= 1) is set: then the Nth entry from the
 * RIGHT of X-Forwarded-For (the address the outermost trusted proxy saw). Hops
 * left of that are client-forgeable and never used. A malformed N, or an XFF
 * with fewer than N entries, falls back to the socket address.
 */
export function clientIp(req: NextApiRequest, env: LiveDataEnv = process.env): string {
  const socketIp = req.socket?.remoteAddress || 'unknown';
  const raw = env.RATIO_TRUSTED_PROXY_HOPS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return socketIp;
  const hops = Number(raw);
  if (!Number.isSafeInteger(hops) || hops < 1) return socketIp;
  const header = req.headers?.['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return socketIp;
  const entries = value.split(',').map((e) => e.trim()).filter(Boolean);
  return entries.length >= hops ? entries[entries.length - hops] : socketIp;
}

/**
 * Deny-by-default gate for the costsource live-data routes (rows / findings /
 * health). Sandbox ids pass. Otherwise: 429 when the client IP is over the
 * failed-auth limit, 401 on a failed check (recorded), else allowed. Returns
 * true when the handler may proceed; otherwise the response has been sent.
 */
export function gateSourceAccess(
  req: NextApiRequest,
  res: NextApiResponse,
  sourceId: string,
  env: LiveDataEnv = process.env,
): boolean {
  if (isOfflineSandboxSource(sourceId)) return true;
  const ip = clientIp(req, env);
  const state = failedAuth.peek(ip);
  if (!state.allowed) {
    res.setHeader('Retry-After', String(state.retryAfterSec));
    res.status(429).json({ error: 'Too many failed authentication attempts' });
    return false;
  }
  const auth = requireLiveDataAuth(req.headers.authorization, env);
  if (!auth.ok) {
    failedAuth.take(ip);
    res.status(401).json({ error: auth.message });
    return false;
  }
  return true;
}
