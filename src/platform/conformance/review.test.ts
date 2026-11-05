// Regression tests from challenger review round 1 of #184 (reviewer probes c3probe.test.ts Q1-Q3, Q5-Q9, Q11-Q13).
// TEST-ONLY, SYNTHETIC content, loopback servers on ephemeral ports.
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateGatewayRequestRecord, validatePolicyDecision, type Policy } from '../contracts';
import { evaluate, type EvaluationInput } from '../policy';
import { bundle, ent, pol, rule } from '../policy/testing/fixtures';
import { createMockGateway, type GatewayOptions, type GatewayResult } from './mockGateway';
import { startMockProvider, type MockProvider, type MockProviderOptions } from './mockProviders';
import { seeded } from './testing/seeded';

const SECRET = 'SYNTH-CARD-4111';
const detect = seeded([SECRET]);
const dlp = (phase: Policy['phase'] = 'pre_request', over: Partial<Policy> = {}) =>
  pol({ policyId: `pol-${phase}`, phase, rules: [rule({ ruleId: 'r-card', reasonCode: 'DLP_PAYMENT_CARD' })], ...(phase === 'pre_request' ? {} : { release: 'buffer_window' }), ...over });
const ents = [ent(), ent({ entitlementId: 'ent-b', provider: 'provider-b', models: ['model-c'] })];
const servers: { close(): Promise<unknown> }[] = [];
const provider = async (o: MockProviderOptions) => { const p = await startMockProvider(o); servers.push(p); return p; };
let a: MockProvider, b: MockProvider, rawUrl = '', connections = 0;
beforeAll(async () => {
  a = await provider({ flavor: 'openai', reply: ['Hello'] });
  b = await provider({ flavor: 'anthropic', reply: ['Hi'] });
  const raw = net.createServer((s) => { connections++; s.on('data', () => s.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}')); });
  await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
  rawUrl = `http://127.0.0.1:${(raw.address() as net.AddressInfo).port}`;
  servers.push({ close: () => new Promise((r) => raw.close(r)) });
});
afterAll(async () => { await Promise.all(servers.map((s) => s.close())); });

const gw = (over: Partial<GatewayOptions> = {}, pa = () => a.url) => createMockGateway({
  gatewayId: 'gw-mock', bundle: bundle({ policies: [dlp()], entitlements: ents }), accessMode: 'enforce', detect, maxInspectBytes: 4096, windowChunks: 2, maxDetectorSpan: SECRET.length,
  credentials: { 'vk-bot': { tenantId: 'tenant-syn', workloadId: 'wl-bot', actorType: 'service', actorRef: 'svc:bot' } },
  providers: { 'provider-a': { flavor: 'openai', url: pa() }, 'provider-b': { flavor: 'anthropic', url: b.url } },
  digestKey: { keyId: 'k1', secret: 'synthetic-digest-key' }, now: () => '2026-10-02T12:00:00Z', ...over,
});
const send = (g: ReturnType<typeof gw>, path: string, body: unknown, credential = 'vk-bot') => g.handle({ credential, path, body: typeof body === 'string' ? body : JSON.stringify(body) });
const calls = () => a.calls.length + b.calls.length;
function sum(r: GatewayResult) {
  if (r.record) expect(validateGatewayRequestRecord(r.record).ok).toBe(true);
  for (const d of r.decisions) expect(validatePolicyDecision(d).ok).toBe(true);
  if (r.status !== 401) expect(r.decisions.length).toBeGreaterThan(0);
  expect(JSON.stringify([r.record, r.decisions])).not.toContain(SECRET);
  return { status: r.status, codes: [...new Set(r.decisions.flatMap((d) => (d.enforced && d.outcome !== 'allow' ? d.reasonCodes : [])))] };
}
const chat = (content: unknown, more: object = {}) => ({ model: 'model-x', messages: [{ role: 'user', content }], ...more });

describe('H1: a model the gateway cannot read is never dispatched (enforce)', () => {
  const allowAllDenyZ = bundle({ policies: [], entitlements: [ent({ models: ['*'] }), ent({ entitlementId: 'ent-no-z', models: ['model-z'], effect: 'deny' })] });
  it.each([
    ['an oversized request for a denied model', { model: 'model-z', messages: [{ role: 'user', content: 'x'.repeat(5000) }] }, ['MODEL_UNKNOWN']],
    ['a model string that is not a model id', { model: 'model-z@latest', messages: [{ role: 'user', content: 'hi' }] }, ['MODEL_UNKNOWN']],
    ['an oversized request under allow * and no DLP policy', { model: 'model-x', messages: [{ role: 'user', content: 'x'.repeat(5000) }] }, ['MODEL_UNKNOWN']],
    ['a small request for the denied model', { model: 'model-z', messages: [{ role: 'user', content: 'hi' }] }, ['ENTITLEMENT_DENIED']],
  ])('%s: 403, zero provider calls', async (_n, body, codes) => {
    const before = calls();
    expect(sum(await send(gw({ bundle: allowAllDenyZ }), '/v1/chat/completions', body))).toEqual({ status: 403, codes });
    expect(calls() - before).toBe(0);
  });
  it('blocked requests open no TCP connection to the provider; an allowed one opens one (raw socket counter)', async () => {
    const g = gw({}, () => rawUrl);
    connections = 0;
    const blocked = [chat(SECRET), { ...chat('q'), model: 'model-z' }, '{"model":', chat('x'.repeat(5000)), { ...chat('q'), model: 'model-z@latest' }, chat('é'.repeat(2100))];
    for (const body of blocked) expect((await send(g, '/v1/chat/completions', body)).status).toBe(403);
    expect((await send(g, '/v1/embeddings', { model: 'model-x', input: 'q' })).status).toBe(403);
    expect(connections).toBe(0);
    expect((await send(g, '/v1/chat/completions', chat('q'))).status).toBe(200);
    expect(connections).toBe(1);
  });
  it('the bound is in bytes: 2100 two-byte characters exceed a 4096-byte bound (N7)', async () => {
    const body = JSON.stringify(chat('é'.repeat(2100)));
    const r = await send(gw(), '/v1/chat/completions', body);
    expect({ ...sum(r), bytes: r.record?.inputBytes }).toEqual({ status: 403, codes: ['MODEL_UNKNOWN', 'DLP_UNAVAILABLE'], bytes: Buffer.byteLength(body) });
  });
});

describe('M1: every string value is inspected (unknown keys are content), nested JSON decoded within bounds', () => {
  it.each([
    ['chat tools[].function.description', '/v1/chat/completions', chat('q', { tools: [{ type: 'function', function: { name: 'search', description: `use ${SECRET}` } }] })],
    ['chat legacy functions[]', '/v1/chat/completions', chat('q', { functions: [{ name: 'f', description: SECRET }] })],
    ['chat assistant function_call.arguments', '/v1/chat/completions', { model: 'model-x', messages: [{ role: 'assistant', content: null, function_call: { name: 'f', arguments: `{"q":"${SECRET}"}` } }] }],
    ['chat prediction.content', '/v1/chat/completions', chat('q', { prediction: { type: 'content', content: SECRET } })],
    ['chat message name', '/v1/chat/completions', { model: 'model-x', messages: [{ role: 'user', name: SECRET, content: 'q' }] }],
    ['chat metadata', '/v1/chat/completions', chat('q', { metadata: { note: SECRET } })],
    ['responses tools[].description', '/v1/responses', { model: 'model-x', tools: [{ type: 'function', name: 'search', description: SECRET }], input: 'q' }],
    ['messages tools[].description', '/v1/messages', { model: 'model-c', tools: [{ name: 'search', description: SECRET, input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'q' }] }],
    ['messages tools[].input_schema', '/v1/messages', { model: 'model-c', tools: [{ name: 'search', input_schema: { type: 'object', description: SECRET } }], messages: [{ role: 'user', content: 'q' }] }],
    ['nested JSON escape in tool arguments', '/v1/chat/completions', { model: 'model-x', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"\\u0053YNTH-CARD-4111"}' } }] }] }],
    ['doubly nested JSON in tool arguments', '/v1/chat/completions', { model: 'model-x', messages: [{ role: 'tool', tool_call_id: 't1', content: JSON.stringify({ r: JSON.stringify({ s: SECRET }) }) }] }],
  ])('%s: blocked before dispatch', async (_n, path, body) => {
    const before = calls();
    expect(sum(await send(gw(), path, body))).toEqual({ status: 403, codes: ['DLP_PAYMENT_CARD'] });
    expect(calls() - before).toBe(0);
  });
  it('content nested past the depth bound fails closed (DLP unavailable)', async () => {
    let deep: unknown = 'q';
    for (let i = 0; i < 80; i++) deep = { d: deep };
    expect(sum(await send(gw(), '/v1/chat/completions', chat('q', { metadata: deep })))).toEqual({ status: 403, codes: ['DLP_UNAVAILABLE'] });
  });
});

describe('M2, M4, M5: synchronous engines, last-known-good settings, multi-turn tools', () => {
  const spin = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms); };
  it.each([['enforce', 403, 0], ['monitor', 200, 1]] as const)('a CPU-bound engine over the deadline is a timeout (%s: %i, %i calls)', async (accessMode, status, n) => {
    const policies = [dlp('pre_request', { mode: accessMode, ...(accessMode === 'monitor' ? { onTimeout: 'continue_with_gap' as const } : {}) })];
    const before = calls();
    const r = await send(gw({ accessMode, bundle: bundle({ policies, entitlements: ents }), engine: (i: EvaluationInput) => { spin(120); return evaluate(i); } }), '/v1/chat/completions', chat('q'));
    expect({ status: r.status, calls: calls() - before, failures: [...new Set(r.decisions.filter((d) => d.phase === 'pre_request').map((d) => d.failure))] }).toEqual({ status, calls: n, failures: ['timeout'] });
  });
  it('under a last-known-good, the release window and the deadline come from the bundle being evaluated', async () => {
    const expired = bundle({ notAfter: '2026-10-02T00:00:00Z', entitlements: ents, policies: [dlp('stream_chunk', { mode: 'monitor', release: 'pass_through' })] });
    const lkg = bundle({ version: 3, lastKnownGoodApproved: true, entitlements: ents, policies: [dlp('stream_chunk', { release: 'buffer_full', evaluationTimeoutMs: 10 })] });
    const p = await provider({ flavor: 'openai', reply: ['a', SECRET, 'd'] });
    const r = await send(gw({ bundle: expired, lastKnownGood: lkg }, () => p.url), '/v1/chat/completions', chat('q', { stream: true }));
    expect({ ...sum(r), released: r.released }).toEqual({ status: 403, codes: ['DLP_PAYMENT_CARD'], released: [] });
    const slow = gw({ bundle: expired, lastKnownGood: lkg, engine: async (i: EvaluationInput) => { await new Promise((res) => setTimeout(res, 30)); return evaluate(i); } }, () => p.url);
    expect((await send(slow, '/v1/chat/completions', chat('q', { stream: true }))).decisions.some((d) => d.failure === 'timeout' && d.phase === 'stream_chunk')).toBe(true);
  });
  it.each(['monitor', 'enforce'] as const)('a tool declared and called in one request is evaluated (%s), never a 403 without decisions', async (accessMode) => {
    const body = { model: 'model-x', tools: [{ type: 'function', function: { name: 'search' } }], messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: 'r' }] };
    expect(sum(await send(gw({ accessMode, bundle: bundle({ policies: [dlp('pre_request', { mode: accessMode })], entitlements: ents }) }), '/v1/chat/completions', body))).toEqual({ status: 200, codes: [] });
  });
});

describe('M3, L1, L3, L4: stream windows, served-model fallback, prototype names, empty streams', () => {
  const streamed = async (o: MockProviderOptions, release: Policy['release']) => {
    const p = await provider(o);
    const r = await send(gw({ bundle: bundle({ policies: [dlp('stream_chunk', { release })], entitlements: ents }) }, () => p.url), '/v1/chat/completions', chat('q', { stream: true }));
    return { ...sum(r), released: r.released, rel: r.record?.released };
  };
  const split = [SECRET.slice(0, 8), SECRET.slice(8)];
  it.each([
    ['buffer_full, split inside the buffer', ['a', ...split, 'd'], 'buffer_full', [], 'none'],
    ['buffer_window, split inside one window', [...split, 'x', 'y'], 'buffer_window', [], 'none'],
    ['buffer_window, split across windows (overlap)', ['a', ...split, 'd'], 'buffer_window', ['a', split[0]], 'partial'],
  ] as const)('%s: the marker is caught on the joined window', async (_n, reply, release, released, rel) => {
    expect(await streamed({ flavor: 'openai', reply: [...reply] }, release)).toEqual({ status: 403, codes: ['DLP_PAYMENT_CARD'], released, rel });
  });
  it('a buffered window over the inspection bound is not inspected: DLP unavailable, withheld', async () => {
    expect(await streamed({ flavor: 'openai', reply: ['x'.repeat(3000), 'y'.repeat(3000)] }, 'buffer_full')).toEqual({ status: 403, codes: ['DLP_UNAVAILABLE'], released: [], rel: 'none' });
  });
  it('a streamed served-model fallback is re-entitled before release (N17)', async () => {
    expect(await streamed({ flavor: 'openai', reply: ['ok'], serveModel: 'model-y' }, 'buffer_window')).toEqual({ status: 403, codes: ['SERVED_MODEL_NOT_GRANTED'], released: [], rel: 'none' });
  });
  it('a stream with no content still gets an output-phase decision (and its served model is re-checked)', async () => {
    const m = await provider({ flavor: 'anthropic', reply: [], serveModel: 'model-y' });
    const e = await send(gw({ providers: { 'provider-b': { flavor: 'anthropic', url: m.url } } }), '/v1/messages', { model: 'model-c', stream: true, messages: [{ role: 'user', content: 'q' }] });
    expect({ ...sum(e), released: e.released, rel: e.record?.released }).toEqual({ status: 403, codes: ['SERVED_MODEL_NOT_GRANTED'], released: [], rel: 'none' });
    expect(await streamed({ flavor: 'openai', reply: [], serveModel: 'model-y' }, 'buffer_window')).toEqual({ status: 403, codes: ['SERVED_MODEL_NOT_GRANTED'], released: [], rel: 'none' });
    const p = await provider({ flavor: 'openai', reply: [] });
    const r = await send(gw({}, () => p.url), '/v1/chat/completions', chat('q', { stream: true }));
    expect({ status: r.status, phases: [...new Set(r.decisions.map((d) => d.phase))] }).toEqual({ status: 200, phases: ['pre_request', 'stream_chunk'] });
  });
  it('prototype-named credentials and paths are refused cleanly (L3)', async () => {
    for (const credential of ['__proto__', 'constructor', 'toString']) expect(await send(gw(), '/v1/chat/completions', chat('q'), credential)).toMatchObject({ status: 401, record: null, decisions: [] });
    for (const path of ['constructor', '__proto__', 'hasOwnProperty']) expect(sum(await send(gw(), path, { model: 'model-x', input: 'q' })).status).toBe(403);
  });
  it('40 parallel requests, 20 with the seeded card: exactly 20 provider calls, unique request refs (Q7)', async () => {
    const g = gw();
    const before = calls();
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => send(g, '/v1/chat/completions', chat(i % 2 ? SECRET : `clean ${i}`))));
    expect({ calls: calls() - before, ok: rs.filter((r) => r.status === 200).length, refs: new Set(rs.map((r) => r.record?.requestRef)).size }).toEqual({ calls: 20, ok: 20, refs: 40 });
  });
});
