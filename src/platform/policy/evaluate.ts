// Pure, deterministic policy evaluation (ADR-0001 D2, §3.2 steps 2, 3 and 6, §3.3; slice C1). A gateway or a thin
// plugin runs it LOCALLY: no I/O, no network, no randomness, no LLM, and no clock read except through the clock the
// caller passes. Same input, same output. Every decision it returns passes validatePolicyDecision; anything it cannot
// evaluate fails closed, and every verdict comes with at least one decision record (review round 1, M2).
// Ratio is not the production gateway: this library supplies decisions to one.
// Not in this slice: bundle signature and digest verification (C2), DLP detection (C4; findings come from the caller).
// Work per evaluation is bounded by the contract maxima (256 policies x 512 rules, 4096 entitlements x 256 models,
// 1000 findings, 256 teams and tools): O(P*R + E*M + F) with per-category finding summaries.
import { isCount, isId, isIsoInstant, validatePolicyDecision, POLICY_PHASES, type Entitlement, type Policy, type PolicyCondition, type PolicyDecision } from '../contracts';
import { capabilityOn, type PlatformFlags } from '../flags';
import { compileBundle, current, RESERVED_PREFIX, selectBundle, type BundleFailure, type CompiledBundle, type Selected } from './bundle';
import { validateRequestContext, type RequestContext } from './context';

export type Outcome = PolicyDecision['outcome'];
export type Mode = PolicyDecision['mode'];
type Failure = NonNullable<PolicyDecision['failure']>;

/** `now` is a UTC instant; `elapsedMicros`, if given, is a monotonic reading used for latency and per-policy timeouts. */
export interface Clock { now: string; elapsedMicros?: () => number }
export interface EvaluationInput {
  /** A raw policy-bundle/1 (validated on every call) or a CompiledBundle from compileBundle (validated once at load). */
  bundle: unknown;
  /** An explicitly approved last-known-good bundle, used only when `bundle` is expired or invalid. */
  lastKnownGood?: unknown;
  context: unknown;
  clock: Clock;
  /** The instance's D7 flags (required): they set the access mode via accessModeFor; off means policy is disabled. */
  flags: PlatformFlags;
  /** Optional assertion: when given, it must equal accessModeFor(flags), or the input is refused. */
  accessMode?: Mode;
}
export interface Evaluation {
  /** What the gateway applies: the most severe outcome among ENFORCED decisions (block when a decision is dropped). */
  verdict: Outcome;
  /** Never empty: a refused input is recorded too (failure engine_error, reason CONTEXT_INVALID). */
  decisions: PolicyDecision[];
  source: 'bundle' | 'last_known_good' | 'none';
  /** A failure continued with a visible gap (monitor or log-only only). */
  gap: boolean;
  /** Input problems (paths and rules, never values). */
  problems: string[];
}

const SEVERITY: Record<Outcome, number> = { allow: 0, redact: 1, require_approval: 2, block: 3 };
const RANK = { low: 0, medium: 1, high: 2 } as const;
const worst = (xs: Outcome[]): Outcome => xs.reduce<Outcome>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'allow');
const day = (now: string) => now.slice(0, 10);
const uniq = (xs: string[]) => [...new Set(xs)];
const FAILURE_CODE = { timeout: 'EVALUATION_TIMEOUT', engine_error: 'ENGINE_ERROR' } as const;
const EPOCH = '1970-01-01T00:00:00Z';
const P = (k: string) => `${RESERVED_PREFIX}${k}`;

/** The single binding point between the D7 flags and the access mode (main's capabilityOn: own properties, `enabled` required). */
export const accessModeFor = (f: PlatformFlags | undefined): Mode | 'off' => (capabilityOn(f, 'enforcement') ? 'enforce' : capabilityOn(f, 'policyMonitor') ? 'monitor' : 'off');

const SEP = /[@\-:./_]/;
/** The id under a namespace or provider prefix (`openai/`, `models/`) and inside a fine-tune wrapper (`ft:<base>:...`). */
const bare = (m: string) => { const ft = /^ft:([^:]+)/.exec(m); const x = ft ? ft[1] : m; return x.slice(x.lastIndexOf('/') + 1); };
const family = (p: string, m: string) => m === p || (m.startsWith(p) && (SEP.test(p.charAt(p.length - 1)) || SEP.test(m.charAt(p.length))));
/**
 * A deny names a model family, case-folded: the id, any id extending it after a separator (@ - : . / _; a pattern
 * ending in one is a prefix), also under a namespace prefix or fine-tune wrapper. Accepted over-deny: gpt-4 denies gpt-4.1.
 */
const denies = (pattern: string, model: string) => {
  const p = pattern.toLowerCase(), m = model.toLowerCase();
  return pattern === '*' || family(p, m) || family(bare(p), bare(m));
};
/** A grant is exact (fail closed): `*` or the identical id. */
const grants = (pattern: string, model: string) => pattern === '*' || pattern === model;

/** A control that can block, redact or require approval is `hard`; anything else only logs (independent of mode). */
export const controlClass = (p: Policy): PolicyDecision['controlClass'] =>
  p.defaultAction === 'block' || p.rules.some((r) => r.action === 'block' || r.action === 'redact' || r.action === 'require_approval') ? 'hard' : 'log_only';

/** Current policies of the compiled bundle that apply to this context (phase, effective date, workload and provider scope). */
export function applicablePolicies(b: CompiledBundle, c: Pick<RequestContext, 'phase' | 'workloadId' | 'provider'>, now: string): { policy: Policy; index: number }[] {
  return current(b.policies, (x) => ({ id: x.policy.policyId, ...x.policy }), day(now)).filter(({ policy: p }) => p.phase === c.phase
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

/** Per-evaluation summaries: the highest finding confidence per category, and the known models. */
interface Env { c: RequestContext; best: Map<string, number>; models: string[] }
const envOf = (c: RequestContext): Env => {
  const best = new Map<string, number>();
  for (const f of c.findings) best.set(f.category, Math.max(best.get(f.category) ?? -1, RANK[f.confidence]));
  return { c, best, models: uniq([...(c.modelRequested ? [c.modelRequested] : []), ...(c.modelServed ? [c.modelServed] : [])]) };
};

function holds(k: PolicyCondition, { c, best, models }: Env): boolean {
  const tools = c.tools ?? [];
  switch (k.kind) {
    case 'always': return true;
    case 'dlp_category': return k.categories.some((cat) => (best.get(cat) ?? -1) >= RANK[k.minConfidence]);
    case 'destination': return k.providers.includes(c.destination) === (k.match === 'in');
    // An unknown model is "not in" every list (fail closed for allowlists).
    case 'model': return k.match === 'in' ? models.some((m) => k.models.includes(m)) : models.length === 0 || models.some((m) => !k.models.includes(m));
    case 'tool': return k.match === 'in' ? tools.some((t) => k.tools.includes(t)) : tools.some((t) => !k.tools.includes(t));
    case 'input_bytes_over': return c.inputBytes > k.limit;
    case 'signal': return (c.signals ?? []).some((s) => s.signal === k.signal && RANK[s.confidence] >= RANK[k.minConfidence]);
  }
}

function policyPart(p: Policy, env: Env): Part {
  const cls = controlClass(p);
  if (env.c.unavailable?.includes('dlp') && p.rules.some((r) => r.condition.kind === 'dlp_category')) return failed(p.mode, cls, 'dlp_unavailable', 'DLP_UNAVAILABLE');
  const matched = p.rules.filter((r) => holds(r.condition, env));
  const acting = matched.filter((r) => r.action !== 'log_only').map((r) => r.action as Outcome);
  // A log-only control has only allow actions and default allow, so it only allows by construction.
  const outcome = acting.length ? worst(acting) : p.defaultAction;
  const threshold = new Map<string, number>();
  for (const r of matched) if (r.condition.kind === 'dlp_category') for (const cat of r.condition.categories) threshold.set(cat, Math.min(threshold.get(cat) ?? 9, RANK[r.condition.minConfidence]));
  const findings = env.c.findings.filter((f) => RANK[f.confidence] >= (threshold.get(f.category) ?? 9)).map((f) => ({ ...f, normalization: [...f.normalization] }));
  return { mode: p.mode, controlClass: cls, outcome, ruleIds: matched.map((r) => r.ruleId), reasonCodes: [...matched.map((r) => r.reasonCode), ...(acting.length ? [] : [p.defaultAction === 'block' ? 'DEFAULT_BLOCK' : 'DEFAULT_ALLOW'])], findings };
}

/** Entitlements for the requested AND the served model: a family deny wins; an exact grant is required; no model, no access. */
function accessPart(b: CompiledBundle, c: RequestContext, now: string, mode: Mode): Part {
  if (c.unavailable?.includes('entitlements')) return failed(mode, 'hard', 'entitlement_unavailable', 'ENTITLEMENTS_UNAVAILABLE');
  const subject = (e: Entitlement) => e.subjectKind === 'tenant' ? e.subjectRef === c.tenantId : e.subjectKind === 'team' ? (c.teamIds ?? []).includes(e.subjectRef)
    : e.subjectKind === 'workload' ? e.subjectRef === c.workloadId : c.actorType === (e.subjectKind === 'user' ? 'human' : 'service') && c.actorRef === e.subjectRef;
  const candidates = current(b.entitlements, (e) => ({ id: e.entitlementId, ...e }), day(now)).filter((e) => e.provider === c.provider && subject(e));
  const check = (model: string | undefined, served: boolean) => {
    if (model === undefined) return { code: 'MODEL_UNKNOWN', deny: [], allow: [] };
    const deny = candidates.filter((e) => e.effect === 'deny' && e.models.some((m) => denies(m, model))).map((e) => e.entitlementId);
    const allow = candidates.filter((e) => e.effect === 'allow' && e.models.some((m) => grants(m, model))).map((e) => e.entitlementId);
    const code = deny.length ? (served ? 'SERVED_MODEL_DENIED' : 'ENTITLEMENT_DENIED') : allow.length ? null : served ? 'SERVED_MODEL_NOT_GRANTED' : 'ENTITLEMENT_NOT_GRANTED';
    return { code, deny, allow };
  };
  const checks = [check(c.modelRequested, false), ...(c.modelServed !== undefined && c.modelServed !== c.modelRequested ? [check(c.modelServed, true)] : [])];
  const refused = checks.filter((k) => k.code !== null);
  return refused.length
    ? { mode, controlClass: 'hard', outcome: 'block', ruleIds: uniq(refused.flatMap((k) => k.deny)), reasonCodes: refused.map((k) => k.code as string) }
    : { mode, controlClass: 'hard', outcome: 'allow', ruleIds: uniq(checks.flatMap((k) => k.allow)), reasonCodes: ['ENTITLED'] };
}

/** Seal decisions into an evaluation. Defense in depth: a decision that fails its own contract is dropped and the request fails closed. */
export function sealEvaluation(source: Evaluation['source'], decisions: PolicyDecision[], inputProblems: string[] = []): Evaluation {
  const ok = decisions.filter((d) => validatePolicyDecision(d).ok);
  const dropped = ok.length === decisions.length ? [] : ['$.decisions: a decision failed policy-decision/1 (dropped)'];
  const verdict = dropped.length || ok.length === 0 ? 'block' : worst(ok.filter((d) => d.enforced).map((d) => d.outcome));
  return { verdict, decisions: ok, source, gap: ok.some((d) => d.failureHandling === 'continued_with_gap'), problems: [...inputProblems, ...dropped] };
}

function resolveMode(i: EvaluationInput, problems: string[]): Mode | 'off' | undefined {
  const f: unknown = i.flags;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) { problems.push('$.flags: required, the platform flags object'); return undefined; }
  const m = accessModeFor(f as PlatformFlags);
  if (m !== 'off' && i.accessMode !== undefined && i.accessMode !== m) { problems.push('$.accessMode: does not match the platform flags'); return undefined; }
  return m;
}
/** One strict read of the input: the context is cloned before validation, so getters are read once and never again. */
interface Snapshot { c?: RequestContext; loose?: unknown; now?: unknown; mode?: Mode | 'off'; problems: string[] }
function snapshot(i: EvaluationInput): Snapshot {
  const s: Snapshot = { problems: [] };
  s.mode = resolveMode(i, s.problems);
  s.now = i.clock.now;
  if (!isIsoInstant(s.now)) s.problems.push('$.clock.now: UTC instant ending in Z');
  try {
    if (typeof i.context === 'object' && i.context !== null && Object.getOwnPropertySymbols(i.context).length) s.problems.push('$.context: symbol keys');
    s.loose = structuredClone(i.context);
    const r = validateRequestContext(s.loose);
    if (r.ok) s.c = r.value; else s.problems.push(...r.problems.map((p) => `$.context${p.slice(1)}`));
  } catch { s.problems.push('$.context: not a plain, cloneable object'); }
  return s;
}
/** The record of an input that was not evaluated: placeholders (reserved prefix, unforgeable) for unusable fields. */
function recordOf(i: EvaluationInput, s: Snapshot) {
  const field = (k: string, ok: (v: unknown) => boolean, d: string) => { try { const v = (s.loose as Record<string, unknown>)?.[k]; return ok(v) && !(v as string).startsWith(RESERVED_PREFIX) ? (v as string) : d; } catch { return d; } };
  const read = (raw: () => unknown) => { try { return compileBundle(raw()); } catch { return null; } };
  const bundles = [read(() => i.bundle), read(() => i.lastKnownGood)].filter((x): x is CompiledBundle => x !== null);
  const clockOk = isIsoInstant(s.now);
  const phaseOk = (v: unknown) => (POLICY_PHASES as readonly unknown[]).includes(v);
  const c = { tenantId: field('tenantId', isId, P('unknown-tenant')), requestRef: field('requestRef', (v) => isId(v) && (v as string).length <= 128, P('unknown-request')),
    phase: field('phase', phaseOk, 'pre_request') } as RequestContext;
  const x: Ctx = { c, now: clockOk ? (s.now as string) : EPOCH, bundleId: bundles[0]?.bundle.bundleId ?? P('unreadable-bundle'), bundleVersion: bundles[0]?.bundle.version ?? 1 };
  const phase = phaseOk(field('phase', phaseOk, '')) ? c.phase : undefined;
  // A refusal is at least as strict as the normal path: any enforce-mode policy for the phase (any phase when unknown) blocks.
  const enforcing = bundles.some((b) => (clockOk ? current(b.policies, (y) => ({ id: y.policy.policyId, ...y.policy }), day(s.now as string)) : b.policies)
    .some(({ policy: p }) => p.mode === 'enforce' && (phase === undefined || p.phase === phase)));
  return { x, clockOk, enforcing };
}
/** A refused input is still recorded: one denied engine_error decision (CONTEXT_INVALID), never laxer than evaluation. */
function refusal(i: EvaluationInput, s: Snapshot): Evaluation {
  const { x, clockOk, enforcing } = recordOf(i, s);
  const mode: Mode = s.mode === 'monitor' && !enforcing ? 'monitor' : 'enforce';
  const part = { ...failed(mode, 'hard', 'engine_error', 'CONTEXT_INVALID'), reasonCodes: ['CONTEXT_INVALID', ...(clockOk ? [] : ['CLOCK_INVALID'])] };
  return sealEvaluation('none', [decision(x, 'access', part, 0)], s.problems.length ? s.problems : ['$: evaluation failed']);
}
/** Policy capability off (D7): nothing is evaluated or enforced; one recorded POLICY_DISABLED allow. */
function disabled(i: EvaluationInput, s: Snapshot): Evaluation {
  const { x } = recordOf(i, s);
  return sealEvaluation('none', [decision(x, 'access', { mode: 'monitor', controlClass: 'log_only', outcome: 'allow', ruleIds: [], reasonCodes: ['POLICY_DISABLED'] }, 0)]);
}

/** No usable bundle and no approved last-known-good: every decision is a denied failure, each in its own mode. */
function bundleFailure(mode: Mode, c: RequestContext, now: string, r: Extract<Selected, { ok: false }>, latency = 0): Evaluation {
  const x: Ctx = { c, now, bundleId: r.compiled?.bundle.bundleId ?? P('unreadable-bundle'), bundleVersion: r.compiled?.bundle.version ?? 1 };
  const part = (m: Mode, cls: Part['controlClass']) => ({ ...failed(m, cls, r.failure, r.codes[0]), reasonCodes: r.codes });
  return sealEvaluation('none', [decision(x, 'access', part(mode, 'hard'), latency),
    ...(r.compiled ? applicablePolicies(r.compiled, c, now) : []).map(({ policy, index }) => decision(x, `p${index}`, part(policy.mode, controlClass(policy)), latency))]);
}

function policyFailure(p: Policy, f: 'timeout' | 'engine_error'): Part {
  const how = f === 'timeout' ? p.onTimeout : p.onEngineError;
  return failed(p.mode, controlClass(p), f, FAILURE_CODE[f], how === 'continue_with_gap');
}

/** Evaluate one phase of one request. Never throws; anything it cannot evaluate fails closed and is recorded. */
export function evaluate(i: EvaluationInput): Evaluation {
  try {
    const s = snapshot(i);
    if (s.mode === 'off') return disabled(i, s);
    if (s.problems.length || !s.c || !s.mode) return refusal(i, s);
    const { c } = s;
    const mode: Mode = s.mode;
    const now = s.now as string;
    const r = selectBundle(i.bundle, i.lastKnownGood, c.tenantId, now);
    if (!r.ok) return bundleFailure(mode, c, now, r);
    const x: Ctx = { c, now, bundleId: r.compiled.bundle.bundleId, bundleVersion: r.compiled.bundle.version, lkg: r.lkg };
    const elapsed = i.clock.elapsedMicros;
    const tick = () => { const v = elapsed ? elapsed() : 0; if (!isCount(v)) throw new Error('clock'); return v; };
    const timed = (slot: string, run: () => Part, onFail: (f: 'timeout' | 'engine_error') => Part, budgetMs?: number) => {
      try {
        const before = tick();
        const part = run();
        const latency = tick() - before;
        return decision(x, slot, budgetMs !== undefined && latency > budgetMs * 1000 ? onFail('timeout') : part, Math.max(0, latency));
      } catch { return decision(x, slot, onFail('engine_error'), 0); }
    };
    const env = envOf(c);
    return sealEvaluation(r.lkg ? 'last_known_good' : 'bundle', [
      timed('access', () => accessPart(r.compiled, c, now, mode), (f) => failed(mode, 'hard', f, FAILURE_CODE[f])),
      ...applicablePolicies(r.compiled, c, now).map(({ policy, index }) => timed(`p${index}`, () => policyPart(policy, env), (f) => policyFailure(policy, f), policy.evaluationTimeoutMs)),
    ]);
  } catch {
    return failureEvaluation(i, 'engine_error');
  }
}

/**
 * The decisions for an evaluation the gateway could not complete (its deadline passed, or the engine failed): each
 * applicable policy's own onTimeout/onEngineError, and access denied. `latencyMicros` is the caller's measurement.
 */
export function failureEvaluation(i: EvaluationInput, f: 'timeout' | 'engine_error', latencyMicros = 0): Evaluation {
  let s: Snapshot = { problems: [] };
  try {
    s = snapshot(i);
    if (s.mode === 'off') return disabled(i, s);
    if (s.problems.length || !s.c || !s.mode) return refusal(i, s);
    const { c } = s;
    const mode: Mode = s.mode;
    const now = s.now as string;
    const latency = isCount(latencyMicros) ? latencyMicros : 0;
    const r = selectBundle(i.bundle, i.lastKnownGood, c.tenantId, now);
    if (!r.ok) return bundleFailure(mode, c, now, r, latency);
    const x: Ctx = { c, now, bundleId: r.compiled.bundle.bundleId, bundleVersion: r.compiled.bundle.version, lkg: r.lkg };
    return sealEvaluation(r.lkg ? 'last_known_good' : 'bundle', [decision(x, 'access', failed(mode, 'hard', f, FAILURE_CODE[f]), latency),
      ...applicablePolicies(r.compiled, c, now).map(({ policy, index }) => decision(x, `p${index}`, policyFailure(policy, f), latency))]);
  } catch {
    return refusal(i, { ...s, problems: [...s.problems, '$: evaluation failed'] });
  }
}
