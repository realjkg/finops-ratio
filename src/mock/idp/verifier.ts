// Mock IdP raw-claims verifier (card A2). Returns the verified claim set; it
// does not build a Principal (card B1's MockIdpVerifier does that).
//
// Order of checks, each failing with a fixed MockIdpError code:
//   gate -> context -> compact shape and canonical base64url -> header
//   (exactly alg, typ, kid; alg must be EdDSA, so none and HS* are refused
//   before any key is touched) -> kid lookup -> Ed25519 signature -> strict
//   claims -> audience -> time -> revocation -> token use (session or
//   one-time login) -> one-time redemption.
// The payload is not parsed as claims until the signature has verified.

import { verify } from 'node:crypto';
import { MOCK_IDP_ALG, MockIdpError, isMockDeployEnv, parseClaims, type MockIdpClaims } from './claims';
import { mockIdpEnabled, type MockIdpEnv } from './enabled';
import { isRevokedJti, markRedeemed, verificationKeyForKid } from './issuer';
import type { MockDeployEnv } from './personas';

export interface VerifyContext {
  /** Epoch seconds. Required: the caller owns the clock. */
  now: number;
  /** This deployment's environment; the token's `aud` must equal it. */
  deployEnv: MockDeployEnv;
}

/** Longest compact token accepted, in characters. */
export const MAX_TOKEN_LENGTH = 8192;

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const HEADER_KEYS: ReadonlySet<string> = new Set(['alg', 'typ', 'kid']);
const ED25519_SIGNATURE_BYTES = 64;

function decodeCanonical(segment: string): Buffer {
  if (!SEGMENT_RE.test(segment)) throw new MockIdpError('malformed');
  const bytes = Buffer.from(segment, 'base64url');
  // Exactly one accepted spelling per byte string (no padding, no stray bits).
  if (bytes.toString('base64url') !== segment) throw new MockIdpError('malformed');
  return bytes;
}

function decodeJsonObject(segment: string, code: 'malformed' | 'invalid_claims'): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeCanonical(segment).toString('utf8'));
  } catch (err) {
    if (err instanceof MockIdpError) throw err;
    throw new MockIdpError(code);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MockIdpError(code);
  return value as Record<string, unknown>;
}

type TokenUse = 'session' | 'login';

function verifyInternal(token: string, ctx: VerifyContext, env: MockIdpEnv, use: TokenUse): MockIdpClaims {
  if (!mockIdpEnabled(env)) throw new MockIdpError('disabled');
  if (typeof ctx !== 'object' || ctx === null) throw new MockIdpError('invalid_input');
  if (typeof ctx.now !== 'number' || !Number.isFinite(ctx.now)) throw new MockIdpError('invalid_input');
  if (!isMockDeployEnv(ctx.deployEnv)) throw new MockIdpError('invalid_input');
  const now = Math.floor(ctx.now);

  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new MockIdpError('malformed');
  }
  const segments = token.split('.');
  if (segments.length !== 3 || !segments.every((seg) => SEGMENT_RE.test(seg))) throw new MockIdpError('malformed');
  const [headerSeg, payloadSeg, signatureSeg] = segments;

  const header = decodeJsonObject(headerSeg, 'malformed');
  for (const key of Object.keys(header)) if (!HEADER_KEYS.has(key)) throw new MockIdpError('malformed');
  if (header.alg !== MOCK_IDP_ALG) throw new MockIdpError('unsupported_alg');
  if (header.typ !== 'JWT') throw new MockIdpError('malformed');
  if (typeof header.kid !== 'string') throw new MockIdpError('malformed');

  const signature = decodeCanonical(signatureSeg);
  // Validate the payload encoding before touching the key, but do not parse it yet.
  decodeCanonical(payloadSeg);

  const key = verificationKeyForKid(header.kid);
  if (!key) throw new MockIdpError('unknown_kid');
  if (signature.length !== ED25519_SIGNATURE_BYTES) throw new MockIdpError('bad_signature');
  let valid: boolean;
  try {
    valid = verify(null, Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf8'), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new MockIdpError('bad_signature');

  const claims = parseClaims(decodeJsonObject(payloadSeg, 'invalid_claims'));
  if (claims.aud !== ctx.deployEnv) throw new MockIdpError('wrong_audience');
  if (now < claims.iat) throw new MockIdpError('not_yet_valid');
  if (now >= claims.exp) throw new MockIdpError('expired');
  if (isRevokedJti(claims.jti)) throw new MockIdpError('revoked');

  const isLoginToken = claims.once === true;
  if ((use === 'login') !== isLoginToken) throw new MockIdpError('wrong_token_use');
  if (use === 'login' && !markRedeemed(claims.jti)) throw new MockIdpError('replayed');
  return claims;
}

/**
 * Verify a session token and return its raw claims. Throws MockIdpError on
 * any failure. One-time login tokens are refused here.
 */
export function verifyToken(token: string, ctx: VerifyContext, env: MockIdpEnv = process.env): MockIdpClaims {
  return verifyInternal(token, ctx, env, 'session');
}

/**
 * Redeem a one-time login token: full verification, then the token id is
 * marked used, so a second redemption fails with `replayed`. A failed check
 * does not consume the token. Session tokens are refused here.
 */
export function redeemLoginToken(token: string, ctx: VerifyContext, env: MockIdpEnv = process.env): MockIdpClaims {
  return verifyInternal(token, ctx, env, 'login');
}
