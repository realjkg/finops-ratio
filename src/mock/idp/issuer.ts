// Mock IdP issuer and process state (card A2). Signs test JWTs with a
// locally generated Ed25519 key (EdDSA via node:crypto, no dependency).
// Keys are created in memory on first use, exported only as public JWKs and
// never written anywhere. Every entry point checks mockIdpEnabled() first.
//
// Process state (keys, issued and revoked token ids, redeemed one-time
// tokens) lives behind one globalThis symbol so separately loaded copies of
// this module (Next.js route bundles, vi.resetModules) share it.

import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import {
  MAX_TOKEN_TTL_SECONDS,
  MOCK_IDP_ALG,
  MOCK_IDP_ISSUER,
  MockIdpError,
  isMockDeployEnv,
  parseClaims,
  type MockIdpClaims,
} from './claims';
import { mockIdpEnabled, type MockIdpEnv } from './enabled';
import { findMockPersona, type MockDeployEnv, type MockRole } from './personas';

export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
export const LOGIN_TOKEN_TTL_SECONDS = 120;
/** Hard cap on tokens tracked per process. Issuing fails closed beyond it. */
export const MAX_TRACKED_TOKENS = 50_000;

export interface IssueInput {
  sub: string;
  role: MockRole;
  teams: readonly string[] | '*';
  envs: readonly MockDeployEnv[];
  tenant: string;
  /** Required: the deployment environment the token is for (its `aud`). */
  deployEnv: MockDeployEnv;
  ttlSeconds?: number;
  /** Epoch seconds; defaults to the wall clock. */
  now?: number;
}

export interface PersonaIssueOptions {
  deployEnv: MockDeployEnv;
  ttlSeconds?: number;
  now?: number;
}

export interface IssuedToken {
  token: string;
  jti: string;
  kid: string;
  /** Epoch seconds. */
  expiresAt: number;
}

export interface MockIdpJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
}

interface KeyEntry {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

interface MockIdpState {
  keys: Map<string, KeyEntry>;
  activeKid: string | null;
  /** jti -> subject, for revokeSubject. */
  issued: Map<string, string>;
  revoked: Set<string>;
  redeemed: Set<string>;
}

const STATE_KEY = Symbol.for('ratio.mockIdp');

function state(): MockIdpState {
  const g = globalThis as unknown as Record<symbol, MockIdpState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { keys: new Map(), activeKid: null, issued: new Map(), revoked: new Set(), redeemed: new Set() };
    Object.defineProperty(globalThis, STATE_KEY, { value: s, enumerable: false, configurable: true, writable: false });
  }
  return s;
}

function requireEnabled(env: MockIdpEnv): void {
  if (!mockIdpEnabled(env)) throw new MockIdpError('disabled');
}

function wallClock(): number {
  return Math.floor(Date.now() / 1000);
}

function newKid(): string {
  return randomBytes(16).toString('base64url');
}

function addKey(s: MockIdpState): string {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let kid = newKid();
  while (s.keys.has(kid)) kid = newKid();
  s.keys.set(kid, { publicKey, privateKey });
  s.activeKid = kid;
  return kid;
}

function activeKey(s: MockIdpState): { kid: string; entry: KeyEntry } {
  const kid = s.activeKid ?? addKey(s);
  const entry = s.keys.get(kid);
  if (!entry) throw new MockIdpError('key_state');
  return { kid, entry };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function issueClaims(input: IssueInput, once: boolean, defaultTtl: number): IssuedToken {
  if (typeof input !== 'object' || input === null) throw new MockIdpError('invalid_input');
  if (!isMockDeployEnv(input.deployEnv)) throw new MockIdpError('invalid_input');
  const now = input.now === undefined ? wallClock() : input.now;
  const ttl = input.ttlSeconds === undefined ? defaultTtl : input.ttlSeconds;
  if (!Number.isSafeInteger(now) || now <= 0) throw new MockIdpError('invalid_input');
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TOKEN_TTL_SECONDS) throw new MockIdpError('invalid_input');

  const s = state();
  if (s.issued.size >= MAX_TRACKED_TOKENS) throw new MockIdpError('capacity');

  let jti = randomBytes(16).toString('base64url');
  while (s.issued.has(jti)) jti = randomBytes(16).toString('base64url');

  const payload: MockIdpClaims = {
    iss: MOCK_IDP_ISSUER,
    aud: input.deployEnv,
    sub: input.sub,
    iat: now,
    exp: now + ttl,
    jti,
    role: input.role,
    teams: input.teams === '*' ? '*' : Array.isArray(input.teams) ? [...input.teams] : (input.teams as never),
    envs: Array.isArray(input.envs) ? [...input.envs] : (input.envs as never),
    tenant: input.tenant,
  };
  if (once) payload.once = true;

  // The issuer runs its own output through the verifier's strict parser, so
  // it can never sign a claim set the verifier would reject structurally.
  let claims: MockIdpClaims;
  try {
    claims = parseClaims(payload);
  } catch {
    throw new MockIdpError('invalid_input');
  }

  const { kid, entry } = activeKey(s);
  const signingInput = `${encodeJson({ alg: MOCK_IDP_ALG, typ: 'JWT', kid })}.${encodeJson(claims)}`;
  const signature = sign(null, Buffer.from(signingInput, 'utf8'), entry.privateKey).toString('base64url');
  s.issued.set(jti, claims.sub);
  return { token: `${signingInput}.${signature}`, jti, kid, expiresAt: claims.exp };
}

/** Issue a session token for an explicit claim set. */
export function issueToken(input: IssueInput, env: MockIdpEnv = process.env): IssuedToken {
  requireEnabled(env);
  return issueClaims(input, false, DEFAULT_TOKEN_TTL_SECONDS);
}

function personaInput(personaId: string, opts: PersonaIssueOptions): IssueInput {
  if (typeof opts !== 'object' || opts === null || !isMockDeployEnv(opts.deployEnv)) {
    throw new MockIdpError('invalid_input');
  }
  const p = typeof personaId === 'string' ? findMockPersona(personaId) : undefined;
  if (!p) throw new MockIdpError('unknown_persona');
  return { sub: p.sub, role: p.role, teams: p.teams, envs: p.envs, tenant: p.tenant, deployEnv: opts.deployEnv, ttlSeconds: opts.ttlSeconds, now: opts.now };
}

/** Issue a session token carrying a catalog persona's claims. */
export function issuePersonaToken(personaId: string, opts: PersonaIssueOptions, env: MockIdpEnv = process.env): IssuedToken {
  requireEnabled(env);
  return issueClaims(personaInput(personaId, opts), false, DEFAULT_TOKEN_TTL_SECONDS);
}

/**
 * Issue a short-lived one-time login token for a persona (claim `once`). It
 * is accepted only by redeemLoginToken, exactly once, and never as a session
 * token.
 */
export function issueLoginToken(personaId: string, opts: Omit<PersonaIssueOptions, 'ttlSeconds'>, env: MockIdpEnv = process.env): IssuedToken {
  requireEnabled(env);
  const input = personaInput(personaId, opts as PersonaIssueOptions);
  return issueClaims({ ...input, ttlSeconds: LOGIN_TOKEN_TTL_SECONDS }, true, LOGIN_TOKEN_TTL_SECONDS);
}

/**
 * Revoke one token id. Idempotent. An id this process never issued cannot
 * verify anyway, so it is ignored, which keeps the revoked set bounded by
 * the issued set.
 */
export function revokeToken(jti: string, env: MockIdpEnv = process.env): void {
  requireEnabled(env);
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 64) throw new MockIdpError('invalid_input');
  const s = state();
  if (s.issued.has(jti)) s.revoked.add(jti);
}

/** Revoke every token issued to `sub` so far (an expired session). */
export function revokeSubject(sub: string, env: MockIdpEnv = process.env): void {
  requireEnabled(env);
  if (typeof sub !== 'string' || sub.length === 0) throw new MockIdpError('invalid_input');
  const s = state();
  for (const [jti, owner] of s.issued) if (owner === sub) s.revoked.add(jti);
}

/**
 * Role or team change: issue a new token for the same subject with new
 * claims, after revoking every earlier token of that subject. The input is
 * validated before anything is revoked.
 */
export function reissueSubject(sub: string, input: IssueInput, env: MockIdpEnv = process.env): IssuedToken {
  requireEnabled(env);
  if (typeof sub !== 'string' || typeof input !== 'object' || input === null || input.sub !== sub) {
    throw new MockIdpError('invalid_input');
  }
  const s = state();
  const earlier = [...s.issued].filter(([, owner]) => owner === sub).map(([jti]) => jti);
  const next = issueClaims(input, false, DEFAULT_TOKEN_TTL_SECONDS);
  for (const jti of earlier) s.revoked.add(jti);
  return next;
}

/** Start signing with a new key. The previous key keeps verifying until retired. */
export function rotateSigningKey(env: MockIdpEnv = process.env): { kid: string } {
  requireEnabled(env);
  return { kid: addKey(state()) };
}

/** Remove a non-active key. Tokens signed with it no longer verify. */
export function retireSigningKey(kid: string, env: MockIdpEnv = process.env): void {
  requireEnabled(env);
  const s = state();
  if (typeof kid !== 'string' || kid === s.activeKid || !s.keys.has(kid)) throw new MockIdpError('key_state');
  s.keys.delete(kid);
}

/** Public verification keys as JWKs (no private parameters). */
export function publicJwks(env: MockIdpEnv = process.env): { keys: MockIdpJwk[] } {
  requireEnabled(env);
  const keys: MockIdpJwk[] = [];
  for (const [kid, entry] of state().keys) {
    const jwk = entry.publicKey.export({ format: 'jwk' });
    keys.push({ kty: 'OKP', crv: 'Ed25519', x: String(jwk.x), kid, alg: 'EdDSA', use: 'sig' });
  }
  return { keys };
}

/** Clear all process state in place (keys, revocations, redemptions). Tests only. */
export function resetMockIdpStateForTests(): void {
  const s = state();
  s.keys.clear();
  s.activeKid = null;
  s.issued.clear();
  s.revoked.clear();
  s.redeemed.clear();
}

// Internal accessors for verifier.ts. Not re-exported from index.ts.

export function verificationKeyForKid(kid: string): KeyObject | undefined {
  return state().keys.get(kid)?.publicKey;
}

export function isRevokedJti(jti: string): boolean {
  return state().revoked.has(jti);
}

/** Marks a one-time token as used. Returns false when it was already used. */
export function markRedeemed(jti: string): boolean {
  const s = state();
  if (s.redeemed.has(jti)) return false;
  s.redeemed.add(jti);
  return true;
}
