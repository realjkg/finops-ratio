// Sweep (final round): upstream provider text never reaches API callers.
// - the Jira / ServiceNow CM adapters (and, in src/ai/chatRoute.test.ts, the
//   OpenAI-compatible chat adapter) throw status + fixed reason only (body only to the redacted server log),
//   and JSON parse errors never quote their input;
// - the gateway's 500 envelope is generic ("Internal error" + requestId); the
//   thrown message goes only to the structured server log, redacted;
// - fetchChecked's network-failure wrap is redacted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withGateway, type GatewayHandler } from './withGateway';
import { SlidingWindowRateLimiter } from './rateLimit';
import { fetchChecked } from '@/costsource/transports/focusExport';

const MARKER = 'UPSTREAM-BODY-MARKER';
const SECRET = 'Bearer leak.tok.SECRET-0123456789 at https://x.example/p?sig=SASSECRET';
const ENV_KEYS = [
  'RATIO_API_TOKEN',
  'CM_PROVIDER',
  'JIRA_BASE_URL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'SERVICENOW_INSTANCE',
  'SERVICENOW_USERNAME',
  'SERVICENOW_PASSWORD',
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.RATIO_API_TOKEN = 'right';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
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

function post(body: unknown): NextApiRequest {
  return {
    method: 'POST',
    url: '/api',
    query: {},
    headers: { authorization: 'Bearer right', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function errorMessage(body: unknown): string {
  return (body as { error: { message: string } }).error.message;
}

/** Everything the gateway wrote to the structured error log in this test. */
function errorLog(): string {
  return (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
}

const CM_CREATE = {
  operation: 'create',
  action: 'rightsize',
  finding: { workloadId: 'wl-1', workloadName: 'Support', recommendedAction: 'rightsize', projectedMonthlyImpact: 10 },
};

describe('gateway 500 envelope is generic; the log is redacted', () => {
  it('strips Bearer tokens and query strings from a thrown message', async () => {
    const throwing: GatewayHandler = () => {
      throw new Error(`boom ${SECRET}`);
    };
    const handler = withGateway(throwing, {
      env: {},
      logger: () => {},
      limiter: new SlidingWindowRateLimiter(),
      validateBody: () => ({ ok: true }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();
    await handler(post({}), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(500);
    // The caller gets the generic envelope only — not even the redacted message.
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('boom');
    expect(text).not.toContain('leak.tok.SECRET');
    expect(text).not.toContain('SASSECRET');
    // The server log carries the message, redacted.
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('boom');
    expect(logged).not.toContain('leak.tok.SECRET');
    expect(logged).not.toContain('SASSECRET');
  });
});

describe('CM route — ITSM body never reaches the caller', () => {
  it('Jira createChange failure carries status only', async () => {
    process.env.CM_PROVIDER = 'jira';
    process.env.JIRA_BASE_URL = 'https://jira.example';
    process.env.JIRA_API_TOKEN = 'jira-secret';
    process.env.JIRA_PROJECT_KEY = 'OPS';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${MARKER} denied`, { status: 403 })));
    const { default: handler } = await import('../../../pages/api/v1/cm/change');
    const res = makeRes();
    await handler(post(CM_CREATE), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(500);
    expect(errorMessage(res.body)).toBe('Internal error');
    expect(JSON.stringify(res.body)).not.toContain('Jira createChange failed');
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
    expect(errorLog()).toContain('Jira createChange failed (403');
    expect(errorLog()).not.toContain(MARKER);
  });

  it('ServiceNow createChange failure carries status only', async () => {
    process.env.CM_PROVIDER = 'servicenow';
    process.env.SERVICENOW_INSTANCE = 'acme';
    process.env.SERVICENOW_USERNAME = 'u';
    process.env.SERVICENOW_PASSWORD = 'p';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${MARKER} denied`, { status: 401 })));
    const { default: handler } = await import('../../../pages/api/v1/cm/change');
    const res = makeRes();
    await handler(post(CM_CREATE), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(500);
    expect(errorMessage(res.body)).toBe('Internal error');
    expect(JSON.stringify(res.body)).not.toContain('ServiceNow createChange failed');
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
    expect(errorLog()).toContain('ServiceNow createChange failed (401');
    expect(errorLog()).not.toContain(MARKER);
  });

  it('a non-JSON Jira success body is not quoted in the error', async () => {
    process.env.CM_PROVIDER = 'jira';
    process.env.JIRA_BASE_URL = 'https://jira.example';
    process.env.JIRA_API_TOKEN = 'jira-secret';
    process.env.JIRA_PROJECT_KEY = 'OPS';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"a": LEAKED}')));
    const { default: handler } = await import('../../../pages/api/v1/cm/change');
    const res = makeRes();
    await handler(post(CM_CREATE), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('LEAKED');
    expect(errorLog()).not.toContain('LEAKED');
  });
});

describe('fetchChecked network-failure wrap is redacted', () => {
  it('strips tokens / query strings from the runtime error text', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed ${SECRET}`);
    }) as unknown as typeof fetch;
    const err = await fetchChecked(fetchImpl, 'https://x.example/p', {}, 'Kubernetes FOCUS endpoint').catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/^Kubernetes FOCUS endpoint unreachable: /);
    expect((err as Error).message).not.toContain('leak.tok.SECRET');
    expect((err as Error).message).not.toContain('SASSECRET');
  });
});
