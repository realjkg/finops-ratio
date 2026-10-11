// JWK import and signature verification (checklist 1.1, 1.2). Trust boundary:
// a JWK comes from a network document, so each one is validated before it is
// turned into a key object, and a key that cannot be proven fit for
// verification is simply not usable (importJwk returns null). The algorithm a
// key may verify is fixed by the key itself (RSA gives RS256, P-256 gives
// ES256, Ed25519 gives EdDSA), never by the token header, which is what stops
// algorithm confusion.
//
// Rules:
//   - public keys only: any private or symmetric member rejects the JWK;
//   - `use`, when present, must be `sig`; `key_ops`, when present, must list
//     `verify`; `alg`, when present, must equal the algorithm the key implies;
//   - RSA modulus 2048 to 8192 bits and odd, exponent odd and at least 65537;
//   - EC must be P-256 and the point must be on the curve; OKP must be Ed25519.

import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { KID_RE, isPlainObject, type OidcAlg } from './shared';

export const MIN_RSA_BITS = 2048;
export const MAX_RSA_BITS = 8192;
const MIN_RSA_EXPONENT = 65_537;
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const MAX_KEY_OPS = 16;

export interface VerificationKey {
  readonly kid: string;
  /** The only algorithm this key may verify. */
  readonly alg: OidcAlg;
  readonly key: KeyObject;
  /** Exact signature length in bytes; any other length is refused before verifying. */
  readonly signatureBytes: number;
}

/** Strict base64url decode: unpadded, canonical, within `maxBytes`. Null when not. */
function b64urlBytes(v: unknown, maxBytes: number): Buffer | null {
  if (typeof v !== 'string' || v.length === 0 || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  const bytes = Buffer.from(v, 'base64url');
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64url') !== v) return null;
  return bytes;
}

function bitLength(bytes: Buffer): number {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i += 1;
  if (i === bytes.length) return 0;
  return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i]));
}

function stripLeadingZeros(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i += 1;
  return bytes.subarray(i);
}

function usableForVerify(jwk: Record<string, unknown>): boolean {
  if (Object.hasOwn(jwk, 'use') && jwk.use !== 'sig') return false;
  if (Object.hasOwn(jwk, 'key_ops')) {
    const ops = jwk.key_ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_KEY_OPS) return false;
    if (!ops.every((o) => typeof o === 'string') || !ops.includes('verify')) return false;
  }
  return true;
}

function importRsa(jwk: Record<string, unknown>): { key: KeyObject; signatureBytes: number } | null {
  const n = b64urlBytes(jwk.n, MAX_RSA_BITS / 8 + 1);
  const e = b64urlBytes(jwk.e, 8);
  if (!n || !e) return null;
  const nn = stripLeadingZeros(n);
  const bits = bitLength(nn);
  if (bits < MIN_RSA_BITS || bits > MAX_RSA_BITS || (nn[nn.length - 1] & 1) === 0) return null;
  const ee = stripLeadingZeros(e);
  if (ee.length === 0 || ee.length > 4 || (ee[ee.length - 1] & 1) === 0) return null;
  if (ee.readUIntBE(0, ee.length) < MIN_RSA_EXPONENT) return null;
  const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n as string, e: jwk.e as string } as JsonWebKey, format: 'jwk' });
  // Belt and braces: the key object's own view of the modulus must agree.
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'rsa' || !details || (details.modulusLength ?? 0) < MIN_RSA_BITS) return null;
  return { key, signatureBytes: Math.ceil(bits / 8) };
}

function importEc(jwk: Record<string, unknown>): { key: KeyObject; signatureBytes: number } | null {
  if (jwk.crv !== 'P-256') return null;
  const x = b64urlBytes(jwk.x, 32);
  const y = b64urlBytes(jwk.y, 32);
  if (!x || !y || x.length !== 32 || y.length !== 32) return null;
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string } as JsonWebKey, format: 'jwk' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
  return { key, signatureBytes: 64 };
}

function importOkp(jwk: Record<string, unknown>): { key: KeyObject; signatureBytes: number } | null {
  if (jwk.crv !== 'Ed25519') return null;
  const x = b64urlBytes(jwk.x, 32);
  if (!x || x.length !== 32) return null;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string } as JsonWebKey, format: 'jwk' });
  if (key.asymmetricKeyType !== 'ed25519') return null;
  return { key, signatureBytes: 64 };
}

/**
 * Turn one JWK into a verification key, or null when it must not be used for
 * any reason (bad shape, no kid, wrong use, private material, weak or
 * unsupported key, algorithm not allowed, import failure).
 */
export function importJwk(raw: unknown, allowed: ReadonlySet<OidcAlg>): VerificationKey | null {
  try {
    if (!isPlainObject(raw)) return null;
    const jwk = raw;
    if (typeof jwk.kid !== 'string' || !KID_RE.test(jwk.kid)) return null;
    for (const m of PRIVATE_MEMBERS) if (Object.hasOwn(jwk, m)) return null;
    if (!usableForVerify(jwk)) return null;

    let alg: OidcAlg;
    let imported: { key: KeyObject; signatureBytes: number } | null;
    switch (jwk.kty) {
      case 'RSA':
        alg = 'RS256';
        imported = importRsa(jwk);
        break;
      case 'EC':
        alg = 'ES256';
        imported = importEc(jwk);
        break;
      case 'OKP':
        alg = 'EdDSA';
        imported = importOkp(jwk);
        break;
      default:
        return null; // includes 'oct' (symmetric) and every other key type
    }
    if (!imported || !allowed.has(alg)) return null;
    if (Object.hasOwn(jwk, 'alg') && jwk.alg !== alg) return null;
    return Object.freeze({ kid: jwk.kid, alg, key: imported.key, signatureBytes: imported.signatureBytes });
  } catch {
    return null;
  }
}

/** Verify a signature with the key's own algorithm. False on any mismatch or error; never throws. */
export function verifySignature(vk: VerificationKey, signingInput: Buffer, signature: Buffer): boolean {
  if (signature.length !== vk.signatureBytes) return false;
  try {
    switch (vk.alg) {
      case 'RS256':
        return cryptoVerify('sha256', signingInput, vk.key, signature);
      case 'ES256':
        return cryptoVerify('sha256', signingInput, { key: vk.key, dsaEncoding: 'ieee-p1363' }, signature);
      case 'EdDSA':
        return cryptoVerify(null, signingInput, vk.key, signature);
      default:
        return false;
    }
  } catch {
    return false;
  }
}
