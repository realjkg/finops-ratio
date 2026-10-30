// M0b: redaction stays linear on hostile input and closes the review-round-2
// leaks (cookies, short bearer tokens, unterminated or escaped quotes). SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { redactString } from './redact';

const red = (s: string) => redactString(s, { n: 0 });

describe('redactString', () => {
  it('finishes 1 MB hostile inputs in under a second each', () => {
    const MB = 1 << 20;
    for (const unit of ['a', 'a.', 'a-', 'eyJ-', 'AKIA', 'Aa1', 'x://', 'token=x&', "password='", '"token":"', '-----BEGIN A-----', 'Bearer ', 'a=']) {
      const s = unit.repeat(Math.ceil(MB / unit.length));
      const t = Date.now();
      red(s);
      expect([unit, Date.now() - t < 1000]).toEqual([unit, true]);
    }
  });

  it('redacts whole header values, short bearer tokens, and the tail of unterminated or escaped quotes', () => {
    expect(red('Cookie: theme=dark; JSESSIONID=8F3A2C9D1E7B4A6F0C5D9E8B7A6F5C4D')).toBe('Cookie: [redacted]');
    expect(red('Set-Cookie: sid=31d4d96e407aad42; Path=/; Secure')).toBe('Set-Cookie: [redacted]');
    expect(red('Authorization: Bearer abc')).toBe('Authorization: [redacted]');
    expect(red('Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe('Proxy-Authorization: [redacted]');
    const keyId = ['AKIA', 'SYNTHETIC', 'EXAMPLE'].join(''); // assembled so the source holds no key-shaped literal
    expect(red(`Authorization: AWS4-HMAC-SHA256 Credential=${keyId}/20261030/us-east-1/s3/aws4_request, Signature=abc\nnext line`)).toBe('Authorization: [redacted]\nnext line');
    expect(red("password='unterminated-hunter2")).not.toContain('hunter2');
    expect(red('{"client_secret": "abc\\"def-after-escaped-quote", "limit": "10"}')).toBe('{"client_secret": "[redacted]", "limit": "10"}');
    expect(red('https://user:p@ss@host.example.test/x')).toBe('https://[redacted]@host.example.test/x');
    expect(red('client_assertion=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl&code=c1')).toBe('client_assertion=[redacted]&code=[redacted]');
    expect(red('requestId 7f3a9B2c4D6e8F0a1B3c5D7e9F1a3B5c7D9e1F3a')).toBe('requestId 7f3a9B2c4D6e8F0a1B3c5D7e9F1a3B5c7D9e1F3a'); // hex ids stay
  });
});
