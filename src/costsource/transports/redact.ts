// Redaction for upstream error bodies that are logged server-side for
// diagnostics. Upstream bodies are NEVER put in errors that reach API callers;
// this only shapes what the server log keeps.
//
// Strips: PEM blocks, URL userinfo and query strings (presigned / SAS URLs
// carry credentials there), Azure AccountKey= / SharedAccessSignature=, AWS
// X-Amz-Signature / -Credential / -Security-Token, JWTs, Bearer (quoted or
// bare) and Basic credentials, access/refresh/id tokens, client secrets, API
// keys, passwords and secrets in JSON and k=v form, bare SAS parameters, and
// AWS access key ids (AKIA… / ASIA…). Redaction runs BEFORE truncation, so a
// cut can never leave a partial secret that no longer matches.

/** Max characters of a redacted upstream body kept in the server log. */
export const MAX_LOGGED_BODY_CHARS = 300;

// Azure SAS query parameter names (service + account SAS, user-delegation keys).
const SAS_PARAMS = ['sig', 'sv', 'se', 'st', 'sp', 'sr', 'spr', 'srt', 'ss', 'si', 'sdd', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv'];
const SAS_RE = new RegExp(`\\b(${SAS_PARAMS.join('|')})=[^&\\s"'<>]*`, 'gi');

// Credential-bearing field names, matched in JSON ("key": "value") and k=v forms.
const SECRET_KEYS = 'access_token|refresh_token|id_token|client_secret|api[_-]?key|password|secret';
const JSON_SECRET_RE = new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi');
const KV_SECRET_RE = new RegExp(`\\b((?:${SECRET_KEYS})\\s*[=:]\\s*)(?!\\[REDACTED)[^\\s&;,"'<>]+`, 'gi');

/**
 * Patterns, applied in order (most specific first). Each replaces the secret
 * part with a `[REDACTED…]` marker and keeps enough context to stay useful.
 */
const RULES: Array<[RegExp, string]> = [
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
  // Bearer tokens, quoted or bare.
  [/\bBearer\s+"[^"]*"/gi, 'Bearer [REDACTED]'],
  [/\bBearer\s+'[^']*'/gi, 'Bearer [REDACTED]'],
  [/\bBearer\s+(?!\[REDACTED)[^\s"'<>,;]+/gi, 'Bearer [REDACTED]'],
  // JWTs anywhere.
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED_JWT]'],
  // Basic auth credentials.
  [/\bBasic\s+[A-Za-z0-9+/=._-]{6,}/g, 'Basic [REDACTED]'],
  // JSON "secret_key": "value".
  [JSON_SECRET_RE, '$1"[REDACTED]"'],
  // k=v / k: v secret fields.
  [KV_SECRET_RE, '$1[REDACTED]'],
  // Bare SAS parameters.
  [SAS_RE, '$1=[REDACTED]'],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
];

export function redactUpstreamText(text: string, maxChars = MAX_LOGGED_BODY_CHARS): string {
  let redacted = text;
  for (const [re, replacement] of RULES) redacted = redacted.replace(re, replacement);
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
  return redactUpstreamText(err instanceof Error ? err.message : String(err), MAX_SURFACED_ERROR_CHARS);
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
