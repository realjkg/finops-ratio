// The deliberate opt-in: only when POINTFIVE_BILLING_ROLE_CONFIRMED is flipped
// (simulated here with a module mock) does the transport call the billing tool,
// passing the window as arguments.
// SYNTHETIC local MCP server; ASSUMED tool names.

import { afterEach, expect, it, vi } from 'vitest';
import { StreamableHttpPointFiveMcpClient } from './PointFiveMcpTransport';
import { startSyntheticMcpServer, type SyntheticServer } from '../connectors/managed/pointfive/fixtures/syntheticMcpServer';

vi.mock('./pointfiveConfig', async (orig) => ({ ...(await orig<typeof import('./pointfiveConfig')>()), POINTFIVE_BILLING_ROLE_CONFIRMED: true }));

const TOKEN = 'synthetic-token-0123456789abcdef';
let srv: SyntheticServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

it('with the opt-in flipped, billing calls the discovered tool with the window as arguments', async () => {
  const onCall = vi.fn(() => ({ content: [], structuredContent: { items: [] } }));
  srv = await startSyntheticMcpServer({
    acceptToken: TOKEN,
    tools: [{ name: 'billing_data', inputSchema: { type: 'object', properties: { start: {}, end: {} }, required: ['start', 'end'] } }],
    onCall,
  });
  const creds = { mcpUrl: srv.url, oauthClientId: 'id', oauthClientSecret: 'synthetic', oauthTokenUrl: 'http://token.invalid' };
  await new StreamableHttpPointFiveMcpClient(creds, { getAccessToken: async () => TOKEN }).fetchBillingRows({ start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' });
  expect(onCall).toHaveBeenCalledWith('billing_data', { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' });
});

