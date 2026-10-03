import { describe, expect, it } from 'vitest';
import { main } from './cli';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

// Port 1 on loopback: nothing listens there, so any connection attempt fails fast.
const UNREACHABLE = 'postgres://ratio_user:SuperSecretPw123@127.0.0.1:1/ratio_db';

describe('ingest CLI (no database)', () => {
  it('unknown command exits 2', async () => {
    const c = capture();
    expect(await main(['frobnicate'], {}, c.io)).toBe(2);
    expect(await main([], {}, c.io)).toBe(2);
    expect(c.err.join('\n')).toMatch(/usage/i);
  });

  it('rejects unknown flags', async () => {
    const c = capture();
    expect(await main(['migrate', '--yolo'], { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE }, c.io)).toBe(2);
    expect(await main(['migrate', 'up'], { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE }, c.io)).toBe(2);
  });

  it('--down requires a positive integer', async () => {
    const env = { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE, RATIO_ALLOW_DOWN_MIGRATIONS: '1' };
    for (const argv of [
      ['migrate', '--down'],
      ['migrate', '--down', '0'],
      ['migrate', '--down', '-1'],
      ['migrate', '--down', '1.5'],
      ['migrate', '--down', 'abc'],
      ['migrate', '--down', '1', '--status'],
    ]) {
      const c = capture();
      expect(await main(argv, env, c.io), argv.join(' ')).toBe(2);
    }
  });

  it('missing RATIO_MIGRATE_DATABASE_URL exits 1', async () => {
    const c = capture();
    expect(await main(['migrate'], {}, c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/RATIO_MIGRATE_DATABASE_URL/);
  });

  it('down is refused before connecting when not allowed', async () => {
    for (const env of [
      { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE },
      { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE, RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'production' },
      { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE, RATIO_ALLOW_DOWN_MIGRATIONS: '1', NODE_ENV: 'production' },
    ]) {
      const c = capture();
      expect(await main(['migrate', '--down', '1'], env, c.io)).toBe(1);
      const all = c.out.concat(c.err).join('\n');
      expect(all).toMatch(/DOWN_NOT_ALLOWED/);
      // Refused before any connection attempt (no ECONNREFUSED).
      expect(all).not.toMatch(/ECONNREFUSED|connect/i);
    }
  });

  it('connection errors never echo the database URL or password', async () => {
    const c = capture();
    expect(await main(['migrate'], { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE }, c.io)).toBe(1);
    const all = c.out.concat(c.err).join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('SuperSecretPw123');
    expect(all).not.toContain('ratio_user');
    expect(all).not.toContain(UNREACHABLE);
    // Every line is structured JSON.
    for (const line of c.out.concat(c.err)) expect(() => JSON.parse(line)).not.toThrow();
  });
});
