// The orchestrator: registers proposals, runs them dry-run first, executes, post-checks,
// records a rollback token for reversible actions, auto-rolls back on a failed execution or a
// failed post-check, trips a per-class circuit breaker after N consecutive failures, and keeps
// execution idempotent. Every step writes an audit record.
//
// Trust boundary: these functions assume the CALLER has already authenticated and authorized
// the actor. `human.ts` does that with authorize(); `submitSystemProposal` is for trusted
// server code (the recommendation pipeline), never for a request body. `runProposal` re-checks
// what it can on its own: a service run needs a fresh `auto_execute` decision, a human run
// needs a stored approval by a different subject that has not expired.
//
// Concurrency: JavaScript runs the synchronous stretches below without interruption, so each
// of them is atomic. The only awaits are executor calls. Between the last gate check and the
// reservation of resource locks, cooldown stamps and window usage there is no await; two
// proposals racing for one resource therefore cannot both pass. A second run of one proposal
// id shares the first run's promise.
import { digestOf } from './canonical';
import { decide } from './decide';
import {
  isRollbackToken, EXEC_FAILURE_CODES, type ExecutableAction, type ExecuteResult, type RollbackRecord,
} from './executor';
import type { Executor } from './executor';
import { isParsedPolicy, type TenantPolicy } from './policy';
import { parseProposal, type ProposalErrorCode, type ProposalResult } from './proposal';
import type { ActionRegistry } from './registry';
import type { AuditLog, AuditKind } from './audit';
import {
  isHalted, pruneTouched, pruneWindow, type BreakerState, type ProposalRecord, type RemediationState, type RollbackEntry,
} from './state';
import {
  LIMITS, SERVICE_ACTOR_ID,
  type Decision, type Proposal, type ProposalOrigin, type RunReason, type RunResult, type RunStatus,
} from './types';

export interface RemediationDeps {
  readonly registry: ActionRegistry;
  readonly executor: Executor;
  readonly audit: AuditLog;
  readonly state: RemediationState;
  /** Epoch milliseconds. Injected so every test is deterministic. */
  readonly now: () => number;
}

export type Actor = { readonly kind: 'service' } | { readonly kind: 'human'; readonly sub: string };
export const actorId = (a: Actor): string => (a.kind === 'service' ? SERVICE_ACTOR_ID : a.sub);

const DEFAULT_BREAKER_THRESHOLD = 3;

function readNow(deps: RemediationDeps): number | null {
  try {
    const t = deps.now();
    return Number.isSafeInteger(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

/** The policy version named in audit records; 'none' for anything that is not a parsed policy. */
export const versionOf = (policy: TenantPolicy): string => (isParsedPolicy(policy) ? policy.version : 'none');

interface Entry {
  kind: AuditKind;
  actor: string;
  outcome: string;
  proposal?: Proposal | null;
  detail?: Record<string, string | number | boolean | null | bigint>;
}

/** Append one audit record; returns false if the log refused it. */
function note(deps: RemediationDeps, policy: TenantPolicy, e: Entry, at?: number): boolean {
  const t = at ?? readNow(deps);
  if (t === null) return false;
  const res = deps.audit.append({
    at: t, kind: e.kind, actor: e.actor, policyVersion: versionOf(policy), proposalId: e.proposal?.id ?? null,
    actionId: e.proposal?.action.id ?? null, outcome: e.outcome, ...(e.detail ? { detail: e.detail } : {}),
  });
  return res.ok;
}

export function toExecutable(p: Proposal): ExecutableAction {
  return Object.freeze({
    proposalId: p.id, tenant: p.tenant, actionId: p.action.id, actionClass: p.action.class, env: p.env, resourceIds: p.resourceIds, params: p.params,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export type RegisterErrorCode = 'INVALID_PROPOSAL' | 'TENANT_MISMATCH' | 'ID_CONFLICT' | 'CAPACITY' | 'AUDIT_UNAVAILABLE' | 'BAD_TIME';
export type RegisterResult =
  | { readonly ok: true; readonly record: ProposalRecord; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RegisterErrorCode; readonly proposalCode?: ProposalErrorCode; readonly proposalField?: string; readonly paramCode?: string };

const proposalDigest = (p: Proposal, requestedBy: string): string =>
  digestOf({
    id: p.id, tenant: p.tenant, origin: p.origin, requestedBy, actionId: p.action.id, env: p.env, team: p.team, params: p.params,
    impact: { currency: p.impact.currency, savings: p.impact.estimatedMonthlySavingsMinor, cost: p.impact.costAtStakeMinor },
  });

/** Parse, then store: for trusted callers that have nothing to authorize first. */
export function registerProposal(
  deps: RemediationDeps, policy: TenantPolicy, input: unknown, origin: ProposalOrigin, requestedBy: string,
): RegisterResult {
  const parsed: ProposalResult = parseProposal(deps.registry, input, origin);
  if (!parsed.ok) {
    return {
      ok: false, code: 'INVALID_PROPOSAL', proposalCode: parsed.code,
      ...(parsed.field === undefined ? {} : { proposalField: parsed.field }), ...(parsed.paramCode === undefined ? {} : { paramCode: parsed.paramCode }),
    };
  }
  return registerParsed(deps, policy, parsed.proposal, requestedBy);
}

/**
 * Store a parsed proposal and audit it. The stored decision is provisional until the caller
 * finalizes it (see `finalizeDecision`). The same id with the same payload replays; the same
 * id with a different payload is refused.
 */
export function registerParsed(deps: RemediationDeps, policy: TenantPolicy, proposal: Proposal, requestedBy: string): RegisterResult {
  const { state } = deps;
  const t = readNow(deps);
  if (t === null) return { ok: false, code: 'BAD_TIME' };
  if (proposal.tenant !== state.tenant) return { ok: false, code: 'TENANT_MISMATCH' };
  const digest = proposalDigest(proposal, requestedBy);
  const existing = state.proposals.get(proposal.id);
  if (existing) return existing.digest === digest ? { ok: true, record: existing, replayed: true } : { ok: false, code: 'ID_CONFLICT' };
  if (state.proposals.size >= state.limits.maxProposals) return { ok: false, code: 'CAPACITY' };
  if (deps.audit.remaining() < 2) return { ok: false, code: 'AUDIT_UNAVAILABLE' };

  const decision = decide(proposal, policy, state, t);
  const record: ProposalRecord = {
    proposal, digest, requestedBy, status: decision.kind === 'deny' ? 'denied' : 'proposed', decision, approvedBy: null, approvedAt: null,
  };
  if (!note(deps, policy, {
    kind: 'proposal', actor: requestedBy, outcome: 'PROPOSED', proposal,
    detail: { origin: proposal.origin, env: proposal.env, resourceCount: proposal.blastRadius.resourceCount, costAtStakeMinor: proposal.blastRadius.costAtStakeMinor, currency: proposal.impact.currency, digest: digest.slice(0, 16) },
  }, t)) return { ok: false, code: 'AUDIT_UNAVAILABLE' };
  state.proposals.set(proposal.id, record);
  return { ok: true, record, replayed: false };
}

/** Store the final decision on the record and audit it. The decision record names the service actor. */
export function finalizeDecision(deps: RemediationDeps, policy: TenantPolicy, record: ProposalRecord, decision: Decision): boolean {
  record.decision = decision;
  if (decision.kind === 'deny') record.status = 'denied';
  return note(deps, policy, {
    kind: 'decision', actor: SERVICE_ACTOR_ID, outcome: decision.reason, proposal: record.proposal,
    detail: { decision: decision.kind, blockers: decision.blockers.join(',') },
  });
}

// ---------------------------------------------------------------------------
// System-originated proposals (autonomy)
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { readonly ok: true; readonly proposalId: string; readonly decision: Decision; readonly result: RunResult; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RegisterErrorCode; readonly proposalCode?: ProposalErrorCode; readonly proposalField?: string; readonly paramCode?: string };

const notExecuted = (id: string, d: Decision, replayed: boolean): RunResult => ({ proposalId: id, status: 'not_executed', reason: d.reason, replayed, decision: d });

/**
 * Submit a proposal from trusted server code. If every gate passes it is dry-run, executed
 * and post-checked; otherwise it is stored for a human to approve (or denied outright).
 * With an empty policy the executor is never called.
 */
export async function submitSystemProposal(deps: RemediationDeps, policy: TenantPolicy, input: unknown): Promise<SubmitResult> {
  const reg = registerProposal(deps, policy, input, 'system', SERVICE_ACTOR_ID);
  if (!reg.ok) return reg;
  const { record } = reg;
  const id = record.proposal.id;
  if (reg.replayed) {
    const running = deps.state.inflight.get(id);
    const result = running ? { ...(await running), replayed: true } : { ...(deps.state.executions.get(id) ?? notExecuted(id, record.decision, true)), replayed: true };
    return { ok: true, proposalId: id, decision: record.decision, result, replayed: true };
  }
  const pre = record.decision;
  const onlyDryRunMissing = pre.kind === 'require_approval' && pre.blockers.length === 1 && pre.blockers[0] === 'DRY_RUN_NOT_PASSED';
  if (pre.kind !== 'auto_execute' && !onlyDryRunMissing) {
    // Denied, or blocked by something a dry run cannot fix: no executor call at all.
    // No dry run was attempted, so a missing dry run is not the cause; report the gates that actually blocked.
    const real = pre.blockers.filter((b) => b !== 'DRY_RUN_NOT_PASSED');
    const shown: Decision = pre.kind === 'deny' || real.length === 0 ? pre : Object.freeze({ ...pre, reason: real[0], blockers: Object.freeze(real) });
    if (!finalizeDecision(deps, policy, record, shown)) return { ok: false, code: 'AUDIT_UNAVAILABLE' };
    return { ok: true, proposalId: id, decision: shown, result: notExecuted(id, shown, false), replayed: false };
  }
  const result = await runProposal(deps, policy, id, { kind: 'service' });
  return { ok: true, proposalId: id, decision: result.decision ?? record.decision, result, replayed: false };
}

// ---------------------------------------------------------------------------
// Running a stored proposal
// ---------------------------------------------------------------------------

const reject = (id: string, reason: RunReason, decision?: Decision): RunResult => ({ proposalId: id, status: 'rejected', reason, replayed: false, ...(decision ? { decision } : {}) });

/** Run an executor call; any throw or malformed answer becomes a fixed failure code. */
async function safeExecute(executor: Executor, action: ExecutableAction, dryRun: boolean): Promise<ExecuteResult> {
  try {
    const r: unknown = await executor.execute(action, { dryRun });
    if (r === null || typeof r !== 'object') return { ok: false, code: 'EXEC_UNKNOWN' };
    const o = r as { ok?: unknown; code?: unknown; rollbackToken?: unknown };
    const token = isRollbackToken(o.rollbackToken) ? { rollbackToken: o.rollbackToken } : {};
    if (o.ok === true) return { ok: true, ...token };
    const code = EXEC_FAILURE_CODES.find((c) => c === o.code) ?? 'EXEC_UNKNOWN';
    return { ok: false, code, ...token };
  } catch {
    return { ok: false, code: 'EXEC_UNKNOWN' };
  }
}

async function safeBool(call: () => Promise<{ readonly ok: boolean }>): Promise<boolean> {
  try {
    const r: unknown = await call();
    return r !== null && typeof r === 'object' && (r as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

async function performRollback(deps: RemediationDeps, policy: TenantPolicy, actor: string, entry: RollbackEntry, proposal: Proposal): Promise<boolean> {
  const rec: RollbackRecord = Object.freeze({
    proposalId: entry.proposalId, tenant: deps.state.tenant, actionId: entry.actionId, actionClass: entry.actionClass, env: entry.env,
    resourceIds: entry.resourceIds, token: entry.token, createdAt: entry.createdAt,
  });
  const ok = await safeBool(() => deps.executor.rollback(rec));
  if (ok) entry.rolledBack = true;
  note(deps, policy, { kind: 'rollback', actor, outcome: ok ? 'ROLLBACK_OK' : 'ROLLBACK_FAILED', proposal });
  return ok;
}

function noteBreaker(deps: RemediationDeps, policy: TenantPolicy, cls: string, success: boolean, proposal: Proposal): void {
  const { state } = deps;
  const b: BreakerState = state.breakers.get(cls) ?? { consecutiveFailures: 0, open: false };
  const threshold = isParsedPolicy(policy) ? policy.circuitBreakerThreshold : DEFAULT_BREAKER_THRESHOLD;
  if (success) {
    const wasOpen = b.open;
    b.consecutiveFailures = 0;
    b.open = false;
    if (wasOpen) note(deps, policy, { kind: 'circuit_breaker', actor: SERVICE_ACTOR_ID, outcome: 'BREAKER_CLOSED', proposal });
  } else {
    b.consecutiveFailures += 1;
    if (!b.open && b.consecutiveFailures >= threshold) {
      b.open = true;
      note(deps, policy, { kind: 'circuit_breaker', actor: SERVICE_ACTOR_ID, outcome: 'BREAKER_TRIPPED', proposal, detail: { failures: b.consecutiveFailures } });
    }
  }
  state.breakers.set(cls, b);
}

/**
 * Run a stored proposal. Replays return the first terminal result; a concurrent duplicate
 * shares the in-flight run. See the header for what each actor kind must satisfy.
 */
export function runProposal(deps: RemediationDeps, policy: TenantPolicy, proposalId: string, actor: Actor): Promise<RunResult> {
  const { state } = deps;
  const first = state.executions.get(proposalId);
  if (first) return Promise.resolve({ ...first, replayed: true });
  const running = state.inflight.get(proposalId);
  if (running) return running.then((r) => ({ ...r, replayed: true }));
  const p = runFresh(deps, policy, proposalId, actor)
    .catch((): RunResult => reject(proposalId, 'INTERNAL_ERROR'))
    .finally(() => {
      state.inflight.delete(proposalId);
    });
  state.inflight.set(proposalId, p);
  return p;
}

/**
 * Safety rails that bind a human-approved apply too: kill switch, platform halt, an open class
 * breaker, and a change-freeze window. There is no override in this build: a human who needs one
 * releases the switch or resets the breaker (both authorized and audited) and applies again.
 * The refusal is audited and is not a terminal result, so the approval stays usable afterwards.
 */
function haltedForHuman(deps: RemediationDeps, policy: TenantPolicy, proposal: Proposal, who: string, t: number): boolean {
  const freeze = isParsedPolicy(policy) && policy.freezeWindows.some((w) => t >= w.startMs && t < w.endMs);
  const halted = isHalted(deps.state) || deps.state.breakers.get(proposal.action.class)?.open === true || freeze || !isParsedPolicy(policy);
  if (halted) note(deps, policy, { kind: 'execution', actor: who, outcome: 'EXEC_REFUSED_HALTED', proposal, detail: { freeze } }, t);
  return halted;
}

async function runFresh(deps: RemediationDeps, policy: TenantPolicy, proposalId: string, actor: Actor): Promise<RunResult> {
  const { state, executor } = deps;
  const record = state.proposals.get(proposalId);
  if (!record) return reject(proposalId, 'NOT_FOUND');
  const proposal = record.proposal;
  const service = actor.kind === 'service';
  const who = actorId(actor);

  // Preconditions on the stored record.
  if (service) {
    if (record.status !== 'proposed' || proposal.origin !== 'system') return reject(proposalId, 'BAD_STATE');
  } else {
    if (record.status !== 'approved' || record.approvedBy === null || record.approvedAt === null) return reject(proposalId, 'NOT_APPROVED');
    if (record.approvedBy === record.requestedBy) return reject(proposalId, 'NOT_APPROVED'); // separation of duties, asserted again
    const t = readNow(deps);
    if (t === null) return reject(proposalId, 'BAD_TIME');
    const maxAge = isParsedPolicy(policy) ? policy.approvalMaxAgeMs : 86_400_000;
    if (t - record.approvedAt > maxAge || t < record.approvedAt) return reject(proposalId, 'APPROVAL_EXPIRED');
    if (haltedForHuman(deps, policy, proposal, who, t)) return reject(proposalId, 'HALTED');
  }

  // Dry run first. It changes nothing; its result is evidence for the decision.
  const action = toExecutable(proposal);
  const dry = await safeExecute(executor, action, true);
  const tDry = readNow(deps);
  if (tDry === null) return reject(proposalId, 'BAD_TIME');
  state.dryRuns.set(proposalId, { ok: dry.ok, at: tDry });
  if (!note(deps, policy, { kind: 'execution', actor: who, outcome: dry.ok ? 'DRY_RUN_OK' : 'DRY_RUN_FAILED', proposal }, tDry)) return reject(proposalId, 'AUDIT_UNAVAILABLE');
  if (!dry.ok && !service) return { proposalId, status: 'dry_run_failed', reason: 'DRY_RUN_FAILED', replayed: false };

  // From here to the reservation there is no await: the gate check and the claim are one atomic step.
  const t = readNow(deps);
  if (t === null) return reject(proposalId, 'BAD_TIME');
  let decision: Decision | undefined;
  if (service) {
    decision = decide(proposal, policy, state, t);
    if (!finalizeDecision(deps, policy, record, decision)) return reject(proposalId, 'AUDIT_UNAVAILABLE', decision);
    if (decision.kind !== 'auto_execute') return notExecuted(proposalId, decision, false);
  } else {
    if (isParsedPolicy(policy) && policy.denyClasses.includes(proposal.action.class)) return reject(proposalId, 'CLASS_DENIED');
    if (haltedForHuman(deps, policy, proposal, who, t)) return reject(proposalId, 'HALTED'); // re-check after the dry-run await
    if (proposal.resourceIds.some((r) => state.locks.has(r))) return reject(proposalId, 'RESOURCE_BUSY');
  }
  pruneTouched(state, t);
  pruneWindow(state, t);
  const fresh = proposal.resourceIds.filter((r) => !state.lastTouched.has(r)).length;
  if (state.lastTouched.size + fresh > state.limits.maxTrackedResources || (service && state.windowUsage.length >= state.limits.maxWindowEntries)) {
    return reject(proposalId, 'CAPACITY', decision);
  }
  if (deps.audit.remaining() < LIMITS.auditHeadroom) return reject(proposalId, 'AUDIT_UNAVAILABLE', decision);
  // Write-ahead: no effect without a record that says it is about to happen.
  if (!note(deps, policy, {
    kind: 'execution', actor: who, outcome: 'EXEC_STARTED', proposal,
    detail: { approvedBy: record.approvedBy, resourceCount: proposal.blastRadius.resourceCount },
  }, t)) return reject(proposalId, 'AUDIT_UNAVAILABLE', decision);

  for (const r of proposal.resourceIds) {
    state.locks.add(r);
    state.lastTouched.set(r, t);
  }
  if (service) {
    state.windowUsage.push({ at: t, actionClass: proposal.action.class, resources: proposal.blastRadius.resourceCount, currency: proposal.impact.currency, costMinor: proposal.blastRadius.costAtStakeMinor });
  }

  let status: RunStatus;
  let reason: RunReason;
  try {
    const exec = await safeExecute(executor, action, false);
    const reversible = proposal.action.reversible;
    let entry: RollbackEntry | null = null;
    if (reversible && exec.rollbackToken !== undefined) {
      entry = {
        proposalId, actionId: proposal.action.id, actionClass: proposal.action.class, env: proposal.env, resourceIds: proposal.resourceIds,
        token: exec.rollbackToken, createdAt: readNow(deps) ?? t, rolledBack: false,
      };
      state.rollbacks.set(proposalId, entry); // recorded the moment it is issued, before anything else can fail
    }
    if (!exec.ok) {
      note(deps, policy, { kind: 'execution', actor: who, outcome: 'EXEC_FAILED', proposal, detail: { code: exec.code } });
      reason = 'EXECUTE_FAILED';
      if (entry) {
        const ok = await performRollback(deps, policy, who, entry, proposal);
        status = ok ? 'rolled_back' : 'rollback_failed';
        if (!ok) reason = 'ROLLBACK_FAILED';
      } else {
        status = 'failed';
      }
      noteBreaker(deps, policy, proposal.action.class, false, proposal);
    } else if (reversible && !entry) {
      // Effect applied but nothing to undo it with: stop and ask a human.
      note(deps, policy, { kind: 'execution', actor: who, outcome: 'EXEC_NO_ROLLBACK', proposal });
      status = 'failed';
      reason = 'ROLLBACK_TOKEN_MISSING';
      noteBreaker(deps, policy, proposal.action.class, false, proposal);
    } else {
      note(deps, policy, { kind: 'execution', actor: who, outcome: 'EXEC_OK', proposal });
      const checked = await safeBool(() => executor.postCheck(action));
      if (checked) {
        status = 'succeeded';
        reason = 'OK';
        noteBreaker(deps, policy, proposal.action.class, true, proposal);
      } else {
        note(deps, policy, { kind: 'execution', actor: who, outcome: 'POSTCHECK_FAILED', proposal });
        reason = 'POSTCHECK_FAILED';
        if (entry) {
          const ok = await performRollback(deps, policy, who, entry, proposal);
          status = ok ? 'rolled_back' : 'rollback_failed';
          if (!ok) reason = 'ROLLBACK_FAILED';
        } else {
          status = 'failed'; // irreversible: nothing to undo
        }
        noteBreaker(deps, policy, proposal.action.class, false, proposal);
      }
    }
    record.status = status === 'succeeded' ? 'executed' : status === 'rolled_back' ? 'rolled_back' : 'failed';
    const result: RunResult = { proposalId, status, reason, replayed: false, ...(decision ? { decision } : {}) };
    state.executions.set(proposalId, result);
    return result;
  } finally {
    for (const r of proposal.resourceIds) state.locks.delete(r);
  }
}

// ---------------------------------------------------------------------------
// Manual rollback, kill switch, circuit breaker (trusted callers; human.ts authorizes first)
// ---------------------------------------------------------------------------

export interface RollbackOutcome {
  readonly proposalId: string;
  readonly status: 'rolled_back' | 'rollback_failed' | 'rejected';
  readonly reason: 'OK' | 'ROLLBACK_FAILED' | 'NOT_FOUND' | 'NO_ROLLBACK_AVAILABLE' | 'RESOURCE_BUSY' | 'BAD_STATE' | 'AUDIT_UNAVAILABLE' | 'BAD_TIME';
}

/** Undo a recorded reversible effect. Only for an executed or failed proposal that has an unused token. */
export async function rollbackProposal(deps: RemediationDeps, policy: TenantPolicy, proposalId: string, actor: string): Promise<RollbackOutcome> {
  const { state } = deps;
  const rej = (reason: RollbackOutcome['reason']): RollbackOutcome => ({ proposalId, status: 'rejected', reason });
  const record = state.proposals.get(proposalId);
  const entry = state.rollbacks.get(proposalId);
  if (!record) return rej('NOT_FOUND');
  if (state.inflight.has(proposalId)) return rej('BAD_STATE');
  if (!entry || entry.rolledBack) return rej('NO_ROLLBACK_AVAILABLE');
  if (record.status !== 'executed' && record.status !== 'failed') return rej('BAD_STATE');
  if (record.proposal.resourceIds.some((r) => state.locks.has(r))) return rej('RESOURCE_BUSY');
  const t = readNow(deps);
  if (t === null) return rej('BAD_TIME');
  if (deps.audit.remaining() < 2) return rej('AUDIT_UNAVAILABLE');
  for (const r of record.proposal.resourceIds) state.locks.add(r);
  try {
    const ok = await performRollback(deps, policy, actor, entry, record.proposal);
    if (ok) record.status = 'rolled_back';
    return { proposalId, status: ok ? 'rolled_back' : 'rollback_failed', reason: ok ? 'OK' : 'ROLLBACK_FAILED' };
  } finally {
    for (const r of record.proposal.resourceIds) state.locks.delete(r);
  }
}

/** Engage or release the tenant kill switch. Engaging always takes effect; releasing needs its audit record. */
export function applyKillSwitch(deps: RemediationDeps, policy: TenantPolicy, actor: string, engaged: boolean): { ok: boolean; changed: boolean } {
  const ks = deps.state.killSwitch;
  if (ks.engaged === engaged) return { ok: true, changed: false };
  const t = readNow(deps);
  if (t === null && !engaged) return { ok: false, changed: false }; // a release needs a trustworthy clock and its record
  const prev = { engaged: ks.engaged, changedBy: ks.changedBy, changedAt: ks.changedAt };
  ks.engaged = engaged;
  ks.changedBy = actor;
  ks.changedAt = t;
  const audited = t !== null && note(deps, policy, { kind: 'kill_switch', actor, outcome: engaged ? 'KILL_SWITCH_ENGAGED' : 'KILL_SWITCH_RELEASED' }, t);
  if (!audited && !engaged) {
    ks.engaged = prev.engaged;
    ks.changedBy = prev.changedBy;
    ks.changedAt = prev.changedAt;
    return { ok: false, changed: false };
  }
  return { ok: true, changed: true };
}

/** Close a class's circuit breaker (for example after a human fixed the executor). */
export function applyBreakerReset(deps: RemediationDeps, policy: TenantPolicy, actor: string, actionClass: string): { ok: boolean } {
  if (!deps.registry.classes().includes(actionClass)) return { ok: false };
  const t = readNow(deps);
  if (t === null) return { ok: false };
  const b = deps.state.breakers.get(actionClass);
  if (!b || (!b.open && b.consecutiveFailures === 0)) return { ok: true };
  if (deps.audit.remaining() < 1) return { ok: false };
  b.open = false;
  b.consecutiveFailures = 0;
  return { ok: note(deps, policy, { kind: 'circuit_breaker', actor, outcome: 'BREAKER_RESET', detail: { class: actionClass } }, t) };
}

