// Secret handles and URL redaction for alert delivery.
//
// TRUST BOUNDARY: webhook URLs and signing secrets are referenced by HANDLE in
// tenant config and resolved here through an injected SecretStore. A resolved
// value is held only for the duration of one attempt. It must never appear in a
// log, error, audit record, delivery result or test snapshot, so:
//   - every failure is a fixed code; a store's thrown error is swallowed, never
//     forwarded (its message could echo the value);
//   - the only thing ever derived from a URL for logging is its HOST.

import type { SecretStore } from './types';

export type SecretCode = 'secret_handle_invalid' | 'secret_missing' | 'secret_unavailable' | 'secret_invalid';

export type SecretResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: SecretCode };

/** Handles look like `notify/slack-prod`: lower-case, no spaces, no value-like content. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9_/-]{0,127}$/;

export const MIN_SIGNING_SECRET_CHARS = 16;
export const MAX_SIGNING_SECRET_CHARS = 256;
export const MAX_URL_SECRET_CHARS = 2048;

export function isValidSecretHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && HANDLE_RE.test(handle) && !handle.includes('//');
}

export type SecretKind = 'url' | 'signing';

/**
 * Resolve a handle through the store. Never throws, never returns store error
 * text. A `url` value must be printable ASCII (it is parsed by the SSRF guard
 * afterwards); a `signing` value must be 16 to 256 characters.
 */
export async function resolveSecret(
  store: SecretStore,
  tenant: string,
  handle: unknown,
  kind: SecretKind,
): Promise<SecretResult> {
  if (!isValidSecretHandle(handle)) return { ok: false, code: 'secret_handle_invalid' };
  let value: string | undefined;
  try {
    value = await store.get(tenant, handle);
  } catch {
    return { ok: false, code: 'secret_unavailable' };
  }
  if (value === undefined || value === null || value === '') return { ok: false, code: 'secret_missing' };
  if (typeof value !== 'string') return { ok: false, code: 'secret_invalid' };
  if (kind === 'url') {
    if (value.length > MAX_URL_SECRET_CHARS || /[^\x21-\x7e]/.test(value)) return { ok: false, code: 'secret_invalid' };
  } else if (value.length < MIN_SIGNING_SECRET_CHARS || value.length > MAX_SIGNING_SECRET_CHARS) {
    return { ok: false, code: 'secret_invalid' };
  }
  return { ok: true, value };
}

/** Marker used when a host cannot be shown. */
export const REDACTED_HOST = '[invalid-host]';

const SAFE_HOST_RE = /^[a-z0-9.:[\]-]{1,255}$/;

/**
 * The only thing that may be logged about a URL: its host. Scheme, userinfo,
 * port, path, query and fragment are all dropped. Returns a marker for
 * anything that does not parse to a plain host.
 */
export function hostOnly(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_URL_SECRET_CHARS) return REDACTED_HOST;
  try {
    const host = new URL(raw).hostname;
    return SAFE_HOST_RE.test(host) ? host : REDACTED_HOST;
  } catch {
    return REDACTED_HOST;
  }
}
