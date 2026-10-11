// Output redaction for MCP tool results (DESIGN 5 threat T7, A19). Purpose: scan every
// string leaf of a data-provider result for secret-shaped text, token-like strings and
// email addresses, and either reject the whole result or replace only what matched.
// Trust boundary: runs after the output schema and before the size cap and delivery,
// so no unredacted value reaches the model, the audit record or a log. It reuses the
// repository's rules (src/costsource/transports/redact.ts) and adds an email rule and
// a token-like heuristic. Pattern-based detection is incomplete by nature: a novel
// secret format, or a secret split across two fields, passes.
//
// Method (DESIGN T7): each string is scanned alone; each key and value pair is also
// scanned in its serialized form, because rules such as password=... fire on the key.
// A key-only hit replaces the value wholesale (the bare value can look harmless). A hit
// on a key, or on a non-string value, cannot be mapped to a replacement and rejects the
// whole result. The delivered text is built from the cleaned tree, never from a
// redacted serialization.
import { applyRedactionRules } from '@/costsource/transports/redact';
import type { JsonValue } from './jsonSafe';

export type SecretPolicy = 'reject' | 'redact';
export type EmailPolicy = 'mask' | 'allow' | 'reject';

export interface RedactOptions {
  onSecret: SecretPolicy;
  email: EmailPolicy;
}

export type RedactionResult =
  | { ok: true; value: JsonValue; redactedCount: number }
  | { ok: false; reason: 'secret_in_result' | 'pii_in_result' };

export const REDACTED = '[REDACTED]';
export const REDACTED_EMAIL = '[REDACTED_EMAIL]';
export const REDACTED_TOKEN = '[REDACTED_TOKEN]';

// Bounded quantifiers only, so the scan stays linear in the string length.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
const TOKEN_RUN_RE = /[A-Za-z0-9_+/=-]{40,}/g;

/** Heuristic: a long run mixing letters and digits with many distinct characters, and few hyphens (so slugs pass). */
function tokenLike(run: string): boolean {
  if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) return false;
  if (new Set(run).size < 12) return false;
  let hyphens = 0;
  for (const c of run) if (c === '-') hyphens += 1;
  return hyphens <= 3;
}

/** Keys whose value is a credential by name. A bare number under one is not matched by the repo rules (they need quotes). */
const CREDENTIAL_KEY_RE = /^(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|api[_-]?key|credential|private[_-]?key)$/i;

interface Scan {
  text: string;
  secret: boolean;
  email: boolean;
}

function scanString(s: string, email: EmailPolicy): Scan {
  let text = applyRedactionRules(s);
  let secret = text !== s;
  const afterToken = text.replace(TOKEN_RUN_RE, (run) => (tokenLike(run) ? REDACTED_TOKEN : run));
  if (afterToken !== text) {
    secret = true;
    text = afterToken;
  }
  let emailHit = false;
  if (email !== 'allow') {
    const afterEmail = text.replace(EMAIL_RE, REDACTED_EMAIL);
    emailHit = afterEmail !== text;
    text = afterEmail;
  }
  return { text, secret, email: emailHit };
}

class Withhold extends Error {
  constructor(readonly reason: 'secret_in_result' | 'pii_in_result') {
    super(reason);
  }
}

/** Does a one-property JSON object serialize to something the rules would change? */
function pairChanges(key: string, value: JsonValue): boolean {
  const serialized = JSON.stringify({ [key]: value });
  return applyRedactionRules(serialized) !== serialized;
}

/**
 * Clean a sanitized tree. Always returns a fresh tree, so the caller may truncate it in
 * place. `redactedCount` is the number of leaves replaced; the values are never reported.
 */
export function redactResult(root: JsonValue, opts: RedactOptions): RedactionResult {
  let count = 0;
  const keyClean = new Map<string, boolean>();
  const isCleanKey = (key: string): boolean => {
    let clean = keyClean.get(key);
    if (clean === undefined) {
      const s = scanString(key, opts.email);
      clean = !s.secret && !s.email;
      keyClean.set(key, clean);
    }
    return clean;
  };

  const walk = (v: JsonValue, key: string | undefined): JsonValue => {
    if (Array.isArray(v)) return v.map((item) => walk(item, undefined));
    if (v !== null && typeof v === 'object') {
      const out = Object.create(null) as { [k: string]: JsonValue };
      for (const k of Object.keys(v)) {
        if (!isCleanKey(k)) throw new Withhold('secret_in_result'); // a key cannot be mapped to a replacement
        out[k] = walk(v[k], k);
      }
      return out;
    }
    if (typeof v !== 'string') {
      if (key !== undefined && (pairChanges(key, v) || (typeof v === 'number' && CREDENTIAL_KEY_RE.test(key)))) throw new Withhold('secret_in_result');
      return v;
    }
    const s = scanString(v, opts.email);
    const keyOnly = !s.secret && key !== undefined && pairChanges(key, v);
    if (!s.secret && !s.email && !keyOnly) return v;
    if (s.email && opts.email === 'reject') throw new Withhold('pii_in_result');
    if (s.secret || keyOnly) {
      if (opts.onSecret === 'reject') throw new Withhold('secret_in_result');
      count += 1;
      return keyOnly ? REDACTED : s.text;
    }
    count += 1; // email masked
    return s.text;
  };

  try {
    const value = walk(root, undefined);
    return { ok: true, value, redactedCount: count };
  } catch (e) {
    return { ok: false, reason: e instanceof Withhold ? e.reason : 'secret_in_result' };
  }
}
