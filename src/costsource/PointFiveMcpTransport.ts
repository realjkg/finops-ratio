// PointFive MCP transport seam (PR E; protocol client M9a).
//
// PointFive's documented programmatic surface is an MCP server (OAuth 2.1;
// art_gvr7b5Ne §2, external research, NOT VERIFIED). This module defines:
//   - the native PointFive payload shapes (Opportunities, Anomalies, FOCUS rows)
//   - the `PointFiveMcpClient` transport interface the adapter depends on
//   - `StreamableHttpPointFiveMcpClient`, built on the MCP 2025-06-18 client
//
// Tests inject a fake transport or use the SYNTHETIC local MCP server; no
// vendor endpoint is contacted in tests or CI. The vendor endpoint, protocol
// version, tool names and payload schemas are unverified compatibility risks.

import type { CostWindow } from './CostSourceClient';
import type { RawSourceRow } from './focusRows';
import type { PointFiveCredentials } from './pointfiveConfig';
import type { PointFiveOAuthClient } from './PointFiveOAuthClient';
import { McpClient, type McpClientOptions, type TokenProvider } from '../connectors/managed/pointfive/mcpClient';
import {
  ASSUMED_POINTFIVE_TOOL_NAMES,
  DiscoveredTools,
  extractItems,
  type PointFiveCapability,
  type ToolMapping,
} from '../connectors/managed/pointfive/discovery';
import { probePointFive, type PointFiveHealthReport } from '../connectors/managed/pointfive/health';

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
  /** True only when an MCP session was established; a token alone is not enough. */
  ping(): Promise<boolean>;
  /** Four-stage health (auth, session, tools, data); optional for test doubles. */
  probe?(validateDataItem: (item: unknown) => unknown): Promise<PointFiveHealthReport>;
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

/**
 * PointFive transport over the spec-conformant MCP client
 * (src/connectors/managed/pointfive, protocol 2025-06-18, Streamable HTTP).
 * Every call initializes a session, discovers tools via tools/list, and calls
 * only a tool the server listed (ASSUMED names, configurable; see discovery.ts).
 * Replaces the earlier scaffolding client, which sent no initialize.
 */
export class StreamableHttpPointFiveMcpClient implements PointFiveMcpClient {
  private readonly mcp: McpClient;
  private readonly mapping: ToolMapping;
  private discovered: Promise<DiscoveredTools> | null = null;

  constructor(
    credentials: PointFiveCredentials,
    private readonly oauth: TokenProvider,
    options: Partial<McpClientOptions> = {},
  ) {
    this.mcp = new McpClient({ endpoint: credentials.mcpUrl, tokenProvider: oauth, ...options });
    this.mapping = credentials.toolMapping ?? ASSUMED_POINTFIVE_TOOL_NAMES;
  }

  /** True only when an MCP session was established (initialize), never on token alone. */
  async ping(): Promise<boolean> {
    return this.mcp.initialize().then(() => true, () => false);
  }

  probe(validateDataItem: (item: unknown) => unknown): Promise<PointFiveHealthReport> {
    return probePointFive({ tokenProvider: this.oauth, client: this.mcp, mapping: this.mapping, validateDataItem });
  }

  async fetchBillingRows(window: CostWindow): Promise<PointFiveFocusRow[]> {
    return (await this.call('billing', { start: window.start, end: window.end })) as PointFiveFocusRow[];
  }

  async listOpportunities(): Promise<PointFiveOpportunity[]> {
    return (await this.call('opportunities', {})) as PointFiveOpportunity[];
  }

  async listAnomalies(): Promise<PointFiveAnomaly[]> {
    return (await this.call('anomalies', {})) as PointFiveAnomaly[];
  }

  private async call(cap: PointFiveCapability, args: Record<string, string>): Promise<unknown[]> {
    this.discovered ??= this.mcp.listTools().then((t) => new DiscoveredTools(t, this.mapping));
    const tool = (await this.discovered).require(cap, args);
    return extractItems(cap, await this.mcp.callTool(tool.name, args));
  }
}
