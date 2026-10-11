// OIDC claim parsing, time checks and the claim-to-Principal mapping
// (checklist 1.1 and 1.3). Trust boundary: the payload of a token whose
// signature has ALREADY verified. A valid signature proves who issued the
// claims, not that they are well formed or that this deployment should honor
// them, so each is parsed strictly and the mapping denies by default.
//
// Three steps, called in this order by the verifier:
//   1. parseRegistered: unknown claims, required claims, and types of the
//      registered claims (iss, sub, aud, exp, nbf, iat, jti);
//   2. checkIssuer / checkAudience / checkTimes: exact issuer, audience
//      (string or array containing the configured value), exp / nbf / iat with
//      bounded skew, and the lifetime cap;
//   3. mapPrincipal: groups to a role (deny when none maps; explicit
//      precedence when several do), tenant (must be one this deployment
//      serves), teams (strict list, or '*' only as the whole value and only
//      if the config allows org-wide), envs (must include the deployment's
//      own environment), authMethod 'oidc'.
//
// Principal.sub is the provider's stable subject id and is never an email:
// the default character class has no '@', and the optional looser class is
// used only when the config explicitly stops rejecting email-shaped subjects.

import type { DeployEnv, PersonaRole, Principal } from '@/identity/types';
import { DEPLOY_ENVS, isOneOf } from '@/identity/types';
import type { ResolvedOidcConfig } from './config';
import { OidcError, type OidcErrorCode } from './errors';
import { ID_RE, JTI_RE, LOOSE_SUBJECT_RE, isBoundedText, isEpochSeconds, isPlainObject } from './shared';

export const MAX_AUDIENCES = 16;
export const MAX_GROUPS = 256;
export const MAX_TEAMS = 64;
const MAX_TEAM_LENGTH = 128;
const MAX_GROUP_LENGTH = 256;
const MAX_CLAIM_TEXT = 512;

export interface RegisteredClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nbf: number | undefined;
  readonly jti: string;
  readonly azp: string | undefined;
}

// A function declaration (not an arrow) so TypeScript narrows after a call to it.
function fail(code: OidcErrorCode = 'invalid_claims'): never {
  throw new OidcError(code);
}

function parseSubject(v: unknown, cfg: ResolvedOidcConfig): string {
  if (typeof v !== 'string') return fail();
  if (cfg.rejectEmailSub && v.includes('@')) return fail('invalid_subject');
  if (!(cfg.rejectEmailSub ? ID_RE : LOOSE_SUBJECT_RE).test(v)) return fail('invalid_subject');
  return v;
}

function parseAudience(v: unknown): string | readonly string[] {
  if (isBoundedText(v, MAX_CLAIM_TEXT)) return v;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_AUDIENCES) return fail();
  if (!v.every((a) => isBoundedText(a, MAX_CLAIM_TEXT))) return fail();
  return Object.freeze([...(v as string[])]);
}

/**
 * Step 1. Strict structural parse of the payload: only known claim names, the
 * required ones present, registered claims of the right type.
 */
export function parseRegistered(payload: unknown, cfg: ResolvedOidcConfig): { claims: Record<string, unknown>; registered: RegisteredClaims } {
  if (!isPlainObject(payload)) return fail();
  for (const key of Object.keys(payload)) if (!cfg.knownClaims.has(key)) fail();
  const required = ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', cfg.claims.groups, cfg.claims.tenant, cfg.claims.teams, cfg.claims.envs];
  for (const key of required) if (!Object.hasOwn(payload, key)) fail();

  const { iss, exp, iat, jti } = payload;
  if (!isBoundedText(iss, MAX_CLAIM_TEXT)) fail();
  if (!isEpochSeconds(exp) || !isEpochSeconds(iat) || exp <= iat) fail();
  let nbf: number | undefined;
  if (Object.hasOwn(payload, 'nbf')) {
    if (!isEpochSeconds(payload.nbf) || payload.nbf >= exp) fail();
    nbf = payload.nbf;
  }
  if (typeof jti !== 'string' || !JTI_RE.test(jti)) fail();
  const sub = parseSubject(payload.sub, cfg);
  const aud = parseAudience(payload.aud);
  let azp: string | undefined;
  if (Object.hasOwn(payload, 'azp')) {
    if (!isBoundedText(payload.azp, MAX_CLAIM_TEXT)) fail();
    azp = payload.azp as string;
  }
  return { claims: payload, registered: { iss, sub, aud, exp, iat, nbf, jti, azp } };
}

/** Step 2a. The issuer must equal the configured value exactly (no trimming, no case folding). */
export function checkIssuer(reg: RegisteredClaims, cfg: ResolvedOidcConfig): void {
  if (reg.iss !== cfg.issuer) throw new OidcError('wrong_issuer');
}

/** Step 2b. `aud` equals the configured audience, or is an array containing it. */
export function checkAudience(reg: RegisteredClaims, cfg: ResolvedOidcConfig): void {
  const ok = typeof reg.aud === 'string' ? reg.aud === cfg.audience : reg.aud.includes(cfg.audience);
  if (!ok) throw new OidcError('wrong_audience');
  // OIDC Core: with several audiences azp is required; whenever present it must be us.
  const multi = typeof reg.aud !== 'string' && reg.aud.length > 1;
  if ((multi && reg.azp === undefined) || (reg.azp !== undefined && reg.azp !== cfg.authorizedParty)) {
    throw new OidcError('wrong_audience');
  }
}

/**
 * Step 2c. Time checks on whole seconds with the configured skew S:
 *   expired      when now >= exp + S
 *   not yet      when now < nbf - S, or now < iat - S
 *   lifetime     when exp - iat > maxTokenLifetimeSeconds
 */
export function checkTimes(reg: RegisteredClaims, now: number, cfg: ResolvedOidcConfig): void {
  const skew = cfg.clockSkewSeconds;
  if (now >= reg.exp + skew) throw new OidcError('expired');
  if (reg.nbf !== undefined && now < reg.nbf - skew) throw new OidcError('not_yet_valid');
  if (now < reg.iat - skew) throw new OidcError('not_yet_valid');
  if (reg.exp - reg.iat > cfg.maxTokenLifetimeSeconds) throw new OidcError('lifetime_exceeded');
}

function parseGroups(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_GROUPS) return fail();
  if (!v.every((g) => isBoundedText(g, MAX_GROUP_LENGTH))) return fail();
  return v as string[];
}

/** The role for a set of groups: unmapped groups are ignored; none mapped denies; the best-ranked mapped role wins. */
function chooseRole(groups: readonly string[], cfg: ResolvedOidcConfig): PersonaRole {
  const mapped = new Set<PersonaRole>();
  for (const g of groups) {
    const role = cfg.groupToRole.get(g);
    if (role !== undefined) mapped.add(role);
  }
  if (mapped.size === 0) throw new OidcError('no_role');
  // Rank by position in the explicit precedence list, never by claim order.
  let best: PersonaRole | undefined;
  let bestRank = Infinity;
  for (const role of mapped) {
    const rank = cfg.rolePrecedence.indexOf(role);
    if (rank !== -1 && rank < bestRank) {
      best = role;
      bestRank = rank;
    }
  }
  if (best === undefined) throw new OidcError('no_role'); // config validation makes this unreachable
  return best;
}

function parseTenant(v: unknown, cfg: ResolvedOidcConfig): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) return fail();
  if (!cfg.allowedTenants.has(v)) throw new OidcError('wrong_tenant');
  return v;
}

function parseTeams(v: unknown, cfg: ResolvedOidcConfig): string[] | '*' {
  if (v === '*') return cfg.allowOrgWide ? '*' : fail();
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TEAMS) return fail();
  const seen = new Set<string>();
  for (const team of v) {
    // No wildcard anywhere inside a list, not even as a substring; no padding; no duplicates.
    if (!isBoundedText(team, MAX_TEAM_LENGTH) || team.includes('*') || team.trim() !== team || seen.has(team)) return fail();
    seen.add(team);
  }
  return [...seen];
}

function parseEnvs(v: unknown): DeployEnv[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > DEPLOY_ENVS.length) return fail();
  const seen = new Set<DeployEnv>();
  for (const env of v) {
    if (!isOneOf(DEPLOY_ENVS, env) || seen.has(env)) return fail();
    seen.add(env);
  }
  return [...seen];
}

/** Step 3. Build the Principal from verified, time-checked claims. Throws OidcError on any denial. */
export function mapPrincipal(claims: Record<string, unknown>, reg: RegisteredClaims, cfg: ResolvedOidcConfig, deployEnv: DeployEnv): Principal {
  const role = chooseRole(parseGroups(claims[cfg.claims.groups]), cfg);
  const tenant = parseTenant(claims[cfg.claims.tenant], cfg);
  const teams = parseTeams(claims[cfg.claims.teams], cfg);
  const envs = parseEnvs(claims[cfg.claims.envs]);
  // An engineering lead is scoped to named teams (PLAN 4.1); an org-wide claim cannot widen it.
  if (role === 'eng_lead' && teams === '*') fail();
  // The audience is not per environment, so the envs claim is the environment binding.
  if (!envs.includes(deployEnv)) throw new OidcError('wrong_environment');

  return Object.freeze({
    sub: reg.sub,
    role,
    teams: teams === '*' ? '*' : Object.freeze(teams) as string[],
    envs: Object.freeze(envs) as DeployEnv[],
    tenant,
    tokenId: reg.jti,
    expiresAt: reg.exp,
    authMethod: 'oidc' as const,
  });
}
