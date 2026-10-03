// Live-data access gate — deny by default.
//
// Only the two OFFLINE sandbox sources (bundled seed data, no credentials, no
// network) may be served anonymously. Every other source id — live connectors,
// PointFive, and ids that do not exist — requires a configured RATIO_API_TOKEN
// and a matching `Authorization: Bearer <token>`, regardless of whether the
// gateway would otherwise enforce auth. Unknown ids are rejected with 401 BEFORE
// any lookup, so anonymous callers cannot probe which live sources exist.
//
// Pure (no req/res, env injected) and free of secrets, so the allowlist is also
// safe to import into the browser bundle to decide which UI actions to offer.

import { checkAuth, type AuthOutcome } from './auth';

/** Offline seed sources that are safe to serve without authentication. */
export const OFFLINE_SANDBOX_SOURCE_IDS: ReadonlySet<string> = new Set([
  'pointfive-sandbox',
  'focus-file-sandbox',
]);

export function isOfflineSandboxSource(sourceId: string): boolean {
  return OFFLINE_SANDBOX_SOURCE_IDS.has(sourceId);
}

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
