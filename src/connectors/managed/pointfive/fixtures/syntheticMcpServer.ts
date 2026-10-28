// SYNTHETIC local MCP test server (Streamable HTTP, protocol 2025-06-18).
//
// Built from the public Model Context Protocol specification (basic/lifecycle,
// basic/transports, server/tools, server/utilities/pagination,
// basic/utilities/cancellation, revision 2025-06-18). It is NOT a model of the
// PointFive server: no PointFive transcript, schema or tool list has been
// captured. Tool names and payloads used with it in tests are SYNTHETIC and
// ASSUMED. It binds to 127.0.0.1 only and is used by tests only.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SyntheticTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export interface RecordedRequest {
  httpMethod: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

/** A per-request override: write any raw response, or return false to fall through. */
export type Override = (
  req: RecordedRequest,
  res: http.ServerResponse,
  rpc: { id?: unknown; method?: string; params?: Record<string, unknown> },
) => boolean | Promise<boolean>;

export interface SyntheticServerOptions {
  /** Versions this server supports; it answers the requested one if listed, else the first. */
  versions?: string[];
  sessionId?: string | null;
  mode?: 'json' | 'sse';
  tools?: SyntheticTool[];
  pageSize?: number;
  /** tools/call handler: returns a CallToolResult, or { rpcError } for a protocol error. */
  onCall?: (name: string, args: unknown) => unknown;
  /** Bearer token the server accepts; any other → 401 with WWW-Authenticate. */
  acceptToken?: string;
  override?: Override;
}

export interface SyntheticServer {
  url: string;
  requests: RecordedRequest[];
  /** Methods of JSON-RPC messages received, in order. */
  methods(): string[];
  close(): Promise<void>;
}

function send(res: http.ServerResponse, mode: 'json' | 'sse', msg: unknown, headers: Record<string, string> = {}) {
  if (mode === 'json') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(msg));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
  // A server notification first (spec: MAY precede the response), then the response.
  res.write(': synthetic comment\n\n');
  res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } })}\n\n`);
  res.end(`id: ev-1\ndata: ${JSON.stringify(msg)}\r\n\r\n`);
}

export async function startSyntheticMcpServer(opts: SyntheticServerOptions = {}): Promise<SyntheticServer> {
  const versions = opts.versions ?? ['2025-06-18'];
  const sessionId = opts.sessionId === undefined ? 'synthetic-session-1' : opts.sessionId;
  const mode = opts.mode ?? 'json';
  const tools = opts.tools ?? [];
  const pageSize = opts.pageSize ?? 100;
  const requests: RecordedRequest[] = [];
  let negotiated: string | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const rec: RecordedRequest = { httpMethod: req.method ?? '', headers: req.headers, body };
      requests.push(rec);
      const rpc = (body ?? {}) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      if (opts.override && (await opts.override(rec, res, rpc))) return;

      if (opts.acceptToken && req.headers.authorization !== `Bearer ${opts.acceptToken}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' });
        res.end('{"error":"invalid_token"}');
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const accept = String(req.headers.accept ?? '');
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        res.writeHead(406).end();
        return;
      }
      if (rpc.method === 'initialize') {
        const requested = String(rpc.params?.protocolVersion ?? '');
        negotiated = versions.includes(requested) ? requested : versions[0];
        const headers: Record<string, string> = sessionId ? { 'Mcp-Session-Id': sessionId } : {};
        send(res, mode, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: negotiated,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'synthetic-mcp-server', version: '0.0.0-synthetic' },
          },
        }, headers);
        return;
      }
      // Every later request must carry the negotiated version and the session id.
      if (req.headers['mcp-protocol-version'] !== negotiated) {
        res.writeHead(400).end();
        return;
      }
      if (sessionId && req.headers['mcp-session-id'] !== sessionId) {
        res.writeHead(sessionId && req.headers['mcp-session-id'] ? 404 : 400).end();
        return;
      }
      if (rpc.id === undefined) {
        res.writeHead(202).end(); // notification accepted
        return;
      }
      if (rpc.method === 'tools/list') {
        const start = rpc.params?.cursor ? Number(String(rpc.params.cursor).replace('c-', '')) : 0;
        if (Number.isNaN(start)) {
          send(res, mode, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Invalid cursor' } });
          return;
        }
        const page = tools.slice(start, start + pageSize);
        const next = start + pageSize < tools.length ? { nextCursor: `c-${start + pageSize}` } : {};
        send(res, mode, { jsonrpc: '2.0', id: rpc.id, result: { tools: page, ...next } });
        return;
      }
      if (rpc.method === 'tools/call') {
        const name = String(rpc.params?.name ?? '');
        if (!tools.some((t) => t.name === name)) {
          send(res, mode, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
          return;
        }
        const out = (opts.onCall ?? (() => ({ content: [], structuredContent: {} })))(name, rpc.params?.arguments) as
          | { rpcError: { code: number; message: string } }
          | Record<string, unknown>;
        if ('rpcError' in out) send(res, mode, { jsonrpc: '2.0', id: rpc.id, error: out.rpcError });
        else send(res, mode, { jsonrpc: '2.0', id: rpc.id, result: out });
        return;
      }
      send(res, mode, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    methods: () => requests.map((r) => String(r.body?.method ?? `<${r.httpMethod}>`)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
