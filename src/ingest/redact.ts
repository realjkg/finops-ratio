// Redactor for everything the worker persists (sync_runs.error_detail, stats,
// quarantine reasons, validation messages) or logs. Runs BEFORE writing: the
// amended schema rejects free text that still looks like it carries a secret.

import { redactDeep as walkRedact } from './cli';

export const MAX_REDACTED_LENGTH = 4000;
const R = '[redacted]';

// Every rule must stay LINEAR in the input (redactLinear.test.ts): redaction
// runs synchronously on worker log lines, evidence records and in the crash
// handler. The URL rules only start a scheme where no scheme character
// precedes (lookbehind); without it a long run of letters restarts the scheme
// scan at every position (quadratic: 200 KB took 77 s).
const SCHEME = '(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\\/\\/';
const PATTERNS: Array<[RegExp, string]> = [
  // Credentials embedded in any URL: scheme://user:pass@host or scheme://user@host
  [new RegExp(`(${SCHEME})[^\\s/@?#]+@`, 'gi'), `$1${R}@`],
  // Query strings of URLs (presigned URLs, SAS tokens, …)
  [new RegExp(`(${SCHEME}[^\\s?#"']*)\\?[^\\s"']*`, 'gi'), `$1?${R}`],
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

/**
 * Max characters of a single string that are redacted at all (same approach
 * as the app redactor, #47). Error messages can be megabytes; only a short
 * prefix is ever kept (MAX_REDACTED_LENGTH), so the rest is dropped BEFORE
 * redaction, bounding the cost of every rule.
 */
export const MAX_REDACT_INPUT_CHARS = 16_384;
export const TRUNCATED_MARKER = ' …[TRUNCATED]';

/**
 * Caps the input for redaction. The cut moves back to the last delimiter, so
 * a secret straddling the cap is dropped whole rather than left half-present
 * in a form no rule recognises.
 */
export function capForRedaction(text: string): string {
  if (text.length <= MAX_REDACT_INPUT_CHARS) return text;
  const head = text.slice(0, MAX_REDACT_INPUT_CHARS);
  let cut = head.length - 1;
  while (cut >= 0 && !/[\s,;&"'<>]/.test(head[cut])) cut -= 1;
  return (cut > 0 ? head.slice(0, cut) : '') + TRUNCATED_MARKER;
}

/**
 * ONE combined, escaped alternation of the literal secrets (longest first, so
 * a longer form wins over its prefix), built once per secrets array and
 * cached: a single linear pass instead of one regex built per secret per call.
 */
const literalPatterns = new WeakMap<readonly string[], RegExp | null>();
function literalPattern(secrets: readonly string[]): RegExp | null {
  let re = literalPatterns.get(secrets);
  if (re === undefined) {
    const parts = [...new Set(secrets.filter((x) => typeof x === 'string' && x.length >= 4))].sort((a, b) => b.length - a.length);
    re = parts.length ? new RegExp(parts.map(escapeRegExp).join('|'), 'g') : null;
    literalPatterns.set(secrets, re);
  }
  return re;
}

/** Removes secrets from (capped) text, then caps it at MAX_REDACTED_LENGTH characters. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = capForRedaction(String(text));
  const literals = literalPattern(secrets);
  if (literals) out = out.replace(literals, R);
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

/** Replaces literal secret forms in already-serialized text (no length cap; one linear pass). */
export function scrubLiterals(text: string, forms: readonly string[]): string {
  const literals = literalPattern(forms);
  return literals ? text.replace(literals, '[redacted]') : text;
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
