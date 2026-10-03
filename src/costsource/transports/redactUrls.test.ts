// URL redaction (round 8): one linear forward scan per scheme://… token.
//   (a) userinfo — everything between `://` and the LAST `@` before the first
//       `/ ? # \` or whitespace — is replaced, however long it is;
//   (b) a query (and a fragment) is replaced up to whitespace / the end of the
//       token; quoted ("…", '…', `…`, \"…\") parts belong to it, spaces inside
//       quotes included.
// Over-redacting the rest of a line is acceptable; leaking is not.

import { describe, expect, it, vi } from 'vitest';
import { applyRedactionRules, logUpstreamError, redactUpstreamText } from './redact';

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

  it('a fragment is replaced even when its key is not a credential name', () => {
    expect(redactUpstreamText(`https://app.test/cb#code=${S}&x=1 done`, 500)).toBe('https://app.test/cb#[REDACTED] done');
    expect(redactUpstreamText(`https://app.test/cb#${S}`, 500)).toBe('https://app.test/cb#[REDACTED]');
  });

  it('JSON-escaped: an @ after an escaped slash is path, not userinfo (host kept)', () => {
    const out = redactUpstreamText(String.raw`{"u":"https:\/\/host.example\/users\/bob@corp.example"}`, 500);
    expect(out).toContain(String.raw`https:\/\/host.example\/users\/bob@corp.example`);
    // A lone `\` does NOT end the authority (DOMAIN\user NTLM credentials
    // contain one), so an @ after a raw backslash is treated as userinfo —
    // accepted over-redaction.
    const win = redactUpstreamText(String.raw`https://host.example\users\bob@corp.example`, 500);
    expect(win).toBe('https://[REDACTED]@corp.example');
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

// --- Round 9 ---------------------------------------------------------------

describe('Windows / NTLM DOMAIN\\user proxy credentials (regression in 403da2b)', () => {
  it.each([
    ['plain', String.raw`proxy http://CORP\jdoe:SECRETNTLM@proxy:8080 refused`],
    ['JSON-escaped backslash', String.raw`{"proxy":"http://CORP\\jdoe:SECRETNTLM@proxy:8080"}`],
    ['JSON-escaped URL + backslash', String.raw`{"proxy":"http:\/\/CORP\\jdoe:SECRETNTLM@proxy:8080\/x"}`],
    ['double-escaped', String.raw`{\"proxy\":\"http:\\\/\\\/CORP\\\\jdoe:SECRETNTLM@proxy:8080\\\/x\"}`],
  ])('%s', (_l, input) => {
    const out = redactUpstreamText(input, 1000);
    expect(out).not.toContain('SECRETNTLM');
    expect(out).not.toContain('jdoe');
    expect(out).toContain('[REDACTED]');
  });

  it('live-style through logUpstreamError', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logUpstreamError('Proxy', 407, String.raw`{"message":"auth failed for http://CORP\\jdoe:SECRETNTLM@proxy:8080"}`);
      const line = String(warn.mock.calls[0][0]);
      expect(line).not.toContain('SECRETNTLM');
      expect(line).toContain('[REDACTED]');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('double-escaped scheme start https:\\\\\\/\\\\\\/', () => {
  it('userinfo and query are redacted', () => {
    const out = redactUpstreamText(String.raw`"u":"https:\\\/\\\/user:${S}@host\\\/p?sig=${S}"`, 1000);
    expect(out).not.toContain(S);
    expect(out).toContain('[REDACTED]');
  });
});

describe('a literal / inside the password (user:pa/ss@host)', () => {
  it.each([
    String.raw`http://user:pa/ss${S}@host.example/x`,
    String.raw`https://user:a/b/c${S}@host.example`,
    String.raw`{"u":"https://user:pa/ss${S}@host.example/x"}`,
  ])('%s', (input) => {
    const out = redactUpstreamText(input, 1000);
    expect(out).not.toContain(S);
    expect(out).not.toMatch(/user:pa|user:a\//);
  });

  it('the extension stops at whitespace / a quote (limited over-redaction)', () => {
    const out = redactUpstreamText(`http://host.example:8080/users/bob@corp.example see also mail@other.example`, 1000);
    // host:port + a later @ in the same token is treated as userinfo (accepted),
    // but nothing after the whitespace is touched.
    expect(out).toBe('http://[REDACTED]@corp.example see also mail@other.example');
  });

  it('the extension never crosses a quote (next JSON field kept)', () => {
    const input = '{"u":"http://host.example:8080/p","mail":"bob@corp.example"}';
    expect(redactUpstreamText(input, 500)).toBe(input);
  });

  it('no ":" in the authority → no extension (path @ kept)', () => {
    expect(redactUpstreamText('https://host.example/users/bob@corp.example', 500)).toBe(
      'https://host.example/users/bob@corp.example',
    );
  });
});

describe('scheme-relative // only after a delimiter', () => {
  it('a // inside a word is not a URL start (no redaction)', () => {
    expect(redactUpstreamText('path a//b:c@d and x//y@z', 500)).toBe('path a//b:c@d and x//y@z');
  });

  it('after whitespace / quote / = it is', () => {
    expect(redactUpstreamText(`x=//u:${S}@h/p`, 500)).toBe('x=//[REDACTED]@h/p');
  });
});

// --- Round 10: quotes end the authority -------------------------------------

describe('a quote ends the authority (no running into the next JSON field)', () => {
  it.each([
    ['two URLs in JSON', '{"api":"https://api.example.com","proxy":"http://svc:SECRETPROXY@proxy.corp:8080"}', 'https://api.example.com"'],
    ['host then userinfo URL', '{"a":"https://host","b":"https://user:SECRETPROXY@h2/p"}', 'https://host"'],
    ['host:443 then a proxy URL', '{"api":"https://api.x.com:443","proxy":"http://svc:SECRETPROXY@proxy:8080"}', 'https://api.x.com:443"'],
    ['single quotes', "{'api':'https://api.example.com','proxy':'http://svc:SECRETPROXY@proxy.corp'}", "https://api.example.com'"],
    ['backticks', '`https://api.example.com` and `http://svc:SECRETPROXY@proxy.corp`', 'https://api.example.com`'],
    [
      'double-encoded two URLs',
      String.raw`{\"api\":\"https://api.example.com\",\"proxy\":\"http://svc:SECRETPROXY@proxy.corp:8080\"}`,
      String.raw`https://api.example.com\"`,
    ],
    [
      'escaped \\" boundary between URLs',
      String.raw`\"https://a.example\",\"https://u:SECRETPROXY@b.example\"`,
      String.raw`https://a.example\"`,
    ],
    [
      'double-encoded host:443 then proxy',
      String.raw`{\"api\":\"https:\/\/api.x.com:443\",\"proxy\":\"http:\/\/svc:SECRETPROXY@proxy:8080\"}`,
      String.raw`https:\/\/api.x.com:443\"`,
    ],
  ])('%s', (_l, input, kept) => {
    const out = redactUpstreamText(input, 1000);
    expect(out).not.toContain('SECRETPROXY');
    expect(out).toContain('[REDACTED]@');
    expect(out).toContain(kept);
  });

  it('a host-only URL does not swallow the next field (cross-field over-redaction)', () => {
    const input = '{"u":"https://host","e":"bob@corp.com"}';
    expect(redactUpstreamText(input, 500)).toBe(input);
    const enc = String.raw`{\"u\":\"https://host\",\"e\":\"bob@corp.com\"}`;
    expect(redactUpstreamText(enc, 500)).toBe(enc);
    // Single quotes and backticks end the authority too.
    const single = "{'u':'https://host','e':'bob@corp.com'}";
    expect(redactUpstreamText(single, 500)).toBe(single);
    const tick = '`https://host`,`bob@corp.com`';
    expect(redactUpstreamText(tick, 500)).toBe(tick);
  });

  it('URLs joined without a quote / space separator are each scanned', () => {
    const out = redactUpstreamText('https://a.example,http://u:SECRETPROXY@b.example/x', 500);
    expect(out).not.toContain('SECRETPROXY');
    expect(out).toContain('https://a.example,http://[REDACTED]@b.example/x');
  });

  it('NTLM in JSON-escaped form (\\\\ before the user) is still redacted', () => {
    const out = redactUpstreamText(String.raw`{"proxy":"http://CORP\\jdoe:SECRETNTLM@proxy:8080","x":"y"}`, 500);
    expect(out).not.toContain('SECRETNTLM');
    expect(out).toContain('"x":"y"');
  });
});

