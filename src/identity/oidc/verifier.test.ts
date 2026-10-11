// Checklist 1.1 and 1.5: the OIDC verifier, end to end. Every token is forged
// in-test with generated keys and checked through the real OidcVerifier over a
// fake key-set server and an injected clock; nothing touches the network.
// Each rejection code has at least one case, and order-of-checks claims
// (signature before claims, header before network) are asserted, not assumed.

import { sign as nodeSign } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { authorize } from '@/rbac/authorize';
import type { DeployEnv } from '@/identity/types';
import { OIDC_ERROR_CODES, OidcError, OidcVerifier, createMemoryJtiDenylist, type OidcConfig, type OidcErrorCode } from './index';
import {
  AUDIENCE, BASE_CONFIG, ISSUER, JWKS_URI, NOW, b64u, baseClaims, codeOf, harness, hmacWithPublicKey, keys, makeToken, nonCanonical, parts, signBytes,
} from './testkit';
import type { TestKey } from './testkit';

const K = keys();
const ALL = [K.rsa, K.ec, K.ed, K.other];
const h = (over: Partial<OidcConfig> = {}) => harness(ALL, over);
const claims = (c: Record<string, unknown>) => ({ claims: c });
const header = (hd: Record<string, unknown>) => ({ header: hd });

describe('valid tokens', () => {
  it.each([
    ['RS256', K.rsa],
    ['ES256', K.ec],
    ['EdDSA', K.ed],
  ])('accepts a valid %s token and builds the principal', async (_alg, key) => {
    const { verify } = h();
    const p = await verify(makeToken(key));
    expect(p).toEqual({
      sub: 'user-123',
      role: 'finops_lead',
      teams: ['Platform Eng', 'CX Engineering'],
      envs: ['dev', 'test', 'prod'],
      tenant: 'acme',
      tokenId: 'jti-0001',
      expiresAt: NOW + 3600,
      authMethod: 'oidc',
    });
  });

  it('returns a frozen principal with exactly the contract fields', async () => {
    const p = await h().verify(makeToken(K.ed));
    expect(Object.keys(p).sort()).toEqual(['authMethod', 'envs', 'expiresAt', 'role', 'sub', 'teams', 'tenant', 'tokenId']);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.teams)).toBe(true);
    expect(Object.isFrozen(p.envs)).toBe(true);
  });

  it('produces a principal that authorize() accepts, scoped by its own envs and role', async () => {
    const p = await h().verify(makeToken(K.ed, claims({ envs: ['dev', 'test'] })));
    expect(authorize(p, 'view.read', { kind: 'view', id: '/overview' })).toEqual({ allow: true });
    expect(authorize(p, 'view.read', { kind: 'view', id: '/overview', env: 'test' })).toEqual({ allow: true });
    const denied = authorize(p, 'view.read', { kind: 'view', id: '/overview', env: 'prod' });
    expect(denied.allow).toBe(false);
  });

  it('accepts an audience array that contains the configured audience', async () => {
    await expect(h().verify(makeToken(K.ed, claims({ aud: ['other', AUDIENCE], azp: AUDIENCE })))).resolves.toMatchObject({ role: 'finops_lead' });
  });

  it('accepts nbf, typ at+jwt, an absent typ and x5t hints', async () => {
    const hh = h();
    await expect(hh.verify(makeToken(K.ed, claims({ nbf: NOW })))).resolves.toBeTruthy();
    await expect(hh.verify(makeToken(K.ed, header({ typ: 'at+jwt' })))).resolves.toBeTruthy();
    await expect(hh.verify(makeToken(K.ed, header({ typ: undefined })))).resolves.toBeTruthy();
    await expect(hh.verify(makeToken(K.ed, header({ x5t: 'abc', 'x5t#S256': 'def' })))).resolves.toBeTruthy();
  });

  it('tolerates standard OIDC claims but never copies them into the principal', async () => {
    const p = await h().verify(makeToken(K.ed, claims({ email: 'jo@example.test', name: 'Jo', azp: AUDIENCE, scope: 'openid', auth_time: NOW })));
    expect(JSON.stringify(p)).not.toContain('example.test');
    expect(p.sub).toBe('user-123');
  });

  it('tolerates extraIgnoredClaims and refuses the same claim without them', async () => {
    const token = makeToken(K.ed, claims({ 'x-custom': 'v' }));
    await expect(codeOf(h().verify(token))).resolves.toBe('invalid_claims');
    await expect(h({ extraIgnoredClaims: ['x-custom'] }).verify(token)).resolves.toBeTruthy();
  });

  it('reads namespaced claim names from the configuration', async () => {
    const names = { groups: 'https://ratio.example/groups', tenant: 'https://ratio.example/tenant', teams: 'https://ratio.example/teams', envs: 'https://ratio.example/envs' };
    const c = baseClaimsRenamed(names);
    await expect(h({ claims: names }).verify(makeToken(K.ed, { rawPayload: JSON.stringify(c) }))).resolves.toMatchObject({ tenant: 'acme', role: 'finops_lead' });
  });

  it('floors a fractional clock', async () => {
    await expect(h().verify(makeToken(K.ed), { now: NOW + 5.9 })).resolves.toBeTruthy();
  });

  it('keeps the full envs list from the claim, not just the deployment environment', async () => {
    const p = await h().verify(makeToken(K.ed, claims({ envs: ['prod', 'test'] })), { deployEnv: 'test' });
    expect(p.envs).toEqual(['prod', 'test']);
  });
});

function baseClaimsRenamed(names: Record<string, string>): Record<string, unknown> {
  return {
    iss: ISSUER, sub: 'user-123', aud: AUDIENCE, iat: NOW, exp: NOW + 3600, jti: 'jti-0001',
    [names.groups]: ['ratio-finops'], [names.tenant]: 'acme', [names.teams]: ['Platform Eng'], [names.envs]: ['test'],
  };
}

describe('bearer shape and size', () => {
  it.each([[undefined], [null], [42], [{}], [['a.b.c']], [true]])('rejects a non-string bearer (%#)', async (bearer) => {
    await expect(codeOf(h().verify(bearer))).resolves.toBe('malformed');
  });

  it('rejects an empty bearer', async () => {
    await expect(codeOf(h().verify(''))).resolves.toBe('malformed');
  });

  it('rejects a Bearer-prefixed value (the caller strips the scheme)', async () => {
    await expect(codeOf(h().verify(`Bearer ${makeToken(K.ed)}`))).resolves.toBe('malformed');
  });

  it.each([['a.b'], ['a.b.c.d'], ['a..c'], ['.b.c'], ['a.b.'], ['....']])('rejects the wrong segment layout %s', async (t) => {
    await expect(codeOf(h().verify(t))).resolves.toBe('malformed');
  });

  it.each([['+'], ['/'], ['='], [' '], ['é']])('rejects a non-base64url character %s in any segment', async (ch) => {
    const [a, b, c] = parts(makeToken(K.ed));
    for (const t of [`${a}${ch}.${b}.${c}`, `${a}.${b}${ch}.${c}`, `${a}.${b}.${c}${ch}`]) {
      await expect(codeOf(h().verify(t))).resolves.toBe('malformed');
    }
  });

  it('rejects a non-canonical spelling of an otherwise valid signature', async () => {
    const [a, b, c] = parts(makeToken(K.ec));
    const spoofed = nonCanonical(c);
    expect(spoofed).not.toBeNull();
    expect(Buffer.from(spoofed as string, 'base64url').equals(Buffer.from(c, 'base64url'))).toBe(true); // same bytes
    await expect(h().verify(`${a}.${b}.${c}`)).resolves.toBeTruthy();
    await expect(codeOf(h().verify(`${a}.${b}.${spoofed}`))).resolves.toBe('malformed');
  });

  it('rejects a non-canonical payload or header spelling', async () => {
    const t = makeToken(K.ed);
    const [a, b, c] = parts(t);
    const nb = nonCanonical(b);
    const na = nonCanonical(a);
    expect(nb ?? na).not.toBeNull();
    if (nb) await expect(codeOf(h().verify(`${a}.${nb}.${c}`))).resolves.toBe('malformed');
    if (na) await expect(codeOf(h().verify(`${na}.${b}.${c}`))).resolves.toBe('malformed');
  });

  it('rejects a header that is not UTF-8, carries a byte-order mark, or is not an object', async () => {
    const [, b, c] = parts(makeToken(K.ed));
    const bad = [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"alg":"EdDSA","kid":"ed-1"}')]), Buffer.from('[]'), Buffer.from('"x"'), Buffer.from('null'), Buffer.from('{')];
    for (const hd of bad) await expect(codeOf(h().verify(`${b64u(hd)}.${b}.${c}`))).resolves.toBe('malformed');
  });

  it('rejects a token one character over the limit and accepts one exactly at it', async () => {
    const t = makeToken(K.ed);
    await expect(h({ maxTokenLength: t.length }).verify(t)).resolves.toBeTruthy();
    await expect(codeOf(h({ maxTokenLength: Math.max(256, t.length - 1) }).verify(`${t}x`))).resolves.toBe('token_too_large');
  });

  it('rejects an oversized token by default (8192) before any other work', async () => {
    const hh = h();
    await expect(codeOf(hh.verify('a'.repeat(8193)))).resolves.toBe('token_too_large');
    await expect(codeOf(hh.verify('a'.repeat(8192)))).resolves.toBe('malformed'); // at the cap: judged on shape
    expect(hh.jwks.calls).toHaveLength(0);
  });

  it('rejects an oversized header segment', async () => {
    const [, b, c] = parts(makeToken(K.ed));
    // Valid members only; JSON whitespace pads the segment, so just the size cap can refuse it.
    const padded = (spaces: number) => b64u(`{"alg":"EdDSA","typ":"JWT","kid":"ed-1"${' '.repeat(spaces)}}`);
    let spaces = 1000;
    while (padded(spaces).length <= 2048) spaces += 1; // the first padding that puts the segment over the cap
    await expect(codeOf(h().verify(`${padded(spaces)}.${b}.${c}`))).resolves.toBe('malformed');
    await expect(codeOf(h().verify(`${padded(spaces - 3)}.${b}.${c}`))).resolves.toBe('bad_signature'); // just under the cap: judged on its signature
    // One that fits under the cap is judged on its signature instead (the header changed, so it fails there).
    await expect(codeOf(h().verify(`${padded(10)}.${b}.${c}`))).resolves.toBe('bad_signature');
  });

  it('refuses a signed payload that is not a JSON object', async () => {
    for (const raw of ['not json', '[]', '"str"', '42', 'null', '{"a":']) {
      await expect(codeOf(h().verify(makeToken(K.ed, { rawPayload: raw })))).resolves.toBe('invalid_claims');
    }
  });
});

describe('header rules', () => {
  it('rejects alg none (with and without a signature) before any key is fetched', async () => {
    const hh = h();
    const [a, b] = parts(makeToken(K.ed, header({ alg: 'none' })));
    await expect(codeOf(hh.verify(`${a}.${b}.AAAA`))).resolves.toBe('unsupported_alg');
    await expect(codeOf(hh.verify(`${a}.${b}.`))).resolves.toBe('malformed'); // no signature segment at all
    expect(hh.jwks.calls).toHaveLength(0);
  });

  it.each([['None'], ['NONE'], ['nOnE'], ['HS256'], ['HS384'], ['HS512'], ['rs256'], ['eddsa'], ['ES384'], ['ES512'], ['RS512'], ['PS256'], ['RSA-OAEP'], ['']])(
    'rejects alg %j',
    async (alg) => {
      const hh = h();
      await expect(codeOf(hh.verify(makeToken(K.ed, { header: { alg }, signature: Buffer.alloc(64, 1) })))).resolves.toBe('unsupported_alg');
      expect(hh.jwks.calls).toHaveLength(0);
    },
  );

  it.each([[undefined], [null], [256], [['EdDSA']], [{ a: 1 }]])('rejects a missing or non-string alg (%#)', async (alg) => {
    await expect(codeOf(h().verify(makeToken(K.ed, header({ alg }))))).resolves.toBe('malformed');
  });

  it('refuses HS256 algorithm confusion against an RSA key (HMAC keyed with the public key)', async () => {
    const hh = h();
    const t = makeToken(K.rsa, { header: { alg: 'HS256' }, signature: hmacWithPublicKey(K.rsa) });
    await expect(codeOf(hh.verify(t))).resolves.toBe('unsupported_alg');
    expect(hh.jwks.calls).toHaveLength(0);
  });

  it('honors a narrowed allowlist: an RS256 token is refused when only ES256 is allowed', async () => {
    const hh = h({ allowedAlgs: ['ES256'] });
    await expect(codeOf(hh.verify(makeToken(K.rsa)))).resolves.toBe('unsupported_alg');
    await expect(codeOf(hh.verify(makeToken(K.ed)))).resolves.toBe('unsupported_alg');
    await expect(hh.verify(makeToken(K.ec))).resolves.toBeTruthy();
  });

  it.each([
    ['ES256 header on an RSA kid', K.rsa, 'ES256'],
    ['EdDSA header on an RSA kid', K.rsa, 'EdDSA'],
    ['RS256 header on an EC kid', K.ec, 'RS256'],
    ['EdDSA header on an EC kid', K.ec, 'EdDSA'],
    ['RS256 header on an Ed25519 kid', K.ed, 'RS256'],
    ['ES256 header on an Ed25519 kid', K.ed, 'ES256'],
  ])('refuses key and algorithm confusion: %s', async (_name, key, alg) => {
    // The signature is genuine for the key; only the header claims a different algorithm.
    const t = makeToken(key, { header: { alg }, signature: (data) => signBytes(key, data) });
    await expect(codeOf(h().verify(t))).resolves.toBe('unsupported_alg');
  });

  it.each([['jku', 'https://evil.test/jwks.json'], ['x5u', 'https://evil.test/cert'], ['x5c', ['AAAA']], ['crit', ['exp']], ['crit', []], ['crit', ['b64']]])(
    'refuses the header member %s even on a genuinely signed token',
    async (member, value) => {
      const hh = h();
      await expect(codeOf(hh.verify(makeToken(K.ed, { header: { [member]: value } })))).resolves.toBe('forbidden_header');
      expect(hh.jwks.calls).toHaveLength(0);
    },
  );

  it('refuses an embedded jwk header and does not trust the embedded key', async () => {
    const attacker = K.other; // not in the provider's key set
    const hh = harness([K.rsa, K.ec, K.ed]);
    const injected = makeToken(attacker, { header: { jwk: attacker.jwk } });
    await expect(codeOf(hh.verify(injected))).resolves.toBe('forbidden_header');
    // The same self-signed token without the injection is merely an unknown key.
    await expect(codeOf(hh.verify(makeToken(attacker)))).resolves.toBe('unknown_kid');
    expect(hh.jwks.calls.every((c) => c.url === JWKS_URI)).toBe(true);
  });

  it.each([['zip', 'DEF'], ['cty', 'JWT'], ['b64', false], ['enc', 'A128GCM'], ['foo', 1], ['__proto__', 'x']])('refuses the unknown header member %s', async (member, value) => {
    const [, b, c] = parts(makeToken(K.ed));
    const raw = `{"alg":"EdDSA","kid":"ed-1",${JSON.stringify(member)}:${JSON.stringify(value)}}`;
    await expect(codeOf(h().verify(`${b64u(raw)}.${b}.${c}`))).resolves.toBe('malformed');
  });

  it.each([['JWS'], ['jwt'], ['at+JWT'], [''], [7], [null]])('refuses typ %j', async (typ) => {
    await expect(codeOf(h().verify(makeToken(K.ed, header({ typ }))))).resolves.toBe('malformed');
  });

  it.each([[undefined], [null], [''], ['has space'], ['a'.repeat(129)], [5], [['ed-1']]])('refuses a missing or bad kid (%#)', async (kid) => {
    await expect(codeOf(h().verify(makeToken(K.ed, header({ kid }))))).resolves.toBe('malformed');
  });
});

describe('key lookup and signature', () => {
  it('rejects an unknown kid', async () => {
    await expect(codeOf(h().verify(makeToken(K.ed, header({ kid: 'nobody' }))))).resolves.toBe('unknown_kid');
  });

  it.each([
    ['RS256', K.rsa],
    ['ES256', K.ec],
    ['EdDSA', K.ed],
  ])('rejects a payload tampered after signing (%s)', async (_alg, key) => {
    const t = makeToken(key);
    const [a, b, c] = parts(t);
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload.groups = ['ratio-cto'];
    await expect(codeOf(h().verify(`${a}.${b64u(payload)}.${c}`))).resolves.toBe('bad_signature');
  });

  it.each([
    ['RS256', K.rsa],
    ['ES256', K.ec],
    ['EdDSA', K.ed],
  ])('rejects a flipped signature bit (%s)', async (_alg, key) => {
    const [a, b, c] = parts(makeToken(key));
    const sig = Buffer.from(c, 'base64url');
    sig[sig.length - 1] ^= 1;
    await expect(codeOf(h().verify(`${a}.${b}.${sig.toString('base64url')}`))).resolves.toBe('bad_signature');
  });

  it('rejects a tampered header', async () => {
    const [, b, c] = parts(makeToken(K.ed));
    await expect(codeOf(h().verify(`${b64u({ alg: 'EdDSA', typ: 'at+jwt', kid: 'ed-1' })}.${b}.${c}`))).resolves.toBe('bad_signature');
  });

  it('rejects an attacker signing with their own key under a trusted kid', async () => {
    await expect(codeOf(h().verify(makeToken(K.ed, { signWith: K.other })))).resolves.toBe('bad_signature');
  });

  it.each([
    ['ES256 with 63 bytes', K.ec, 63],
    ['ES256 with 65 bytes', K.ec, 65],
    ['EdDSA with 63 bytes', K.ed, 63],
    ['EdDSA with 65 bytes', K.ed, 65],
    ['RS256 with 255 bytes', K.rsa, 255],
    ['RS256 with 257 bytes', K.rsa, 257],
    ['any alg with 1 byte', K.ed, 1],
  ])('rejects a wrong-length signature: %s', async (_name, key, len) => {
    const real = Buffer.from(parts(makeToken(key))[2], 'base64url');
    const sig = len <= real.length ? real.subarray(0, len) : Buffer.concat([real, Buffer.alloc(len - real.length, 7)]);
    await expect(codeOf(h().verify(makeToken(key, { signature: sig })))).resolves.toBe('bad_signature');
  });

  it('rejects an ES256 signature in DER form (only IEEE P1363 is accepted)', async () => {
    const der = (data: Buffer) => sigDer(K.ec, data);
    await expect(codeOf(h().verify(makeToken(K.ec, { signature: der })))).resolves.toBe('bad_signature');
  });

  it('verifies the signature before it parses the payload', async () => {
    // Same garbage payload: wrong key says bad_signature, right key says invalid_claims.
    await expect(codeOf(h().verify(makeToken(K.ed, { rawPayload: 'not json', signWith: K.other })))).resolves.toBe('bad_signature');
    await expect(codeOf(h().verify(makeToken(K.ed, { rawPayload: 'not json' })))).resolves.toBe('invalid_claims');
  });

  it('verifies the signature before any claim check (expired, wrong issuer and wrong audience still say bad_signature)', async () => {
    const t = makeToken(K.ed, { signWith: K.other, claims: { exp: NOW - 1, iss: 'https://evil.test/', aud: 'x' } });
    await expect(codeOf(h().verify(t))).resolves.toBe('bad_signature');
  });
});

describe('strict claims', () => {
  it.each(['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'groups', 'tenant', 'teams', 'envs'])('rejects a token missing %s', async (name) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ [name]: undefined }))))).resolves.toBe('invalid_claims');
  });

  it.each([
    ['an unknown claim', { surprise: 1 }],
    ['cnf (proof of possession)', { cnf: { jkt: 'x' } }],
    ['a roles claim that is not configured', { roles: ['cto'] }],
    ['an Azure overage marker', { _claim_names: { groups: 'src1' } }],
    ['a nested admin flag', { admin: true }],
    ['an ID-token nonce (login artifacts are not API bearers)', { nonce: 'n-0S6_WzA2Mj' }],
    ['an ID-token at_hash', { at_hash: 'abc' }],
    ['an ID-token c_hash', { c_hash: 'abc' }],
  ])('rejects %s', async (_name, extra) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims(extra))))).resolves.toBe('invalid_claims');
  });

  it('rejects an own __proto__ claim', async () => {
    const base = JSON.stringify(baseClaims());
    const raw = `${base.slice(0, -1)},"__proto__":{"role":"cto"}}`;
    await expect(codeOf(h().verify(makeToken(K.ed, { rawPayload: raw })))).resolves.toBe('invalid_claims');
  });

  it.each([
    ['iss number', { iss: 5 }],
    ['iss empty', { iss: '' }],
    ['sub number', { sub: 5 }],
    ['sub null', { sub: null }],
    ['aud number', { aud: 5 }],
    ['aud object', { aud: { a: 1 } }],
    ['aud empty array', { aud: [] }],
    ['aud array with a non-string', { aud: [AUDIENCE, 5] }],
    ['aud array of 17', { aud: Array.from({ length: 17 }, (_, i) => `a${i}`) }],
    ['aud empty string', { aud: '' }],
    ['exp string', { exp: String(NOW + 3600) }],
    ['exp float', { exp: NOW + 3600.5 }],
    ['exp negative', { exp: -5 }],
    ['exp zero', { exp: 0 }],
    ['exp unsafe integer', { exp: 2 ** 60 }],
    ['exp Infinity-like string', { exp: 'Infinity' }],
    ['iat zero', { iat: 0 }],
    ['iat string', { iat: 'x' }],
    ['exp equal to iat', { exp: NOW }],
    ['exp before iat', { exp: NOW - 10 }],
    ['nbf string', { nbf: 'x' }],
    ['nbf float', { nbf: NOW + 0.5 }],
    ['nbf at exp', { nbf: NOW + 3600 }],
    ['nbf after exp', { nbf: NOW + 4000 }],
    ['jti number', { jti: 5 }],
    ['jti empty', { jti: '' }],
    ['jti with a space', { jti: 'a b' }],
    ['jti of 129 characters', { jti: 'j'.repeat(129) }],
  ])('rejects %s', async (_name, bad) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims(bad))))).resolves.toBe('invalid_claims');
  });

  it('accepts a jti of exactly 128 characters', async () => {
    const jti = 'j'.repeat(128);
    await expect(h().verify(makeToken(K.ed, claims({ jti })))).resolves.toMatchObject({ tokenId: jti });
  });
});

describe('subject rules', () => {
  it.each([['jo@example.test'], ['@'], ['a@b'], ['user+tag@x.test']])('rejects an email-shaped sub %s by default', async (sub) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ sub }))))).resolves.toBe('invalid_subject');
  });

  it.each([[''], ['a b'], ['a/b'], ['a'.repeat(129)], ['naïve'], ['a\nb']])('rejects the unstable or unbounded sub %j', async (sub) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ sub }))))).resolves.toBe('invalid_subject');
  });

  it.each([['auth0|abc123'], ['00u1abcdXYZ'], ['2a6c9a53-1e1b-4c1d-9f3e-0123456789ab'], ['google-oauth2:1234'], ['a'.repeat(128)]])('accepts the stable provider subject %s', async (sub) => {
    await expect(h().verify(makeToken(K.ed, claims({ sub })))).resolves.toMatchObject({ sub });
  });

  it('accepts an email-shaped sub only when the config explicitly stops rejecting it, and still bounds the character class', async () => {
    const lenient = h({ rejectEmailSub: false });
    await expect(lenient.verify(makeToken(K.ed, claims({ sub: 'jo@example.test' })))).resolves.toMatchObject({ sub: 'jo@example.test' });
    await expect(codeOf(lenient.verify(makeToken(K.ed, claims({ sub: 'a b@c' }))))).resolves.toBe('invalid_subject');
  });
});

describe('issuer and audience', () => {
  it.each([
    ['another issuer', 'https://evil.test/'],
    ['no trailing slash', 'https://idp.example.test'],
    ['different case', 'HTTPS://IDP.EXAMPLE.TEST/'],
    ['trailing space', `${ISSUER} `],
    ['prefix only', 'https://idp.example.test/x'],
  ])('rejects %s', async (_name, iss) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ iss }))))).resolves.toBe('wrong_issuer');
  });

  it.each([
    ['another audience', 'api://other'],
    ['different case', 'API://RATIO'],
    ['prefix of the audience', 'api://rati'],
    ['audience as substring of a longer value', `${AUDIENCE}/x`],
    ['an array without it', ['api://a', 'api://b']],
    ['an array whose members merely contain it', [`${AUDIENCE}/x`, `x${AUDIENCE}`]],
    ['an array holding a different case', ['API://RATIO']],
  ])('rejects %s', async (_name, aud) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ aud }))))).resolves.toBe('wrong_audience');
  });

  it('accepts an array with the audience in any position', async () => {
    for (const aud of [[AUDIENCE], [AUDIENCE, 'x'], ['x', AUDIENCE], ['x', 'y', AUDIENCE]]) {
      await expect(h().verify(makeToken(K.ed, claims({ aud, azp: AUDIENCE })))).resolves.toBeTruthy();
    }
  });

  it('authorized party: single aud with no azp passes, with matching azp passes, with wrong azp fails', async () => {
    await expect(h().verify(makeToken(K.ed))).resolves.toBeTruthy();
    await expect(h().verify(makeToken(K.ed, claims({ azp: AUDIENCE })))).resolves.toBeTruthy();
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ azp: 'other-client' }))))).resolves.toBe('wrong_audience');
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ aud: [AUDIENCE], azp: 'other-client' }))))).resolves.toBe('wrong_audience');
  });

  it('authorized party: a multi-entry aud requires azp, and it must match', async () => {
    const aud = [AUDIENCE, 'other-client'];
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ aud }))))).resolves.toBe('wrong_audience');
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ aud, azp: 'other-client' }))))).resolves.toBe('wrong_audience');
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ aud, azp: AUDIENCE.toUpperCase() }))))).resolves.toBe('wrong_audience');
    await expect(h().verify(makeToken(K.ed, claims({ aud, azp: AUDIENCE })))).resolves.toBeTruthy();
  });

  it.each([[5], [''], [['x']], [null]])('authorized party: a malformed azp (%j) is invalid_claims', async (azp) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ azp }))))).resolves.toBe('invalid_claims');
  });

  it('authorized party: a configured value replaces the audience default', async () => {
    const hh = h({ authorizedParty: 'client-123' });
    const aud = [AUDIENCE, 'x'];
    await expect(hh.verify(makeToken(K.ed, claims({ aud, azp: 'client-123' })))).resolves.toBeTruthy();
    await expect(codeOf(hh.verify(makeToken(K.ed, claims({ aud, azp: AUDIENCE }))))).resolves.toBe('wrong_audience');
  });
});

describe('time checks and skew boundaries', () => {
  // Base token: iat = NOW, exp = NOW + 3600; harness skew = 60.
  const exp = NOW + 3600;

  it('accepts one second before exp plus skew and rejects at it', async () => {
    const t = makeToken(K.ed);
    await expect(h().verify(t, { now: exp + 59 })).resolves.toBeTruthy();
    await expect(codeOf(h().verify(t, { now: exp + 60 }))).resolves.toBe('expired');
    await expect(codeOf(h().verify(t, { now: exp + 61 }))).resolves.toBe('expired');
  });

  it('with zero skew expires exactly at exp', async () => {
    const t = makeToken(K.ed);
    await expect(h({ clockSkewSeconds: 0 }).verify(t, { now: exp - 1 })).resolves.toBeTruthy();
    await expect(codeOf(h({ clockSkewSeconds: 0 }).verify(t, { now: exp }))).resolves.toBe('expired');
  });

  it('applies the maximum skew of 120 seconds', async () => {
    const t = makeToken(K.ed);
    await expect(h({ clockSkewSeconds: 120 }).verify(t, { now: exp + 119 })).resolves.toBeTruthy();
    await expect(codeOf(h({ clockSkewSeconds: 120 }).verify(t, { now: exp + 120 }))).resolves.toBe('expired');
  });

  it('honors nbf with skew on both sides of the boundary', async () => {
    const nbf = NOW + 1000;
    const t = makeToken(K.ed, claims({ nbf }));
    await expect(h().verify(t, { now: nbf - 60 })).resolves.toBeTruthy();
    await expect(codeOf(h().verify(t, { now: nbf - 61 }))).resolves.toBe('not_yet_valid');
    await expect(h({ clockSkewSeconds: 0 }).verify(t, { now: nbf })).resolves.toBeTruthy();
    await expect(codeOf(h({ clockSkewSeconds: 0 }).verify(t, { now: nbf - 1 }))).resolves.toBe('not_yet_valid');
  });

  it('refuses a token issued in the future beyond skew', async () => {
    const iat = NOW + 1000;
    const t = makeToken(K.ed, claims({ iat, exp: iat + 3600 }));
    await expect(h().verify(t, { now: iat - 60 })).resolves.toBeTruthy();
    await expect(codeOf(h().verify(t, { now: iat - 61 }))).resolves.toBe('not_yet_valid');
  });

  it('caps the lifetime: exactly the maximum passes, one second more is refused', async () => {
    await expect(h().verify(makeToken(K.ed, claims({ exp: NOW + 3600 })))).resolves.toBeTruthy();
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ exp: NOW + 3601 }))))).resolves.toBe('lifetime_exceeded');
    await expect(codeOf(h({ maxTokenLifetimeSeconds: 60 }).verify(makeToken(K.ed, claims({ exp: NOW + 61 }))))).resolves.toBe('lifetime_exceeded');
    await expect(h({ maxTokenLifetimeSeconds: 60 }).verify(makeToken(K.ed, claims({ exp: NOW + 60 })))).resolves.toBeTruthy();
  });

  it('checks expiry before the lifetime cap and the cap before role mapping', async () => {
    const long = makeToken(K.ed, claims({ exp: NOW + 7200, groups: ['unmapped'] }));
    await expect(codeOf(h().verify(long, { now: NOW + 7200 + 60 }))).resolves.toBe('expired');
    await expect(codeOf(h().verify(long))).resolves.toBe('lifetime_exceeded');
  });

  it.each([[Number.NaN], [Infinity], ['now'], [null], [undefined]])('rejects an invalid clock value (%#)', async (now) => {
    await expect(codeOf(h().verify(makeToken(K.ed), { now: now as number }))).resolves.toBe('invalid_input');
  });
});

describe('role mapping', () => {
  it.each([
    ['ratio-cto', 'cto'],
    ['ratio-finops', 'finops_lead'],
    ['ratio-finance', 'finance'],
    ['ratio-procurement', 'procurement'],
    ['ratio-audit', 'auditor'],
  ])('maps group %s to role %s', async (group, role) => {
    await expect(h().verify(makeToken(K.ed, claims({ groups: [group] })))).resolves.toMatchObject({ role });
  });

  it('maps an engineering lead only with a named team list', async () => {
    await expect(h().verify(makeToken(K.ed, claims({ groups: ['ratio-eng'], teams: ['Platform Eng'] })))).resolves.toMatchObject({ role: 'eng_lead', teams: ['Platform Eng'] });
  });

  it.each([[[]], [['unmapped']], [['Ratio-CTO']], [[' ratio-cto']], [['ratio-cto ']], [['RATIO-FINOPS']], [['__proto__', 'constructor', 'toString', 'hasOwnProperty']]])(
    'denies when no group maps to a role (%#)',
    async (groups) => {
      await expect(codeOf(h().verify(makeToken(K.ed, claims({ groups }))))).resolves.toBe('no_role');
    },
  );

  it.each([
    ['a string', 'ratio-cto'],
    ['an object', { 'ratio-cto': true }],
    ['null', null],
    ['an array with a number', ['ratio-cto', 5]],
    ['an array with an empty string', ['ratio-cto', '']],
    ['an array with a nested array', [['ratio-cto']]],
  ])('refuses a groups claim that is %s', async (_name, groups) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ groups }))))).resolves.toBe('invalid_claims');
  });

  it('picks the narrowest role by the default precedence whatever the group order', async () => {
    const a = await h().verify(makeToken(K.ed, claims({ groups: ['ratio-cto', 'ratio-audit'] })));
    const b = await h().verify(makeToken(K.ed, claims({ groups: ['ratio-audit', 'ratio-cto'] })));
    expect(a.role).toBe('auditor');
    expect(b.role).toBe('auditor');
  });

  it('resolves every pair of roles identically in both orders', async () => {
    const entries = Object.entries(BASE_CONFIG.groupToRole);
    const rank = ['auditor', 'procurement', 'finance', 'eng_lead', 'finops_lead', 'cto'];
    for (const [g1, r1] of entries) {
      for (const [g2, r2] of entries) {
        const expected = rank.indexOf(r1) <= rank.indexOf(r2) ? r1 : r2;
        for (const groups of [[g1, g2], [g2, g1]]) {
          const p = await h().verify(makeToken(K.ed, claims({ groups })));
          expect(p.role).toBe(expected);
        }
      }
    }
  });

  it('uses the configured precedence instead of the default', async () => {
    const reversed = h({ rolePrecedence: ['cto', 'finops_lead', 'eng_lead', 'finance', 'procurement', 'auditor'] });
    await expect(reversed.verify(makeToken(K.ed, claims({ groups: ['ratio-audit', 'ratio-cto'] })))).resolves.toMatchObject({ role: 'cto' });
    await expect(reversed.verify(makeToken(K.ed, claims({ groups: ['ratio-cto', 'ratio-audit'] })))).resolves.toMatchObject({ role: 'cto' });
  });

  it('ignores unmapped groups next to a mapped one and tolerates duplicate groups', async () => {
    await expect(h().verify(makeToken(K.ed, claims({ groups: ['x', 'ratio-finance', 'ratio-finance', 'y'] })))).resolves.toMatchObject({ role: 'finance' });
  });

  it('accepts the maximum of 256 groups and refuses 257', async () => {
    const many = Array.from({ length: 255 }, (_, i) => `g${i}`);
    await expect(h().verify(makeToken(K.ed, claims({ groups: [...many, 'ratio-audit'] })))).resolves.toMatchObject({ role: 'auditor' });
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ groups: [...many, 'x', 'ratio-audit'] }))))).resolves.toBe('invalid_claims');
  });

  it('never yields legacy_service, whatever the token says', async () => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ groups: ['legacy_service'] }))))).resolves.toBe('no_role');
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ groups: ['ratio-cto'], role: 'legacy_service' }))))).resolves.toBe('invalid_claims');
  });
});

describe('tenant, teams and envs', () => {
  it.each([['other'], ['ACME'], ['acme2'], ['acme.']])('refuses the cross-tenant claim %j', async (tenant) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ tenant }))))).resolves.toBe('wrong_tenant');
  });

  it.each([[['acme', 'other']], [5], [null], [{ id: 'acme' }], [''], ['acme '], ['ac me']])('refuses a tenant claim of the wrong shape (%#)', async (tenant) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ tenant }))))).resolves.toBe('invalid_claims');
  });

  it('serves any of several allowed tenants and no other', async () => {
    const multi = h({ allowedTenants: ['acme', 'globex'] });
    await expect(multi.verify(makeToken(K.ed, claims({ tenant: 'globex' })))).resolves.toMatchObject({ tenant: 'globex' });
    await expect(codeOf(multi.verify(makeToken(K.ed, claims({ tenant: 'initech' }))))).resolves.toBe('wrong_tenant');
  });

  it.each([
    ['a wildcard inside a list', ['*']],
    ['a wildcard with other teams', ['Platform Eng', '*']],
    ['a wildcard substring', ['Plat*']],
    ['a leading wildcard', ['*Eng']],
    ['an empty list', []],
    ['duplicates', ['A', 'A']],
    ['padded names', [' A']],
    ['trailing-padded names', ['A ']],
    ['an empty name', ['']],
    ['a non-string member', ['A', 5]],
    ['a nested list', [['A']]],
    ['a control character', ['A\u0000B']],
    ['a newline', ['A\nB']],
    ['a bare string', 'Platform Eng'],
    ['null', null],
    ['an object', { A: true }],
    ['a name of 129 characters', ['t'.repeat(129)]],
  ])('refuses teams with %s', async (_name, teams) => {
    await expect(codeOf(h({ allowOrgWide: true }).verify(makeToken(K.ed, claims({ teams }))))).resolves.toBe('invalid_claims');
  });

  it('refuses the whole-value star unless the config allows org-wide, and then returns it as the whole value', async () => {
    const t = makeToken(K.ed, claims({ teams: '*' }));
    await expect(codeOf(h().verify(t))).resolves.toBe('invalid_claims');
    await expect(codeOf(h({ allowOrgWide: false }).verify(t))).resolves.toBe('invalid_claims');
    await expect(h({ allowOrgWide: true }).verify(t)).resolves.toMatchObject({ teams: '*' });
  });

  it('never lets an engineering lead be org-wide, even when org-wide is allowed', async () => {
    const t = makeToken(K.ed, claims({ groups: ['ratio-eng'], teams: '*' }));
    await expect(codeOf(h({ allowOrgWide: true }).verify(t))).resolves.toBe('invalid_claims');
  });

  it('accepts 64 teams and refuses 65, and a name of exactly 128 characters', async () => {
    const teams = Array.from({ length: 64 }, (_, i) => `team-${i}`);
    await expect(h().verify(makeToken(K.ed, claims({ teams })))).resolves.toMatchObject({ teams });
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ teams: [...teams, 'team-64'] }))))).resolves.toBe('invalid_claims');
    await expect(h().verify(makeToken(K.ed, claims({ teams: ['t'.repeat(128)] })))).resolves.toBeTruthy();
  });

  it('keeps team names exactly as given (no case folding, spaces inside kept)', async () => {
    await expect(h().verify(makeToken(K.ed, claims({ teams: ['Platform Eng', 'platform eng'] })))).resolves.toMatchObject({ teams: ['Platform Eng', 'platform eng'] });
  });

  it.each([
    ['an unknown environment', ['staging']],
    ['production spelled out', ['production']],
    ['a wrong-case value', ['PROD']],
    ['an empty list', []],
    ['duplicates', ['dev', 'dev']],
    ['four entries', ['dev', 'test', 'prod', 'dev']],
    ['a non-string member', ['dev', 1]],
    ['a bare string', 'dev'],
    ['null', null],
  ])('refuses envs with %s', async (_name, envs) => {
    await expect(codeOf(h().verify(makeToken(K.ed, claims({ envs }))))).resolves.toBe('invalid_claims');
  });

  it('binds the token to the deployment environment through the envs claim', async () => {
    const t = makeToken(K.ed, claims({ envs: ['dev'] }));
    await expect(h().verify(t, { deployEnv: 'dev' })).resolves.toBeTruthy();
    await expect(codeOf(h().verify(t, { deployEnv: 'test' }))).resolves.toBe('wrong_environment');
    await expect(codeOf(h().verify(t, { deployEnv: 'prod' }))).resolves.toBe('wrong_environment');
  });

  it.each([['production'], ['staging'], [''], [undefined], [null], ['DEV']])('rejects a deployEnv of %j as invalid input', async (deployEnv) => {
    await expect(codeOf(h().verify(makeToken(K.ed), { deployEnv: deployEnv as DeployEnv }))).resolves.toBe('invalid_input');
  });

  it('rejects a missing or non-object context', async () => {
    const { verifier } = h();
    const t = makeToken(K.ed);
    await expect(codeOf(verifier.verify(t, null as never))).resolves.toBe('invalid_input');
    await expect(codeOf(verifier.verify(t, undefined as never))).resolves.toBe('invalid_input');
    await expect(codeOf(verifier.verify(t, 5 as never))).resolves.toBe('invalid_input');
  });
});

describe('revocation and replay hooks', () => {
  it('refuses a revoked token id', async () => {
    const hh = h();
    hh.revokedIds.add('jti-0001');
    await expect(codeOf(hh.verify(makeToken(K.ed)))).resolves.toBe('revoked');
    await expect(hh.verify(makeToken(K.ed, claims({ jti: 'jti-0002' })))).resolves.toBeTruthy();
  });

  it('asks the hook once per verified token, with the jti only', async () => {
    const hh = h();
    await hh.verify(makeToken(K.ed));
    expect(hh.revocationCalls).toEqual(['jti-0001']);
  });

  it('does not consult the hook for a token that fails any earlier check', async () => {
    const hh = h();
    await codeOf(hh.verify(makeToken(K.ed, { signWith: K.other })));
    await codeOf(hh.verify(makeToken(K.ed, claims({ exp: NOW - 1000 }))));
    await codeOf(hh.verify(makeToken(K.ed, claims({ groups: [] }))));
    await codeOf(hh.verify(makeToken(K.ed, claims({ tenant: 'other' }))));
    expect(hh.revocationCalls).toEqual([]);
  });

  it('fails closed when the hook throws, rejects, or answers with anything but a boolean', async () => {
    const make = (isRevoked: (jti: string) => Promise<boolean>) =>
      new OidcVerifier(BASE_CONFIG, { fetchJwks: harness(ALL).jwks.fetch, isRevoked, clock: () => NOW, createSignal: () => new AbortController().signal });
    const ctx = { now: NOW + 5, deployEnv: 'test' as const };
    const t = makeToken(K.ed);
    const answers: unknown[] = ['false', 'true', 1, 0, null, undefined, {}, []];
    for (const answer of answers) {
      await expect(codeOf(make(async () => answer as boolean).verify(t, ctx))).resolves.toBe('revocation_unavailable');
    }
    await expect(codeOf(make(async () => { throw new Error('store down'); }).verify(t, ctx))).resolves.toBe('revocation_unavailable');
    await expect(codeOf(make(() => { throw new Error('sync boom'); }).verify(t, ctx))).resolves.toBe('revocation_unavailable');
  });

  it('supports single-use (replay) protection through the same hook', async () => {
    const seen = new Set<string>();
    const v = new OidcVerifier(BASE_CONFIG, {
      fetchJwks: harness(ALL).jwks.fetch,
      isRevoked: async (jti) => (seen.has(jti) ? true : (seen.add(jti), false)),
      clock: () => NOW,
      createSignal: () => new AbortController().signal,
    });
    const ctx = { now: NOW + 5, deployEnv: 'test' as const };
    const t = makeToken(K.ed);
    await expect(v.verify(t, ctx)).resolves.toBeTruthy();
    await expect(codeOf(v.verify(t, ctx))).resolves.toBe('revoked');
  });

  it('works with the bundled in-memory denylist', async () => {
    const clock = { t: NOW };
    const deny = createMemoryJtiDenylist({ maxEntries: 10, clock: () => clock.t });
    const v = new OidcVerifier(BASE_CONFIG, { fetchJwks: harness(ALL).jwks.fetch, isRevoked: (j) => deny.isRevoked(j), clock: () => clock.t, createSignal: () => new AbortController().signal });
    const t = makeToken(K.ed);
    const ctx = () => ({ now: clock.t + 5, deployEnv: 'test' as const });
    await expect(v.verify(t, ctx())).resolves.toBeTruthy();
    deny.revoke('jti-0001', NOW + 3600 + 60);
    await expect(codeOf(v.verify(t, ctx()))).resolves.toBe('revoked');
    await expect(v.verify(makeToken(K.ed, claims({ jti: 'other' })), ctx())).resolves.toBeTruthy();
  });
});

describe('failure containment and fixed messages', () => {
  const MARK = 'SECRET-MARKER-9f3a';

  it('never puts token text, claim values, key ids or URLs in an error', async () => {
    const hh = h();
    const bad: string[] = [
      makeToken(K.ed, { header: { kid: `kid-${MARK}` } }),
      makeToken(K.ed, { signWith: K.other, claims: { sub: `sub-${MARK}` } }),
      makeToken(K.ed, claims({ iss: `https://${MARK}.test/` })),
      makeToken(K.ed, claims({ aud: `aud-${MARK}` })),
      makeToken(K.ed, claims({ sub: `${MARK}@example.test` })),
      makeToken(K.ed, claims({ groups: [`group-${MARK}`] })),
      makeToken(K.ed, claims({ tenant: `tenant-${MARK}` })),
      makeToken(K.ed, claims({ teams: [`team-${MARK}*`] })),
      makeToken(K.ed, claims({ [`claim-${MARK}`]: 1 })),
      makeToken(K.ed, { header: { alg: `alg-${MARK}` } }),
      makeToken(K.ed, { header: { jku: `https://${MARK}.test/` } }),
      makeToken(K.ed, claims({ jti: `jti ${MARK}` })),
      `${MARK}.${MARK}.${MARK}`,
      MARK.repeat(2000),
    ];
    for (const token of bad) {
      let err: unknown;
      try {
        await hh.verify(token);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OidcError);
      const text = [(err as Error).message, String((err as Error).stack), JSON.stringify(err), inspect(err, { depth: 6 })].join('\n');
      expect(text).not.toContain(MARK);
      for (const seg of token.split('.')) if (seg.length > 8) expect(text).not.toContain(seg);
    }
  });

  it('gives every code one distinct fixed message', () => {
    const messages = OIDC_ERROR_CODES.map((c) => new OidcError(c).message);
    expect(new Set(messages).size).toBe(OIDC_ERROR_CODES.length);
    for (const c of OIDC_ERROR_CODES) expect(new OidcError(c).code).toBe(c);
  });

  it('turns an unexpected exception into the internal code, never a raw error', async () => {
    const v = new OidcVerifier(BASE_CONFIG, {
      fetchJwks: harness(ALL).jwks.fetch,
      isRevoked: async () => false,
      clock: () => {
        throw new Error(`clock exploded ${MARK}`);
      },
    });
    let err: unknown;
    try {
      await v.verify(makeToken(K.ed), { now: NOW + 5, deployEnv: 'test' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OidcError);
    expect((err as OidcError).code).toBe('internal');
    expect((err as Error).message).not.toContain(MARK);
  });

  it('rejects arbitrary garbage with an OidcError and never anything else (seeded fuzz)', async () => {
    const hh = h();
    let state = 12345;
    const rnd = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    const alphabet = 'abcXYZ019_-.=+/ {}[]":,\\\u0000é';
    const valid = makeToken(K.ed);
    for (let i = 0; i < 300; i += 1) {
      let s: string;
      if (i % 3 === 0) {
        s = Array.from({ length: rnd(120) }, () => alphabet[rnd(alphabet.length)]).join('');
      } else if (i % 3 === 1) {
        const chars = valid.split('');
        for (let j = 0; j < 1 + rnd(4); j += 1) chars[rnd(chars.length)] = alphabet[rnd(alphabet.length)];
        s = chars.join('');
      } else {
        s = valid.slice(0, rnd(valid.length));
      }
      if (s === valid) s += 'x'; // an identity mutation would legitimately verify
      const code = await codeOf(hh.verify(s));
      expect(code).not.toBe('no-throw');
      expect(code).not.toBe('not-an-oidc-error');
    }
  });

  it('throws invalid_config for a bad configuration or missing dependencies, with fixed text', () => {
    const deps = { fetchJwks: harness(ALL).jwks.fetch, isRevoked: async () => false };
    const attempt = (cfg: unknown, d: unknown = deps): OidcErrorCode | 'no-throw' | 'other' => {
      try {
        new OidcVerifier(cfg as OidcConfig, d as never);
      } catch (e) {
        return e instanceof OidcError ? e.code : 'other';
      }
      return 'no-throw';
    };
    expect(attempt({ ...BASE_CONFIG, issuer: 'http://idp.example.test/' })).toBe('invalid_config');
    expect(attempt(BASE_CONFIG, { fetchJwks: deps.fetchJwks })).toBe('invalid_config'); // isRevoked is required
    expect(attempt(BASE_CONFIG, { isRevoked: deps.isRevoked })).toBe('invalid_config');
    expect(attempt(BASE_CONFIG, null)).toBe('invalid_config');
    expect(attempt(BASE_CONFIG)).toBe('no-throw');
  });
});

function sigDer(key: TestKey, data: Buffer): Buffer {
  return nodeSign('sha256', data, { key: key.privateKey, dsaEncoding: 'der' });
}
