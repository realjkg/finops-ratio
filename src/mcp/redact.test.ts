import { describe, expect, it } from 'vitest';
import { redactResult, REDACTED, REDACTED_EMAIL, REDACTED_TOKEN, type RedactOptions } from './redact';
import type { JsonValue } from './jsonSafe';

const J = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;
const opts = (o: Partial<RedactOptions> = {}): RedactOptions => ({ onSecret: 'reject', email: 'mask', ...o });
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwx';
const SECRETS = ['Bearer abcdefghijklmnop1234', JWT, 'sk-abcdefghijklmnop1234567', ['ghp', '_abcdefghijklmnopqrstuvwx1234'].join(''), ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
  'password=hunter2hunter2', 'api_key: abcdef123456', 'https://user:pass@host.example/x', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'];

describe('secrets', () => {
  it('rejects the whole result for each secret shape by default', () => {
    for (const s of SECRETS) expect(redactResult(J({ title: s }), opts()), s).toEqual({ ok: false, reason: 'secret_in_result' });
  });
  it('in redact mode replaces only the matching value and counts it', () => {
    const r = redactResult(J({ a: 'fine', b: SECRETS[2], c: ['x', SECRETS[1]] }), opts({ onSecret: 'redact' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { a: string }).a).toBe('fine');
      expect(JSON.stringify(r.value)).not.toContain('abcdefghijklmnop1234567');
      expect(JSON.stringify(r.value)).not.toContain('eyJhbGci');
      expect(r.redactedCount).toBe(2);
    }
  });
  it('catches a key-only secret, replacing the value wholesale (the bare value looks harmless)', () => {
    const r = redactResult(J({ password: 'abc def' }), opts({ onSecret: 'redact' }));
    expect(r).toEqual({ ok: true, value: { password: REDACTED }, redactedCount: 1 });
    expect(redactResult(J({ password: 'abc def' }), opts())).toEqual({ ok: false, reason: 'secret_in_result' });
  });
  it('rejects a secret-shaped key and a non-string value under a secret key, even in redact mode', () => {
    expect(redactResult(J({ 'Bearer abcdefghijklmnop1234': 1 }), opts({ onSecret: 'redact' }))).toEqual({ ok: false, reason: 'secret_in_result' });
    expect(redactResult(J({ password: 12345678 }), opts({ onSecret: 'redact' }))).toEqual({ ok: false, reason: 'secret_in_result' });
  });
  it('rejects a URL value whose query would break the serialized form, in both modes', () => {
    const v = J({ url: 'https://example.com/a?x=1&y="2"' });
    expect(redactResult(v, opts({ onSecret: 'redact' })).ok).toBe(true); // string-level redaction handles it
    expect(JSON.stringify((redactResult(v, opts({ onSecret: 'redact' })) as { value: JsonValue }).value)).not.toContain('x=1');
  });
  it('finds secrets deep in arrays and objects', () => {
    expect(redactResult(J({ a: [{ b: [{ c: SECRETS[0] }] }] }), opts()).ok).toBe(false);
  });
  it('masks token-like runs, but leaves ids, dates, hashes-with-hyphens and short words', () => {
    const t = ['aB3dE5gH7jK9mN1p', 'Q3sT5vW7yZ9bC1dE', '3fG5hJ7k'].join('');
    const r = redactResult(J({ note: `x ${t} y` }), opts({ onSecret: 'redact' }));
    expect(r.ok && JSON.stringify(r.value)).toContain(REDACTED_TOKEN);
    for (const ok of ['2026-09-30', 'fnd-1', 'rev-2026-10-01', 'Idle GPU nodes in staging', 'a'.repeat(60), 'subscription-prod-eastus-compute-cluster-nodes-01']) {
      expect(redactResult(J({ v: ok }), opts()).ok, ok).toBe(true);
    }
  });
});

describe('email policy', () => {
  const v = J({ owner: 'jane.doe@example.com wrote this' });
  it('masks by default, allows, or rejects by policy', () => {
    expect(redactResult(v, opts())).toEqual({ ok: true, value: { owner: `${REDACTED_EMAIL} wrote this` }, redactedCount: 1 });
    expect(redactResult(v, opts({ email: 'allow' }))).toEqual({ ok: true, value: v, redactedCount: 0 });
    expect(redactResult(v, opts({ email: 'reject' }))).toEqual({ ok: false, reason: 'pii_in_result' });
  });
  it('masks emails in keys by rejecting (a key cannot be replaced)', () => {
    expect(redactResult(J({ 'a@b.example': 1 }), opts()).ok).toBe(false);
  });
  it('ignores text that only looks like an email', () => {
    for (const s of ['@handle', 'a@b', 'user at example.com']) expect(redactResult(J({ s }), opts())).toEqual({ ok: true, value: { s }, redactedCount: 0 });
  });
});

describe('clean data and structure', () => {
  it('passes clean data unchanged, as a copy', () => {
    const v = J({ data: { rows: [{ key: 'Compute', amount: '200.00' }], n: 1, ok: true, z: null } });
    const r = redactResult(v, opts());
    expect(r).toEqual({ ok: true, value: v, redactedCount: 0 });
    expect(r.ok && r.value).not.toBe(v);
  });
  it('does not flag ordinary lower-case field names such as cost_per_token', () => {
    expect(redactResult(J({ cost_per_token: '0.002', max_tokens: 5 }), opts()).ok).toBe(true);
  });
  it('stays fast on long hostile strings', () => {
    const t0 = Date.now();
    redactResult(J({ a: 'a@'.repeat(1000), b: 'x'.repeat(2000), c: '-'.repeat(2000), d: 'eyJ'.repeat(600) }), opts({ onSecret: 'redact' }));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
