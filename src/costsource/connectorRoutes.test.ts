// Connector API routes — the live-data auth gate on /api/costsource/rows and the
// /api/v1/connectors registry + probe. fetch is stubbed; nothing leaves the
// process. Lives under src/ so Next never compiles it into a deployed route.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const ENV_KEYS = [
  'RATIO_API_TOKEN',
  'FOCUS_ENDPOINT_URL',
  'FOCUS_ENDPOINT_TOKEN',
  'AI_PROVIDER',
  'COSTSOURCE_POINTFIVE_LIVE',
  'POINTFIVE_OAUTH_CLIENT_ID',
  'POINTFIVE_OAUTH_CLIENT_SECRET',
  'POINTFIVE_OAUTH_TOKEN_URL',
] as const;

function configurePointFiveLive() {
  process.env.COSTSOURCE_POINTFIVE_LIVE = 'true';
  process.env.POINTFIVE_OAUTH_CLIENT_ID = 'client';
  process.env.POINTFIVE_OAUTH_CLIENT_SECRET = 'secret';
  process.env.POINTFIVE_OAUTH_TOKEN_URL = 'https://auth.pointfive.example/token';
}
const CSV =
  'BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,ResourceId\n42,USD,2026-06-02T00:00:00Z,VMware vSphere,arn:ratio:workload/wl-001\n';
const QUERY = { sourceId: 'focus-endpoint', start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

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
});

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
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

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}): NextApiRequest {
  return { method: 'GET', url: '/api', query, headers } as unknown as NextApiRequest;
}

async function callRows(headers: Record<string, string> = {}) {
  const { default: handler } = await import('../../pages/api/costsource/rows');
  const res = makeRes();
  await handler(makeReq(QUERY, headers), res as unknown as NextApiResponse);
  return res;
}

describe('/api/costsource/rows — live-data auth gate', () => {
  it('serves sandbox seed sources without a token (demo unchanged)', async () => {
    const { default: handler } = await import('../../pages/api/costsource/rows');
    const res = makeRes();
    await handler(makeReq({ ...QUERY, sourceId: 'pointfive-sandbox' }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(200);
  });

  it('refuses a live connector when no RATIO_API_TOKEN is configured', async () => {
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await callRows();
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).toContain('RATIO_API_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a live connector with a wrong token', async () => {
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    process.env.RATIO_API_TOKEN = 'right';
    const res = await callRows({ authorization: 'Bearer wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('serves normalized live rows with the right token', async () => {
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    process.env.FOCUS_ENDPOINT_TOKEN = 'upstream';
    process.env.RATIO_API_TOKEN = 'right';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(CSV)));
    const res = await callRows({ authorization: 'Bearer right' });
    expect(res.statusCode).toBe(200);
    const body = res.body as { rows: Array<{ BilledCost: number; ServiceName: string; x_RatioSourceId: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ BilledCost: 42, ServiceName: 'VMware vSphere', x_RatioSourceId: 'focus-endpoint' });
  });

  it('returns 409 (not configured) for an available connector, with no network', async () => {
    // Deny-by-default (H1): the 409 is only reachable after live-data auth.
    process.env.RATIO_API_TOKEN = 'right';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await callRows({ authorization: 'Bearer right' });
    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/api/v1/connectors', () => {
  async function callRegistry(query: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const { default: handler } = await import('../../pages/api/v1/connectors/index');
    const res = makeRes();
    await handler(makeReq(query, headers), res as unknown as NextApiResponse);
    return res as ReturnType<typeof makeRes> & {
      body: {
        connectors: Array<{ id: string; connection?: string; setup?: { requiredEnv: string[] } }>;
        summary: Record<string, number>;
        health?: Array<{ sourceId: string; reachable: boolean }>;
      };
    };
  }

  it('lists every connector as available with its env contract in a default build', async () => {
    const res = await callRegistry();
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toEqual({ connected: 0, available: 6, incomplete: 0, disabled: 0 });
    const aws = res.body.connectors.find((c) => c.id === 'aws-data-exports');
    expect(aws?.setup?.requiredEnv).toContain('AWS_FOCUS_EXPORT_BUCKET');
    expect(res.body.health).toBeUndefined();
  });

  it('probes only configured connectors and reports their live health', async () => {
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    // H2: a probe invokes connectors with server credentials — token required.
    process.env.RATIO_API_TOKEN = 'right';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const res = await callRegistry({ probe: 'true' }, { authorization: 'Bearer right' });
    expect(res.statusCode).toBe(200);
    expect(res.body.summary.connected).toBe(1);
    expect(res.body.health).toEqual([expect.objectContaining({ sourceId: 'focus-endpoint', reachable: true })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-GET methods through the gateway', async () => {
    const { default: handler } = await import('../../pages/api/v1/connectors/index');
    const res = makeRes();
    await handler({ ...makeReq({}), method: 'POST' } as NextApiRequest, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Security review findings (PR #41): deny-by-default live-data gate.
// ---------------------------------------------------------------------------

describe('H1 — /api/costsource/rows is deny-by-default for non-sandbox sources', () => {
  async function rowsFor(sourceId: string, headers: Record<string, string> = {}) {
    const { default: handler } = await import('../../pages/api/costsource/rows');
    const res = makeRes();
    await handler(makeReq({ ...QUERY, sourceId }, headers), res as unknown as NextApiResponse);
    return res;
  }

  it('refuses anonymous rows from configured pointfive-live and makes no upstream call', async () => {
    configurePointFiveLive();
    const fetchMock = vi.fn(async () => Response.json({ access_token: 't', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await rowsFor('pointfive-live');
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses pointfive-live with a wrong token when RATIO_API_TOKEN is set', async () => {
    configurePointFiveLive();
    process.env.RATIO_API_TOKEN = 'right';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await rowsFor('pointfive-live', { authorization: 'Bearer wrong' });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 (not 404) to an anonymous request for an unknown source id', async () => {
    const res = await rowsFor('no-such-source');
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 for an unknown source id only after successful auth', async () => {
    process.env.RATIO_API_TOKEN = 'right';
    const res = await rowsFor('no-such-source', { authorization: 'Bearer right' });
    expect(res.statusCode).toBe(404);
  });

  it('still serves both offline sandbox sources anonymously', async () => {
    expect((await rowsFor('pointfive-sandbox')).statusCode).toBe(200);
    expect((await rowsFor('focus-file-sandbox')).statusCode).toBe(200);
  });
});

describe('H2 — /api/v1/connectors?probe=true always requires the API token', () => {
  async function registry(query: Record<string, string>, headers: Record<string, string> = {}) {
    const { default: handler } = await import('../../pages/api/v1/connectors/index');
    const res = makeRes();
    await handler(makeReq(query, headers), res as unknown as NextApiResponse);
    return res;
  }

  it('refuses an anonymous probe under AI_PROVIDER=mock with no token and invokes no connector', async () => {
    process.env.AI_PROVIDER = 'mock';
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const res = await registry({ probe: 'true' });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a probe with a wrong token and invokes no connector', async () => {
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    process.env.RATIO_API_TOKEN = 'right';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const res = await registry({ probe: '1' }, { authorization: 'Bearer wrong' });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still lists connectors anonymously without probe (unchanged)', async () => {
    process.env.AI_PROVIDER = 'mock';
    const res = await registry({});
    expect(res.statusCode).toBe(200);
  });
});

describe('H3 — /api/costsource/health is deny-by-default for non-sandbox sources', () => {
  async function health(sourceId: string, headers: Record<string, string> = {}) {
    const { default: handler } = await import('../../pages/api/costsource/health');
    const res = makeRes();
    await handler(makeReq({ sourceId }, headers), res as unknown as NextApiResponse);
    return res;
  }

  it('refuses an anonymous probe of a configured live connector with no transport call', async () => {
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const res = await health('focus-endpoint');
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an anonymous probe of configured pointfive-live with no upstream call', async () => {
    configurePointFiveLive();
    const fetchMock = vi.fn(async () => Response.json({ access_token: 't', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await health('pointfive-live');
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 for an unknown id anonymously, 404 after auth', async () => {
    expect((await health('no-such-source')).statusCode).toBe(401);
    process.env.RATIO_API_TOKEN = 'right';
    expect((await health('no-such-source', { authorization: 'Bearer right' })).statusCode).toBe(404);
  });

  it('serves sandbox health anonymously and live health with the right token', async () => {
    expect((await health('pointfive-sandbox')).statusCode).toBe(200);
    expect((await health('focus-file-sandbox')).statusCode).toBe(200);
    process.env.FOCUS_ENDPOINT_URL = 'https://billing.internal/focus.csv';
    process.env.RATIO_API_TOKEN = 'right';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(CSV)));
    const res = await health('focus-endpoint', { authorization: 'Bearer right' });
    expect(res.statusCode).toBe(200);
  });
});
