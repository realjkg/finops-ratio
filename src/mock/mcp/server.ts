// Loopback-only mock MCP server over HTTP (card A5). Fixture data only.
// See protocol.ts for the wire assumptions (the MCP specification was not read).

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  ERR_PARSE,
  MCP_PATH,
  PROTOCOL_VERSION,
  SESSION_HEADER,
  fail,
  isRecord,
  ok,
  parseMessage,
} from './protocol';
import type { JsonRpcResponse } from './protocol';
import { InvalidArgumentsError, ToolRegistry, UnknownToolError } from './tools';

export interface FixtureCredential {
  /** Bearer token. Never logged or echoed. */
  token: string;
  /** The one team whose rows this credential may see, or '*' for org-wide. */
  team: string;
}

export interface MockMcpServerOptions {
  credentials: readonly FixtureCredential[];
  /** Loopback address only. Default 127.0.0.1. */
  host?: string;
  /** Default 0 (ephemeral). */
  port?: number;
  /** Receives one short line per request: method, path, status. Never headers or bodies. */
  log?: (line: string) => void;
}

export interface MockMcpTestHooks {
  setToolDescription(name: string, description: string): void;
  mutationCount(): number;
  /** Restores descriptions and ticket state (sessions are kept). */
  reset(): void;
}

export interface MockMcpServer {
  url: string;
  address: AddressInfo;
  testHooks: MockMcpTestHooks;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

function isLoopbackHost(host: string): boolean {
  if (host === '::1') return true;
  return net.isIPv4(host) && host.startsWith('127.');
}

const sha = (s: string) => createHash('sha256').update(s).digest();

function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '[::1]' || (net.isIPv4(h) && h.startsWith('127.'));
  } catch {
    return false;
  }
}

export async function startMockMcpServer(options: MockMcpServerOptions): Promise<MockMcpServer> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) throw new Error('mock MCP server refuses a non-loopback host (loopback only)');
  if (options.credentials.length === 0) throw new Error('at least one fixture credential is required');

  const log = options.log ?? (() => {});
  const registry = new ToolRegistry();
  // Hash once; compare digests so unequal lengths cannot throw or leak timing.
  const creds = options.credentials.map((c) => ({ digest: sha(c.token), team: c.team }));
  const sessions = new Map<string, { digest: Buffer; team: string }>();

  function authenticate(header: string | undefined): { digest: Buffer; team: string } | null {
    if (!header || !header.startsWith('Bearer ')) return null;
    const presented = sha(header.slice('Bearer '.length));
    let found: { digest: Buffer; team: string } | null = null;
    for (const c of creds) if (timingSafeEqual(presented, c.digest)) found = c;
    return found;
  }

  function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
    res.end(payload);
  }

  function handleRpc(
    res: http.ServerResponse,
    body: unknown,
    principal: { digest: Buffer; team: string },
    sessionId: string | undefined,
  ): number {
    const parsed = parseMessage(body);
    if (parsed.kind === 'invalid') {
      send(res, 400, fail(null, ERR_INVALID_REQUEST, 'invalid request'));
      return 400;
    }
    const method = parsed.message.method;
    if (method === 'initialize' && parsed.kind === 'request') {
      const id = randomUUID();
      sessions.set(id, principal);
      send(
        res,
        200,
        ok(parsed.message.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ratio-mock-mcp', version: '0.0.0' },
        }),
        { [SESSION_HEADER]: id },
      );
      return 200;
    }
    // Everything else needs an initialized session bound to this credential.
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      send(res, 400, fail(parsed.kind === 'request' ? parsed.message.id : null, ERR_INVALID_REQUEST, 'session not initialized'));
      return 400;
    }
    if (!timingSafeEqual(session.digest, principal.digest)) {
      send(res, 401, { error: 'unauthorized' });
      return 401;
    }
    if (parsed.kind === 'notification') {
      res.writeHead(202);
      res.end();
      return 202;
    }
    const { id, params } = parsed.message;
    let response: JsonRpcResponse;
    if (method === 'tools/list') {
      response = ok(id, { tools: registry.list() });
    } else if (method === 'tools/call') {
      if (!isRecord(params) || typeof params.name !== 'string') {
        response = fail(id, ERR_INVALID_PARAMS, 'invalid params');
      } else {
        try {
          response = ok(id, registry.call(params.name, params.arguments, session.team));
        } catch (e) {
          if (e instanceof UnknownToolError) response = fail(id, ERR_METHOD_NOT_FOUND, 'tool not found');
          else if (e instanceof InvalidArgumentsError) response = fail(id, ERR_INVALID_PARAMS, 'invalid params');
          else response = fail(id, ERR_INVALID_REQUEST, 'internal error');
        }
      }
    } else {
      response = fail(id, ERR_METHOD_NOT_FOUND, 'method not found');
    }
    send(res, 200, response);
    return 200;
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const done = (status: number) => log(`${req.method} ${path} -> ${status}`);

    if (path !== MCP_PATH) {
      send(res, 404, { error: 'not found' });
      return done(404);
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
      return done(405);
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      send(res, 403, { error: 'forbidden origin' });
      return done(403);
    }
    const principal = authenticate(req.headers.authorization);
    if (!principal) {
      send(res, 401, { error: 'unauthorized' });
      return done(401);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        send(res, 413, { error: 'payload too large' });
        return done(413);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(res, 400, fail(null, ERR_PARSE, 'parse error'));
        return done(400);
      }
      const sessionHeader = req.headers[SESSION_HEADER];
      done(handleRpc(res, body, principal, typeof sessionHeader === 'string' ? sessionHeader : undefined));
    });
    req.on('error', () => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${hostPart}:${address.port}${MCP_PATH}`,
    address,
    testHooks: {
      setToolDescription: (name, description) => registry.setDescription(name, description),
      mutationCount: () => registry.mutationCount(),
      reset: () => registry.reset(),
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
