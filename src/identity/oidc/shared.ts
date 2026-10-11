// Small shared primitives for the OIDC verifier: the closed algorithm list,
// bounded character classes and plain-object tests. Pure data and pure
// functions; nothing here touches keys, the network or the clock.

/** The only signature algorithms this verifier can ever accept. Never `none`, never HS*. */
export const OIDC_ALGS = Object.freeze(['RS256', 'ES256', 'EdDSA'] as const);
export type OidcAlg = (typeof OIDC_ALGS)[number];

export const isOidcAlg = (v: unknown): v is OidcAlg => typeof v === 'string' && (OIDC_ALGS as readonly string[]).includes(v);

/** Printable ASCII, no space: key ids, token ids, audiences, claim names, URLs. */
export const TOKEN_CHARS_RE = /^[\x21-\x7E]+$/;
/** Stable subject and tenant ids. Same class as the mock IdP; no `@`, so an email never fits. */
export const ID_RE = /^[A-Za-z0-9._:|-]{1,128}$/;
/** Subject class used only when the config explicitly stops rejecting email-shaped subjects. */
export const LOOSE_SUBJECT_RE = /^[A-Za-z0-9._:|@+-]{1,128}$/;
export const KID_RE = /^[\x21-\x7E]{1,128}$/;
export const JTI_RE = /^[\x21-\x7E]{1,128}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when the string holds an ASCII control character (C0 or DEL). */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** A non-empty string no longer than `max` with no control characters. */
export function isBoundedText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !hasControlChars(v);
}

/** Epoch seconds: a positive safe integer. */
export function isEpochSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
