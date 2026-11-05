// Property-style tests for the policy evaluation library (ADR-0001 slice C1): randomized SYNTHETIC bundles and
// request contexts from a SEEDED generator (mulberry32), so every run checks the same cases and a failure names its
// seed. Properties: determinism, contract validity of every decision, deny wins, never allow on error in enforce
// mode, monitor never enforced, the verdict is the worst enforced outcome, and inputs are never mutated.
import { describe, expect, it } from 'vitest';
import { validatePolicyBundle, validatePolicyDecision, type DlpFinding, type Entitlement, type Policy, type PolicyCondition, type PolicyDecision, type PolicyRule } from '../contracts';
import { evaluate, failureEvaluation, type EvaluationInput } from './evaluate';
import type { RequestContext } from './context';
import { bundle, ctx, ent, HUMAN, NOW, pol, ticking } from './testing/fixtures';

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
type R = () => number;
const pick = <T,>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const some = <T,>(r: R, xs: readonly T[], min = 0): T[] => { const out = xs.filter(() => r() < 0.5); return out.length >= min ? out : xs.slice(0, min); };
const chance = (r: R, p: number) => r() < p;

const MODELS = ['model-x', 'model-y', 'model-z'] as const;
const PROVIDERS = ['provider-a', 'provider-b'] as const;
const WORKLOADS = ['wl-bot', 'wl-etl'] as const;
const TOOLS = ['search', 'shell'] as const;
const CONF = ['low', 'medium', 'high'] as const;
const ACTIONS = ['allow', 'block', 'redact', 'require_approval', 'log_only'] as const;
const SEVERITY = { allow: 0, redact: 1, require_approval: 2, block: 3 } as const;

function condition(r: R): PolicyCondition {
  switch (pick(r, ['always', 'dlp', 'destination', 'model', 'tool', 'bytes', 'signal'] as const)) {
    case 'always': return { kind: 'always' };
    case 'dlp': return { kind: 'dlp_category', categories: some(r, ['payment_card', 'us_ssn'] as const, 1), minConfidence: pick(r, CONF) };
    case 'destination': return { kind: 'destination', providers: some(r, PROVIDERS, 1), match: pick(r, ['in', 'not_in'] as const) };
    case 'model': return { kind: 'model', models: some(r, MODELS, 1), match: pick(r, ['in', 'not_in'] as const) };
    case 'tool': return { kind: 'tool', tools: some(r, TOOLS, 1), match: pick(r, ['in', 'not_in'] as const) };
    case 'bytes': return { kind: 'input_bytes_over', limit: 1 + Math.floor(r() * 2000) };
    case 'signal': return { kind: 'signal', signal: 'prompt-injection', minConfidence: pick(r, CONF) };
  }
}
function policy(r: R, i: number): Policy {
  const rules: PolicyRule[] = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, j) => ({ ruleId: `r${j}`, condition: condition(r), action: pick(r, ACTIONS), reasonCode: `REASON_${j}` }));
  const mode = pick(r, ['monitor', 'enforce'] as const);
  const defaultAction = pick(r, ['allow', 'block'] as const);
  const hard = defaultAction === 'block' || rules.some((x) => ['block', 'redact', 'require_approval'].includes(x.action));
  const phase = pick(r, ['pre_request', 'pre_response', 'stream_chunk'] as const);
  const strict = mode === 'enforce' && hard;
  const fail = () => (strict ? 'deny' : pick(r, ['deny', 'continue_with_gap'] as const));
  const release: Policy['release'] = phase === 'pre_request' ? undefined : strict ? pick(r, ['buffer_full', 'buffer_window'] as const) : pick(r, ['buffer_full', 'buffer_window', 'pass_through', undefined] as const);
  const scope = { ...(chance(r, 0.4) ? { workloadIds: some(r, WORKLOADS, 1) } : {}), ...(chance(r, 0.3) ? { providers: some(r, PROVIDERS, 1) } : {}) };
  return pol({ policyId: `pol-${i}`, scope, phase, mode, rules, defaultAction, evaluationTimeoutMs: 1 + Math.floor(r() * 100), onTimeout: fail(), onEngineError: fail(), ...(release ? { release } : {}) });
}
function entitlement(r: R, i: number): Entitlement {
  const kind = pick(r, ['tenant', 'team', 'user', 'workload', 'service'] as const);
  const subjectRef = { tenant: 'tenant-syn', team: 'team-a', user: HUMAN, workload: pick(r, WORKLOADS), service: 'svc:bot' }[kind];
  return ent({ entitlementId: `ent-${i}`, subjectKind: kind, subjectRef, provider: pick(r, PROVIDERS), models: chance(r, 0.2) ? ['*'] : some(r, MODELS, 1), effect: chance(r, 0.3) ? 'deny' : 'allow', ...(chance(r, 0.1) ? { effectiveTo: '2026-10-02' } : {}) });
}
const finding = (r: R): DlpFinding => ({ category: pick(r, ['payment_card', 'us_ssn', 'email'] as const), detectorId: 'det', detectorVersion: 1, confidence: pick(r, CONF), location: 'input', start: 0, end: 1 + Math.floor(r() * 30), normalization: [] });
function context(r: R): RequestContext {
  const human = chance(r, 0.3);
  return ctx({
    phase: pick(r, ['pre_request', 'pre_response', 'stream_chunk'] as const), workloadId: pick(r, [...WORKLOADS, undefined]), teamIds: chance(r, 0.5) ? ['team-a'] : undefined,
    actorType: human ? 'human' : 'service', actorRef: human ? HUMAN : 'svc:bot', provider: pick(r, PROVIDERS), destination: pick(r, PROVIDERS), modelRequested: pick(r, MODELS),
    modelServed: pick(r, [...MODELS, undefined]), tools: chance(r, 0.5) ? some(r, TOOLS) : undefined, inputBytes: Math.floor(r() * 2500),
    findings: Array.from({ length: Math.floor(r() * 3) }, () => finding(r)), signals: chance(r, 0.3) ? [{ signal: 'prompt-injection', confidence: pick(r, CONF) }] : undefined,
    unavailable: chance(r, 0.15) ? some(r, ['entitlements', 'dlp'] as const, 1) : undefined, sequence: Math.floor(r() * 3),
  });
}
type ClockSpec = 'none' | 'throws' | number;
const clockOf = (s: ClockSpec) => ({ now: NOW, ...(s === 'none' ? {} : { elapsedMicros: s === 'throws' ? () => { throw new Error('clock'); } : ticking(s) }) });
function scenario(seed: number) {
  const r = rng(seed);
  const b = bundle({ policies: Array.from({ length: Math.floor(r() * 4) }, (_, i) => policy(r, i)), entitlements: Array.from({ length: Math.floor(r() * 5) }, (_, i) => entitlement(r, i)),
    ...(chance(r, 0.15) ? { notAfter: NOW } : {}), ...(chance(r, 0.05) ? { tenantId: 'tenant-other', policies: [], entitlements: [] } : {}) });
  const lastKnownGood = chance(r, 0.3) ? { ...b, version: 2, notAfter: '2026-10-08T00:00:00Z', tenantId: 'tenant-syn', lastKnownGoodApproved: chance(r, 0.6) } : undefined;
  const clock: ClockSpec = pick(r, ['none', 'none', 'throws', 1, 30000, 200000] as const);
  const make = (): EvaluationInput => structuredClone({ bundle: b, ...(lastKnownGood ? { lastKnownGood } : {}), context: context(rng(seed + 1)), clock: { now: NOW }, accessMode: pick(rng(seed + 2), ['monitor', 'enforce'] as const) });
  return { b, lastKnownGood, make: () => ({ ...make(), clock: clockOf(clock) }), clock };
}
const deepFreeze = <T,>(x: T): T => { if (x && typeof x === 'object') { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; };
const SEEDS = Array.from({ length: 400 }, (_, i) => 1000 + i * 7919);

/** Independent oracle for deny-wins on the requested model (subject, provider, model and date matching). */
function deniedByOracle(i: EvaluationInput): boolean {
  const c = i.context as RequestContext;
  const subject = (e: Entitlement) => ({ tenant: e.subjectRef === c.tenantId, team: (c.teamIds ?? []).includes(e.subjectRef), user: c.actorType === 'human' && c.actorRef === e.subjectRef,
    workload: c.workloadId === e.subjectRef, service: c.actorType === 'service' && c.actorRef === e.subjectRef })[e.subjectKind];
  return (i.bundle as { entitlements: Entitlement[] }).entitlements.some((e) => e.effect === 'deny' && e.provider === c.provider && (e.models.includes('*') || e.models.includes(c.modelRequested))
    && e.effectiveFrom <= NOW.slice(0, 10) && (e.effectiveTo === undefined || NOW.slice(0, 10) < e.effectiveTo) && subject(e));
}
const worst = (ds: PolicyDecision[]) => ds.filter((d) => d.enforced).reduce<keyof typeof SEVERITY>((a, d) => (SEVERITY[d.outcome] > SEVERITY[a] ? d.outcome : a), 'allow');

describe('policy evaluation properties over 400 seeded random scenarios', () => {
  it('the generator only produces contract-valid bundles (so the properties below are not vacuous)', () => {
    for (const s of SEEDS) expect(validatePolicyBundle(scenario(s).b).ok, `seed ${s}`).toBe(true);
    const all = SEEDS.flatMap((s) => evaluate(scenario(s).make()).decisions);
    expect(new Set(all.map((d) => `${d.outcome}/${d.mode}/${d.controlClass}/${d.failureHandling ?? '-'}`)).size).toBeGreaterThanOrEqual(15);
  });
  it('is deterministic: the same input gives an identical result, and a frozen input is never mutated', () => {
    for (const s of SEEDS) {
      const sc = scenario(s);
      const a = evaluate(sc.make());
      expect(JSON.stringify(evaluate(sc.make())), `seed ${s}`).toBe(JSON.stringify(a));
      expect(evaluate(deepFreeze(sc.make())), `seed ${s}`).toEqual(a);
    }
  });
  it('every decision passes validatePolicyDecision; the verdict is the worst enforced outcome; monitor is never enforced', () => {
    for (const s of SEEDS) {
      const e = evaluate(scenario(s).make());
      expect(e.problems, `seed ${s}`).toEqual([]);
      for (const d of e.decisions) {
        expect(validatePolicyDecision(d).ok, `seed ${s} ${d.decisionId}`).toBe(true);
        expect(d.enforced, `seed ${s}`).toBe(d.mode === 'enforce');
      }
      expect(e.verdict, `seed ${s}`).toBe(worst(e.decisions));
      expect(new Set(e.decisions.map((d) => d.decisionId)).size, `seed ${s}`).toBe(e.decisions.length);
    }
  });
  it('deny wins: a matching deny entitlement always blocks access', () => {
    let checked = 0;
    for (const s of SEEDS) {
      const sc = scenario(s);
      const i = sc.make();
      const e = evaluate(i);
      if (e.source !== 'bundle' || !deniedByOracle(i)) continue;
      checked++;
      expect(e.decisions[0], `seed ${s}`).toMatchObject({ decisionId: expect.stringMatching(/:access$/), outcome: 'block' });
      if (i.accessMode === 'enforce') expect(e.verdict, `seed ${s}`).toBe('block');
    }
    expect(checked).toBeGreaterThan(20);
  });
  it('never allows on error in enforce mode: every failed hard enforced decision blocks; a failed evaluation in enforce access mode blocks', () => {
    for (const s of SEEDS) {
      const sc = scenario(s);
      for (const e of [evaluate(sc.make()), failureEvaluation(sc.make(), pick(rng(s), ['timeout', 'engine_error'] as const))]) {
        for (const d of e.decisions) {
          expect(validatePolicyDecision(d).ok, `seed ${s}`).toBe(true);
          if (d.failure && d.failureHandling !== 'last_known_good' && d.mode === 'enforce' && d.controlClass === 'hard') expect(d.outcome, `seed ${s}`).toBe('block');
          if (d.failureHandling === 'continued_with_gap') expect(d.mode === 'monitor' || d.controlClass === 'log_only', `seed ${s}`).toBe(true);
        }
        expect(e.gap).toBe(e.decisions.some((d) => d.failureHandling === 'continued_with_gap'));
      }
      const i = sc.make();
      if (i.accessMode === 'enforce') {
        expect(failureEvaluation(i, 'engine_error').verdict, `seed ${s}`).toBe('block');
        if (sc.clock === 'throws') expect(evaluate(sc.make()).verdict, `seed ${s}`).toBe('block');
      }
    }
  });
  it('random junk as input never throws and never allows', () => {
    const r = rng(42);
    const junk = () => pick(r, [null, 7, 'x', [], { kind: 'always' }, { ...ctx(), [`k${Math.floor(r() * 9)}`]: 1 }, undefined]);
    for (let n = 0; n < 300; n++) {
      const e = evaluate({ bundle: chance(r, 0.5) ? junk() : bundle(), context: (chance(r, 0.5) ? junk() : ctx()) as never, clock: chance(r, 0.8) ? { now: NOW } : (junk() as never), accessMode: 'enforce' });
      if (e.problems.length || e.source === 'none') expect(e.verdict).toBe('block');
      for (const d of e.decisions) expect(validatePolicyDecision(d).ok).toBe(true);
    }
  });
});
