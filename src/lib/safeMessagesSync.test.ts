// The client allow-list (src/lib/httpError.ts) must carry every FIXED,
// input-free message our routes emit, so the UI keeps actionable text (which
// env var is missing, what the body must contain). Driven through the real
// routes so a new or reworded server message fails this test until it is
// allow-listed. Messages embedding dynamic values (method, size) stay
// code-only and must NOT be on the list.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import chatHandler from '../../pages/api/v1/ai/chat';
import cmHandler from '../../pages/api/v1/cm/change';
import snapshotHandler from '../../pages/api/report/snapshot';
import attributionHandler from '../../pages/api/attribution';
import { SAFE_ERROR_CODES, SAFE_ERROR_MESSAGES, describeHttpErrorBody } from './httpError';

const ENV_KEYS = [
  'RATIO_API_TOKEN', 'AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MISTRAL_API_KEY', 'MISTRAL_BASE_URL',
  'MISTRAL_MODEL', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL', 'OPENLLM_BASE_URL',
  'OPENLLM_MODEL', 'OPENLLM_API_KEY', 'CM_PROVIDER', 'JIRA_BASE_URL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY',
  'SERVICENOW_INSTANCE', 'SERVICENOW_USERNAME', 'SERVICENOW_PASSWORD',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.RATIO_API_TOKEN = 'secret';
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = String(v);
    },
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(p: unknown) {
      res.body = p;
      res.headersSent = true;
      return res;
    },
    send(p: unknown) {
      res.body = p;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

let ip = 0;
async function call(handler: unknown, method: string, body?: unknown, query: Record<string, string> = {}) {
  ip += 1;
  const res = makeRes();
  await (handler as NextApiHandler)(
    {
      method,
      url: '/api/x',
      query,
      body,
      headers: { authorization: 'Bearer secret', 'x-forwarded-for': `198.51.${ip % 250}.${(ip >> 8) % 250}` },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return res;
}

function messageOf(body: unknown): string {
  const e = (body as { error: unknown }).error;
  return typeof e === 'string' ? e : (e as { message: string }).message;
}

const chatBody = {
  messages: [{ role: 'user', content: 'hi' }],
  context: { initiatives: [], summary: {}, asOf: '2026-06-26T00:00:00.000Z' },
};

describe('fixed server messages are allow-listed (driven through the routes)', () => {
  it.each([
    ['claude', {}],
    ['openai', {}],
    ['mistral', {}],
    ['qwen', {}],
    ['openllm', {}],
    ['openllm', { OPENLLM_BASE_URL: 'http://llm.local/v1' }],
    ['openllm', { OPENLLM_MODEL: 'm' }],
  ] as const)('AI 422 provider_misconfigured for %s %j', async (provider, extra) => {
    process.env.AI_PROVIDER = provider;
    for (const [k, v] of Object.entries(extra)) process.env[k] = v;
    const res = await call(chatHandler, 'POST', chatBody);
    expect(res.statusCode).toBe(422);
    const msg = messageOf(res.body);
    expect(SAFE_ERROR_MESSAGES.has(msg), msg).toBe(true);
    expect(describeHttpErrorBody('AI chat', 422, JSON.stringify(res.body))).toBe(`AI chat error 422: ${msg}`);
  });

  it('AI chat 400 body validation', async () => {
    const res = await call(chatHandler, 'POST', { nope: true });
    expect(res.statusCode).toBe(400);
    expect(SAFE_ERROR_MESSAGES.has(messageOf(res.body)), messageOf(res.body)).toBe(true);
  });

  it.each(['jira', 'servicenow'])('CM 422 provider_misconfigured for %s', async (provider) => {
    process.env.CM_PROVIDER = provider;
    const res = await call(cmHandler, 'POST', { operation: 'status', ticketRef: 'OPS-1' });
    expect(res.statusCode).toBe(422);
    expect(SAFE_ERROR_MESSAGES.has(messageOf(res.body)), messageOf(res.body)).toBe(true);
  });

  it('CM 400 body validation', async () => {
    const res = await call(cmHandler, 'POST', { operation: 'bogus' });
    expect(res.statusCode).toBe(400);
    expect(SAFE_ERROR_MESSAGES.has(messageOf(res.body)), messageOf(res.body)).toBe(true);
  });

  it('report snapshot 400', async () => {
    const res = await call(snapshotHandler, 'GET', undefined, { format: 'docx' });
    expect(res.statusCode).toBe(400);
    expect(SAFE_ERROR_MESSAGES.has(messageOf(res.body)), messageOf(res.body)).toBe(true);
  });

  it('attribution 400 (invalid dimension)', async () => {
    const res = await call(attributionHandler, 'GET', undefined, { dimension: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(SAFE_ERROR_MESSAGES.has(messageOf(res.body)), messageOf(res.body)).toBe(true);
  });
});

describe('dynamic gateway messages stay code-only', () => {
  it('405 (embeds the method) surfaces the code, not the text', async () => {
    const res = await call(chatHandler, 'DELETE');
    expect(res.statusCode).toBe(405);
    expect(SAFE_ERROR_MESSAGES.has(messageOf(res.body))).toBe(false);
    expect(SAFE_ERROR_CODES.has('method_not_allowed')).toBe(true);
    expect(describeHttpErrorBody('AI chat', 405, JSON.stringify(res.body))).toBe('AI chat error 405: method_not_allowed');
  });

  it('413 (embeds the size) surfaces the code, not the text', async () => {
    const res = await call(chatHandler, 'POST', { blob: 'x'.repeat(200_000) });
    expect(res.statusCode).toBe(413);
    expect(SAFE_ERROR_MESSAGES.has(messageOf(res.body))).toBe(false);
    expect(describeHttpErrorBody('AI chat', 413, JSON.stringify(res.body))).toBe('AI chat error 413: payload_too_large');
  });
});
