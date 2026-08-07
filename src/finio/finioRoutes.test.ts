// FinIO A2A route tests — exercises the gateway-wrapped handlers end to end
// with a fake req/res, mirroring src/ai/chatRoute.test.ts. Lives under src/ (NOT
// pages/) so Next never compiles it into a deployed route. No keys, no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handshakeHandler from '../../pages/api/v1/a2a/handshake';
import exportHandler from '../../pages/api/v1/finio/export';
import legacyHandshakeHandler from '../../pages/api/a2a/handshake';
import legacyExportHandler from '../../pages/api/finio/export';
import { validateFocusRows } from './focusValidation';
import type { FinioExport, HandshakeResult } from './FinioClient';

const ENV_KEYS = ['FINIO_PEER_TOKEN', 'FINIO_SESSION_SECRET', 'RATIO_API_TOKEN'] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FINIO_SESSION_SECRET = 'route-test-secret';
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

type TestRes = NextApiResponse & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
};

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

function makeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
}): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/api/v1/a2a/handshake',
    headers: opts.headers ?? {},
    body: opts.body,
    query: opts.query ?? {},
  } as unknown as NextApiRequest;
}

const validBody = {
  agentId: 'peer-agent',
  capabilities: ['finio.export'],
  focusVersion: '1.4',
  nonce: 'n-1',
};

/** Run the handshake and return the parsed result. */
async function openSession(body: unknown = validBody, headers: Record<string, string> = {}) {
  const res = makeRes();
  await handshakeHandler(makeReq({ method: 'POST', body, headers }), res);
  return { res, result: res.body as HandshakeResult };
}

/** Errors use the repo-standard gateway envelope. */
function errorOf(res: TestRes): { code: string; message: string } {
  const body = res.body as { error: { code: string; message: string } };
  return body.error;
}

// ---------------------------------------------------------------------------
// POST /api/v1/a2a/handshake
// ---------------------------------------------------------------------------

describe('POST /api/v1/a2a/handshake', () => {
  it('mints a session for a valid handshake', async () => {
    const { res, result } = await openSession();
    expect(res.statusCode).toBe(200);
    expect(result.sessionId).toBeTruthy();
    expect(result.accepts).toEqual(['finio.export']);
    expect(result.focusVersion).toBe('1.4');
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('negotiates down to the version the peer asked for', async () => {
    const { result } = await openSession({ ...validBody, focusVersion: '1.0' });
    expect(result.focusVersion).toBe('1.0');
  });

  it('returns 409 naming both versions on a version it does not support', async () => {
    const { res } = await openSession({ ...validBody, focusVersion: '2.0' });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('focus_version_mismatch');
    expect(errorOf(res).message).toContain("requested '2.0'");
    expect(errorOf(res).message).toContain('1.0, 1.1, 1.2, 1.3, 1.4');
  });

  it('returns 400 on a malformed body', async () => {
    const { res } = await openSession({ ...validBody, agentId: undefined });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('invalid_request');
  });

  it('returns 405 with an Allow header on a non-POST method', async () => {
    const res = makeRes();
    await handshakeHandler(makeReq({ method: 'GET', body: validBody }), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('sets rate-limit headers on every response (gateway is engaged)', async () => {
    const { res } = await openSession();
    expect(res.headers['x-ratelimit-limit']).toBe('1000');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('uses the repo-standard {error:{code,message}} envelope, not a bare string', async () => {
    const { res } = await openSession({ ...validBody, focusVersion: '9.9' });
    expect(res.body).toHaveProperty('error.code');
    expect(res.body).toHaveProperty('error.message');
  });

  describe('peer authentication', () => {
    it('does not require a peer token when none is configured', async () => {
      const { res } = await openSession();
      expect(res.statusCode).toBe(200);
    });

    it('returns 401 when a peer token is configured and absent', async () => {
      process.env.FINIO_PEER_TOKEN = 'peer-secret';
      const { res } = await openSession(validBody, {});
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('unauthorized_peer');
    });

    it('returns 401 when a peer token is configured and wrong', async () => {
      process.env.FINIO_PEER_TOKEN = 'peer-secret';
      const { res } = await openSession(validBody, { 'x-finio-peer-token': 'nope' });
      expect(res.statusCode).toBe(401);
    });

    it('accepts the configured peer token', async () => {
      process.env.FINIO_PEER_TOKEN = 'peer-secret';
      const { res } = await openSession(validBody, { 'x-finio-peer-token': 'peer-secret' });
      expect(res.statusCode).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/finio/export
// ---------------------------------------------------------------------------

describe('GET /api/v1/finio/export', () => {
  async function runExport(opts: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    method?: string;
  }) {
    const res = makeRes();
    await exportHandler(
      makeReq({
        method: opts.method ?? 'GET',
        url: '/api/v1/finio/export',
        query: opts.query,
        headers: opts.headers,
      }),
      res,
    );
    return res;
  }

  it('returns conformant FOCUS rows for a valid session', async () => {
    const { result } = await openSession();
    const res = await runExport({ query: { sessionId: result.sessionId } });
    expect(res.statusCode).toBe(200);

    const payload = res.body as FinioExport;
    expect(payload.focusVersion).toBe('1.4');
    expect(payload.rows.length).toBeGreaterThan(0);
    expect(validateFocusRows(payload.rows)).toEqual({ ok: true });
  });

  it('accepts the session via the X-FinIO-Session header', async () => {
    const { result } = await openSession();
    const res = await runExport({ headers: { 'x-finio-session': result.sessionId } });
    expect(res.statusCode).toBe(200);
  });

  it('emits rows at the version negotiated in the handshake, not a fixed default', async () => {
    const { result } = await openSession({ ...validBody, focusVersion: '1.0' });
    const res = await runExport({ query: { sessionId: result.sessionId } });
    const payload = res.body as FinioExport;
    expect(payload.focusVersion).toBe('1.0');
    // v1.1+ additive columns must be absent for a v1.0 peer.
    expect(payload.rows[0].ListCost).toBeUndefined();
    expect(payload.rows[0].CapacityReservationId).toBeUndefined();
  });

  it('returns 401 with no session at all', async () => {
    const res = await runExport({});
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe('invalid_session');
  });

  it('returns 401 for a forged session', async () => {
    const res = await runExport({ query: { sessionId: '9999999999999-1.4-deadbeefdeadbeef' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a session signed by a different deployment', async () => {
    const { result } = await openSession();
    process.env.FINIO_SESSION_SECRET = 'a-different-secret';
    const res = await runExport({ query: { sessionId: result.sessionId } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an expired session', async () => {
    const { result } = await openSession();
    const realTimeNow = Date.now;
    try {
      Date.now = () => new Date(result.expiresAt).getTime() + 1;
      const res = await runExport({ query: { sessionId: result.sessionId } });
      expect(res.statusCode).toBe(401);
    } finally {
      Date.now = realTimeNow;
    }
  });

  it('gives the same message for forged, malformed, and expired sessions', async () => {
    const messages = new Set<string>();
    for (const sessionId of ['garbage', '1-1.4-aaaa', '9999999999999-1.4-deadbeef']) {
      const res = await runExport({ query: { sessionId } });
      messages.add(errorOf(res).message);
    }
    expect(messages.size).toBe(1);
  });

  it('ignores Authorization: Bearer — that header belongs to the gateway tenant', async () => {
    const { result } = await openSession();
    const res = await runExport({ headers: { authorization: `Bearer ${result.sessionId}` } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 405 with an Allow header on a non-GET method', async () => {
    const res = await runExport({ method: 'POST' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// Legacy unversioned aliases
// ---------------------------------------------------------------------------

describe('deprecated unversioned routes', () => {
  it('/api/a2a/handshake still completes the exchange', async () => {
    const res = makeRes();
    await legacyHandshakeHandler(makeReq({ method: 'POST', body: validBody }), res);
    expect(res.statusCode).toBe(200);

    const exportRes = makeRes();
    await legacyExportHandler(
      makeReq({
        method: 'GET',
        url: '/api/finio/export',
        query: { sessionId: (res.body as HandshakeResult).sessionId },
      }),
      exportRes,
    );
    expect(exportRes.statusCode).toBe(200);
    expect(validateFocusRows((exportRes.body as FinioExport).rows)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// The seam's central claim
// ---------------------------------------------------------------------------

describe('mock/live row parity', () => {
  it('produces identical rows over both transports — only the transport differs', async () => {
    const { createFinioClient } = await import('./index');

    const mock = createFinioClient('mock');
    const mockHandshake = await mock.handshake({
      agentId: 'ratio-agent-v1',
      capabilities: ['finio.export'],
      focusVersion: '1.4',
      nonce: 'parity',
    });
    const mockExport = await mock.export(mockHandshake.sessionId);

    const { result } = await openSession();
    const res = makeRes();
    await exportHandler(
      makeReq({
        method: 'GET',
        url: '/api/v1/finio/export',
        query: { sessionId: result.sessionId },
      }),
      res,
    );
    const liveExport = res.body as FinioExport;

    expect(liveExport.focusVersion).toBe(mockExport.focusVersion);
    // generatedAt is a timestamp and legitimately differs; the rows must not.
    expect(liveExport.rows).toEqual(mockExport.rows);
  });
});
