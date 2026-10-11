// A strict JSON Schema subset, written here so the MCP core depends on no schema
// library. Purpose: compile a schema constant into a validator, and lint the schema
// itself. Supported: object, string, integer, number, boolean, array; required;
// enum; minimum and maximum; minLength and maxLength (UTF-16 code units);
// minItems and maxItems; pattern (code-defined, string length capped). Anything
// else, and any unbounded string, array, number or open object in a tool schema, is
// refused when the schema is compiled (a startup failure, not a runtime one).
// Trust boundary: validators only read values that sanitizeJson already copied, and
// report a closed rule code plus the DECLARED property names, never the input.

export type Schema = ObjectSchema | StringSchema | IntegerSchema | NumberSchema | BooleanSchema | ArraySchema;

export interface StringSchema {
  readonly type: 'string';
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly pattern?: string;
}
export interface IntegerSchema {
  readonly type: 'integer';
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}
export interface NumberSchema {
  readonly type: 'number';
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}
export interface BooleanSchema {
  readonly type: 'boolean';
  readonly description?: string;
}
export interface ArraySchema {
  readonly type: 'array';
  readonly description?: string;
  readonly items: Schema;
  readonly minItems?: number;
  readonly maxItems?: number;
}
export interface ObjectSchema {
  readonly type: 'object';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  /** false for every tool schema. true is allowed only for protocol envelopes (allowOpen). */
  readonly additionalProperties: boolean;
  /** Required when additionalProperties is true. */
  readonly maxProperties?: number;
}

export type RuleCode =
  | 'type' | 'required' | 'unknown_property' | 'enum' | 'minimum' | 'maximum'
  | 'min_length' | 'max_length' | 'pattern' | 'min_items' | 'max_items' | 'max_properties';

export type ValidationResult = { ok: true } | { ok: false; rule: RuleCode; path: readonly string[] };
export type Validator = (value: unknown) => ValidationResult;

export interface CompileOptions {
  /** Permit additionalProperties:true (bounded by maxProperties). Never set for a tool schema. */
  allowOpen?: boolean;
}

/** Hard ceilings a schema may declare, so even a permissive schema stays bounded. */
export const SCHEMA_MAX_STRING = 2_048;
export const SCHEMA_MAX_ITEMS = 100;
export const SCHEMA_MAX_PROPERTIES = 32;
export const SCHEMA_MAX_DEPTH = 6;

export class SchemaLintError extends Error {
  constructor(readonly code: string) {
    super(`MCP schema invalid: ${code}`);
  }
}

const OK: ValidationResult = Object.freeze({ ok: true });
const fail = (rule: RuleCode, path: readonly string[]): ValidationResult => ({ ok: false, rule, path });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function compileNode(schema: Schema, depth: number, opts: CompileOptions): (value: unknown, path: readonly string[]) => ValidationResult {
  if (depth > SCHEMA_MAX_DEPTH) throw new SchemaLintError('depth');
  switch (schema.type) {
    case 'string': {
      const { minLength, maxLength, pattern } = schema;
      const values = schema.enum;
      if (values !== undefined) {
        if (values.length === 0 || values.length > SCHEMA_MAX_ITEMS || !values.every((x) => typeof x === 'string')) throw new SchemaLintError('enum');
      } else if (!isCount(maxLength) || maxLength > SCHEMA_MAX_STRING) throw new SchemaLintError('string_unbounded');
      if (minLength !== undefined && (!isCount(minLength) || (isCount(maxLength) && minLength > maxLength))) throw new SchemaLintError('string_bounds');
      if (pattern !== undefined && !isCount(maxLength)) throw new SchemaLintError('pattern_unbounded');
      let re: RegExp | undefined;
      if (pattern !== undefined) {
        try {
          re = new RegExp(pattern, 'u');
        } catch {
          throw new SchemaLintError('pattern_invalid');
        }
      }
      const allowed = values === undefined ? undefined : new Set<string>(values);
      return (v, path) => {
        if (typeof v !== 'string') return fail('type', path);
        if (allowed !== undefined) return allowed.has(v) ? OK : fail('enum', path);
        if (v.length > (maxLength as number)) return fail('max_length', path);
        if (minLength !== undefined && v.length < minLength) return fail('min_length', path);
        if (re !== undefined && !re.test(v)) return fail('pattern', path);
        return OK;
      };
    }
    case 'integer':
    case 'number': {
      const { minimum, maximum } = schema;
      if (typeof minimum !== 'number' || typeof maximum !== 'number' || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
        throw new SchemaLintError('number_unbounded');
      }
      const integer = schema.type === 'integer';
      return (v, path) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isSafeInteger(v))) return fail('type', path);
        if (v < minimum) return fail('minimum', path);
        if (v > maximum) return fail('maximum', path);
        return OK;
      };
    }
    case 'boolean':
      return (v, path) => (typeof v === 'boolean' ? OK : fail('type', path));
    case 'array': {
      const { minItems, maxItems } = schema;
      if (!isCount(maxItems) || maxItems > SCHEMA_MAX_ITEMS) throw new SchemaLintError('array_unbounded');
      if (minItems !== undefined && (!isCount(minItems) || minItems > maxItems)) throw new SchemaLintError('array_bounds');
      const item = compileNode(schema.items, depth + 1, opts);
      return (v, path) => {
        if (!Array.isArray(v)) return fail('type', path);
        if (v.length > maxItems) return fail('max_items', path);
        if (minItems !== undefined && v.length < minItems) return fail('min_items', path);
        for (let i = 0; i < v.length; i += 1) {
          const r = item(v[i], path); // indices are omitted from the path on purpose
          if (!r.ok) return r;
        }
        return OK;
      };
    }
    case 'object': {
      const props = schema.properties ?? {};
      const names = Object.keys(props);
      if (names.length > SCHEMA_MAX_PROPERTIES) throw new SchemaLintError('too_many_properties');
      const required = schema.required ?? [];
      if (!required.every((r) => names.includes(r))) throw new SchemaLintError('required_unknown');
      if (schema.additionalProperties) {
        if (!opts.allowOpen) throw new SchemaLintError('object_open');
        if (!isCount(schema.maxProperties) || schema.maxProperties > SCHEMA_MAX_PROPERTIES) throw new SchemaLintError('object_unbounded');
      }
      const children = new Map<string, (value: unknown, path: readonly string[]) => ValidationResult>();
      for (const name of names) children.set(name, compileNode(props[name], depth + 1, opts));
      const maxProperties = schema.maxProperties;
      const open = schema.additionalProperties;
      return (v, path) => {
        if (!isRecord(v)) return fail('type', path);
        const keys = Object.keys(v);
        if (open && maxProperties !== undefined && keys.length > maxProperties) return fail('max_properties', path);
        for (const key of keys) {
          const child = children.get(key);
          if (child === undefined) {
            if (!open) return fail('unknown_property', path); // the unknown key is never reported
            continue;
          }
          const r = child(v[key], [...path, key]);
          if (!r.ok) return r;
        }
        for (const key of required) if (!Object.hasOwn(v, key)) return fail('required', [...path, key]);
        return OK;
      };
    }
    default:
      throw new SchemaLintError('unsupported_type');
  }
}

/** Compile a schema constant. Throws SchemaLintError for an unbounded or unsupported schema. */
export function compileSchema(schema: Schema, opts: CompileOptions = {}): Validator {
  const root = compileNode(schema, 0, opts);
  return (value) => root(value, []);
}
