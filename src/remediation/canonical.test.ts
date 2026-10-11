// Canonical JSON and digests: deterministic, and strict about what they will serialize.
import { describe, expect, it } from 'vitest';
import { CanonicalError, canonicalJson, digestOf, sha256Hex } from './canonical';

describe('canonicalJson', () => {
  it('sorts_keys_at_every_depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}');
  });
  it('is_independent_of_insertion_order', () => {
    expect(digestOf({ x: 1, y: 2 })).toBe(digestOf({ y: 2, x: 1 }));
  });
  it('tags_bigint_so_it_cannot_collide_with_a_string_or_number', () => {
    const big = canonicalJson(BigInt(5));
    expect(big).not.toBe(canonicalJson('5'));
    expect(big).not.toBe(canonicalJson(5));
    expect(canonicalJson({ v: BigInt(5) })).not.toBe(canonicalJson({ v: '5' }));
  });
  it('accepts_null_prototype_objects_and_frozen_arrays', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.k = Object.freeze([1, 'a', null, true]);
    expect(canonicalJson(o)).toBe('{"k":[1,"a",null,true]}');
  });
  it('refuses_what_it_cannot_serialize_deterministically', () => {
    class Box { v = 1; }
    for (const bad of [undefined, () => 1, Symbol('s'), Number.NaN, Infinity, -Infinity, new Box(), new Date(0), new Map(), { a: undefined }]) {
      expect(() => canonicalJson(bad), String(bad)).toThrow(CanonicalError);
    }
  });
  it('refuses_deep_nesting_and_cycles', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 9; i += 1) deep = { d: deep };
    expect(() => canonicalJson(deep)).toThrow(CanonicalError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(CanonicalError);
    let ok: unknown = 1;
    for (let i = 0; i < 8; i += 1) ok = { d: ok };
    expect(() => canonicalJson(ok)).not.toThrow(); // 8 levels is the cap
  });
  it('error_text_is_fixed', () => {
    expect(() => canonicalJson(Symbol('secret-value'))).toThrow('Value cannot be canonicalized');
  });
  it('sha256_matches_a_known_vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
