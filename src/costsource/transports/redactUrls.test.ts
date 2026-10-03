// URL redaction (round 8): one linear forward scan per scheme://… token.
//   (a) userinfo — everything between `://` and the LAST `@` before the first
//       `/ ? # \` or whitespace — is replaced, however long it is;
//   (b) a query (and a fragment) is replaced up to whitespace / the end of the
//       token; quoted ("…", '…', `…`, \"…\") parts belong to it, spaces inside
//       quotes included.
// Over-redacting the rest of a line is acceptable; leaking is not.

import { describe, expect, it } from 'vitest';
import { applyRedactionRules, redactUpstreamText } from './redact';

const S = 'URL-SECRET';

function expectRedacted(input: string, maxChars = Number.POSITIVE_INFINITY) {
  const out = redactUpstreamText(input, maxChars);
  expect(out).not.toContain(S);
  expect(out).toContain('[REDACTED]');
  return out;
}

describe('userinfo of any length', () => {
  it.each([
    ['just over the old 2,048 cap', 2_100],
    ['3,000 chars', 3_000],
    ['~15 KB (inside the 16 KB input cap)', 15_000],
  ])('%s', (_l, n) => {
    const input = `GET https://user:${S}${'x'.repeat(n)}@host.example/p failed`;
    const out = expectRedacted(input);
    expect(out).toContain('https://[REDACTED]@host.example/p');
    // The logged 300-char prefix is clean too.
    expect(redactUpstreamText(input)).not.toContain(S);
  });

  it('the LAST @ before the path ends the userinfo (an @ inside the password)', () => {
    const out = expectRedacted(`https://user:p@ss${S}@host.example/x`);
    expect(out).toContain('https://[REDACTED]@host.example/x');
  });

  it('upper-case scheme', () => {
    expectRedacted(`HTTPS://user:${S}@HOST.example/x`);
  });

  it('non-http schemes (postgres://, s3://)', () => {
    expectRedacted(`postgres://admin:${S}@db.internal:5432/app`);
    expectRedacted(`s3://AKID:${S}@bucket/key`);
  });

  it('scheme-relative //user:pw@host', () => {
    expect(expectRedacted(`see //user:${S}@host.example/p`)).toContain('//[REDACTED]@host.example/p');
    expectRedacted(`"//user:${S}@host.example/p"`);
  });

  it('a URL inside JSON-escaped text (https:\\/\\/…)', () => {
    expectRedacted(String.raw`{"detail":"fetch https:\/\/user:${S}@host.example\/p failed"}`);
  });

  it('no @ → authority kept', () => {
    expect(redactUpstreamText('https://host.example/p/q failed', 500)).toBe('https://host.example/p/q failed');
  });
});

describe('query and fragment', () => {
  it.each([
    ['plain', `https://x.test/p?token=${S}&a=1 next`],
    ['double-quoted value', `https://x.test/p?foo="${S}"`],
    ['single-quoted value', `https://x.test/p?foo='${S}'`],
    ['backtick value', 'https://x.test/p?foo=`' + S + '`'],
    ['escaped-quoted value', String.raw`https://x.test/p?foo=\"${S}\"`],
    ['quoted value with spaces', `https://x.test/p?foo="a b ${S} c"&z=1`],
    ['single-quoted value with spaces', `https://x.test/p?foo='a ${S} b'`],
    ['escaped-quoted value with spaces', String.raw`https://x.test/p?foo=\"a b ${S}\"`],
    ['unterminated quote runs to the end', `https://x.test/p?foo="a b ${S}`],
    ['fragment carrying a token', `https://app.test/cb#access_token=${S}&state=1`],
    ['query then fragment', `https://app.test/cb?x=1#id_token=${S}`],
    ['upper-case scheme', `HTTP://X.TEST/P?SIG=${S}`],
    ['non-http scheme', `s3://bucket/key?X-Amz-Signature=${S}`],
    ['JSON-escaped URL', String.raw`{"u":"https:\/\/x.test\/p?sig=${S}&a=\"${S}\""}`],
    ['inner URL in a redirect path keeps its userinfo redacted', `https://a.test/r/https://u:${S}@b.test/x`],
  ])('%s', (_l, input) => {
    const out = expectRedacted(input);
    expect(out).not.toMatch(/\?(?!\[REDACTED\])[^\s]*URL-SECRET/);
  });

  it('keeps scheme, host and path; replaces the whole query', () => {
    const out = redactUpstreamText(`GET https://acct.blob.core.windows.net/c/x.csv?sv=2024&sig="${S} z"&se=2030 failed`, 1000);
    expect(out).toBe('GET https://acct.blob.core.windows.net/c/x.csv?[REDACTED] failed');
  });

  it('a URL without query / fragment is unchanged', () => {
    expect(redactUpstreamText('see https://x.test/a/b and more', 500)).toBe('see https://x.test/a/b and more');
  });
});

describe('scan is applied by applyRedactionRules too (uncapped)', () => {
  it('long userinfo beyond the public 16 KB cap', () => {
    const out = applyRedactionRules(`https://u:${S}${'y'.repeat(40_000)}@h/p?q=${S}`);
    expect(out).not.toContain(S);
    expect(out).toBe('https://[REDACTED]@h/p?[REDACTED]');
  });
});
