// GET /api/v1/costs/published — the tenant's published cost facts.
//
// Authentication is the repo's EXISTING mechanism, unchanged:
//   1. evaluateLiveDataAuth (src/server/gateway/liveDataAuth.ts), BEFORE any
//      other work: deny by default (no RATIO_API_TOKEN configured ⇒ 401), weak
//      configured token ⇒ 503, wrong/missing Bearer ⇒ 401, repeated failures
//      from one client ⇒ 429; a valid token is never throttled;
//   2. withGateway (GET only): 405, body-size guard, the gateway's own token
//      check, per-tenant rate limit, structured request log, generic 500.
// Tenant: "one API key per tenant" — the configured key is bound server-side
// to its Ratio tenant by RATIO_API_TENANT_ID. The tenant is NEVER read from
// the request (a `tenant` parameter is an unknown parameter ⇒ 400).
// Database identity: RATIO_READER_DATABASE_URL, a LOGIN member of
// ratio_reader, checked on EVERY request before anything is read
// (readerLogin.ts) ⇒ 503 unsafe_db_login when unsafe.
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import type { Pool } from 'pg';
import { isTenantId } from '@/ingest/db/tenant';
import { sendError, withGateway, type GatewayLogEntry } from '@/server/gateway';
import { logInternalError } from '@/server/gateway/internalError';
import { evaluateLiveDataAuth, THROTTLED_MESSAGE, WEAK_TOKEN_MESSAGE, type LiveAuthResult } from '@/server/gateway/liveDataAuth';
import type { SlidingWindowRateLimiter } from '@/server/gateway/rateLimit';
import { parsePublishedCostsQuery } from './query';
import { readPublishedCosts } from './publishedCosts';
import { readerPool } from './readerPool';
import { UnsafeReaderLoginError } from './readerLogin';

export const ROUTE_MESSAGES = {
  notConfigured: 'Published cost data is not configured on this server',
  unsafeLogin: 'Published cost data is unavailable: the server refused its database login',
} as const;

type Env = Record<string, string | undefined>;

export interface PublishedCostsRouteDeps {
  /** Environment source (tests inject a fixture env). Read on every request. */
  env?: Env;
  /** Pool factory for the reader URL (default: the process-wide reader pools). */
  poolFor?: (url: string) => Pick<Pool, 'connect'>;
  /** Gateway request logger override. */
  logger?: (entry: GatewayLogEntry) => void;
  /** Gateway rate limiter override. */
  limiter?: SlidingWindowRateLimiter;
}

function sendAuthFailure(res: NextApiResponse, auth: Exclude<LiveAuthResult, { kind: 'ok' }>): void {
  switch (auth.kind) {
    case 'weak-token':
      sendError(res, 503, 'weak_token', WEAK_TOKEN_MESSAGE);
      return;
    case 'throttled':
      res.setHeader('Retry-After', String(auth.retryAfterSec));
      sendError(res, 429, 'rate_limited', THROTTLED_MESSAGE);
      return;
    case 'unauthorized':
      sendError(res, 401, auth.code, auth.message);
      return;
    case 'absent':
      // Unreachable with countAbsent: true; refuse defensively.
      sendError(res, 401, 'unauthorized', 'Missing Authorization: Bearer <token> header');
      return;
  }
}

export function createPublishedCostsRoute(deps: PublishedCostsRouteDeps = {}): NextApiHandler {
  const envOf = (): Env => deps.env ?? process.env;
  const poolFor = deps.poolFor ?? readerPool;

  async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
    const env = envOf();
    const tenantId = env.RATIO_API_TENANT_ID ?? '';
    const readerUrl = env.RATIO_READER_DATABASE_URL?.trim() ?? '';
    if (!isTenantId(tenantId) || readerUrl === '') {
      sendError(res, 503, 'not_configured', ROUTE_MESSAGES.notConfigured);
      return;
    }
    const parsed = parsePublishedCostsQuery(req.query ?? {});
    if (!parsed.ok) {
      sendError(res, 400, 'invalid_request', parsed.message);
      return;
    }
    try {
      const page = await readPublishedCosts(poolFor(readerUrl), tenantId.toLowerCase(), parsed.value);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(page);
    } catch (err) {
      if (err instanceof UnsafeReaderLoginError) {
        // The reasons (role names, attributes) go only to the operator log, redacted.
        logInternalError(err, { method: req.method, path: req.url });
        sendError(res, 503, 'unsafe_db_login', ROUTE_MESSAGES.unsafeLogin);
        return;
      }
      throw err; // the gateway answers a generic 500 with a requestId
    }
  }

  return async function publishedCostsRoute(req: NextApiRequest, res: NextApiResponse): Promise<void> {
    const env = envOf();
    // Live-data auth first: nothing else (not even the method) is evaluated for an unauthenticated caller.
    const auth = evaluateLiveDataAuth(req, { countAbsent: true }, env);
    if (auth.kind !== 'ok') {
      sendAuthFailure(res, auth);
      return;
    }
    const guarded = withGateway(handler, { methods: ['GET'], env, logger: deps.logger, limiter: deps.limiter });
    await guarded(req, res);
  };
}
