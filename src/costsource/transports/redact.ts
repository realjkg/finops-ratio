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
// an env-style prefix (RATIO_API_TOKEN=, SERVICENOW_PASSWORD=, Db_Password=),
// with values quoted "…", '…', `…`, backslash-escaped \"…\" or unquoted, in
// plain or double-encoded JSON; bare token=, bare SAS parameters, and AWS
// access key ids (AKIA… / ASIA…). Redaction runs BEFORE output truncation, so
// a cut can never leave a partial secret that no longer matches. The input is
// capped (MAX_REDACT_INPUT_CHARS) and every rule is linear, so redaction can
// never stall the event loop (redactLinear.test.ts).

/** Max characters of a redacted upstream body kept in the server log. */
export const MAX_LOGGED_BODY_CHARS = 300;

// Azure SAS query parameter names (service + account SAS, user-delegation keys).
const SAS_PARAMS = ['sig', 'sv', 'se', 'st', 'sp', 'sr', 'spr', 'srt', 'ss', 'si', 'sdd', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv'];
const SAS_RE = new RegExp(`\\b(${SAS_PARAMS.join('|')})=[^&\\s"'<>]*`, 'gi');

// Credential-bearing field names, matched in JSON ("key": "value") and k=v forms.
const SECRET_KEYS =
  'aws[_-]?secret[_-]?access[_-]?key|access_token|refresh_token|id_token|session_token|private_token|' +
  'access_key|client_secret|api[_-]?key|password|passwd|pwd|secret|token|x-finio-session';

/** A case-insensitive character-class spelling of an ASCII word (no regex flag needed). */
function anyCase(word: string): string {
  return word.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

// Env-style keys: a prefix that STARTS WITH AN UPPER-CASE LETTER, made of
// `_`-terminated segments, then a credential name in any case —
// RATIO_API_TOKEN, JIRA_API_TOKEN, FINIO_PEER_TOKEN, SERVICENOW_PASSWORD,
// DB_PWD, and mixed-case Db_Password / Jira_Api_Token. Decision: a leading
// capital marks an env / config key; ordinary lower-case snake_case fields
// (cost_per_token, input_token, is_secret, has_password, team_token,
// max_tokens) are left alone. Un-prefixed keys use the case-insensitive rules
// with a word boundary, which `_` blocks. Each segment ends at `_`, which the
// segment class excludes, so there is one way to split a key (linear).
const ENV_CREDENTIALS = [
  'secret_access_key', 'access_token', 'refresh_token', 'id_token', 'session_token', 'private_token',
  'access_key', 'client_secret', 'api_key', 'apikey', 'password', 'passwd', 'pwd', 'secret', 'token',
];
const ENV_KEY = `[A-Z][A-Za-z0-9]*_(?:[A-Za-z0-9]*_)*(?:${ENV_CREDENTIALS.map(anyCase).join('|')})`;

// Secret value grammar. Every alternative is deterministic and always
// succeeds once started (closing delimiters are optional — an unterminated
// value runs to the end, over-redacting malformed text, the safe side), so
// matching never backtracks and stays linear.
const BT = '`';
// \"…\" — a quoted value inside an already-escaped (JSON-in-a-string) body.
// Units: a plain char; `\\\X` (an escaped backslash + escaped char, i.e. an
// inner escape such as \\\"); `\X` other than the closing `\"`.
const ESC_DQ = String.raw`\\"(?:[^"\\]|\\\\\\[\s\S]|\\[^"])*(?:\\")?`;
const DQ = String.raw`"(?:[^"\\]|\\[\s\S])*"?`;
const SQ = String.raw`'(?:[^'\\]|\\[\s\S])*'?`;
const BQ = `${BT}(?:[^${BT}\\\\]|\\\\[\\s\\S])*${BT}?`;
const UNQUOTED = String.raw`(?!\[REDACTED)[^\s&;,"'<>]+`;
const SECRET_VALUE = `(?:${ESC_DQ}|${DQ}|${SQ}|${BQ}|${UNQUOTED})`;
const JSON_VALUE = `(?:${ESC_DQ}|${DQ})`;
/** A JSON key, optionally with backslash-escaped quotes (double-encoded JSON). */
const jsonKey = (key: string) => String.raw`(\\?"(?:` + key + String.raw`)\\?"\s*:\s*)`;

/** Keep a value's delimiter style; replace its content. */
function redactValue(prefix: string, value: string): string {
  if (value.startsWith('\\"')) return `${prefix}\\"[REDACTED]\\"`;
  const q = value[0];
  return q === '"' || q === "'" || q === BT ? `${prefix}${q}[REDACTED]${q}` : `${prefix}[REDACTED]`;
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
const JSON_SECRET_RE = new RegExp(`${jsonKey(SECRET_KEYS)}(${JSON_VALUE})`, 'gi');
const JSON_ENV_SECRET_RE = new RegExp(`${jsonKey(ENV_KEY)}(${JSON_VALUE})`, 'g');
const KV_SECRET_RE = new RegExp(`\\b((?:${SECRET_KEYS})\\s*[=:]\\s*)(${SECRET_VALUE})`, 'gi');
const KV_ENV_SECRET_RE = new RegExp(`\\b(${ENV_KEY}\\s*[=:]\\s*)(${SECRET_VALUE})`, 'g');

/**
 * PEM blocks, without a regex: `[\s\S]*?-----END` re-scanned the rest of the
 * text from every BEGIN (quadratic on repeated BEGINs). One forward pass; an
 * unterminated block is redacted up to the next BEGIN or the end.
 */
function redactPem(text: string): string {
  const BEGIN = '-----BEGIN ';
  const END = '-----END ';
  let out = '';
  let pos = 0;
  // Position of the next END marker at/after the current body (-1: none left).
  // Cached so a run of BEGINs without an END does not re-scan to the end of
  // the text each time.
  let endIdx = -2;
  for (;;) {
    const begin = text.indexOf(BEGIN, pos);
    if (begin === -1) return out + text.slice(pos);
    const headerEnd = text.indexOf('-----', begin + BEGIN.length);
    if (headerEnd === -1 || headerEnd - begin > BEGIN.length + 64) {
      // Not a PEM header: keep it and move on.
      out += text.slice(pos, begin + BEGIN.length);
      pos = begin + BEGIN.length;
      continue;
    }
    const bodyStart = headerEnd + 5;
    const nextBegin = text.indexOf(BEGIN, bodyStart);
    if (endIdx !== -1 && endIdx < bodyStart) endIdx = text.indexOf(END, bodyStart);
    const end = endIdx;
    let stop: number;
    if (end !== -1 && (nextBegin === -1 || end < nextBegin)) {
      const endClose = text.indexOf('-----', end + END.length);
      stop = endClose !== -1 && endClose - end <= END.length + 64 ? endClose + 5 : end + END.length;
    } else {
      stop = nextBegin === -1 ? text.length : nextBegin;
    }
    out += text.slice(pos, begin) + '[REDACTED_PEM]';
    pos = stop;
  }
}

/**
 * URL tokens — one bounded, LINEAR forward scan instead of length-capped
 * regexes (a 2,048-char userinfo cap let `https://user:<3,000 chars>@host`
 * through; a query matcher that stopped at quotes left `?foo="SECRET"`).
 *
 * A token starts at `scheme://` (any scheme, any case), at its JSON-escaped
 * form `scheme:\/\/` or double-escaped form `scheme:\\\/\\\/`, or at a
 * scheme-relative `//` that follows the start of the text, whitespace, a
 * quote, a bracket, `=` or `,`.
 */
const URL_START = /([a-z][a-z0-9+.-]{0,31}:)?(\/\/|\\\/\\\/|\\\\\\\/\\\\\\\/)/gi;
const SCHEME_RELATIVE_AFTER = /[\s"'`(=,<>[{]/;
const WS = /\s/;
const QUOTES = '"\'`';

/** Where the next URL token starts at/after `from` (or null). */
function nextUrlStart(text: string, from: number): { start: number; authStart: number } | null {
  URL_START.lastIndex = from;
  for (let m = URL_START.exec(text); m; m = URL_START.exec(text)) {
    const start = m.index;
    if (m[1] || start === 0 || SCHEME_RELATIVE_AFTER.test(text[start - 1])) {
      return { start, authStart: start + m[0].length };
    }
  }
  return null;
}

/**
 * (a) Userinfo: everything between `://` and the LAST `@` before the authority
 * end is replaced, however long. The authority ends at `/ ? #`, whitespace or
 * a quote (double, single or backtick — so a host-only URL in one JSON field
 * never runs into the next field; an escaped `\"` ends it at its quote). A
 * JSON-escaped `\/` ends it at its `/`. It does NOT end at a backslash:
 * Windows / NTLM `DOMAIN\user:password@proxy` credentials contain one.
 *
 * A literal `/ ? #` inside a password (`user:pa/ss@host`) ends the authority
 * early; so when the authority contains `:` and no `@`, the userinfo is
 * extended to the last `@` before whitespace or a quote in the same token.
 * That over-redacts `host:port/path/bob@corp` (accepted) but never crosses
 * whitespace / a quote. The run end and its last `@` are cached and only move
 * forward, so the scan stays linear.
 */
function redactUrlUserinfo(text: string): string {
  let out = '';
  let pos = 0;
  let from = 0;
  let runEnd = -1; // end (exclusive) of the cached whitespace/quote-free run
  let runLastAt = -1; // last '@' in that run
  for (let u = nextUrlStart(text, from); u; u = nextUrlStart(text, from)) {
    let i = u.authStart;
    let lastAt = -1;
    let colons = 0;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (c === '/' || c === '?' || c === '#' || WS.test(c) || QUOTES.includes(c)) break;
      if (c === '@') lastAt = i;
      else if (c === ':') colons += 1;
    }
    // Resume the start search right after this `//`: a URL glued to this
    // authority (`https://a.example,http://u:p@b`) has its `//` at or after
    // `i`, so it is never skipped — and the next authority starts past `i`,
    // so nothing is scanned twice (linear).
    let resumeAt = u.authStart;
    // A `:` right before a `//` is the scheme of a URL glued to this one
    // (`https://a.example,http://…`), not a password separator.
    const gluedScheme = text[i - 1] === ':' && text.startsWith('//', i) ? 1 : 0;
    if (lastAt === -1 && colons > gluedScheme && i < text.length && !WS.test(text[i])) {
      if (u.authStart >= runEnd) {
        let j = u.authStart;
        runLastAt = -1;
        for (; j < text.length; j += 1) {
          const c = text[j];
          if (WS.test(c) || QUOTES.includes(c)) break;
          if (c === '@') runLastAt = j;
        }
        runEnd = j;
      }
      if (runLastAt > i) {
        lastAt = runLastAt;
        resumeAt = runLastAt; // everything before it is redacted
      }
    }
    if (lastAt !== -1) {
      out += text.slice(pos, u.authStart) + '[REDACTED]';
      pos = lastAt; // keep the '@'
    }
    from = resumeAt;
  }
  return out + text.slice(pos);
}

/**
 * End of the LINE that starts at `j`: the next REAL `\n` / `\r`, or the end
 * of the text. A backslash + `n` / `r` is NOT a line end: in a text/plain body
 * it is forgeable (`?dir=C:\new\data&code=SECRET`), so a JSON body's escaped
 * `\n` is over-redacted instead (accepted). No quote or escape parsing —
 * every such parser had a bypass. One forward pass: linear.
 */
function lineEnd(text: string, j: number): number {
  for (let k = j; k < text.length; k += 1) {
    const c = text[k];
    if (c === '\n' || c === '\r') return k;
  }
  return text.length;
}

/**
 * (b) Query and fragment: from the first `?` or `#` after the scheme to the
 * end of the line (lineEnd) is replaced (`?[REDACTED]` / `#[REDACTED]`);
 * scheme, host and path are kept. Over-redacting the rest of the line is
 * accepted (upstream error logs keep 300 chars anyway); leaking is not. The
 * scan resumes after the redacted span, so every char is visited once.
 */
function redactUrlQueries(text: string): string {
  let out = '';
  let pos = 0;
  let from = 0;
  for (let u = nextUrlStart(text, from); u; u = nextUrlStart(text, from)) {
    let i = u.authStart;
    while (i < text.length && text[i] !== '?' && text[i] !== '#' && !WS.test(text[i])) i += 1;
    if (i < text.length && (text[i] === '?' || text[i] === '#')) {
      const end = lineEnd(text, i + 1);
      out += text.slice(pos, i + 1) + '[REDACTED]';
      pos = end;
      i = end;
    }
    from = Math.max(i, u.authStart);
  }
  return out + text.slice(pos);
}

function redactUrls(text: string): string {
  return redactUrlQueries(redactUrlUserinfo(text));
}

/**
 * Patterns, applied in order (most specific first). Each replaces the secret
 * part with a `[REDACTED…]` marker and keeps enough context to stay useful.
 * Every rule must stay LINEAR (src/costsource/transports/redactLinear.test.ts).
 */
type Replacement = string | ((match: string, ...groups: string[]) => string);

const RULES: Array<[RegExp, Replacement]> = [
  // URL userinfo / query / fragment: see redactUrls() (a linear scan, not a rule).
  // Azure storage connection-string secrets.
  [/\b(AccountKey|SharedAccessSignature)=[^;\s"'<>]+/gi, '$1=[REDACTED]'],
  // AWS SigV4 query / header credentials.
  [/\b(X-Amz-(?:Signature|Credential|Security-Token))(\s*[=:]\s*)[^\s&;,"'<>]+/gi, '$1$2[REDACTED]'],
  // Authorization header values: always redacted, whatever the scheme value.
  [/\b(Authorization\s*:\s*(?:Bearer|Basic|token))\s+("[^"]*"|'[^']*'|(?!\[REDACTED)[^\s"'<>,;]+)/gi, '$1 [REDACTED]'],
  // Bearer / Basic in free text (any case): only before a credential-shaped value.
  [FREE_TEXT_AUTH_RE, (match, scheme, _q, value) => (credentialShaped(scheme, value) ? `${scheme} [REDACTED]` : match)],
  // JWTs anywhere: three or more dot-separated segments starting `eyJ`. The
  // pattern consumes the whole `eyJ…` run (dots optional) and the callback
  // decides, so it never fails after scanning a long `[\w-]` run (the old
  // `[\w-]+\.` form was quadratic on `eyJa-eyJa-…`).
  [/\beyJ[\w-]*(?:\.[\w-]+)*/g, (match) => (match.split('.').length >= 3 ? '[REDACTED_JWT]' : match)],
  // GitHub tokens (classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_GITHUB_TOKEN]'],
  // OpenAI-style secret keys (sk-…, sk-proj-…).
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
  // JSON "secret_key": "value" — plain or double-encoded (\"key\":\"value\"),
  // and env-style keys ("RATIO_API_TOKEN": "value").
  [JSON_SECRET_RE, (_m, prefix, value) => redactValue(prefix, value)],
  [JSON_ENV_SECRET_RE, (_m, prefix, value) => redactValue(prefix, value)],
  // k=v / k: v secret fields: "…", '…', `…`, \"…\" (escaped) or unquoted.
  [KV_SECRET_RE, (_m, prefix, value) => redactValue(prefix, value)],
  [KV_ENV_SECRET_RE, (_m, prefix, value) => redactValue(prefix, value)],
  // Bare token=value (not one of the quoted forms handled above).
  [/\b(token\s*=\s*)(?!\[REDACTED|\\"|["'`])[^\s&;,"'<>]+/gi, '$1[REDACTED]'],
  // Bare SAS parameters.
  [SAS_RE, '$1=[REDACTED]'],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
];

/**
 * Every rule over the FULL text (no input cap). Exported for the linearity
 * guard test; callers use redactUpstreamText / redactErrorText.
 */
export function applyRedactionRules(text: string): string {
  let redacted = redactUrls(redactPem(text));
  for (const [re, replacement] of RULES) {
    redacted =
      typeof replacement === 'string'
        ? redacted.replace(re, replacement)
        : redacted.replace(re, (match: string, ...groups: string[]) => replacement(match, ...groups));
  }
  return redacted;
}

/**
 * Max characters of input that are redacted at all. Upstream bodies can be
 * megabytes; only a short prefix is ever logged, so the rest is dropped BEFORE
 * redaction, bounding the cost of every rule.
 */
export const MAX_REDACT_INPUT_CHARS = 16_384;
export const TRUNCATED_MARKER = ' …[TRUNCATED]';

/**
 * Cap the input for redaction. The cut moves back to the last delimiter, so a
 * secret straddling the cap is dropped whole — never left half-present in a
 * form no rule recognises (e.g. a JWT missing its signature part).
 */
function capForRedaction(text: string): string {
  if (text.length <= MAX_REDACT_INPUT_CHARS) return text;
  const head = text.slice(0, MAX_REDACT_INPUT_CHARS);
  let cut = head.length - 1;
  while (cut >= 0 && !/[\s,;&"'<>]/.test(head[cut])) cut -= 1;
  return (cut > 0 ? head.slice(0, cut) : '') + TRUNCATED_MARKER;
}

export function redactUpstreamText(text: string, maxChars = MAX_LOGGED_BODY_CHARS): string {
  return applyRedactionRules(capForRedaction(text)).slice(0, maxChars);
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
