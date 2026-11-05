import { describe, expect, it } from 'vitest';
import { arr, byKind, C, isContentDigest, isIsoDate, isIsoInstant, isMoney, isPseudonymousRef, isQuantity, obj, opt, req, sumsExactly, validator } from './validate';

describe('exact decimal strings', () => {
  it('accepts plain decimal strings and refuses numbers, exponents, blanks and partial forms', () => {
    for (const ok of ['0', '12', '-3.50', '0.000000001', '123456789012345678901234567890.123456789']) expect(isMoney(ok)).toBe(true);
    for (const bad of [1, 1.5, '1e3', '1.', '.5', ' 1', '1 ', '', '+1', 'NaN', 'Infinity', '0x10', '1,000', null, undefined]) expect(isMoney(bad)).toBe(false);
  });
  it('quantities are never negative', () => {
    expect(isQuantity('0')).toBe(true);
    expect(isQuantity('-1')).toBe(false);
    expect(isQuantity('-0')).toBe(false);
  });
  it('sums exactly without float drift', () => {
    expect(sumsExactly(['0.1', '0.2'], '0', '0.3')).toBe(true);
    expect(sumsExactly(['0.1', '0.2'], '0.0000000001', '0.3')).toBe(false);
    expect(sumsExactly([], '5.00', '5')).toBe(true);
  });
});

describe('dates and instants', () => {
  it('dates follow the calendar', () => {
    for (const ok of ['2024-02-29', '2000-02-29', '2026-12-31']) expect(isIsoDate(ok)).toBe(true);
    for (const bad of ['2023-02-29', '1900-02-29', '2026-13-01', '2026-04-31', '2026-1-01', '2026-01-01T00:00:00Z', 20260101]) expect(isIsoDate(bad)).toBe(false);
  });
  it('instants are UTC with a Z; offsets, 24:00 and leap seconds are refused', () => {
    for (const ok of ['2026-11-05T10:00:00Z', '2026-11-05T23:59:59.123456789Z']) expect(isIsoInstant(ok)).toBe(true);
    for (const bad of ['2026-11-05T10:00:00+00:00', '2026-11-05T24:00:00Z', '2026-11-05T23:59:60Z', '2026-11-05 10:00:00Z', '2026-02-30T00:00:00Z']) expect(isIsoInstant(bad)).toBe(false);
  });
});

describe('pseudonymous references and content digests', () => {
  const hex = 'a'.repeat(64);
  it('a human ref is a keyed HMAC under a named key, never an email or a bare hash', () => {
    expect(isPseudonymousRef(`ps1:k2026-01:${hex}`)).toBe(true);
    for (const bad of ['alice@example.test', hex, `ps1:K:${hex}`, `ps1:k1:${hex.slice(1)}`, `ps2:k1:${hex}`]) expect(isPseudonymousRef(bad)).toBe(false);
  });
  it('content digests are keyed (hm1), not plain sha256', () => {
    expect(isContentDigest(`hm1:k1:${hex}`)).toBe(true);
    expect(isContentDigest(hex)).toBe(false);
  });
});

describe('strict objects and problem text', () => {
  const v = validator<{ a: string; b?: string[] }>(obj({ a: req(C.money), b: opt(arr(C.id, 1, 2)) }));
  it('refuses unknown keys, so content cannot ride along', () => {
    expect(v({ a: '1', prompt: 'hello' })).toEqual({ ok: false, problems: ['$.prompt: unknown key'] });
  });
  it('names the path and the rule, never the value', () => {
    const secret = 'sk-live-0123456789abcdef';
    const r = v({ a: secret, b: [secret, 'x', 'y'], [`${secret} key`]: 1 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.ok ? [] : r.problems).toEqual(['$: unknown key (not printed)', '$.a: exact decimal string', '$.b: array of 1 to 2 items']);
  });
  it('reports missing keys, non-objects, arrays and class instances', () => {
    expect(v({})).toEqual({ ok: false, problems: ['$.a: missing'] });
    for (const bad of [null, [], 'x', new Map()]) expect(v(bad)).toEqual({ ok: false, problems: ['$: object'] });
  });
  it('a JSON __proto__ key is an unknown key, not a prototype change', () => {
    expect(v(JSON.parse('{"a":"1","__proto__":{"b":["x"]}}'))).toEqual({ ok: false, problems: ['$.__proto__: unknown key'] });
  });
  it('discriminated unions accept each variant strictly', () => {
    const u = validator(byKind({ x: { n: req(C.count) }, y: {} }));
    expect(u({ kind: 'x', n: 1 }).ok).toBe(true);
    expect(u({ kind: 'y' }).ok).toBe(true);
    expect(u({ kind: 'y', n: 1 })).toEqual({ ok: false, problems: ['$.n: unknown key'] });
    expect(u({ kind: 'z' })).toEqual({ ok: false, problems: ['$.kind: one of x|y'] });
  });
});
