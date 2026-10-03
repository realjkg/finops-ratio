// Challenger re-review (Medium + Low):
//   M1 strict window parsing everywhere a window is used
//   M2 a valid token is never throttled; weak RATIO_API_TOKEN → 503 for live
//      data; one-time X-Forwarded-For warning
//   M3 one shared failed-auth accounting for every requireLiveDataAuth route
//   LOW redactor additions / no over-matching; limiter pruning + IPv4-mapped
//      normalisation + missing socket; currency list; size caps

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  assertValidWindow,
  rowsFromRecords,
  selectExportObjects,
  validateFocusRecords,
} from './transports/focusExport';
import { expandWindow, createHttpFocusTransport } from './transports/httpFocusTransport';
import { createAwsS3Transport } from './transports/awsS3Transport';
import { createAzureBlobTransport } from './transports/azureBlobTransport';
import { redactUpstreamText } from './transports/redact';
import { SlidingWindowRateLimiter } from '@/server/gateway/rateLimit';

const TOKEN = 'live-token-0123456789abcdef-0123456789';
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

function req(
  query: Record<string, string>,
  headers: Record<string, string> = {},
  remoteAddress: string | undefined = '192.0.2.1',
): NextApiRequest {
  return {
    method: 'GET',
    url: '/api',
    query,
    headers,
    socket: remoteAddress === undefined ? {} : { remoteAddress },
  } as unknown as NextApiRequest;
}

type H = (a: NextApiRequest, b: NextApiResponse) => unknown;
async function handlerOf(path: string): Promise<H> {
  return ((await import(path)) as { default: H }).default;
}
async function hit(h: H, r: NextApiRequest) {
  const res = makeRes();
  await h(r, res as unknown as NextApiResponse);
  return res;
}

const ROWS = '../../pages/api/costsource/rows';
const HEALTH = '../../pages/api/costsource/health';
const FINDINGS = '../../pages/api/costsource/findings';
const SOURCES = '../../pages/api/costsource/sources';
const CONNECTORS = '../../pages/api/v1/connectors/index';
const CSV = 'BilledCost,BillingCurrency,ChargePeriodStart\n1,USD,2026-06-02T00:00:00Z\n';
const JUNE = { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

// ---------------------------------------------------------------------------
describe('M1 strict windows', () => {
  const BAD = ['2026-02-30', '1', '2', '2026-06-01 00:00:00', '06/01/2026', '2026-06-01 00:00:00 UTC', 'banana'];

  it.each(BAD)('rows route → 400 for start=%s', async (start) => {
    const res = await hit(await handlerOf(ROWS), req({ sourceId: 'pointfive-sandbox', start, end: '2026-07-01T00:00:00Z' }));
    expect(res.statusCode).toBe(400);
  });

  it.each(BAD)('assertValidWindow / selectExportObjects / rowsFromRecords reject end=%s', (end) => {
    const w = { start: '2026-06-01', end };
    expect(() => assertValidWindow(w)).toThrow(/window/i);
    expect(() => selectExportObjects([{ key: 'x/BILLING_PERIOD=2026-06/a.csv', lastModified: '2026-06-01T00:00:00Z', size: 1 }], w)).toThrow(/window/i);
    expect(() => rowsFromRecords([{ BilledCost: '1', BillingCurrency: 'USD', ChargePeriodStart: '2026-06-02' }], w, 'f')).toThrow(/window/i);
  });

  it('accepts date-only (00:00Z), Z / offset, and offset-less (UTC) timestamps', () => {
    expect(() => assertValidWindow({ start: '2026-06-01', end: '2026-07-01' })).not.toThrow();
    expect(() => assertValidWindow({ start: '2026-06-01T00:00:00+02:00', end: '2026-07-01T00:00:00Z' })).not.toThrow();
    expect(() => assertValidWindow({ start: '2026-06-01T00:00:00', end: '2026-07-01T00:00:00' })).not.toThrow();
  });

  it('{start}/{end} expansion uses the parsed, normalized instant', () => {
    expect(expandWindow('https://x/f?s={start}&e={end}', { start: '2026-06-01', end: '2026-06-01T12:00:00+02:00' })).toBe(
      `https://x/f?s=${encodeURIComponent('2026-06-01T00:00:00.000Z')}&e=${encodeURIComponent('2026-06-01T10:00:00.000Z')}`,
    );
  });
});

// ---------------------------------------------------------------------------
describe('M2 valid tokens are never throttled; weak tokens refuse live data', () => {
  it('1000 failures from one IP, then a valid token ⇒ 200 (and the next failure ⇒ 429)', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(CSV)));
    const rows = await handlerOf(ROWS);
    const q = { sourceId: 'kubernetes', ...JUNE };
    for (let i = 0; i < 1000; i += 1) {
      expect((await hit(rows, req(q, { authorization: 'Bearer wrong' }, '203.0.113.1'))).statusCode).toBe(401);
    }
    expect((await hit(rows, req(q, { authorization: `Bearer ${TOKEN}` }, '203.0.113.1'))).statusCode).toBe(200);
    expect((await hit(rows, req(q, { authorization: 'Bearer wrong' }, '203.0.113.1'))).statusCode).toBe(429);
  }, 60_000);

  it('a configured RATIO_API_TOKEN shorter than 32 characters ⇒ 503 for live data; sandbox unaffected', async () => {
    process.env.RATIO_API_TOKEN = 'short-token';
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    const fetchMock = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetchMock);
    const auth = { authorization: 'Bearer short-token' };
    for (const [path, q] of [
      [ROWS, { sourceId: 'kubernetes', ...JUNE }],
      [HEALTH, { sourceId: 'kubernetes' }],
      [FINDINGS, { sourceId: 'pointfive-live' }],
    ] as const) {
      const res = await hit(await handlerOf(path), req(q, auth));
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: 'RATIO_API_TOKEN is too weak to serve live cost data (≥32 chars, ≥10 distinct)' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await hit(await handlerOf(ROWS), req({ sourceId: 'pointfive-sandbox', ...JUNE }))).statusCode).toBe(200);
    expect((await hit(await handlerOf(HEALTH), req({ sourceId: 'focus-file-sandbox' }))).statusCode).toBe(200);
  });

  it('a weak token never unlocks live status or probing either', async () => {
    process.env.RATIO_API_TOKEN = 'short-token';
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    const list = (await hit(await handlerOf(SOURCES), req({}, { authorization: 'Bearer short-token' }))).body as Array<{ id: string; configured: boolean }>;
    expect(list.find((s) => s.id === 'kubernetes')?.configured).toBe(false);
    const probe = await hit(await handlerOf(CONNECTORS), req({ probe: 'true' }, { authorization: 'Bearer short-token' }));
    expect(probe.statusCode).toBe(503);
  });

  it('warns once when X-Forwarded-For arrives but RATIO_TRUSTED_PROXY_HOPS is unset', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const health = await handlerOf(HEALTH);
    // Multi-hop X-Forwarded-For (a proxy chain); a single hop is what Next adds itself.
    await hit(health, req({ sourceId: 'kubernetes' }, { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }));
    await hit(health, req({ sourceId: 'kubernetes' }, { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }));
    await hit(await handlerOf(SOURCES), req({}, { 'x-forwarded-for': '5.6.7.8, 10.0.0.1', authorization: 'Bearer nope' }));
    const calls = warn.mock.calls.filter((c) => String(c[0]).includes('RATIO_TRUSTED_PROXY_HOPS'));
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('M3 one failed-auth accounting for every live-auth route', () => {
  // The mock client's listSources() sleeps 120ms to show loading states; skip
  // that for the 1000-request loops (status resolution itself is unchanged).
  beforeEach(() => {
    vi.doMock('@/costsource', async (orig) => {
      const real = (await orig()) as typeof import('@/costsource');
      const { sourcesForEnv } = await import('./seed');
      return {
        ...real,
        createCostSourceClient: (mode?: 'mock' | 'live') => {
          const client = real.createCostSourceClient(mode);
          return Object.assign(Object.create(Object.getPrototypeOf(client)), client, {
            listSources: async () => sourcesForEnv(process.env),
          });
        },
      };
    });
  });
  afterEach(() => {
    vi.doUnmock('@/costsource');
  });

  it('/api/costsource/sources: a wrong bearer counts; over the limit ⇒ 429; a valid token still passes', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    process.env.KUBERNETES_FOCUS_ENDPOINT = 'https://opencost.internal/focus';
    const sources = await handlerOf(SOURCES);
    for (let i = 0; i < 1000; i += 1) {
      expect((await hit(sources, req({}, { authorization: 'Bearer wrong' }, '203.0.113.20'))).statusCode).toBe(200);
    }
    expect((await hit(sources, req({}, { authorization: 'Bearer wrong' }, '203.0.113.20'))).statusCode).toBe(429);
    // No bearer at all is not an auth attempt: neutral view, not throttled.
    expect((await hit(sources, req({}, {}, '203.0.113.20'))).statusCode).toBe(200);
    const ok = await hit(sources, req({}, { authorization: `Bearer ${TOKEN}` }, '203.0.113.20'));
    expect(ok.statusCode).toBe(200);
    expect((ok.body as Array<{ id: string; configured: boolean }>).find((s) => s.id === 'kubernetes')?.configured).toBe(true);
  }, 60_000);

  it('/api/v1/connectors: gateway-rejected bearers count; over the limit ⇒ 429; a valid token still passes', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    const connectors = await handlerOf(CONNECTORS);
    for (let i = 0; i < 1000; i += 1) {
      expect((await hit(connectors, req({}, { authorization: 'Bearer wrong' }, '203.0.113.21'))).statusCode).toBe(401);
    }
    expect((await hit(connectors, req({}, { authorization: 'Bearer wrong' }, '203.0.113.21'))).statusCode).toBe(429);
    expect((await hit(connectors, req({}, { authorization: `Bearer ${TOKEN}` }, '203.0.113.21'))).statusCode).toBe(200);
  }, 60_000);

  it('failures on /sources and /rows share one count per client', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    const sources = await handlerOf(SOURCES);
    const rows = await handlerOf(ROWS);
    for (let i = 0; i < 1000; i += 1) await hit(sources, req({}, { authorization: 'Bearer wrong' }, '203.0.113.22'));
    expect((await hit(rows, req({ sourceId: 'kubernetes', ...JUNE }, { authorization: 'Bearer wrong' }, '203.0.113.22'))).statusCode).toBe(429);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('LOW redactor', () => {
  const cases: Array<[string, string, string]> = [
    ['aws_secret_access_key=', 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
    ['AWS_SECRET_ACCESS_KEY:', 'AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI'],
    ['aws-secret-access-key JSON', '{"aws-secret-access-key":"wJalrXUtnFEMI/K7"}', 'wJalrXUtnFEMI'],
    ['awssecretaccesskey', 'awssecretaccesskey=wJalrXUtnFEMI', 'wJalrXUtnFEMI'],
    ['bare token=', 'callback?x=1 token=tk-SECRET-0001 more', 'tk-SECRET-0001'],
    ['Authorization: token', 'Authorization: token gh-tok-SECRET-2', 'gh-tok-SECRET-2'],
    ['ghp_', 'clone with ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'ghp_AbCdEfGhIjKlMnOp'],
    ['gho_', 'gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'gho_AbCdEfGh'],
    ['github_pat_', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'github_pat_11ABCDEFG'],
    ['sk-', 'key sk-AbCdEfGhIjKlMnOpQrStUvWx rejected', 'sk-AbCdEfGhIjKlMnOp'],
    ['sk-proj-', 'key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx rejected', 'sk-proj-AbCdEfGh'],
    ['long Bearer', 'auth Bearer abcdefghijklmnop0123 failed', 'abcdefghijklmnop0123'],
    ['long Basic', 'auth Basic dXNlcjpwYXNzd29yZDEyMzQ= failed', 'dXNlcjpwYXNzd29yZDEyMzQ'],
  ];
  it.each(cases)('redacts %s', (_n, input, secret) => {
    expect(redactUpstreamText(input, 10_000)).not.toContain(secret);
  });

  it.each(['Basic Support plan', 'Bearer of costs', 'the Bearer token was rejected', 'Basic tier limits apply'])(
    'leaves prose unchanged: %s',
    (text) => {
      expect(redactUpstreamText(text, 10_000)).toBe(text);
    },
  );
});

// ---------------------------------------------------------------------------
describe('LOW limiter hygiene', () => {
  it('prunes keys whose hits are all older than the window', () => {
    let now = 0;
    const l = new SlidingWindowRateLimiter(5, 1000, () => now);
    l.take('a');
    l.take('b');
    expect(l.size()).toBe(2);
    now = 5000;
    l.take('c');
    expect(l.size()).toBe(1);
  });

  it('normalises IPv4-mapped IPv6 socket addresses', async () => {
    const { clientIp } = await import('@/server/gateway/liveDataAuth');
    expect(clientIp(req({}, {}, '::ffff:203.0.113.5'), {})).toBe('203.0.113.5');
    expect(clientIp(req({}, {}, '2001:db8::1'), {})).toBe('2001:db8::1');
  });

  it('a missing socket address is counted under "unknown" but never blocks a valid token', async () => {
    process.env.RATIO_API_TOKEN = TOKEN;
    const health = await handlerOf(HEALTH);
    for (let i = 0; i < 1000; i += 1) await hit(health, req({ sourceId: 'kubernetes' }, { authorization: 'Bearer wrong' }, undefined));
    expect((await hit(health, req({ sourceId: 'kubernetes' }, { authorization: 'Bearer wrong' }, undefined))).statusCode).toBe(429);
    expect((await hit(health, req({ sourceId: 'kubernetes' }, { authorization: `Bearer ${TOKEN}` }, undefined))).statusCode).toBe(200);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('LOW currency must be a known ISO-4217 code', () => {
  // Node 22's Intl.supportedValuesOf('currency') does not list XXX (no
  // currency) or ZZZ, so both are rejected despite the right shape.
  it.each(['XXX', 'ZZZ', 'ABC'])('rejects %s', (c) => {
    expect(() => validateFocusRecords([{ BilledCost: '1', BillingCurrency: c, ChargePeriodStart: '2026-06-02' }], 'f')).toThrow(
      /BillingCurrency/,
    );
  });
  it.each(['USD', 'EUR', 'JPY', 'GBP'])('accepts %s', (c) => {
    expect(validateFocusRecords([{ BilledCost: '1', BillingCurrency: c, ChargePeriodStart: '2026-06-02' }], 'f')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('LOW size caps', () => {
  const big = 'BilledCost,BillingCurrency,ChargePeriodStart\n' + '1,USD,2026-06-02T00:00:00Z\n'.repeat(10);

  it('HTTP export object over maxObjectBytes ⇒ "export too large"', async () => {
    const t = createHttpFocusTransport({
      endpoint: 'https://ncm.example/api/cost',
      label: 'Nutanix',
      maxObjectBytes: 64,
      fetch: vi.fn(async () => new Response(big)) as unknown as typeof fetch,
    });
    await expect(t.fetchExportRows(JUNE)).rejects.toThrow(/export too large: Nutanix \(\d+ > 64\)/);
  });

  it('S3 manifest over maxManifestBytes and object over maxObjectBytes', async () => {
    const DATA = 'f/data/BILLING_PERIOD=2026-06/x-1.csv';
    const META = 'f/metadata/BILLING_PERIOD=2026-06/x-Manifest.json';
    const listing = `<ListBucketResult><Contents><Key>${DATA}</Key><LastModified>2026-06-20T00:00:00Z</LastModified><Size>10</Size></Contents><Contents><Key>${META}</Key><LastModified>2026-06-20T00:00:00Z</LastModified><Size>10</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`;
    const manifest = JSON.stringify({ dataFiles: [`s3://b/${DATA}`], pad: 'x'.repeat(200) });
    const ff = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes('list-type=2')) return new Response(listing);
      if (url.includes('Manifest.json')) return new Response(manifest);
      return new Response(big);
    }) as unknown as typeof fetch;
    const opts = { bucket: 'b', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's', fetch: ff };
    await expect(createAwsS3Transport({ ...opts, maxManifestBytes: 100 }).fetchExportRows(JUNE)).rejects.toThrow(
      /export too large: .*Manifest\.json \(\d+ > 100\)/,
    );
    await expect(createAwsS3Transport({ ...opts, maxObjectBytes: 64 }).fetchExportRows(JUNE)).rejects.toThrow(
      /export too large: .*x-1\.csv \(\d+ > 64\)/,
    );
  });

  it('Azure blob over maxObjectBytes', async () => {
    const RUN = 'focus/20260601-20260630/run1';
    const listing = `<?xml version="1.0"?><EnumerationResults><Blobs>${[`${RUN}/manifest.json`, `${RUN}/part_0.csv`]
      .map((n) => `<Blob><Name>${n}</Name><Properties><Last-Modified>Sat, 20 Jun 2026 00:00:00 GMT</Last-Modified><Content-Length>10</Content-Length></Properties></Blob>`)
      .join('')}</Blobs><NextMarker></NextMarker></EnumerationResults>`;
    const ff = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes('comp=list')) return new Response(listing);
      if (url.includes('manifest.json')) return Response.json({ blobs: [{ blobName: `${RUN}/part_0.csv` }] });
      return new Response(big);
    }) as unknown as typeof fetch;
    const t = createAzureBlobTransport({ exportUrl: 'https://a.blob.core.windows.net/exports/focus', sasToken: 'sig=x', fetch: ff, maxObjectBytes: 64 });
    await expect(t.fetchExportRows(JUNE)).rejects.toThrow(/export too large: .*part_0\.csv \(\d+ > 64\)/);
  });

  it('defaults are 1 MiB per manifest and 512 MiB per export object', async () => {
    const { DEFAULT_MAX_MANIFEST_BYTES, DEFAULT_MAX_OBJECT_BYTES } = await import('./transports/focusExport');
    expect(DEFAULT_MAX_MANIFEST_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_MAX_OBJECT_BYTES).toBe(512 * 1024 * 1024);
  });
});
