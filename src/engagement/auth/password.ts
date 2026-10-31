// R2: password hashes for named engagement users. scrypt from node:crypto (no
// dependency). Format: scrypt$<log2 N>$<r>$<p>$<salt b64url>$<32-byte key b64url>.
// The cost bounds keep a hand-edited users file from making each sign-in a
// memory or CPU denial of service. SERVER-ONLY.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptParams { logN: number; r: number; p: number }
export const SCRYPT_DEFAULTS: ScryptParams = Object.freeze({ logN: 15, r: 8, p: 1 });
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;
const KEY_BYTES = 32;
// logN 14..16, r 1..8, p 1..4, salt 16..48 bytes, key exactly 32 bytes.
const HASH_RE = /^scrypt\$(1[4-6])\$([1-8])\$([1-4])\$([A-Za-z0-9_-]{22,64})\$([A-Za-z0-9_-]{43})$/;

export const isPasswordHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);

function derive(password: string, salt: Buffer, { logN, r, p }: ScryptParams): Promise<Buffer> {
  const N = 2 ** logN;
  const opts: ScryptOptions = { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
  return new Promise((resolve, reject) => scrypt(password.normalize('NFC'), salt, KEY_BYTES, opts, (e, key) => (e ? reject(e) : resolve(key))));
}

/** Hash a new password (operator tooling and tests). Throws on a length outside 12..1024. */
export async function hashPassword(password: string, params: ScryptParams = SCRYPT_DEFAULTS): Promise<string> {
  if (password.length < PASSWORD_MIN) throw new Error(`password must be at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) throw new Error(`password must be at most ${PASSWORD_MAX} characters`);
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  const encoded = `scrypt$${params.logN}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  if (!isPasswordHash(encoded)) throw new Error('scrypt parameters out of bounds');
  return encoded;
}

/** Constant-time check. False (never a throw) for a malformed hash or an over-long password. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const m = typeof encoded === 'string' ? HASH_RE.exec(encoded) : null;
  if (!m || typeof password !== 'string' || password.length > PASSWORD_MAX) return false;
  const expected = Buffer.from(m[5], 'base64url');
  const salt = Buffer.from(m[4], 'base64url');
  if (expected.length !== KEY_BYTES || salt.length < 16) return false;
  try {
    const key = await derive(password, salt, { logN: Number(m[1]), r: Number(m[2]), p: Number(m[3]) });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** A hash of a random password, so an unknown or disabled user costs the same work as a real one. */
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(randomBytes(24).toString('base64url')));
}
