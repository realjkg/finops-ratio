// Public surface of the OIDC identity slice (checklist Step 1). Provider
// neutral: issuer, audience, key-set location and claim names are
// configuration. Test helpers (testkit.ts) are deliberately not exported.

export { OidcVerifier, type IsRevoked, type OidcVerifierDeps } from './verifier';
export {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_MAX_TOKEN_LENGTH,
  DEFAULT_ROLE_PRECEDENCE,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_LIFETIME_CEILING_SECONDS,
  MAX_TOKEN_LENGTH_CEILING,
  REGISTERED_CLAIMS,
  STANDARD_IGNORED_CLAIMS,
  resolveOidcConfig,
  type OidcClaimNames,
  type OidcConfig,
  type OidcJwksOptions,
  type ResolvedOidcConfig,
} from './config';
export { OIDC_ERROR_CODES, OidcError, oidcErrorMessage, type OidcErrorCode } from './errors';
export { JwksCache, parseJwks, type FetchJwks, type FetchJwksOptions, type JwksCacheDeps } from './jwks';
export { MAX_DENYLIST_ENTRIES, createMemoryJtiDenylist, type JtiDenylist, type JtiDenylistOptions } from './denylist';
export { OIDC_ALGS, type OidcAlg } from './shared';
