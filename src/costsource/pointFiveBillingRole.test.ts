// B1: while the PointFive billing role is undecided (M0c/M9b), PointFive billing
// rows are never headline-eligible. Two guards: the descriptor says
// roleConfirmed:false, and the MCP transport refuses fetchBillingRows with
// BILLING_ROLE_UNDECIDED until the deliberate opt-in constant is flipped.
// The MCP server is the SYNTHETIC local server; rows are SYNTHETIC seed rows.

import { afterEach, describe, expect, it } from 'vitest';
import type { CostSourceClient } from './CostSourceClient';
import { fetchAiSpendRatio } from './aiSpendRatio';
import { HEADLINE_EXCLUSION_REASON } from './headline';
import { PointFiveLiveAdapter } from './PointFiveLiveAdapter';
import { StreamableHttpPointFiveMcpClient } from './PointFiveMcpTransport';
import type { HttpFetch } from './PointFiveOAuthClient';
import {
  POINTFIVE_BILLING_ROLE_CONFIRMED,
  POINTFIVE_LIVE_SOURCE_ID,
  pointFiveLiveDescriptor,
  resolvePointFiveStatus,
} from './pointfiveConfig';
import { rawRowsForVersion, sourcesForEnv } from './seed';
import { startSyntheticMcpServer, type SyntheticServer } from '../connectors/managed/pointfive/fixtures/syntheticMcpServer';

const TOKEN = 'synthetic-token-0123456789abcdef';
const WINDOW = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };
const OBJ = { type: 'object', properties: {} };
const TOOLS = [
  { name: 'billing_data', inputSchema: { type: 'object', properties: { start: {}, end: {} }, required: ['start', 'end'] } },
  { name: 'opportunities', inputSchema: OBJ },
  { name: 'anomalies', inputSchema: OBJ },
];
const BILLING_ROWS = rawRowsForVersion('1.0'); // SYNTHETIC FOCUS v1.0 rows
const env = (url = 'http://127.0.0.1:1/mcp') => ({
  COSTSOURCE_POINTFIVE_LIVE: 'true',
  POINTFIVE_OAUTH_CLIENT_ID: 'id',
  POINTFIVE_OAUTH_CLIENT_SECRET: 'synthetic-client-secret',
  POINTFIVE_OAUTH_TOKEN_URL: 'http://token.invalid/token',
  POINTFIVE_MCP_URL: url,
});
const tokenEndpoint: HttpFetch = async () => ({
  ok: true, status: 200, text: async () => '', json: async () => ({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 }),
});
/** A CostSourceClient whose only source is the configured live PointFive adapter. */
const clientOver = (adapter: PointFiveLiveAdapter): CostSourceClient => ({
  mode: 'live',
  listSources: async () => [adapter.describe()],
  fetchCostRows: async (_id, w) => adapter.fetchCostRows(w),
  fetchFindings: async () => adapter.fetchFindings(),
  healthCheck: async () => adapter.healthCheck(),
});

let srv: SyntheticServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});
// The SYNTHETIC server answers the billing tool with a real-looking billing row list.
const serveBilling = async () =>
  (srv = await startSyntheticMcpServer({
    acceptToken: TOKEN,
    tools: TOOLS,
    onCall: (name) => ({ content: [], structuredContent: { items: name === 'billing_data' ? BILLING_ROWS : [] } }),
  }));

describe('PointFive billing role undecided (B1)', () => {
  it('the opt-in constant is off and every descriptor state is roleConfirmed:false', () => {
    expect(POINTFIVE_BILLING_ROLE_CONFIRMED).toBe(false);
    for (const e of [{}, { COSTSOURCE_POINTFIVE_LIVE: 'true' }, env()]) {
      expect(pointFiveLiveDescriptor(resolvePointFiveStatus(e)).roleConfirmed).toBe(false);
    }
    expect(sourcesForEnv(env()).find((s) => s.id === POINTFIVE_LIVE_SOURCE_ID)?.roleConfirmed).toBe(false);
  });

  it('the MCP transport refuses fetchBillingRows with BILLING_ROLE_UNDECIDED and contacts nothing', async () => {
    const s = await serveBilling();
    const creds = { mcpUrl: s.url, oauthClientId: 'id', oauthClientSecret: 'synthetic', oauthTokenUrl: 'http://token.invalid' };
    const t = new StreamableHttpPointFiveMcpClient(creds, { getAccessToken: async () => TOKEN });
    await expect(t.fetchBillingRows(WINDOW)).rejects.toMatchObject({ code: 'BILLING_ROLE_UNDECIDED' });
    expect(s.requests).toHaveLength(0);
    // Findings still work on the same transport.
    await expect(t.listOpportunities()).resolves.toEqual([]);
  });

  it('fetchAiSpendRatio never counts pointfive-live in the headline when a server returns billing rows (real transport)', async () => {
    const s = await serveBilling();
    const client = clientOver(new PointFiveLiveAdapter({ env: env(s.url), httpFetch: tokenEndpoint }));
    for (const ids of [undefined, [POINTFIVE_LIVE_SOURCE_ID]]) {
      const r = await fetchAiSpendRatio(client, WINDOW, ids);
      expect(r.overall.rowCount).toBe(0);
      expect(r.overall.byCurrency).toEqual([]);
      expect(r.perSource.filter((p) => p.inHeadline)).toEqual([]);
      expect(r.errors).toEqual([{ sourceId: POINTFIVE_LIVE_SOURCE_ID, message: expect.stringMatching(/billing role/i) }]);
    }
    expect(s.methods()).not.toContain('tools/call');
  });

  it('even a transport that does return billing rows stays out of the headline (descriptor guard)', async () => {
    const adapter = new PointFiveLiveAdapter({
      env: env(),
      httpFetch: tokenEndpoint,
      transportFactory: () => ({
        ping: async () => true,
        fetchBillingRows: async () => BILLING_ROWS,
        listOpportunities: async () => [],
        listAnomalies: async () => [],
      }),
    });
    for (const ids of [undefined, [POINTFIVE_LIVE_SOURCE_ID]]) {
      const r = await fetchAiSpendRatio(clientOver(adapter), WINDOW, ids);
      const p5 = r.perSource.find((p) => p.sourceId === POINTFIVE_LIVE_SOURCE_ID)!;
      expect(p5.result.rowCount).toBeGreaterThan(0); // the rows are visible per source...
      expect(p5).toMatchObject({ inHeadline: false, exclusionReason: HEADLINE_EXCLUSION_REASON });
      expect(r.overall.rowCount).toBe(0); // ...and never reach the headline
      expect(r.overall.byCurrency).toEqual([]);
    }
  });
});
