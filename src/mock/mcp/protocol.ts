// Minimal JSON-RPC 2.0 / MCP wire subset for the mock server (card A5).
//
// ASSUMPTIONS (the MCP specification was NOT read or verified; the Frank design
// lists every MCP reliance as unverified, docs/design/frank-mcp/DESIGN.md 2.5).
// This file is the single place those assumptions live:
//   1. Transport: JSON-RPC 2.0 messages POSTed to one path over plain HTTP,
//      one JSON response per request (no SSE stream, no batching).
//   2. `initialize` returns `protocolVersion`, `capabilities`, `serverInfo` and
//      an `Mcp-Session-Id` response header; later requests must echo it.
//   3. `notifications/initialized` is a notification (no `id`) answered 202.
//   4. `tools/list` returns `tools[]` with `name`, `description`, `inputSchema`,
//      optional `outputSchema` and `annotations.readOnlyHint`.
//   5. `tools/call` returns `{ content: [{type:'text', text}], structuredContent,
//      isError? }`; a tool-level failure is a result with `isError: true`.
//   6. Error codes: -32700 parse, -32600 invalid request, -32601 method not
//      found (also used for an unknown tool name, as the card specifies),
//      -32602 invalid params.
// Nothing here is evidence about a real server. A client built against this
// mock must still be checked against the real specification (Frank T-1, D13).

export const JSONRPC_VERSION = '2.0';
export const PROTOCOL_VERSION = '2025-03-26';
export const SESSION_HEADER = 'mcp-session-id';
export const MCP_PATH = '/mcp';

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** Error messages are fixed strings; never interpolate request data into them. */
export function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

export type ParsedMessage =
  | { kind: 'request'; message: JsonRpcRequest & { id: JsonRpcId } }
  | { kind: 'notification'; message: JsonRpcRequest }
  | { kind: 'invalid' };

export function parseMessage(value: unknown): ParsedMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid' };
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== JSONRPC_VERSION || typeof v.method !== 'string') return { kind: 'invalid' };
  if (!('id' in v) || v.id === undefined) {
    return { kind: 'notification', message: { jsonrpc: '2.0', method: v.method, params: v.params } };
  }
  if (typeof v.id !== 'string' && typeof v.id !== 'number') return { kind: 'invalid' };
  return { kind: 'request', message: { jsonrpc: '2.0', id: v.id, method: v.method, params: v.params } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
