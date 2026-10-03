// COMPATIBILITY CONTRACT SUITE — golden-contract tests for the public API
// surface that must not change for existing callers.
//
// Every handler is invoked in-process with a fake req/res (no server, no
// network). Response bodies are normalized (ISO timestamps → '<iso>') and
// compared against src/compat/golden/api.json.
//
// Goldens are GENERATED FROM origin/main behaviour: run this file with
// COMPAT_WRITE=1 in an export of origin/main to (re)write the golden file, then
// run it normally on the branch under test. See src/compat/README note in the
// golden file's `_generatedFrom` field.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { rawRowsForVersion } from '@/costsource/seed';

const GOLDEN = path.resolve(__dirname, 'golden/api.json');
const WRITE = process.env.COMPAT_WRITE === '1';

// Env that could change behaviour is cleared so the contract is the default build.
const ENV_KEYS = [
  'RATIO_API_TOKEN',
  'AI_PROVIDER',
  'CM_PROVIDER',
  'FINIO_PEER_TOKEN',
  'FINIO_SESSION_SECRET',
  'COSTSOURCE_POINTFIVE_LIVE',
  'KUBERNETES_FOCUS_ENDPOINT',
  'NUTANIX_ENDPOINT',
  'AZURE_FOCUS_EXPORT_URL',
  'AWS_FOCUS_EXPORT_BUCKET',
  'GCP_FOCUS_BQ_DATASET',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    setHeader(k: string, v: string | number) {
      res.headers[k.toLowerCase()] = String(v);
      return res;
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
    end() {
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

let ipSeq = 0;
function makeReq(method: string, opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) {
  ipSeq += 1;
  return {
    method,
    url: '/api',
    query: opts.query ?? {},
    body: opts.body,
    headers: { 'x-forwarded-for': `198.51.100.${ipSeq % 250}`, ...(opts.headers ?? {}) },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(mod: Promise<{ default: unknown }>, req: NextApiRequest): Promise<Captured> {
  const handler = (await mod).default as Handler;
  const res = makeRes();
  await handler(req, res as unknown as NextApiResponse);
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** What a client receives on the wire: res.json() serializes (Infinity → null etc.). */
function wire(v: unknown): unknown {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Deep-normalize volatile values: ISO timestamps → '<iso>'. */
function normalize(v: unknown): unknown {
  if (typeof v === 'string') return ISO.test(v) ? '<iso>' : v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalize(x)]));
  }
  return v;
}

function shape(c: Captured, opts: { body?: boolean; headers?: string[] } = {}) {
  const headers: Record<string, string> = {};
  for (const h of opts.headers ?? []) if (c.headers[h] !== undefined) headers[h] = c.headers[h];
  return {
    status: c.status,
    ...(opts.headers ? { headers } : {}),
    ...(opts.body === false ? {} : { body: normalize(wire(c.body)) }),
  };
}

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

const CHAT_BODY = {
  messages: [{ role: 'user', content: 'Which initiatives are at risk?' }],
  context: {
    initiatives: [
      {
        id: 'i1',
        name: 'GPT Summarizer',
        monthlyCost: 50000,
        annualRunRate: 600000,
        budgetConsumedPct: 85,
        status: 'At Risk',
        valueRatio: 2.1,
        savingsOpportunity: 8000,
      },
    ],
    summary: { totalMonthlySpend: 50000, projectedSavings: 8000, initiativesActive: 1, pendingApproval: 0 },
    asOf: '2026-06-26T00:00:00.000Z',
  },
};

function ingestRows() {
  const rows = rawRowsForVersion('1.2') as unknown as Record<string, unknown>[];
  rows[0] = { ...rows[0], Tags: { team: 'platform', env: 'prod' }, x_CostCenter: 'cc-42' };
  return rows;
}

/** Every contract case: name → captured shape. */
async function captureAll(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // /api/costsource/sources — sandbox entries field-for-field.
  const sources = await call(import('../../pages/api/costsource/sources'), makeReq('GET'));
  const list = sources.body as Array<{ id: string }>;
  out['costsource/sources sandbox entries'] = {
    status: sources.status,
    body: normalize(wire(list.filter((s) => s.id === 'pointfive-sandbox' || s.id === 'focus-file-sandbox'))),
  };

  for (const id of ['pointfive-sandbox', 'focus-file-sandbox']) {
    out[`costsource/rows ${id}`] = shape(
      await call(import('../../pages/api/costsource/rows'), makeReq('GET', { query: { sourceId: id, ...WINDOW } })),
    );
    out[`costsource/findings ${id}`] = shape(
      await call(import('../../pages/api/costsource/findings'), makeReq('GET', { query: { sourceId: id } })),
    );
    out[`costsource/health ${id}`] = shape(
      await call(import('../../pages/api/costsource/health'), makeReq('GET', { query: { sourceId: id } })),
    );
  }

  out['costsource/ingest round-trip'] = shape(
    await call(
      import('../../pages/api/costsource/ingest'),
      makeReq('POST', { body: { sourceId: 'focus-file-sandbox', version: '1.2', rows: ingestRows(), window: WINDOW } }),
    ),
  );

  out['hello'] = shape(await call(import('../../pages/api/hello'), makeReq('GET')));
  out['tokenomics'] = shape(await call(import('../../pages/api/tokenomics'), makeReq('GET')));
  out['prediction/accuracy'] = shape(await call(import('../../pages/api/prediction/accuracy'), makeReq('GET')));
  out['prediction/predict 400'] = shape(
    await call(import('../../pages/api/prediction/predict'), makeReq('POST', { body: { nope: true } })),
  );

  // Deprecated aliases: status + envelope.
  out['a2a/handshake (deprecated alias) no peer token'] = shape(
    await call(import('../../pages/api/a2a/handshake'), makeReq('POST', { body: { focusVersion: '1.2', capabilities: [] } })),
  );
  out['finio/export (deprecated alias) no session'] = shape(
    await call(import('../../pages/api/finio/export'), makeReq('GET')),
  );

  out['v1/ai/chat mock answer (empty env)'] = shape(
    await call(import('../../pages/api/v1/ai/chat'), makeReq('POST', { body: CHAT_BODY })),
  );

  for (const format of ['pdf', 'xlsx']) {
    out[`report/snapshot ${format}`] = shape(
      await call(import('../../pages/api/report/snapshot'), makeReq('GET', { query: { format } })),
      { body: false, headers: ['content-type'] },
    );
  }
  return out;
}

describe('API compatibility contract (goldens from origin/main)', () => {
  it('matches the committed goldens', async () => {
    const actual = await captureAll();
    if (WRITE) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify({ _generatedFrom: process.env.COMPAT_SOURCE ?? 'unknown', ...actual }, null, 2)}\n`);
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
    delete golden._generatedFrom;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
    for (const key of Object.keys(golden)) {
      expect({ [key]: actual[key] }).toEqual({ [key]: golden[key] });
    }
  }, 60_000);

  it('the pdf / xlsx snapshot bodies are non-empty binaries', async () => {
    for (const format of ['pdf', 'xlsx']) {
      const c = await call(import('../../pages/api/report/snapshot'), makeReq('GET', { query: { format } }));
      expect(c.status).toBe(200);
      expect((c.body as Uint8Array).length).toBeGreaterThan(100);
    }
  }, 60_000);
});
