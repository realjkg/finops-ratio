// Connector API routes — the live-data auth gate on /api/costsource/rows and the
// /api/v1/connectors registry + probe. fetch is stubbed; nothing leaves the
// process. Lives under src/ so Next never compiles it into a deployed route.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const ENV_KEYS = [
  'RATIO_API_TOKEN',
  'KUBERNETES_FOCUS_ENDPOINT',
  'KUBERNETES_FOCUS_TOKEN',
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
  'BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,ResourceId\n42,USD,2026-06-02T00:00:00Z,OpenCost namespace,arn:ratio:workload/wl-001\n';
const QUERY = { sourceId: 'kubernetes', start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

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
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await callRows();
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.body)).toContain('RATIO_API_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a live connector with a wrong token', async () => {
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    const res = await callRows({ authorization: 'Bearer wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('serves normalized live rows with the right token', async () => {
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    process.env.KUBERNETES_FOCUS_TOKEN = 'upstream';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(CSV)));
    const res = await callRows({ authorization: 'Bearer right-token-0123456789abcdef-0123456789' });
    expect(res.statusCode).toBe(200);
    const body = res.body as { rows: Array<{ BilledCost: number; ServiceName: string; x_RatioSourceId: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ BilledCost: 42, ServiceName: 'OpenCost namespace', x_RatioSourceId: 'kubernetes' });
  });

  it('returns 409 (not configured) for an available connector, with no network', async () => {
    // Deny-by-default (H1): the 409 is only reachable after live-data auth.
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await callRows({ authorization: 'Bearer right-token-0123456789abcdef-0123456789' });
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
    expect(res.body.summary).toEqual({ connected: 0, available: 5, incomplete: 0, disabled: 0 });
    const aws = res.body.connectors.find((c) => c.id === 'aws-data-exports');
    expect(aws?.setup?.requiredEnv).toContain('AWS_FOCUS_EXPORT_BUCKET');
    expect(res.body.health).toBeUndefined();
  });

  it('probes only configured connectors and reports their live health', async () => {
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    // H2: a probe invokes connectors with server credentials — token required.
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const res = await callRegistry({ probe: 'true' }, { authorization: 'Bearer right-token-0123456789abcdef-0123456789' });
    expect(res.statusCode).toBe(200);
    expect(res.body.summary.connected).toBe(1);
    expect(res.body.health).toEqual([expect.objectContaining({ sourceId: 'kubernetes', reachable: true })]);
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
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
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
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    const res = await rowsFor('no-such-source', { authorization: 'Bearer right-token-0123456789abcdef-0123456789' });
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
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const res = await registry({ probe: 'true' });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a probe with a wrong token and invokes no connector', async () => {
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
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
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const res = await health('kubernetes');
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
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    expect((await health('no-such-source', { authorization: 'Bearer right-token-0123456789abcdef-0123456789' })).statusCode).toBe(404);
  });

  it('serves sandbox health anonymously and live health with the right token', async () => {
    expect((await health('pointfive-sandbox')).statusCode).toBe(200);
    expect((await health('focus-file-sandbox')).statusCode).toBe(200);
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://billing.internal/focus.csv';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(CSV)));
    const res = await health('kubernetes', { authorization: 'Bearer right-token-0123456789abcdef-0123456789' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Upstream error bodies never reach API callers', () => {
  const MARKER = 'UPSTREAM-BODY-MARKER';
  const upstream401 = () => new Response(`${MARKER} denied for Bearer s3cr3t`, { status: 401 });

  function silenceWarn() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  it('rows: a failing live connector returns an error without the upstream body', async () => {
    const warn = silenceWarn();
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    vi.stubGlobal('fetch', vi.fn(async () => upstream401()));
    const res = await callRows({ authorization: 'Bearer right-token-0123456789abcdef-0123456789' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
    expect(JSON.stringify(res.body)).toContain('401');
    warn.mockRestore();
  });

  it('rows: a malformed upstream export body is not echoed in the parse error', async () => {
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    // Short line so the runtime's JSON error snippet would include all of it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`{"BilledCost":1}\n{"a": LEAKED}\n`)));
    const res = await callRows({ authorization: 'Bearer right-token-0123456789abcdef-0123456789' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain('LEAKED');
  });

  it('health: the probe detail carries status only, never the upstream body', async () => {
    const warn = silenceWarn();
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    vi.stubGlobal('fetch', vi.fn(async () => upstream401()));
    const { default: handler } = await import('../../pages/api/costsource/health');
    const res = makeRes();
    await handler(makeReq({ sourceId: 'kubernetes' }, { authorization: 'Bearer right-token-0123456789abcdef-0123456789' }), res as unknown as NextApiResponse);
    expect(JSON.stringify(res.body)).toContain('401');
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
    expect(JSON.stringify(res.body)).not.toContain('s3cr3t');
    warn.mockRestore();
  });

  it('probe: /api/v1/connectors?probe=true health never carries the upstream body', async () => {
    const warn = silenceWarn();
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    vi.stubGlobal('fetch', vi.fn(async () => upstream401()));
    const { default: handler } = await import('../../pages/api/v1/connectors/index');
    const res = makeRes();
    await handler(makeReq({ probe: 'true' }, { authorization: 'Bearer right-token-0123456789abcdef-0123456789' }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).toContain('401');
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
    warn.mockRestore();
  });
});

describe('/api/costsource/findings is deny-by-default for non-sandbox sources', () => {
  async function findings(sourceId: string, headers: Record<string, string> = {}) {
    const { default: handler } = await import('../../pages/api/costsource/findings');
    const res = makeRes();
    await handler(makeReq({ sourceId }, headers), res as unknown as NextApiResponse);
    return res;
  }

  it('refuses anonymous findings from configured pointfive-live and makes no upstream call', async () => {
    configurePointFiveLive();
    const fetchMock = vi.fn(async () => Response.json({ access_token: 't', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await findings('pointfive-live');
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses pointfive-live findings with a wrong token', async () => {
    configurePointFiveLive();
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await findings('pointfive-live', { authorization: 'Bearer wrong' });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 for an unknown id anonymously, 404 after auth', async () => {
    expect((await findings('no-such-source')).statusCode).toBe(401);
    process.env.RATIO_API_TOKEN = 'right-token-0123456789abcdef-0123456789';
    expect((await findings('no-such-source', { authorization: 'Bearer right-token-0123456789abcdef-0123456789' })).statusCode).toBe(404);
  });

  it('still serves sandbox findings anonymously', async () => {
    const res = await findings('pointfive-sandbox');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((await findings('focus-file-sandbox')).statusCode).toBe(200);
  });
});
