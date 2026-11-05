// Regression tests from challenger review round 2 of #183 (probes c1probe-r2 R1-R7; mutations M40, M41, M43).
import { describe, expect, it } from 'vitest';
import { validatePolicyDecision, type PolicyDecision } from '../contracts';
import { accessModeFor, compileBundle, evaluate, unnamespacedTools, type Evaluation } from './index';
import { bundle, card, ctx, ent, FLAGS, input, pol, rule } from './testing/fixtures';

const valid = (e: Evaluation) => { for (const d of e.decisions) expect(validatePolicyDecision(d).ok).toBe(true); return e; };
const brief = (d: PolicyDecision) => [d.mode, d.enforced, d.outcome, d.failure ?? '-', d.reasonCodes.join('+')];
const access = (e: Evaluation) => e.decisions[0].reasonCodes.join('+');
describe('M1: per id, the highest version EFFECTIVE at now is evaluated', () => {
  const at = (now: string) => ({ clock: { now } });
  it.each([['2026-10-02T12:00:00Z', 'ENTITLEMENT_DENIED'], ['2026-11-30T23:59:59.999Z', 'ENTITLEMENT_DENIED'], ['2026-12-01T00:00:00Z', 'ENTITLEMENT_DENIED']])('deny v1 now, v2 from Dec 1 (%s): model-z %s', (now, code) => {
    const b = bundle({ policies: [], notAfter: '2026-12-08T00:00:00Z', entitlements: [ent({ models: ['*'] }), ent({ entitlementId: 'ent-deny', models: ['model-z'], effect: 'deny' }), ent({ entitlementId: 'ent-deny', version: 2, models: ['model-z', 'model-q'], effect: 'deny', effectiveFrom: '2026-12-01' })] });
    expect(access(evaluate(input({ bundle: b, context: ctx({ modelRequested: 'model-z' }), ...at(now) })))).toBe(code);
    expect(access(evaluate(input({ bundle: b, context: ctx({ modelRequested: 'model-q' }), ...at(now) })))).toBe(now >= '2026-12-01' ? 'ENTITLEMENT_DENIED' : 'ENTITLED');
  });
  it('a future DLP policy version does not remove the current one; a future grant does not cause an outage', () => {
    expect(evaluate(input({ bundle: bundle({ policies: [pol({ version: 1 }), pol({ version: 2, effectiveFrom: '2026-12-01' })] }), context: ctx({ findings: [card()] }) })).verdict).toBe('block');
    expect(access(evaluate(input({ bundle: bundle({ policies: [], entitlements: [ent({ version: 1 }), ent({ version: 2, models: ['model-x', 'model-y'], effectiveFrom: '2026-12-01' })] }) })))).toBe('ENTITLED');
  });
});
describe('M2: a refusal is at least as strict as the normal path', () => {
  const enforceDlp = bundle({ policies: [pol()] });
  const many = Array.from({ length: 1001 }, (_, i) => ({ ...card(), start: i * 20, end: i * 20 + 16 }));
  it.each([['1001 findings', ctx({ findings: many })], ['1 card + 257 tools', ctx({ findings: [card()], tools: Array.from({ length: 257 }, (_, i) => `t${i}`) })], ['257 teams', ctx({ teamIds: Array.from({ length: 257 }, (_, i) => `t${i}`) })]])(
    'monitor access + an enforce-mode policy for the phase: %s blocks, recorded CONTEXT_INVALID', (_n, context) => {
      expect(evaluate(input({ bundle: enforceDlp, accessMode: 'monitor', context: ctx({ findings: [card()] }) })).verdict).toBe('block');
      const e = valid(evaluate(input({ bundle: enforceDlp, accessMode: 'monitor', context })));
      expect({ verdict: e.verdict, d: e.decisions.map(brief) }).toEqual({ verdict: 'block', d: [['enforce', true, 'block', 'engine_error', 'CONTEXT_INVALID']] });
    });
  it('only when every applicable policy is monitor (or none applies) does a monitor refusal record and allow', () => {
    expect(evaluate(input({ bundle: bundle({ policies: [pol({ mode: 'monitor' })] }), accessMode: 'monitor', context: ctx({ findings: many }) })).verdict).toBe('allow');
    expect(evaluate(input({ bundle: bundle({ policies: [pol({ phase: 'pre_response', release: 'buffer_full' })] }), accessMode: 'monitor', context: ctx({ findings: many }) })).verdict).toBe('allow');
    expect(evaluate(input({ bundle: bundle({ policies: [pol({ phase: 'pre_response', release: 'buffer_full' })] }), accessMode: 'monitor', context: { ...ctx(), phase: 'bogus' } as never })).verdict).toBe('block');
  });
});
describe('L1/L2 + round 3 M1: flags must be valid D7 flags (parsePlatformBlock); only valid off flags without a contrary assertion are a recorded allow', () => {
  const run = (over: object, c = ctx({ modelRequested: 'model-z', findings: [card()] })) => valid(evaluate({ ...input({ context: c }), ...over } as never));
  it.each([[{}], [{ enabled: true }], [{ enabled: false }], [{ enabled: true, policyMonitor: false, enforcement: false }]])('valid off flags %j: one recorded POLICY_DISABLED allow', (flags) => {
    const e = run({ flags });
    expect({ verdict: e.verdict, d: e.decisions.map(brief) }).toEqual({ verdict: 'allow', d: [['monitor', false, 'allow', '-', 'POLICY_DISABLED']] });
  });
  it.each([[{ enabled: true, enforce: true }], [{ enabled: 1, enforcement: 1 }], [{ enabled: true, enforcement: 'true' }], [{ enabled: false, enforcement: true }], [Object.create({ enabled: true, enforcement: true })], ['on'], [null], [undefined]])(
    'junk flags %j are refused and block (never POLICY_DISABLED)', (flags) => expect([run({ flags }).verdict, access(run({ flags }))]).toEqual(['block', 'CONTEXT_INVALID']));
  it('an asserted accessMode that disagrees with the flags (also with off flags) is refused; off flags with an invalid context are refused', () => {
    expect([accessModeFor(FLAGS.enforce), accessModeFor(FLAGS.monitor), accessModeFor(Object.create(FLAGS.enforce))]).toEqual(['enforce', 'monitor', 'off']);
    for (const over of [{ accessMode: 'monitor' }, { flags: {}, accessMode: 'enforce' }, { flags: { enabled: true }, accessMode: 'monitor' }]) expect([run(over).verdict, access(run(over))]).toEqual(['block', 'CONTEXT_INVALID']);
    expect([run({ flags: {} }, { ...ctx(), prompt: 'x' } as never).verdict, access(run({ flags: {} }, { ...ctx(), prompt: 'x' } as never))]).toEqual(['block', 'CONTEXT_INVALID']);
  });
});
describe('L3 families, L4 placeholders, L5 compile', () => {
  const b = (deny: string) => bundle({ policies: [], entitlements: [ent({ models: ['*'] }), ent({ entitlementId: 'ent-deny', models: [deny], effect: 'deny' })] });
  it.each([['gpt-4', 'openai/gpt-4', true], ['gpt-4', 'models/gpt-4', true], ['gpt-4', 'ft:gpt-4:org::abc', true], ['gpt-4', 'ft:gpt-4-turbo:org::abc', true], ['gpt-4-', 'gpt-4-turbo', true],
    ['gpt-4', 'gpt-4.1', true], ['gpt-4', 'gpt-4o', false], ['gpt-4', 'gpt-40', false], ['gpt-4', 'openai/gpt-4o', false]])('deny %s vs %s: denied %s', (deny, model, denied) => {
    expect(access(evaluate(input({ bundle: b(deny), context: ctx({ modelRequested: model }) })))).toBe(denied ? 'ENTITLEMENT_DENIED' : 'ENTITLED');
  });
  it('refusal placeholders cannot be forged: the reserved refused: prefix is refused in contexts and bundles', () => {
    const e = valid(evaluate(input({ context: { ...ctx({ tenantId: 'jane@corp.example', requestRef: 'r'.repeat(129) }) } })));
    expect([e.decisions[0].tenantId, e.decisions[0].requestRef]).toEqual(['refused:unknown-tenant', 'refused:unknown-request']);
    expect(JSON.stringify(e)).not.toContain('jane');
    expect(access(evaluate(input({ context: ctx({ tenantId: 'refused:unknown-tenant' }) })))).toBe('CONTEXT_INVALID');
    expect(access(evaluate(input({ context: ctx({ requestRef: 'refused:unknown-request' }) })))).toBe('CONTEXT_INVALID');
    expect(compileBundle(bundle({ bundleId: 'refused:unreadable-bundle' }))).toBeNull();
  });
  it('a refusal also weighs the last-known-good (M32b) and never copies a refused: tenant into its record (M43)', () => {
    const lkg = bundle({ version: 2, lastKnownGoodApproved: true, policies: [pol()] }), refusedCtx = ctx({ findings: Array.from({ length: 1001 }, () => card()) });
    expect(evaluate(input({ bundle: bundle({ policies: [pol({ mode: 'monitor' })] }), lastKnownGood: lkg, accessMode: 'monitor', context: refusedCtx })).verdict).toBe('block');
    expect(evaluate(input({ context: ctx({ tenantId: 'refused:evil' }) })).decisions[0].tenantId).toBe('refused:unknown-tenant');
  });
  it('a compiled bundle is frozen and independent of the raw input, which stays mutable', () => {
    const raw = bundle({ policies: [], entitlements: [ent({ models: ['model-x'] })] });
    const c = compileBundle(raw) as NonNullable<ReturnType<typeof compileBundle>>;
    expect(() => (c.entitlements as unknown[]).push(ent({ models: ['*'] }))).toThrow(TypeError);
    expect(() => ((c.bundle.entitlements[0].models as string[]).push('model-z'))).toThrow(TypeError);
    raw.entitlements[0].models.push('model-z');
    expect(access(evaluate(input({ bundle: c, context: ctx({ modelRequested: 'model-z' }) })))).toBe('ENTITLEMENT_NOT_GRANTED');
  });
});
describe('#184 round 4: unidentified tools are never listable or allowed; unnamespaced tool ids are reported', () => {
  const tools = (ids: string[], match: 'in' | 'not_in' = 'not_in') => bundle({ policies: [pol({ rules: [rule({ condition: { kind: 'tool', tools: ids, match }, reasonCode: 'TOOL_NOT_ALLOWED' })] })] });
  it('a bundle naming an unidentified: tool is refused (L2)', () => expect([compileBundle(tools(['fn:a', 'unidentified:gw-req-1'])), compileBundle(tools(['fn:a'])) === null]).toEqual([null, false]));
  it.each([['enforce', 'block', true], ['monitor', 'allow', false]] as const)('an unidentified tool is refused by the access decision (%s: %s)', (accessMode, verdict, enforced) => {
    const e = valid(evaluate(input({ accessMode, bundle: bundle({ policies: [] }), context: ctx({ tools: ['fn:search', 'unidentified:gw-req-1'] }) })));
    expect([e.verdict, brief(e.decisions[0])]).toEqual([verdict, [accessMode, enforced, 'block', '-', 'TOOL_UNIDENTIFIED']]);
  });
  it('unnamespacedTools lists tool ids that never match a gateway identity (L1, advisory)', () => {
    expect(unnamespacedTools(compileBundle(tools(['shell', 'fn:search', 'mcp:wiki', 'type:web_search', 'fn-h:0123456789abcdef', 'mcp_x'], 'in'))!)).toEqual(['shell', 'mcp_x']);
  });
});
