// Redaction for upstream error bodies that are logged server-side for
// diagnostics. Upstream bodies are NEVER put in errors that reach API callers;
// this only shapes what the server log keeps.
//
// Strips: PEM blocks, URL userinfo and query strings (presigned / SAS URLs
// carry credentials there), Azure AccountKey= / SharedAccessSignature=, AWS
// X-Amz-Signature / -Credential / -Security-Token, JWTs, Authorization header
// values (Bearer / Basic / token), free-text Bearer / Basic (any case) before
// a credential-shaped value (>= 16 token chars, >= 8 with a digit, or base64
// user:pass — prose is left alone), GitHub tokens, sk- / sk-proj- keys, AWS
// secret access keys, access / refresh / id / session / private tokens, access
// keys, client secrets, API keys, passwords (password / passwd / pwd),
// secrets, tokens and X-FinIO-Session values in JSON and k=v form — also with
// an env-style prefix (RATIO_API_TOKEN=, SERVICENOW_PASSWORD=), bare token=, bare SAS parameters, and AWS access key ids (AKIA… /
// ASIA…). Redaction runs BEFORE truncation, so a
// cut can never leave a partial secret that no longer matches.

/** Max characters of a redacted upstream body kept in the server log. */
export const MAX_LOGGED_BODY_CHARS = 300;

// Azure SAS query parameter names (service + account SAS, user-delegation keys).
const SAS_PARAMS = ['sig', 'sv', 'se', 'st', 'sp', 'sr', 'spr', 'srt', 'ss', 'si', 'sdd', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv'];
const SAS_RE = new RegExp(`\\b(${SAS_PARAMS.join('|')})=[^&\\s"'<>]*`, 'gi');

// Credential-bearing field names, matched in JSON ("key": "value") and k=v forms.
const SECRET_KEYS =
  'aws[_-]?secret[_-]?access[_-]?key|access_token|refresh_token|id_token|session_token|private_token|' +
  'access_key|client_secret|api[_-]?key|password|passwd|pwd|secret|token|x-finio-session';

// Env-style keys: an UPPER-CASE prefix ending in `_` plus an UPPER-CASE
// credential name — RATIO_API_TOKEN, JIRA_API_TOKEN, FINIO_PEER_TOKEN,
// SERVICENOW_PASSWORD, DB_PWD … Matched case-SENSITIVELY so ordinary
// snake_case fields (cost_per_token, input_token, is_secret, has_password,
// team_token, max_tokens) are left alone; un-prefixed keys use the
// case-insensitive rules above with a word boundary, which `_` blocks.
const ENV_SECRET_KEYS =
  'SECRET_ACCESS_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|SESSION_TOKEN|PRIVATE_TOKEN|ACCESS_KEY|' +
  'CLIENT_SECRET|API_?KEY|PASSWORD|PASSWD|PWD|SECRET|TOKEN';
const ENV_KEY = `[A-Z0-9_]*_(?:${ENV_SECRET_KEYS})`;

// A secret value: a whole "…" or '…' string (escaped quotes inside; an
// unterminated quote runs to the end — over-redacting malformed text is the
// safe side), or an unquoted run. Each alternative is deterministic (no
// nested ambiguity), so matching stays linear.
const SECRET_VALUE = `(?:"(?:[^"\\\\]|\\\\[\\s\\S])*"?|'(?:[^'\\\\]|\\\\[\\s\\S])*'?|(?!\\[REDACTED)[^\\s&;,"'<>]+)`;
const JSON_VALUE = `"(?:[^"\\\\]|\\\\[\\s\\S])*"?`;

/** Keep a quoted value's quote style; replace its content. */
function redactValue(prefix: string, value: string): string {
  const q = value[0];
  return q === '"' || q === "'" ? `${prefix}${q}[REDACTED]${q}` : `${prefix}[REDACTED]`;
}

/** `user:pass` encoded as base64 (Basic credentials). */
function isBasicCredential(v: string): boolean {
  if (v.length < 8 || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  try {
    return atob(v).includes(':');
  } catch {
    return false;
  }
}

/**
 * Whether a free-text Bearer / Basic value is credential-shaped: >= 16 token
 * characters, or >= 8 containing a digit, or (Basic) base64 `user:pass`.
 * Prose ("Bearer of costs", "Basic Support plan") is left alone; inside an
 * Authorization header the value is always redacted (separate rule).
 */
function credentialShaped(scheme: string, v: string): boolean {
  if (v.length >= 16) return true;
  if (v.length >= 8 && /\d/.test(v)) return true;
  return scheme.toLowerCase() === 'basic' && isBasicCredential(v);
}

const FREE_TEXT_AUTH_RE = /\b(Bearer|Basic)\s+(["']?)([A-Za-z0-9._~+/=-]+)\2/gi;
const JSON_SECRET_RE = new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)${JSON_VALUE}`, 'gi');
const JSON_ENV_SECRET_RE = new RegExp(`("${ENV_KEY}"\\s*:\\s*)${JSON_VALUE}`, 'g');
const KV_SECRET_RE = new RegExp(`\\b((?:${SECRET_KEYS})\\s*[=:]\\s*)(${SECRET_VALUE})`, 'gi');
const KV_ENV_SECRET_RE = new RegExp(`\\b(${ENV_KEY}\\s*[=:]\\s*)(${SECRET_VALUE})`, 'g');

/**
 * Patterns, applied in order (most specific first). Each replaces the secret
 * part with a `[REDACTED…]` marker and keeps enough context to stay useful.
 */
type Replacement = string | ((match: string, ...groups: string[]) => string);

const RULES: Array<[RegExp, Replacement]> = [
  // PEM blocks (private keys, certificates).
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, '[REDACTED_PEM]'],
  // URL userinfo: scheme://user:pass@host → scheme://[REDACTED]@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, '$1[REDACTED]@'],
  // URL query strings → keep scheme/host/path only.
  [/(\bhttps?:\/\/[^\s"'<>?#]*)\?[^\s"'<>#]*/gi, '$1?[REDACTED]'],
  // Azure storage connection-string secrets.
  [/\b(AccountKey|SharedAccessSignature)=[^;\s"'<>]+/gi, '$1=[REDACTED]'],
  // AWS SigV4 query / header credentials.
  [/\b(X-Amz-(?:Signature|Credential|Security-Token))(\s*[=:]\s*)[^\s&;,"'<>]+/gi, '$1$2[REDACTED]'],
  // Authorization header values: always redacted, whatever the scheme value.
  [/\b(Authorization\s*:\s*(?:Bearer|Basic|token))\s+("[^"]*"|'[^']*'|(?!\[REDACTED)[^\s"'<>,;]+)/gi, '$1 [REDACTED]'],
  // Bearer / Basic in free text (any case): only before a credential-shaped value.
  [FREE_TEXT_AUTH_RE, (match, scheme, _q, value) => (credentialShaped(scheme, value) ? `${scheme} [REDACTED]` : match)],
  // JWTs anywhere.
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]'],
  // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_GITHUB_TOKEN]'],
  // OpenAI-style secret keys (sk-…, sk-proj-…).
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
  // JSON "secret_key": "value" (and env-style "RATIO_API_TOKEN": "value").
  [JSON_SECRET_RE, '$1"[REDACTED]"'],
  [JSON_ENV_SECRET_RE, '$1"[REDACTED]"'],
  // k=v / k: v secret fields, quoted or not (and env-style RATIO_API_TOKEN=…).
  [KV_SECRET_RE, (_m, prefix, value) => redactValue(prefix, value)],
  [KV_ENV_SECRET_RE, (_m, prefix, value) => redactValue(prefix, value)],
  // Bare token=value.
  [/\b(token\s*=\s*)(?!\[REDACTED)[^\s&;,"'<>]+/gi, '$1[REDACTED]'],
  // Bare SAS parameters.
  [SAS_RE, '$1=[REDACTED]'],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
];

export function redactUpstreamText(text: string, maxChars = MAX_LOGGED_BODY_CHARS): string {
  let redacted = text;
  for (const [re, replacement] of RULES) {
    redacted =
      typeof replacement === 'string'
        ? redacted.replace(re, replacement)
        : redacted.replace(re, (match: string, ...groups: string[]) => replacement(match, ...groups));
  }
  return redacted.slice(0, maxChars);
}

/** Max characters of error text surfaced in health detail / rethrown errors. */
export const MAX_SURFACED_ERROR_CHARS = 1000;

/**
 * Redacted text of an error for anything that reaches an API caller (health
 * detail, rethrown adapter errors) — a second line of defence behind the
 * transports' own status-only errors.
 */
export function redactErrorText(err: unknown): string {
  return redactUpstreamText(renderThrown(err), MAX_SURFACED_ERROR_CHARS);
}

/** Fixed rendering for a thrown value that cannot be turned into text. */
export const UNRENDERABLE_THROWN_VALUE = '[unrenderable thrown value]';

/**
 * Total: renders ANY thrown JS value to a string and never throws. Rendering
 * can throw for valid thrown values — Object.create(null) (no toString),
 * throwing / non-callable toString, a throwing `message` getter, a Proxy whose
 * traps throw — and the error path must not itself escape.
 */
export function renderThrown(err: unknown): string {
  try {
    if (typeof err === 'string') return err;
    if (typeof err === 'symbol') return err.toString();
    const raw: unknown = err instanceof Error ? err.message : err;
    const text = typeof raw === 'symbol' ? raw.toString() : String(raw);
    return typeof text === 'string' ? text : UNRENDERABLE_THROWN_VALUE;
  } catch {
    return UNRENDERABLE_THROWN_VALUE;
  }
}

/** Fixed, body-free reason for an upstream HTTP status. */
export function statusReason(status: number): string {
  if (status === 400) return 'bad request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'upstream error';
  return 'request failed';
}

/**
 * Logs an upstream error body server-side ONLY (structured JSON, redacted,
 * truncated). Never part of an error that reaches an API caller.
 */
export function logUpstreamError(label: string, status: number, body: string): void {
  console.warn(
    JSON.stringify({ tag: 'upstream-error', label, status, body: redactUpstreamText(body) }),
  );
}

/** Parse a JSON body with a FIXED error: a runtime JSON error would quote upstream content. */
export async function readJsonBody<T>(res: { json(): Promise<unknown> }, label: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }
}
