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
import { publishedCostsConfig } from './config';
import { sendError, withGateway, type GatewayLogEntry } from '@/server/gateway';
import { randomUUID } from 'crypto';
import { INTERNAL_ERROR_MESSAGE, logInternalError, pathOnly } from '@/server/gateway/internalError';
import { engagementMode } from '@/engagement/config';
import type { Permission } from '@/engagement/auth/authz';
import { checkReportAccess, type ReportAccessDeps } from '@/engagement/auth/reportAccess';
import { LoginGate } from '@/engagement/auth/routes';
import { SlidingWindowRateLimiter as Limiter } from '@/server/gateway/rateLimit';

const sharedSessionLimiter = new Limiter(60, 60_000);
const sharedRenderGate = new LoginGate(2);
import { evaluateLiveDataAuth, THROTTLED_MESSAGE, WEAK_TOKEN_MESSAGE, type LiveAuthResult } from '@/server/gateway/liveDataAuth';
import type { SlidingWindowRateLimiter } from '@/server/gateway/rateLimit';
import { parsePublishedCostsQuery } from './query';
import { readPublishedCosts } from './publishedCosts';
import { readerPool } from './readerPool';
import { READ_TIMEOUTS, readWithDeadline } from './readDeadline';
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
  /** Whole-request deadline for the database read (tests shorten it). */
  requestDeadlineMs?: number;
  /** Clock (tests pin it); used by reads that report an as-of time. */
  now?: () => Date;
  /** R2 slice C: the named-user session check of the report routes (tests inject the store, clock and audit sink). */
  access?: ReportAccessDeps;
  /** Session report reads per user (default 60 per minute, per process). */
  sessionLimiter?: SlidingWindowRateLimiter;
  /** Concurrent XLSX/PDF renders for session requests (default 2). */
  renderGate?: LoginGate;
}

type Parsed<Q> = { ok: true; value: Q } | { ok: false; message: string };

/** What differs between the island's routes: the log tag, the query parser and the read. */
export interface ReaderRouteSpec<Q> {
  tag: string;
  parse(query: Record<string, string | string[] | undefined>): Parsed<Q>;
  read(pool: Pick<Pool, 'connect'>, tenantId: string, q: Q, ctx: { env: Env; now: Date }): Promise<unknown>;
  /** Sends a successful read (default: 200 JSON). */
  respond?(res: NextApiResponse, body: unknown): void;
  /**
   * R2 slice C: in engagement mode a request WITHOUT an Authorization header is
   * a browser request: it needs a named-user session that authorize() allows
   * for this permission. Routes without it (published costs) stay machine-token only.
   */
  session?: { permission(q: Q): Permission; format(q: Q): string };
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

function isEngagement(env: Env): boolean {
  try {
    return engagementMode(env);
  } catch {
    return false; // an invalid RATIO_MODE keeps the machine path (which answers 503 not_configured)
  }
}

export function createPublishedCostsRoute(deps: PublishedCostsRouteDeps = {}): NextApiHandler {
  return createReaderRoute(deps, { tag: 'published-costs', parse: parsePublishedCostsQuery, read: (pool, tenantId, q) => readPublishedCosts(pool, tenantId, q) });
}

/** The shared route factory of the read-API island (auth, gateway, tenant binding, deadline, fail-closed errors). */
export function createReaderRoute<Q>(deps: PublishedCostsRouteDeps, spec: ReaderRouteSpec<Q>): NextApiHandler {
  const envOf = (): Env => deps.env ?? process.env;
  const poolFor = deps.poolFor ?? readerPool;
  const deadlineMs = deps.requestDeadlineMs ?? READ_TIMEOUTS.requestMs;

  async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
    const config = publishedCostsConfig(envOf());
    if (!config.ok) {
      sendError(res, 503, 'not_configured', ROUTE_MESSAGES.notConfigured);
      return;
    }
    const { tenantId, readerUrl } = config;
    const parsed = spec.parse(req.query ?? {});
    if (!parsed.ok) {
      sendError(res, 400, 'invalid_request', parsed.message);
      return;
    }
    try {
      // Bounded end to end (Copilot 4176494809): the tenant transaction, the
      // login check and the reads; a stuck client is destroyed, not pooled.
      const now = (deps.now ?? (() => new Date()))();
      const body = await readWithDeadline(poolFor(readerUrl), (p) => spec.read(p, tenantId, parsed.value, { env: envOf(), now }), deadlineMs);
      if (spec.respond) spec.respond(res, body);
      else res.status(200).json(body);
    } catch (err) {
      if (err instanceof UnsafeReaderLoginError) {
        // A distinct, expected refusal (not an unhandled 500): one structured
        // event with fixed reason CODES (the problem texts can name roles and
        // are never logged or returned) and a correlation id the caller gets
        // too, as on every other error path.
        const requestId = randomUUID();
        console.error(
          JSON.stringify({
            tag: spec.tag,
            event: 'unsafe_db_login',
            requestId,
            method: req.method ?? 'UNKNOWN',
            path: pathOnly(req.url),
            status: 503,
            reasons: err.reasons,
          }),
        );
        res.setHeader('X-Request-Id', requestId);
        res.status(503).json({ error: { code: 'unsafe_db_login', message: ROUTE_MESSAGES.unsafeLogin, requestId } });
        return;
      }
      throw err; // the gateway answers a generic 500 with a requestId
    }
  }

  return async function publishedCostsRoute(req: NextApiRequest, res: NextApiResponse): Promise<void> {
    // No response of this route may be cached, whichever layer writes it:
    // auth failures here, the gateway's 405/413/429/500, our 400/503/200.
    res.setHeader('Cache-Control', 'no-store');
    const env = envOf();
    if (spec.session && req.headers.authorization === undefined && isEngagement(env)) {
      // Session path: authentication and authorization before the query and the method; the DB only after an allow.
      res.setHeader('Vary', 'Cookie');
      const parsed = spec.parse(req.query ?? {});
      const access = checkReportAccess(req, env, parsed.ok ? spec.session.permission(parsed.value) : 'reports:read', parsed.ok ? spec.session.format(parsed.value) : 'invalid', deps.access);
      if (!access.ok) return sendError(res, access.status, access.code, access.message);
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendError(res, 405, 'method_not_allowed', 'Method not allowed');
      }
      const rl = (deps.sessionLimiter ?? sharedSessionLimiter).take(`u:${access.userId}`);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        return sendError(res, 429, 'rate_limited', 'Too many report requests. Try again later.');
      }
      // XLSX/PDF renders are CPU and memory heavy: a small global cap for session requests.
      const gate = parsed.ok && spec.session.permission(parsed.value) === 'reports:export' ? (deps.renderGate ?? sharedRenderGate) : null;
      if (gate && !gate.tryEnter()) {
        res.setHeader('Retry-After', '1');
        return sendError(res, 503, 'busy', 'Report export is busy. Try again in a moment.');
      }
      try {
        await handler(req, res);
      } catch (err) {
        const requestId = logInternalError(err, { method: req.method, path: req.url });
        if (!res.headersSent) res.status(500).json({ error: { code: 'internal_error', message: INTERNAL_ERROR_MESSAGE, requestId } });
      } finally {
        gate?.leave();
      }
      return;
    }
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
