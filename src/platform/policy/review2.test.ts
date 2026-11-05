// Regression tests from challenger review round 2 of #183 (probes c1probe-r2 R1-R7; mutations M40, M41, M43).
import { describe, expect, it } from 'vitest';
import { validatePolicyDecision, type PolicyDecision } from '../contracts';
import { accessModeFor, compileBundle, evaluate, type Evaluation } from './index';
import { bundle, card, ctx, ent, FLAGS, input, pol } from './testing/fixtures';

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
    expect(evaluate(input({ bundle: enforceDlp, accessMode: 'monitor', context: { ...ctx({ findings: many }), phase: 'bogus' } as never })).verdict).toBe('block');
  });
});

describe('L1/L2: flags are required and bound through capabilityOn; off is a recorded allow', () => {
  it('off flags never block: one recorded POLICY_DISABLED allow, nothing enforced', () => {
    for (const flags of [{}, { enabled: true }, { enabled: false, enforcement: true }, { enabled: true, enforcement: 'true' }, Object.create({ enabled: true, enforcement: true })]) {
      expect(accessModeFor(flags as never)).toBe('off');
      const e = valid(evaluate({ ...input({ context: ctx({ modelRequested: 'model-z', findings: [card()] }) }), flags: flags as never }));
      expect({ verdict: e.verdict, d: e.decisions.map(brief) }).toEqual({ verdict: 'allow', d: [['monitor', false, 'allow', '-', 'POLICY_DISABLED']] });
    }
  });
  it('a flags/accessMode mismatch or junk flags are refused (enforce with this bundle); enforcement wins over monitor', () => {
    expect([accessModeFor(FLAGS.enforce), accessModeFor(FLAGS.monitor)]).toEqual(['enforce', 'monitor']);
    for (const over of [{ accessMode: 'monitor' as const }, { flags: 'on' as never }, { flags: null as never }]) {
      expect(access(valid(evaluate({ ...input(), ...over })))).toBe('CONTEXT_INVALID');
    }
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
  it('a compiled bundle is frozen and independent of the raw input, which stays mutable', () => {
    const raw = bundle({ policies: [], entitlements: [ent({ models: ['model-x'] })] });
    const c = compileBundle(raw);
    if (!c) throw new Error('compile');
    expect(() => (c.entitlements as unknown[]).push(ent({ models: ['*'] }))).toThrow(TypeError);
    expect(() => ((c.bundle.entitlements[0].models as string[]).push('model-z'))).toThrow(TypeError);
    raw.entitlements[0].models.push('model-z');
    expect(access(evaluate(input({ bundle: c, context: ctx({ modelRequested: 'model-z' }) })))).toBe('ENTITLEMENT_NOT_GRANTED');
  });
});
