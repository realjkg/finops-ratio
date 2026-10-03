// Redactor for everything the worker persists (sync_runs.error_detail, stats,
// quarantine reasons, validation messages) or logs. Runs BEFORE writing: the
// amended schema rejects free text that still looks like it carries a secret.

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
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (SECRET_ENV.test(k)) out.push(v);
    if (URL_ENV.test(k)) {
      out.push(v);
      try {
        const u = new URL(v);
        if (u.password) out.push(u.password, decodeURIComponent(u.password));
        if (u.username && u.username.length >= 3) out.push(u.username, decodeURIComponent(u.username));
      } catch {
        // unparseable: the literal value is still redacted
      }
    }
  }
  return [...new Set(out.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
}

/** Deep-redacts every string inside a JSON-compatible value. */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === 'string') return redact(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, secrets);
    return out as T;
  }
  return value;
}
