import { describe, expect, it } from 'vitest';
import { compileSchema, SchemaLintError, SCHEMA_MAX_DEPTH, SCHEMA_MAX_ITEMS, SCHEMA_MAX_PROPERTIES, SCHEMA_MAX_STRING, type Schema } from './schema';

const lint = (schema: unknown, opts = {}): string => {
  try {
    compileSchema(schema as Schema, opts);
    return 'ok';
  } catch (e) {
    return e instanceof SchemaLintError ? e.code : `other:${String(e)}`;
  }
};
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });

describe('schema lint (startup failures)', () => {
  it('refuses an unbounded string, array, number and object', () => {
    expect(lint({ type: 'string' })).toBe('string_unbounded');
    expect(lint({ type: 'string', maxLength: SCHEMA_MAX_STRING + 1 })).toBe('string_unbounded');
    expect(lint({ type: 'string', maxLength: -1 })).toBe('string_unbounded');
    expect(lint({ type: 'array', items: { type: 'boolean' } })).toBe('array_unbounded');
    expect(lint({ type: 'array', items: { type: 'boolean' }, maxItems: SCHEMA_MAX_ITEMS + 1 })).toBe('array_unbounded');
    expect(lint({ type: 'integer' })).toBe('number_unbounded');
    expect(lint({ type: 'number', minimum: 0 })).toBe('number_unbounded');
    expect(lint({ type: 'number', minimum: 5, maximum: 1 })).toBe('number_unbounded');
    expect(lint({ type: 'integer', minimum: 0, maximum: Infinity })).toBe('number_unbounded');
    expect(lint({ type: 'object', additionalProperties: true, maxProperties: 4 })).toBe('object_open');
  });

  it('allows an open object only when asked, and only with maxProperties', () => {
    const open = { type: 'object', additionalProperties: true, maxProperties: 4 };
    expect(lint(open, { allowOpen: true })).toBe('ok');
    expect(lint({ type: 'object', additionalProperties: true }, { allowOpen: true })).toBe('object_unbounded');
    expect(lint({ ...open, maxProperties: SCHEMA_MAX_PROPERTIES + 1 }, { allowOpen: true })).toBe('object_unbounded');
  });

  it('refuses bad patterns, empty enums, contradictory bounds and dangling required names', () => {
    expect(lint({ type: 'string', maxLength: 5, pattern: '(' })).toBe('pattern_invalid');
    expect(lint({ type: 'string', pattern: '^a$' })).toBe('string_unbounded');
    expect(lint({ type: 'string', enum: [] })).toBe('enum');
    expect(lint({ type: 'string', enum: ['a', 1] })).toBe('enum');
    expect(lint({ type: 'string', minLength: 5, maxLength: 4 })).toBe('string_bounds');
    expect(lint({ type: 'array', items: { type: 'boolean' }, minItems: 3, maxItems: 2 })).toBe('array_bounds');
    expect(lint(obj({ a: { type: 'boolean' } }, ['b']))).toBe('required_unknown');
  });

  it('refuses unsupported types and over-deep or over-wide schemas', () => {
    expect(lint({ type: 'null' })).toBe('unsupported_type');
    expect(lint({})).toBe('unsupported_type');
    let deep: Schema = { type: 'boolean' };
    for (let i = 0; i <= SCHEMA_MAX_DEPTH; i += 1) deep = { type: 'array', items: deep, maxItems: 1 };
    expect(lint(deep)).toBe('depth');
    const wide = Object.fromEntries(Array.from({ length: SCHEMA_MAX_PROPERTIES + 1 }, (_, i) => [`p${i}`, { type: 'boolean' }])) as Record<string, Schema>;
    expect(lint(obj(wide))).toBe('too_many_properties');
  });
});

describe('validation rules', () => {
  const v = compileSchema(obj({
    name: { type: 'string', minLength: 2, maxLength: 5 },
    kind: { type: 'string', enum: ['a', 'b'] },
    code: { type: 'string', maxLength: 4, pattern: '^[A-Z]{2}[0-9]{2}$' },
    n: { type: 'integer', minimum: 1, maximum: 10 },
    x: { type: 'number', minimum: 0, maximum: 1 },
    flag: { type: 'boolean' },
    list: { type: 'array', maxItems: 2, minItems: 1, items: { type: 'integer', minimum: 0, maximum: 9 } },
    nested: obj({ inner: { type: 'string', enum: ['ok'] } }, ['inner']),
  }, ['name']));
  const rule = (value: unknown): string => {
    const r = v(value);
    return r.ok ? 'ok' : `${r.rule}@${r.path.join('.')}`;
  };

  it('accepts a valid value and the boundaries', () => {
    expect(rule({ name: 'ab' })).toBe('ok');
    expect(rule({ name: 'abcde', kind: 'b', code: 'AB12', n: 1, x: 0, flag: false, list: [0], nested: { inner: 'ok' } })).toBe('ok');
    expect(rule({ name: 'ab', n: 10, x: 1, list: [9, 9] })).toBe('ok');
  });

  it('reports one closed rule and the declared path for each violation', () => {
    expect(rule('x')).toBe('type@');
    expect(rule([])).toBe('type@');
    expect(rule(null)).toBe('type@');
    expect(rule({})).toBe('required@name');
    expect(rule({ name: 'a' })).toBe('min_length@name');
    expect(rule({ name: 'abcdef' })).toBe('max_length@name');
    expect(rule({ name: 1 })).toBe('type@name');
    expect(rule({ name: 'ab', kind: 'c' })).toBe('enum@kind');
    expect(rule({ name: 'ab', code: 'ab12' })).toBe('pattern@code');
    expect(rule({ name: 'ab', n: 0 })).toBe('minimum@n');
    expect(rule({ name: 'ab', n: 11 })).toBe('maximum@n');
    expect(rule({ name: 'ab', n: 1.5 })).toBe('type@n');
    expect(rule({ name: 'ab', n: '1' })).toBe('type@n');
    expect(rule({ name: 'ab', x: -0.01 })).toBe('minimum@x');
    expect(rule({ name: 'ab', x: 1.01 })).toBe('maximum@x');
    expect(rule({ name: 'ab', x: NaN })).toBe('type@x');
    expect(rule({ name: 'ab', x: Infinity })).toBe('type@x');
    expect(rule({ name: 'ab', flag: 'true' })).toBe('type@flag');
    expect(rule({ name: 'ab', list: [] })).toBe('min_items@list');
    expect(rule({ name: 'ab', list: [1, 2, 3] })).toBe('max_items@list');
    expect(rule({ name: 'ab', list: [10] })).toBe('maximum@list');
    expect(rule({ name: 'ab', nested: {} })).toBe('required@nested.inner');
    expect(rule({ name: 'ab', nested: { inner: 'no' } })).toBe('enum@nested.inner');
  });

  it('refuses unknown properties without reporting their names', () => {
    const r = v({ name: 'ab', SENTINEL_KEY: 1 });
    expect(r).toEqual({ ok: false, rule: 'unknown_property', path: [] });
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
    expect(v({ name: 'ab', nested: { inner: 'ok', extra: 1 } })).toEqual({ ok: false, rule: 'unknown_property', path: ['nested'] });
  });

  it('does not let prototype names stand in for declared or required properties', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const value = Object.create(null) as Record<string, unknown>;
      value.name = 'ab';
      Object.defineProperty(value, key, { value: 1, enumerable: true, configurable: true });
      expect(v(value), key).toEqual({ ok: false, rule: 'unknown_property', path: [] });
    }
    expect(v(Object.create({ name: 'ab' }))).toEqual({ ok: false, rule: 'required', path: ['name'] }); // inherited is not own
  });

  it('compiles a pattern once and tests it without state across calls', () => {
    const p = compileSchema({ type: 'string', maxLength: 3, pattern: '^[a-c]+$' });
    for (let i = 0; i < 5; i += 1) expect(p('abc')).toEqual({ ok: true });
  });
});
