// Redaction for upstream error bodies that are logged server-side for
// diagnostics. Upstream bodies are NEVER put in errors that reach API callers;
// this only shapes what the server log keeps.
//
// Strips: URL query strings (presigned / SAS URLs carry credentials there),
// `Bearer <token>`, Azure SAS parameters (sig= / sv= / se= ...) appearing
// outside a URL, and AWS access key ids (AKIA… / ASIA…). Redaction runs BEFORE
// truncation, so a cut can never leave a partial secret that no longer matches.

/** Max characters of a redacted upstream body kept in the server log. */
export const MAX_LOGGED_BODY_CHARS = 300;

// Azure SAS query parameter names (service + account SAS, user-delegation keys).
const SAS_PARAMS = ['sig', 'sv', 'se', 'st', 'sp', 'sr', 'spr', 'srt', 'ss', 'si', 'sdd', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv'];
const SAS_RE = new RegExp(`\\b(${SAS_PARAMS.join('|')})=[^&\\s"'<>]*`, 'gi');

export function redactUpstreamText(text: string, maxChars = MAX_LOGGED_BODY_CHARS): string {
  const redacted = text
    // URL query strings → keep scheme/host/path only.
    .replace(/(\bhttps?:\/\/[^\s"'<>?#]*)\?[^\s"'<>#]*/gi, '$1?[REDACTED]')
    // Bearer tokens.
    .replace(/\bBearer\s+[^\s"'<>,;]+/gi, 'Bearer [REDACTED]')
    // Bare SAS parameters.
    .replace(SAS_RE, '$1=[REDACTED]')
    // AWS access key ids.
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY_ID]');
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
