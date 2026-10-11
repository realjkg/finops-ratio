// OIDC verifier configuration (checklist 1.1 and 1.3). Trust boundary: the
// configuration is operator input (environment or a file), not request input,
// but it decides who is let in, so it is parsed as strictly as a token: every
// field is typed and capped, unknown fields are refused (a typo in a security
// setting must not silently fall back to a default), and any problem raises a
// fixed-text OidcError('invalid_config') that never echoes the offending value.
//
// Deny by default: org-wide scope, email-shaped subjects and every claim not
// named here are refused unless the config says otherwise.

import { PERSONA_ROLES, isOneOf, type PersonaRole } from '@/identity/types';
import { OidcError } from './errors';
import { OIDC_ALGS, TOKEN_CHARS_RE, ID_RE, isBoundedText, isOidcAlg, isPlainObject, type OidcAlg } from './shared';

/** Hard cap on the allowed clock skew, in seconds. */
export const MAX_CLOCK_SKEW_SECONDS = 120;
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;
/** Hard cap on the configurable token lifetime, in seconds (24 hours). */
export const MAX_LIFETIME_CEILING_SECONDS = 86_400;
export const DEFAULT_MAX_TOKEN_LENGTH = 8192;
export const MAX_TOKEN_LENGTH_CEILING = 16_384;
export const MAX_GROUP_MAPPINGS = 256;
export const MAX_ALLOWED_TENANTS = 64;
export const MAX_EXTRA_CLAIMS = 64;

/**
 * Role precedence when several of a token's groups map to different roles:
 * the role that appears EARLIEST in the list wins, whatever the order of the
 * groups claim. The default puts the narrowest grant first (least privilege):
 * the read-only auditor, then the two single-purpose approvers, then the
 * team-scoped engineering lead, then the org-wide FinOps lead and CTO. The
 * owner may replace it with `rolePrecedence`.
 */
export const DEFAULT_ROLE_PRECEDENCE: readonly PersonaRole[] = Object.freeze([
  'auditor', 'procurement', 'finance', 'eng_lead', 'finops_lead', 'cto',
] as const);

export const REGISTERED_CLAIMS: readonly string[] = Object.freeze(['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'] as const);

/**
 * Standard OIDC claims that are tolerated and ignored (never read into the
 * Principal). Anything not listed here, not registered and not configured is
 * refused. Deliberately absent: `cnf` (a proof-of-possession token must not
 * be accepted as a plain bearer), `nonce`, `at_hash` and `c_hash` (they mark
 * an ID token, which is a login artifact and must not be replayed as an API
 * bearer; an operator who really needs them lists them in `extraIgnoredClaims`),
 * and every group- or role-bearing name, which only counts if the config names it.
 */
export const STANDARD_IGNORED_CLAIMS: readonly string[] = Object.freeze([
  'azp', 'client_id', 'scope', 'scp', 'auth_time', 'acr', 'amr', 'sid', 'ver',
  'email', 'email_verified', 'name', 'given_name', 'family_name', 'preferred_username', 'oid', 'tid', 'idp', 'upn',
] as const);

export interface OidcClaimNames {
  /** Claim holding the array of group names (mapped through `groupToRole`). */
  groups: string;
  /** Claim holding the tenant id (a single string). */
  tenant: string;
  /** Claim holding the team list, or the whole-value string `'*'`. */
  teams: string;
  /** Claim holding the deploy environments (`dev`, `test`, `prod`). */
  envs: string;
}

export interface OidcJwksOptions {
  /** How long a fetched key set is fresh. Default 600; 30 to 86400. */
  ttlSeconds?: number;
  /** Minimum gap between network fetches (success or failure). Default 30; 1 to ttlSeconds. */
  refreshCooldownSeconds?: number;
  /** How long past the TTL a stale set may be served when refresh fails. Default 3600; 0 to 86400. */
  staleIfErrorSeconds?: number;
  /** Most keys a key-set document may list. Default 16; 1 to 64. */
  maxKeys?: number;
  /** Most bytes a key-set document may hold. Default 65536; 1024 to 262144. */
  maxBytes?: number;
  /** Deadline for one fetch, in milliseconds. Default 5000; 100 to 30000. */
  fetchTimeoutMs?: number;
}

export interface OidcConfig {
  /** Exact `iss` to accept. An https URL with no query or fragment. */
  issuer: string;
  /** The value `aud` must equal (or contain, when `aud` is an array). */
  audience: string;
  /** Expected `azp` (client id). Defaults to the audience. Required when `aud` lists several values; when `azp` is present it must equal this. */
  authorizedParty?: string;
  /** https URL of the provider's key set. */
  jwksUri: string;
  /** Allowed clock skew in seconds, 0 to 120. Default 30. */
  clockSkewSeconds?: number;
  /** Longest `exp - iat` accepted, 1 to 86400 seconds. */
  maxTokenLifetimeSeconds: number;
  /** Group name (exact, case-sensitive) to Ratio persona role. */
  groupToRole: Readonly<Record<string, PersonaRole>>;
  /** Earlier wins when groups map to different roles. Defaults to DEFAULT_ROLE_PRECEDENCE. */
  rolePrecedence?: readonly PersonaRole[];
  claims: OidcClaimNames;
  /** Non-empty subset of RS256, ES256, EdDSA. */
  allowedAlgs: readonly OidcAlg[];
  /** Tenant ids this deployment serves. A token for any other tenant is refused. */
  allowedTenants: readonly string[];
  /** Allow `'*'` as a whole teams value. Default false. */
  allowOrgWide?: boolean;
  /** Refuse an email-shaped `sub`. Default true; set false only deliberately. */
  rejectEmailSub?: boolean;
  /** Extra claim names to tolerate and ignore, beyond STANDARD_IGNORED_CLAIMS. */
  extraIgnoredClaims?: readonly string[];
  /** Longest compact token accepted, in characters. Default 8192; up to 16384. */
  maxTokenLength?: number;
  jwks?: OidcJwksOptions;
}

export interface ResolvedJwksOptions {
  readonly ttlSeconds: number;
  readonly refreshCooldownSeconds: number;
  readonly staleIfErrorSeconds: number;
  readonly maxKeys: number;
  readonly maxBytes: number;
  readonly fetchTimeoutMs: number;
}

export interface ResolvedOidcConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly authorizedParty: string;
  readonly jwksUri: string;
  readonly clockSkewSeconds: number;
  readonly maxTokenLifetimeSeconds: number;
  readonly groupToRole: ReadonlyMap<string, PersonaRole>;
  readonly rolePrecedence: readonly PersonaRole[];
  readonly claims: Readonly<OidcClaimNames>;
  readonly allowedAlgs: ReadonlySet<OidcAlg>;
  readonly allowedTenants: ReadonlySet<string>;
  readonly allowOrgWide: boolean;
  readonly rejectEmailSub: boolean;
  /** Registered, configured, standard-ignored and extra claim names: the only names a token may carry. */
  readonly knownClaims: ReadonlySet<string>;
  readonly maxTokenLength: number;
  readonly jwks: ResolvedJwksOptions;
}

const TOP_KEYS: ReadonlySet<string> = new Set([
  'issuer', 'audience', 'authorizedParty', 'jwksUri', 'clockSkewSeconds', 'maxTokenLifetimeSeconds', 'groupToRole', 'rolePrecedence',
  'claims', 'allowedAlgs', 'allowedTenants', 'allowOrgWide', 'rejectEmailSub', 'extraIgnoredClaims', 'maxTokenLength', 'jwks',
]);
const CLAIM_NAME_KEYS: readonly (keyof OidcClaimNames)[] = ['groups', 'tenant', 'teams', 'envs'];
const JWKS_KEYS: ReadonlySet<string> = new Set(['ttlSeconds', 'refreshCooldownSeconds', 'staleIfErrorSeconds', 'maxKeys', 'maxBytes', 'fetchTimeoutMs']);
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const bad = (): never => {
  throw new OidcError('invalid_config');
};

function onlyKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) bad();
}

function intIn(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return bad();
  return v;
}

function optionalInt(o: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  return Object.hasOwn(o, key) && o[key] !== undefined ? intIn(o[key], min, max) : def;
}

function optionalBool(o: Record<string, unknown>, key: string, def: boolean): boolean {
  if (!Object.hasOwn(o, key) || o[key] === undefined) return def;
  return typeof o[key] === 'boolean' ? (o[key] as boolean) : bad();
}

/** An https URL, printable ASCII only, no credentials, no fragment, no backslash. Returns the parsed URL. */
function httpsUrl(v: unknown, max: number): URL {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !TOKEN_CHARS_RE.test(v) || v.includes('\\') || v.includes('#')) return bad();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad();
  }
  if (u.protocol !== 'https:' || u.hostname === '' || u.username !== '' || u.password !== '') return bad();
  return u;
}

function claimName(v: unknown): string {
  if (!isBoundedText(v, 128) || !TOKEN_CHARS_RE.test(v) || FORBIDDEN_NAMES.has(v)) return bad();
  return v;
}

function parseClaimNames(v: unknown): OidcClaimNames {
  if (!isPlainObject(v)) return bad();
  onlyKeys(v, new Set(CLAIM_NAME_KEYS));
  const out = {} as OidcClaimNames;
  const seen = new Set<string>(REGISTERED_CLAIMS);
  for (const key of CLAIM_NAME_KEYS) {
    if (!Object.hasOwn(v, key)) return bad();
    const name = claimName(v[key]);
    if (seen.has(name)) return bad(); // distinct, and never a registered name
    seen.add(name);
    out[key] = name;
  }
  return out;
}

function parseGroupToRole(v: unknown): Map<string, PersonaRole> {
  if (!isPlainObject(v)) return bad();
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.length > MAX_GROUP_MAPPINGS) return bad();
  const map = new Map<string, PersonaRole>();
  for (const group of keys) {
    const role = v[group];
    if (!isBoundedText(group, 256) || !isOneOf(PERSONA_ROLES, role)) return bad(); // never legacy_service
    map.set(group, role);
  }
  return map;
}

function parsePrecedence(v: unknown, mapped: ReadonlyMap<string, PersonaRole>): readonly PersonaRole[] {
  if (v === undefined) return DEFAULT_ROLE_PRECEDENCE;
  if (!Array.isArray(v) || v.length === 0 || v.length > PERSONA_ROLES.length) return bad();
  const seen = new Set<PersonaRole>();
  for (const r of v) {
    if (!isOneOf(PERSONA_ROLES, r) || seen.has(r)) return bad();
    seen.add(r);
  }
  // Every mapped role needs a rank, or the choice would depend on something else.
  for (const role of mapped.values()) if (!seen.has(role)) return bad();
  return Object.freeze([...seen]);
}

function parseAlgs(v: unknown): Set<OidcAlg> {
  if (!Array.isArray(v) || v.length === 0 || v.length > OIDC_ALGS.length) return bad();
  const out = new Set<OidcAlg>();
  for (const a of v) {
    if (!isOidcAlg(a) || out.has(a)) return bad();
    out.add(a);
  }
  return out;
}

function parseTenants(v: unknown): Set<string> {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ALLOWED_TENANTS) return bad();
  const out = new Set<string>();
  for (const t of v) {
    if (typeof t !== 'string' || !ID_RE.test(t) || out.has(t)) return bad();
    out.add(t);
  }
  return out;
}

function parseExtraClaims(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_EXTRA_CLAIMS) return bad();
  return v.map(claimName);
}

function parseJwksOptions(v: unknown): ResolvedJwksOptions {
  const o = v === undefined ? {} : v;
  if (!isPlainObject(o)) return bad();
  onlyKeys(o, JWKS_KEYS);
  const ttlSeconds = optionalInt(o, 'ttlSeconds', 600, 30, 86_400);
  const refreshCooldownSeconds = optionalInt(o, 'refreshCooldownSeconds', Math.min(30, ttlSeconds), 1, ttlSeconds);
  return Object.freeze({
    ttlSeconds,
    refreshCooldownSeconds,
    staleIfErrorSeconds: optionalInt(o, 'staleIfErrorSeconds', 3600, 0, 86_400),
    maxKeys: optionalInt(o, 'maxKeys', 16, 1, 64),
    maxBytes: optionalInt(o, 'maxBytes', 65_536, 1024, 262_144),
    fetchTimeoutMs: optionalInt(o, 'fetchTimeoutMs', 5000, 100, 30_000),
  });
}

/**
 * Validate and normalize a configuration. Throws OidcError('invalid_config')
 * (fixed text) for any problem. The result is frozen.
 */
export function resolveOidcConfig(input: unknown): ResolvedOidcConfig {
  if (!isPlainObject(input)) return bad();
  onlyKeys(input, TOP_KEYS);
  for (const required of ['issuer', 'audience', 'jwksUri', 'maxTokenLifetimeSeconds', 'groupToRole', 'claims', 'allowedAlgs', 'allowedTenants'] as const) {
    if (!Object.hasOwn(input, required)) return bad();
  }

  const issuerUrl = httpsUrl(input.issuer, 512);
  if (issuerUrl.search !== '' || (input.issuer as string).includes('?')) return bad();
  const issuer = input.issuer as string; // exact string comparison later, so keep it as written
  if (typeof input.audience !== 'string' || input.audience.length > 256 || !TOKEN_CHARS_RE.test(input.audience)) return bad();
  const azp = input.authorizedParty === undefined ? input.audience : input.authorizedParty;
  if (typeof azp !== 'string' || azp.length > 256 || !TOKEN_CHARS_RE.test(azp)) return bad();
  const jwksUri = httpsUrl(input.jwksUri, 2048).href;

  const groupToRole = parseGroupToRole(input.groupToRole);
  const claims = parseClaimNames(input.claims);
  const extra = parseExtraClaims(input.extraIgnoredClaims);
  const known = new Set<string>([...REGISTERED_CLAIMS, ...STANDARD_IGNORED_CLAIMS, ...extra, claims.groups, claims.tenant, claims.teams, claims.envs]);

  const resolved: ResolvedOidcConfig = {
    issuer,
    audience: input.audience,
    authorizedParty: azp,
    jwksUri,
    clockSkewSeconds: optionalInt(input, 'clockSkewSeconds', DEFAULT_CLOCK_SKEW_SECONDS, 0, MAX_CLOCK_SKEW_SECONDS),
    maxTokenLifetimeSeconds: intIn(input.maxTokenLifetimeSeconds, 1, MAX_LIFETIME_CEILING_SECONDS),
    groupToRole,
    rolePrecedence: parsePrecedence(input.rolePrecedence, groupToRole),
    claims: Object.freeze(claims),
    allowedAlgs: parseAlgs(input.allowedAlgs),
    allowedTenants: parseTenants(input.allowedTenants),
    allowOrgWide: optionalBool(input, 'allowOrgWide', false),
    rejectEmailSub: optionalBool(input, 'rejectEmailSub', true),
    knownClaims: known,
    maxTokenLength: optionalInt(input, 'maxTokenLength', DEFAULT_MAX_TOKEN_LENGTH, 256, MAX_TOKEN_LENGTH_CEILING),
    jwks: parseJwksOptions(input.jwks),
  };
  return Object.freeze(resolved);
}
