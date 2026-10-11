// OIDC verifier error type (checklist 1.4). Every failure the verifier, the
// JWKS cache or the configuration check can raise is an OidcError carrying a
// code from a closed union. The message is fixed text per code: it never
// echoes a token, a claim value, a key id, a URL or any other caller input,
// and no cause or stack detail is attached beyond the standard Error stack.
// The gateway maps every code to the same 401 body; the code is for audit
// records and tests only.

export type OidcErrorCode =
  | 'invalid_config'
  | 'invalid_input'
  | 'malformed'
  | 'token_too_large'
  | 'unsupported_alg'
  | 'forbidden_header'
  | 'unknown_kid'
  | 'jwks_unavailable'
  | 'bad_signature'
  | 'invalid_claims'
  | 'invalid_subject'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'lifetime_exceeded'
  | 'wrong_tenant'
  | 'wrong_environment'
  | 'no_role'
  | 'revoked'
  | 'revocation_unavailable'
  | 'capacity'
  | 'internal';

/** Every code, for exhaustive tests and audit dashboards. */
export const OIDC_ERROR_CODES: readonly OidcErrorCode[] = Object.freeze([
  'invalid_config',
  'invalid_input',
  'malformed',
  'token_too_large',
  'unsupported_alg',
  'forbidden_header',
  'unknown_kid',
  'jwks_unavailable',
  'bad_signature',
  'invalid_claims',
  'invalid_subject',
  'wrong_issuer',
  'wrong_audience',
  'expired',
  'not_yet_valid',
  'lifetime_exceeded',
  'wrong_tenant',
  'wrong_environment',
  'no_role',
  'revoked',
  'revocation_unavailable',
  'capacity',
  'internal',
] as const);

const MESSAGES: Readonly<Record<OidcErrorCode, string>> = Object.freeze({
  invalid_config: 'oidc verifier configuration is invalid',
  invalid_input: 'oidc verification input is invalid',
  malformed: 'token is malformed',
  token_too_large: 'token exceeds the size limit',
  unsupported_alg: 'token algorithm is not accepted',
  forbidden_header: 'token header is not accepted',
  unknown_kid: 'token signing key is not recognized',
  jwks_unavailable: 'token signing keys are unavailable',
  bad_signature: 'token signature is invalid',
  invalid_claims: 'token claims are invalid',
  invalid_subject: 'token subject is not accepted',
  wrong_issuer: 'token issuer is not accepted',
  wrong_audience: 'token audience does not match this deployment',
  expired: 'token has expired',
  not_yet_valid: 'token is not yet valid',
  lifetime_exceeded: 'token lifetime exceeds the allowed maximum',
  wrong_tenant: 'token tenant is not accepted',
  wrong_environment: 'token is not valid for this environment',
  no_role: 'token grants no role',
  revoked: 'token has been revoked',
  revocation_unavailable: 'token revocation status could not be checked',
  capacity: 'revocation capacity reached',
  internal: 'token verification failed',
});

// Brand shared by every loaded copy of this module, so `instanceof` works
// across separately loaded module instances (Next.js route bundles).
const ERROR_BRAND = Symbol.for('ratio.oidc.error');

export class OidcError extends Error {
  readonly code: OidcErrorCode;
  constructor(code: OidcErrorCode) {
    super(MESSAGES[code]);
    this.name = 'OidcError';
    this.code = code;
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[ERROR_BRAND] === true;
  }
}

/** The fixed message for a code (never contains input). */
export function oidcErrorMessage(code: OidcErrorCode): string {
  return MESSAGES[code];
}
