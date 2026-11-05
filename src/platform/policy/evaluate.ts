// Pure, deterministic policy evaluation (ADR-0001 D2, §3.2 steps 2, 3 and 6, §3.3; slice C1). A gateway or a thin
// plugin runs it LOCALLY: no I/O, no network, no randomness, no LLM, and no clock read except through the clock the
// caller passes. Same input, same output. Every decision it returns passes validatePolicyDecision; anything it cannot
// evaluate fails closed. Ratio is not the production gateway: this library supplies decisions to one.
// Not in this slice: bundle signature and digest verification (C2), DLP detection (C4; findings come from the caller).
import { instantBefore, isCount, isIsoInstant, validatePolicyBundle, validatePolicyDecision, type Entitlement, type Policy, type DlpFinding, type PolicyBundle, type PolicyCondition, type PolicyDecision } from '../contracts';
import { validateRequestContext, type RequestContext } from './context';

export type Outcome = PolicyDecision['outcome'];
export type Mode = PolicyDecision['mode'];
type Failure = NonNullable<PolicyDecision['failure']>;
type BundleFailure = 'policy_expired' | 'policy_invalid';

/** `now` is a UTC instant; `elapsedMicros`, if given, is a monotonic reading used for latency and per-policy timeouts. */
export interface Clock { now: string; elapsedMicros?: () => number }
export interface EvaluationInput {
  bundle: unknown;
  /** An explicitly approved last-known-good bundle, used only when `bundle` is expired or invalid. */
  lastKnownGood?: unknown;
  context: RequestContext;
  clock: Clock;
  /** Mode of the entitlement (access) decision: 1.3 deployments pass monitor, 2.0 enforce. */
  accessMode: Mode;
}
export interface Evaluation {
  /** What the gateway applies: the most severe outcome among ENFORCED decisions (block when the input is refused). */
  verdict: Outcome;
  decisions: PolicyDecision[];
  source: 'bundle' | 'last_known_good' | 'none';
  /** A failure continued with a visible gap (monitor or log-only only). */
  gap: boolean;
  /** Input problems (paths and rules, never values). Non-empty means verdict block and no decisions. */
  problems: string[];
}

const SEVERITY: Record<Outcome, number> = { allow: 0, redact: 1, require_approval: 2, block: 3 };
const RANK = { low: 0, medium: 1, high: 2 } as const;
const worst = (xs: Outcome[]): Outcome => xs.reduce<Outcome>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'allow');
const day = (now: string) => now.slice(0, 10);
const effective = (x: { effectiveFrom: string; effectiveTo?: string }, d: string) => x.effectiveFrom <= d && (x.effectiveTo === undefined || d < x.effectiveTo);
const uniq = (xs: string[]) => [...new Set(xs)];
const FAILURE_CODE = { timeout: 'EVALUATION_TIMEOUT', engine_error: 'ENGINE_ERROR' } as const;

/** A control that can block, redact or require approval is `hard`; anything else only logs (independent of mode). */
export const controlClass = (p: Policy): PolicyDecision['controlClass'] =>
  p.defaultAction === 'block' || p.rules.some((r) => r.action === 'block' || r.action === 'redact' || r.action === 'require_approval') ? 'hard' : 'log_only';

/** Policies of the bundle that apply to this context (phase, effective date, workload and provider scope), with their index. */
export function applicablePolicies(b: PolicyBundle, c: RequestContext, now: string): { policy: Policy; index: number }[] {
  return b.policies.map((policy, index) => ({ policy, index })).filter(({ policy: p }) => p.phase === c.phase && effective(p, day(now))
    && (p.scope.workloadIds === undefined || (c.workloadId !== undefined && p.scope.workloadIds.includes(c.workloadId)))
    && (p.scope.providers === undefined || p.scope.providers.includes(c.provider)));
}

interface Ctx { c: RequestContext; now: string; bundleId: string; bundleVersion: number; lkg?: { contentSha256: string; reason: BundleFailure } }
interface Part { mode: Mode; controlClass: PolicyDecision['controlClass']; outcome: Outcome; ruleIds: string[]; reasonCodes: string[]; findings?: PolicyDecision['findings']; failure?: Failure; handling?: PolicyDecision['failureHandling'] }

function decision(x: Ctx, slot: string, part: Part, latencyMicros: number): PolicyDecision {
  const failure = part.failure ?? x.lkg?.reason;
  const handling = part.failure ? part.handling : x.lkg ? 'last_known_good' : undefined;
  return {
    schemaVersion: 'policy-decision/1', decisionId: `dec:${x.c.requestRef}:${x.c.phase}:${x.c.sequence ?? 0}:${slot}`, tenantId: x.c.tenantId, requestRef: x.c.requestRef,
    bundleId: x.bundleId, bundleVersion: x.bundleVersion, phase: x.c.phase, mode: part.mode, controlClass: part.controlClass, outcome: part.outcome, enforced: part.mode === 'enforce',
    ruleIds: part.ruleIds, reasonCodes: x.lkg && part.failure ? [...part.reasonCodes, 'LAST_KNOWN_GOOD_IN_USE'] : part.reasonCodes,
    ...(failure ? { failure, failureHandling: handling } : {}), ...(handling === 'last_known_good' && x.lkg ? { lastKnownGood: { contentSha256: x.lkg.contentSha256, reason: x.lkg.reason } } : {}),
    findings: part.findings ?? [], latencyMicros, evaluatedAt: x.now,
  };
}
/** A failed control: denied (a block), or continued with a visible gap (an allow). */
const failed = (mode: Mode, cls: Part['controlClass'], failure: Failure, code: string, cont = false): Part =>
  ({ mode, controlClass: cls, outcome: cont ? 'allow' : 'block', ruleIds: [], reasonCodes: [code], failure, handling: cont ? 'continued_with_gap' : 'denied' });

type DlpCondition = Extract<PolicyCondition, { kind: 'dlp_category' }>;
const hit = (k: DlpCondition, f: DlpFinding) => k.categories.includes(f.category) && RANK[f.confidence] >= RANK[k.minConfidence];

function holds(k: PolicyCondition, c: RequestContext): boolean {
  const models = uniq([c.modelRequested, ...(c.modelServed ? [c.modelServed] : [])]);
  const tools = c.tools ?? [];
  switch (k.kind) {
    case 'always': return true;
    case 'dlp_category': return c.findings.some((f) => hit(k, f));
    case 'destination': return k.providers.includes(c.destination) === (k.match === 'in');
    case 'model': return k.match === 'in' ? models.some((m) => k.models.includes(m)) : models.some((m) => !k.models.includes(m));
    case 'tool': return k.match === 'in' ? tools.some((t) => k.tools.includes(t)) : tools.some((t) => !k.tools.includes(t));
    case 'input_bytes_over': return c.inputBytes > k.limit;
    case 'signal': return (c.signals ?? []).some((s) => s.signal === k.signal && RANK[s.confidence] >= RANK[k.minConfidence]);
  }
}

function policyPart(p: Policy, c: RequestContext): Part {
  const cls = controlClass(p);
  if (c.unavailable?.includes('dlp') && p.rules.some((r) => r.condition.kind === 'dlp_category')) return failed(p.mode, cls, 'dlp_unavailable', 'DLP_UNAVAILABLE');
  const matched = p.rules.filter((r) => holds(r.condition, c));
  const acting = matched.filter((r) => r.action !== 'log_only').map((r) => r.action as Outcome);
  const outcome = cls === 'log_only' ? 'allow' : acting.length ? worst(acting) : p.defaultAction;
  const dlp = matched.flatMap((r) => (r.condition.kind === 'dlp_category' ? [r.condition] : []));
  const findings = c.findings.filter((f) => dlp.some((k) => hit(k, f))).map((f) => ({ ...f, normalization: [...f.normalization] }));
  return { mode: p.mode, controlClass: cls, outcome, ruleIds: matched.map((r) => r.ruleId), reasonCodes: [...matched.map((r) => r.reasonCode), ...(acting.length ? [] : [p.defaultAction === 'block' ? 'DEFAULT_BLOCK' : 'DEFAULT_ALLOW'])], findings };
}

/** Entitlements (deny wins; no grant denies) for the requested AND the served model. */
function accessPart(b: PolicyBundle, c: RequestContext, now: string, mode: Mode): Part {
  if (c.unavailable?.includes('entitlements')) return failed(mode, 'hard', 'entitlement_unavailable', 'ENTITLEMENTS_UNAVAILABLE');
  const subject = (e: Entitlement) => e.subjectKind === 'tenant' ? e.subjectRef === c.tenantId : e.subjectKind === 'team' ? (c.teamIds ?? []).includes(e.subjectRef)
    : e.subjectKind === 'workload' ? e.subjectRef === c.workloadId : c.actorType === (e.subjectKind === 'user' ? 'human' : 'service') && c.actorRef === e.subjectRef;
  const check = (model: string, served: boolean) => {
    const hits = b.entitlements.filter((e) => e.provider === c.provider && effective(e, day(now)) && (e.models.includes('*') || e.models.includes(model)) && subject(e));
    const deny = hits.filter((e) => e.effect === 'deny').map((e) => e.entitlementId);
    const allow = hits.filter((e) => e.effect === 'allow').map((e) => e.entitlementId);
    const code = deny.length ? (served ? 'SERVED_MODEL_DENIED' : 'ENTITLEMENT_DENIED') : allow.length ? null : served ? 'SERVED_MODEL_NOT_GRANTED' : 'ENTITLEMENT_NOT_GRANTED';
    return { code, deny, allow };
  };
  const checks = [check(c.modelRequested, false), ...(c.modelServed !== undefined && c.modelServed !== c.modelRequested ? [check(c.modelServed, true)] : [])];
  const refused = checks.filter((k) => k.code !== null);
  return refused.length
    ? { mode, controlClass: 'hard', outcome: 'block', ruleIds: uniq(refused.flatMap((k) => k.deny)), reasonCodes: refused.map((k) => k.code as string) }
    : { mode, controlClass: 'hard', outcome: 'allow', ruleIds: uniq(checks.flatMap((k) => k.allow)), reasonCodes: ['ENTITLED'] };
}

type Resolved = { ok: true; bundle: PolicyBundle; lkg?: Ctx['lkg'] } | { ok: false; bundle?: PolicyBundle; failure: BundleFailure; codes: string[] };
function usable(raw: unknown, tenantId: string, now: string): { bundle?: PolicyBundle; failure?: BundleFailure; code?: string } {
  const r = validatePolicyBundle(raw);
  if (!r.ok) return { failure: 'policy_invalid', code: 'BUNDLE_INVALID' };
  const b = r.value;
  if (b.tenantId !== tenantId) return { bundle: b, failure: 'policy_invalid', code: 'BUNDLE_TENANT_MISMATCH' };
  if (instantBefore(now, b.issuedAt)) return { bundle: b, failure: 'policy_invalid', code: 'BUNDLE_NOT_YET_VALID' };
  if (!instantBefore(now, b.notAfter)) return { bundle: b, failure: 'policy_expired', code: 'BUNDLE_EXPIRED' };
  return { bundle: b };
}
function resolve(i: EvaluationInput, c: RequestContext, now: string): Resolved {
  const cur = usable(i.bundle, c.tenantId, now);
  if (!cur.failure && cur.bundle) return { ok: true, bundle: cur.bundle };
  const failure = cur.failure as BundleFailure;
  if (i.lastKnownGood === undefined) return { ok: false, bundle: cur.bundle, failure, codes: [cur.code as string] };
  const lkg = usable(i.lastKnownGood, c.tenantId, now);
  if (lkg.bundle && !lkg.failure && lkg.bundle.lastKnownGoodApproved === true) return { ok: true, bundle: lkg.bundle, lkg: { contentSha256: lkg.bundle.contentSha256, reason: failure } };
  return { ok: false, bundle: cur.bundle, failure, codes: [cur.code as string, 'LAST_KNOWN_GOOD_REFUSED'] };
}

function finish(source: Evaluation['source'], decisions: PolicyDecision[]): Evaluation {
  // Defense in depth: a decision that fails its own contract is dropped and the request fails closed.
  const ok = decisions.filter((d) => validatePolicyDecision(d).ok);
  const problems = ok.length === decisions.length ? [] : ['$.decisions: a decision failed policy-decision/1 (dropped)'];
  const verdict = problems.length ? 'block' : worst(ok.filter((d) => d.enforced).map((d) => d.outcome));
  return { verdict, decisions: ok, source, gap: ok.some((d) => d.failureHandling === 'continued_with_gap'), problems };
}
const refuse = (problems: string[]): Evaluation => ({ verdict: 'block', decisions: [], source: 'none', gap: false, problems });

/** Validated context and clock, or the refusal. */
function admit(i: EvaluationInput): { c: RequestContext; now: string } | Evaluation {
  const r = validateRequestContext(i?.context);
  const now = i?.clock?.now;
  const problems = [...(r.ok ? [] : r.problems.map((p) => p.replace('$', '$.context'))), ...(isIsoInstant(now) ? [] : ['$.clock.now: UTC instant ending in Z']),
    ...(i?.accessMode === 'monitor' || i?.accessMode === 'enforce' ? [] : ['$.accessMode: one of monitor|enforce'])];
  return problems.length || !r.ok ? refuse(problems) : { c: r.value, now: now as string };
}

/** A bundle that cannot be used and no approved last-known-good: every decision is a denied failure. */
function bundleFailure(i: EvaluationInput, c: RequestContext, now: string, r: Extract<Resolved, { ok: false }>, latency = 0): Evaluation {
  if (!r.bundle) return finish('none', [decision({ c, now, bundleId: 'unreadable-bundle', bundleVersion: 1 }, 'access', failed('enforce', 'hard', r.failure, r.codes[0]), latency)]);
  const x: Ctx = { c, now, bundleId: r.bundle.bundleId, bundleVersion: r.bundle.version };
  const part = (mode: Mode, cls: Part['controlClass']) => ({ ...failed(mode, cls, r.failure, r.codes[0]), reasonCodes: r.codes });
  return finish('none', [decision(x, 'access', part(i.accessMode, 'hard'), latency),
    ...applicablePolicies(r.bundle, c, now).map(({ policy, index }) => decision(x, `p${index}`, part(policy.mode, controlClass(policy)), latency))]);
}

/** Evaluate one phase of one request. Never throws; anything it cannot evaluate fails closed. */
export function evaluate(i: EvaluationInput): Evaluation {
  try {
    const a = admit(i);
    if ('verdict' in a) return a;
    const { c, now } = a;
    const r = resolve(i, c, now);
    if (!r.ok) return bundleFailure(i, c, now, r);
    const x: Ctx = { c, now, bundleId: r.bundle.bundleId, bundleVersion: r.bundle.version, lkg: r.lkg };
    const tick = () => { const v = i.clock.elapsedMicros ? i.clock.elapsedMicros() : 0; if (!isCount(v)) throw new Error('clock'); return v; };
    const timed = (slot: string, run: () => Part, onFail: (f: 'timeout' | 'engine_error') => Part, budgetMs?: number) => {
      try {
        const before = tick();
        const part = run();
        const latency = tick() - before;
        return decision(x, slot, budgetMs !== undefined && latency > budgetMs * 1000 ? onFail('timeout') : part, Math.max(0, latency));
      } catch { return decision(x, slot, onFail('engine_error'), 0); }
    };
    return finish(r.lkg ? 'last_known_good' : 'bundle', [
      timed('access', () => accessPart(r.bundle, c, now, i.accessMode), (f) => failed(i.accessMode, 'hard', f, FAILURE_CODE[f])),
      ...applicablePolicies(r.bundle, c, now).map(({ policy, index }) => timed(`p${index}`, () => policyPart(policy, c), (f) => policyFailure(policy, f), policy.evaluationTimeoutMs)),
    ]);
  } catch {
    return failureEvaluation(i, 'engine_error');
  }
}

function policyFailure(p: Policy, f: 'timeout' | 'engine_error'): Part {
  const how = f === 'timeout' ? p.onTimeout : p.onEngineError;
  return failed(p.mode, controlClass(p), f, FAILURE_CODE[f], how === 'continue_with_gap');
}

/**
 * The decisions for an evaluation the gateway could not complete (its deadline passed, or the engine failed): each
 * applicable policy's own onTimeout/onEngineError, and access denied. `latencyMicros` is the caller's measurement.
 */
export function failureEvaluation(i: EvaluationInput, f: 'timeout' | 'engine_error', latencyMicros = 0): Evaluation {
  try {
    const a = admit(i);
    if ('verdict' in a) return a;
    const { c, now } = a;
    const latency = isCount(latencyMicros) ? latencyMicros : 0;
    const r = resolve(i, c, now);
    if (!r.ok) return bundleFailure(i, c, now, r, latency);
    const x: Ctx = { c, now, bundleId: r.bundle.bundleId, bundleVersion: r.bundle.version, lkg: r.lkg };
    return finish(r.lkg ? 'last_known_good' : 'bundle', [decision(x, 'access', failed(i.accessMode, 'hard', f, FAILURE_CODE[f]), latency),
      ...applicablePolicies(r.bundle, c, now).map(({ policy, index }) => decision(x, `p${index}`, policyFailure(policy, f), latency))]);
  } catch {
    return refuse(['$: evaluation failed']);
  }
}
