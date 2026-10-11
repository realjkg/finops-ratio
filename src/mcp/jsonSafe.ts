// Bounded, prototype-pollution-safe JSON intake. Purpose: turn untrusted text or an
// already-parsed value into a plain JSON tree with null-prototype objects, or refuse.
// Trust boundary: everything that crosses it (client messages, data-provider results)
// passes here first. Refuses oversized, too-deep, too-wide, non-JSON and
// prototype-key input with a closed code and never echoes the input. The caller
// decides what each code means to the client.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SanitizeCode = 'size' | 'depth' | 'nodes' | 'string' | 'key' | 'forbidden_key' | 'type' | 'syntax';

export type SanitizeResult = { ok: true; value: JsonValue; bytes: number } | { ok: false; code: SanitizeCode };

export interface SanitizeLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
  maxKeyBytes: number;
}

/** Keys that could reach Object.prototype through a careless merge. Refused anywhere. */
export const FORBIDDEN_KEYS: readonly string[] = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** UTF-8 length of a string without allocating (a lone surrogate counts as 3, like TextEncoder). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

class Reject extends Error {
  constructor(readonly code: SanitizeCode) {
    super(code);
  }
}

/** Deepest container nesting of JSON text, compared with the limit before anything is built. */
function withinDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > maxDepth) return false;
    } else if ((c === 0x7d || c === 0x5d) && depth > 0) depth -= 1;
  }
  return true;
}

/**
 * Copy `input` into a fresh tree of null-prototype objects and plain arrays. Accepts
 * only own enumerable data properties of plain objects and arrays; refuses accessors,
 * class instances, non-finite numbers, undefined, functions, symbols and bigints.
 * `bytes` is an approximation of the serialized size (strings plus keys plus 2 per value).
 */
export function sanitizeJson(input: unknown, limits: SanitizeLimits): SanitizeResult {
  let nodes = 0;
  let bytes = 0;
  const add = (n: number): void => {
    bytes += n;
    if (bytes > limits.maxBytes) throw new Reject('size');
  };
  const walk = (v: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > limits.maxNodes) throw new Reject('nodes');
    if (v === null) {
      add(4);
      return null;
    }
    switch (typeof v) {
      case 'boolean':
        add(5);
        return v;
      case 'number':
        if (!Number.isFinite(v)) throw new Reject('type');
        add(String(v).length);
        return v;
      case 'string': {
        const n = utf8Length(v);
        if (n > limits.maxStringBytes) throw new Reject('string');
        add(n + 2);
        return v;
      }
      case 'object':
        break;
      default:
        throw new Reject('type');
    }
    if (depth + 1 > limits.maxDepth) throw new Reject('depth');
    add(2);
    if (Array.isArray(v)) {
      const len = v.length;
      if (len > limits.maxNodes) throw new Reject('nodes');
      const out: JsonValue[] = [];
      for (let i = 0; i < len; i += 1) {
        if (!Object.hasOwn(v, i)) throw new Reject('type'); // a hole is not JSON
        out.push(walk(v[i], depth + 1));
      }
      return out;
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Reject('type');
    const out = Object.create(null) as { [key: string]: JsonValue };
    for (const key of Object.keys(v)) {
      const keyBytes = utf8Length(key);
      if (keyBytes > limits.maxKeyBytes) throw new Reject('key');
      if (FORBIDDEN_KEYS.includes(key)) throw new Reject('forbidden_key');
      const desc = Object.getOwnPropertyDescriptor(v, key);
      if (!desc || !('value' in desc)) throw new Reject('type'); // accessors can change between reads
      add(keyBytes + 3);
      out[key] = walk(desc.value, depth + 1);
    }
    return out;
  };
  try {
    return { ok: true, value: walk(input, 0), bytes };
  } catch (e) {
    // A throwing Proxy or getter is not JSON either; nothing is reported but the code.
    return { ok: false, code: e instanceof Reject ? e.code : 'type' };
  }
}

/**
 * Parse JSON text under the limits. The size and depth are checked before JSON.parse
 * builds anything. A syntax error is reported as a code only: the engine's message
 * quotes the input.
 */
export function parseJsonSafe(text: string, limits: SanitizeLimits): SanitizeResult {
  if (typeof text !== 'string') return { ok: false, code: 'type' };
  // UTF-8 bytes are never fewer than UTF-16 code units, so this is a cheap first refusal.
  if (text.length > limits.maxBytes || utf8Length(text) > limits.maxBytes) return { ok: false, code: 'size' };
  if (!withinDepth(text, limits.maxDepth)) return { ok: false, code: 'depth' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'syntax' };
  }
  return sanitizeJson(parsed, limits);
}
