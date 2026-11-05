// Regression tests from challenger review round 1 of #183 (reviewer probes c1probe.test.ts P1, P2, P4, P5, P6, P7, P9;
// mutations M12, M19, M20, M21). SYNTHETIC fixtures only.
import { describe, expect, it } from 'vitest';
import { validatePolicyDecision, type PolicyDecision } from '../contracts';
import { compileBundle, evaluate, failureEvaluation, sealEvaluation, type Evaluation } from './index';
import { bundle, card, ctx, ent, input, NOW, pol, rule } from './testing/fixtures';

const valid = (e: Evaluation) => { for (const d of e.decisions) expect(validatePolicyDecision(d).ok).toBe(true); return e; };
const access = (e: Evaluation) => [e.decisions[0].outcome, e.decisions[0].ruleIds.join('+'), e.decisions[0].reasonCodes.join('+')];
const brief = (d: PolicyDecision) => [d.mode, d.enforced, d.outcome, d.failure ?? '-', d.failureHandling ?? '-', d.reasonCodes.join('+')];

describe('M1: a deny names a model family (id, @revision and separator-extended ids, case-folded); grants stay exact', () => {
  const b = bundle({ policies: [], entitlements: [ent({ models: ['*'] }), ent({ entitlementId: 'ent-deny', models: ['model-x'], effect: 'deny' })] });
  it.each(['model-x', 'model-x@20261001', 'model-x-2026-10-01', 'MODEL-X', 'Model-X.v2', 'model-x:ft'])('deny model-x blocks %s', (m) => {
    expect(access(valid(evaluate(input({ bundle: b, context: ctx({ modelRequested: m }) }))))).toEqual(['block', 'ent-deny', 'ENTITLEMENT_DENIED']);
  });
  it('re-checks a dated served id against the family deny before release', () => {
    expect(access(evaluate(input({ bundle: b, context: ctx({ phase: 'pre_response', modelRequested: 'model-y', modelServed: 'model-x-2026-10-01' }) })))).toEqual(['block', 'ent-deny', 'SERVED_MODEL_DENIED']);
  });
  it('does not deny another model that only shares a prefix, and grants stay exact', () => {
    expect(access(evaluate(input({ bundle: b, context: ctx({ modelRequested: 'model-xl' }) })))[0]).toBe('allow');
    const exact = bundle({ policies: [], entitlements: [ent({ models: ['model-x'] })] });
    for (const m of ['model-x@20261001', 'model-x-2026-10-01', 'MODEL-X']) expect(access(evaluate(input({ bundle: exact, context: ctx({ modelRequested: m }) })))).toEqual(['block', '', 'ENTITLEMENT_NOT_GRANTED']);
  });
});

describe('M2 / L7: every verdict has a decision record; monitor records and allows, enforce blocks', () => {
  const mon = bundle({ policies: [pol({ mode: 'monitor' })] });
  const throwing = Object.defineProperty({ ...ctx() }, 'workloadId', { get() { throw new Error('getter'); }, enumerable: true });
  const proxy = new Proxy({}, { get() { throw new Error('proxy'); } });
  it.each([
    ['duplicate tools', ctx({ tools: ['search', 'search'] })], ['257 teams', ctx({ teamIds: Array.from({ length: 257 }, (_, i) => `t${i}`) })],
    ['1001 findings', ctx({ findings: Array.from({ length: 1001 }, () => card()) })], ['a 129-character requestRef', ctx({ requestRef: 'r'.repeat(129) })],
    ['a symbol key', { ...ctx(), [Symbol('s')]: 'SYNTHETIC-SECRET' }], ['a throwing getter', throwing], ['a proxy', proxy], ['null', null],
  ])('a refused context (%s) is recorded as a denied engine_error with CONTEXT_INVALID', (_n, context) => {
    for (const accessMode of ['enforce', 'monitor'] as const) {
      const e = valid(evaluate(input({ bundle: mon, context: context as never, accessMode })));
      expect({ verdict: e.verdict, problems: e.problems.length > 0, d: e.decisions.map(brief) })
        .toEqual({ verdict: accessMode === 'enforce' ? 'block' : 'allow', problems: true, d: [[accessMode, accessMode === 'enforce', 'block', 'engine_error', 'denied', 'CONTEXT_INVALID']] });
      expect(JSON.stringify(e)).not.toContain('SYNTHETIC-SECRET');
    }
  });
  it('a missing model is MODEL_UNKNOWN: blocked in enforce, recorded and allowed in monitor; a not_in model rule holds', () => {
    const c = ctx({ modelRequested: undefined });
    expect(access(valid(evaluate(input({ context: c }))))).toEqual(['block', '', 'MODEL_UNKNOWN']);
    expect(evaluate(input({ context: c, accessMode: 'monitor' })).verdict).toBe('allow');
    const notIn = bundle({ policies: [pol({ rules: [rule({ condition: { kind: 'model', models: ['model-x'], match: 'not_in' } })] })] });
    expect(evaluate(input({ bundle: notIn, context: c, accessMode: 'monitor' })).decisions[1].outcome).toBe('block');
  });
  it('an unreadable bundle and a failed evaluation follow the access mode (monitor never enforces)', () => {
    for (const r of [evaluate(input({ accessMode: 'monitor', bundle: null })), failureEvaluation(input({ accessMode: 'monitor', bundle: null }), 'timeout')]) {
      expect({ verdict: r.verdict, d: valid(r).decisions.map(brief)[0].slice(0, 5) }).toEqual({ verdict: 'allow', d: ['monitor', false, 'block', 'policy_invalid', 'denied'] });
    }
    expect(failureEvaluation(input({ accessMode: 'monitor' }), 'engine_error').decisions.map(brief)[0]).toEqual(['monitor', false, 'block', 'engine_error', 'denied', 'ENGINE_ERROR']);
  });
  it('a clock that throws is recorded under the epoch with CLOCK_INVALID, and blocks in enforce', () => {
    const clock = Object.defineProperty({}, 'now', { get() { throw new Error('clock'); } });
    const e = valid(evaluate(input({ clock: clock as never })));
    expect({ verdict: e.verdict, at: e.decisions[0].evaluatedAt, codes: e.decisions[0].reasonCodes }).toEqual({ verdict: 'block', at: '1970-01-01T00:00:00Z', codes: ['CONTEXT_INVALID', 'CLOCK_INVALID'] });
  });
});

describe('L1 supersession, L2 the log-only DLP exception, L3 mutation gaps', () => {
  it('only the highest version of an entitlement or policy id is evaluated', () => {
    const b = bundle({ policies: [], entitlements: [ent({ version: 1, models: ['*'] }), ent({ version: 2, models: ['model-x'] })] });
    expect(access(evaluate(input({ bundle: b, context: ctx({ modelRequested: 'model-y' }) })))).toEqual(['block', '', 'ENTITLEMENT_NOT_GRANTED']);
    const p = bundle({ policies: [pol({ version: 1, defaultAction: 'block' }), pol({ version: 2, defaultAction: 'allow' })] });
    expect(evaluate(input({ bundle: p })).decisions.map((d) => [d.decisionId.split(':').pop(), d.outcome])).toEqual([['access', 'allow'], ['p1', 'allow']]);
  });
  it('kept contract behavior: a log-only DLP policy with DLP unavailable denies in enforce mode (failure-table@1)', () => {
    const lo = pol({ rules: [rule({ action: 'log_only' })], onTimeout: 'continue_with_gap', onEngineError: 'continue_with_gap' });
    expect(evaluate(input({ bundle: bundle({ policies: [lo] }), context: ctx({ unavailable: ['dlp'] }) })).decisions[1].outcome).toBe('block');
  });
  it('a team grant matches only the listed team (M12)', () => {
    const t = bundle({ policies: [], entitlements: [ent({ subjectKind: 'team', subjectRef: 'team-a' })] });
    expect(access(evaluate(input({ bundle: t, context: ctx({ teamIds: ['team-b'] }) })))[0]).toBe('block');
  });
  it('a dropped (contract-invalid) decision fails the evaluation closed (M20)', () => {
    const good = evaluate(input()).decisions;
    const e = sealEvaluation('bundle', [...good, { ...good[0], enforced: false }]);
    expect({ verdict: e.verdict, n: e.decisions.length, problems: e.problems }).toEqual({ verdict: 'block', n: 2, problems: ['$.decisions: a decision failed policy-decision/1 (dropped)'] });
  });
});

describe('L4 compiled bundles, L5 one read of the input, P7 hostile inputs', () => {
  it('a compiled bundle gives the same result as the raw one; a look-alike object is not trusted as compiled', () => {
    const compiled = compileBundle(bundle());
    expect(compiled).not.toBeNull();
    expect(evaluate(input({ bundle: compiled }))).toEqual(evaluate(input()));
    expect(evaluate(input({ bundle: { ...compiled } })).decisions[0].reasonCodes).toEqual(['BUNDLE_INVALID']);
    expect(compileBundle({ ...bundle(), prompt: 'x' })).toBeNull();
  });
  it('reads each input getter once (a strict copy is validated and evaluated)', () => {
    let reads = 0;
    const c = Object.defineProperty({ ...ctx() }, 'modelRequested', { get() { reads++; return reads === 1 ? 'model-x' : 'model-z'; }, enumerable: true });
    expect(evaluate(input({ context: c as never })).verdict).toBe('allow');
    expect(reads).toBe(1);
  });
  it('hostile inputs never throw, never allow in enforce mode, and always record a decision', () => {
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    const proxy = new Proxy({}, { get() { throw new Error('proxy'); }, ownKeys() { throw new Error('keys'); } });
    const cases = [undefined, 42, proxy, { ...input(), context: proxy }, { ...input(), bundle: proxy }, { ...input(), clock: proxy }, { ...input(), context: { ...ctx(), teamIds: [cyc] } },
      { ...input(), context: { ...ctx(), teamIds: [BigInt(10)] } }, { ...input(), context: { ...ctx(), inputBytes: NaN } }, { ...input(), clock: { now: NOW, elapsedMicros: () => NaN } },
      { ...input(), bundle: { ...bundle(), policies: [cyc] } }, { ...input({ bundle: bundle({ notAfter: '2026-10-02T00:00:00Z' }) }), lastKnownGood: proxy }];
    for (const c of cases) for (const e of [evaluate(c as never), failureEvaluation(c as never, 'timeout')]) {
      expect(e.verdict).toBe('block');
      expect(valid(e).decisions.length).toBeGreaterThan(0);
    }
  });
  it('P9: at the contract maxima a compiled bundle evaluates within a bounded time (recorded in green.txt)', () => {
    const models = Array.from({ length: 256 }, (_, i) => `model-${i}`);
    const dlp = rule({ condition: { kind: 'dlp_category', categories: ['payment_card', 'email', 'phone', 'iban', 'us_ssn', 'api_key', 'custom', 'private_key', 'cloud_credential'], minConfidence: 'low' }, action: 'log_only' });
    const rules = Array.from({ length: 512 }, (_, i) => ({ ...dlp, ruleId: `r${i}` }));
    const b = bundle({ policies: Array.from({ length: 256 }, (_, i) => pol({ policyId: `p${i}`, rules, mode: 'monitor', onTimeout: 'continue_with_gap', onEngineError: 'continue_with_gap' })),
      entitlements: Array.from({ length: 4096 }, (_, i) => ent({ entitlementId: `e${i}`, models, subjectKind: 'team', subjectRef: `team-${i % 256}` })) });
    const c = ctx({ teamIds: Array.from({ length: 256 }, (_, i) => `team-${i}`), findings: Array.from({ length: 1000 }, (_, i) => ({ ...card(), start: i, end: i + 16 })), modelRequested: 'model-255', modelServed: 'model-254' });
    const t0 = process.hrtime.bigint();
    const compiled = compileBundle(b);
    const t1 = process.hrtime.bigint();
    const e = evaluate(input({ bundle: compiled, context: c, accessMode: 'monitor' }));
    const t2 = process.hrtime.bigint();
    console.log(`P9 contract maxima: compile ${Number(t1 - t0) / 1e6} ms, evaluate ${Number(t2 - t1) / 1e6} ms, ${e.decisions.length} decisions`);
    expect({ n: e.decisions.length, problems: e.problems }).toEqual({ n: 257, problems: [] });
    expect(Number(t2 - t1) / 1e6).toBeLessThan(5000);
  }, 60000);
});
