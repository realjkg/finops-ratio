// MCP client over Streamable HTTP, pinned to protocol revision 2025-06-18 (public
// spec: basic/lifecycle, basic/transports, server/tools, pagination, cancellation).
// Nothing here is PointFive-specific; no PointFive transcript has been captured,
// so the vendor's endpoint and version support remain a compatibility risk.
// initialize -> notifications/initialized; negotiated MCP-Protocol-Version and
// Mcp-Session-Id on every later request; a 404 on a session re-initializes once.
// Timeouts (30 s) and caller cancellation send notifications/cancelled; 429/5xx/
// network errors retry with bounded backoff; a Retry-After (seconds or HTTP-date)
// longer than 10 s stops with RETRY_AFTER_TOO_LONG instead of retrying early;
// bodies and pages are bounded. The
// legacy HTTP+SSE transport (2024-11-05) is not defined by 2025-06-18 and is not
// implemented: a 404/405 on initialize is ENDPOINT_NOT_STREAMABLE_HTTP. The token
// is fetched per request and never logged or put in an error.

import { logUpstreamError, statusReason } from '../../../costsource/transports/redact';
import { McpProtocolError, rpcReason } from './errors';
import { SseDecoder } from './sse';

export { McpProtocolError } from './errors';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18'] as const;
const LATEST = SUPPORTED_PROTOCOL_VERSIONS[0];
const ACCEPT = 'application/json, text/event-stream';
const MAX_RETRY_AFTER_MS = 10_000;

type Obj = Record<string, unknown>;
export interface TokenProvider { getAccessToken(): Promise<string> }
const DEFAULTS = { timeoutMs: 30_000, maxResponseBytes: 4 * 1024 * 1024, maxRetries: 2, backoffMs: 250, maxListPages: 20 };
export type McpClientOptions = Partial<typeof DEFAULTS> & {
  endpoint: string;
  tokenProvider: TokenProvider;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for Retry-After HTTP-dates (ms since epoch). Default Date.now. */
  now?: () => number;
};
export interface McpSession { protocolVersion: string; capabilities: Obj; serverInfo: { name: string; version: string } }
export interface McpTool { name: string; inputSchema: Obj; outputSchema?: Obj }
export interface McpToolResult { content: unknown[]; structuredContent?: unknown }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 100) : '');
/**
 * Retry-After (RFC 9110 section 10.2.3) in ms: delay-seconds or an HTTP-date
 * relative to `now` (a past date is 0). Null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // HTTP-date forms (IMF-fixdate, RFC 850, asctime) all start with a day name.
  if (!/^[A-Za-z]{3,9},? /.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const fail = (code: ConstructorParameters<typeof McpProtocolError>[0], method: string, what: string) =>
  new McpProtocolError(code, `PointFive MCP ${method} ${what}`);

export class McpClient {
  private nextId = 1;
  private negotiated: string | null = null;
  private sessionId: string | null = null;
  private current: McpSession | null = null;
  private initializing: Promise<McpSession> | null = null;
  private readonly o: typeof DEFAULTS & Required<McpClientOptions>;

  constructor(opts: McpClientOptions) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    this.o = { ...DEFAULTS, fetch: (i, init) => fetch(i, init), sleep, now: () => Date.now(), ...given } as typeof this.o;
  }

  /** The negotiated session, or null before a successful initialize. */
  get session(): McpSession | null {
    return this.current;
  }

  /** Starts a new session (any previous one is dropped). */
  async initialize(signal?: AbortSignal): Promise<McpSession> {
    this.current = this.negotiated = this.sessionId = null;
    const { result, headers } = await this.exchange('initialize', {
      protocolVersion: LATEST,
      capabilities: {},
      clientInfo: { name: 'ratio-pointfive-connector', version: '1.0.0' },
    }, signal);
    const version = result.protocolVersion;
    if (typeof version !== 'string' || !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      throw fail('PROTOCOL_VERSION_UNSUPPORTED', 'initialize', 'answered with an unsupported protocol version');
    }
    if (!isObj(result.capabilities)) throw fail('MALFORMED_RESPONSE', 'initialize', 'returned no capabilities');
    const sid = headers.get('mcp-session-id');
    if (sid !== null && !/^[\x21-\x7e]{1,512}$/.test(sid)) throw fail('MALFORMED_RESPONSE', 'initialize', 'returned an invalid session id');
    this.negotiated = version;
    this.sessionId = sid;
    await this.exchange('notifications/initialized', undefined, signal, false);
    const info = isObj(result.serverInfo) ? result.serverInfo : {};
    const serverInfo = { name: short(info.name), version: short(info.version) };
    return (this.current = { protocolVersion: version, capabilities: result.capabilities, serverInfo });
  }

  /** `tools/list`, following `nextCursor` to completion within the page bound. */
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= this.o.maxListPages) throw fail('PAGINATION_LIMIT', 'tools/list', 'exceeded the page bound');
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor }, signal);
      if (!Array.isArray(result.tools)) throw fail('MALFORMED_RESPONSE', 'tools/list', 'returned no tool list');
      for (const t of result.tools) {
        const ok =
          isObj(t) && typeof t.name === 'string' && /^.{1,128}$/.test(t.name) &&
          isObj(t.inputSchema) && t.inputSchema.type === 'object' &&
          (t.outputSchema === undefined || (isObj(t.outputSchema) && t.outputSchema.type === 'object'));
        if (!ok) throw fail('MALFORMED_RESPONSE', 'tools/list', 'returned an invalid tool definition');
        const { name, inputSchema, outputSchema } = t as unknown as McpTool;
        tools.push({ name, inputSchema, ...(outputSchema ? { outputSchema } : {}) });
      }
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw fail('PAGINATION_LIMIT', 'tools/list', 'returned an invalid or repeated cursor');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
  }

  /** `tools/call`. A result flagged `isError` throws TOOL_EXECUTION_ERROR. */
  async callTool(name: string, args: Obj, signal?: AbortSignal): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, signal);
    if (!Array.isArray(result.content)) throw fail('MALFORMED_RESPONSE', 'tools/call', 'returned no content list');
    if (result.isError === true) throw fail('TOOL_EXECUTION_ERROR', 'tools/call', 'reported a tool execution error');
    return { content: result.content, structuredContent: result.structuredContent };
  }

  /** Ends the session (HTTP DELETE); best effort. */
  async close(): Promise<void> {
    if (this.sessionId) await this.o.fetch(this.o.endpoint, { method: 'DELETE', headers: await this.headers() }).catch(() => undefined);
    this.current = this.negotiated = this.sessionId = null;
  }

  // --- internals ---------------------------------------------------------

  private async request(method: string, params: Obj, signal?: AbortSignal): Promise<Obj> {
    await this.ensureSession(signal);
    try {
      return (await this.exchange(method, params, signal)).result;
    } catch (e) {
      if (!(e instanceof McpProtocolError) || e.code !== 'SESSION_EXPIRED') throw e;
      this.current = null;
      await this.ensureSession(signal);
      return (await this.exchange(method, params, signal)).result;
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    if (this.current) return;
    this.initializing ??= this.initialize(signal).finally(() => (this.initializing = null));
    await this.initializing;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${await this.o.tokenProvider.getAccessToken()}`,
      'Content-Type': 'application/json',
      Accept: ACCEPT,
    };
    if (this.negotiated) h['MCP-Protocol-Version'] = this.negotiated;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  /** One JSON-RPC request (expectResponse) or notification, with timeout, cancel and retry. */
  private async exchange(method: string, params: Obj | undefined, signal?: AbortSignal, expectResponse = true): Promise<{ result: Obj; headers: Headers }> {
    const id = expectResponse ? this.nextId++ : undefined;
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) });
    for (let attempt = 0; ; attempt++) {
      const headers = await this.headers();
      const hadSession = this.sessionId !== null;
      const ctl = new AbortController();
      let why: 'TIMEOUT' | 'CANCELLED' | null = null;
      const timer = setTimeout(() => ((why = 'TIMEOUT'), ctl.abort()), this.o.timeoutMs);
      const onAbort = () => ((why = 'CANCELLED'), ctl.abort());
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      let retryDelay!: number;
      try {
        const res = await this.o.fetch(this.o.endpoint, { method: 'POST', headers, body, signal: ctl.signal });
        if (res.ok) {
          if (!expectResponse) {
            await res.body?.cancel().catch(() => undefined);
            return { result: {}, headers: res.headers };
          }
          return { result: await this.readResponse(method, id!, res), headers: res.headers };
        }
        if ((res.status === 429 || res.status >= 500) && attempt < this.o.maxRetries) {
          await res.body?.cancel().catch(() => undefined);
          const after = parseRetryAfter(res.headers.get('retry-after'), this.o.now());
          if (after !== null && after > MAX_RETRY_AFTER_MS) {
            // Retrying before the server's stated time would be early; stop instead.
            throw new McpProtocolError(
              'RETRY_AFTER_TOO_LONG',
              `PointFive MCP ${method} returned ${res.status} (${statusReason(res.status)}) and asked to retry after more than ${MAX_RETRY_AFTER_MS / 1000} s`,
              { httpStatus: res.status },
            );
          }
          retryDelay = after ?? this.o.backoffMs * 2 ** attempt;
        } else {
          throw await this.httpError(method, res, hadSession);
        }
      } catch (e) {
        if (why) {
          if (id !== undefined && method !== 'initialize') await this.notifyCancelled(id, why);
          throw fail(why, method, why === 'TIMEOUT' ? `timed out after ${this.o.timeoutMs} ms` : 'was canceled');
        }
        if (e instanceof McpProtocolError) throw e;
        if (attempt >= this.o.maxRetries) throw fail('NETWORK', method, 'request failed (network error)');
        retryDelay = this.o.backoffMs * 2 ** attempt;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      await this.o.sleep(retryDelay);
    }
  }

  private async notifyCancelled(requestId: number, reason: string): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(this.o.timeoutMs, 5_000));
    try {
      const res = await this.o.fetch(this.o.endpoint, { method: 'POST', headers: await this.headers(), body, signal: ctl.signal });
      await res.body?.cancel().catch(() => undefined);
    } catch {
      // Fire and forget (spec: cancellation is best effort).
    } finally {
      clearTimeout(timer);
    }
  }

  private async httpError(method: string, res: Response, hadSession: boolean): Promise<McpProtocolError> {
    const text = await this.readText(method, res).catch(() => '');
    if (text) logUpstreamError(`PointFive MCP ${method}`, res.status, text);
    const st = res.status;
    const msg = `PointFive MCP ${method} returned ${st} (${statusReason(st)})`;
    const resourceMetadataAdvertised = st === 401 ? /resource_metadata\s*=/i.test(res.headers.get('www-authenticate') ?? '') : undefined;
    const code =
      st === 401 ? 'AUTH_REJECTED' : st === 403 ? 'FORBIDDEN'
        : method === 'initialize' && (st === 404 || st === 405) ? 'ENDPOINT_NOT_STREAMABLE_HTTP'
          : st === 404 && hadSession ? 'SESSION_EXPIRED' : 'HTTP_STATUS';
    return new McpProtocolError(code, msg, { httpStatus: st, resourceMetadataAdvertised });
  }

  /** Reads the body as text within the byte bound. */
  private async readText(method: string, res: Response, onText?: (t: string) => boolean): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw fail('TRUNCATED_STREAM', method, 'response stream ended early');
        }
        if (chunk.done) return text + decoder.decode();
        total += chunk.value.byteLength;
        if (total > this.o.maxResponseBytes) throw fail('RESPONSE_TOO_LARGE', method, 'response exceeds the size bound');
        const part = decoder.decode(chunk.value, { stream: true });
        if (onText) {
          if (onText(part)) return '';
        } else text += part;
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  private async readResponse(method: string, id: number, res: Response): Promise<Obj> {
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'application/json') {
      const text = await this.readText(method, res);
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        throw fail('MALFORMED_RESPONSE', method, 'returned a non-JSON response');
      }
      return this.settle(method, id, msg);
    }
    if (type !== 'text/event-stream') {
      await res.body?.cancel().catch(() => undefined);
      throw fail('MALFORMED_RESPONSE', method, 'returned an unsupported content type');
    }
    const decoder = new SseDecoder(this.o.maxResponseBytes);
    let response: unknown;
    await this.readText(method, res, (part) => {
      for (const ev of decoder.push(part)) {
        if (ev.event !== 'message' || ev.data === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          throw fail('MALFORMED_SSE', method, 'sent an SSE event that is not JSON');
        }
        // Server notifications and requests are ignored: this client declares no capabilities.
        if (isObj(msg) && msg.id === id && !('method' in msg)) {
          response = msg;
          return true;
        }
      }
      return false;
    });
    if (response === undefined) throw fail('TRUNCATED_STREAM', method, 'SSE stream ended before the response');
    return this.settle(method, id, response);
  }

  private settle(method: string, id: number, msg: unknown): Obj {
    if (!isObj(msg) || msg.jsonrpc !== '2.0' || msg.id !== id) {
      throw fail('MALFORMED_RESPONSE', method, 'returned an invalid JSON-RPC response');
    }
    if (isObj(msg.error)) {
      const code = typeof msg.error.code === 'number' ? msg.error.code : 0;
      const data = msg.error.data;
      const versionRefused = (isObj(data) && Array.isArray(data.supported)) || /version/i.test(String(msg.error.message));
      if (method === 'initialize' && code === -32602 && versionRefused) throw fail('PROTOCOL_VERSION_UNSUPPORTED', method, 'refused the requested protocol version');
      throw new McpProtocolError('JSONRPC_ERROR', `PointFive MCP ${method} failed with JSON-RPC error ${code} (${rpcReason(code)})`, { rpcCode: code });
    }
    if (!isObj(msg.result)) throw fail('MALFORMED_RESPONSE', method, 'returned no result');
    return msg.result;
  }
}
