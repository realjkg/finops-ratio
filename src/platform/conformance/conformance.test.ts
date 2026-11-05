// Conformance suite for the policy library in a mock gateway (ADR-0001 slice C3; §3.2, §3.3, §7 bypass paths).
// TEST-ONLY: mock providers on 127.0.0.1 ephemeral ports, SYNTHETIC content, no real provider, key or network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateGatewayRequestRecord, validatePolicy, validatePolicyDecision, type DlpFinding, type Policy, type PolicyBundle } from '../contracts';
import { evaluate } from '../policy';
import { bundle, ent, pol, rule } from '../policy/testing/fixtures';
import { createMockGateway, type GatewayOptions, type GatewayResult } from './mockGateway';
import { startMockProvider, type MockProvider, type MockProviderOptions } from './mockProviders';
import { seeded } from './testing/seeded';

const SECRET = 'SYNTH-CARD-4111';
const PROMPT = 'SYNTHETIC prompt text';
const ALLOWED = ['provider-a:openai_chat', 'provider-a:openai_completions', 'provider-a:openai_responses', 'provider-b:anthropic_messages'];
const dlp = rule({ ruleId: 'r-card', reasonCode: 'DLP_PAYMENT_CARD' });
const inputPolicy = pol({ policyId: 'pol-in', rules: [dlp, rule({ ruleId: 'r-surface', condition: { kind: 'destination', providers: ALLOWED, match: 'not_in' }, reasonCode: 'SURFACE_NOT_ALLOWED' }),
  rule({ ruleId: 'r-tool', condition: { kind: 'tool', tools: ['shell'], match: 'in' }, reasonCode: 'TOOL_NOT_ALLOWED' })] });
const out = (phase: Policy['phase'], release: Policy['release'], over: Partial<Policy> = {}) => pol({ policyId: `pol-${phase}`, phase, release, rules: [dlp], ...over });
const conformanceBundle = (stream: Partial<Policy> = {}, over: Partial<PolicyBundle> = {}) => bundle({
  policies: [inputPolicy, out('pre_response', 'buffer_full'), out('stream_chunk', 'buffer_window', stream)],
  entitlements: [ent(), ent({ entitlementId: 'ent-b', provider: 'provider-b', models: ['model-c'] })], ...over,
});
const inspected: number[] = [];
/** A seeded-marker detector standing in for the C4 detectors: offsets only, never the text. */
const detect = (text: string, location: DlpFinding['location']): DlpFinding[] => { inspected.push(text.length); return seeded([SECRET])(text, location); };

const providers: MockProvider[] = [];
const provider = async (o: MockProviderOptions) => { const p = await startMockProvider(o); providers.push(p); return p; };
afterAll(async () => { await Promise.all(providers.map((p) => p.close())); });
let a: MockProvider, b: MockProvider;
beforeAll(async () => { a = await provider({ flavor: 'openai', reply: ['Hello ', 'there'] }); b = await provider({ flavor: 'anthropic', reply: ['Hi'] }); });

const gateway = (over: Partial<GatewayOptions> = {}, pa = a, pb = b) => createMockGateway({
  gatewayId: 'gw-mock', bundle: conformanceBundle(), accessMode: 'enforce', detect, maxInspectBytes: 4096, windowChunks: 2,
  credentials: { 'vk-bot': { tenantId: 'tenant-syn', workloadId: 'wl-bot', actorType: 'service', actorRef: 'svc:bot' } },
  providers: { 'provider-a': { flavor: 'openai', url: pa.url }, 'provider-b': { flavor: 'anthropic', url: pb.url } },
  digestKey: { keyId: 'k1', secret: 'synthetic-digest-key' }, now: () => '2026-10-02T12:00:00Z', maxDetectorSpan: SECRET.length, ...over,
});
const chat = (content: unknown, more: object = {}) => ({ model: 'model-x', messages: [{ role: 'user', content }], ...more });
const send = (g: ReturnType<typeof gateway>, path: string, body: unknown, credential = 'vk-bot', headers: Record<string, string> = {}) =>
  g.handle({ credential, path, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
/** Every record and decision passes its contract and carries no raw content. */
function checked(r: GatewayResult) {
  expect(r.record && validateGatewayRequestRecord(r.record)).toEqual({ ok: true, value: r.record });
  for (const d of r.decisions) expect(validatePolicyDecision(d).ok).toBe(true);
  expect(r.record?.decisionIds).toEqual(r.decisions.map((d) => d.decisionId));
  expect(JSON.stringify([r.record, r.decisions])).not.toMatch(new RegExp(`${SECRET}|${PROMPT}|Hello|there`));
  return r;
}
const codes = (r: GatewayResult) => r.decisions.flatMap((d) => (d.enforced && d.outcome !== 'allow' ? d.reasonCodes : []));
const calls = (p: MockProvider) => p.calls.length;

describe('pre-dispatch: a blocked request never reaches the provider', () => {
  it('a clean request is dispatched once and released in full; test servers listen on 127.0.0.1 only', async () => {
    expect([a.url, b.url].every((u) => /^http:\/\/127\.0\.0\.1:\d+$/.test(u))).toBe(true);
    const before = calls(a);
    const r = checked(await send(gateway(), '/v1/chat/completions', chat(PROMPT)));
    expect({ status: r.status, released: r.released, dispatch: r.record?.dispatch, rel: r.record?.released, calls: calls(a) - before }).toEqual({ status: 200, released: ['Hello there'], dispatch: 'dispatched', rel: 'full', calls: 1 });
    expect(r.record).toMatchObject({ surface: 'openai_chat', provider: 'provider-a', modelRequested: 'model-x', modelServed: 'model-x', outputBytes: 11, streamed: false });
  });
  it.each([
    ['chat user text', '/v1/chat/completions', chat(`card ${SECRET}`), 'input'],
    ['chat content parts', '/v1/chat/completions', chat([{ type: 'text', text: `card ${SECRET}` }]), 'input'],
    ['chat system', '/v1/chat/completions', { model: 'model-x', messages: [{ role: 'system', content: SECRET }, { role: 'user', content: PROMPT }] }, 'system'],
    ['chat tool-call arguments', '/v1/chat/completions', { model: 'model-x', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: `{"q":"${SECRET}"}` } }] }] }, 'tool_arguments'],
    ['chat tool result', '/v1/chat/completions', { model: 'model-x', messages: [{ role: 'tool', tool_call_id: 't1', content: SECRET }] }, 'tool_result'],
    ['completions-style prompt', '/v1/completions', { model: 'model-x', prompt: [PROMPT, SECRET] }, 'input'],
    ['responses input', '/v1/responses', { model: 'model-x', input: SECRET }, 'input'],
    ['responses function output', '/v1/responses', { model: 'model-x', input: [{ type: 'function_call_output', call_id: 't1', output: SECRET }] }, 'tool_result'],
    ['messages system', '/v1/messages', { model: 'model-c', system: [{ type: 'text', text: SECRET }], messages: [{ role: 'user', content: PROMPT }] }, 'system'],
    ['messages text block', '/v1/messages', { model: 'model-c', messages: [{ role: 'user', content: [{ type: 'text', text: SECRET }] }] }, 'input'],
    ['messages tool_use input', '/v1/messages', { model: 'model-c', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: SECRET } }] }] }, 'tool_arguments'],
    ['messages tool_result', '/v1/messages', { model: 'model-c', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: SECRET }] }] }] }, 'tool_result'],
  ])('%s: seeded card is found and blocked before dispatch', async (_n, path, body, location) => {
    const before = calls(a) + calls(b);
    const r = checked(await send(gateway(), path, body));
    expect({ status: r.status, released: r.released, dispatch: r.record?.dispatch, calls: calls(a) + calls(b) - before, codes: codes(r) }).toEqual({ status: 403, released: [], dispatch: 'not_dispatched', calls: 0, codes: ['DLP_PAYMENT_CARD'] });
    expect(r.decisions.flatMap((d) => d.findings.map((f) => f.location))).toEqual([location]);
  });
  it.each([['/v1/completions', { model: 'model-x', prompt: PROMPT }, 'other'], ['/v1/responses', { model: 'model-x', input: PROMPT }, 'openai_responses'], ['/v1/messages', { model: 'model-c', messages: [{ role: 'user', content: PROMPT }] }, 'anthropic_messages']])(
    'clean %s is dispatched (surface %s)', async (path, body, surface) => {
      const before = calls(a) + calls(b);
      const r = checked(await send(gateway(), path, body));
      expect({ status: r.status, surface: r.record?.surface, calls: calls(a) + calls(b) - before }).toEqual({ status: 200, surface, calls: 1 });
    });
  it.each([
    ['an unknown surface (embeddings)', '/v1/embeddings', { model: 'model-x', input: PROMPT }, ['ENTITLEMENT_NOT_GRANTED', 'SURFACE_NOT_ALLOWED']],
    ['a disallowed tool', '/v1/chat/completions', chat(PROMPT, { tools: [{ type: 'function', function: { name: 'shell' } }] }), ['TOOL_NOT_ALLOWED']],
    ['an uninspectable content block', '/v1/messages', { model: 'model-c', messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }, ['DLP_UNAVAILABLE']],
    ['malformed JSON', '/v1/chat/completions', '{"model":', ['MODEL_UNKNOWN', 'DLP_UNAVAILABLE']],
    ['a disallowed model', '/v1/chat/completions', { ...chat(PROMPT), model: 'model-z' }, ['ENTITLEMENT_NOT_GRANTED']],
  ])('%s is blocked before dispatch', async (_n, path, body, expected) => {
    const before = calls(a) + calls(b);
    const r = checked(await send(gateway(), path, body));
    expect({ status: r.status, calls: calls(a) + calls(b) - before, codes: codes(r) }).toEqual({ status: 403, calls: 0, codes: expected });
  });
  it('identity comes from the gateway credential; claimed headers are ignored; an unknown credential is refused', async () => {
    const r = checked(await send(gateway(), '/v1/chat/completions', chat(PROMPT), 'vk-bot', { 'x-tenant-id': 'tenant-evil', 'x-workload-id': 'wl-etl' }));
    expect(r.record).toMatchObject({ tenantId: 'tenant-syn', workloadId: 'wl-bot', actorRef: 'svc:bot' });
    const before = calls(a);
    expect(await send(gateway(), '/v1/chat/completions', chat(PROMPT), 'vk-unknown')).toMatchObject({ status: 401, record: null, decisions: [] });
    expect(calls(a)).toBe(before);
  });
  it('an oversized input is bounded: never parsed or inspected past the limit, DLP unavailable, not dispatched', async () => {
    inspected.length = 0;
    const before = calls(a);
    const body = JSON.stringify(chat(`${'x'.repeat(5000)} ${SECRET}`));
    const r = checked(await send(gateway(), '/v1/chat/completions', body));
    expect({ status: r.status, calls: calls(a) - before, inspected, bytes: r.record?.inputBytes, model: r.record?.modelRequested }).toEqual({ status: 403, calls: 0, inspected: [], bytes: Buffer.byteLength(body), model: undefined });
    expect(codes(r)).toContain('DLP_UNAVAILABLE');
  });
});

describe('fail closed on evaluation timeout and engine error', () => {
  it('a hung engine times out at the policy deadline and the request is never dispatched', async () => {
    const before = calls(a);
    const t0 = process.hrtime.bigint();
    const r = checked(await send(gateway({ engine: () => new Promise(() => undefined) }), '/v1/chat/completions', chat(PROMPT)));
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(1000);
    expect({ status: r.status, calls: calls(a) - before, failures: [...new Set(r.decisions.map((d) => d.failure))] }).toEqual({ status: 403, calls: 0, failures: ['timeout'] });
  });
  it('an engine that throws fails closed', async () => {
    const before = calls(a);
    const r = checked(await send(gateway({ engine: () => { throw new Error('engine'); } }), '/v1/chat/completions', chat(PROMPT)));
    expect({ status: r.status, calls: calls(a) - before, failures: [...new Set(r.decisions.map((d) => d.failure))] }).toEqual({ status: 403, calls: 0, failures: ['engine_error'] });
  });
  it('monitor-only: a timeout continues with a visible gap and the request is dispatched', async () => {
    const monitor = bundle({ policies: [pol({ mode: 'monitor', onTimeout: 'continue_with_gap' })] });
    const before = calls(a);
    const r = checked(await send(gateway({ bundle: monitor, accessMode: 'monitor', engine: () => new Promise(() => undefined) }), '/v1/chat/completions', chat(PROMPT)));
    expect({ status: r.status, calls: calls(a) - before, gap: r.decisions.some((d) => d.failureHandling === 'continued_with_gap') }).toEqual({ status: 200, calls: 1, gap: true });
  });
});

describe('pre-release: output policy, served-model fallback, streaming and partial failure', () => {
  it('a blocked response is never released (non-streamed)', async () => {
    const p = await provider({ flavor: 'openai', reply: ['card ', SECRET] });
    const r = checked(await send(gateway({}, p), '/v1/chat/completions', chat(PROMPT)));
    expect({ status: r.status, released: r.released, dispatch: r.record?.dispatch, rel: r.record?.released, codes: codes(r), calls: calls(p) }).toEqual({ status: 403, released: [], dispatch: 'dispatched', rel: 'none', codes: ['DLP_PAYMENT_CARD'], calls: 1 });
  });
  it('a provider-side model fallback is re-entitled before release', async () => {
    const p = await provider({ flavor: 'openai', reply: ['ok'], serveModel: 'model-y' });
    const r = checked(await send(gateway({}, p), '/v1/chat/completions', chat(PROMPT)));
    expect({ status: r.status, released: r.released, served: r.record?.modelServed, codes: codes(r) }).toEqual({ status: 403, released: [], served: 'model-y', codes: ['SERVED_MODEL_NOT_GRANTED'] });
  });
  const stream = async (o: MockProviderOptions, policy: Partial<Policy> = {}, path = '/v1/chat/completions', body: object = chat(PROMPT, { stream: true })) => {
    const p = await provider(o);
    return checked(await send(o.flavor === 'openai' ? gateway({ bundle: conformanceBundle(policy) }, p) : gateway({ bundle: conformanceBundle(policy) }, a, p), path, body));
  };
  const shape = (r: GatewayResult) => ({ status: r.status, released: r.released, rel: r.record?.released, streamed: r.record?.streamed });
  it('streams a clean response window by window', async () => {
    expect(shape(await stream({ flavor: 'openai', reply: ['a', 'b', 'c'] }))).toEqual({ status: 200, released: ['a', 'b', 'c'], rel: 'full', streamed: true });
  });
  it('buffer_full: no chunk before a block is released', async () => {
    expect(shape(await stream({ flavor: 'openai', reply: ['a', 'b', SECRET, 'd'] }, { release: 'buffer_full' }))).toEqual({ status: 403, released: [], rel: 'none', streamed: true });
  });
  it('buffer_window: the blocked window and everything after it are withheld; LIMITATION: earlier windows were already released', async () => {
    const r = await stream({ flavor: 'openai', reply: ['a', 'b', SECRET, 'd', 'e'] });
    expect(shape(r)).toEqual({ status: 403, released: ['a', 'b'], rel: 'partial', streamed: true });
    expect(r.decisions.filter((d) => d.phase === 'stream_chunk' && d.decisionId.endsWith(':p2')).map((d) => [d.outcome, d.decisionId.split(':')[3]])).toEqual([['allow', '0'], ['block', '1']]);
  });
  it('a marker split across windows is caught by the carried overlap; LIMITATION: the first half was already released', async () => {
    expect(shape(await stream({ flavor: 'openai', reply: ['a', SECRET.slice(0, 6), SECRET.slice(6), 'd'] }))).toEqual({ status: 403, released: ['a', SECRET.slice(0, 6)], rel: 'partial', streamed: true });
  });
  it('pass_through (one-chunk windows, no buffering) is refused for an enforcing output policy; a monitor policy observes and never withholds', async () => {
    expect(validatePolicy(out('stream_chunk', 'pass_through')).ok).toBe(false);
    const r = await stream({ flavor: 'openai', reply: ['a', SECRET] }, { mode: 'monitor', release: 'pass_through' });
    expect(shape(r)).toEqual({ status: 200, released: ['a', SECRET], rel: 'full', streamed: true });
    expect(r.decisions.some((d) => d.outcome === 'block' && !d.enforced)).toBe(true);
  });
  it('anthropic stream: a card in streamed tool input is withheld', async () => {
    const r = await stream({ flavor: 'anthropic', reply: ['x', 'y'], toolArguments: [`{"q":"${SECRET}"}`] }, {}, '/v1/messages', { model: 'model-c', stream: true, messages: [{ role: 'user', content: PROMPT }] });
    expect(shape(r)).toEqual({ status: 403, released: ['x', 'y'], rel: 'partial', streamed: true });
    expect(r.decisions.flatMap((d) => d.findings.map((f) => f.location))).toEqual(['tool_arguments']);
  });
  it.each([['buffer_window', ['a', 'b'], 'partial'], ['buffer_full', [], 'none']] as const)('partial failure mid-stream (%s): released %j, recorded as %s, no usage event', async (release, released, rel) => {
    const r = await stream({ flavor: 'openai', reply: ['a', 'b', 'c', 'd'], failAfterChunks: 3 }, { release });
    expect(shape(r)).toEqual({ status: 502, released, rel, streamed: true });
    expect(r.record).toMatchObject({ dispatch: 'dispatched' });
    expect(r.record?.usageEventId).toBeUndefined();
  });
  it('a stream that ends without its terminal event is a partial failure: the pending window is withheld', async () => {
    expect(shape(await stream({ flavor: 'openai', reply: ['a', 'b', 'c'], omitTerminal: true }))).toEqual({ status: 502, released: ['a', 'b'], rel: 'partial', streamed: true });
  });
  it('an upstream error status is dispatched, never released', async () => {
    const r = await stream({ flavor: 'openai', reply: [], status: 500 });
    expect(shape(r)).toEqual({ status: 502, released: [], rel: 'none', streamed: true });
  });
  it('the default engine is the C1 library', () => expect(gateway().engine).toBe(evaluate));
});
