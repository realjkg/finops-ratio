import { describe, expect, it } from 'vitest';
import { MAX_REDACTED_LENGTH, jsonLineRedactorFor, redact, secretsFromEnv } from './redact';

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
  });

  it('the serialized-text backstop never truncates long output', () => {
    const line = jsonLineRedactorFor({});
    const value = { rows: Array.from({ length: 500 }, (_, i) => `row-${i}-${'x'.repeat(20)}`) };
    expect(JSON.parse(line(value))).toEqual(value);
  });
});

