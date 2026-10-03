// Redactor for upstream error bodies logged server-side: strips URL query
// strings, Bearer tokens, SAS parameters, and AWS access key ids, then
// truncates to 300 characters.

import { describe, expect, it } from 'vitest';
import { redactUpstreamText } from './redact';

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
});
