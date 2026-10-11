// Canonical JSON and SHA-256 for digests and the audit hash chain. Pure; node:crypto only.
// Trust boundary: input here is built by this module's callers from validated values, but the
// canonicalizer still refuses anything it cannot serialize deterministically (undefined,
// functions, symbols, NaN, Infinity, class instances, cycles) rather than guessing.
import { createHash } from 'node:crypto';

const MAX_DEPTH = 8;

export class CanonicalError extends Error {
  constructor() {
    super('Value cannot be canonicalized');
    this.name = 'CanonicalError';
  }
}

/** Deterministic JSON: object keys sorted, bigint tagged so it cannot collide with a string or number. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new CanonicalError();
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalError();
      return JSON.stringify(value);
    case 'bigint':
      return `{"$bigint":"${value.toString()}"}`;
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError();
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new CanonicalError();
  }
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Digest of a value's canonical form. */
export const digestOf = (value: unknown): string => sha256Hex(canonicalJson(value));
