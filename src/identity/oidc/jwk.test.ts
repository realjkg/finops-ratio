// Checklist 1.1 and 1.5: JWK import rules and signature verification. A JWK is
// network input, so every way it can fail to be a safe verification key has a
// negative case, with boundaries on the RSA modulus and exponent.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_RSA_BITS, MIN_RSA_BITS, importJwk, verifySignature } from './jwk';
import type { OidcAlg } from './shared';
import { b64u, ecKey, edKey, keys, rsaKey, signBytes, type TestKey } from './testkit';

const K = keys();
const ALL = new Set<OidcAlg>(['RS256', 'ES256', 'EdDSA']);
const ok = (jwk: unknown, allowed: ReadonlySet<OidcAlg> = ALL) => importJwk(jwk, allowed);

/** A syntactically valid RSA JWK around an arbitrary modulus (only the size and parity rules matter here). */
function fakeRsa(modulus: Buffer, e = 65_537, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const eb = Buffer.alloc(4);
  eb.writeUInt32BE(e);
  let i = 0;
  while (i < 3 && eb[i] === 0) i += 1;
  return { kty: 'RSA', kid: 'fake', n: b64u(modulus), e: b64u(eb.subarray(i)), ...extra };
}
/** An odd modulus of exactly `bits` bits (top bit set), random below that. */
function modulusOfBits(bits: number): Buffer {
  const bytes = Math.ceil(bits / 8);
  const m = randomBytes(bytes);
  const topBits = bits - (bytes - 1) * 8; // 1..8 bits live in the first byte
  m[0] = (m[0] & (0xff >> (8 - topBits))) | (1 << (topBits - 1));
  m[bytes - 1] |= 1;
  return m;
}

describe('importJwk: accepted keys', () => {
  it('imports an RSA-2048 key as RS256 with a 256-byte signature', () => {
    const vk = ok(K.rsa.jwk);
    expect(vk).toMatchObject({ kid: 'rsa-1', alg: 'RS256', signatureBytes: 256 });
  });
  it('imports a P-256 key as ES256 with a 64-byte signature', () => {
    expect(ok(K.ec.jwk)).toMatchObject({ kid: 'ec-1', alg: 'ES256', signatureBytes: 64 });
  });
  it('imports an Ed25519 key as EdDSA with a 64-byte signature', () => {
    expect(ok(K.ed.jwk)).toMatchObject({ kid: 'ed-1', alg: 'EdDSA', signatureBytes: 64 });
  });
  it('does not require use, key_ops or alg to be present', () => {
    const bare: Record<string, unknown> = { ...K.ed.jwk };
    delete bare.use;
    delete bare.alg;
    expect(ok(bare)).not.toBeNull();
  });
  it('accepts use sig and key_ops that include verify', () => {
    expect(ok({ ...K.ed.jwk, use: 'sig', key_ops: ['verify'] })).not.toBeNull();
    expect(ok({ ...K.ed.jwk, key_ops: ['sign', 'verify'] })).not.toBeNull();
  });
  it('returns a frozen key whose algorithm comes from the key, not from any caller', () => {
    const vk = ok(K.ec.jwk);
    expect(Object.isFrozen(vk)).toBe(true);
    expect(vk?.alg).toBe('ES256');
  });
});

describe('importJwk: use, key_ops and alg', () => {
  it.each([['enc'], ['SIG'], [''], [null], [5]])('rejects use %j', (use) => {
    expect(ok({ ...K.ed.jwk, use })).toBeNull();
  });
  it.each([
    [[]],
    [['sign']],
    [['encrypt', 'decrypt']],
    ['verify'],
    [[5, 'verify']],
    [{ 0: 'verify' }],
    [null],
    [Array.from({ length: 17 }, () => 'verify')],
  ])('rejects key_ops that forbid or do not list verification (%#)', (key_ops) => {
    expect(ok({ ...K.ed.jwk, key_ops })).toBeNull();
  });
  it('rejects a declared alg that differs from the one the key implies', () => {
    expect(ok({ ...K.rsa.jwk, alg: 'RS384' })).toBeNull();
    expect(ok({ ...K.rsa.jwk, alg: 'PS256' })).toBeNull();
    expect(ok({ ...K.rsa.jwk, alg: 'HS256' })).toBeNull();
    expect(ok({ ...K.ec.jwk, alg: 'RS256' })).toBeNull();
    expect(ok({ ...K.ec.jwk, alg: 'ES384' })).toBeNull();
    expect(ok({ ...K.ed.jwk, alg: 'ES256' })).toBeNull();
    expect(ok({ ...K.ed.jwk, alg: 'none' })).toBeNull();
  });
  it('rejects a key whose algorithm is not on the configured allowlist', () => {
    expect(ok(K.rsa.jwk, new Set<OidcAlg>(['ES256']))).toBeNull();
    expect(ok(K.ec.jwk, new Set<OidcAlg>(['RS256', 'EdDSA']))).toBeNull();
    expect(ok(K.ed.jwk, new Set<OidcAlg>(['ES256']))).toBeNull();
    expect(ok(K.ed.jwk, new Set<OidcAlg>())).toBeNull();
  });
});

describe('importJwk: key id and shape', () => {
  it.each([[undefined], [null], [''], ['has space'], ['a'.repeat(129)], [5], ['tab\tkid']])('rejects kid %j', (kid) => {
    expect(ok({ ...K.ed.jwk, kid })).toBeNull();
  });
  it('accepts a kid of exactly 128 printable characters', () => {
    expect(ok({ ...K.ed.jwk, kid: 'k'.repeat(128) })).not.toBeNull();
  });
  it.each([[null], [undefined], ['str'], [5], [[]], [[K.ed.jwk]]])('rejects a non-object JWK (%#)', (v) => {
    expect(ok(v)).toBeNull();
  });
  it.each([['oct'], ['EC2'], [''], [undefined], [5]])('rejects kty %j (symmetric and unknown key types never import)', (kty) => {
    expect(ok({ kty, kid: 'x', k: 'c2VjcmV0' })).toBeNull();
    expect(ok({ ...K.ed.jwk, kty })).toBeNull();
  });
  it('rejects any JWK that carries private or symmetric members', () => {
    const priv = (k: TestKey) => ({ ...(k.privateKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: k.kid, use: 'sig' });
    expect(ok(priv(K.rsa))).toBeNull();
    expect(ok(priv(K.ec))).toBeNull();
    expect(ok(priv(K.ed))).toBeNull();
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) expect(ok({ ...K.ed.jwk, [member]: 'AAAA' })).toBeNull();
  });
});

describe('importJwk: RSA modulus and exponent', () => {
  it('has the documented bounds', () => {
    expect(MIN_RSA_BITS).toBe(2048);
    expect(MAX_RSA_BITS).toBe(8192);
  });
  it('rejects a real 1024-bit key', () => {
    expect(ok(rsaKey('weak', 1024).jwk)).toBeNull();
  });
  it('rejects a real 2047-bit key and accepts a real 2048-bit key', () => {
    expect(ok(rsaKey('edge-low', 2047).jwk)).toBeNull();
    expect(ok(rsaKey('edge-ok', 2048).jwk)).not.toBeNull();
  });
  it('enforces the size bounds exactly on arbitrary moduli: 2047 no, 2048 yes, 8192 yes, 8193 no', () => {
    expect(ok(fakeRsa(modulusOfBits(2047)))).toBeNull();
    expect(ok(fakeRsa(modulusOfBits(2048)))).not.toBeNull();
    expect(ok(fakeRsa(modulusOfBits(8192)))).not.toBeNull();
    expect(ok(fakeRsa(modulusOfBits(8193)))).toBeNull();
    expect(ok(fakeRsa(modulusOfBits(512)))).toBeNull();
    expect(ok(fakeRsa(modulusOfBits(16_384)))).toBeNull();
  });
  it('measures the modulus after stripping leading zero bytes', () => {
    const small = modulusOfBits(1024);
    expect(ok(fakeRsa(Buffer.concat([Buffer.alloc(200), small])))).toBeNull(); // padded to look big, still 1024 bits
  });
  it('rejects an even modulus', () => {
    const m = modulusOfBits(2048);
    m[m.length - 1] &= 0xfe;
    expect(ok(fakeRsa(m))).toBeNull();
  });
  it.each([[3], [5], [17], [65_535], [65_536], [65_538]])('rejects the exponent %i (small, even or below 65537)', (e) => {
    expect(ok(fakeRsa(modulusOfBits(2048), e))).toBeNull();
  });
  it.each([[65_537], [65_539], [0x01000001]])('accepts the exponent %i', (e) => {
    expect(ok(fakeRsa(modulusOfBits(2048), e))).not.toBeNull();
  });
  it('rejects a five-byte exponent and a zero exponent', () => {
    expect(ok({ ...fakeRsa(modulusOfBits(2048)), e: b64u(Buffer.from([1, 0, 0, 0, 1])) })).toBeNull();
    expect(ok({ ...fakeRsa(modulusOfBits(2048)), e: b64u(Buffer.from([0])) })).toBeNull();
  });
  it.each([[undefined], [''], [5], ['AA=='], ['A'], ['not base64!'], [null]])('rejects a bad n or e encoding (%j)', (v) => {
    expect(ok({ ...K.rsa.jwk, n: v })).toBeNull();
    expect(ok({ ...K.rsa.jwk, e: v })).toBeNull();
  });
});

describe('importJwk: EC and OKP key rules', () => {
  it('rejects EC curves other than P-256', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
    expect(ok({ ...p384, kid: 'p384' })).toBeNull();
    const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ format: 'jwk' });
    expect(ok({ ...k1, kid: 'k1' })).toBeNull();
    expect(ok({ ...K.ec.jwk, crv: 'P-384' })).toBeNull();
    expect(ok({ ...K.ec.jwk, crv: undefined })).toBeNull();
  });
  it('rejects a point that is not on the curve', () => {
    const y = Buffer.from(K.ec.jwk.y as string, 'base64url');
    y[y.length - 1] ^= 0x01;
    expect(ok({ ...K.ec.jwk, y: y.toString('base64url') })).toBeNull();
  });
  it('rejects coordinates of the wrong length or encoding', () => {
    const x = Buffer.from(K.ec.jwk.x as string, 'base64url');
    expect(ok({ ...K.ec.jwk, x: x.subarray(1).toString('base64url') })).toBeNull();
    expect(ok({ ...K.ec.jwk, x: `${K.ec.jwk.x as string}=` })).toBeNull();
    expect(ok({ ...K.ec.jwk, y: undefined })).toBeNull();
  });
  it('rejects OKP curves other than Ed25519 and malformed Ed25519 points', () => {
    const ed448 = generateKeyPairSync('ed448').publicKey.export({ format: 'jwk' });
    expect(ok({ ...ed448, kid: 'ed448' })).toBeNull();
    const x25519 = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
    expect(ok({ ...x25519, kid: 'x25519' })).toBeNull();
    const x = Buffer.from(K.ed.jwk.x as string, 'base64url');
    expect(ok({ ...K.ed.jwk, x: x.subarray(0, 31).toString('base64url') })).toBeNull();
    expect(ok({ ...K.ed.jwk, x: Buffer.concat([x, Buffer.from([0])]).toString('base64url') })).toBeNull();
    expect(ok({ ...K.ed.jwk, crv: 'Ed25519', x: undefined })).toBeNull();
  });
});

describe('verifySignature', () => {
  const data = Buffer.from('header.payload');
  it.each([
    ['RS256', K.rsa],
    ['ES256', K.ec],
    ['EdDSA', K.ed],
  ])('verifies a genuine %s signature and nothing else', (_alg, key) => {
    const vk = importJwkOrThrow(key);
    const sig = signBytes(key, data);
    expect(verifySignature(vk, data, sig)).toBe(true);
    expect(verifySignature(vk, Buffer.from('header.payloaD'), sig)).toBe(false);
    const flipped = Buffer.from(sig);
    flipped[0] ^= 0x80;
    expect(verifySignature(vk, data, flipped)).toBe(false);
  });
  it('refuses a signature from another key of the same type', () => {
    const vk = importJwkOrThrow(K.ed);
    expect(verifySignature(vk, data, signBytes(K.other, data))).toBe(false);
    const ec2 = ecKey('ec-2');
    expect(verifySignature(importJwkOrThrow(K.ec), data, signBytes(ec2, data))).toBe(false);
  });
  it('refuses wrong-length signatures without calling into the crypto layer', () => {
    const vk = importJwkOrThrow(K.ec);
    expect(verifySignature(vk, data, Buffer.alloc(0))).toBe(false);
    expect(verifySignature(vk, data, Buffer.alloc(63))).toBe(false);
    expect(verifySignature(vk, data, Buffer.alloc(65))).toBe(false);
    expect(verifySignature(importJwkOrThrow(K.rsa), data, Buffer.alloc(255))).toBe(false);
  });
  it('never throws on garbage of the right length', () => {
    expect(verifySignature(importJwkOrThrow(K.ec), data, Buffer.alloc(64, 0xff))).toBe(false);
    expect(verifySignature(importJwkOrThrow(K.ed), data, Buffer.alloc(64, 0))).toBe(false);
    expect(verifySignature(importJwkOrThrow(K.rsa), data, Buffer.alloc(256, 0xff))).toBe(false);
  });
  it('does not accept an ES256 signature as EdDSA or the reverse (the key fixes the algorithm)', () => {
    const edKey2 = edKey('ed-2');
    const ecSig = signBytes(K.ec, data);
    expect(verifySignature(importJwkOrThrow(edKey2), data, ecSig)).toBe(false);
  });
});

function importJwkOrThrow(key: TestKey) {
  const vk = importJwk(key.jwk, ALL);
  if (!vk) throw new Error('test key failed to import');
  return vk;
}
