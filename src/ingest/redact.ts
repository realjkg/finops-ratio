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
// scan at every position (quadratic: 200 KB took 77 s). The query rule
// consumes the whole URL whether or not it has a query (the callback keeps a
// query-less URL unchanged), so the scan resumes AFTER it instead of retrying
// from every later scheme start (`a://a://…` was quadratic).
const SCHEME = '(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\\/\\/';
export type Replacement = string | ((match: string, ...groups: string[]) => string);

/**
 * Query strings of URLs (presigned URLs, SAS tokens, …). Exported so its
 * linearity is tested on its own, uncapped (redactCap.test.ts).
 */
export const QUERY_RULE: readonly [RegExp, Replacement] = [
  new RegExp(`(${SCHEME}[^\\s?#"']*)(\\?[^\\s"']*)?`, 'gi'),
  (match, url, query) => (query === undefined ? match : `${url}?${R}`),
];

const PATTERNS: ReadonlyArray<readonly [RegExp, Replacement]> = [
  // Credentials embedded in any URL: scheme://user:pass@host or scheme://user@host
  [new RegExp(`(${SCHEME})[^\\s/@?#]+@`, 'gi'), `$1${R}@`],
  QUERY_RULE,
  // Authorization headers
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${R}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${R}`],
  // AWS signing parameters and similar key=value secrets
  [/\b(X-Amz-(?:Signature|Credential|Security-Token)|sig|signature|password|passwd|pwd|secret|token|sas|access_token|aws_secret_access_key|aws_session_token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,]+)/gi, `$1$2${R}`],
  // AWS access key ids
  [/\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, R],
];

/**
 * Max characters of a single string that are redacted at all (same approach
 * as the app redactor, #47). Error messages can be megabytes; only
 * MAX_REDACTED_LENGTH characters are ever kept, so the input is cut a little
 * above that BEFORE redaction, bounding the cost of every rule to a few KB.
 */
export const MAX_REDACT_INPUT_CHARS = MAX_REDACTED_LENGTH + 512;
export const TRUNCATED_MARKER = ' …[TRUNCATED]';

const DELIMITER = /[\s,;&"'<>]/;

/** Index of the last delimiter before `limit` (the kept text is text.slice(0, it)), or 0. */
function backToDelimiter(text: string, limit: number): number {
  let cut = Math.min(limit, text.length) - 1;
  while (cut > 0 && !DELIMITER.test(text[cut])) cut -= 1;
  return Math.max(cut, 0);
}

/**
 * Caps the input for redaction. The cut moves back to the last delimiter, and
 * never lands inside text covered by a configured secret form (whose own
 * characters may be delimiters, e.g. a quote): a secret straddling the cap is
 * dropped whole, never left as a fragment no rule recognises.
 */
export function capForRedaction(text: string, secrets: readonly string[] = []): string {
  if (text.length <= MAX_REDACT_INPUT_CHARS) return text;
  let cut = backToDelimiter(text, MAX_REDACT_INPUT_CHARS);
  const parts = literalParts(secrets);
  if (parts.length) {
    const longest = parts[0].length;
    // Each step moves the cut strictly left, so this ends. Any occurrence that
    // covers the cut starts within `longest` of it; a chain of overlapping
    // occurrences further left is followed one step at a time.
    for (let moved = true; moved && cut > 0; ) {
      moved = false;
      const from = Math.max(0, cut - longest);
      for (const [s, e] of coveredRuns(text.slice(from, cut + longest), parts)) {
        if (from + s < cut && cut < from + e) {
          cut = backToDelimiter(text, from + s + 1);
          moved = true;
          break;
        }
      }
    }
  }
  return text.slice(0, cut) + TRUNCATED_MARKER;
}

/** The literal secrets worth matching (>= 4 chars, unique, longest first), cached per secrets array. */
const literalLists = new WeakMap<readonly string[], readonly string[]>();
function literalParts(secrets: readonly string[]): readonly string[] {
  let parts = literalLists.get(secrets);
  if (parts === undefined) {
    parts = [...new Set(secrets.filter((x) => typeof x === 'string' && x.length >= 4))].sort((a, b) => b.length - a.length);
    literalLists.set(secrets, parts);
  }
  return parts;
}

/**
 * The maximal runs of `text` covered by ANY occurrence of ANY secret —
 * overlapping occurrences of distinct secrets and of the same secret
 * included. A single leftmost alternation would consume one match and leave
 * the rest of an overlapping secret behind ('admin;x' + 'x;secret;pw' on
 * 'admin;x;secret;pw'). Every indexOf hit goes into a difference array, so
 * this stays linear in text length x number of secrets.
 */
function coveredRuns(text: string, parts: readonly string[]): Array<[number, number]> {
  let diff: Int32Array | null = null;
  for (const p of parts) {
    for (let i = text.indexOf(p); i !== -1; i = text.indexOf(p, i + 1)) {
      if (!diff) diff = new Int32Array(text.length + 1);
      diff[i] += 1;
      diff[i + p.length] -= 1;
    }
  }
  if (!diff) return [];
  const runs: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const before = depth;
    depth += diff[i];
    if (before === 0 && depth > 0) start = i;
    else if (before > 0 && depth === 0) runs.push([start, i]);
  }
  return runs;
}

/** Replaces every covered run (see coveredRuns) with `replacement`. */
function replaceLiterals(text: string, secrets: readonly string[], replacement: string): string {
  const parts = literalParts(secrets);
  if (!parts.length) return text;
  const runs = coveredRuns(text, parts);
  if (!runs.length) return text;
  const out: string[] = [];
  let last = 0;
  for (const [s, e] of runs) {
    out.push(text.slice(last, s), replacement);
    last = e;
  }
  out.push(text.slice(last));
  return out.join('');
}

/** Removes secrets from (capped) text, then caps it at MAX_REDACTED_LENGTH characters. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = replaceLiterals(capForRedaction(String(text), secrets), secrets, R);
  for (const [re, rep] of PATTERNS) out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
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
  return replaceLiterals(text, forms, '[redacted]');
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
