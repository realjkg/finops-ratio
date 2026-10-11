// Canonical JSON and SHA-256 helpers. Purpose: a stable text form of a JSON value
// (keys sorted, no whitespace) for argument hashes and descriptor digests.
// Trust boundary: input is already sanitized (bounded depth and size); the hash uses
// the web-standard crypto API, so there is no dependency and no randomness.
import type { JsonValue } from './jsonSafe';

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
