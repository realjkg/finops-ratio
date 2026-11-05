// Table-driven tests for the pure policy evaluation library (ADR-0001 slice C1, §3.2 steps 2-3 and 6, §3.3).
import { describe, expect, it } from 'vitest';
import { validatePolicyDecision, type PolicyCondition, type PolicyDecision } from '../contracts';
import { evaluate, failureEvaluation, type Evaluation } from './evaluate';
import { bundle, card, ctx, ent, HUMAN, input, NOW, pol, rule, ticking } from './testing/fixtures';

const view = (d: PolicyDecision) => ({ outcome: d.outcome, enforced: d.enforced, ruleIds: d.ruleIds, reasonCodes: d.reasonCodes, ...(d.failure ? { failure: d.failure, handling: d.failureHandling } : {}) });
const valid = (e: Evaluation) => { for (const d of e.decisions) expect(validatePolicyDecision(d)).toEqual({ ok: true, value: d }); return e; };
const access = (e: Evaluation) => view(e.decisions[0]);
const policyView = (e: Evaluation) => e.decisions.slice(1).map(view);

describe('decisions per rule action (pre_request, enforce)', () => {
  it('allows a clean request and records the default', () => {
    const e = valid(evaluate(input()));
    expect(e).toMatchObject({ verdict: 'allow', source: 'bundle', gap: false, problems: [] });
    expect(access(e)).toEqual({ outcome: 'allow', enforced: true, ruleIds: ['ent-wl'], reasonCodes: ['ENTITLED'] });
    expect(policyView(e)).toEqual([{ outcome: 'allow', enforced: true, ruleIds: [], reasonCodes: ['DEFAULT_ALLOW'] }]);
    expect(e.decisions.map((d) => d.decisionId)).toEqual(['dec:gw-req-1:pre_request:0:access', 'dec:gw-req-1:pre_request:0:p0']);
    expect(e.decisions[1]).toMatchObject({ controlClass: 'hard', bundleId: 'bundle-syn', bundleVersion: 4, evaluatedAt: NOW, latencyMicros: 0 });
  });
  it.each([
    ['block', 'block', 'hard'], ['redact', 'redact', 'hard'], ['require_approval', 'require_approval', 'hard'], ['allow', 'allow', 'log_only'], ['log_only', 'allow', 'log_only'],
  ] as const)('a matched %s rule yields %s (%s control)', (action, outcome, controlClass) => {
    const e = valid(evaluate(input({ bundle: bundle({ policies: [pol({ rules: [rule({ action })] })] }), context: ctx({ findings: [card()] }) })));
    expect(e.decisions[1]).toMatchObject({ outcome, controlClass, ruleIds: ['r-cards'], reasonCodes: ['DLP_PAYMENT_CARD'], findings: [card()] });
    expect(e.verdict).toBe(outcome);
  });
  it('the most severe matched rule wins over an allow exception; a default block applies when nothing acts', () => {
    const rules = [rule({ ruleId: 'r-ok', action: 'allow', condition: { kind: 'always' }, reasonCode: 'ALLOWED' }), rule(), rule({ ruleId: 'r-log', action: 'log_only', condition: { kind: 'always' }, reasonCode: 'LOGGED' })];
    expect(policyView(valid(evaluate(input({ bundle: bundle({ policies: [pol({ rules })] }), context: ctx({ findings: [card()] }) })))))
      .toEqual([{ outcome: 'block', enforced: true, ruleIds: ['r-ok', 'r-cards', 'r-log'], reasonCodes: ['ALLOWED', 'DLP_PAYMENT_CARD', 'LOGGED'] }]);
    expect(policyView(valid(evaluate(input({ bundle: bundle({ policies: [pol({ defaultAction: 'block' })] }) })))))
      .toEqual([{ outcome: 'block', enforced: true, ruleIds: [], reasonCodes: ['DEFAULT_BLOCK'] }]);
  });
});

describe('conditions', () => {
  const holds = (condition: PolicyCondition, over = {}) => evaluate(input({ bundle: bundle({ policies: [pol({ rules: [rule({ condition })] })] }), context: ctx(over) })).decisions[1].outcome === 'block';
  it.each([
    [{ kind: 'destination', providers: ['provider-a'], match: 'in' }, {}, true], [{ kind: 'destination', providers: ['provider-a'], match: 'not_in' }, {}, false],
    [{ kind: 'destination', providers: ['provider-a'], match: 'not_in' }, { destination: 'provider-a-batch' }, true],
    [{ kind: 'model', models: ['model-x'], match: 'in' }, {}, true], [{ kind: 'model', models: ['model-x'], match: 'not_in' }, {}, false],
    [{ kind: 'model', models: ['model-x'], match: 'not_in' }, { modelServed: 'model-y' }, true],
    [{ kind: 'tool', tools: ['shell'], match: 'in' }, { tools: ['search', 'shell'] }, true], [{ kind: 'tool', tools: ['shell'], match: 'in' }, {}, false],
    [{ kind: 'tool', tools: ['search'], match: 'not_in' }, { tools: ['search', 'shell'] }, true], [{ kind: 'tool', tools: ['search'], match: 'not_in' }, { tools: ['search'] }, false],
    [{ kind: 'input_bytes_over', limit: 512 }, {}, false], [{ kind: 'input_bytes_over', limit: 511 }, {}, true],
    [{ kind: 'signal', signal: 'prompt-injection', minConfidence: 'medium' }, { signals: [{ signal: 'prompt-injection', confidence: 'low' }] }, false],
    [{ kind: 'signal', signal: 'prompt-injection', minConfidence: 'medium' }, { signals: [{ signal: 'prompt-injection', confidence: 'medium' }] }, true],
    [{ kind: 'dlp_category', categories: ['payment_card'], minConfidence: 'medium' }, { findings: [card('medium')] }, true],
    [{ kind: 'dlp_category', categories: ['payment_card'], minConfidence: 'high' }, { findings: [card('medium')] }, false],
    [{ kind: 'dlp_category', categories: ['us_ssn'], minConfidence: 'low' }, { findings: [card()] }, false], [{ kind: 'always' }, {}, true],
  ] as [PolicyCondition, object, boolean][])('%j with %j holds: %s', (condition, over, expected) => expect(holds(condition, over)).toBe(expected));
});

describe('scope and effective dates', () => {
  it.each([
    ['another workload', {}, ctx({ workloadId: 'wl-other' })], ['no workload', {}, ctx({ workloadId: undefined })], ['another phase', { phase: 'pre_response', release: 'buffer_full' }, ctx()],
    ['another provider scope', { scope: { providers: ['provider-b'] } }, ctx()], ['not yet effective', { effectiveFrom: '2026-10-03' }, ctx()], ['no longer effective', { effectiveTo: '2026-10-02' }, ctx()],
  ] as const)('a policy for %s does not apply', (_n, over, context) => {
    const e = valid(evaluate(input({ bundle: bundle({ policies: [pol({ ...over, defaultAction: 'block' })] }), context })));
    expect(e.decisions).toHaveLength(1);
  });
});

describe('entitlements (cap 8): deny wins, the served model is re-checked', () => {
  const deny = ent({ entitlementId: 'ent-deny', subjectKind: 'tenant', subjectRef: 'tenant-syn', models: ['*'], effect: 'deny' });
  it.each([
    ['no grant', [], {}, { outcome: 'block', ruleIds: [], reasonCodes: ['ENTITLEMENT_NOT_GRANTED'] }],
    ['allow and deny', [ent(), deny], {}, { outcome: 'block', ruleIds: ['ent-deny'], reasonCodes: ['ENTITLEMENT_DENIED'] }],
    ['deny before allow', [deny, ent()], {}, { outcome: 'block', ruleIds: ['ent-deny'], reasonCodes: ['ENTITLEMENT_DENIED'] }],
    ['another provider', [ent({ provider: 'provider-b' })], {}, { outcome: 'block', ruleIds: [], reasonCodes: ['ENTITLEMENT_NOT_GRANTED'] }],
    ['an expired grant', [ent({ effectiveTo: '2026-10-02' })], {}, { outcome: 'block', ruleIds: [], reasonCodes: ['ENTITLEMENT_NOT_GRANTED'] }],
    ['a wildcard grant', [ent({ models: ['*'] })], {}, { outcome: 'allow', ruleIds: ['ent-wl'], reasonCodes: ['ENTITLED'] }],
    ['a tenant grant', [ent({ subjectKind: 'tenant', subjectRef: 'tenant-syn' })], {}, { outcome: 'allow', ruleIds: ['ent-wl'], reasonCodes: ['ENTITLED'] }],
    ['a team grant', [ent({ subjectKind: 'team', subjectRef: 'team-a' })], { teamIds: ['team-a'] }, { outcome: 'allow', ruleIds: ['ent-wl'], reasonCodes: ['ENTITLED'] }],
    ['a user grant', [ent({ subjectKind: 'user', subjectRef: HUMAN })], { actorType: 'human', actorRef: HUMAN }, { outcome: 'allow', ruleIds: ['ent-wl'], reasonCodes: ['ENTITLED'] }],
    ['a user grant for a service', [ent({ subjectKind: 'user', subjectRef: HUMAN })], {}, { outcome: 'block', ruleIds: [], reasonCodes: ['ENTITLEMENT_NOT_GRANTED'] }],
    ['a service grant', [ent({ subjectKind: 'service', subjectRef: 'svc:bot' })], {}, { outcome: 'allow', ruleIds: ['ent-wl'], reasonCodes: ['ENTITLED'] }],
    ['a served-model fallback', [ent()], { modelServed: 'model-y' }, { outcome: 'block', ruleIds: [], reasonCodes: ['SERVED_MODEL_NOT_GRANTED'] }],
    ['a denied served model', [ent(), ent({ entitlementId: 'ent-no-y', models: ['model-y'], effect: 'deny' })], { modelServed: 'model-y' }, { outcome: 'block', ruleIds: ['ent-no-y'], reasonCodes: ['SERVED_MODEL_DENIED'] }],
    ['an entitled fallback', [ent({ models: ['model-x', 'model-y'] })], { modelServed: 'model-y' }, { outcome: 'allow', ruleIds: ['ent-wl'], reasonCodes: ['ENTITLED'] }],
  ] as const)('%s', (_n, entitlements, over, expected) => {
    const e = valid(evaluate(input({ bundle: bundle({ entitlements: [...entitlements], policies: [] }), context: ctx(over) })));
    expect(access(e)).toEqual({ ...expected, enforced: true });
    expect(e.verdict).toBe(expected.outcome);
  });
  it('re-checks the served model before release, and records a monitor-mode violation without blocking', () => {
    const out = ctx({ phase: 'pre_response', modelServed: 'model-y' });
    expect(evaluate(input({ context: out })).verdict).toBe('block');
    const e = valid(evaluate(input({ context: out, accessMode: 'monitor' })));
    expect({ verdict: e.verdict, access: access(e) }).toEqual({ verdict: 'allow', access: { outcome: 'block', enforced: false, ruleIds: [], reasonCodes: ['SERVED_MODEL_NOT_GRANTED'] } });
  });
});

describe('monitor vs enforce', () => {
  it('a monitor decision records what enforcement would do and never changes the verdict', () => {
    const e = valid(evaluate(input({ bundle: bundle({ policies: [pol({ mode: 'monitor' })] }), context: ctx({ findings: [card()] }) })));
    expect({ verdict: e.verdict, policy: policyView(e) }).toEqual({ verdict: 'allow', policy: [{ outcome: 'block', enforced: false, ruleIds: ['r-cards'], reasonCodes: ['DLP_PAYMENT_CARD'] }] });
  });
});

describe('the failure table (ADR-0001 §3.3)', () => {
  const lenient = pol({ policyId: 'pol-log', mode: 'monitor', onTimeout: 'continue_with_gap', onEngineError: 'continue_with_gap' });
  const two = bundle({ policies: [pol(), lenient] });
  it('required DLP unavailable denies a policy with a DLP condition; entitlements unavailable deny access', () => {
    const e = valid(evaluate(input({ context: ctx({ unavailable: ['dlp'] }) })));
    expect({ verdict: e.verdict, policy: policyView(e) }).toEqual({ verdict: 'block', policy: [{ outcome: 'block', enforced: true, ruleIds: [], reasonCodes: ['DLP_UNAVAILABLE'], failure: 'dlp_unavailable', handling: 'denied' }] });
    expect(access(valid(evaluate(input({ context: ctx({ unavailable: ['entitlements'] }) }))))).toEqual({ outcome: 'block', enforced: true, ruleIds: [], reasonCodes: ['ENTITLEMENTS_UNAVAILABLE'], failure: 'entitlement_unavailable', handling: 'denied' });
  });
  it.each(['timeout', 'engine_error'] as const)('%s: enforcing policies deny; a monitor policy configured to continue does so with a visible gap', (failure) => {
    const e = valid(failureEvaluation(input({ bundle: two }), failure, 60000));
    expect(e.decisions.map((d) => [d.failure, d.failureHandling, d.outcome, d.enforced, d.latencyMicros])).toEqual([
      [failure, 'denied', 'block', true, 60000], [failure, 'denied', 'block', true, 60000], [failure, 'continued_with_gap', 'allow', false, 60000]]);
    expect({ verdict: e.verdict, gap: e.gap }).toEqual({ verdict: 'block', gap: true });
  });
  it('a policy that overran its own timeout (measured with the injected clock) is a timeout, and fails closed', () => {
    const e = valid(evaluate(input({ bundle: two, clock: { now: NOW, elapsedMicros: ticking(60000) } })));
    expect(e.decisions.map((d) => [d.failure ?? null, d.failureHandling ?? null, d.outcome, d.latencyMicros])).toEqual([
      [null, null, 'allow', 60000], ['timeout', 'denied', 'block', 60000], ['timeout', 'continued_with_gap', 'allow', 60000]]);
    expect(evaluate(input({ bundle: two, clock: { now: NOW, elapsedMicros: ticking(10) } })).verdict).toBe('allow');
  });
  it('an engine error inside evaluation (a throwing clock) fails closed', () => {
    const e = valid(evaluate(input({ bundle: two, clock: { now: NOW, elapsedMicros: () => { throw new Error('boom'); } } })));
    expect(e.decisions.map((d) => [d.failure, d.failureHandling, d.outcome])).toEqual([
      ['engine_error', 'denied', 'block'], ['engine_error', 'denied', 'block'], ['engine_error', 'continued_with_gap', 'allow']]);
    expect(e.verdict).toBe('block');
  });
  it.each([
    ['expired', { notAfter: '2026-10-02T12:00:00Z' }, 'policy_expired', 'BUNDLE_EXPIRED'], ['not yet valid', { issuedAt: '2026-10-02T12:00:01Z' }, 'policy_invalid', 'BUNDLE_NOT_YET_VALID'],
    ['of another tenant', { tenantId: 'tenant-other', policies: [], entitlements: [] }, 'policy_invalid', 'BUNDLE_TENANT_MISMATCH'],
  ] as const)('a bundle that is %s denies every decision', (_n, over, failure, code) => {
    const e = valid(evaluate(input({ bundle: bundle(over) })));
    expect({ verdict: e.verdict, source: e.source }).toEqual({ verdict: 'block', source: 'none' });
    for (const d of e.decisions) expect(view(d)).toEqual({ outcome: 'block', enforced: true, ruleIds: [], reasonCodes: [code], failure, handling: 'denied' });
  });
  it('an unreadable bundle is one enforced, denied decision under a placeholder id', () => {
    const e = valid(evaluate(input({ bundle: { ...bundle(), prompt: 'x' }, accessMode: 'monitor' })));
    expect(e.decisions.map((d) => [d.bundleId, d.mode, d.failure, d.outcome, d.reasonCodes])).toEqual([['unreadable-bundle', 'enforce', 'policy_invalid', 'block', ['BUNDLE_INVALID']]]);
    expect(e.verdict).toBe('block');
  });
});

describe('last-known-good (approved, within its own validity, same tenant)', () => {
  const expired = bundle({ version: 5, notAfter: '2026-10-02T00:00:00Z' });
  const lkg = (over = {}) => bundle({ version: 3, lastKnownGoodApproved: true, contentSha256: 'e5'.repeat(32), ...over });
  it('is used and recorded on every decision', () => {
    const e = valid(evaluate(input({ bundle: expired, lastKnownGood: lkg() })));
    expect({ verdict: e.verdict, source: e.source }).toEqual({ verdict: 'allow', source: 'last_known_good' });
    for (const d of e.decisions) expect(d).toMatchObject({ bundleVersion: 3, failure: 'policy_expired', failureHandling: 'last_known_good', lastKnownGood: { contentSha256: 'e5'.repeat(32), reason: 'policy_expired' } });
  });
  it.each([['not approved', { lastKnownGoodApproved: false }], ['itself expired', { notAfter: '2026-10-02T11:00:00Z' }], ['of another tenant', { tenantId: 'tenant-other', policies: [], entitlements: [] }]])(
    'is refused when %s', (_n, over) => {
      const e = valid(evaluate(input({ bundle: expired, lastKnownGood: lkg(over) })));
      expect({ verdict: e.verdict, source: e.source }).toEqual({ verdict: 'block', source: 'none' });
      expect(e.decisions[0].reasonCodes).toEqual(['BUNDLE_EXPIRED', 'LAST_KNOWN_GOOD_REFUSED']);
    });
  it('is never used for a valid bundle', () => expect(evaluate(input({ lastKnownGood: lkg() })).source).toBe('bundle'));
});

describe('input refusal, no content', () => {
  it.each([
    ['a content key', { context: { ...ctx(), prompt: 'SYNTHETIC-SECRET-TEXT' } }], ['a bad clock', { clock: { now: '2026-10-02 12:00' } }],
    ['an email as actor', { context: ctx({ actorType: 'human', actorRef: 'jane@corp.example' }) }], ['a bad finding', { context: ctx({ findings: [{ ...card(), matched: 'SYNTHETIC-SECRET-TEXT' }] as never }) }],
  ])('refuses %s: block, no decision, no echoed value', (_n, over) => {
    const e = evaluate(input(over as never));
    expect({ verdict: e.verdict, decisions: e.decisions, refused: e.problems.length > 0 }).toEqual({ verdict: 'block', decisions: [], refused: true });
    expect(JSON.stringify(e)).not.toMatch(/SYNTHETIC-SECRET-TEXT|jane@/);
  });
});
