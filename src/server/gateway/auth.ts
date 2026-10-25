// Gateway auth (Wave3b). Bearer-token authentication, one API key per tenant
// (.obvious/obvious.md API-First rule). Pure functions — no req/res — so the
// enforcement decision and token matching are independently testable.
//
// Fail-closed invariant (P11): auth is enforced by default. The only bypass is
// the explicit local simulation mode (see ./simulationMode.ts), and even then
// enforcement stays on when a token is configured or a live AI provider
// (anything but mock, aliases included — see src/ai/providers.ts) or live
// change-management provider is selected.

import { createHash, timingSafeEqual } from 'crypto';
import { LIVE_AI_PROVIDERS, normalizeAIProvider } from '@/ai/providers';
import { gatewaySimulationMode } from './simulationMode';

export interface GatewayAuthConfig {
  /** Whether a Bearer token is required for this request. */
  enforce: boolean;
  /** The configured server-side token, if any. */
  token: string | null;
}

export type AuthOutcome =
  | { ok: true; tenant: string }
  | { ok: false; code: 'unauthorized'; message: string };

export interface GatewayEnv {
  NODE_ENV?: 'development' | 'production' | 'test';
  RATIO_API_TOKEN?: string;
  AI_PROVIDER?: string;
  /** Wave 4 Slice 3: change-management provider selection. */
  CM_PROVIDER?: string;
  /** P11: '1' with RATIO_ENV development or test enables local simulation. */
  RATIO_SIMULATION?: string;
  RATIO_ENV?: string;
}

const LIVE_CM_PROVIDERS = new Set(['jira', 'servicenow']);

/** Decide whether to enforce Bearer auth. Enforced unless explicit simulation mode. */
export function resolveGatewayAuth(env: GatewayEnv): GatewayAuthConfig {
  const token = env.RATIO_API_TOKEN?.trim() || null;
  const aiProvider = normalizeAIProvider(env.AI_PROVIDER);
  const cmProvider = (env.CM_PROVIDER ?? '').toLowerCase();
  const liveProvider =
    LIVE_AI_PROVIDERS.has(aiProvider) || LIVE_CM_PROVIDERS.has(cmProvider);
  return { enforce: !gatewaySimulationMode(env) || Boolean(token) || liveProvider, token };
}

/** Longest Authorization header value considered; anything longer is rejected. */
export const MAX_AUTH_HEADER_LENGTH = 8192;

/**
 * Parse a `Bearer <token>` Authorization header. Returns null when absent,
 * malformed, over the length cap, or containing a line break. Linear time: a
 * prefix check and one forward scan, no backtracking pattern (CodeQL
 * js/polynomial-redos on the former `/^Bearer\s+(.+)$/i`).
 */
export function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length > MAX_AUTH_HEADER_LENGTH) return null;
  if (value.slice(0, 6).toLowerCase() !== 'bearer') return null;
  let i = 6;
  while (i < value.length && /\s/.test(value[i])) i += 1;
  if (i === 6) return null; // a separator is required
  const rest = value.slice(i);
  if (/[\n\r\u2028\u2029]/.test(rest)) return null;
  return rest.trim() || null;
}

// Stable, non-reversible tenant id derived from the token (djb2 → base36) so we
// can key rate limits and log a tenant WITHOUT ever logging the raw secret.
export function tenantId(token: string): string {
  let hash = 5381;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 33) ^ token.charCodeAt(i);
  }
  return `tnt_${(hash >>> 0).toString(36)}`;
}

/**
 * Constant-time token comparison (server-only). A plain `!==` leaks the length
 * of the matching prefix through timing; comparing fixed-width SHA-256 digests
 * with timingSafeEqual costs the same wherever the strings diverge. Aligned
 * with `secretsMatch` in src/finio/config.ts.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Minimum strength for a token that may unlock live cost data. */
export const MIN_TOKEN_LENGTH = 32;
export const MIN_TOKEN_DISTINCT_CHARS = 10;

/** True when the token is >= 32 characters with >= 10 distinct characters. */
export function isStrongToken(token: string): boolean {
  return token.length >= MIN_TOKEN_LENGTH && new Set(token).size >= MIN_TOKEN_DISTINCT_CHARS;
}

/** Validate the request's Bearer token against the configured token. */
export function checkAuth(
  authHeader: string | string[] | undefined,
  config: GatewayAuthConfig,
): AuthOutcome {
  if (!config.enforce) return { ok: true, tenant: 'simulation' };

  if (!config.token) {
    // Live provider selected but no token configured — secure default: refuse
    // rather than expose a live LLM endpoint unauthenticated.
    return {
      ok: false,
      code: 'unauthorized',
      message: 'API token required: configure RATIO_API_TOKEN to enable authenticated access',
    };
  }

  const presented = extractBearer(authHeader);
  if (!presented) {
    return {
      ok: false,
      code: 'unauthorized',
      message: 'Missing Authorization: Bearer <token> header',
    };
  }
  if (!tokensMatch(presented, config.token)) {
    return { ok: false, code: 'unauthorized', message: 'Invalid API token' };
  }
  return { ok: true, tenant: tenantId(presented) };
}
