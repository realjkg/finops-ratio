// Parameter schema abuse: unknown keys, prototype keys, oversized strings, wrong types, accessors,
// proxies, sparse and oversized lists. Failures are fixed codes that never echo input.
import { describe, expect, it } from 'vitest';
import { PARAM_ERROR_TEXT, SchemaDefinitionError, freezeSchema, validateParams, type ParamsResult } from './schema';
import { ACTION_REGISTRY } from './registry';

const stop = ACTION_REGISTRY.get('stop_idle_dev_instance')!.params;
const resize = ACTION_REGISTRY.get('resize_down')!.params;
const sched = ACTION_REGISTRY.get('schedule_on_off')!.params;
const good = () => ({ instanceIds: ['i-aaa'], idleDays: 14 });
const code = (r: ParamsResult) => (r.ok ? 'ok' : r.code);

describe('validateParams: shape and keys', () => {
  it('returns_a_frozen_null_prototype_copy', () => {
    const input = good();
    const r = validateParams(stop, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.getPrototypeOf(r.value)).toBeNull();
    expect(Object.isFrozen(r.value)).toBe(true);
    input.instanceIds.push('i-later');
    expect(r.value.instanceIds).toEqual(['i-aaa']);
  });
  it('refuses_non_objects_and_class_instances', () => {
    for (const bad of [null, undefined, 'x', 5, [], [good()], () => 1]) expect(code(validateParams(stop, bad))).toBe('PARAMS_NOT_OBJECT');
    class P { instanceIds = ['i-a']; idleDays = 1; }
    expect(code(validateParams(stop, new P()))).toBe('PARAMS_NOT_OBJECT');
  });
  it('a_throwing_proxy_is_refused_without_throwing', () => {
    const evil = new Proxy({}, { getPrototypeOf() { throw new Error('boom'); } });
    expect(code(validateParams(stop, evil))).toBe('PARAMS_NOT_OBJECT');
  });
  it('refuses_unknown_and_prototype_keys', () => {
    expect(code(validateParams(stop, { ...good(), extra: 1 }))).toBe('PARAMS_UNKNOWN_KEY');
    expect(code(validateParams(stop, JSON.parse('{"instanceIds":["i-a"],"idleDays":7,"__proto__":{"admin":true}}')))).toBe('PARAMS_UNKNOWN_KEY');
    expect(code(validateParams(stop, { ...good(), constructor: 'x' }))).toBe('PARAMS_UNKNOWN_KEY');
    expect(code(validateParams(stop, { ...good(), [Symbol('s')]: 1 }))).toBe('PARAMS_UNKNOWN_KEY');
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
  it('refuses_non_enumerable_extras_and_accessors', () => {
    const hidden = good();
    Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
    expect(code(validateParams(stop, hidden))).toBe('PARAMS_UNKNOWN_KEY');
    let reads = 0;
    const o = { instanceIds: ['i-a'] } as Record<string, unknown>;
    Object.defineProperty(o, 'idleDays', { enumerable: true, get() { reads += 1; return 7; } });
    expect(code(validateParams(stop, o))).toBe('PARAMS_ACCESSOR');
    expect(reads).toBe(0);
  });
  it('missing_required_field_is_named_from_the_schema', () => {
    expect(validateParams(stop, { instanceIds: ['i-a'] })).toEqual({ ok: false, code: 'PARAMS_MISSING', field: 'idleDays' });
  });
  it('key_cap_is_16_and_17_is_refused', () => {
    const fields: Record<string, unknown> = {};
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 16; i += 1) { fields[`f${i}`] = { kind: 'bool' }; input[`f${i}`] = true; }
    expect(code(validateParams(freezeSchema(fields), input))).toBe('ok');
    input.f16 = true;
    expect(code(validateParams(freezeSchema(fields), input))).toBe('PARAMS_TOO_MANY_KEYS');
  });
});

describe('validateParams: values', () => {
  const rz = (resourceId: unknown) => ({ resourceId, fromSize: 'm5.2xlarge', toSize: 'm5.xlarge' });
  it('string_length_cap_boundary', () => {
    expect(code(validateParams(resize, rz('a'.repeat(128))))).toBe('ok');
    expect(code(validateParams(resize, rz('a'.repeat(129))))).toBe('PARAMS_TOO_LONG');
    expect(code(validateParams(resize, rz('a'.repeat(5_000_000))))).toBe('PARAMS_TOO_LONG');
  });
  it('pattern_violations_and_non_strings', () => {
    for (const bad of ['', ' lead', 'a b', 'a\nb', '-lead', '../x;', 'a\u0000b', '日本', '<script>']) expect(code(validateParams(resize, rz(bad))), bad).toBe('PARAMS_FORMAT');
    for (const bad of [5, null, undefined, {}, []]) expect(code(validateParams(resize, rz(bad)))).not.toBe('ok');
  });
  it('int_bounds_and_types', () => {
    const sc = (v: unknown) => ({ resourceIds: ['i-a'], onHourUtc: v, offHourUtc: 18, weekdaysOnly: true });
    expect(code(validateParams(sched, sc(0)))).toBe('ok');
    expect(code(validateParams(sched, sc(23)))).toBe('ok');
    expect(code(validateParams(sched, sc(-1)))).toBe('PARAMS_RANGE');
    expect(code(validateParams(sched, sc(24)))).toBe('PARAMS_RANGE');
    for (const bad of [1.5, Number.NaN, Infinity, '8', null, true, 2 ** 53, BigInt(8)]) expect(code(validateParams(sched, sc(bad)))).toBe('PARAMS_TYPE');
  });
  it('enum_and_bool', () => {
    const c = ACTION_REGISTRY.get('buy_commitment')!.params;
    const mk = (over: Record<string, unknown>) => ({ scopeId: 'a1', commitmentKind: 'compute_savings_plan', term: '1y', payment: 'no_upfront', monthlyCommitMinor: 1, ...over });
    expect(code(validateParams(c, mk({})))).toBe('ok');
    for (const bad of ['5y', '1Y', 'constructor', '__proto__', '']) expect(code(validateParams(c, mk({ term: bad })))).toBe('PARAMS_ENUM');
    expect(code(validateParams(c, mk({ monthlyCommitMinor: 1_000_000_000_001 })))).toBe('PARAMS_RANGE');
    for (const bad of ['true', 1, null]) expect(code(validateParams(sched, { resourceIds: ['i-a'], onHourUtc: 1, offHourUtc: 2, weekdaysOnly: bad }))).toBe('PARAMS_TYPE');
  });
});

describe('validateParams: lists', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `i-${i}`);
  it('cap_20_ok_21_refused', () => {
    expect(code(validateParams(stop, { instanceIds: ids(20), idleDays: 7 }))).toBe('ok');
    expect(code(validateParams(stop, { instanceIds: ids(21), idleDays: 7 }))).toBe('PARAMS_TOO_MANY_ITEMS');
  });
  it('empty_duplicate_non_array_bad_items', () => {
    expect(code(validateParams(stop, { instanceIds: [], idleDays: 7 }))).toBe('PARAMS_EMPTY_LIST');
    expect(code(validateParams(stop, { instanceIds: ['i-a', 'i-a'], idleDays: 7 }))).toBe('PARAMS_DUPLICATE_ITEM');
    for (const bad of ['i-a', { 0: 'i-a', length: 1 }, null]) expect(code(validateParams(stop, { instanceIds: bad, idleDays: 7 }))).toBe('PARAMS_TYPE');
    expect(code(validateParams(stop, { instanceIds: [5], idleDays: 7 }))).toBe('PARAMS_TYPE');
    expect(code(validateParams(stop, { instanceIds: ['a'.repeat(129)], idleDays: 7 }))).toBe('PARAMS_TOO_LONG');
    expect(code(validateParams(stop, { instanceIds: ['bad id'], idleDays: 7 }))).toBe('PARAMS_FORMAT');
  });
  it('sparse_and_accessor_items_refused_and_huge_array_not_walked', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(code(validateParams(stop, { instanceIds: ['i-a', , 'i-c'], idleDays: 7 }))).toBe('PARAMS_TYPE');
    const g = ['i-a'];
    Object.defineProperty(g, 0, { get: () => 'i-b', enumerable: true });
    expect(code(validateParams(stop, { instanceIds: g, idleDays: 7 }))).toBe('PARAMS_TYPE');
    const t = Date.now();
    expect(code(validateParams(stop, { instanceIds: new Array(5_000_000), idleDays: 7 }))).toBe('PARAMS_TOO_MANY_ITEMS');
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('errors and definitions', () => {
  it('results_never_echo_input', () => {
    const evil = 'EVIL-CANARY';
    for (const a of [{ ...good(), [evil]: 1 }, { instanceIds: [evil + ' x'], idleDays: 7 }, { instanceIds: [evil], idleDays: evil }]) {
      expect(JSON.stringify(validateParams(stop, a))).not.toContain('CANARY');
    }
    expect(Object.keys(PARAM_ERROR_TEXT).length).toBe(14);
  });
  it('freezeSchema_refuses_malformed_definitions', () => {
    const ok = { kind: 'bool' };
    const bad: unknown[] = [null, [], {}, 'x', JSON.parse('{"__proto__":{"kind":"bool"}}'), { constructor: ok }, { Upper: ok }, { a: null }, { a: { kind: 'nope' } },
      { a: { kind: 'string', maxLen: 0, pattern: /x/ } }, { a: { kind: 'string', maxLen: 5, pattern: /x/g } }, { a: { kind: 'string', maxLen: 5, pattern: 'x' } },
      { a: { kind: 'int', min: 5, max: 1 } }, { a: { kind: 'enum', values: [] } }, { a: { kind: 'enum', values: ['x', 'x'] } },
      { a: { kind: 'idList', maxItems: 101, itemMaxLen: 5, itemPattern: /x/ } }, { a: { kind: 'bool', optional: 'yes' } }];
    for (const b of bad) expect(() => freezeSchema(b), JSON.stringify(b)).toThrow(SchemaDefinitionError);
    expect(() => freezeSchema({ 'Evil-Name': ok })).toThrow('Parameter schema definition is invalid');
    expect(Object.isFrozen(freezeSchema({ a: ok }))).toBe(true);
  });
});
