// pathOnly(): what the server logs for a request target. Node keeps the raw
// request-target in req.url — including ABSOLUTE-FORM targets such as
// `http://user:secret@example/api?x=1` — so splitting on `?` is not enough:
// the authority (with userinfo credentials) would be logged. Only a parsed
// pathname may reach a log; anything else becomes a fixed placeholder.

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { pathOnly, NON_PATH_TARGET } from './gateway/internalError';
import { withGateway } from './gateway/withGateway';
import { SlidingWindowRateLimiter } from './gateway/rateLimit';

const LEAKS = ['user', 'secret', 'example', 'evil', 'x=1', 'sig='];

function expectNoLeak(out: string) {
  for (const l of LEAKS) expect(out).not.toContain(l);
}

describe('pathOnly', () => {
  it.each([
    ['origin-form with query', '/api/v1/ai/chat?sessionId=abc&sig=zzz', '/api/v1/ai/chat'],
    ['origin-form with fragment', '/api/x#frag', '/api/x'],
    ['absolute-form with userinfo', 'http://user:secret@example/api?x=1', '/api'],
    ['absolute-form https with userinfo + port', 'https://user:secret@example.com:8443/a/b?x=1', '/a/b'],
    ['absolute-form, upper-case scheme', 'HTTP://user:secret@example/api', '/api'],
    ['scheme-relative //host/path', '//user:secret@example/path?x=1', '/path'],
    ['backslash host form \\\\host\\path', '\\\\user:secret@example\\path', '/path'],
    ['mixed slash/backslash', '/\\user:secret@example/path', '/path'],
    ['absolute-form with backslashes', 'http:\\\\user:secret@example\\api', '/api'],
  ])('%s', (_label, input, expected) => {
    const out = pathOnly(input);
    expect(out).toBe(expected);
    expectNoLeak(out);
  });

  it.each([
    ['authority-form (CONNECT)', 'example.com:443'],
    ['authority-form with userinfo', 'user:secret@example.com:443'],
    ['non-http absolute-form', 'ftp://user:secret@example/x'],
    ['opaque scheme', 'mailto:user@example'],
    ['encoded slashes hiding an authority', 'http:%2F%2Fuser:secret@example/api'],
    ['bare word', 'example'],
  ])('%s → fixed placeholder', (_label, input) => {
    const out = pathOnly(input);
    expect(out).toBe(NON_PATH_TARGET);
    expectNoLeak(out);
  });

  it('asterisk-form is logged as "*"', () => {
    expect(pathOnly('*')).toBe('*');
  });

  it.each([
    ['%40 in a path segment', '/x/user%40example/secret'],
    ['raw @ in a path segment', '/x/user:secret@example/api'],
    ['encoded authority inside an origin-form path', '/x/http:%2F%2Fuser:secret@example'],
  ])('%s → placeholder (credential-shaped path)', (_label, input) => {
    const out = pathOnly(input);
    expectNoLeak(out);
  });

  it('empty / undefined → empty string', () => {
    expect(pathOnly(undefined)).toBe('');
    expect(pathOnly('')).toBe('');
  });

  it('very long targets are bounded (no huge log lines) and never throw', () => {
    const long = '/a'.repeat(200_000) + '?secret=1';
    const out = pathOnly(long);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).not.toContain('secret');
    expect(() => pathOnly('http://[::1'.repeat(1000))).not.toThrow();
    expect(() => pathOnly('http://%zz@')).not.toThrow();
  });
});

// --- Live-style: every logger goes through pathOnly ---------------------------

let lines: string[];
beforeEach(() => {
  lines = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

function throwingGateway() {
  return withGateway(
    () => {
      throw new Error('boom');
    },
    { methods: ['GET'], env: {}, limiter: new SlidingWindowRateLimiter() },
  );
}

describe('withGateway logs no authority from an absolute-form req.url', () => {
  it('request log + 500 log carry the pathname only', async () => {
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      status(c: number) {
        res.statusCode = c;
        return res;
      },
      json() {
        res.headersSent = true;
        return res;
      },
    };
    await throwingGateway()(
      {
        method: 'GET',
        url: 'http://user:secret@example/api?x=1',
        headers: { 'x-forwarded-for': '192.0.2.10' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as NextApiRequest,
      res as unknown as NextApiResponse,
    );
    expect(res.statusCode).toBe(500);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const all = lines.join('\n');
    expectNoLeak(all);
    for (const l of lines) expect((JSON.parse(l) as { path: string }).path).toBe('/api');
  });

  it('a raw absolute-form request line over a real socket to a Node server', async () => {
    const handler = throwingGateway();
    const server = http.createServer((req, res) => {
      const r = res as unknown as NextApiResponse & { status: (c: number) => unknown; json: (b: unknown) => void };
      r.status = (c: number) => {
        res.statusCode = c;
        return r;
      };
      r.json = (b: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(b));
      };
      void handler(req as unknown as NextApiRequest, r);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write('GET http://user:secret@example/api?x=1 HTTP/1.1\r\nHost: example\r\nConnection: close\r\n\r\n');
        });
        let buf = '';
        sock.on('data', (d) => (buf += d.toString()));
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
      });
      expect(raw).toMatch(/^HTTP\/1\.1 500/);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expectNoLeak(lines.join('\n'));
      for (const l of lines) expect((JSON.parse(l) as { path: string }).path).toBe('/api');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
