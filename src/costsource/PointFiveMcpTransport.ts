// PointFive MCP-over-SSE transport seam (PR E).
//
// PointFive's only public programmatic surface is the MCP Server at
// mcp.pointfive.co/sse (OAuth 2.1); there is no public REST API (art_gvr7b5Ne
// §2). The live adapter therefore speaks MCP. This module defines:
//   - the native PointFive payload shapes (Opportunities, Anomalies, FOCUS rows)
//   - the `PointFiveMcpClient` transport interface the adapter depends on
//   - `SsePointFiveMcpClient`, a scaffolding implementation over the SSE endpoint
//
// The interface is the seam: tests inject a fake transport, so no real network
// call is ever made in tests or CI. The SSE implementation is never exercised in
// the default dark build; the exact JSON-RPC/SSE wire framing must be validated
// against a live PointFive account during trial setup (the spec's parity caveat).

import type { CostWindow } from './CostSourceClient';
import type { RawSourceRow } from './focusRows';
import type { PointFiveCredentials } from './pointfiveConfig';
import type { PointFiveOAuthClient } from './PointFiveOAuthClient';
import { logUpstreamError, readJsonBody, statusReason } from './transports/focusExport';

/** PointFive DeepWaste Opportunity (savings finding). */
export interface PointFiveOpportunity {
  id: string;
  resourceId: string;
  category: string; // e.g. 'idle_resource', 'rightsizing'
  title: string;
  estimatedMonthlySavings: number;
  severity: 'info' | 'warning' | 'critical';
  detectedAt: string; // ISO 8601
}

/** PointFive Anomaly (unexpected-spend finding). */
export interface PointFiveAnomaly {
  id: string;
  resourceId: string;
  category: string; // e.g. 'spend_spike'
  title: string;
  observedSpendDelta: number;
  severity: 'info' | 'warning' | 'critical';
  detectedAt: string; // ISO 8601
}

// PointFive exports FOCUS-certified rows (documented v1.0). A native billing row
// is therefore a FOCUS source row that the existing version shim upgrades to the
// v1.4 canonical model — the adapter does not reimplement normalization.
export type PointFiveFocusRow = RawSourceRow;

/**
 * Transport the live adapter depends on — one method per PointFive MCP tool
 * category used by Ratio (Billing Data → cost rows; Opportunities + Anomalies
 * → findings). `ping` covers the health probe. Only the adapter (auth, fetch,
 * identity) is source-specific; downstream the engine sees normalized rows.
 */
export interface PointFiveMcpClient {
  /** Lightweight reachability/auth probe against the MCP server. */
  ping(): Promise<boolean>;
  /** Billing Data tool — FOCUS-shaped cost rows for a window. */
  fetchBillingRows(window: CostWindow): Promise<PointFiveFocusRow[]>;
  /** Opportunities tool — savings findings. */
  listOpportunities(): Promise<PointFiveOpportunity[]>;
  /** Anomalies tool — unexpected-spend findings. */
  listAnomalies(): Promise<PointFiveAnomaly[]>;
}

/** Factory the adapter uses to build a transport once it is configured. */
export type PointFiveMcpClientFactory = (
  credentials: PointFiveCredentials,
  oauth: PointFiveOAuthClient,
) => PointFiveMcpClient;

// MCP tool names on the PointFive server (art_gvr7b5Ne §2). Centralized so the
// scaffolding and any future live wiring agree on the surface.
export const POINTFIVE_MCP_TOOLS = {
  billing: 'billing_data',
  opportunities: 'opportunities',
  anomalies: 'anomalies',
} as const;

/**
 * Scaffolding MCP-over-SSE client. Authenticates with the OAuth token source,
 * then issues JSON-RPC `tools/call` requests to the SSE endpoint. This is the
 * shape a live integration takes; it is NOT exercised in tests or the dark
 * build. The concrete SSE event framing is intentionally thin and must be
 * confirmed against a real PointFive account during trial setup.
 */
export class SsePointFiveMcpClient implements PointFiveMcpClient {
  constructor(
    private readonly credentials: PointFiveCredentials,
    private readonly oauth: PointFiveOAuthClient,
  ) {}

  async ping(): Promise<boolean> {
    // A real ping issues an MCP `initialize` handshake; reaching here means the
    // adapter was configured. Acquiring a token proves OAuth + reachability.
    await this.oauth.getAccessToken();
    return true;
  }

  async fetchBillingRows(window: CostWindow): Promise<PointFiveFocusRow[]> {
    return this.callTool<PointFiveFocusRow[]>(POINTFIVE_MCP_TOOLS.billing, {
      start: window.start,
      end: window.end,
    });
  }

  async listOpportunities(): Promise<PointFiveOpportunity[]> {
    return this.callTool<PointFiveOpportunity[]>(POINTFIVE_MCP_TOOLS.opportunities, {});
  }

  async listAnomalies(): Promise<PointFiveAnomaly[]> {
    return this.callTool<PointFiveAnomaly[]>(POINTFIVE_MCP_TOOLS.anomalies, {});
  }

  // JSON-RPC `tools/call` over the SSE endpoint, bearer-authenticated. The exact
  // SSE decoding is a trial-setup detail; this keeps the call shape honest.
  private async callTool<T>(tool: string, args: Record<string, string>): Promise<T> {
    const accessToken = await this.oauth.getAccessToken();
    const res = await fetch(this.credentials.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    });
    const label = `PointFive MCP tool '${tool}'`;
    if (!res.ok) {
      // Status + fixed reason only; the body is logged server-side, redacted.
      const text = await res.text().catch(() => '');
      if (text) logUpstreamError(label, res.status, text);
      throw new Error(`${label} returned ${res.status} (${statusReason(res.status)})`);
    }
    const payload = await readJsonBody<{ result?: { structuredContent?: T } }>(res, label);
    const content = payload.result?.structuredContent;
    if (content === undefined) {
      throw new Error(`PointFive MCP tool '${tool}' returned no structured content`);
    }
    return content;
  }
}

