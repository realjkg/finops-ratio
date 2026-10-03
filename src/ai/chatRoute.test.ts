// /api/v1/ai/chat route tests — exercises the gateway-wrapped handler end to end
// with a fake req/res. Lives under src/ (NOT pages/) so Next never compiles it
// into a deployed route. The mock provider path needs no keys or network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../../pages/api/v1/ai/chat';

const ENV_KEYS = [
  'AI_PROVIDER',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENLLM_BASE_URL',
  'OPENLLM_MODEL',
  'OPENLLM_API_KEY',
  'MISTRAL_API_KEY',
  'MISTRAL_BASE_URL',
  'MISTRAL_MODEL',
  'QWEN_API_KEY',
  'QWEN_BASE_URL',
  'QWEN_MODEL',
  'DASHSCOPE_API_KEY',
  'RATIO_API_TOKEN',
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function makeRes(): NextApiResponse & { statusCode: number; body: unknown; headers: Record<string, string> } {
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
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

function makeReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): NextApiRequest {
  return {
    method: opts.method ?? 'POST',
    url: '/api/v1/ai/chat',
    headers: opts.headers ?? {},
    body: opts.body,
  } as unknown as NextApiRequest;
}

const context = {
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
  summary: {
    totalMonthlySpend: 50000,
    projectedSavings: 8000,
    initiativesActive: 1,
    pendingApproval: 0,
  },
  asOf: '2026-06-26T00:00:00.000Z',
};
const validBody = {
  messages: [{ role: 'user', content: 'Which initiatives are at risk?' }],
  context,
};

describe('/api/v1/ai/chat', () => {
  it('answers via the offline mock provider with no env set', async () => {
    const res = makeRes();
    await handler(makeReq({ body: validBody }), res);
    expect(res.statusCode).toBe(200);
    const payload = res.body as {
      provider: string;
      message: { role: string; content: string };
      initiativesReferenced: string[];
    };
    expect(payload.provider).toBe('mock');
    expect(payload.message.role).toBe('assistant');
    expect(payload.initiativesReferenced).toContain('i1');
  });

  it('returns 405 on a non-POST method (gateway method guard)', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', body: validBody }), res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 400 on an invalid body (gateway validation)', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { messages: [] } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('returns 422 when AI_PROVIDER=claude but the key is missing (authenticated)', async () => {
    // Live provider selected → the gateway enforces auth, so configure + present
    // a token; the handler then surfaces the missing-key 422 before any LLM call.
    process.env.RATIO_API_TOKEN = 'secret';
    process.env.AI_PROVIDER = 'claude';
    const res = makeRes();
    await handler(
      makeReq({ headers: { authorization: 'Bearer secret' }, body: validBody }),
      res,
    );
    expect(res.statusCode).toBe(422);
    expect((res.body as { error: { code: string; message: string } }).error.message).toContain(
      'ANTHROPIC_API_KEY',
    );
  });

  it('returns 401 when a live provider is selected without a token', async () => {
    process.env.AI_PROVIDER = 'claude'; // enforce auth, but no RATIO_API_TOKEN
    const res = makeRes();
    await handler(makeReq({ body: validBody }), res);
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Provider-agnostic routing: Mistral, Qwen, and open-weight servers all ride
// the OpenAI-compatible adapter. fetch is stubbed — nothing leaves the process.
// ---------------------------------------------------------------------------

describe('/api/v1/ai/chat — OpenAI-compatible providers', () => {
  const AUTH = { authorization: 'Bearer secret' };

  function stubCompletion(text = 'GPT Summarizer is at risk at 2.1× value.') {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: text } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function lastCall(fetchMock: ReturnType<typeof stubCompletion>) {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string }> },
    };
  }

  beforeEach(() => {
    process.env.RATIO_API_TOKEN = 'secret';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes AI_PROVIDER=mistral to La Plateforme with the default model', async () => {
    process.env.AI_PROVIDER = 'mistral';
    process.env.MISTRAL_API_KEY = 'mk';
    const fetchMock = stubCompletion();
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { provider: string; initiativesReferenced: string[] };
    expect(body.provider).toBe('mistral');
    expect(body.initiativesReferenced).toEqual(['i1']);
    const call = lastCall(fetchMock);
    expect(call.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer mk');
    expect(call.body.model).toBe('mistral-large-latest');
    expect(call.body.messages[0].role).toBe('system');
  });

  it('routes AI_PROVIDER=qwen to DashScope compatible mode, accepting DASHSCOPE_API_KEY', async () => {
    process.env.AI_PROVIDER = 'qwen';
    process.env.DASHSCOPE_API_KEY = 'dk';
    process.env.QWEN_MODEL = 'qwen-max';
    const fetchMock = stubCompletion();
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { provider: string }).provider).toBe('qwen');
    const call = lastCall(fetchMock);
    expect(call.url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer dk');
    expect(call.body.model).toBe('qwen-max');
  });

  it('routes an open-weight alias (ollama) to the self-hosted server with no key', async () => {
    process.env.AI_PROVIDER = 'ollama';
    process.env.OPENLLM_BASE_URL = 'http://ollama.internal:11434/v1/';
    process.env.OPENLLM_MODEL = 'llama3.1:70b';
    const fetchMock = stubCompletion();
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);

    expect(res.statusCode).toBe(200);
    expect((res.body as { provider: string }).provider).toBe('openllm');
    const call = lastCall(fetchMock);
    expect(call.url).toBe('http://ollama.internal:11434/v1/chat/completions');
    expect(call.headers).not.toHaveProperty('Authorization');
    expect(call.body.model).toBe('llama3.1:70b');
  });

  it('returns 422 naming the missing key before any LLM call', async () => {
    process.env.AI_PROVIDER = 'mistral';
    const fetchMock = stubCompletion();
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);
    expect(res.statusCode).toBe(422);
    expect((res.body as { error: { message: string } }).error.message).toBe(
      'MISTRAL_API_KEY is required for AI_PROVIDER=mistral',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the original OpenLLM misconfiguration message', async () => {
    process.env.AI_PROVIDER = 'openllm';
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);
    expect(res.statusCode).toBe(422);
    expect((res.body as { error: { message: string } }).error.message).toBe(
      'OPENLLM_BASE_URL and OPENLLM_MODEL are required for AI_PROVIDER=openllm',
    );
  });

  it.each(['mistral', 'qwen', 'vllm'])('enforces auth when AI_PROVIDER=%s (no token → 401)', async (p) => {
    delete process.env.RATIO_API_TOKEN;
    process.env.AI_PROVIDER = p;
    const res = makeRes();
    await handler(makeReq({ body: validBody }), res);
    expect(res.statusCode).toBe(401);
  });

  it('surfaces a provider error without leaking the key', async () => {
    process.env.AI_PROVIDER = 'mistral';
    process.env.MISTRAL_API_KEY = 'mk-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).toContain('Mistral error 429');
    expect(JSON.stringify(res.body)).not.toContain('mk-secret');
  });

  it('never returns the provider response body (status only; body to the redacted log)', async () => {
    process.env.AI_PROVIDER = 'mistral';
    process.env.MISTRAL_API_KEY = 'mk-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('UPSTREAM-BODY-MARKER quota', { status: 429 })));
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).toContain('Mistral error 429');
    expect(JSON.stringify(res.body)).not.toContain('UPSTREAM-BODY-MARKER');
    warn.mockRestore();
  });

  it('does not quote a non-JSON provider body in the error', async () => {
    process.env.AI_PROVIDER = 'mistral';
    process.env.MISTRAL_API_KEY = 'mk-secret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"a": LEAKED}')));
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('LEAKED');
  });
});

// ---------------------------------------------------------------------------
// SDK adapters (Claude / OpenAI): provider error bodies never reach the caller.
// ---------------------------------------------------------------------------

describe('/api/v1/ai/chat — SDK provider errors carry status only', () => {
  const AUTH = { authorization: 'Bearer secret' };
  const MARKER = 'UPSTREAM-BODY-MARKER';

  function stub401() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `${MARKER} bad key` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  }

  it.each([
    ['claude', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
  ])('%s: a 401 from the provider returns "<provider> error 401 (unauthorized)" without the body', async (provider, keyEnv) => {
    process.env.RATIO_API_TOKEN = 'secret';
    process.env.AI_PROVIDER = provider;
    process.env[keyEnv] = 'sk-test-key';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub401();
    const res = makeRes();
    await handler(makeReq({ headers: AUTH, body: validBody }), res);
    expect(res.statusCode).toBe(500);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(MARKER);
    expect(text).toContain(`${provider} error 401 (unauthorized)`);
    warn.mockRestore();
  });
});
