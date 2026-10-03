// withGateway (Wave3b) — the single composable server-side entry point that
// guards an /api handler with the repo's API-First concerns (.obvious/obvious.md):
// method guard, payload-size limit, Bearer auth (one key per tenant), per-tenant
// rate limiting (1,000 req/min), input validation, a consistent error envelope,
// and structured request logging. Provider adapters stay BEHIND this gate — never
// imported into the client bundle.
//
// Composability: takes a handler, returns a guarded NextApiHandler. Apply it to
// any /api route; the chat route is the first consumer.
//
// Middleware order: method → size → auth → rate-limit → validate → dispatch.

import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { checkAuth, isStrongToken, resolveGatewayAuth, type GatewayEnv } from './auth';
import { redactErrorText } from '@/costsource/transports/redact';
import {
  SlidingWindowRateLimiter,
  type RateLimitResult,
} from './rateLimit';

/** Per-request context handed to the wrapped handler. */
export interface GatewayContext {
  /** Tenant id derived from the API token, or 'anonymous' when auth is not enforced. */
  tenant: string;
}

export type GatewayHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  ctx: GatewayContext,
) => Promise<void> | void;

export type GatewayValidation = { ok: true } | { ok: false; message: string };

export interface GatewayLogEntry {
  method: string;
  path: string;
  tenant: string;
  status: number;
  latencyMs: number;
}

export interface GatewayOptions {
  /** Allowed HTTP methods. Default: ['POST']. */
  methods?: string[];
  /** Route-specific body validator — a 400 envelope is returned on failure. */
  validateBody?: (body: unknown) => GatewayValidation;
  /** Reject bodies larger than this many bytes. Default: 100 KB. */
  maxBodyBytes?: number;
  /** Override the shared limiter (tests inject a deterministic instance). */
  limiter?: SlidingWindowRateLimiter;
  /** Override request logging (tests pass a no-op or a spy). */
  logger?: (entry: GatewayLogEntry) => void;
  /** Override the environment source (tests inject a fixture env). */
  env?: GatewayEnv;
}

/** Consistent error envelope: { error: { code, message } }. Never a stack trace. */
export interface GatewayErrorBody {
  error: { code: string; message: string };
}

export function sendError(
  res: NextApiResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } } satisfies GatewayErrorBody);
}

const DEFAULT_MAX_BODY_BYTES = 100_000;

let warnedWeakToken = false;

/**
 * Gateway routes (AI chat, change management) still accept a weak
 * RATIO_API_TOKEN — only live cost data refuses it — but the operator is told
 * once per process.
 */
function warnIfWeakToken(env: GatewayEnv): void {
  const token = env.RATIO_API_TOKEN?.trim();
  if (warnedWeakToken || !token || isStrongToken(token)) return;
  warnedWeakToken = true;
  console.warn(
    JSON.stringify({
      tag: 'gateway',
      warning:
        'RATIO_API_TOKEN is weak (needs >= 32 chars and >= 10 distinct characters); live cost data is refused until it is rotated.',
    }),
  );
}

// One process-wide limiter shared across every wrapped route (single-instance
// demo). See rateLimit.ts for the production (shared-store) note.
const sharedLimiter = new SlidingWindowRateLimiter();

function defaultLogger(entry: GatewayLogEntry): void {
  // One structured line per request. No secrets — tenant is a hashed id.
  console.info(JSON.stringify({ tag: 'gateway', ...entry }));
}

function approximateBytes(body: unknown): number {
  if (body == null) return 0;
  try {
    return Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body));
  } catch {
    return 0;
  }
}

function setRateLimitHeaders(res: NextApiResponse, rl: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', String(rl.limit));
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(rl.resetMs / 1000)));
}

export function withGateway(
  handler: GatewayHandler,
  options: GatewayOptions = {},
): NextApiHandler {
  const methods = options.methods ?? ['POST'];
  const limiter = options.limiter ?? sharedLimiter;
  const logger = options.logger ?? defaultLogger;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const env = options.env ?? process.env;

  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    warnIfWeakToken(env);
    const start = Date.now();
    let tenant = 'anonymous';
    const finish = (status: number) =>
      logger({
        method: req.method ?? 'UNKNOWN',
        path: req.url ?? '',
        tenant,
        status,
        latencyMs: Date.now() - start,
      });

    // 1. Method guard.
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', '));
      sendError(res, 405, 'method_not_allowed', `Method ${req.method ?? 'UNKNOWN'} not allowed`);
      finish(405);
      return;
    }

    // 2. Payload-size guard — trust Content-Length when present, else estimate.
    const contentLength = Number(req.headers['content-length'] ?? 0);
    const bytes =
      Number.isFinite(contentLength) && contentLength > 0
        ? contentLength
        : approximateBytes(req.body);
    if (bytes > maxBodyBytes) {
      sendError(res, 413, 'payload_too_large', `Request body exceeds ${maxBodyBytes} bytes`);
      finish(413);
      return;
    }

    // 3. Bearer auth (offline-safe: bypassed for mock + no token).
    const auth = checkAuth(req.headers.authorization, resolveGatewayAuth(env));
    if (!auth.ok) {
      sendError(res, 401, auth.code, auth.message);
      finish(401);
      return;
    }
    tenant = auth.tenant;

    // 4. Per-tenant rate limit.
    const rl = limiter.take(tenant);
    setRateLimitHeaders(res, rl);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      sendError(res, 429, 'rate_limited', 'Rate limit exceeded: 1000 requests per minute');
      finish(429);
      return;
    }

    // 5. Route-specific input validation.
    if (options.validateBody) {
      const result = options.validateBody(req.body);
      if (!result.ok) {
        sendError(res, 400, 'invalid_request', result.message);
        finish(400);
        return;
      }
    }

    // 6. Dispatch to the guarded handler.
    try {
      await handler(req, res, { tenant });
    } catch (err) {
      // Never leak a stack trace — only the message in the envelope, redacted
      // (Bearer tokens, URL query strings / SAS, AWS key ids) as a second line
      // of defence against upstream text reaching the caller.
      const message = redactErrorText(err);
      if (!res.headersSent) sendError(res, 500, 'internal_error', message);
    } finally {
      finish(res.statusCode);
    }
  };
}
