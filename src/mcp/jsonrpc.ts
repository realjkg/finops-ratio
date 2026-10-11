// JSON-RPC 2.0 envelope handling for the MCP core. Purpose: strict request parsing and
// the fixed error table. Trust boundary: the envelope is the first thing an untrusted
// client controls. Accepted: one request object with jsonrpc "2.0", an id that is a
// non-empty string of at most 128 characters or a safe integer, a method string of at
// most 64 characters, and params absent or an object. Refused with a fixed error:
// batch arrays (the design allows none; MCP 2025-06-18 removed batching), a null,
// float, boolean or object id, extra envelope keys, and responses sent as requests.
// A notification (no id) is never answered. Error text is a constant and never echoes
// any input; the response id is echoed only after it passed the id check above.
import type { JsonValue } from './jsonSafe';

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: Record<string, unknown>;
}
export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
}
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface RpcError {
  readonly code: number;
  readonly message: string;
}

const e = (code: number, message: string): RpcError => Object.freeze({ code, message });

/** Every error the core can return. Codes -32700 to -32603 are JSON-RPC's; -32001 and -32011 are implementation-defined server errors. */
export const RPC_ERRORS = Object.freeze({
  parse: e(-32700, 'Parse error'),
  invalidRequest: e(-32600, 'Invalid request'),
  batchRefused: e(-32600, 'Batch requests are not supported'),
  tooLarge: e(-32600, 'Request too large'),
  methodNotFound: e(-32601, 'Method not found'),
  invalidParams: e(-32602, 'Invalid params'),
  toolNotAvailable: e(-32602, 'Tool not available'),
  internal: e(-32603, 'Internal error'),
  unauthenticated: e(-32001, 'Authentication required'),
  rateLimited: e(-32011, 'Rate limit exceeded'),
});

export const MAX_ID_CHARS = 128;
export const MAX_METHOD_CHARS = 64;

export const failure = (id: JsonRpcId, err: RpcError): JsonRpcFailure => ({ jsonrpc: '2.0', id, error: { code: err.code, message: err.message } });
export const success = (id: string | number, result: Record<string, unknown>): JsonRpcSuccess => ({ jsonrpc: '2.0', id, result });

export type Envelope =
  | { kind: 'request'; id: string | number; method: string; params: Record<string, JsonValue> | undefined }
  | { kind: 'notification' }
  | { kind: 'invalid'; error: RpcError; id: JsonRpcId };

const ENVELOPE_KEYS: readonly string[] = ['jsonrpc', 'id', 'method', 'params'];

export function validId(v: unknown): v is string | number {
  if (typeof v === 'string') return v.length >= 1 && v.length <= MAX_ID_CHARS;
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** `value` is the sanitized top-level JSON value. */
export function parseEnvelope(value: JsonValue): Envelope {
  if (Array.isArray(value)) return { kind: 'invalid', error: RPC_ERRORS.batchRefused, id: null };
  if (value === null || typeof value !== 'object') return { kind: 'invalid', error: RPC_ERRORS.invalidRequest, id: null };
  const keys = Object.keys(value);
  if (!keys.every((k) => ENVELOPE_KEYS.includes(k)) || value.jsonrpc !== '2.0') return { kind: 'invalid', error: RPC_ERRORS.invalidRequest, id: null };
  const method = value.method;
  if (typeof method !== 'string' || method.length < 1 || method.length > MAX_METHOD_CHARS) return { kind: 'invalid', error: RPC_ERRORS.invalidRequest, id: null };
  const hasId = Object.hasOwn(value, 'id');
  if (!hasId) return { kind: 'notification' };
  if (!validId(value.id)) return { kind: 'invalid', error: RPC_ERRORS.invalidRequest, id: null };
  const params = value.params;
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    return { kind: 'invalid', error: RPC_ERRORS.invalidParams, id: value.id };
  }
  return { kind: 'request', id: value.id, method, params };
}
