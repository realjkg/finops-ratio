// MCP protocol client (Streamable HTTP, 2025-06-18) against the SYNTHETIC
// local MCP test server. No vendor endpoint is contacted; the server binds to
// 127.0.0.1 and implements the public MCP specification only.

import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient, McpProtocolError, type McpClientOptions } from './mcpClient';
import { SseDecoder } from './sse';
import { startSyntheticMcpServer, type SyntheticServer, type SyntheticServerOptions } from './fixtures/syntheticMcpServer';

const TOKEN = 'synthetic-token-0123456789abcdef';
const TOOL = (name: string) => ({ name, inputSchema: { type: 'object', properties: {} } });
let srv: SyntheticServer | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await srv?.close();
  srv = null;
});

async function setup(server: SyntheticServerOptions = {}, client: Partial<McpClientOptions> = {}) {
  srv = await startSyntheticMcpServer({ acceptToken: TOKEN, ...server });
  const c = new McpClient({
    endpoint: srv.url,
    tokenProvider: { getAccessToken: async () => TOKEN },
    timeoutMs: 2_000,
    sleep: async () => {},
    ...client,
  });
  return { c, s: srv };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(McpProtocolError);
  expect(String((e as Error).message)).not.toContain(TOKEN);
  return (e as McpProtocolError).code;
}

describe('McpClient lifecycle and headers', () => {
  it.each(['json', 'sse'] as const)('initializes first, then sends initialized, version + session headers (%s)', async (mode) => {
    const { c, s } = await setup({ mode, tools: [TOOL('t1')] });
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['t1']);
    expect(s.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    const [init, notif, list] = s.requests;
    expect(init.headers.accept).toBe('application/json, text/event-stream');
    expect(init.headers['mcp-protocol-version']).toBeUndefined();
    expect(init.body?.params).toMatchObject({ protocolVersion: '2025-06-18', capabilities: {} });
    for (const r of [notif, list]) {
      expect(r.headers['mcp-protocol-version']).toBe('2025-06-18');
      expect(r.headers['mcp-session-id']).toBe('synthetic-session-1');
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(notif.body).not.toHaveProperty('id');
    expect(c.session?.capabilities).toHaveProperty('tools');
  });

  it('uses incrementing request ids', async () => {
    const { c, s } = await setup({ tools: [TOOL('t1')] });
    await c.listTools();
    await c.callTool('t1', {});
    expect(s.requests.filter((r) => r.body && 'id' in r.body).map((r) => r.body!.id)).toEqual([1, 2, 3]);
  });

  it('works without a session id when the server assigns none', async () => {
    const { c, s } = await setup({ sessionId: null, tools: [TOOL('t1')] });
    await c.listTools();
    expect(s.requests[2].headers['mcp-session-id']).toBeUndefined();
  });

  it('refuses a server that answers with an unsupported protocol version', async () => {
    const { c, s } = await setup({ versions: ['2024-11-05'] });
    expect(await codeOf(c.listTools())).toBe('PROTOCOL_VERSION_UNSUPPORTED');
    expect(s.methods()).toEqual(['initialize']); // no initialized, no tools/list
  });

  it('maps an initialize JSON-RPC version error to PROTOCOL_VERSION_UNSUPPORTED', async () => {
    const { c } = await setup({
      override: (_r, res, rpc) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Unsupported protocol version' } }));
        return true;
      },
    });
    expect(await codeOf(c.initialize())).toBe('PROTOCOL_VERSION_UNSUPPORTED');
  });

  it('reports a legacy or wrong endpoint (404/405 on initialize) specifically', async () => {
    const { c } = await setup({ override: (_r, res) => (res.writeHead(405).end(), true) });
    expect(await codeOf(c.initialize())).toBe('ENDPOINT_NOT_STREAMABLE_HTTP');
  });

  it('re-initializes once when the session expires (404 with a session id)', async () => {
    let expired = false;
    const { c, s } = await setup({
      tools: [TOOL('t1')],
      override: (r, res) => {
        if (r.body?.method === 'tools/call' && !expired) {
          expired = true;
          res.writeHead(404).end();
          return true;
        }
        return false;
      },
    });
    await c.callTool('t1', {});
    expect(s.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    expect(s.requests[3].headers['mcp-session-id']).toBeUndefined();
  });
});

describe('McpClient errors, bounds and retries', () => {
  it('maps 401 and 403 to auth codes and keeps the body and token out of the error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = await setup({}, { tokenProvider: { getAccessToken: async () => 'wrong-token-0123456789abcdef' } });
    const e = await bad.c.initialize().catch((x: McpProtocolError) => x);
    expect(e.code).toBe('AUTH_REJECTED');
    expect(e.resourceMetadataAdvertised).toBe(true);
    expect(e.message).toBe('PointFive MCP initialize returned 401 (unauthorized)');
    expect(e.message).not.toContain('wrong-token');
    await srv!.close();
    const { c } = await setup({ override: (_r, res) => (res.writeHead(403).end('BODY-MARKER'), true) });
    expect(await codeOf(c.initialize())).toBe('FORBIDDEN');
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('BODY-MARKER');
  });

  it('maps a JSON-RPC error to a fixed message without the server text', async () => {
    const { c } = await setup({ tools: [TOOL('t1')], onCall: () => ({ rpcError: { code: -32603, message: 'LEAK-MARKER' } }) });
    const e = await c.callTool('t1', {}).catch((x: McpProtocolError) => x);
    expect([e.code, e.rpcCode]).toEqual(['JSONRPC_ERROR', -32603]);
    expect(e.message).not.toContain('LEAK-MARKER');
  });

  it('retries 429 and 5xx with backoff, bounded', async () => {
    const sleeps: number[] = [];
    let fails = 2;
    const { c, s } = await setup(
      { override: (r, res) => (r.body?.method === 'initialize' && fails-- > 0 ? (res.writeHead(fails ? 429 : 503, fails ? { 'Retry-After': '1' } : {}).end(), true) : false) },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    await c.initialize();
    expect(sleeps).toEqual([1000, 500]);
    expect(s.methods().slice(0, 3)).toEqual(['initialize', 'initialize', 'initialize']);
    await s.close();
    const always = await setup({ override: (_r, res) => (res.writeHead(500).end(), true) }, { maxRetries: 2 });
    expect(await codeOf(always.c.initialize())).toBe('HTTP_STATUS');
    expect(always.s.requests).toHaveLength(3);
  });

  it('times out a hung request and sends notifications/cancelled', async () => {
    const { c, s } = await setup(
      { tools: [TOOL('t1')], override: (r) => r.body?.method === 'tools/call' /* never answers */ },
      { timeoutMs: 150 },
    );
    expect(await codeOf(c.callTool('t1', {}))).toBe('TIMEOUT');
    const cancel = s.requests.find((r) => r.body?.method === 'notifications/cancelled');
    expect(cancel?.body?.params).toMatchObject({ requestId: 2 });
  });

  it('honors caller cancellation', async () => {
    const { c, s } = await setup({ tools: [TOOL('t1')], override: (r) => r.body?.method === 'tools/call' });
    await c.initialize();
    const ac = new AbortController();
    const p = c.callTool('t1', {}, ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect(await codeOf(p)).toBe('CANCELLED');
    expect(s.methods()).toContain('notifications/cancelled');
  });

  const raw = (contentType: string, body: string, end = true) => (r: { body: Record<string, unknown> | null }, res: http.ServerResponse) => {
    if (r.body?.method !== 'initialize') return false;
    res.writeHead(200, { 'Content-Type': contentType });
    if (end) res.end(body);
    else {
      res.write(body);
      setTimeout(() => res.destroy(), 20);
    }
    return true;
  };

  it.each([
    ['malformed SSE data', raw('text/event-stream', 'data: {not json\n\n'), 'MALFORMED_SSE'],
    ['SSE ending before the response', raw('text/event-stream', ': only a comment\n\n'), 'TRUNCATED_STREAM'],
    ['stream cut mid-event', raw('text/event-stream', 'data: {"jsonrpc":"2.0","id":1,', false), 'TRUNCATED_STREAM'],
    ['non-JSON body', raw('application/json', '{"a": LEAKED}'), 'MALFORMED_RESPONSE'],
    ['unsupported content type', raw('text/plain', 'hello'), 'MALFORMED_RESPONSE'],
    ['response for another id', raw('application/json', '{"jsonrpc":"2.0","id":99,"result":{}}'), 'MALFORMED_RESPONSE'],
    ['oversized response', raw('application/json', `{"x":"${'a'.repeat(5000)}"}`), 'RESPONSE_TOO_LARGE'],
  ])('%s → %s', async (_n, override, code) => {
    const { c } = await setup({ override }, { maxResponseBytes: 4096 });
    expect(await codeOf(c.initialize())).toBe(code);
  });
});

describe('McpClient tools/list pagination', () => {
  it('follows nextCursor to completion', async () => {
    const { c, s } = await setup({ tools: ['a', 'b', 'c', 'd', 'e'].map(TOOL), pageSize: 2 });
    expect((await c.listTools()).map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.requests.filter((r) => r.body?.method === 'tools/list').map((r) => (r.body!.params as { cursor?: string })?.cursor)).toEqual([undefined, 'c-2', 'c-4']);
  });

  it('stops on a repeated cursor and on the page bound', async () => {
    const loop = (_r: unknown, res: http.ServerResponse, rpc: { id?: unknown; method?: string }) => {
      if (rpc.method !== 'tools/list') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [], nextCursor: `k${Math.random()}` } }));
      return true;
    };
    const { c } = await setup({ override: loop }, { maxListPages: 3 });
    expect(await codeOf(c.listTools())).toBe('PAGINATION_LIMIT');
  });

  it('rejects a tool without an object inputSchema', async () => {
    const { c } = await setup({ tools: [{ name: 'bad', inputSchema: { type: 'string' } }] });
    expect(await codeOf(c.listTools())).toBe('MALFORMED_RESPONSE');
  });
});

describe('SseDecoder', () => {
  it('joins multi-line data, handles CRLF/CR split across chunks, ignores comments and partial tails', () => {
    const d = new SseDecoder(10_000);
    expect(d.push(': c\r')).toEqual([]);
    expect(d.push('\ndata: a\r\ndata: b\r')).toEqual([]);
    expect(d.push('\n\r\nevent: x\ndata: y\n\ndata: tail')).toEqual([
      { event: 'message', data: 'a\nb' },
      { event: 'x', data: 'y' },
    ]);
    expect(d.pending).toBe(true);
  });

  it('refuses an unbounded line', () => {
    expect(() => new SseDecoder(16).push('data: ' + 'z'.repeat(32))).toThrow(McpProtocolError);
  });
});
