// GET /api/v1/connectors[?probe=true] — the connector registry, for automation.
//
// Lists every cost source with its server-resolved connection state and the env
// contract that connects it (names only, never values). With `probe=true`, it
// also runs a live health check against every CONFIGURED connector in parallel
// — a scheduler, uptime monitor, or IaC pipeline can call this after deploying
// credentials to verify on-prem, private-cloud, and public-cloud sources end to
// end. Unconfigured connectors are never probed (no network calls).
//
// Behind the API gateway (method guard, per-tenant rate limit, Bearer auth when
// RATIO_API_TOKEN is set or a live AI provider is selected) under /v1/ per the
// API-First rule. `probe=true` invokes connectors with SERVER credentials, so it
// additionally requires a configured RATIO_API_TOKEN and a matching Bearer token
// regardless of gateway enforcement; otherwise 401 and no connector is invoked.

import type { NextApiRequest, NextApiResponse } from 'next';
import { createCostSourceClient } from '@/costsource';
import type { CostSourceDescriptor, SourceHealth } from '@/costsource';
import { sendError, withGateway } from '@/server/gateway';
import { requireLiveDataAuth } from '@/server/gateway/liveDataAuth';

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

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const probe = String(req.query.probe ?? '').toLowerCase();
  const wantsProbe = probe === 'true' || probe === '1';
  if (wantsProbe) {
    const auth = requireLiveDataAuth(req.headers.authorization);
    if (!auth.ok) {
      sendError(res, 401, auth.code, auth.message);
      return;
    }
  }

  const client = createCostSourceClient('mock');
  const connectors = await client.listSources();
  const summary = { connected: 0, available: 0, incomplete: 0, disabled: 0 };
  for (const c of connectors) {
    if (c.connection) summary[c.connection] += 1;
  }

  const body: ConnectorRegistryResponse = { connectors, summary };

  if (wantsProbe) {
    const live = connectors.filter((c) => c.connection === 'connected');
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
            detail: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
  }

  res.status(200).json(body);
}

export default withGateway(handler, { methods: ['GET'] });
