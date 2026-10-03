// Redactor for upstream error bodies logged server-side: strips URL query
// strings, Bearer tokens, SAS parameters, and AWS access key ids, then
// truncates to 300 characters.

import { describe, expect, it, vi } from 'vitest';
import { logUpstreamError, redactUpstreamText } from './redact';

describe('redactUpstreamText', () => {
  it('strips URL query strings', () => {
    const out = redactUpstreamText('GET https://acct.blob.core.windows.net/c/x.csv?sv=2024&sig=abc123&se=2030 failed');
    expect(out).not.toContain('sig=abc123');
    expect(out).not.toContain('se=2030');
    expect(out).toContain('https://acct.blob.core.windows.net/c/x.csv');
  });

  it('strips Bearer tokens', () => {
    const out = redactUpstreamText('Authorization: Bearer eyJhbGciOi.secret.part rejected');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('strips bare SAS parameters outside a URL', () => {
    const out = redactUpstreamText('<AuthenticationErrorDetail>sv=2021-08-06&sig=Zm9vYmFy%3D sr=c</AuthenticationErrorDetail>');
    expect(out).not.toContain('Zm9vYmFy');
    expect(out).not.toContain('2021-08-06');
    expect(out).toMatch(/sig=\[REDACTED\]/);
  });

  it('strips AWS access key ids (AKIA / ASIA)', () => {
    const out = redactUpstreamText('<AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId> and ASIAY34FZKBOKMUTVV7A');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('ASIAY34FZKBOKMUTVV7A');
  });

  it('truncates to 300 characters after redacting (a cut never exposes a partial secret)', () => {
    const long = `${'x'.repeat(290)} AKIAIOSFODNN7EXAMPLE ${'y'.repeat(500)}`;
    const out = redactUpstreamText(long);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).not.toContain('AKIAIOSF');
  });

  it.each([
    ['RATIO_API_TOKEN=', 'RATIO_API_TOKEN=s3cretRatioValue'],
    ['JIRA_API_TOKEN:', 'JIRA_API_TOKEN: s3cretJiraValue'],
    ['FINIO_PEER_TOKEN=', 'env FINIO_PEER_TOKEN=s3cretPeerValue loaded'],
    ['SERVICENOW_PASSWORD=', 'SERVICENOW_PASSWORD=s3cretSnowValue'],
    ['OPENLLM_API_KEY=', 'OPENLLM_API_KEY=s3cretLlmValue'],
    ['JSON "JIRA_API_TOKEN"', '{"JIRA_API_TOKEN": "s3cretJsonValue"}'],
    ['pwd=', 'login pwd=s3cretPwdValue'],
    ['passwd:', 'passwd: s3cretPasswdValue'],
    ['DB_PWD=', 'DB_PWD=s3cretDbValue'],
    ['x-finio-session:', 'x-finio-session: s3cretSessionValue'],
    ['X-FinIO-Session=', 'X-FinIO-Session=s3cretSessionValue2'],
    ['JSON "pwd"', '{"pwd":"s3cretJsonPwd"}'],
    ['DB_PASSWD=', 'DB_PASSWD=s3cretDbPasswd'],
    ['JSON "RATIO_API_TOKEN":', '{"RATIO_API_TOKEN":"s3cretJsonRatio"}'],
    ['X-FinIO-Session:', 'X-FinIO-Session: s3cretHeaderSession'],
  ])('redacts a prefixed / new credential key: %s', (_label, input) => {
    const out = redactUpstreamText(input);
    expect(out).not.toMatch(/s3cret/);
    expect(out).toContain('[REDACTED]');
  });

  it('keeps prose that merely resembles a scheme or key intact', () => {
    for (const prose of ['Basic Support plan', 'Bearer of costs', 'token count is high', 'password reset link sent']) {
      expect(redactUpstreamText(prose)).toBe(prose);
    }
  });

  it.each([
    ['double-quoted env value', 'JIRA_API_TOKEN="s3cret value with spaces"'],
    ['single-quoted env value', "SERVICENOW_PASSWORD='s3cret value'"],
    ['double-quoted with escaped quote inside', 'RATIO_API_TOKEN="s3cret\\"tail-s3cret"'],
    ['single-quoted with escaped quote inside', "FINIO_PEER_TOKEN='s3cret\\'tail-s3cret'"],
    ['quoted after colon', 'JIRA_API_TOKEN: "s3cretColonQuoted"'],
    ['lower-case quoted', 'password="s3cret pw"'],
    ['JSON-ish "KEY": "value"', '{"JIRA_API_TOKEN": "s3cret\\"json"}'],
    ['unterminated quote', 'JIRA_API_TOKEN="s3cretUnterminated and more'],
  ])('redacts a whole quoted value: %s', (_label, input) => {
    const out = redactUpstreamText(input);
    expect(out).not.toMatch(/s3cret|tail-|json"/);
    expect(out).toContain('[REDACTED]');
  });

  it.each([
    'cost_per_token: 0.002',
    'input_token: 12',
    'is_secret: false',
    'has_password=true',
    '{"team_token":"blue"}',
    'max_tokens: 4096',
    'tokenomics_report=ready',
    '{"max_tokens": 512, "tokenomics_report": "ok"}',
  ])('does not over-redact the ordinary field %j', (input) => {
    expect(redactUpstreamText(input)).toBe(input);
  });

  it.each([
    ['env-key runs', () => 'A_'.repeat(500_000) + 'TOKEN'],
    ['upper-case word chars', () => 'A'.repeat(1_000_000)],
    ['repeated open quotes', () => 'API_TOKEN="'.repeat(90_000)],
    ['repeated single quotes', () => "PASSWORD='".repeat(100_000)],
    ['one open quote then 1 MB', () => 'TOKEN="' + 'x'.repeat(1_000_000)],
    ['backslash runs in a quote', () => 'TOKEN="' + '\\'.repeat(1_000_000)],
    ['many short keys', () => 'X_TOKEN= '.repeat(110_000)],
  ])('no catastrophic backtracking on 1 MB worst case: %s', (_label, make) => {
    const input = make();
    expect(input.length).toBeGreaterThanOrEqual(900_000);
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      redactUpstreamText(input, 64);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(50);
  });
});

// --- Round 5: backslash-escaped quotes, backticks, mixed-case env keys ------

describe('backslash-escaped quote delimiters (JSON-in-a-string bodies)', () => {
  it.each([
    ['escaped-quote value inside a JSON string', String.raw`"detail":"password=\"hunter2 secret words\""`],
    ['env-style escaped-quote value', String.raw`RATIO_API_TOKEN=\"env secret words\"`],
    ['inner escaped quote inside an escaped value', String.raw`token=\"a\\\"b secret\"`],
    ['dangling escaped quote runs to the end', String.raw`pwd=\"dangling secret words`],
    ['double-encoded JSON', String.raw`{\"password\":\"double encoded secret\"}`],
    ['double-encoded env JSON', String.raw`{\"JIRA_API_TOKEN\": \"double env secret\", \"user\": \"bob\"}`],
    ['backtick-quoted value', 'password=`backtick secret words`'],
    ['backtick env value', 'SERVICENOW_PASSWORD=`backtick env secret`'],
  ])('%s', (_label, input) => {
    const out = redactUpstreamText(input);
    expect(out).not.toMatch(/hunter2|secret words|env secret|b secret|double encoded|double env|backtick (env )?secret/);
    expect(out).toContain('[REDACTED]');
  });

  it('double-encoded JSON keeps the neighbouring non-secret fields', () => {
    const out = redactUpstreamText(String.raw`{\"password\":\"x-secret\",\"user\":\"bob\"}`);
    expect(out).not.toContain('x-secret');
    expect(out).toContain(String.raw`\"user\":\"bob\"`);
  });

  it('live-style: a Jira 500 body logged through logUpstreamError never carries the secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const body = String.raw`{"errorMessages":["bad"],"detail":"password=\"hunter2 secret words\" RATIO_API_TOKEN=\"env secret words\" {\"password\":\"double encoded secret\"}"}`;
      logUpstreamError('Jira createChange', 500, body);
      const line = String(warn.mock.calls[0][0]);
      expect(line).not.toMatch(/hunter2|secret words|double encoded/);
      expect((JSON.parse(line) as { body: string }).body).toContain('[REDACTED]');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mixed-case env keys (decision: redact when the key starts with an upper-case letter)', () => {
  it.each(['Db_Password=s3cretMixed', 'Jira_Api_Token: s3cretMixed2', '{"Db_Password":"s3cretMixed3"}'])(
    'redacts %j',
    (input) => {
      const out = redactUpstreamText(input);
      expect(out).not.toContain('s3cret');
      expect(out).toContain('[REDACTED]');
    },
  );

  it.each(['has_password=true', 'cost_per_token: 0.002', 'is_secret: false', '{"team_token":"blue"}'])(
    'still leaves lower-case snake_case %j alone',
    (input) => {
      expect(redactUpstreamText(input)).toBe(input);
    },
  );
});

describe('input cap', () => {
  it('a secret straddling the 16 KB redaction cap is never emitted half-redacted', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNlY3JldA';
    for (let pad = 16_330; pad <= 16_384; pad += 3) {
      const input = '-----BEGIN PRIVATE KEY-----\n' + 'Q'.repeat(pad - 60) + '\n-----END PRIVATE KEY----- ' + 'x'.repeat(40) + ' ' + jwt + ' tail';
      const out = redactUpstreamText(input, Number.POSITIVE_INFINITY);
      expect(out).not.toContain('eyJhbGci');
      expect(out).not.toContain('c2lnbmF0');
    }
  });

  it('only the first 16 KB is redacted / emitted, even with an unlimited maxChars', () => {
    const out = redactUpstreamText('word '.repeat(40_000), Number.POSITIVE_INFINITY);
    expect(out.length).toBeLessThanOrEqual(16_384 + ' …[TRUNCATED]'.length);
    expect(out.endsWith(' …[TRUNCATED]')).toBe(true);
    expect(redactUpstreamText('short body', Number.POSITIVE_INFINITY)).toBe('short body');
  });

  it('output is still truncated to maxChars', () => {
    expect(redactUpstreamText('y'.repeat(100_000), 300).length).toBeLessThanOrEqual(300);
  });
});

