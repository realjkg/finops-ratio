// Test-only helpers for the OIDC suites: key generation, token forging, a fake
// key-set server and a verifier harness with an injected clock. Not exported
// from index.ts and never imported by production code. Keys are generated in
// memory per run, exported only as public JWKs, and never written anywhere.

import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { OidcVerifier, type OidcConfig, type OidcErrorCode } from './index';
import { OidcError } from './errors';
import type { FetchJwks } from './jwks';
import type { OidcAlg } from './shared';
import type { DeployEnv } from '@/identity/types';

export const ISSUER = 'https://idp.example.test/';
export const AUDIENCE = 'api://ratio';
export const JWKS_URI = 'https://idp.example.test/.well-known/jwks.json';
export const NOW = 1_800_000_000;

export interface TestKey {
  readonly kid: string;
  readonly alg: OidcAlg;
  readonly privateKey: KeyObject;
  /** The public JWK exactly as a provider would publish it (kid, use and alg included). */
  readonly jwk: Record<string, unknown>;
}

function wrap(kid: string, alg: OidcAlg, privateKey: KeyObject, publicKey: KeyObject): TestKey {
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg };
  return { kid, alg, privateKey, jwk };
}

export function rsaKey(kid: string, bits = 2048): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return wrap(kid, 'RS256', privateKey, publicKey);
}
export function ecKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return wrap(kid, 'ES256', privateKey, publicKey);
}
export function edKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return wrap(kid, 'EdDSA', privateKey, publicKey);
}

let memo: { rsa: TestKey; ec: TestKey; ed: TestKey; other: TestKey } | undefined;
/** One key of each kind, generated once per test file. `other` is a second EdDSA key (an attacker's, or a rotation target). */
export function keys(): { rsa: TestKey; ec: TestKey; ed: TestKey; other: TestKey } {
  memo ??= { rsa: rsaKey('rsa-1'), ec: ecKey('ec-1'), ed: edKey('ed-1'), other: edKey('other-1') };
  return memo;
}

export function signBytes(key: Pick<TestKey, 'alg' | 'privateKey'>, data: Buffer): Buffer {
  switch (key.alg) {
    case 'RS256':
      return sign('sha256', data, key.privateKey);
    case 'ES256':
      return sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    default:
      return sign(null, data, key.privateKey);
  }
}

export const b64u = (v: string | Buffer | object): string =>
  Buffer.from(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).toString('base64url');

export function baseClaims(): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'user-123',
    aud: AUDIENCE,
    iat: NOW,
    exp: NOW + 3600,
    jti: 'jti-0001',
    groups: ['ratio-finops'],
    tenant: 'acme',
    teams: ['Platform Eng', 'CX Engineering'],
    envs: ['dev', 'test', 'prod'],
  };
}

export interface MakeTokenOptions {
  /** Merged over the default header; a key set to undefined is removed. */
  header?: Record<string, unknown>;
  /** Merged over the default claims; a key set to undefined is removed. */
  claims?: Record<string, unknown>;
  /** Raw payload JSON text, used instead of the claims object. */
  rawPayload?: string;
  /** Sign with this key instead of the header key. */
  signWith?: Pick<TestKey, 'alg' | 'privateKey'>;
  /** Replace the signature bytes entirely. */
  signature?: Buffer | ((signingInput: Buffer) => Buffer);
}

function merged(base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = { ...base, ...(over ?? {}) };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** A compact JWS signed with `key` (or the override), defaults valid at NOW + 5. */
export function makeToken(key: TestKey, o: MakeTokenOptions = {}): string {
  const header = merged({ alg: key.alg, typ: 'JWT', kid: key.kid }, o.header);
  const payloadText = o.rawPayload ?? JSON.stringify(merged(baseClaims(), o.claims));
  const signingInput = `${b64u(header)}.${b64u(payloadText)}`;
  const data = Buffer.from(signingInput, 'utf8');
  let sig: Buffer;
  if (typeof o.signature === 'function') sig = o.signature(data);
  else if (o.signature) sig = o.signature;
  else sig = signBytes(o.signWith ?? key, data);
  return `${signingInput}.${b64u(sig)}`;
}

export function parts(token: string): [string, string, string] {
  const p = token.split('.');
  return [p[0], p[1], p[2]];
}

/** HMAC-SHA256 "signature" keyed with the public key material: the classic confusion attack. */
export function hmacWithPublicKey(key: TestKey): (data: Buffer) => Buffer {
  const material = Buffer.from(JSON.stringify(key.jwk), 'utf8');
  return (data) => createHmac('sha256', material).update(data).digest();
}

export function jwksDocument(list: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ keys: list });
}

/** A scriptable key-set server behind the injected FetchJwks seam. */
export class FakeJwks {
  readonly calls: { url: string; maxBytes: number }[] = [];
  private respond: () => Promise<string | Uint8Array>;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  constructor(list: readonly TestKey[]) {
    const doc = jwksDocument(list.map((k) => k.jwk));
    this.respond = async () => doc;
  }
  setKeys(list: readonly TestKey[]): void {
    const doc = jwksDocument(list.map((k) => k.jwk));
    this.respond = async () => doc;
  }
  setBody(body: string | Uint8Array): void {
    this.respond = async () => body;
  }
  setFailure(): void {
    this.respond = async () => {
      throw new Error('network down');
    };
  }
  /** Make every fetch wait until release(). */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }
  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }
  readonly fetch: FetchJwks = async (url, opts) => {
    this.calls.push({ url, maxBytes: opts.maxBytes });
    if (this.gate) await this.gate;
    return this.respond();
  };
}

export const BASE_CONFIG: OidcConfig = Object.freeze({
  issuer: ISSUER,
  audience: AUDIENCE,
  jwksUri: JWKS_URI,
  clockSkewSeconds: 60,
  maxTokenLifetimeSeconds: 3600,
  groupToRole: Object.freeze({
    'ratio-cto': 'cto',
    'ratio-finops': 'finops_lead',
    'ratio-finance': 'finance',
    'ratio-eng': 'eng_lead',
    'ratio-procurement': 'procurement',
    'ratio-audit': 'auditor',
  } as const),
  claims: Object.freeze({ groups: 'groups', tenant: 'tenant', teams: 'teams', envs: 'envs' }),
  allowedAlgs: Object.freeze(['RS256', 'ES256', 'EdDSA'] as const),
  allowedTenants: Object.freeze(['acme']),
  jwks: Object.freeze({ ttlSeconds: 600, refreshCooldownSeconds: 30, staleIfErrorSeconds: 3600 }),
}) as OidcConfig;

export interface Harness {
  verifier: OidcVerifier;
  jwks: FakeJwks;
  clock: { t: number };
  revokedIds: Set<string>;
  revocationCalls: string[];
  /** Verify at NOW + 5 in the `test` deployment unless overridden. */
  verify: (token: unknown, ctx?: Partial<{ now: number; deployEnv: DeployEnv }>) => ReturnType<OidcVerifier['verify']>;
}

export function harness(list: readonly TestKey[], over: Partial<OidcConfig> = {}): Harness {
  const jwks = new FakeJwks(list);
  const clock = { t: NOW };
  const revokedIds = new Set<string>();
  const revocationCalls: string[] = [];
  const verifier = new OidcVerifier({ ...BASE_CONFIG, ...over }, {
    fetchJwks: jwks.fetch,
    isRevoked: async (jti) => {
      revocationCalls.push(jti);
      return revokedIds.has(jti);
    },
    clock: () => clock.t,
    createSignal: () => new AbortController().signal,
  });
  return {
    verifier,
    jwks,
    clock,
    revokedIds,
    revocationCalls,
    verify: (token, ctx = {}) => verifier.verify(token as string, { now: NOW + 5, deployEnv: 'test', ...ctx }),
  };
}

/** The OidcError code a promise rejects with, or a marker for anything else. */
export async function codeOf(p: Promise<unknown>): Promise<OidcErrorCode | 'no-throw' | 'not-an-oidc-error'> {
  try {
    await p;
  } catch (err) {
    return err instanceof OidcError ? err.code : 'not-an-oidc-error';
  }
  return 'no-throw';
}

/** A segment spelled non-canonically: same bytes, stray low bits set. Null when the length leaves no stray bits. */
export function nonCanonical(segment: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const rem = segment.length % 4;
  if (rem !== 2 && rem !== 3) return null;
  const last = alphabet.indexOf(segment[segment.length - 1]);
  const stray = rem === 2 ? 0b1111 : 0b11;
  if ((last & stray) !== 0) return null; // already carries stray bits
  return segment.slice(0, -1) + alphabet[last | 1];
}
