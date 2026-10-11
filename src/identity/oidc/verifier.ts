// OidcVerifier (checklist 1.1 to 1.4): the real-identity TokenVerifier. It maps
// a provider's signed JWT onto the gateway's Principal; it is the one class
// that replaces the mock verifier when an identity provider is chosen (D1).
// Trust boundary: the bearer string and the provider's key-set document.
//
// Order of checks, each failing with a fixed OidcError code and none echoing
// input:
//   context (now, deployEnv) -> type, size, compact shape and canonical
//   base64url -> header (no injected jku/x5u/x5c/jwk/crit, alg in the
//   allowlist, typ, kid) -> key lookup by kid through the JWKS cache (the
//   key fixes the algorithm; a header that disagrees is refused) -> signature
//   -> strict claims -> issuer (exact) -> audience -> exp / nbf / iat with
//   bounded skew -> lifetime cap -> role, tenant, teams, envs mapping
//   (including the deployment's own environment) -> revocation hook.
// The payload is not parsed as JSON until the signature has verified, and the
// revocation hook (which may do I/O) runs last, only for tokens that would
// otherwise be accepted.
//
// Any failure, including an unexpected exception, becomes an OidcError; the
// caller never sees a raw crypto or parser error.

import { DEPLOY_ENVS, isOneOf, type DeployEnv, type Principal, type TokenVerifier } from '@/identity/types';
import { checkAudience, checkIssuer, checkTimes, mapPrincipal, parseRegistered } from './claims';
import { resolveOidcConfig, type OidcConfig, type ResolvedOidcConfig } from './config';
import { OidcError } from './errors';
import { verifySignature } from './jwk';
import { JwksCache, type FetchJwks } from './jwks';
import { parseCompact, parseJsonBytes } from './token';

/**
 * Revocation and replay hook. Resolve `true` when the token id must be
 * refused, `false` when it may proceed. Anything else, a rejection or a
 * throw fails closed (OidcError 'revocation_unavailable'). The hook should
 * enforce its own deadline. An implementation that records each id on first
 * sight and answers `true` afterwards turns this into single-use (replay)
 * protection for token classes that need it.
 */
export type IsRevoked = (jti: string) => Promise<boolean>;

export interface OidcVerifierDeps {
  /** Network seam for the key set; see FetchJwks. */
  fetchJwks: FetchJwks;
  /** Required on purpose: opting out of revocation must be a visible decision. */
  isRevoked: IsRevoked;
  /** Epoch seconds, used for key-set freshness and cooldown. Defaults to the wall clock. */
  clock?: () => number;
  /** Deadline signal factory for key-set fetches. Defaults to AbortSignal.timeout. */
  createSignal?: (timeoutMs: number) => AbortSignal;
}

export class OidcVerifier implements TokenVerifier {
  private readonly cfg: ResolvedOidcConfig;
  private readonly cache: JwksCache;
  private readonly isRevoked: IsRevoked;

  /** Throws OidcError('invalid_config') for a bad configuration or bad dependencies. */
  constructor(config: OidcConfig, deps: OidcVerifierDeps) {
    this.cfg = resolveOidcConfig(config);
    if (typeof deps !== 'object' || deps === null || typeof deps.isRevoked !== 'function') throw new OidcError('invalid_config');
    this.isRevoked = deps.isRevoked;
    this.cache = new JwksCache(this.cfg.jwksUri, this.cfg.allowedAlgs, this.cfg.jwks, {
      fetchJwks: deps.fetchJwks,
      clock: deps.clock,
      createSignal: deps.createSignal,
    });
  }

  async verify(bearer: string, ctx: { now: number; deployEnv: DeployEnv }): Promise<Principal> {
    try {
      return await this.run(bearer, ctx);
    } catch (err) {
      if (err instanceof OidcError) throw err;
      throw new OidcError('internal');
    }
  }

  private async run(bearer: string, ctx: { now: number; deployEnv: DeployEnv }): Promise<Principal> {
    if (typeof ctx !== 'object' || ctx === null) throw new OidcError('invalid_input');
    const { now: rawNow, deployEnv } = ctx;
    if (typeof rawNow !== 'number' || !Number.isFinite(rawNow) || !isOneOf(DEPLOY_ENVS, deployEnv)) throw new OidcError('invalid_input');
    const now = Math.floor(rawNow);

    const token = parseCompact(bearer, this.cfg.maxTokenLength, this.cfg.allowedAlgs);
    const key = await this.cache.getKey(token.kid);
    // The key, not the header, decides the algorithm. A mismatch is confusion.
    if (key.alg !== token.alg) throw new OidcError('unsupported_alg');
    if (!verifySignature(key, token.signingInput, token.signature)) throw new OidcError('bad_signature');

    const { claims, registered } = parseRegistered(parseJsonBytes(token.payloadBytes, 'invalid_claims'), this.cfg);
    checkIssuer(registered, this.cfg);
    checkAudience(registered, this.cfg);
    checkTimes(registered, now, this.cfg);
    const principal = mapPrincipal(claims, registered, this.cfg, deployEnv);

    let revoked: unknown;
    try {
      revoked = await this.isRevoked(registered.jti);
    } catch {
      throw new OidcError('revocation_unavailable');
    }
    if (revoked === true) throw new OidcError('revoked');
    if (revoked !== false) throw new OidcError('revocation_unavailable');
    return principal;
  }
}
