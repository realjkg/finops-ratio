// /api/v1/cm/change — ticketRef path / query injection.
//
// A caller-supplied ticketRef used to be interpolated straight into the Jira
// REST path (`/rest/api/2/issue/${ticketRef}`), so `ABC-1/../../admin`,
// `../`, `?x=` or `#` steered an authenticated server-side request (carrying
// JIRA_API_TOKEN) to an arbitrary path on the Jira host. ServiceNow put the ref
// into an encoded query (`sysparm_query=number=<ref>`), where `^OR...` widens
// the lookup. Every ref is now validated against the provider's identifier
// grammar BEFORE a URL is built; an invalid ref is a 400 `invalid_request` with
// a fixed message that never echoes the input, and no upstream call is made.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { InvalidTicketRefError } from './ticketRef';
import * as changeRoute from '../../pages/api/v1/cm/change';

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

let ip = 0;
function post(body: unknown): NextApiRequest {
  ip += 1;
  return {
    method: 'POST',
    url: '/api/v1/cm/change',
    query: {},
    headers: { authorization: 'Bearer right', 'x-forwarded-for': `10.9.${Math.floor(ip / 250)}.${ip % 250}` },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function useJira() {
  process.env.CM_PROVIDER = 'jira';
  process.env.JIRA_BASE_URL = 'https://jira.example';
  process.env.JIRA_API_TOKEN = 'jira-secret';
  process.env.JIRA_PROJECT_KEY = 'OPS';
}

function useServiceNow() {
  process.env.CM_PROVIDER = 'servicenow';
  process.env.SERVICENOW_INSTANCE = 'acme.service-now.com';
  process.env.SERVICENOW_USERNAME = 'u';
  process.env.SERVICENOW_PASSWORD = 'p';
}

async function call(body: unknown) {
  const { default: handler } = await import('../../pages/api/v1/cm/change');
  const res = makeRes();
  await handler(post(body), res as unknown as NextApiResponse);
  return res;
}

/** Hostile / malformed refs — none may reach a URL. */
const HOSTILE = [
  '../',
  '..',
  '%2e%2e/',
  '%2E%2E%2F',
  'ABC-1/../../admin',
  'ABC-1/..%2f..%2fadmin',
  'ABC-1?x=',
  'ABC-1?expand=renderedFields',
  'ABC-1#',
  'ABC-1#frag',
  'ABC-1\\..\\admin',
  'ABC-1%00',
  'ABC-1\u0000',
  'ABC-1\n',
  ' ABC-1',
  'ABC-1 ',
  'abc-1',
  'ABC-0',
  'ABC-01',
  'ABC-',
  '-1',
  '1ABC-1',
  'ABC_1',
  'ÄBC-1',
  'ABC-１',
  'ABC‐1',
  'ABC-1‮',
  '',
  '   ',
  `A${'B'.repeat(255)}-1`,
  `ABC-${'1'.repeat(11)}`,
  'x'.repeat(5000),
  'https://evil.example/ABC-1',
  'ABC-1;rm',
  'ABC-1&jql=project=OPS',
];

/** Short, printable test-title label for a hostile ref. */
function label(ref: string): string {
  const shown = JSON.stringify(ref);
  return shown.length > 40 ? `${shown.slice(0, 24)}…(${ref.length} chars)` : shown;
}
const cases = (refs: string[]) => refs.map((r) => [label(r), r] as const);

/** Strings that must never appear in a 400 body for the hostile input. */
function assertNotEchoed(body: unknown, ref: string) {
  const text = JSON.stringify(body);
  const meaningful = ref.trim();
  if (meaningful.length >= 2) expect(text).not.toContain(JSON.stringify(meaningful).slice(1, -1));
  expect(text).not.toContain('admin');
  expect(text).not.toContain('evil.example');
}

describe('Jira ticketRef validation (before any URL is built)', () => {
  for (const operation of ['attach', 'status'] as const) {
    it.each(cases(HOSTILE))(`${operation}: rejects %s with 400 invalid_request and no upstream call`, async (_l, ref) => {
      useJira();
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const body =
        operation === 'attach' ? { operation, provider: 'jira', ticketRef: ref } : { operation, ticketRef: ref };
      const res = await call(body);
      expect(res.statusCode).toBe(400);
      const err = (res.body as { error: { code: string; message: string } }).error;
      expect(err.code).toBe('invalid_request');
      assertNotEchoed(res.body, ref);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('the 400 message is fixed — identical for every hostile ref', async () => {
    useJira();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const messages = new Set<string>();
    for (const ref of ['ABC-1/../../admin', '%2e%2e/', 'ABC-1?x=', 'ABC-1#', 'x'.repeat(300)]) {
      const res = await call({ operation: 'status', ticketRef: ref });
      expect(res.statusCode).toBe(400);
      messages.add((res.body as { error: { message: string } }).error.message);
    }
    expect(messages.size).toBe(1);
  });

  it.each(cases(['A-1', 'OPS-123', 'AB_C9-4567890123', `A${'B'.repeat(254)}-1`, 'ABC-9999999999']))(
    'accepts a valid issue key %s and requests exactly /rest/api/2/issue/<key>',
    async (_l, key) => {
      useJira();
      const fetchSpy = vi.fn(
        async (_url: string) =>
          new Response(JSON.stringify({ fields: { status: { name: 'Open' }, updated: '2026-01-01T00:00:00Z' } }), {
            status: 200,
          }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const res = await call({ operation: 'status', ticketRef: key });
      expect(res.statusCode).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(`https://jira.example/rest/api/2/issue/${key}`);
      expect((res.body as { ticketRef: string }).ticketRef).toBe(key);
    },
  );

  it('attach with a valid key builds the issue URL and an encoded browse URL', async () => {
    useJira();
    const fetchSpy = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call({ operation: 'attach', provider: 'jira', ticketRef: 'OPS-42' });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://jira.example/rest/api/2/issue/OPS-42');
    expect((res.body as { url: string }).url).toBe('https://jira.example/browse/OPS-42');
  });

  it('a not-found ref never puts the ticketRef in the caller-facing error', async () => {
    useJira();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    for (const op of ['attach', 'status'] as const) {
      const body = op === 'attach' ? { operation: op, provider: 'jira', ticketRef: 'SECRETPROJ-777' } : { operation: op, ticketRef: 'SECRETPROJ-777' };
      const res = await call(body);
      expect(res.statusCode).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('SECRETPROJ');
    }
  });
});

describe('ServiceNow ticketRef validation (before any URL is built)', () => {
  const SN_HOSTILE = [
    ...HOSTILE.filter((r) => r !== 'abc-1'),
    'CHG0030001^ORnumberISNOTEMPTY',
    'CHG0030001^NQsys_idISNOTEMPTY',
    'CHG0030001&sysparm_fields=password',
    'CHG0030001=',
    'chg0030001',
    'CHG-0030001',
    'CHG 0030001',
  ];

  for (const operation of ['attach', 'status'] as const) {
    it.each(cases(SN_HOSTILE))(`${operation}: rejects %s with 400 invalid_request and no upstream call`, async (_l, ref) => {
      useServiceNow();
      const fetchSpy = vi.fn(async () => new Response('{"result":[]}', { status: 200 }));
      vi.stubGlobal('fetch', fetchSpy);
      const body =
        operation === 'attach'
          ? { operation, provider: 'servicenow', ticketRef: ref }
          : { operation, ticketRef: ref };
      const res = await call(body);
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('invalid_request');
      assertNotEchoed(res.body, ref);
      expect(JSON.stringify(res.body)).not.toContain('ISNOTEMPTY');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it.each(['CHG0030001', 'CHG1', 'RITM0010001'])('accepts a change number %j', async (num) => {
    useServiceNow();
    const fetchSpy = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ result: [{ state: 'new', sys_updated_on: '2026-01-01 00:00:00' }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call({ operation: 'status', ticketRef: num });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toContain(`sysparm_query=number=${num}&`);
  });

  it('a not-found ref never puts the ticketRef in the caller-facing error', async () => {
    useServiceNow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"result":[]}', { status: 200 })));
    for (const op of ['attach', 'status'] as const) {
      const body =
        op === 'attach'
          ? { operation: op, provider: 'servicenow', ticketRef: 'CHG7770001' }
          : { operation: op, ticketRef: 'CHG7770001' };
      const res = await call(body);
      expect(res.statusCode).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('CHG7770001');
    }
  });
});

describe('mock provider is unchanged', () => {
  it('still accepts free-form refs (no upstream call exists to steer)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const res = await call({ operation: 'attach', provider: 'mock', ticketRef: 'inc-123' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { ticketRef: string }).ticketRef).toBe('INC-123');
  });
});

describe('attach audit record: provider is the resolved provider, never the caller value', () => {
  it.each(['jira', 'servicenow', 'mock'])('mock (default) provider ignores body provider %j', async (claimed) => {
    vi.stubGlobal('fetch', vi.fn());
    const res = await call({ operation: 'attach', provider: claimed, ticketRef: 'CHG-1' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { provider: string }).provider).toBe('mock');
  });

  it('CM_PROVIDER=jira records "jira" even when the body claims servicenow', async () => {
    useJira();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const res = await call({ operation: 'attach', provider: 'servicenow', ticketRef: 'OPS-7' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { provider: string }).provider).toBe('jira');
  });

  it('CM_PROVIDER=servicenow records "servicenow" even when the body claims jira', async () => {
    useServiceNow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"result":[{"number":"CHG0030001"}]}', { status: 200 })));
    const res = await call({ operation: 'attach', provider: 'jira', ticketRef: 'CHG0030001' });
    expect(res.statusCode).toBe(200);
    expect((res.body as { provider: string }).provider).toBe('servicenow');
  });
});

// --- Each layer of the ticketRef defence must hold on its own ----------------

const BAD_JIRA = ['ABC-1/../../admin', '%2e%2e/', 'ABC-1?x=', 'ABC-1#', ''];
const BAD_SN = ['CHG0030001^ORnumberISNOTEMPTY', '../', 'CHG1?x=', ''];

describe('handler gate alone (adapter checks bypassed by a fake adapter)', () => {
  function fakeAdapter(provider: 'jira' | 'servicenow') {
    const real =
      provider === 'jira'
        ? new changeRoute.JiraAdapter('https://jira.example', 't', 'OPS')
        : new changeRoute.ServiceNowAdapter('acme.service-now.com', 'u', 'p');
    return {
      provider,
      invalidRefMessage: (ref: string) => real.invalidRefMessage(ref),
      createChange: vi.fn(),
      attachReference: vi.fn(async () => ({ provider, ticketRef: 'X', url: 'u', createdAt: 'c' })),
      getStatus: vi.fn(async () => ({ ticketRef: 'X', status: 's', updatedAt: 'u' })),
    };
  }

  for (const provider of ['jira', 'servicenow'] as const) {
    const bad = provider === 'jira' ? BAD_JIRA : BAD_SN;
    it.each(bad)(`${provider}: %j is refused before the adapter is called`, async (ref) => {
      const adapter = fakeAdapter(provider);
      const handler = changeRoute.createChangeHandler(() => adapter as never);
      for (const body of [
        { operation: 'attach', provider, ticketRef: ref },
        { operation: 'status', ticketRef: ref },
      ]) {
        const res = makeRes();
        await handler(post(body), res as unknown as NextApiResponse);
        expect(res.statusCode).toBe(400);
      }
      expect(adapter.attachReference).not.toHaveBeenCalled();
      expect(adapter.getStatus).not.toHaveBeenCalled();
    });
  }
});

describe('adapter checks alone (called directly, no handler gate)', () => {
  it.each(BAD_JIRA)('JiraAdapter refuses %j before any fetch', async (ref) => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const jira = new changeRoute.JiraAdapter('https://jira.example', 't', 'OPS');
    await expect(jira.getStatus(ref)).rejects.toBeInstanceOf(InvalidTicketRefError);
    await expect(jira.attachReference({ provider: 'jira', ticketRef: ref })).rejects.toBeInstanceOf(InvalidTicketRefError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(BAD_SN)('ServiceNowAdapter refuses %j before any fetch', async (ref) => {
    const fetchSpy = vi.fn(async () => new Response('{"result":[]}'));
    vi.stubGlobal('fetch', fetchSpy);
    const sn = new changeRoute.ServiceNowAdapter('acme.service-now.com', 'u', 'p');
    await expect(sn.getStatus(ref)).rejects.toBeInstanceOf(InvalidTicketRefError);
    await expect(sn.attachReference({ provider: 'servicenow', ticketRef: ref })).rejects.toBeInstanceOf(InvalidTicketRefError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a thrown InvalidTicketRefError from the adapter maps to 400 (not 500)', async () => {
    const adapter = {
      provider: 'jira',
      createChange: vi.fn(),
      attachReference: vi.fn(async () => {
        throw new InvalidTicketRefError('ticketRef is not a valid Jira issue key');
      }),
      getStatus: vi.fn(),
    };
    const handler = changeRoute.createChangeHandler(() => adapter as never);
    const res = makeRes();
    await handler(post({ operation: 'attach', provider: 'jira', ticketRef: 'OPS-1' }), res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: { code: 'invalid_request', message: 'ticketRef is not a valid Jira issue key' } });
  });
});

describe('Jira URLs are built with encodeURIComponent (defence in depth)', () => {
  it('getStatus, attachReference and the browse URL encode the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ fields: { status: { name: 'Open' }, updated: 'u' } }))),
    );
    const enc = vi.spyOn(globalThis, 'encodeURIComponent');
    const jira = new changeRoute.JiraAdapter('https://jira.example', 't', 'OPS');
    await jira.getStatus('OPS-11');
    expect(enc).toHaveBeenCalledWith('OPS-11');
    enc.mockClear();
    await jira.attachReference({ provider: 'jira', ticketRef: 'OPS-12' });
    // issue path + browse URL
    expect(enc.mock.calls.filter((c) => c[0] === 'OPS-12').length).toBeGreaterThanOrEqual(2);
  });
});
