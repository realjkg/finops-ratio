// Final round before re-review:
//   1. failed-auth limiter keys on the socket address; X-Forwarded-For only
//      with RATIO_TRUSTED_PROXY_HOPS=N (Nth hop from the right)
//   2. GET /api/v1/connectors (no probe): anonymous callers get the neutral
//      projection, authenticated callers real status
//   3. Azure single-blob mode removed: a data-file URL is rejected
//   4. PointFive findings validated field by field

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createAzureBlobTransport } from './transports/azureBlobTransport';
import { PointFiveLiveAdapter } from './PointFiveLiveAdapter';
import type { PointFiveMcpClient, PointFiveOpportunity, PointFiveAnomaly } from './PointFiveMcpTransport';
import { rawRowsForVersion, resourceIdFor } from './seed';

const ENV_KEYS = [
  'RATIO_API_TOKEN',
  'RATIO_TRUSTED_PROXY_HOPS',
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
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

function req(query: Record<string, string>, headers: Record<string, string>, remoteAddress: string): NextApiRequest {
  return { method: 'GET', url: '/api', query, headers, socket: { remoteAddress } } as unknown as NextApiRequest;
}

type H = (a: NextApiRequest, b: NextApiResponse) => unknown;
const Q = { sourceId: 'kubernetes' };

async function healthHandler(): Promise<H> {
  return ((await import('../../pages/api/costsource/health')) as { default: H }).default;
}

async function hit(handler: H, headers: Record<string, string>, socket: string) {
  const res = makeRes();
  await handler(req(Q, headers, socket), res as unknown as NextApiResponse);
  return res.statusCode;
}

// ---------------------------------------------------------------------------
describe('1. failed-auth limiter client identity', () => {
  it('without RATIO_TRUSTED_PROXY_HOPS, rotating X-Forwarded-For does not reset the count', async () => {
    process.env.RATIO_API_TOKEN = 'right-token';
    const handler = await healthHandler();
    for (let i = 0; i < 1000; i += 1) {
      expect(await hit(handler, { authorization: 'Bearer wrong', 'x-forwarded-for': `10.9.${i >> 8}.${i & 255}` }, '203.0.113.50')).toBe(401);
    }
    expect(await hit(handler, { authorization: 'Bearer wrong', 'x-forwarded-for': '10.250.0.1' }, '203.0.113.50')).toBe(429);
  }, 60_000);

  it('without RATIO_TRUSTED_PROXY_HOPS, spoofing a victim IP in X-Forwarded-For does not lock the victim out', async () => {
    process.env.RATIO_API_TOKEN = 'right-token';
    const handler = await healthHandler();
    for (let i = 0; i < 1001; i += 1) {
      await hit(handler, { authorization: 'Bearer wrong', 'x-forwarded-for': '198.51.100.77' }, '203.0.113.66');
    }
    // The victim, connecting from its own address, is not blocked.
    expect(await hit(handler, { authorization: 'Bearer wrong' }, '198.51.100.77')).toBe(401);
  }, 60_000);

  it('with RATIO_TRUSTED_PROXY_HOPS=N, the Nth hop from the right is the client', async () => {
    process.env.RATIO_API_TOKEN = 'right-token';
    process.env.RATIO_TRUSTED_PROXY_HOPS = '2';
    const handler = await healthHandler();
    // client-forged, real client (added by the outer proxy), inner proxy
    const xff = (client: string) => `6.6.6.6, ${client}, 10.0.0.2`;
    for (let i = 0; i < 1000; i += 1) {
      expect(await hit(handler, { authorization: 'Bearer wrong', 'x-forwarded-for': xff('192.0.2.10') }, '10.0.0.1')).toBe(401);
    }
    expect(await hit(handler, { authorization: 'Bearer wrong', 'x-forwarded-for': xff('192.0.2.10') }, '10.0.0.1')).toBe(429);
    // A different real client behind the same proxies is unaffected, whatever it forges.
    expect(await hit(handler, { authorization: 'Bearer wrong', 'x-forwarded-for': xff('192.0.2.11') }, '10.0.0.1')).toBe(401);
  }, 60_000);

  it('an invalid RATIO_TRUSTED_PROXY_HOPS is ignored (socket address used)', async () => {
    const { clientIp } = await import('@/server/gateway/liveDataAuth');
    const r = req({}, { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '203.0.113.5');
    expect(clientIp(r, {})).toBe('203.0.113.5');
    expect(clientIp(r, { RATIO_TRUSTED_PROXY_HOPS: '0' })).toBe('203.0.113.5');
    expect(clientIp(r, { RATIO_TRUSTED_PROXY_HOPS: 'abc' })).toBe('203.0.113.5');
    expect(clientIp(r, { RATIO_TRUSTED_PROXY_HOPS: '1' })).toBe('2.2.2.2');
    expect(clientIp(r, { RATIO_TRUSTED_PROXY_HOPS: '2' })).toBe('1.1.1.1');
    expect(clientIp(r, { RATIO_TRUSTED_PROXY_HOPS: '3' })).toBe('203.0.113.5');
  });
});

// ---------------------------------------------------------------------------
describe('2. GET /api/v1/connectors (no probe) hides live status from anonymous callers', () => {
  async function list(headers: Record<string, string>) {
    const { default: handler } = (await import('../../pages/api/v1/connectors/index')) as { default: H };
    const res = makeRes();
    await handler(req({}, headers, '192.0.2.200'), res as unknown as NextApiResponse);
    return res as ReturnType<typeof makeRes> & {
      body: { connectors: Array<{ id: string; configured: boolean; connection?: string }>; summary: Record<string, number> };
    };
  }
  function configure() {
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    process.env.RATIO_API_TOKEN = 'right-token';
  }

  it('anonymous: neutral projection and neutral summary', async () => {
    configure();
    const { sourcesForEnv } = await import('./seed');
    const res = await list({});
    expect(res.statusCode).toBe(401); // token configured → gateway enforces auth
    // With no token configured the listing is public but neutral.
    delete process.env.RATIO_API_TOKEN;
    vi.resetModules();
    const anon = await list({});
    expect(anon.statusCode).toBe(200);
    const k8s = anon.body.connectors.find((c) => c.id === 'kubernetes');
    expect(k8s).toEqual(sourcesForEnv({}).find((c) => c.id === 'kubernetes'));
    expect(anon.body.summary.connected).toBe(0);
  });

  it('authenticated: real status and summary', async () => {
    configure();
    const res = await list({ authorization: 'Bearer right-token' });
    expect(res.statusCode).toBe(200);
    expect(res.body.connectors.find((c) => c.id === 'kubernetes')).toMatchObject({ configured: true, connection: 'connected' });
    expect(res.body.summary.connected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('3. Azure single-blob mode is removed', () => {
  it.each([
    'https://a.blob.core.windows.net/exports/focus/part_0.csv',
    'https://a.blob.core.windows.net/exports/focus/part_0.csv.gz',
    'https://a.blob.core.windows.net/exports/x.json',
  ])('rejects %s with a clear configuration message', (url) => {
    expect(() => createAzureBlobTransport({ exportUrl: url, sasToken: 'sig=x', fetch: vi.fn() })).toThrow(
      /AZURE_FOCUS_EXPORT_URL must name the export container/,
    );
  });

  it('still accepts a container (+ optional path)', () => {
    expect(() =>
      createAzureBlobTransport({ exportUrl: 'https://a.blob.core.windows.net/exports/focus/daily', sasToken: 'sig=x', fetch: vi.fn() }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('4. PointFive findings are validated field by field', () => {
  const ENV = {
    COSTSOURCE_POINTFIVE_LIVE: 'true',
    POINTFIVE_OAUTH_CLIENT_ID: 'id',
    POINTFIVE_OAUTH_CLIENT_SECRET: 's',
    POINTFIVE_OAUTH_TOKEN_URL: 'https://auth.example/token',
  };
  const OPP: PointFiveOpportunity = {
    id: 'o1',
    resourceId: resourceIdFor('wl-support'),
    category: 'rightsizing',
    title: 'Idle GPU',
    estimatedMonthlySavings: 1200,
    severity: 'warning',
    detectedAt: '2026-06-20T00:00:00Z',
  };
  const ANOM: PointFiveAnomaly = {
    id: 'a1',
    resourceId: resourceIdFor('wl-support'),
    category: 'spend_spike',
    title: 'Spike',
    observedSpendDelta: 800,
    severity: 'critical',
    detectedAt: '2026-06-21T00:00:00Z',
  };
  function adapter(opps: unknown[], anoms: unknown[]) {
    const t: PointFiveMcpClient = {
      ping: async () => true,
      fetchBillingRows: async () => rawRowsForVersion('1.0'),
      listOpportunities: async () => opps as PointFiveOpportunity[],
      listAnomalies: async () => anoms as PointFiveAnomaly[],
    };
    return new PointFiveLiveAdapter({ env: ENV, transportFactory: () => t });
  }

  it('valid findings pass and are normalized (decimal strings → numbers, ISO with ms)', async () => {
    const out = await adapter([{ ...OPP, estimatedMonthlySavings: '1200.50' }], [ANOM]).fetchFindings();
    expect(out[0]).toMatchObject({ estimatedMonthlySavings: 1200.5, detectedAt: '2026-06-20T00:00:00.000Z', status: 'open' });
    expect(out[1]).toMatchObject({ observedSpendDelta: 800, severity: 'critical', type: 'anomaly' });
  });

  it.each([
    ['negative savings', [{ ...OPP, estimatedMonthlySavings: -5 }], [], 1, /estimatedMonthlySavings/],
    ['non-decimal savings', [{ ...OPP, estimatedMonthlySavings: '0x10' }], [], 1, /estimatedMonthlySavings/],
    ['missing savings', [{ ...OPP, estimatedMonthlySavings: undefined }], [], 1, /estimatedMonthlySavings/],
    ['non-decimal delta', [], [{ ...ANOM, observedSpendDelta: 'lots' }], 1, /observedSpendDelta/],
    ['infinite delta', [], [{ ...ANOM, observedSpendDelta: Infinity }], 1, /observedSpendDelta/],
    ['bad severity', [{ ...OPP, severity: 'urgent' }], [], 1, /severity/],
    ['bad detectedAt', [OPP], [{ ...ANOM, detectedAt: '06/21/2026' }], 2, /detectedAt/],
    ['empty category', [{ ...OPP, category: '' }], [], 1, /category/],
    ['empty id', [{ ...OPP, id: '' }], [], 1, /id/],
    ['non-string title', [{ ...OPP, title: 5 }], [], 1, /title/],
  ])('%s → throws "pointfive-live: invalid finding N: <reason>"', async (_n, opps, anoms, n, reason) => {
    const err = await adapter(opps, anoms)
      .fetchFindings()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(new RegExp(`^pointfive-live: invalid finding ${n}: `));
    expect((err as Error).message).toMatch(reason);
  });
});
