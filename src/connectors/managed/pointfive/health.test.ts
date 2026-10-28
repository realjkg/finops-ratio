// Tool discovery, the four-stage PointFive health probe, and the adapter wiring,
// against the SYNTHETIC local MCP server. Tool names are the ASSUMED defaults
// (never captured from PointFive); payloads are SYNTHETIC.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from './mcpClient';
import { ASSUMED_POINTFIVE_TOOL_NAMES, DiscoveredTools, parseToolMapping } from './discovery';
import { probePointFive } from './health';
import { startSyntheticMcpServer, type SyntheticServer, type SyntheticServerOptions } from './fixtures/syntheticMcpServer';
import { StreamableHttpPointFiveMcpClient } from '../../../costsource/PointFiveMcpTransport';
import { PointFiveLiveAdapter, validateOpportunity } from '../../../costsource/PointFiveLiveAdapter';
import type { HttpFetch } from '../../../costsource/PointFiveOAuthClient';

const TOKEN = 'synthetic-token-0123456789abcdef';
const SECRET = 'synthetic-client-secret-0123456789';
const OBJ = { type: 'object', properties: {} };
const ALL_TOOLS = [
  { name: 'billing_data', inputSchema: { type: 'object', properties: { start: {}, end: {} }, required: ['start', 'end'] } },
  { name: 'opportunities', inputSchema: OBJ },
  { name: 'anomalies', inputSchema: OBJ },
];
// SYNTHETIC finding; field names follow the existing adapter validator, not a vendor schema.
const OPP = { id: 'syn-opp-1', resourceId: 'syn-res', category: 'rightsizing', title: 'SYNTHETIC', estimatedMonthlySavings: '12.50', severity: 'info', detectedAt: '2026-06-20T00:00:00Z' };
const items = (list: unknown[]) => ({ content: [{ type: 'text', text: JSON.stringify({ items: list }) }], structuredContent: { items: list } });

let srv: SyntheticServer | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await srv?.close();
  srv = null;
});

async function serve(opts: SyntheticServerOptions = {}) {
  srv = await startSyntheticMcpServer({ acceptToken: TOKEN, tools: ALL_TOOLS, onCall: () => items([OPP]), ...opts });
  return srv;
}
const tokenOk = { getAccessToken: async () => TOKEN };
const probe = (s: SyntheticServer, tokenProvider = tokenOk) =>
  probePointFive({
    tokenProvider,
    client: new McpClient({ endpoint: s.url, tokenProvider, timeoutMs: 1_000, sleep: async () => {} }),
    mapping: ASSUMED_POINTFIVE_TOOL_NAMES,
    validateDataItem: validateOpportunity,
  });

describe('tool mapping (ASSUMED names, configurable)', () => {
  it('defaults to the ASSUMED names and accepts overrides per capability', () => {
    expect(parseToolMapping(undefined)).toEqual({ billing: 'billing_data', opportunities: 'opportunities', anomalies: 'anomalies' });
    expect(parseToolMapping('anomalies=pf_anomalies_v2')).toMatchObject({ anomalies: 'pf_anomalies_v2', billing: 'billing_data' });
  });

  it('refuses an unknown capability or an invalid tool name, naming the key only', () => {
    expect(() => parseToolMapping('costs=x')).toThrow(/costs/);
    expect(() => parseToolMapping('billing=bad name!')).toThrow(/billing/);
  });

  it('require() fails with TOOL_NOT_DISCOVERED for a configured tool absent from tools/list', () => {
    const d = new DiscoveredTools([ALL_TOOLS[1]], ASSUMED_POINTFIVE_TOOL_NAMES);
    expect(d.missing()).toEqual(['billing', 'anomalies']);
    expect(() => d.require('anomalies', {})).toThrow(expect.objectContaining({ code: 'TOOL_NOT_DISCOVERED' }));
  });

  it('require() fails with TOOL_SCHEMA_MISMATCH when the discovered input schema needs arguments we do not send', () => {
    const d = new DiscoveredTools([{ name: 'opportunities', inputSchema: { type: 'object', required: ['accountId'] } }], ASSUMED_POINTFIVE_TOOL_NAMES);
    expect(() => d.require('opportunities', {})).toThrow(expect.objectContaining({ code: 'TOOL_SCHEMA_MISMATCH' }));
  });
});

describe('probePointFive: four separate stages', () => {
  it('all four pass → source-access-verified', async () => {
    const r = await probe(await serve());
    expect(r.state).toBe('source-access-verified');
    expect([r.stages.auth.ok, r.stages.session.ok, r.stages.tools.ok, r.stages.data.ok]).toEqual([true, true, true, true]);
    expect(r.session?.protocolVersion).toBe('2025-06-18');
  });

  it('token failure → configured-not-verified; no MCP request is made', async () => {
    const s = await serve();
    const r = await probe(s, { getAccessToken: async () => { throw new Error(`token endpoint said ${SECRET}`); } });
    expect(r.state).toBe('configured-not-verified');
    expect([r.stages.auth.ok, r.stages.session.ok, r.stages.tools.ok, r.stages.data.ok]).toEqual([false, null, null, null]);
    expect(s.requests).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('a token the MCP server rejects (401) passes auth only: auth-verified, never data', async () => {
    const r = await probe(await serve({ acceptToken: 'another-token-0123456789abcdef' }));
    expect(r.state).toBe('auth-verified');
    expect(r.stages.session).toMatchObject({ ok: false, code: 'AUTH_REJECTED' });
    expect(r.stages.data.ok).toBeNull();
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('tools/list 403 → degraded with tools:false', async () => {
    const r = await probe(await serve({ override: (rq, res) => (rq.body?.method === 'tools/list' ? (res.writeHead(403).end(), true) : false) }));
    expect(r.state).toBe('degraded');
    expect(r.stages.tools).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('a missing configured tool → degraded, naming the capability; data still checked on the probe tool', async () => {
    const r = await probe(await serve({ tools: ALL_TOOLS.slice(1, 2) }));
    expect(r.state).toBe('degraded');
    expect(r.stages.tools.ok).toBe(false);
    expect(r.stages.tools.detail).toMatch(/billing.*anomalies/);
    expect(r.stages.data.ok).toBe(true);
  });

  it.each([
    ['an invalid item', () => items([{ ...OPP, severity: 'urgent' }])],
    ['an array instead of an object', () => ({ content: [], structuredContent: [OPP] })],
    ['no structured content', () => ({ content: [{ type: 'text', text: 'x' }] })],
    ['a tool execution error', () => ({ content: [], isError: true })],
  ])('data stage fails on %s', async (_n, onCall) => {
    const r = await probe(await serve({ onCall }));
    expect(r.state).toBe('degraded');
    expect(r.stages.data.ok).toBe(false);
  });
});

describe('StreamableHttpPointFiveMcpClient', () => {
  const creds = (url: string) => ({ mcpUrl: url, oauthClientId: 'id', oauthClientSecret: SECRET, oauthTokenUrl: 'http://token.invalid' });
  const oauth = tokenOk as never;

  it('discovers before calling and never calls an undiscovered tool', async () => {
    const s = await serve({ tools: ALL_TOOLS.slice(1, 2) });
    const c = new StreamableHttpPointFiveMcpClient(creds(s.url), oauth);
    expect(await c.listOpportunities()).toEqual([OPP]);
    await expect(c.listAnomalies()).rejects.toMatchObject({ code: 'TOOL_NOT_DISCOVERED' });
    expect(s.methods().filter((m) => m === 'tools/call')).toHaveLength(1);
    expect(s.methods().indexOf('tools/list')).toBeLessThan(s.methods().indexOf('tools/call'));
  });

  it('passes the billing window as tool arguments', async () => {
    const onCall = vi.fn(() => items([]));
    const s = await serve({ onCall });
    await new StreamableHttpPointFiveMcpClient(creds(s.url), oauth).fetchBillingRows({ start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' });
    expect(onCall).toHaveBeenCalledWith('billing_data', { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' });
  });

  it('ping() is true only when an MCP session is established, not on token alone', async () => {
    const s = await serve({ acceptToken: 'another-token-0123456789abcdef' });
    expect(await new StreamableHttpPointFiveMcpClient(creds(s.url), oauth).ping()).toBe(false);
  });
});

describe('PointFiveLiveAdapter.healthCheck with the real protocol client', () => {
  const tokenEndpoint: HttpFetch = async (_url, init) => {
    expect(init?.body).toContain('resource=');
    return { ok: true, status: 200, text: async () => '', json: async () => ({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 }) };
  };
  const env = (url: string) => ({
    COSTSOURCE_POINTFIVE_LIVE: 'true',
    POINTFIVE_OAUTH_CLIENT_ID: 'id',
    POINTFIVE_OAUTH_CLIENT_SECRET: SECRET,
    POINTFIVE_OAUTH_TOKEN_URL: 'http://token.invalid/token',
    POINTFIVE_MCP_URL: url,
  });

  it('reports source-access-verified with all four stages', async () => {
    const s = await serve();
    const h = await new PointFiveLiveAdapter({ env: env(s.url), httpFetch: tokenEndpoint }).healthCheck();
    expect(h).toMatchObject({ reachable: true, authed: true, verification: 'source-access-verified' });
    expect(Object.keys(h.stages!)).toEqual(['auth', 'session', 'tools', 'data']);
  });

  it('token obtained but MCP refuses: not reachable/authed, never "MCP reachable", no secret or token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await serve({ acceptToken: 'another-token-0123456789abcdef' });
    const h = await new PointFiveLiveAdapter({ env: env(s.url), httpFetch: tokenEndpoint }).healthCheck();
    expect(h).toMatchObject({ reachable: false, authed: false, verification: 'auth-verified' });
    expect(h.detail).not.toMatch(/MCP reachable|connected/i);
    const out = JSON.stringify(h) + JSON.stringify(warn.mock.calls);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
  });
});
