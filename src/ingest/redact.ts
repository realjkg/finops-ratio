// Redactor for everything the worker persists (sync_runs.error_detail, stats,
// quarantine reasons, validation messages) or logs. Runs BEFORE writing: the
// amended schema rejects free text that still looks like it carries a secret.

import { redactDeep as walkRedact } from './cli';

export const MAX_REDACTED_LENGTH = 4000;
const R = '[redacted]';

const PATTERNS: Array<[RegExp, string]> = [
  // Credentials embedded in any URL: scheme://user:pass@host or scheme://user@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi, `$1${R}@`],
  // Query strings of URLs (presigned URLs, SAS tokens, …)
  [/([a-z][a-z0-9+.-]*:\/\/[^\s?#"']*)\?[^\s"']*/gi, `$1?${R}`],
  // Authorization headers
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${R}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${R}`],
  // AWS signing parameters and similar key=value secrets
  [/\b(X-Amz-(?:Signature|Credential|Security-Token)|sig|signature|password|passwd|pwd|secret|token|sas|access_token|aws_secret_access_key|aws_session_token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,]+)/gi, `$1$2${R}`],
  // AWS access key ids
  [/\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, R],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes secrets from text, then caps it at MAX_REDACTED_LENGTH characters. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.replace(new RegExp(escapeRegExp(s), 'g'), R);
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  if (out.length > MAX_REDACTED_LENGTH) out = out.slice(0, MAX_REDACTED_LENGTH - 3) + '...';
  return out;
}

const SECRET_ENV = /(SECRET|SESSION_TOKEN|PASSWORD|_TOKEN$)/;
const URL_ENV = /DATABASE_URL$/;

/** Literal secret values in the environment that must never be printed or stored. */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Every form a secret can take in our output: raw, URL-decoded, URL-encoded,
 * and the JSON-escaped form of each (what JSON.stringify makes of a quote,
 * backslash or control character inside it). Longest first.
 */
export function secretForms(raw: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const s of raw) {
    for (const v of [s, safeDecode(s), encodeURIComponent(s)]) {
      forms.add(v);
      forms.add(JSON.stringify(v).slice(1, -1));
    }
  }
  return [...forms].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length);
}

/** Literal secret values in the environment that must never be printed or stored, in every output form. */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (SECRET_ENV.test(k)) out.push(v);
    if (URL_ENV.test(k)) {
      out.push(v);
      try {
        const u = new URL(v);
        if (u.password) out.push(u.password, safeDecode(u.password));
        if (u.username && u.username.length >= 3) out.push(u.username, safeDecode(u.username));
        for (const [qk, qv] of u.searchParams) if (/pass/i.test(qk) && qv) out.push(qv);
      } catch {
        // unparseable: the literal value is still redacted
      }
    }
  }
  return secretForms(out);
}

/**
 * Deep copy with every string (and object key) redacted, BEFORE serialization
 * so JSON escaping can never hide a secret from the redactor. There is ONE
 * walker: Slice 0's `redactDeep` in cli.ts (BigInt as exact decimal text,
 * Buffers/typed arrays as `[binary]`, `toJSON` honoured, Errors as
 * name/message/code/cause, cycles as `[circular]`); this only supplies the
 * worker's secret-aware string redactor. The result is plain JSON-safe data.
 * (cli.ts imports this module too; the cycle is only dereferenced at call
 * time, never while modules load.)
 */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  return walkRedact(value, (s) => redact(s, secrets)) as T;
}

/** Replaces literal secret forms in already-serialized text (no length cap). */
export function scrubLiterals(text: string, forms: readonly string[]): string {
  let out = text;
  for (const f of forms) if (f.length >= 4) out = out.split(f).join('[redacted]');
  return out;
}

/**
 * The ONE way the worker CLI turns a value into an output line: redact every
 * string before JSON.stringify, then a literal backstop over the serialized
 * text (the forms include JSON-escaped secrets). Same pattern as Slice 0's
 * migrate CLI.
 */
export function jsonLineRedactorFor(env: Record<string, string | undefined>, extra: readonly string[] = []): (value: unknown) => string {
  const forms = secretForms([...secretsFromEnv(env), ...extra]);
  return (value: unknown) => scrubLiterals(JSON.stringify(redactDeep(value, forms)), forms);
}
