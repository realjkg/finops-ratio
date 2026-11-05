// Regression tests from challenger review round 2 of #184 (probes c3probe-r2 S3-S8; mutations N29, N33). TEST-ONLY, SYNTHETIC.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateGatewayRequestRecord, validatePolicyDecision, type Policy } from '../contracts';
import { bundle, ent, pol, rule } from '../policy/testing/fixtures';
import { createMockGateway, type GatewayOptions, type GatewayResult } from './mockGateway';
import { startMockProvider, type MockProvider, type MockProviderOptions } from './mockProviders';
import { seeded } from './testing/seeded';

const SECRET = 'SYNTH-CARD-4111', PAN = '4111111111111111';
const ENTS = [ent(), ent({ entitlementId: 'ent-b', provider: 'provider-b', models: ['model-c'] })];
const card = (phase: Policy['phase'] = 'pre_request', over: Partial<Policy> = {}) => pol({ policyId: `pol-${phase}`, phase, rules: [rule({ ruleId: 'r-card', reasonCode: 'DLP_PAYMENT_CARD' })], ...(phase === 'pre_request' ? {} : { release: 'buffer_window' }), ...over });
const servers: MockProvider[] = [];
const provider = async (o: MockProviderOptions) => { const p = await startMockProvider(o); servers.push(p); return p; };
let a: MockProvider, b: MockProvider;
beforeAll(async () => { a = await provider({ flavor: 'openai', reply: ['Hello'] }); b = await provider({ flavor: 'anthropic', reply: ['Hi'] }); });
afterAll(async () => { await Promise.all(servers.map((p) => p.close())); });
const gw = (over: Partial<GatewayOptions> = {}) => createMockGateway({
  gatewayId: 'gw-mock', bundle: bundle({ policies: [card()], entitlements: ENTS }), accessMode: 'enforce', detect: seeded([SECRET, PAN]), maxInspectBytes: 4096, windowChunks: 2, maxDetectorSpan: SECRET.length,
  credentials: { 'vk-bot': { tenantId: 'tenant-syn', workloadId: 'wl-bot', actorType: 'service', actorRef: 'svc:bot' } },
  providers: { 'provider-a': { flavor: 'openai', url: a.url }, 'provider-b': { flavor: 'anthropic', url: b.url } },
  digestKey: { keyId: 'k1', secret: 'synthetic-digest-key' }, now: () => '2026-10-02T12:00:00Z', ...over,
});
const calls = () => a.calls.length + b.calls.length;
async function go(path: string, body: unknown, over: Partial<GatewayOptions> = {}) {
  const before = calls();
  const r: GatewayResult = await gw(over).handle({ credential: 'vk-bot', path, body: typeof body === 'string' ? body : JSON.stringify(body) });
  expect(r.record && validateGatewayRequestRecord(r.record).ok).toBe(true);
  for (const d of r.decisions) expect(validatePolicyDecision(d).ok).toBe(true);
  expect(JSON.stringify([r.record, r.decisions])).not.toContain(SECRET);
  return { status: r.status, calls: calls() - before, codes: [...new Set(r.decisions.flatMap((d) => (d.enforced && d.outcome !== 'allow' ? d.reasonCodes : [])))], r };
}
const chat = (content: unknown, more: object = {}) => ({ model: 'model-x', messages: [{ role: 'user', content }], ...more });
const args = (x: string) => ({ model: 'model-x', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: x } }] }] });
const blocked = { status: 403, calls: 0 };

describe('M1: object keys and non-string scalars are inspected', () => {
  it.each([
    ['a marker as a JSON key in tool arguments', args(JSON.stringify({ [SECRET]: 'x' }))], ['a marker as a top-level key', { ...chat('q'), [SECRET]: 1 }],
    ['a marker as a metadata key', chat('q', { metadata: { [SECRET]: 'v' } })], ['a PAN as a JSON number in tool arguments', args(`{"card":${PAN}}`)],
    ['a PAN as a JSON number in metadata', `{"model":"model-x","metadata":{"card":${PAN}},"messages":[{"role":"user","content":"q"}]}`],
    ['a 19-digit PAN number (beyond float precision) in metadata', `{"model":"model-x","metadata":{"card":${PAN}123},"messages":[{"role":"user","content":"q"}]}`],
  ])('%s is blocked before dispatch', async (_n, body) => {
    expect(await go('/v1/chat/completions', body)).toMatchObject({ ...blocked, codes: ['DLP_PAYMENT_CARD'] });
  });
});

describe('M2 / L1: tools identified by name, else by type; unidentifiable tools are never on an allowlist', () => {
  const allow = bundle({ entitlements: ENTS, policies: [pol({ policyId: 'pol-tools', rules: [rule({ ruleId: 'r-tools', condition: { kind: 'tool', tools: ['search', 'type:web_search_preview', 'mcp:wiki', 'tool:_lookup'], match: 'not_in' }, reasonCode: 'TOOL_NOT_ALLOWED' })] })] });
  it.each([
    ['code_interpreter (no name)', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] }, 403],
    ['an mcp server not allowed', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'mcp', server_label: 'deepwiki', server_url: 'https://mcp.example.invalid' }] }, 403],
    ['an allowed mcp server', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'mcp', server_label: 'wiki' }] }, 200],
    ['web_search_preview, allowed by type', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'web_search_preview' }] }, 200],
    ['a tool without name or type', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ container: {} }] }, 403],
    ['a name that is not an id (_shell), not allowed', '/v1/chat/completions', chat('q', { tools: [{ type: 'function', function: { name: '_shell' } }] }), 403],
    ['a name that is not an id (_lookup), allowed by its normalized id', '/v1/chat/completions', chat('q', { tools: [{ type: 'function', function: { name: '_lookup' } }] }), 200],
  ])('%s', async (_n, path, body, status) => {
    const r = await go(path, body, { bundle: allow });
    expect({ status: r.status, codes: r.codes }).toEqual({ status, codes: status === 403 ? ['TOOL_NOT_ALLOWED'] : [] });
  });
});

describe('M3: over-cap findings or tools never flip block to allow (monitor access, enforce DLP policy)', () => {
  const mixed = { accessMode: 'monitor' as const, maxInspectBytes: 1e7 };
  it.each([
    ['1 marker', '/v1/completions', { model: 'model-x', prompt: [SECRET] }], ['1001 markers', '/v1/completions', { model: 'model-x', prompt: Array.from({ length: 1001 }, () => SECRET) }],
    ['1 marker + 257 tools', '/v1/chat/completions', chat(SECRET, { tools: Array.from({ length: 257 }, (_, i) => ({ type: 'function', function: { name: `t${i}` } })) })],
  ])('%s: blocked, zero calls', async (_n, path, body) => {
    expect(await go(path, body, mixed)).toMatchObject(blocked);
  });
});

describe('L2-L4: media types, carried findings, oversized responses, detector span', () => {
  it.each(['Image', 'image_file', 'INPUT_AUDIO', 'video_url'])('a %s block is opaque: DLP unavailable', async (type) => {
    expect(await go('/v1/messages', { model: 'model-c', messages: [{ role: 'user', content: [{ type, source: {} }] }] })).toMatchObject({ ...blocked, codes: ['DLP_UNAVAILABLE'] });
  });
  it('a finding in the carried overlap is not re-reported, and a second occurrence after it is still found (N29)', async () => {
    const p = await provider({ flavor: 'openai', reply: ['a', SECRET, 'b', SECRET, 'c'] });
    const monitorStream = bundle({ entitlements: ENTS, policies: [card('stream_chunk', { mode: 'monitor', release: 'pass_through' })] });
    const r = await go('/v1/chat/completions', chat('q', { stream: true }), { bundle: monitorStream, maxDetectorSpan: 64, providers: { 'provider-a': { flavor: 'openai', url: p.url } } });
    const windows = r.r.decisions.filter((d) => d.phase === 'stream_chunk' && d.decisionId.endsWith(':p0'));
    expect(windows.map((d) => d.findings.length)).toEqual([0, 1, 0, 1, 0]);
  });
  it('an oversized non-streamed response is not inspected: DLP unavailable, withheld (N33)', async () => {
    const p = await provider({ flavor: 'openai', reply: ['x'.repeat(5000)] });
    const out = bundle({ entitlements: ENTS, policies: [card('pre_response', { release: 'buffer_full' })] });
    const r = await go('/v1/chat/completions', chat('q'), { bundle: out, providers: { 'provider-a': { flavor: 'openai', url: p.url } } });
    expect({ status: r.status, codes: r.codes, released: r.r.released }).toEqual({ status: 403, codes: ['DLP_UNAVAILABLE'], released: [] });
  });
  it('a detector span below 2 is refused at creation (a 1-character span would carry the whole stream)', () => {
    expect(() => gw({ maxDetectorSpan: 1 })).toThrow(RangeError);
  });
});
