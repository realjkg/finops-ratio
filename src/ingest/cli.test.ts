import { describe, expect, it } from 'vitest';
import { jsonLineRedactor, main, redactDeep, redactor } from './cli';

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
      { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE, RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'test', NODE_ENV: 'production' },
      { RATIO_MIGRATE_DATABASE_URL: UNREACHABLE, RATIO_ALLOW_DOWN_MIGRATIONS: '1', RATIO_ENV: 'staging' },
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

  it('redacts password= values in URL query strings and keyword DSNs', () => {
    const cases: Array<[string, string]> = [
      ['postgres://bob@127.0.0.1:1/db?sslmode=require&password=QuerySecret123', 'QuerySecret123'],
      ['postgres://127.0.0.1:1/db?password=Enc%40ded%21Pw', 'Enc%40ded%21Pw'],
      ["host=127.0.0.1 port=1 user=bob password=KeywordSecret456 dbname=x", 'KeywordSecret456'],
      ["host=127.0.0.1 password='Quoted Secret 789' dbname=x", 'Quoted Secret 789'],
    ];
    for (const [url, secret] of cases) {
      const redact = redactor(url);
      const msg = `failed: ${url} -- detail password=${secret} and again ${secret}`;
      const out = redact(msg);
      expect(out, url).not.toContain(secret);
      expect(out, url).toContain('[redacted]');
    }
    // Even text not derived from the configured URL never shows a password= value.
    expect(redactor(undefined)('conn password=Stray999 failed')).not.toContain('Stray999');
  });

  describe('secrets are redacted BEFORE JSON serialization (Copilot High, round 6)', () => {
    // Passwords whose JSON-escaped form differs from the raw / URL-decoded form.
    const PASSWORDS = ['abc"def', 'back\\slash', 'mix"\\"ed', 'line\nbreak', 'tab\there', 'pässwörd✓', 'ls ps', 'ctl\u0001x', '{"k":"v"}'];
    const urlFor = (pw: string) => `postgres://ratio_user:${encodeURIComponent(pw)}@127.0.0.1:1/ratio_db`;
    const forms = (pw: string) => [pw, JSON.stringify(pw).slice(1, -1), encodeURIComponent(pw)];

    it('a message carrying the decoded password is redacted in every serialized form', () => {
      for (const pw of PASSWORDS) {
        const line = jsonLineRedactor(urlFor(pw))({ level: 'error', event: 'migrate.failed', message: `boom: database "${pw}" does not exist`, nested: { list: [pw, { deeper: `x${pw}y` }] } });
        for (const f of forms(pw)) expect(line, JSON.stringify(pw)).not.toContain(f);
        expect(line).toContain('[redacted]');
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('literal %22 / %5C in the URL password: both the encoded and the decoded (and escaped) forms are redacted', () => {
      for (const [raw, decoded] of [
        ['abc%22def', 'abc"def'],
        ['abc%5Cdef', 'abc\\def'],
      ]) {
        const url = `postgres://ratio_user:${raw}@127.0.0.1:1/ratio_db`;
        const line = jsonLineRedactor(url)({ message: `a ${decoded} b ${raw} c`, error: new Error(`pg said ${decoded}`) });
        for (const f of [raw, decoded, JSON.stringify(decoded).slice(1, -1)]) expect(line, raw).not.toContain(f);
        expect(line).toContain('pg said [redacted]');
      }
    });

    it('redactDeep walks objects, arrays, Error messages and causes without mutating the input', () => {
      const pw = 'abc"def';
      const text = redactor(urlFor(pw));
      const cause = new Error(`inner ${pw}`);
      const err = new Error(`outer ${pw}`, { cause });
      const input = { a: pw, b: [1, `x ${pw}`, { c: pw }], err, [`key ${pw}`]: true };
      const out = redactDeep(input, text) as Record<string, unknown>;
      const json = JSON.stringify(out);
      expect(json).not.toContain('abc');
      expect(json).toContain('outer [redacted]');
      expect(json).toContain('inner [redacted]');
      expect(input.a).toBe(pw); // input untouched
      const cyc: Record<string, unknown> = { s: pw };
      cyc.self = cyc;
      expect(() => redactDeep(cyc, text)).not.toThrow();
    });

    it('the post-serialization pass alone is not what is relied on: escaped forms are also caught by the backstop', () => {
      const pw = 'abc"def';
      // A value that is already JSON text (e.g. a nested serialized document) still loses the secret.
      const line = jsonLineRedactor(urlFor(pw))({ doc: JSON.stringify({ p: pw }) });
      for (const f of forms(pw)) expect(line).not.toContain(f);
      // ... including the double-escaped form the outer serialization would make of it.
      expect(line).not.toContain(JSON.stringify(JSON.stringify(pw).slice(1, -1)).slice(1, -1));
      expect(line).not.toContain('def');
    });

    it('objects with toJSON are serialized through the redactor too', () => {
      const pw = 'abc"def';
      const line = jsonLineRedactor(urlFor(pw))({ wrapped: { toJSON: () => `via toJSON ${pw}` }, when: new Date(0) });
      for (const f of forms(pw)) expect(line).not.toContain(f);
      expect(line).toContain('via toJSON [redacted]');
      expect(line).toContain('1970-01-01T00:00:00.000Z');
    });

    it('backstop: a non-string value whose serialized text equals the secret is still redacted', () => {
      const pw = '90817263';
      const line = jsonLineRedactor(urlFor(pw))({ pid: 90817263 });
      expect(line).not.toContain(pw);
    });
  });
});

