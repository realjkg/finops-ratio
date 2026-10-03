// PointFive OAuth + MCP transports: upstream bodies never reach thrown errors
// (status + fixed reason only; body only to the redacted server-side log), and
// JSON parse failures never quote their input.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PointFiveOAuthClient, type HttpFetch } from './PointFiveOAuthClient';
import { SsePointFiveMcpClient } from './PointFiveMcpTransport';
import type { PointFiveCredentials } from './pointfiveConfig';

const CREDS: PointFiveCredentials = {
  mcpUrl: 'https://mcp.pointfive.example/sse',
  oauthClientId: 'client',
  oauthClientSecret: 'secret',
  oauthTokenUrl: 'https://auth.pointfive.example/token',
};
const MARKER = 'UPSTREAM-BODY-MARKER';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function httpFetchReturning(res: { ok: boolean; status: number; text: string; json?: () => Promise<unknown> }): HttpFetch {
  return async () => ({
    ok: res.ok,
    status: res.status,
    text: async () => res.text,
    json: res.json ?? (async () => JSON.parse(res.text) as unknown),
  });
}

describe('PointFiveOAuthClient — no upstream body in errors', () => {
  it('a non-2xx token response throws status + fixed reason and logs the redacted body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new PointFiveOAuthClient(
      CREDS,
      httpFetchReturning({ ok: false, status: 401, text: `${MARKER} invalid_client Bearer s3cr3t-0123456789abcdef` }),
    );
    const err = await client.getAccessToken().catch((e: unknown) => e);
    expect((err as Error).message).toBe('PointFive OAuth token endpoint returned 401 (unauthorized)');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain(MARKER);
    expect(logged).not.toContain('s3cr3t');
  });

  it('a non-JSON token body throws a fixed message, not the body', async () => {
    const client = new PointFiveOAuthClient(CREDS, httpFetchReturning({ ok: true, status: 200, text: `{"a": LEAKED}` }));
    const err = await client.getAccessToken().catch((e: unknown) => e);
    expect((err as Error).message).toBe('PointFive OAuth token endpoint returned a non-JSON response');
    expect((err as Error).message).not.toContain('LEAKED');
  });
});

describe('SsePointFiveMcpClient — no upstream body in errors', () => {
  const oauth = { getAccessToken: async () => 'tok' } as unknown as PointFiveOAuthClient;
  const WINDOW = { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

  it('a non-2xx tool response throws status + fixed reason and logs the redacted body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${MARKER} at https://x.example/p?sig=leak`, { status: 403 })));
    const err = await new SsePointFiveMcpClient(CREDS, oauth).fetchBillingRows(WINDOW).catch((e: unknown) => e);
    expect((err as Error).message).toBe("PointFive MCP tool 'billing_data' returned 403 (forbidden)");
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain(MARKER);
    expect(logged).not.toContain('sig=leak');
  });

  it('a non-JSON tool body throws a fixed message, not the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`{"a": LEAKED}`)));
    const err = await new SsePointFiveMcpClient(CREDS, oauth).listAnomalies().catch((e: unknown) => e);
    expect((err as Error).message).toBe("PointFive MCP tool 'anomalies' returned a non-JSON response");
  });
});
