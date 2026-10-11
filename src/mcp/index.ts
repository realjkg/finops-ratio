// Public surface of the read-only MCP core. Purpose: the one import a transport needs.
// Trust boundary: exports the handler and its injected-dependency types only; the
// registry is read-only from here (no register function exists).
export { handleMcpMessage, TOOL_ERROR_TEXT } from './handler';
export type { McpContext, McpPolicy, McpAuditSink, McpAuditRecord, AuditReason } from './context';
export type { McpDataProvider, McpScope, ProviderResult } from './provider';
export type { McpClock } from './clock';
export { systemClock } from './clock';
export { createRateLimiter } from './rateLimit';
export type { McpRateLimiter } from './rateLimit';
export { DEFAULT_LIMITS, HARD_LIMITS } from './limits';
export type { McpLimits } from './limits';
export { TOOL_REGISTRY } from './registry';
export type { JsonRpcResponse } from './jsonrpc';
