// Strict parameter schema for remediation actions. Trust boundary: action parameters are
// untrusted input. Validation is deny by default: only declared keys are read, unknown keys
// (including __proto__, constructor, prototype, symbols and non-enumerable names) are refused,
// accessors are refused (a getter could answer differently on a second read), every string has
// a length cap and an anchored pattern, every number is a bounded safe integer, every list has
// a cap. The output is a null-prototype, frozen copy of the declared keys only. Errors are
// fixed codes; they never echo input.
import { LIMITS } from './types';

export type FieldSpec =
  | { readonly kind: 'string'; readonly maxLen: number; readonly pattern: RegExp; readonly optional?: boolean }
  | { readonly kind: 'int'; readonly min: number; readonly max: number; readonly optional?: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly optional?: boolean }
  | { readonly kind: 'bool'; readonly optional?: boolean }
  | {
      readonly kind: 'idList';
      readonly maxItems: number;
      readonly itemMaxLen: number;
      readonly itemPattern: RegExp;
      readonly optional?: boolean;
    };
export type ParamSchema = Readonly<Record<string, FieldSpec>>;

export type ParamErrorCode =
  | 'PARAMS_NOT_OBJECT' | 'PARAMS_TOO_MANY_KEYS' | 'PARAMS_UNKNOWN_KEY' | 'PARAMS_MISSING' | 'PARAMS_TYPE'
  | 'PARAMS_RANGE' | 'PARAMS_TOO_LONG' | 'PARAMS_FORMAT' | 'PARAMS_ENUM' | 'PARAMS_TOO_MANY_ITEMS'
  | 'PARAMS_EMPTY_LIST' | 'PARAMS_DUPLICATE_ITEM' | 'PARAMS_ACCESSOR' | 'PARAMS_INVALID';

export const PARAM_ERROR_TEXT: Readonly<Record<ParamErrorCode, string>> = Object.freeze({
  PARAMS_NOT_OBJECT: 'Parameters must be a plain object',
  PARAMS_TOO_MANY_KEYS: 'Too many parameters',
  PARAMS_UNKNOWN_KEY: 'Unknown parameter',
  PARAMS_MISSING: 'Required parameter missing',
  PARAMS_TYPE: 'Parameter has the wrong type',
  PARAMS_RANGE: 'Parameter out of range',
  PARAMS_TOO_LONG: 'Parameter too long',
  PARAMS_FORMAT: 'Parameter has an invalid format',
  PARAMS_ENUM: 'Parameter is not an allowed value',
  PARAMS_TOO_MANY_ITEMS: 'Too many list items',
  PARAMS_EMPTY_LIST: 'List must not be empty',
  PARAMS_DUPLICATE_ITEM: 'Duplicate list item',
  PARAMS_ACCESSOR: 'Parameter must be a plain data value',
  PARAMS_INVALID: 'Parameters are inconsistent',
});

export type ParamsResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: ParamErrorCode; /** A schema field name, never caller input. */ readonly field?: string };

const fail = (code: ParamErrorCode, field?: string): ParamsResult => ({ ok: false, code, ...(field === undefined ? {} : { field }) });
const FIELD_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A data property's value, or a marker when the property is an accessor or missing. */
function dataValue(o: object, key: string | number): { found: true; value: unknown } | { found: false } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && 'value' in d ? { found: true, value: d.value } : { found: false };
}

type Checked = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: ParamErrorCode };

function checkIdList(spec: Extract<FieldSpec, { kind: 'idList' }>, v: unknown): Checked {
  if (!Array.isArray(v)) return { ok: false, code: 'PARAMS_TYPE' };
  const n = v.length; // read once
  if (n > spec.maxItems) return { ok: false, code: 'PARAMS_TOO_MANY_ITEMS' };
  if (n === 0) return { ok: false, code: 'PARAMS_EMPTY_LIST' };
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const item = dataValue(v, i);
    if (!item.found || typeof item.value !== 'string') return { ok: false, code: 'PARAMS_TYPE' }; // sparse hole, accessor or non-string
    if (item.value.length > spec.itemMaxLen) return { ok: false, code: 'PARAMS_TOO_LONG' };
    if (!spec.itemPattern.test(item.value)) return { ok: false, code: 'PARAMS_FORMAT' };
    if (seen.has(item.value)) return { ok: false, code: 'PARAMS_DUPLICATE_ITEM' };
    seen.add(item.value);
    out.push(item.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function checkField(spec: FieldSpec, v: unknown): Checked {
  switch (spec.kind) {
    case 'string':
      if (typeof v !== 'string') return { ok: false, code: 'PARAMS_TYPE' };
      if (v.length > spec.maxLen) return { ok: false, code: 'PARAMS_TOO_LONG' };
      if (v.length === 0 || !spec.pattern.test(v)) return { ok: false, code: 'PARAMS_FORMAT' };
      return { ok: true, value: v };
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, code: 'PARAMS_TYPE' };
      return v < spec.min || v > spec.max ? { ok: false, code: 'PARAMS_RANGE' } : { ok: true, value: v };
    case 'enum':
      if (typeof v !== 'string') return { ok: false, code: 'PARAMS_TYPE' };
      return spec.values.includes(v) ? { ok: true, value: v } : { ok: false, code: 'PARAMS_ENUM' };
    case 'bool':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, code: 'PARAMS_TYPE' };
    case 'idList':
      return checkIdList(spec, v);
  }
}

/** Validate untrusted params against a schema. Never throws. */
export function validateParams(schema: ParamSchema, input: unknown): ParamsResult {
  try {
    if (!isPlainObject(input)) return fail('PARAMS_NOT_OBJECT');
    if (Object.getOwnPropertySymbols(input).length > 0) return fail('PARAMS_UNKNOWN_KEY');
    const names = Object.getOwnPropertyNames(input); // includes non-enumerable names on purpose
    if (names.length > LIMITS.maxParamKeys) return fail('PARAMS_TOO_MANY_KEYS');
    for (const k of names) if (!Object.hasOwn(schema, k)) return fail('PARAMS_UNKNOWN_KEY');
    const out: Record<string, unknown> = Object.create(null);
    for (const name of Object.keys(schema)) {
      const spec = schema[name];
      if (!Object.hasOwn(input, name)) {
        if (spec.optional) continue;
        return fail('PARAMS_MISSING', name);
      }
      const got = dataValue(input, name);
      if (!got.found) return fail('PARAMS_ACCESSOR', name);
      const checked = checkField(spec, got.value);
      if (!checked.ok) return fail(checked.code, name);
      out[name] = checked.value;
    }
    return { ok: true, value: Object.freeze(out) };
  } catch {
    return fail('PARAMS_NOT_OBJECT'); // a throwing Proxy or getter is not a plain object
  }
}

export class SchemaDefinitionError extends Error {
  constructor() {
    super('Parameter schema definition is invalid');
    this.name = 'SchemaDefinitionError';
  }
}

const isStatelessPattern = (p: unknown): p is RegExp => p instanceof RegExp && !p.global && !p.sticky;
const isBoundedInt = (n: unknown, lo: number, hi: number): n is number => Number.isSafeInteger(n) && (n as number) >= lo && (n as number) <= hi;

/** Build-time check of a schema definition; returns a frozen null-prototype copy or throws. */
export function freezeSchema(schema: unknown): ParamSchema {
  if (!isPlainObject(schema)) throw new SchemaDefinitionError();
  const names = Object.keys(schema);
  if (names.length === 0 || names.length > LIMITS.maxParamKeys) throw new SchemaDefinitionError();
  const out: Record<string, FieldSpec> = Object.create(null);
  for (const name of names) {
    if (!FIELD_NAME.test(name) || RESERVED_NAMES.has(name)) throw new SchemaDefinitionError();
    const raw = (schema as Record<string, unknown>)[name];
    if (!isPlainObject(raw)) throw new SchemaDefinitionError();
    const s = raw as Record<string, unknown>;
    if (s.optional !== undefined && typeof s.optional !== 'boolean') throw new SchemaDefinitionError();
    switch (s.kind) {
      case 'string':
        if (!isBoundedInt(s.maxLen, 1, 256) || !isStatelessPattern(s.pattern)) throw new SchemaDefinitionError();
        break;
      case 'int':
        if (!Number.isSafeInteger(s.min) || !Number.isSafeInteger(s.max) || (s.min as number) > (s.max as number)) throw new SchemaDefinitionError();
        break;
      case 'enum':
        if (!Array.isArray(s.values) || s.values.length === 0 || s.values.length > 16 ||
            !s.values.every((x: unknown) => typeof x === 'string' && x.length >= 1 && x.length <= 32) ||
            new Set(s.values).size !== s.values.length) throw new SchemaDefinitionError();
        break;
      case 'bool':
        break;
      case 'idList':
        if (!isBoundedInt(s.maxItems, 1, LIMITS.maxResourcesHard) || !isBoundedInt(s.itemMaxLen, 1, LIMITS.maxResourceIdLen) ||
            !isStatelessPattern(s.itemPattern)) throw new SchemaDefinitionError();
        break;
      default:
        throw new SchemaDefinitionError();
    }
    out[name] = Object.freeze({ ...(s as unknown as FieldSpec), ...(Array.isArray(s.values) ? { values: Object.freeze([...(s.values as string[])]) } : {}) }) as FieldSpec;
  }
  return Object.freeze(out);
}
