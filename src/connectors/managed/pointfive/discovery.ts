// PointFive tool discovery: logical capabilities -> tool names, checked against
// the server's own `tools/list` before any call.
//
// ASSUMED / UNVERIFIED: the default names below come from external research,
// not from a captured PointFive `tools/list`. They are NOT the vendor contract.
// They are configurable (POINTFIVE_MCP_TOOL_MAP), and a tool is callable only
// if the server lists it. The result payload shape (`structuredContent.items`)
// is likewise ASSUMED (compatibility risk until M9b captures the real schema).

import { McpProtocolError } from './errors';
import type { McpTool, McpToolResult } from './mcpClient';

export type PointFiveCapability = 'billing' | 'opportunities' | 'anomalies';
export type ToolMapping = Readonly<Record<PointFiveCapability, string>>;

/** ASSUMED, UNVERIFIED default tool names (never captured from PointFive). */
export const ASSUMED_POINTFIVE_TOOL_NAMES: ToolMapping = Object.freeze({
  billing: 'billing_data',
  opportunities: 'opportunities',
  anomalies: 'anomalies',
});

/** ASSUMED field of `structuredContent` that carries the result list. */
export const ASSUMED_ITEMS_FIELD = 'items';

const CAPS = Object.keys(ASSUMED_POINTFIVE_TOOL_NAMES) as PointFiveCapability[];
const NAME_RE = /^[A-Za-z0-9_.\-/]{1,128}$/;

/** `cap=tool,cap=tool` overrides on top of the ASSUMED defaults. Errors name the key, never the value. */
export function parseToolMapping(raw: string | undefined): ToolMapping {
  const out: Record<PointFiveCapability, string> = { ...ASSUMED_POINTFIVE_TOOL_NAMES };
  for (const pair of (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [key, value = ''] = pair.split('=').map((p) => p.trim());
    if (!CAPS.includes(key as PointFiveCapability)) throw new Error(`POINTFIVE_MCP_TOOL_MAP: unknown capability '${key.slice(0, 32)}'`);
    if (!NAME_RE.test(value)) throw new Error(`POINTFIVE_MCP_TOOL_MAP: invalid tool name for '${key}'`);
    out[key as PointFiveCapability] = value;
  }
  return Object.freeze(out);
}

export class DiscoveredTools {
  private readonly byName: Map<string, McpTool>;

  constructor(tools: McpTool[], private readonly mapping: ToolMapping) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  /** Configured capabilities whose tool the server did not list. */
  missing(): PointFiveCapability[] {
    return CAPS.filter((c) => !this.byName.has(this.mapping[c]));
  }

  /** The discovered tool for a capability, checked to accept the arguments we send. */
  require(cap: PointFiveCapability, args: Record<string, unknown>): McpTool {
    const tool = this.byName.get(this.mapping[cap]);
    if (!tool) throw new McpProtocolError('TOOL_NOT_DISCOVERED', `PointFive MCP tool for '${cap}' is not in the server's tools/list`);
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
    if (required.some((r) => typeof r !== 'string' || !(r in args))) {
      throw new McpProtocolError('TOOL_SCHEMA_MISMATCH', `PointFive MCP tool for '${cap}' requires arguments this connector does not send`);
    }
    return tool;
  }
}

/** The result list of a tool call, per the ASSUMED payload shape. */
export function extractItems(cap: PointFiveCapability, result: McpToolResult): unknown[] {
  const sc = result.structuredContent;
  const list = typeof sc === 'object' && sc !== null && !Array.isArray(sc) ? (sc as Record<string, unknown>)[ASSUMED_ITEMS_FIELD] : undefined;
  if (!Array.isArray(list)) {
    throw new McpProtocolError('PAYLOAD_SCHEMA_MISMATCH', `PointFive MCP tool for '${cap}' returned no structuredContent.${ASSUMED_ITEMS_FIELD} list`);
  }
  return list;
}
