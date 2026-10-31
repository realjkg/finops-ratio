// R2: scrypt password hashes (node:crypto, no dependency). Passwords are
// generated at run time (SYNTHETIC); no credential literal is committed.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, isPasswordHash, verifyPassword } from './password';

const pw = () => randomBytes(18).toString('base64url');
const FAST = { logN: 14, r: 8, p: 1 };

describe('hashPassword / verifyPassword', () => {
  it('round-trips, salts every hash, and rejects a wrong password', async () => {
    const secret = pw();
    const [a, b] = await Promise.all([hashPassword(secret, FAST), hashPassword(secret, FAST)]);
    expect(a).toMatch(/^scrypt\$14\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(secret);
    expect(await verifyPassword(secret, a)).toBe(true);
    expect(await verifyPassword(secret, b)).toBe(true);
    expect(await verifyPassword(`${secret}x`, a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('refuses short passwords when hashing and over-long ones when verifying', async () => {
    await expect(hashPassword('short', FAST)).rejects.toThrow(/at least 12/);
    const long = 'a'.repeat(1025);
    await expect(hashPassword(long, FAST)).rejects.toThrow(/at most 1024/);
    expect(await verifyPassword(long, await hashPassword(pw(), FAST))).toBe(false);
  });

  it('a malformed or out-of-bounds hash never verifies and never throws (cost bounds stop a config-driven DoS)', async () => {
    const good = await hashPassword(pw(), FAST);
    const parts = good.split('$');
    const bad = [
      '', 'scrypt', good.replace('scrypt', 'bcrypt'), [parts[0], '22', ...parts.slice(2)].join('$'),
      [parts[0], '13', ...parts.slice(2)].join('$'), [parts[0], parts[1], '64', ...parts.slice(3)].join('$'),
      [parts[0], parts[1], parts[2], '9', ...parts.slice(4)].join('$'), `${good}$`, good.slice(0, -1),
    ];
    for (const h of bad) {
      expect(isPasswordHash(h), h).toBe(false);
      await expect(verifyPassword('anything-at-all', h)).resolves.toBe(false);
    }
    expect(isPasswordHash(good)).toBe(true);
    expect(isPasswordHash(42)).toBe(false);
  });
});
