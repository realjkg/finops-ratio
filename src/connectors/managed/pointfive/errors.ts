// Typed MCP client errors. Messages are FIXED text built from the method name,
// HTTP status or JSON-RPC code: upstream bodies, server error messages, tokens
// and tool payloads never appear in them.

// AUTH_REJECTED = HTTP 401, FORBIDDEN = 403 (scope), HTTP_STATUS = other non-2xx
// after bounded retries, ENDPOINT_NOT_STREAMABLE_HTTP = 404/405 on initialize.
export type McpErrorCode =
  | 'AUTH_REJECTED' | 'FORBIDDEN' | 'HTTP_STATUS' | 'NETWORK' | 'TIMEOUT' | 'CANCELLED'
  | 'ENDPOINT_NOT_STREAMABLE_HTTP' | 'PROTOCOL_VERSION_UNSUPPORTED' | 'SESSION_EXPIRED' | 'JSONRPC_ERROR'
  | 'MALFORMED_RESPONSE' | 'MALFORMED_SSE' | 'TRUNCATED_STREAM' | 'RESPONSE_TOO_LARGE' | 'PAGINATION_LIMIT'
  | 'TOOL_EXECUTION_ERROR';

export interface McpErrorDetails {
  httpStatus?: number;
  rpcCode?: number;
  /** A 401 carried an RFC 9728 `resource_metadata` WWW-Authenticate parameter. */
  resourceMetadataAdvertised?: boolean;
}

export class McpProtocolError extends Error {
  readonly httpStatus?: number;
  readonly rpcCode?: number;
  readonly resourceMetadataAdvertised?: boolean;

  constructor(readonly code: McpErrorCode, message: string, details: McpErrorDetails = {}) {
    super(message);
    this.name = 'McpProtocolError';
    Object.assign(this, details);
  }
}

const RPC_REASONS: Record<number, string> = {
  [-32700]: 'parse error', [-32600]: 'invalid request', [-32601]: 'method not found', [-32602]: 'invalid params', [-32603]: 'internal error',
};

export const rpcReason = (code: number): string => RPC_REASONS[code] ?? 'server-defined error';
