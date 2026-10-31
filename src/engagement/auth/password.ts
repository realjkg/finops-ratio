// R2: password hashes for named engagement users. scrypt from node:crypto (no
// dependency). Format: scrypt$15$8$1$<16-byte salt b64url>$<32-byte key b64url>.
// ONLY the default cost is accepted, so every stored hash costs exactly the
// work of the dummy hash used for unknown, suspended or credential-less users
// (no timing oracle on user existence) and a hand-edited users file cannot make
// sign-in a memory or CPU denial of service. SERVER-ONLY.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const SCRYPT_DEFAULTS = Object.freeze({ logN: 15, r: 8, p: 1 });
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;
const KEY_BYTES = 32;
const N = 2 ** SCRYPT_DEFAULTS.logN;
const OPTS = Object.freeze({ N, r: SCRYPT_DEFAULTS.r, p: SCRYPT_DEFAULTS.p, maxmem: 256 * N * SCRYPT_DEFAULTS.r + 1024 * 1024 });
const PREFIX = `scrypt$${SCRYPT_DEFAULTS.logN}$${SCRYPT_DEFAULTS.r}$${SCRYPT_DEFAULTS.p}$`;
const HASH_RE = /^scrypt\$15\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

/** The key-derivation seam (tests count calls); always the default cost. */
export const kdf = { scrypt };

export const isPasswordHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => kdf.scrypt(password.normalize('NFC'), salt, KEY_BYTES, OPTS, (e, key) => (e ? reject(e) : resolve(key))));
}

/** Hash a new password (operator tooling and tests). Throws on a length outside 12..1024. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN) throw new Error(`password must be at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) throw new Error(`password must be at most ${PASSWORD_MAX} characters`);
  const salt = randomBytes(16);
  return `${PREFIX}${salt.toString('base64url')}$${(await derive(password, salt)).toString('base64url')}`;
}

/** Constant-time check. False (never a throw) for a malformed hash or an over-long password. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const m = typeof encoded === 'string' ? HASH_RE.exec(encoded) : null;
  if (!m || typeof password !== 'string' || password.length > PASSWORD_MAX) return false;
  const salt = Buffer.from(m[1], 'base64url');
  const expected = Buffer.from(m[2], 'base64url');
  if (salt.length !== 16 || expected.length !== KEY_BYTES) return false;
  try {
    return timingSafeEqual(await derive(password, salt), expected);
  } catch {
    return false;
  }
}

// A random salt and a random key at the default cost, built at module load
// without any scrypt: verifying against it costs one default-cost scrypt and
// never matches (the key is not derived from any password).
const DUMMY = `${PREFIX}${randomBytes(16).toString('base64url')}$${randomBytes(KEY_BYTES).toString('base64url')}`;
/** The hash used for unknown, suspended or credential-less users: same work as a real one. */
export const dummyHash = (): string => DUMMY;
