// FinIO trust-boundary configuration. SERVER-SIDE ONLY — never import this from
// a component or from LiveFinioClient; nothing here may reach the browser bundle.
//
// What this replaces: the shared A2A token used to be the exported constant
// `FINIO_DEMO_TOKEN` in FinioClient.ts, which LiveFinioClient imported. Because
// LiveFinioClient runs in the browser, the "shared secret" gating the handshake
// was compiled into the client bundle and readable by anyone with devtools — the
// trust boundary the spec wanted to demonstrate did not actually exist. The
// session-signing HMAC key was hardcoded in the same way.
//
// The offline-safe invariant matches src/server/gateway/auth.ts: with NO peer
// token configured, the handshake does NOT enforce one, so the demo and CI stay
// green with zero env. Enforcement turns on the moment FINIO_PEER_TOKEN is set.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface FinioEnv {
  /** Shared secret a peer agent presents to open a FinIO session. */
  FINIO_PEER_TOKEN?: string;
  /** Key used to sign session tokens. Generated per-process when unset. */
  FINIO_SESSION_SECRET?: string;
  // Index signature so `process.env` is assignable and tests can pass a fixture.
  [key: string]: string | undefined;
}

export interface FinioPeerAuthConfig {
  /** Whether a peer token is required for this deployment. */
  enforce: boolean;
  /** The configured peer token, if any. */
  token: string | null;
}

/** Decide whether to enforce the A2A peer token from the server environment. */
export function resolveFinioPeerAuth(env: FinioEnv = process.env): FinioPeerAuthConfig {
  const token = env.FINIO_PEER_TOKEN?.trim() || null;
  return { enforce: Boolean(token), token };
}

/**
 * Constant-time string comparison. A plain `!==` on a secret leaks its prefix
 * length through response timing; this compares fixed-width digests so every
 * comparison costs the same regardless of where the strings diverge.
 */
export function secretsMatch(a: string, b: string): boolean {
  const digest = (value: string) => createHmac('sha256', 'finio-cmp').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Validate a presented peer token.
 *
 * Returns ok when enforcement is off (the zero-config demo path), when the
 * presented token matches, and never otherwise.
 */
export function checkPeerToken(
  presented: string | null,
  config: FinioPeerAuthConfig,
): { ok: true } | { ok: false; message: string } {
  if (!config.enforce) return { ok: true };
  if (!config.token) {
    return { ok: false, message: 'FinIO peer authentication is misconfigured' };
  }
  if (!presented) {
    return { ok: false, message: 'Missing FinIO peer token' };
  }
  return secretsMatch(presented, config.token)
    ? { ok: true }
    : { ok: false, message: 'Invalid FinIO peer token' };
}

// Per-process fallback signing key. Regenerated on every boot, so sessions do
// not survive a restart — correct for a stateless demo, and far better than a
// constant checked into git. Set FINIO_SESSION_SECRET to pin it across a
// multi-instance deployment.
const EPHEMERAL_SESSION_SECRET = randomBytes(32).toString('hex');

/** The key used to sign and verify session tokens. */
export function sessionSecret(env: FinioEnv = process.env): string {
  return env.FINIO_SESSION_SECRET?.trim() || EPHEMERAL_SESSION_SECRET;
}
