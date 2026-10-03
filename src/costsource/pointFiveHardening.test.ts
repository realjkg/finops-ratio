// PointFive live adapter hardening (final round):
// - health detail / rethrown errors are redacted (second line of defence);
// - billing rows go through the shared FOCUS row validator — an invalid row
//   throws `<source>: invalid FOCUS row N: <reason>`, never silently normalized;
// - the OAuth client's network-failure wrap is redacted.
// Plus the same validator on POST /api/costsource/ingest (sweep).

import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { PointFiveLiveAdapter } from './PointFiveLiveAdapter';
import { PointFiveOAuthClient, type HttpFetch } from './PointFiveOAuthClient';
import type { PointFiveMcpClient, PointFiveFocusRow } from './PointFiveMcpTransport';
import { rawRowsForVersion } from './seed';

const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };
const ENV = {
  COSTSOURCE_POINTFIVE_LIVE: 'true',
  POINTFIVE_OAUTH_CLIENT_ID: 'client-id',
  POINTFIVE_OAUTH_CLIENT_SECRET: 'client-secret',
  POINTFIVE_OAUTH_TOKEN_URL: 'https://auth.example/oauth/token',
};
const SECRET_MSG =
  'mcp said: Bearer pf.tok.SECRET-0123456789 denied at https://acct.blob.core.windows.net/c/x?sv=2024&sig=SASSECRET';

function transport(overrides: Partial<PointFiveMcpClient>): PointFiveMcpClient {
  return {
    ping: async () => true,
    fetchBillingRows: async () => rawRowsForVersion('1.0'),
    listOpportunities: async () => [],
    listAnomalies: async () => [],
    ...overrides,
  };
}

function adapterWith(overrides: Partial<PointFiveMcpClient>) {
  return new PointFiveLiveAdapter({ env: ENV, transportFactory: () => transport(overrides) });
}

const boom = async (): Promise<never> => {
  throw new Error(SECRET_MSG);
};

describe('PointFiveLiveAdapter — redacted error text', () => {
  it('health detail is redacted', async () => {
    const health = await adapterWith({ ping: boom }).healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.detail).toMatch(/health check failed/i);
    expect(health.detail).not.toContain('pf.tok.SECRET');
    expect(health.detail).not.toContain('SASSECRET');
  });

  it('fetchCostRows and fetchFindings rethrow redacted messages', async () => {
    for (const run of [
      () => adapterWith({ fetchBillingRows: boom }).fetchCostRows(WINDOW),
      () => adapterWith({ listOpportunities: boom }).fetchFindings(),
    ]) {
      const err = await run().catch((e: unknown) => e);
      expect((err as Error).message).toContain('mcp said');
      expect((err as Error).message).not.toContain('pf.tok.SECRET');
      expect((err as Error).message).not.toContain('SASSECRET');
    }
  });
});

describe('PointFiveLiveAdapter — billing rows are validated, never silently normalized', () => {
  function withRow(patch: Record<string, unknown>) {
    const rows = rawRowsForVersion('1.0');
    rows[1] = { ...rows[1], ...patch } as PointFiveFocusRow;
    return adapterWith({ fetchBillingRows: async () => rows });
  }

  it('rejects a row with a missing currency', async () => {
    await expect(withRow({ BillingCurrency: '' }).fetchCostRows(WINDOW)).rejects.toThrow(
      /^pointfive-live: invalid FOCUS row 2: .*BillingCurrency/,
    );
  });

  it('rejects a row with an unparseable cost', async () => {
    await expect(withRow({ BilledCost: 'lots' }).fetchCostRows(WINDOW)).rejects.toThrow(
      /^pointfive-live: invalid FOCUS row 2: .*BilledCost/,
    );
  });

  it('rejects a row with an unparseable date', async () => {
    await expect(withRow({ ChargePeriodStart: 'yesterday-ish' }).fetchCostRows(WINDOW)).rejects.toThrow(
      /^pointfive-live: invalid FOCUS row 2: .*ChargePeriodStart/,
    );
  });

  it('still normalizes valid rows', async () => {
    const result = await adapterWith({}).fetchCostRows(WINDOW);
    expect(result.rows.length).toBe(rawRowsForVersion('1.0').length);
  });
});

describe('PointFiveOAuthClient — network failure text is redacted', () => {
  it('redacts Bearer tokens and query strings from the wrapped network error', async () => {
    const httpFetch: HttpFetch = async () => {
      throw new Error(SECRET_MSG);
    };
    const client = new PointFiveOAuthClient(
      {
        mcpUrl: 'https://mcp.example/sse',
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
        oauthTokenUrl: 'https://auth.example/token',
      },
      httpFetch,
    );
    const err = await client.getAccessToken().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^PointFive OAuth token request failed: /);
    expect((err as Error).message).not.toContain('pf.tok.SECRET');
    expect((err as Error).message).not.toContain('SASSECRET');
  });
});

describe('POST /api/costsource/ingest — rows are validated (sweep)', () => {
  function makeRes() {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      setHeader: vi.fn(),
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    return res;
  }

  async function ingest(rows: unknown[]) {
    const { default: handler } = await import('../../pages/api/costsource/ingest');
    const res = makeRes();
    await handler(
      { method: 'POST', body: { sourceId: 'focus-file-sandbox', version: '1.0', rows, window: WINDOW } } as unknown as NextApiRequest,
      res as unknown as NextApiResponse,
    );
    return res;
  }

  it('rejects an invalid row with 400 naming the row instead of normalizing it', async () => {
    const rows = rawRowsForVersion('1.0');
    rows[0] = { ...rows[0], BillingCurrency: '' };
    const res = await ingest(rows);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/invalid FOCUS row 1: .*BillingCurrency/);
  });

  it('still accepts valid rows', async () => {
    const res = await ingest(rawRowsForVersion('1.0'));
    expect(res.statusCode).toBe(200);
  });
});
