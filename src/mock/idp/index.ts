// Public surface of the mock identity provider (card A2). Fixture identities
// for local and test runs only; every entry point is gated by mockIdpEnabled.

export { mockIdpEnabled, type MockIdpEnv } from './enabled';
export {
  MOCK_DEPLOY_ENVS,
  MOCK_PERSONAS,
  MOCK_ROLES,
  MOCK_TENANT,
  findMockPersona,
  type MockDeployEnv,
  type MockPersona,
  type MockPersonaId,
  type MockRole,
} from './personas';
export {
  MAX_TOKEN_LENGTH,
  MAX_TOKEN_TTL_SECONDS,
  MOCK_IDP_ALG,
  MOCK_IDP_ISSUER,
  MockIdpError,
  isMockDeployEnv,
  isMockRole,
  parseClaims,
  type MockIdpClaims,
  type MockIdpErrorCode,
} from './claims';
export {
  DEFAULT_TOKEN_TTL_SECONDS,
  LOGIN_TOKEN_TTL_SECONDS,
  MAX_TRACKED_TOKENS,
  issueLoginToken,
  issuePersonaToken,
  issueToken,
  publicJwks,
  reissueSubject,
  retireSigningKey,
  revokeSubject,
  revokeToken,
  rotateSigningKey,
  type IssueInput,
  type IssuedToken,
  type MockIdpJwk,
  type PersonaIssueOptions,
} from './issuer';
export { redeemLoginToken, verifyToken, type VerifyContext } from './verifier';
