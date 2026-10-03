// Challenger review round — API routes.
//   #3  rows: invalid / inverted windows → 400
//   #6  timing-safe token comparison + failed-auth rate limiting (429)
//   #8  /api/costsource/sources: anonymous callers get env-independent status
//   #12 probe catch is redacted
//   #13 probe=true includes configured pointfive-live
//   #9  ingest preserves Tags / x_* and documents date + number normalization

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { rawRowsForVersion } from './seed';

const ENV_KEYS = [
  'RATIO_API_TOKEN',
  'KUBERNETES_FOCUS_ENDPOINT',
  'AI_PROVIDER',
  'COSTSOURCE_POINTFIVE_LIVE',
  'POINTFIVE_OAUTH_CLIENT_ID',
  'POINTFIVE_OAUTH_CLIENT_SECRET',
  'POINTFIVE_OAUTH_TOKEN_URL',
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('@/costsource');
});

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string | number) {
      res.headers[k.toLowerCase()] = String(v);
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
  return res;
}

function req(
  query: Record<string, string>,
  headers: Record<string, string> = {},
  extra: Partial<{ method: string; body: unknown; remoteAddress: string }> = {},
): NextApiRequest {
  return {
    method: extra.method ?? 'GET',
    url: '/api',
    query,
    headers,
    body: extra.body,
    socket: { remoteAddress: extra.remoteAddress ?? '192.0.2.1' },
  } as unknown as NextApiRequest;
}

async function run(path: string, r: NextApiRequest) {
  const { default: handler } = (await import(path)) as { default: (q: NextApiRequest, s: NextApiResponse) => unknown };
  const res = makeRes();
  await handler(r, res as unknown as NextApiResponse);
  return res;
}

const ROWS = '../../pages/api/costsource/rows';
const SANDBOX = { sourceId: 'pointfive-sandbox' };

// ---------------------------------------------------------------------------
describe('#3 rows rejects invalid / inverted windows with 400', () => {
  it.each([
    { start: 'banana', end: '2026-07-01T00:00:00Z' },
    { start: '2026-06-01T00:00:00Z', end: 'banana' },
    { start: '2026-07-01T00:00:00Z', end: '2026-06-01T00:00:00Z' },
    { start: '2026-06-01T00:00:00Z', end: '2026-06-01T00:00:00Z' },
  ])('%j', async (w) => {
    const res = await run(ROWS, req({ ...SANDBOX, ...w }));
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/window/i);
  });
});

// ---------------------------------------------------------------------------
describe('#6 token comparison', () => {
  it('tokensMatch is a timing-safe digest comparison with exact semantics', async () => {
    const { tokensMatch } = await import('@/server/gateway/auth');
    expect(typeof tokensMatch).toBe('function');
    expect(tokensMatch('right-token', 'right-token')).toBe(true);
    expect(tokensMatch('right', 'right-token')).toBe(false);
    expect(tokensMatch('right-tokenX', 'right-token')).toBe(false);
    expect(tokensMatch('', 'right-token')).toBe(false);
  });

  it('rejects a prefix and a token+1 char; accepts a lowercase scheme', async () => {
    process.env.RATIO_API_TOKEN = 'right-token';
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('BilledCost,BillingCurrency,ChargePeriodStart\n1,USD,2026-06-02T00:00:00Z\n')));
    const q = { sourceId: 'kubernetes', start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };
    expect((await run(ROWS, req(q, { authorization: 'Bearer right' }))).statusCode).toBe(401);
    expect((await run(ROWS, req(q, { authorization: 'Bearer right-tokenX' }))).statusCode).toBe(401);
    expect((await run(ROWS, req(q, { authorization: 'bearer right-token' }))).statusCode).toBe(200);
  });
});

describe('#6 failed-auth rate limiting on rows / findings / health', () => {
  it.each([
    ['rows', ROWS, { sourceId: 'kubernetes', start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' }],
    ['findings', '../../pages/api/costsource/findings', { sourceId: 'pointfive-live' }],
    ['health', '../../pages/api/costsource/health', { sourceId: 'kubernetes' }],
  ])('%s: 429 after 1000 failed attempts per minute from one client IP', async (_n, path, q) => {
    process.env.RATIO_API_TOKEN = 'right-token';
    const { default: handler } = (await import(path)) as { default: (a: NextApiRequest, b: NextApiResponse) => unknown };
    // Keyed on the socket address (X-Forwarded-For is ignored unless
    // RATIO_TRUSTED_PROXY_HOPS is set — see finalRound.test.ts).
    const ip = { remoteAddress: '203.0.113.9' };
    for (let i = 0; i < 1000; i += 1) {
      const res = makeRes();
      await handler(req(q, { authorization: 'Bearer wrong' }, ip), res as unknown as NextApiResponse);
      expect(res.statusCode).toBe(401);
    }
    const blocked = makeRes();
    await handler(req(q, { authorization: 'Bearer wrong' }, ip), blocked as unknown as NextApiResponse);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    // Even the right token is refused while the IP is blocked (no brute-force oracle).
    const right = makeRes();
    await handler(req(q, { authorization: 'Bearer right-token' }, ip), right as unknown as NextApiResponse);
    expect(right.statusCode).toBe(429);

    // Another client (different socket address) is unaffected.
    const other = makeRes();
    await handler(req(q, { authorization: 'Bearer wrong' }, { remoteAddress: '198.51.100.7' }), other as unknown as NextApiResponse);
    expect(other.statusCode).toBe(401);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('#8 /api/costsource/sources hides live status from anonymous callers', () => {
  const SOURCES = '../../pages/api/costsource/sources';
  function configure() {
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    process.env.COSTSOURCE_POINTFIVE_LIVE = 'true';
    process.env.POINTFIVE_OAUTH_CLIENT_ID = 'c';
    process.env.POINTFIVE_OAUTH_CLIENT_SECRET = 's';
    process.env.POINTFIVE_OAUTH_TOKEN_URL = 'https://auth.example/token';
    process.env.RATIO_API_TOKEN = 'right-token';
  }
  type Src = { id: string; configured: boolean; connection?: string; note: string };

  it('anonymous: non-sandbox entries are the env-independent projection', async () => {
    configure();
    const { sourcesForEnv } = await import('./seed');
    const neutral = sourcesForEnv({});
    const res = await run(SOURCES, req({}));
    const list = res.body as Src[];
    expect(res.statusCode).toBe(200);
    for (const s of list) {
      if (s.id === 'pointfive-sandbox' || s.id === 'focus-file-sandbox') continue;
      expect(s.configured).toBe(false);
      expect(s.connection).not.toBe('connected');
      expect(s).toEqual(neutral.find((n) => n.id === s.id));
    }
    expect(JSON.stringify(list)).not.toMatch(/— live;/);
  });

  it('a wrong token is treated as anonymous', async () => {
    configure();
    const list = (await run(SOURCES, req({}, { authorization: 'Bearer nope' }))).body as Src[];
    expect(list.find((s) => s.id === 'kubernetes')?.configured).toBe(false);
  });

  it('authenticated: real server-resolved status', async () => {
    configure();
    const list = (await run(SOURCES, req({}, { authorization: 'Bearer right-token' }))).body as Src[];
    expect(list.find((s) => s.id === 'kubernetes')).toMatchObject({ configured: true, connection: 'connected' });
    expect(list.find((s) => s.id === 'pointfive-live')?.configured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('#12 / #13 /api/v1/connectors?probe=true', () => {
  it('#13 probes a configured pointfive-live (no `connection` field) too', async () => {
    process.env.RATIO_API_TOKEN = 'right-token';
    process.env.COSTSOURCE_POINTFIVE_LIVE = 'true';
    process.env.POINTFIVE_OAUTH_CLIENT_ID = 'c';
    process.env.POINTFIVE_OAUTH_CLIENT_SECRET = 's';
    process.env.POINTFIVE_OAUTH_TOKEN_URL = 'https://auth.example/token';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 't', token_type: 'bearer', expires_in: 3600 })));
    const res = await run('../../pages/api/v1/connectors/index', req({ probe: 'true' }, { authorization: 'Bearer right-token' }));
    expect(res.statusCode).toBe(200);
    const health = (res.body as { health: Array<{ sourceId: string; reachable: boolean }> }).health;
    expect(health.map((h) => h.sourceId)).toContain('pointfive-live');
  });

  it('#12 a rejected probe is reported with redacted detail', async () => {
    process.env.RATIO_API_TOKEN = 'right-token';
    vi.doMock('@/costsource', async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      return {
        ...real,
        createCostSourceClient: () => ({
          listSources: async () => [
            { id: 'kubernetes', name: 'K8s', kind: 'kubernetes', focusVersion: '1.0', coverage: 'private_cloud', capabilities: ['costRows'], configured: true, note: '', connection: 'connected' },
          ],
          healthCheck: async () => {
            throw new Error('probe blew up: Bearer pr.tok.SECRET at https://x.example/p?sig=SASSECRET');
          },
        }),
      };
    });
    const res = await run('../../pages/api/v1/connectors/index', req({ probe: 'true' }, { authorization: 'Bearer right-token' }));
    const text = JSON.stringify(res.body);
    expect(text).toContain('probe blew up');
    expect(text).not.toContain('pr.tok.SECRET');
    expect(text).not.toContain('SASSECRET');
  });
});

// ---------------------------------------------------------------------------
describe('#9 ingest preserves Tags / x_* and normalizes dates + numbers', () => {
  const INGEST = '../../pages/api/costsource/ingest';
  const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

  it('keeps FOCUS Tags and every x_* extension column', async () => {
    const rows = rawRowsForVersion('1.2') as unknown as Record<string, unknown>[];
    rows[0] = { ...rows[0], Tags: { team: 'platform' }, x_CostCenter: 'cc-42', x_Nested: { a: 1 } };
    const res = await run(INGEST, req({}, {}, { method: 'POST', body: { sourceId: 'focus-file-sandbox', version: '1.2', rows, window: WINDOW } }));
    expect(res.statusCode).toBe(200);
    const out = (res.body as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(out.Tags).toEqual({ team: 'platform' });
    expect(out.x_CostCenter).toBe('cc-42');
    expect(out.x_Nested).toEqual({ a: 1 });
  });

  it('contract: dates normalize to ISO-8601 UTC with milliseconds; numeric strings coerce to numbers', async () => {
    const rows = rawRowsForVersion('1.0') as unknown as Record<string, unknown>[];
    rows[0] = { ...rows[0], ChargePeriodStart: '2026-06-03T04:05:06Z', BilledCost: '12.50', UsageQuantity: '1e3' };
    const res = await run(INGEST, req({}, {}, { method: 'POST', body: { sourceId: 'focus-file-sandbox', version: '1.0', rows, window: WINDOW } }));
    expect(res.statusCode).toBe(200);
    const out = (res.body as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(out.ChargePeriodStart).toBe('2026-06-03T04:05:06.000Z');
    expect(out.BilledCost).toBe(12.5);
    expect(out.UsageQuantity).toBe(1000);
  });
});
