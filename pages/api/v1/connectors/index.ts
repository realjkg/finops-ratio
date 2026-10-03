// GET /api/v1/connectors[?probe=true] — the connector registry, for automation.
//
// Lists every cost source with the env contract that connects it (names only,
// never values). The server-resolved connection state and summary counts are
// disclosed only to authenticated callers (valid Bearer, token configured);
// anonymous callers get the env-independent projection, as
// /api/costsource/sources does. With `probe=true`, it
// also runs a live health check against every CONFIGURED connector in parallel
// — a scheduler, uptime monitor, or IaC pipeline can call this after deploying
// credentials to verify on-prem, private-cloud, and public-cloud sources end to
// end. Unconfigured connectors are never probed (no network calls).
//
// Behind the API gateway (method guard, per-tenant rate limit, Bearer auth when
// RATIO_API_TOKEN is set or a live AI provider is selected) under /v1/ per the
// API-First rule. `probe=true` invokes connectors with SERVER credentials, so it
// additionally requires a configured RATIO_API_TOKEN and a matching Bearer token
// regardless of gateway enforcement; otherwise 401 and no connector is invoked
// (503 when the configured token is weaker than 32 characters).
//
// Failed-auth accounting: every request is evaluated by the shared live-data
// auth helper BEFORE the gateway, so a wrong bearer counts even when the
// gateway itself rejects it; over the limit, such requests get 429. A valid
// token always passes.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createCostSourceClient } from '@/costsource';
import type { CostSourceDescriptor, SourceHealth } from '@/costsource';
import { sendError, withGateway } from '@/server/gateway';
import {
  evaluateLiveDataAuth,
  isOfflineSandboxSource,
  THROTTLED_MESSAGE,
  WEAK_TOKEN_MESSAGE,
  type LiveAuthResult,
} from '@/server/gateway/liveDataAuth';
import { redactErrorText } from '@/costsource/transports/redact';
import { anonymousSourceView } from '@/costsource/sourceDisclosure';

export interface ConnectorRegistryResponse {
  connectors: CostSourceDescriptor[];
  summary: { connected: number; available: number; incomplete: number; disabled: number };
  /** Present only with probe=true: health of each configured connector. */
  health?: SourceHealth[];
}

const PROBE_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function wantsProbe(req: NextApiRequest): boolean {
  const probe = String(req.query?.probe ?? '').toLowerCase();
  return probe === 'true' || probe === '1';
}

// The shared auth evaluation for this request, made once before the gateway.
const evaluated = new WeakMap<NextApiRequest, LiveAuthResult>();

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const probing = wantsProbe(req);
  const auth = evaluated.get(req) ?? evaluateLiveDataAuth(req, { countAbsent: probing });
  if (probing && auth.kind !== 'ok') {
    if (auth.kind === 'weak-token') sendError(res, 503, 'weak_token', WEAK_TOKEN_MESSAGE);
    else if (auth.kind === 'unauthorized') sendError(res, 401, auth.code, auth.message);
    else sendError(res, 401, 'unauthorized', 'Missing Authorization: Bearer <token> header');
    return;
  }

  const client = createCostSourceClient('mock');
  const resolved = await client.listSources();
  const connectors = auth.kind === 'ok' ? resolved : anonymousSourceView(resolved);
  const summary = { connected: 0, available: 0, incomplete: 0, disabled: 0 };
  for (const c of connectors) {
    if (c.connection) summary[c.connection] += 1;
  }

  const body: ConnectorRegistryResponse = { connectors, summary };

  if (probing) {
    // Every configured non-sandbox source — including PointFive live, whose
    // descriptor carries `configured` but no `connection` field.
    const live = connectors.filter((c) => c.configured && !isOfflineSandboxSource(c.id));
    body.health = await Promise.all(
      live.map((c) =>
        withTimeout(client.healthCheck(c.id), PROBE_TIMEOUT_MS, c.name).catch(
          (err): SourceHealth => ({
            sourceId: c.id,
            reachable: false,
            authed: false,
            sourceVersion: c.focusVersion,
            canonicalVersion: '1.4',
            checkedAt: new Date().toISOString(),
            detail: redactErrorText(err),
          }),
        ),
      ),
    );
  }

  res.status(200).json(body);
}

const guarded = withGateway(handler, { methods: ['GET'] });

export default async function connectorsRoute(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // Count wrong bearers before the gateway can reject them (no token oracle).
  const auth = evaluateLiveDataAuth(req, { countAbsent: wantsProbe(req) });
  if (auth.kind === 'throttled') {
    res.setHeader('Retry-After', String(auth.retryAfterSec));
    sendError(res, 429, 'rate_limited', THROTTLED_MESSAGE);
    return;
  }
  evaluated.set(req, auth);
  await guarded(req, res);
}
