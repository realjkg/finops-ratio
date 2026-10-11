import { describe, expect, it } from 'vitest';
import { FORBIDDEN_KEYS, parseJsonSafe, sanitizeJson, utf8Length, type SanitizeLimits } from './jsonSafe';

const L: SanitizeLimits = { maxBytes: 1000, maxDepth: 4, maxNodes: 50, maxStringBytes: 100, maxKeyBytes: 16 };

describe('utf8Length', () => {
  it('matches TextEncoder for ASCII, 2-, 3- and 4-byte characters and lone surrogates', () => {
    const samples = ['', 'abc', 'é', '€', '😀', 'a😀b€é', '\ud800', '\udc00', 'x\ud83dy', '\u0000', 'a'.repeat(1000) + '€'];
    for (const s of samples) expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe('parseJsonSafe', () => {
  it('parses within the limits into null-prototype objects', () => {
    const r = parseJsonSafe('{"a":{"b":[1,"x",null,true]}}', L);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = r.value as { a: object };
      expect(Object.getPrototypeOf(v)).toBeNull();
      expect(Object.getPrototypeOf(v.a)).toBeNull();
    }
  });

  it('reports a closed code for each refusal and never an engine message', () => {
    const code = (t: string, l = L): string => {
      const r = parseJsonSafe(t, l);
      return r.ok ? 'ok' : r.code;
    };
    expect(code('{')).toBe('syntax');
    expect(code('')).toBe('syntax');
    expect(code(' '.repeat(1001))).toBe('size');
    expect(code('[[[[[1]]]]]')).toBe('depth');
    expect(code('[[[[1]]]]')).toBe('ok');
    expect(code(JSON.stringify(Array.from({ length: 60 }, () => 1)))).toBe('nodes');
    expect(code(JSON.stringify('x'.repeat(101)))).toBe('string');
    expect(code(JSON.stringify({ ['k'.repeat(17)]: 1 }))).toBe('key');
    for (const k of FORBIDDEN_KEYS) expect(code(JSON.stringify({ [k]: 1 }).replace(`"${k}"`, `"${k}"`))).toBe('forbidden_key');
    expect(code('1e999')).toBe('type');
  });

  it('is not fooled by brackets inside strings when measuring depth', () => {
    expect(parseJsonSafe(JSON.stringify({ a: '[[[[[[[[[[' }), L).ok).toBe(true);
    expect(parseJsonSafe('{"a":"\\"[[[[[[[["}', L).ok).toBe(true);
  });

  it('keeps __proto__ out of the prototype chain even though JSON.parse makes it an own key', () => {
    const r = parseJsonSafe('{"__proto__":{"polluted":true}}', L);
    expect(r).toEqual({ ok: false, code: 'forbidden_key' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts exactly the byte limit', () => {
    const body = JSON.stringify('x'.repeat(98)); // 100 bytes with quotes
    expect(parseJsonSafe(body, { ...L, maxBytes: 100 }).ok).toBe(true);
    expect(parseJsonSafe(body, { ...L, maxBytes: 99 })).toEqual({ ok: false, code: 'size' });
  });
});

describe('sanitizeJson', () => {
  it('copies: the result shares nothing with the input', () => {
    const input = { a: [1, { b: 2 }] };
    const r = sanitizeJson(input, L);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(input);
      expect(r.value).not.toBe(input);
      (input.a[1] as { b: number }).b = 99;
      expect((r.value as { a: [number, { b: number }] }).a[1].b).toBe(2);
    }
  });

  it('refuses non-JSON values with the type code', () => {
    const cases: unknown[] = [undefined, () => 1, Symbol('s'), BigInt(1), NaN, Infinity, new Date(0), new Map(), new Set(), new Uint8Array(2), Object.create({}), /x/];
    for (const c of cases) expect(sanitizeJson({ v: c }, L), String(c)).toEqual({ ok: false, code: 'type' });
  });

  it('refuses accessors and sparse arrays', () => {
    expect(sanitizeJson({ get a() { return 1; } }, L)).toEqual({ ok: false, code: 'type' });
    expect(sanitizeJson(new Array(3), L)).toEqual({ ok: false, code: 'type' });
  });

  it('ignores symbol keys and non-enumerable properties', () => {
    const o: Record<string | symbol, unknown> = { a: 1 };
    o[Symbol('s')] = 2;
    Object.defineProperty(o, 'hidden', { value: 3, enumerable: false });
    const r = sanitizeJson(o, L);
    expect(r.ok && r.value).toEqual({ a: 1 });
  });

  it('counts a value at the node cap and refuses one more', () => {
    expect(sanitizeJson(Array.from({ length: 49 }, () => 0), L).ok).toBe(true); // 1 array + 49 elements = 50
    expect(sanitizeJson(Array.from({ length: 50 }, () => 0), L)).toEqual({ ok: false, code: 'nodes' });
  });

  it('accepts nesting at the depth cap and refuses one more, for objects and arrays alike', () => {
    expect(sanitizeJson([[[[1]]]], L).ok).toBe(true);
    expect(sanitizeJson([[[[[1]]]]], L)).toEqual({ ok: false, code: 'depth' });
    expect(sanitizeJson({ a: { a: { a: { a: 1 } } } }, L).ok).toBe(true);
    expect(sanitizeJson({ a: { a: { a: { a: { a: 1 } } } } }, L)).toEqual({ ok: false, code: 'depth' });
  });
});
