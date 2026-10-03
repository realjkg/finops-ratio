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
