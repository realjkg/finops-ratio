// Routes NOT wrapped in withGateway (costsource, prediction, tokenomics, report,
// hello): the same error discipline as the gateway.
//   - 500: a fixed `{ error: "Internal error", requestId }` (the route's flat
//     envelope) + X-Request-Id; the thrown message goes only to the structured
//     server log, redacted.
//   - 4xx: fixed strings that never echo caller input (no source id, no window
//     value, no workload id / model name).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { MockCostSourceClient } from '@/costsource/MockCostSourceClient';
import { FocusFileAdapter } from '@/costsource/FocusFileAdapter';
import { MockPredictionClient } from '@/prediction/MockPredictionClient';
import { MockTokenomicsClient } from '@/tokenomics/MockTokenomicsClient';
import { MockAttributionClient } from '@/attribution/MockAttributionClient';
import rowsHandler from '../../pages/api/costsource/rows';
import healthHandler from '../../pages/api/costsource/health';
import findingsHandler from '../../pages/api/costsource/findings';
import sourcesHandler from '../../pages/api/costsource/sources';
import ingestHandler from '../../pages/api/costsource/ingest';
import predictHandler from '../../pages/api/prediction/predict';
import accuracyHandler from '../../pages/api/prediction/accuracy';
import tokenomicsHandler from '../../pages/api/tokenomics';
import attributionHandler from '../../pages/api/attribution';
import helloHandler from '../../pages/api/hello';

const TOKEN = 'right-token-0123456789abcdef-0123456789';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const HOSTILE = '<img src=x onerror=alert(1)>EVILID/../../etc/passwd?x=1#y';
const SECRET_DETAIL = 'INTERNAL-DETAIL Bearer abc.def.SECRETTOKEN99 at https://h.example/p?sig=SASSECRET';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ENV_KEYS = [
  'RATIO_API_TOKEN',
  'KUBERNETES_FOCUS_ENDPOINT',
  'NUTANIX_ENDPOINT',
  'AZURE_FOCUS_EXPORT_URL',
  'AWS_FOCUS_EXPORT_BUCKET',
  'GCP_FOCUS_BQ_DATASET',
  'COSTSOURCE_POINTFIVE_LIVE',
];

let saved: Record<string, string | undefined>;
let errSpy: { mock: { calls: unknown[][] } };
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.RATIO_API_TOKEN = TOKEN;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type TestRes = NextApiResponse & { statusCode: number; body: unknown; headers: Record<string, string> };
function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    setHeader(k: string, v: string | number) {
      res.headers[k.toLowerCase()] = String(v);
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()];
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
    send(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res as unknown as TestRes;
}

let ip = 0;
function makeReq(
  method: string,
  opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): NextApiRequest {
  ip += 1;
  return {
    method,
    url: '/api/x',
    query: opts.query ?? {},
    body: opts.body,
    headers: { 'x-forwarded-for': `198.18.${Math.floor(ip / 250) % 250}.${ip % 250}`, ...(opts.headers ?? {}) },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

async function run(handler: unknown, req: NextApiRequest): Promise<TestRes> {
  const res = makeRes();
  await (handler as NextApiHandler)(req, res);
  return res;
}

const ROWS = rowsHandler;
const HEALTH = healthHandler;
const FINDINGS = findingsHandler;
const SOURCES = sourcesHandler;
const INGEST = ingestHandler;
const PREDICT = predictHandler;
const ACCURACY = accuracyHandler;
const TOKENOMICS = tokenomicsHandler;
const ATTRIBUTION = attributionHandler;
const JUNE = { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

function errorLog(): string {
  return errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

function expectGeneric500(res: TestRes) {
  expect(res.statusCode).toBe(500);
  const body = res.body as { error: string; requestId: string };
  expect(body).toEqual({ error: 'Internal error', requestId: expect.stringMatching(UUID) });
  expect(res.headers['x-request-id']).toBe(body.requestId);
  const text = JSON.stringify(res.body);
  expect(text).not.toContain('INTERNAL-DETAIL');
  expect(text).not.toContain('SECRETTOKEN99');
  // The detail is in the structured log, redacted, under the same requestId.
  const log = errorLog();
  const line = JSON.parse(log.split('\n').find((l) => l.includes(body.requestId)) ?? '{}') as Record<string, unknown>;
  expect(line.requestId).toBe(body.requestId);
  expect(line.status).toBe(500);
  expect(String(line.error)).toContain('INTERNAL-DETAIL');
  expect(log).not.toContain('SECRETTOKEN99');
  expect(log).not.toContain('SASSECRET');
}

describe('thrown internal errors never reach the caller', () => {
  it('rows', async () => {
    vi.spyOn(MockCostSourceClient.prototype, 'fetchCostRows').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(await run(ROWS, makeReq('GET', { query: { sourceId: 'pointfive-sandbox', ...JUNE } })));
  });

  it('findings', async () => {
    vi.spyOn(MockCostSourceClient.prototype, 'fetchFindings').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(await run(FINDINGS, makeReq('GET', { query: { sourceId: 'pointfive-sandbox' } })));
  });

  it('health', async () => {
    vi.spyOn(MockCostSourceClient.prototype, 'healthCheck').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(await run(HEALTH, makeReq('GET', { query: { sourceId: 'pointfive-sandbox' } })));
  });

  it('sources', async () => {
    vi.spyOn(MockCostSourceClient.prototype, 'listSources').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(await run(SOURCES, makeReq('GET')));
  });

  it('ingest', async () => {
    vi.spyOn(FocusFileAdapter, 'ingest').mockImplementation(() => {
      throw new Error(SECRET_DETAIL);
    });
    const body = {
      sourceId: 'focus-file-sandbox',
      version: '1.0',
      rows: [{ BilledCost: 1, ChargePeriodStart: '2026-06-02T00:00:00Z', BillingCurrency: 'USD' }],
      window: JUNE,
    };
    expectGeneric500(await run(INGEST, makeReq('POST', { body })));
  });

  it('prediction/predict (a non-"Unknown" error)', async () => {
    vi.spyOn(MockPredictionClient.prototype, 'predictChange').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(
      await run(PREDICT, makeReq('POST', { body: { type: 'scale', workloadId: 'wl-support', volumeMultiplier: 2 } })),
    );
  });

  it('prediction/accuracy', async () => {
    vi.spyOn(MockPredictionClient.prototype, 'getAccuracyReport').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(await run(ACCURACY, makeReq('GET')));
  });

  it('tokenomics', async () => {
    vi.spyOn(MockTokenomicsClient.prototype, 'getTokenomicsReport').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(await run(TOKENOMICS, makeReq('GET')));
  });

  it('attribution', async () => {
    vi.spyOn(MockAttributionClient.prototype, 'getAttributionReport').mockRejectedValue(new Error(SECRET_DETAIL));
    expectGeneric500(await run(ATTRIBUTION, makeReq('GET', { query: { dimension: 'team' } })));
  });

  it('a thrown upstream message that merely contains "Unknown" is not a 404 that echoes it', async () => {
    vi.spyOn(MockCostSourceClient.prototype, 'fetchCostRows').mockRejectedValue(
      new Error(`${SECRET_DETAIL} Unknown field from upstream`),
    );
    const res = await run(ROWS, makeReq('GET', { query: { sourceId: 'pointfive-sandbox', ...JUNE } }));
    expectGeneric500(res);
  });
});

describe('4xx messages are fixed and never echo caller input', () => {
  function expectNoEcho(res: TestRes) {
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('EVILID');
    expect(text).not.toContain('onerror');
    expect(text).not.toContain('passwd');
  }

  it.each([
    ['rows', ROWS, { ...JUNE }],
    ['health', HEALTH, {}],
    ['findings', FINDINGS, {}],
  ])('%s: unknown hostile sourceId → 404 "Unknown cost source"', async (_n, path, extra) => {
    const res = await run(path, makeReq('GET', { query: { sourceId: HOSTILE, ...extra }, headers: AUTH }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Unknown cost source' });
    expectNoEcho(res);
  });

  it.each([
    { start: `${HOSTILE}`, end: JUNE.end },
    { start: JUNE.start, end: `2026-07-01T00:00:00Z${HOSTILE}` },
    { start: JUNE.end, end: JUNE.start },
  ])('rows: hostile / invalid window %j → 400 with a fixed message', async (w) => {
    const res = await run(ROWS, makeReq('GET', { query: { sourceId: 'pointfive-sandbox', ...w } }));
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.body as object)).toEqual(['error']);
    expect((res.body as { error: string }).error).toMatch(/^invalid cost window: /);
    expectNoEcho(res);
  });

  it('rows: an unconfigured connector → 409 with a fixed message (no id, no env names)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const res = await run(ROWS, makeReq('GET', { query: { sourceId: 'kubernetes', ...JUNE }, headers: AUTH }));
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Cost source is not configured — live credentials required' });
  });

  it('rows: "not configured" / "does not provide" thrown with the caller id → fixed 409 / 422', async () => {
    const spy = vi.spyOn(MockCostSourceClient.prototype, 'fetchCostRows');
    spy.mockRejectedValueOnce(new Error(`Source '${HOSTILE}' is not configured — live credentials required (PR E)`));
    let res = await run(ROWS, makeReq('GET', { query: { sourceId: 'pointfive-sandbox', ...JUNE } }));
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Cost source is not configured — live credentials required' });
    expectNoEcho(res);

    spy.mockRejectedValueOnce(new Error(`Source '${HOSTILE}' does not provide cost rows`));
    res = await run(ROWS, makeReq('GET', { query: { sourceId: 'pointfive-sandbox', ...JUNE } }));
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'Cost source does not provide cost rows' });
    expectNoEcho(res);

    spy.mockRejectedValueOnce(new Error(`Unknown cost source '${HOSTILE}'`));
    res = await run(ROWS, makeReq('GET', { query: { sourceId: 'pointfive-sandbox', ...JUNE } }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Unknown cost source' });
    expectNoEcho(res);
  });

  it('ingest: a non-focus_file hostile sourceId → 422 fixed message', async () => {
    const res = await run(
      INGEST,
      makeReq('POST', { body: { sourceId: HOSTILE, version: '1.0', rows: [] } }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      error: 'sourceId is not a focus_file source. Use /api/costsource/rows for other sources.',
    });
    expectNoEcho(res);
  });

  it('ingest: a hostile window → 400 with the fixed window message (not a 500)', async () => {
    const res = await run(
      INGEST,
      makeReq('POST', {
        body: { sourceId: 'focus-file-sandbox', version: '1.0', rows: [], window: { start: HOSTILE, end: HOSTILE } },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/^invalid cost window: /);
    expectNoEcho(res);
  });

  it('ingest: a hostile cell value is never quoted in the row error', async () => {
    const res = await run(
      INGEST,
      makeReq('POST', {
        body: {
          sourceId: 'focus-file-sandbox',
          version: '1.0',
          rows: [{ BilledCost: HOSTILE, ChargePeriodStart: HOSTILE, BillingCurrency: HOSTILE }],
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/invalid FOCUS row 1: /);
    expectNoEcho(res);
  });

  it('predict: unknown hostile workloadId → 404 "Unknown workload"', async () => {
    const res = await run(PREDICT, makeReq('POST', { body: { type: 'scale', workloadId: HOSTILE, volumeMultiplier: 2 } }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Unknown workload' });
    expectNoEcho(res);
  });

  it('predict: unknown hostile model → 404 "Unknown model"', async () => {
    const res = await run(
      PREDICT,
      makeReq('POST', {
        body: { type: 'model_switch', workloadId: 'wl-support', fromModel: HOSTILE, toModel: 'gpt-4o-mini' },
      }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Unknown model' });
    expectNoEcho(res);
  });

  it('attribution: hostile / non-boolean dimension → 400 with the fixed message', async () => {
    for (const dimension of [HOSTILE, 'portfolios', '']) {
      const res = await run(ATTRIBUTION, makeReq('GET', { query: { dimension } }));
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'dimension must be one of team, user' });
      expectNoEcho(res);
    }
  });
});

describe('attribution: GET-only route contract', () => {
  it.each(['POST', 'PUT', 'DELETE'])('%s → 405 with Allow: GET', async (method) => {
    const res = await run(ATTRIBUTION, makeReq(method));
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(res.headers['allow']).toBe('GET');
  });

  it('a valid dimension returns a value-agnostic report on the 200 wire', async () => {
    const res = await run(ATTRIBUTION, makeReq('GET', { query: { dimension: 'team' } }));
    expect(res.statusCode).toBe(200);
    const body = res.body as { dimension: string; rows: unknown[] };
    expect(body.dimension).toBe('team');
    expect(body.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/valueRatio|value_ratio|total_value|credits/i);
  });

  it('an absent dimension defaults to team', async () => {
    const res = await run(ATTRIBUTION, makeReq('GET'));
    expect(res.statusCode).toBe(200);
    expect((res.body as { dimension: string }).dimension).toBe('team');
  });
});

describe('ingest 400s forward only the known validator grammar', () => {
  const base = { sourceId: 'focus-file-sandbox', version: '1.0' };
  const good = { BilledCost: 1, ChargePeriodStart: '2026-06-02T00:00:00Z', BillingCurrency: 'USD' };

  it.each([
    [{ ...good, BillingCurrency: 'ZZZ' }, 'focus-file-sandbox: invalid FOCUS row 1: BillingCurrency is not an ISO-4217 currency code'],
    [{ ...good, BilledCost: 'abc' }, 'focus-file-sandbox: invalid FOCUS row 1: BilledCost is not a number'],
    [{ ...good, ChargePeriodStart: 'nope' }, 'focus-file-sandbox: invalid FOCUS row 1: ChargePeriodStart is not a valid date'],
    [{ BilledCost: 1, ChargePeriodStart: '2026-06-02T00:00:00Z' }, 'focus-file-sandbox: invalid FOCUS row 1: missing required column BillingCurrency'],
    ['not-an-object', 'focus-file-sandbox: invalid FOCUS row 1: row is not an object'],
  ])('known form %j is forwarded as a 400', async (row, message) => {
    const res = await run(INGEST, makeReq('POST', { body: { ...base, rows: [row] } }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: message });
  });

  it.each([
    ['a {"toString":1} currency', { ...good, BillingCurrency: { toString: 1 } }],
    ['a non-primitive ResourceId', { ...good, ResourceId: { toString: 1 } }],
  ])('%s is not forwarded: generic 500 with requestId', async (_l, row) => {
    const res = await run(INGEST, makeReq('POST', { body: { ...base, rows: [row] } }));
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: string; requestId: string };
    expect(body).toEqual({ error: 'Internal error', requestId: expect.stringMatching(UUID) });
    expect(res.headers['x-request-id']).toBe(body.requestId);
    expect(JSON.stringify(res.body)).not.toMatch(/primitive|invalid FOCUS row/);
  });
});

describe('predict: an unknown change type is a fixed 400, not a 500', () => {
  it.each(['teleport', '<b>EVILTYPE</b>', '', 42])('type %j', async (type) => {
    const res = await run(PREDICT, makeReq('POST', { body: { type, workloadId: 'wl-support' } }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: '`type` must be one of model_switch, demand_shape, scale, budget' });
    expect(JSON.stringify(res.body)).not.toContain('EVILTYPE');
    expect(JSON.stringify(res.body)).not.toContain('teleport');
  });
});

describe('/api/hello is guarded too', () => {
  it('a failure while responding becomes the generic 500', async () => {
    const res = makeRes();
    const realStatus = res.status.bind(res);
    (res as unknown as { status: (c: number) => unknown }).status = (code: number) => {
      if (code === 200) throw new Error(SECRET_DETAIL);
      return realStatus(code);
    };
    await (helloHandler as unknown as NextApiHandler)(makeReq('GET'), res);
    expectGeneric500(res);
  });
});
