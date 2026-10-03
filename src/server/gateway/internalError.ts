// Generic-500 discipline shared by withGateway and by the /api routes that are
// not wrapped in it. SERVER-SIDE ONLY.
//
// A caller never sees a thrown message (it can carry upstream / provider text
// or echoed input): they get a fixed message plus a random correlation id,
// also returned as X-Request-Id. The message itself goes to the server log as
// one structured JSON line, redacted (Bearer tokens, URL query strings / SAS,
// AWS key ids), under the same requestId.

import { randomUUID } from 'crypto';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { redactErrorText } from '@/costsource/transports/redact';

/** The ONLY message a caller ever sees for an unhandled error. */
export const INTERNAL_ERROR_MESSAGE = 'Internal error';

/** Logged instead of a request target that is not a plain path. */
export const NON_PATH_TARGET = '[non-path request target]';
/** Targets longer than this are not parsed at all. */
const MAX_TARGET_CHARS = 8_192;
/** A logged pathname is cut to this many characters. */
const MAX_LOGGED_PATH_CHARS = 512;

// Origin-form (`/…`, incl. `//host` and `/\host`, which a URL parser reads as
// an authority), a leading backslash (`\\host\…`), or an http(s) absolute-form
// target with `//` or `\\`. Everything else — authority-form (CONNECT
// host:443), other / opaque schemes, encoded-slash tricks — is not a path.
const PATH_LIKE = /^(?:[/\\]|https?:[/\\]{2})/i;
// A pathname that still looks like it carries an authority / credentials.
const CREDENTIAL_SHAPED = /@|%40|%2f%2f|%5c%5c/i;

/**
 * The request PATHNAME only — the single function every log line uses for a
 * request target. Node keeps the raw request-target in req.url, including
 * absolute-form `http://user:secret@host/p?x=1`, so splitting on `?` is not
 * enough: the target is parsed against a fixed base and only `.pathname` is
 * kept (no userinfo, host, query or fragment). Anything that is not a plain
 * path becomes a fixed placeholder; it never throws.
 */
export function pathOnly(url: string | undefined): string {
  if (typeof url !== 'string' || url.length === 0) return '';
  if (url === '*') return '*'; // asterisk-form (OPTIONS *)
  if (url.length > MAX_TARGET_CHARS || !PATH_LIKE.test(url)) return NON_PATH_TARGET;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return NON_PATH_TARGET;
  }
  if (CREDENTIAL_SHAPED.test(pathname)) return NON_PATH_TARGET;
  return pathname.length > MAX_LOGGED_PATH_CHARS ? `${pathname.slice(0, MAX_LOGGED_PATH_CHARS)}…` : pathname;
}

export interface InternalErrorContext {
  method?: string;
  path?: string;
  tenant?: string;
}

/** Log the redacted error under a fresh requestId; returns the id. */
export function logInternalError(err: unknown, ctx: InternalErrorContext = {}): string {
  const requestId = randomUUID();
  console.error(
    JSON.stringify({
      tag: 'gateway',
      event: 'unhandled_error',
      requestId,
      method: ctx.method ?? 'UNKNOWN',
      path: pathOnly(ctx.path),
      ...(ctx.tenant ? { tenant: ctx.tenant } : {}),
      status: 500,
      error: redactErrorText(err),
    }),
  );
  return requestId;
}

/**
 * Log + answer a generic 500 in the flat `{ error, requestId }` envelope the
 * non-gateway routes use. No-op on the response if headers were already sent.
 */
export function sendInternalError(req: NextApiRequest, res: NextApiResponse, err: unknown): void {
  const requestId = logInternalError(err, { method: req.method, path: req.url });
  if (res.headersSent) return;
  res.setHeader('X-Request-Id', requestId);
  res.status(500).json({ error: INTERNAL_ERROR_MESSAGE, requestId });
}

/** Wrap a non-gateway route so any throw becomes the generic flat 500. */
export function withInternalErrorGuard<T = unknown>(handler: NextApiHandler<T>): NextApiHandler<T> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      sendInternalError(req, res as NextApiResponse, err);
    }
  };
}

/**
 * Structured log line for a 4xx whose detail is NOT returned to the caller
 * (the caller gets a fixed string). Operators keep the specifics.
 */
export function logClientErrorDetail(status: number, err: unknown, ctx: InternalErrorContext = {}): void {
  console.warn(
    JSON.stringify({
      tag: 'api',
      event: 'client_error_detail',
      method: ctx.method ?? 'UNKNOWN',
      path: pathOnly(ctx.path),
      status,
      error: redactErrorText(err),
    }),
  );
}
