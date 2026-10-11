// Mock IdP claim shape, strict parser and the fixed error type (card A2).
// The verifier returns these raw claims; card B1's MockIdpVerifier maps them
// onto the gateway's Principal. Nothing here knows about Principal.

import { MOCK_DEPLOY_ENVS, MOCK_ROLES, type MockDeployEnv, type MockRole } from './personas';

export const MOCK_IDP_ISSUER = 'urn:ratio:mock-idp';
export const MOCK_IDP_ALG = 'EdDSA';
/** Upper bound on any token lifetime, in seconds. */
export const MAX_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface MockIdpClaims {
  iss: string;
  /** The deployment environment the token is for. */
  aud: MockDeployEnv;
  sub: string;
  /** Epoch seconds. */
  iat: number;
  /** Epoch seconds. */
  exp: number;
  jti: string;
  role: MockRole;
  teams: string[] | '*';
  envs: MockDeployEnv[];
  tenant: string;
  /** Present only on one-time login tokens. */
  once?: true;
}

export type MockIdpErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'unknown_persona'
  | 'key_state'
  | 'capacity'
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'invalid_claims'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'revoked'
  | 'replayed'
  | 'wrong_token_use';

// Fixed text per code. A message never echoes a token, a claim value or any
// other caller input.
const MESSAGES: Readonly<Record<MockIdpErrorCode, string>> = Object.freeze({
  disabled: 'mock identity provider is not enabled',
  invalid_input: 'mock identity provider input is invalid',
  unknown_persona: 'persona is not recognized',
  key_state: 'signing key operation is not allowed',
  capacity: 'mock identity provider token capacity reached',
  malformed: 'token is malformed',
  unsupported_alg: 'token algorithm is not accepted',
  unknown_kid: 'token signing key is not recognized',
  bad_signature: 'token signature is invalid',
  invalid_claims: 'token claims are invalid',
  wrong_audience: 'token audience does not match this deployment',
  expired: 'token has expired',
  not_yet_valid: 'token is not yet valid',
  revoked: 'token has been revoked',
  replayed: 'token has already been used',
  wrong_token_use: 'token is not valid for this use',
});

// Brand shared by every loaded copy of this module, so `instanceof` works
// across separately loaded module instances (Next.js route bundles).
const ERROR_BRAND = Symbol.for('ratio.mockIdp.error');

export class MockIdpError extends Error {
  readonly code: MockIdpErrorCode;
  constructor(code: MockIdpErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MockIdpError';
    this.code = code;
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[ERROR_BRAND] === true;
  }
}

export function isMockDeployEnv(value: unknown): value is MockDeployEnv {
  return typeof value === 'string' && (MOCK_DEPLOY_ENVS as readonly string[]).includes(value);
}

export function isMockRole(value: unknown): value is MockRole {
  return typeof value === 'string' && (MOCK_ROLES as readonly string[]).includes(value);
}

const SUBJECT_RE = /^[A-Za-z0-9._:|-]{1,128}$/;
const JTI_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_TEAMS = 64;
const MAX_TEAM_LENGTH = 128;
const REQUIRED_KEYS = ['iss', 'aud', 'sub', 'iat', 'exp', 'jti', 'role', 'teams', 'envs', 'tenant'] as const;
const OPTIONAL_KEYS = ['once'] as const;
const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseTeams(value: unknown): string[] | '*' | null {
  if (value === '*') return '*';
  if (!Array.isArray(value) || value.length > MAX_TEAMS) return null;
  const seen = new Set<string>();
  for (const team of value) {
    if (typeof team !== 'string' || team.length === 0 || team.length > MAX_TEAM_LENGTH) return null;
    if (team === '*' || team.trim() !== team || seen.has(team)) return null;
    seen.add(team);
  }
  return [...seen];
}

function parseEnvs(value: unknown): MockDeployEnv[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MOCK_DEPLOY_ENVS.length) return null;
  const seen = new Set<MockDeployEnv>();
  for (const env of value) {
    if (!isMockDeployEnv(env) || seen.has(env)) return null;
    seen.add(env);
  }
  return [...seen];
}

/**
 * Strict structural parse of a claim set. Rejects unknown claims, wrong
 * types, an audience array, a foreign issuer, a role outside the six mock
 * personas, a wildcard inside a team list, and lifetimes that are not
 * positive or exceed MAX_TOKEN_TTL_SECONDS. Time and audience checks against
 * the current deployment are the verifier's job.
 */
export function parseClaims(payload: unknown): MockIdpClaims {
  const fail = (): never => {
    throw new MockIdpError('invalid_claims');
  };
  if (!isPlainObject(payload)) return fail();
  for (const key of Object.keys(payload)) if (!ALLOWED_KEYS.has(key)) fail();
  for (const key of REQUIRED_KEYS) if (!Object.prototype.hasOwnProperty.call(payload, key)) fail();

  const { iss, aud, sub, iat, exp, jti, role, tenant } = payload;
  if (iss !== MOCK_IDP_ISSUER) fail();
  if (!isMockDeployEnv(aud)) return fail();
  if (typeof sub !== 'string' || !SUBJECT_RE.test(sub)) return fail();
  if (typeof tenant !== 'string' || !SUBJECT_RE.test(tenant)) return fail();
  if (!isEpochSeconds(iat) || !isEpochSeconds(exp)) return fail();
  if (exp <= iat || exp - iat > MAX_TOKEN_TTL_SECONDS) fail();
  if (typeof jti !== 'string' || !JTI_RE.test(jti)) return fail();
  if (!isMockRole(role)) return fail();
  const teams = parseTeams(payload.teams);
  const envs = parseEnvs(payload.envs);
  if (teams === null || envs === null) return fail();

  const claims: MockIdpClaims = { iss: MOCK_IDP_ISSUER, aud, sub, iat, exp, jti, role, teams, envs, tenant };
  if (Object.prototype.hasOwnProperty.call(payload, 'once')) {
    if (payload.once !== true) fail();
    claims.once = true;
  }
  return claims;
}
