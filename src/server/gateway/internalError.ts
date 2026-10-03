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

/**
 * The request pathname only. Query strings can carry session ids, OAuth
 * tokens or SAS signatures, so they are never written to a log.
 */
export function pathOnly(url: string | undefined): string {
  return (url ?? '').split('?')[0];
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
