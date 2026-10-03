import { describe, expect, it } from 'vitest';
import { MAX_REDACTED_LENGTH, jsonLineRedactorFor, redact, scrubLiterals, secretForms, secretsFromEnv } from './redact';

describe('redact', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['URL query string', 'GET https://bucket.s3.amazonaws.com/a/b.csv.gz?X-Amz-Expires=300&foo=bar failed', /foo=bar|X-Amz-Expires/],
    ['presigned signature', 'url=https://h/x?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAABCDEFGHIJKLMNOP%2F', /deadbeefcafe|AKIAABCDEFGHIJKLMNOP/],
    ['bare sig=', 'blob sig=Zm9vYmFyc2VjcmV0 rejected', /Zm9vYmFyc2VjcmV0/],
    ['bearer token', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', /eyJhbGciOiJIUzI1NiJ9/],
    ['AWS access key id', 'key AKIAIOSFODNN7EXAMPLE was denied', /AKIAIOSFODNN7EXAMPLE/],
    ['AWS temp key id', 'key ASIAIOSFODNN7EXAMPLE expired', /ASIAIOSFODNN7EXAMPLE/],
    ['AWS secret after name', 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', /wJalrXUtnFEMI/],
    ['security token', 'X-Amz-Security-Token: FwoGZXIvYXdzEJr//////////wEaDOyxtoken', /FwoGZXIvYXdzEJr/],
    ['postgres URL credentials', 'connect postgres://ratio_user:hunter2pass@db.internal:5432/ratio failed', /hunter2pass|ratio_user/],
    ['password=', 'conninfo host=x password=s3cr3tpw user=y', /s3cr3tpw/],
    ['signature=', 'token signature=abcdef0123456789 bad', /abcdef0123456789/],
  ];
  for (const [name, input, leak] of cases) {
    it(`removes ${name}`, () => {
      const out = redact(input);
      expect(out).not.toMatch(leak);
      expect(out).toContain('[redacted]');
    });
  }

  it('removes literal configured secrets anywhere', () => {
    const out = redact('the value was plain-looking-secret-123 inside text', ['plain-looking-secret-123']);
    expect(out).not.toContain('plain-looking-secret-123');
  });

  it('ignores empty/short configured secrets (no over-redaction)', () => {
    expect(redact('abc def', ['', 'a'])).toBe('abc def');
  });

  it('leaves benign operational text unchanged', () => {
    const s = 'period 2026-07-01 quarantined: 3 errors (UNPARSEABLE_NUMBER x2, PERIOD_MISMATCH x1); sha256 ' + 'a'.repeat(64);
    expect(redact(s)).toBe(s);
  });

  it(`caps output at ${MAX_REDACTED_LENGTH} characters`, () => {
    expect(MAX_REDACTED_LENGTH).toBe(4000);
    expect(redact('x'.repeat(10_000)).length).toBeLessThanOrEqual(4000);
  });

  it('secretsFromEnv collects credential env values and DB URL passwords', () => {
    const s = secretsFromEnv({
      RATIO_SOURCE_S3_SECRET_ACCESS_KEY: 'srcsecretvalue',
      RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY: 'evsecretvalue',
      RATIO_SOURCE_S3_SESSION_TOKEN: 'sessiontokenvalue',
      RATIO_DATABASE_URL: 'postgres://worker:dbpassword1@h/db',
      RATIO_MIGRATE_DATABASE_URL: 'postgres://owner:dbpassword2@h/db',
      UNRELATED: 'not-a-secret',
    });
    for (const v of ['srcsecretvalue', 'evsecretvalue', 'sessiontokenvalue', 'dbpassword1', 'dbpassword2']) expect(s).toContain(v);
    expect(s).not.toContain('not-a-secret');
  });
});

// Slice 0 round 6 pattern: redact every string BEFORE serialization (escaping a
// quote or backslash must not hide a secret from the redactor), then a literal
// backstop over the serialized text.
describe('jsonLineRedactorFor (redact before serialize)', () => {
  const secret = 'pw"q\\b%22x';
  const url = `postgres://worker_login:${encodeURIComponent(secret)}@127.0.0.1:5432/${encodeURIComponent(secret)}`;
  const forms = (s: string) => {
    const dec = (() => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })();
    return [s, dec, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), JSON.stringify(dec).slice(1, -1), JSON.stringify(encodeURIComponent(s)).slice(1, -1)];
  };

  it('no form of a quoted/backslashed/%22 password survives in a serialized line (values, keys, nested Errors)', () => {
    const line = jsonLineRedactorFor({ RATIO_DATABASE_URL: url });
    const err = Object.assign(new Error(`database "${secret}" does not exist`), { code: '3D000', cause: new Error(`inner ${secret}`) });
    const text = line({ message: `database "${secret}" does not exist`, nested: { [secret]: [secret, encodeURIComponent(secret)] }, err });
    expect(() => JSON.parse(text)).not.toThrow();
    for (const f of forms(secret)) expect(text, f).not.toContain(f);
    expect(text).toContain('[redacted]');
    // Errors are serialized (redacted), not silently dropped to {}.
    const parsed = JSON.parse(text);
    expect(parsed.err).toMatchObject({ name: 'Error', code: '3D000' });
    expect(parsed.err.message).toContain('[redacted]');
    expect(parsed.err.cause.message).toContain('[redacted]');
  });

  it('a value that already holds the JSON-escaped form of the secret is redacted (W2)', () => {
    const line = jsonLineRedactorFor({ RATIO_DATABASE_URL: url });
    const escaped = JSON.stringify(secret).slice(1, -1); // pw\"q\\b%22x as literal characters
    const text = line({ detail: `server said: ${escaped}`, [escaped]: 1 });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const printedValues = [...Object.keys(parsed), ...Object.values(parsed).map(String)].join('\n');
    for (const f of forms(secret)) {
      expect(text, f).not.toContain(f);
      expect(printedValues, f).not.toContain(f);
    }
  });

  it('a worker log line with a BigInt, a Buffer and a toJSON that returns a secret is one valid, redacted line (L-k)', () => {
    const line = jsonLineRedactorFor({ RATIO_DATABASE_URL: url });
    const value = {
      rows: BigInt('9007199254740993'),
      payload: Buffer.from(`bytes ${secret}`, 'utf8'),
      custom: { toJSON: () => ({ note: `custom ${secret}` }) },
    };
    let text = '';
    expect(() => (text = line(value))).not.toThrow();
    const parsed = JSON.parse(text);
    // BigInt is printed as its exact decimal text (no float rounding).
    expect(parsed.rows).toBe('9007199254740993');
    // Raw bytes are never printed, not even index by index.
    expect(parsed.payload).toBe('[binary]');
    // toJSON is honoured and its result is redacted.
    expect(parsed.custom).toEqual({ note: 'custom [redacted]' });
    for (const f of forms(secret)) expect(text, f).not.toContain(f);
  });

  it('the serialized-text backstop never truncates long output', () => {
    const line = jsonLineRedactorFor({});
    const value = { rows: Array.from({ length: 500 }, (_, i) => `row-${i}-${'x'.repeat(20)}`) };
    expect(JSON.parse(line(value))).toEqual(value);
  });
});

// Overlapping DISTINCT secrets: a single leftmost alternation consumes the
// first match and leaves the rest of the overlapping one behind
// ('admin;x' + 'x;secret;pw' on 'admin;x;secret;pw' -> '[redacted];secret;pw').
// Every character covered by ANY occurrence of ANY secret must be redacted.
describe('overlapping secrets (all three entry points)', () => {
  const CASES: Array<{ name: string; secrets: string[]; text: string }> = [
    { name: 'two overlapping', secrets: ['admin;x', 'x;secret;pw'], text: 'login admin;x;secret;pw done' },
    { name: 'two overlapping, other order', secrets: ['x;secret;pw', 'admin;x'], text: 'admin;x;secret;pw' },
    { name: 'three-way overlap', secrets: ['one;two', 'two;three;four', 'four;five'], text: 'k=one;two;three;four;five end' },
    { name: 'secret that is a substring of another', secrets: ['topsecret99', 'secret'], text: 'topsecret99 and secret and xsecretx' },
    { name: 'self-overlapping occurrences', secrets: ['abab'], text: 'zz ababab zz' },
  ];
  /** Every substring of >= 3 characters of every secret (none occurs in '[redacted]' or the surrounding text). */
  const remainders = (secrets: string[]) => {
    const out = new Set<string>();
    for (const sec of secrets) for (let i = 0; i + 3 <= sec.length; i++) out.add(sec.slice(i, i + 3));
    return [...out];
  };
  const noRemainder = (label: string, out: string, secrets: string[]) => {
    for (const r of remainders(secrets)) expect(out.includes(r), `${label}: ${JSON.stringify(r)} survives in ${JSON.stringify(out)}`).toBe(false);
  };

  for (const c of CASES) {
    it(`${c.name}: redact leaves no remainder of any secret`, () => {
      noRemainder('redact', redact(c.text, secretForms(c.secrets)), c.secrets);
    });
    it(`${c.name}: scrubLiterals leaves no remainder of any secret`, () => {
      noRemainder('scrubLiterals', scrubLiterals(c.text, secretForms(c.secrets)), c.secrets);
    });
    it(`${c.name}: jsonLineRedactorFor leaves no remainder of any secret (values, keys, Errors)`, () => {
      const env: Record<string, string> = {};
      c.secrets.forEach((sec, i) => (env[`RATIO_TEST_${i}_SECRET`] = sec));
      const line = jsonLineRedactorFor(env)({ message: c.text, [c.text]: [c.text], err: new Error(c.text) });
      noRemainder('jsonLineRedactorFor', line, c.secrets);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      noRemainder('jsonLineRedactorFor (parsed)', JSON.stringify(Object.keys(parsed)) + JSON.stringify(Object.values(parsed)), c.secrets);
    });
  }
});

