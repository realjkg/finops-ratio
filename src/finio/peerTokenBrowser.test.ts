// FinIO peer token never reaches the browser (#17).
//
// LiveFinioClient used to read a NEXT_PUBLIC_ copy of the peer token and send
// it as X-FinIO-Peer-Token. Anything NEXT_PUBLIC_ is inlined into the client
// bundle at build time, so a deployment that set it published its A2A peer
// secret to every visitor. The browser client now sends no peer token; when a
// deployment enforces FINIO_PEER_TOKEN, live mode surfaces a typed
// FinioPeerAuthError ("use the API with X-FinIO-Peer-Token") instead of a
// generic failure. Mock mode is unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import handshakeHandler from '../../pages/api/v1/a2a/handshake';
import { LiveFinioClient, FinioPeerAuthError, FINIO_PEER_AUTH_MESSAGE } from './LiveFinioClient';
import { finioErrorView } from './FinioPage';
import { createFinioClient } from './index';

// Assembled at runtime so this file does not match its own scan.
const BANNED = ['NEXT', 'PUBLIC', 'FINIO', 'PEER', 'TOKEN'].join('_');
const ROOT = path.resolve(__dirname, '../..');

/** Every source file under a directory (skipping build output / deps). */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('no FinIO peer secret is compiled into the browser bundle', () => {
  it(`nothing under src/ or pages/ references the browser peer-token variable`, () => {
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'pages'))];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => fs.readFileSync(f, 'utf8').includes(BANNED));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('no NEXT_PUBLIC_ variable under src/ or pages/ names a FinIO peer credential', () => {
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'pages'))];
    const pattern = /NEXT_PUBLIC_[A-Z0-9_]*(FINIO|PEER)[A-Z0-9_]*/;
    const offenders = files.filter((f) => pattern.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the operator docs no longer offer the browser peer-token variable', () => {
    for (const doc of ['.env.example', 'README.md']) {
      const p = path.join(ROOT, doc);
      if (fs.existsSync(p)) expect(fs.readFileSync(p, 'utf8')).not.toContain(BANNED);
    }
  });
});

describe('LiveFinioClient sends no peer token', () => {
  let savedPublic: string | undefined;
  beforeEach(() => {
    savedPublic = process.env[BANNED];
    // Even if an operator still sets the old variable, nothing reads it.
    process.env[BANNED] = 'leaked-peer-secret';
  });
  afterEach(() => {
    if (savedPublic === undefined) delete process.env[BANNED];
    else process.env[BANNED] = savedPublic;
    vi.unstubAllGlobals();
  });

  it('handshake carries no X-FinIO-Peer-Token header', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ sessionId: 's', accepts: ['finio.export'], focusVersion: '1.4', expiresAt: 'x' }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await new LiveFinioClient().handshake({
      agentId: 'a',
      capabilities: ['finio.export'],
      focusVersion: '1.4',
      nonce: 'n',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] ?? {};
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.has('x-finio-peer-token')).toBe(false);
    expect(JSON.stringify(init)).not.toContain('leaked-peer-secret');
  });
});

// --- Live mode against a deployment that enforces FINIO_PEER_TOKEN -----------

type TestRes = NextApiResponse & { statusCode: number; body: unknown; headers: Record<string, string> };
function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    setHeader(key: string, value: string | number) {
      res.headers[key.toLowerCase()] = String(value);
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res as unknown as TestRes;
}

/** fetch → the real handshake route, in-process. */
function routeFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => {
      headers[k] = v;
    });
    const req = {
      method: init?.method ?? 'GET',
      url: '/api/v1/a2a/handshake',
      headers: { ...headers, 'x-forwarded-for': '203.0.113.7' },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    } as unknown as NextApiRequest;
    const res = makeRes();
    await handshakeHandler(req, res);
    return new Response(JSON.stringify(res.body), { status: res.statusCode });
  });
}

describe('live mode when the server enforces a peer token', () => {
  const KEYS = ['FINIO_PEER_TOKEN', 'FINIO_SESSION_SECRET', 'RATIO_API_TOKEN'] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.FINIO_PEER_TOKEN = 'server-side-peer-secret';
    process.env.FINIO_SESSION_SECRET = 'peer-test-secret';
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const request = { agentId: 'ratio-agent-v1', capabilities: ['finio.export' as const], focusVersion: '1.4' as const, nonce: 'n' };

  it('handshake rejects with a typed FinioPeerAuthError, not a generic error', async () => {
    vi.stubGlobal('fetch', routeFetch());
    const err = await new LiveFinioClient().handshake(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinioPeerAuthError);
    expect((err as FinioPeerAuthError).status).toBe(401);
    expect((err as Error).message).toBe(FINIO_PEER_AUTH_MESSAGE);
    expect((err as Error).message).toMatch(/peer authentication required/i);
    expect((err as Error).message).toContain('X-FinIO-Peer-Token');
    expect((err as Error).message).not.toContain('server-side-peer-secret');
  });

  it('the /finio/demo error view shows the peer-auth guidance', () => {
    const view = finioErrorView(new FinioPeerAuthError());
    expect(view.title).toBe('Peer authentication required');
    expect(view.message).toBe(FINIO_PEER_AUTH_MESSAGE);
  });

  it('other failures keep the generic "Exchange failed" view', () => {
    expect(finioErrorView(new Error('FinIO handshake error 409: nope'))).toEqual({
      title: 'Exchange failed',
      message: 'FinIO handshake error 409: nope',
    });
    expect(finioErrorView('plain')).toEqual({ title: 'Exchange failed', message: 'plain' });
  });

  it('a gateway tenant 401 is NOT mistaken for peer auth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Missing API token' } }), {
            status: 401,
          }),
      ),
    );
    const err = await new LiveFinioClient().handshake(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FinioPeerAuthError);
    expect((err as Error).message).toContain('401');
  });

  it('mock mode is unchanged: it never consults a peer token and still completes', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const client = createFinioClient('mock');
    const hs = await client.handshake(request);
    const data = await client.export(hs.sessionId);
    expect(data.rows.length).toBeGreaterThan(0);
  });
});
