// PointFive live-adapter configuration (PR E) — feature flag + credential
// resolution for the gated live MCP SSE path.
//
// The live PointFive adapter SHIPS DARK: the COSTSOURCE_POINTFIVE_LIVE flag is
// OFF by default, and even when ON the adapter only goes live if OAuth 2.1
// credentials are present. No real PointFive credentials exist yet (partner
// outreach is a separately user-gated action), so in every default build this
// resolves to `disabled` — the adapter is registered but makes no network call.
//
// `resolvePointFiveStatus` is a pure function of an env record so the flag-OFF,
// unconfigured, and configured branches are all unit-testable without touching
// process.env or the network.

import type { CostSourceDescriptor } from './CostSourceClient';
import { parseToolMapping, type ToolMapping } from '../connectors/managed/pointfive/discovery';

/** Canonical id of the live PointFive source across the seam. */
export const POINTFIVE_LIVE_SOURCE_ID = 'pointfive-live';

/** Feature flag env var. OFF unless explicitly set to a truthy value. */
export const POINTFIVE_LIVE_FLAG_ENV = 'COSTSOURCE_POINTFIVE_LIVE';

/** Documented public PointFive MCP SSE endpoint (art_gvr7b5Ne §2). */
export const DEFAULT_POINTFIVE_MCP_URL = 'https://mcp.pointfive.co/sse';

/** PointFive documents FOCUS v1.0 cross-cloud exports (art_gvr7b5Ne §2). */
export const POINTFIVE_FOCUS_VERSION = '1.0' as const;

/** Resolved OAuth 2.1 + MCP connection settings for the live adapter. */
export interface PointFiveCredentials {
  mcpUrl: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthTokenUrl: string;
  /** Capability -> tool name; defaults are ASSUMED (see discovery.ts). */
  toolMapping?: ToolMapping;
}

/**
 * Live-adapter status, a discriminated union over the three real-world states:
 *   - `disabled`     — flag OFF; the adapter ships dark (default).
 *   - `unconfigured` — flag ON but one or more OAuth credentials are missing.
 *   - `configured`   — flag ON and all credentials present; live calls allowed.
 * Only `configured` ever permits a network call.
 */
export type PointFiveStatus =
  | { state: 'disabled' }
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'configured'; credentials: PointFiveCredentials };

// Env var names for the required OAuth 2.1 credentials. mcpUrl is optional and
// falls back to the documented public endpoint; the OAuth secrets are not
// public and must be supplied once a PointFive subscription exists.
const REQUIRED_OAUTH_ENV = {
  oauthClientId: 'POINTFIVE_OAUTH_CLIENT_ID',
  oauthClientSecret: 'POINTFIVE_OAUTH_CLIENT_SECRET',
  oauthTokenUrl: 'POINTFIVE_OAUTH_TOKEN_URL',
} as const;

export const POINTFIVE_MCP_URL_ENV = 'POINTFIVE_MCP_URL';
/** Optional `capability=tool,...` override of the ASSUMED tool names. */
export const POINTFIVE_MCP_TOOL_MAP_ENV = 'POINTFIVE_MCP_TOOL_MAP';

type EnvRecord = Record<string, string | undefined>;

/** True only if the feature flag is explicitly enabled. Default: false (dark). */
export function isPointFiveLiveEnabled(env: EnvRecord): boolean {
  const raw = env[POINTFIVE_LIVE_FLAG_ENV];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Resolve the live adapter's status from an env record. Pure — no process.env,
 * no I/O. Flag OFF short-circuits to `disabled` before any credential is read,
 * so a dark build never even inspects the OAuth env.
 */
export function resolvePointFiveStatus(env: EnvRecord): PointFiveStatus {
  if (!isPointFiveLiveEnabled(env)) return { state: 'disabled' };

  const missing: string[] = [];
  const resolved: Partial<PointFiveCredentials> = {};
  for (const [key, envName] of Object.entries(REQUIRED_OAUTH_ENV) as [
    keyof typeof REQUIRED_OAUTH_ENV,
    string,
  ][]) {
    const value = env[envName]?.trim();
    if (!value) missing.push(envName);
    else resolved[key] = value;
  }

  let toolMapping: ToolMapping | undefined;
  try {
    toolMapping = parseToolMapping(env[POINTFIVE_MCP_TOOL_MAP_ENV]);
  } catch {
    missing.push(POINTFIVE_MCP_TOOL_MAP_ENV); // invalid: named, never echoed
  }
  if (missing.length > 0) return { state: 'unconfigured', missing };

  return {
    state: 'configured',
    credentials: {
      mcpUrl: env[POINTFIVE_MCP_URL_ENV]?.trim() || DEFAULT_POINTFIVE_MCP_URL,
      oauthClientId: resolved.oauthClientId!,
      oauthClientSecret: resolved.oauthClientSecret!,
      oauthTokenUrl: resolved.oauthTokenUrl!,
      toolMapping,
    },
  };
}

/** Human-readable note for the source descriptor, per status. */
export function pointFiveStatusNote(status: PointFiveStatus): string {
  switch (status.state) {
    case 'disabled':
      return `Live MCP SSE + OAuth 2.1 adapter — feature flag ${POINTFIVE_LIVE_FLAG_ENV} is OFF; ships dark, no network calls (PR E).`;
    case 'unconfigured':
      return `Feature flag ON but OAuth credentials missing (${status.missing.join(', ')}); no network calls until configured.`;
    case 'configured':
      return 'Live PointFive MCP adapter configured (OAuth 2.1); not verified until the four-stage health check passes.';
  }
}

/**
 * Build the live PointFive source descriptor from a status. `configured` is
 * driven by the resolved status, so `listSources()` honestly reflects whether
 * the dark adapter has been switched on — without changing the engine or views.
 */
export function pointFiveLiveDescriptor(status: PointFiveStatus): CostSourceDescriptor {
  return {
    id: POINTFIVE_LIVE_SOURCE_ID,
    name: 'PointFive (live)',
    kind: 'pointfive',
    focusVersion: POINTFIVE_FOCUS_VERSION,
    coverage: 'public_cloud',
    capabilities: ['costRows', 'findings'],
    configured: status.state === 'configured',
    note: pointFiveStatusNote(status),
  };
}

