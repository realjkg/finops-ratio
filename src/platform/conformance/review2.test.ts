// Regression tests from challenger review round 2 of #184 (probes c3probe-r2 S3-S8; mutations N29, N33). TEST-ONLY, SYNTHETIC.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateGatewayRequestRecord, validatePolicyDecision, type Policy } from '../contracts';
import { bundle, ent, pol, rule } from '../policy/testing/fixtures';
import { createMockGateway, requireSourceText, type GatewayOptions, type GatewayResult } from './mockGateway';
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
    ['a 17-digit number ending in a PAN (beyond float precision) in metadata', `{"model":"model-x","metadata":{"card":9${PAN}},"messages":[{"role":"user","content":"q"}]}`],
  ])('%s is blocked before dispatch', async (_n, body) => {
    expect(await go('/v1/chat/completions', body)).toMatchObject({ ...blocked, codes: ['DLP_PAYMENT_CARD'] });
  });
});

describe('M2 / L1: tools identified by name, else by type; unidentifiable tools are never on an allowlist', () => {
  const allow = bundle({ entitlements: ENTS, policies: [pol({ policyId: 'pol-tools', rules: [rule({ ruleId: 'r-tools', condition: { kind: 'tool', tools: ['fn:search', 'type:web_search_preview', 'mcp:wiki', 'fn:_lookup', 'unidentified-tool'], match: 'not_in' }, reasonCode: 'TOOL_NOT_ALLOWED' })] })] });
  it.each([
    ['code_interpreter (no name)', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] }, 403],
    ['an mcp server not allowed', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'mcp', server_label: 'deepwiki', server_url: 'https://mcp.example.invalid' }] }, 403],
    ['an allowed mcp server', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'mcp', server_label: 'wiki' }] }, 200],
    ['web_search_preview, allowed by type', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'web_search_preview' }] }, 200],
    ['a tool without name or type', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ container: {} }] }, 403],
    ['a name that is not an id (_shell), not allowed', '/v1/chat/completions', chat('q', { tools: [{ type: 'function', function: { name: '_shell' } }] }), 403],
    ['a name that is not an id (_lookup), allowed as fn:_lookup', '/v1/chat/completions', chat('q', { tools: [{ type: 'function', function: { name: '_lookup' } }] }), 200],
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
describe('round 3: tool identities, content-block positions, numbers', () => {
  const allow = bundle({ entitlements: ENTS, policies: [pol({ policyId: 'pol-tools', rules: [rule({ ruleId: 'r-tools', condition: { kind: 'tool', tools: ['fn:search', 'mcp:deepwiki', 'unidentified-tool'], match: 'not_in' }, reasonCode: 'TOOL_NOT_ALLOWED' })] })] });
  const call = (...names: string[]) => ({ model: 'model-x', messages: [{ role: 'assistant', content: null, tool_calls: names.map((name, i) => ({ id: `t${i}`, type: 'function', function: { name, arguments: '{}' } })) }] });
  it.each([
    ['an mcp tool with a decoy name', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'mcp', name: 'search', server_label: 'evil', server_url: 'https://mcp.example.invalid' }] }, 403],
    ['code_interpreter with a decoy name', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'code_interpreter', name: 'search' }] }, 403],
    ['a function named mcp:deepwiki (no collision with mcp:deepwiki)', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'function', name: 'mcp:deepwiki' }] }, 403],
    ['a nameless, typeless tool although unidentified-tool is listed', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ container: {} }] }, 403],
    ['a function with two names (function.name search, name shell)', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'function', name: 'shell', function: { name: 'search' } }] }, 403],
    ['a function name that is not an id even with the prefix ("search x")', '/v1/responses', { model: 'model-x', input: 'q', tools: [{ type: 'function', name: 'search x' }] }, 403],
    ['parallel tool calls search + shell', '/v1/chat/completions', call('search', 'shell'), 403], ['parallel tool calls search + search', '/v1/chat/completions', call('search', 'search'), 200],
  ])('%s', async (_n, path, body, status) => expect((await go(path, body, { bundle: allow })).status).toBe(status));
  it.each([
    ['a messages block of unknown type with base64 data', { model: 'model-c', messages: [{ role: 'user', content: [{ type: 'pdf', source: { data: 'QUJD' } }] }] }, '/v1/messages'],
    ['a messages image_base64 block', { model: 'model-c', messages: [{ role: 'user', content: [{ type: 'image_base64', data: 'QUJD' }] }] }, '/v1/messages'],
    ['a chat input_pdf part', chat([{ type: 'input_pdf', file_data: 'QUJD' }]), '/v1/chat/completions'], ['a typeless chat part with image_url', chat([{ image_url: { url: 'data:image/png;base64,QUJD' } }]), '/v1/chat/completions'],
    ['a content object (not array) with image_url', chat({ image_url: { url: 'x' } }), '/v1/chat/completions'],
  ])('%s is uninspectable: DLP unavailable', async (_n, body, path) => expect(await go(path, body)).toMatchObject({ ...blocked, codes: ['DLP_UNAVAILABLE'] }));
  it('a media object outside a content-block position (any case) is also uninspectable', async () => {
    expect(await go('/v1/chat/completions', chat('q', { metadata: { attachment: { type: 'Image', data: 'QUJD' } } }))).toMatchObject({ ...blocked, codes: ['DLP_UNAVAILABLE'] });
  });
  it('JSON-schema fields in tool definitions are data, not content blocks; 10,001 token ids are one segment', async () => {
    expect((await go('/v1/messages', { model: 'model-c', tools: [{ name: 'search', input_schema: { type: 'object', properties: { type: { type: 'string' } } } }], messages: [{ role: 'user', content: 'q' }] })).status).toBe(200);
    expect((await go('/v1/completions', { model: 'model-x', prompt: Array.from({ length: 10001 }, (_, i) => i) }, { maxInspectBytes: 1e6 })).status).toBe(200);
  });
  it('number findings carry their real location: tool_use input numbers are tool_arguments; response numbers are output (N46)', async () => {
    const r = await go('/v1/messages', { model: 'model-c', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'pay', input: { card: Number(PAN) } }] }] });
    expect({ status: r.status, at: r.r.decisions.flatMap((d) => d.findings.map((f) => f.location)) }).toEqual({ status: 403, at: ['tool_arguments'] });
    const p = await provider({ flavor: 'openai', reply: ['ok'], extra: { meta: { card: Number(PAN) } } });
    const o = await go('/v1/chat/completions', chat('q'), { bundle: bundle({ entitlements: ENTS, policies: [card('pre_response', { release: 'buffer_full' })] }), providers: { 'provider-a': { flavor: 'openai', url: p.url } } });
    expect({ status: o.status, at: o.r.decisions.flatMap((d) => d.findings.map((f) => f.location)) }).toEqual({ status: 403, at: ['output'] });
  });
});
describe('round 4: tools declared outside tools, history identities, item and block positions', () => {
  const only = (tools: string[], match: 'in' | 'not_in' = 'not_in') => bundle({ entitlements: ENTS, policies: [pol({ policyId: 'pol-tools', rules: [rule({ ruleId: 'r-tools', condition: { kind: 'tool', tools, match }, reasonCode: 'TOOL_NOT_ALLOWED' })] })] });
  const msgs = (more: object, ...content: unknown[]) => ({ model: 'model-c', messages: [{ role: 'user', content: 'q' }, ...content.map((c) => ({ role: 'assistant', content: [c] }))], ...more });
  const evil = { type: 'url', url: 'https://evil.invalid/sse', name: 'evil' }, U = ['TOOL_UNIDENTIFIED'], N = ['TOOL_NOT_ALLOWED'], R = '/v1/responses', M = '/v1/messages';
  it.each([
    ['Messages mcp_servers under an fn:search allowlist (M1)', M, msgs({ tools: [{ name: 'search' }], mcp_servers: [evil] }), only(['fn:search']), 403, N],
    ['Messages mcp_servers allowed as mcp:evil', M, msgs({ tools: [{ name: 'search' }], mcp_servers: [evil] }), only(['fn:search', 'mcp:evil']), 200, []],
    ['a nameless mcp_servers entry, no tool policy', M, msgs({ mcp_servers: [{ type: 'url', url: 'https://x.invalid' }] }), undefined, 403, U],
    ['an unknown tool-declaring parameter (plugins), no tool policy', '/v1/chat/completions', chat('q', { plugins: [{ id: 'x' }] }), undefined, 403, U],
    ['fn:search + mcp:evil under fn:search + mcp:wiki', R, { model: 'model-x', input: 'q', tools: [{ type: 'function', name: 'search' }, { type: 'mcp', server_label: 'evil' }] }, only(['fn:search', 'mcp:wiki']), 403, N],
    ['a bundle listing the unidentified sentinel is refused (L2)', R, { model: 'model-x', input: 'q', tools: [{ type: 'mcp' }] }, only(['unidentified:gw-mock-req-1']), 403, ['BUNDLE_INVALID']],
    ['server_tool_use in history is type:web_search (L4)', M, msgs({}, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }), only(['fn:search']), 403, N],
    ['mcp_tool_use in history is mcp:<server_name>', M, msgs({}, { type: 'mcp_tool_use', id: 'm1', name: 'run', server_name: 'evil', input: {} }), only(['mcp:evil'], 'in'), 403, N],
    ['a Responses mcp_call item is mcp:<server_label>', R, { model: 'model-x', input: [{ type: 'mcp_call', id: 'c1', server_label: 'evil', name: 'run', arguments: '{}', output: 'ok' }] }, only(['mcp:evil'], 'in'), 403, N],
  ])('%s', async (_n, path, body, b, status, codes) => expect(await go(path, body, b ? { bundle: b } : {})).toMatchObject({ status, codes }));
  it('an unidentified tool is recorded, not enforced, in monitor mode', async () => expect((await go(M, msgs({ mcp_servers: [{ type: 'url' }] }), { accessMode: 'monitor' })).status).toBe(200));
  it.each([
    ['a Responses input item of unknown type (L3)', R, { model: 'model-x', input: [{ type: 'input_blob', data: 'QUJD' }] }], ['a typeless Responses input item with data', R, { model: 'model-x', input: [{ data: 'QUJD' }] }],
    ['function_call_output.output parts of unknown type', R, { model: 'model-x', input: [{ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_blob', data: 'QUJD' }] }] }],
    ['a tool_result content block of unknown type (N49)', M, msgs({}, { type: 'tool_result', tool_use_id: 't', content: [{ type: 'pdf', data: 'QUJD' }] })], ['a top-level system block of unknown type (N50)', M, msgs({ system: [{ type: 'pdf', data: 'QUJD' }] })],
    ['redacted_thinking in history (accepted availability cost, L5)', M, msgs({}, { type: 'redacted_thinking', data: 'QUJD' })], ['web_search_tool_result in history (L5)', M, msgs({}, { type: 'web_search_tool_result', tool_use_id: 's', content: [] })],
  ])('%s is uninspectable: DLP unavailable', async (_n, path, body) => expect(await go(path, body)).toMatchObject({ ...blocked, codes: ['DLP_UNAVAILABLE'] }));
  it('known Responses items stay inspectable; a token-id array with a PAN is found (N38); source-text access is checked loudly', async () => {
    expect((await go(R, { model: 'model-x', input: [{ role: 'user', content: 'q' }, { type: 'function_call', call_id: 'c', name: 'search', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: 'ok' }] })).status).toBe(200);
    expect(await go('/v1/completions', { model: 'model-x', prompt: [Number(PAN), 7] })).toMatchObject({ ...blocked, codes: ['DLP_PAYMENT_CARD'] });
    expect([() => requireSourceText(), () => requireSourceText((s, r) => JSON.parse(s, (k, v) => r(k, v)))].map((f) => { try { f(); return 'ok'; } catch (e) { return String(e); } })).toEqual(['ok', expect.stringMatching(/source text/)]);
  });
});
