// The human path: request, approve, apply (and roll back), each gated by authorize() from
// src/rbac/authorize.ts, which this module calls and never changes or bypasses. This is the
// default posture: propose, then a DIFFERENT person approves, then apply. Autonomy does not
// alter it.
//
// Trust boundary: the `principal` must come from the verified session (never a request body);
// `ticketState` must come from the ticket system (never a request body); `input` is untrusted
// and is validated by parseProposal. Failures return the contract's statuses (401, 403, 409,
// plus 400, 404 and 503 for malformed, unknown and unavailable) with FIXED reason text. No
// reason ever echoes input. Nothing is revealed about a change until the caller is
// authenticated and in the tenant.
//
// Tenant scoping: authorize() has no tenant field, so this module checks that the principal's
// tenant equals the tenant of the state it is operating on before anything else.
//
// Separation of duties: authorize('change.approve') refuses when the requester is the caller;
// the orchestrator checks it again at apply time. A proposal raised by autonomy is requested
// by the service actor, so any human approver differs from it.
//
// Authorize is not called on a denial path for logging: denied attempts are returned to the
// caller and belong in the serving route's access log, not in this audit chain (otherwise a
// caller with a valid token could fill the chain and halt remediation).
import { ownRecord } from '@/identity/scope';
import type { Principal, Resource, Role, TicketState, Verdict } from '@/identity/types';
import { authorize, DENY_REASONS } from '@/rbac/authorize';
import { isValidActor } from './audit';
import {
  applyBreakerReset, applyKillSwitch, finalizeDecision, registerParsed, rollbackProposal, runProposal, versionOf,
  type RemediationDeps, type RollbackOutcome,
} from './orchestrator';
import type { TenantPolicy } from './policy';
import { ID_PATTERN, parseProposal } from './proposal';
import type { ProposalRecord } from './state';
import { SERVICE_ACTOR_ID, type Decision, type RunResult } from './types';

export type HumanStatus = 400 | 401 | 403 | 404 | 409 | 503;
export interface HumanDenied {
  readonly ok: false;
  readonly status: HumanStatus;
  /** Fixed text. Never echoes input. */
  readonly reason: string;
  /** A fixed code from this module, when one adds information. */
  readonly code?: string;
}

export const HUMAN_REASONS = Object.freeze({
  invalid: 'Request is invalid',
  reserved: 'Principal not permitted',
  notFound: 'Change not found',
  notAwaiting: 'Change is not awaiting approval',
  expired: 'Approval has expired',
  idConflict: 'Change id already used',
  capacity: 'Capacity reached',
  unavailable: 'Service unavailable',
  policy: 'Denied by policy',
  busy: 'Resource busy',
  halted: 'Remediation is halted',
  noRollback: 'Nothing to roll back',
  badState: 'Change is not in a valid state for this step',
});

const PRINCIPAL_KEYS = ['sub', 'role', 'teams', 'envs', 'tenant', 'tokenId', 'expiresAt', 'authMethod'] as const;
const denied = (status: HumanStatus, reason: string, code?: string): HumanDenied => ({ ok: false, status, reason, ...(code === undefined ? {} : { code }) });
const fromVerdict = (v: Extract<Verdict, { allow: false }>): HumanDenied => denied(v.status, v.reason);

/** Snapshot the principal once, so a getter or Proxy cannot answer differently after the authorize() call. */
function snapshot(deps: RemediationDeps, input: unknown): { ok: true; principal: Principal } | HumanDenied {
  const o = ownRecord(input, PRINCIPAL_KEYS);
  if (!o || typeof o.sub !== 'string' || o.sub === '' || typeof o.role !== 'string' || typeof o.tenant !== 'string') return denied(401, DENY_REASONS.noPrincipal);
  // Too long, unprintable, or the reserved service prefix. The service actor id itself is valid in the audit log but never for a human.
  if (!isValidActor(o.sub) || o.sub === SERVICE_ACTOR_ID) return denied(403, HUMAN_REASONS.reserved);
  if (o.tenant !== deps.state.tenant) return denied(403, DENY_REASONS.scope);
  return { ok: true, principal: o as unknown as Principal };
}

function changeResource(rec: ProposalRecord, extra: Partial<Resource> = {}): Resource {
  return {
    kind: 'change', id: rec.proposal.id, team: rec.proposal.team, env: rec.proposal.env, requesterSub: rec.requestedBy,
    impact: rec.proposal.action.impact, ...extra,
  };
}

function lookup(deps: RemediationDeps, id: unknown): ProposalRecord | null {
  return typeof id === 'string' && ID_PATTERN.test(id) ? deps.state.proposals.get(id) ?? null : null;
}

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

export type RequestResult =
  | { readonly ok: true; readonly proposalId: string; readonly decision: Decision; readonly replayed: boolean }
  | HumanDenied;

/**
 * File a change request. Requires change.request. A human-filed request is never
 * auto-executed (the decision is recorded with HUMAN_ORIGIN): a second person approves, then
 * someone applies.
 */
export function requestChange(deps: RemediationDeps, policy: TenantPolicy, principal: Principal | null | undefined, input: unknown): RequestResult {
  const snap = snapshot(deps, principal);
  if (!snap.ok) return snap;
  const p = snap.principal;
  const parsed = parseProposal(deps.registry, input, 'human');
  if (!parsed.ok) return denied(400, HUMAN_REASONS.invalid, parsed.code);
  const proposal = parsed.proposal;
  const verdict = authorize(p, 'change.request', {
    kind: 'change', id: proposal.id, team: proposal.team, env: proposal.env, requesterSub: p.sub, impact: proposal.action.impact,
  });
  if (!verdict.allow) return fromVerdict(verdict);
  const reg = registerParsed(deps, policy, proposal, p.sub);
  if (!reg.ok) {
    if (reg.code === 'ID_CONFLICT') return denied(409, HUMAN_REASONS.idConflict);
    if (reg.code === 'TENANT_MISMATCH') return denied(403, DENY_REASONS.scope);
    if (reg.code === 'CAPACITY') return denied(409, HUMAN_REASONS.capacity);
    return denied(503, HUMAN_REASONS.unavailable, reg.code);
  }
  if (reg.replayed) return { ok: true, proposalId: proposal.id, decision: reg.record.decision, replayed: true };
  const decision = reg.record.decision;
  if (!finalizeDecision(deps, policy, reg.record, decision)) return denied(503, HUMAN_REASONS.unavailable, 'AUDIT_UNAVAILABLE');
  if (decision.kind === 'deny') return denied(403, HUMAN_REASONS.policy, decision.reason);
  return { ok: true, proposalId: proposal.id, decision, replayed: false };
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

export type ApproveResult = { readonly ok: true; readonly proposalId: string; readonly approvedBy: string } | HumanDenied;

/** Approve a proposed change. Requires change.approve; the approver must differ from the requester. */
export function approveChange(deps: RemediationDeps, policy: TenantPolicy, principal: Principal | null | undefined, proposalId: string): ApproveResult {
  const snap = snapshot(deps, principal);
  if (!snap.ok) return snap;
  const p = snap.principal;
  const rec = lookup(deps, proposalId);
  if (!rec) return denied(404, HUMAN_REASONS.notFound);
  const verdict = authorize(p, 'change.approve', changeResource(rec));
  if (!verdict.allow) return fromVerdict(verdict);
  if (rec.requestedBy === p.sub) return denied(403, DENY_REASONS.duties); // asserted again; authorize() already refuses
  if (rec.status !== 'proposed') return denied(409, HUMAN_REASONS.notAwaiting);
  const now = safeNow(deps);
  if (now === null) return denied(503, HUMAN_REASONS.unavailable, 'BAD_TIME');
  const audited = deps.audit.append({
    at: now, kind: 'approval', actor: p.sub, policyVersion: versionOf(policy), proposalId: rec.proposal.id, actionId: rec.proposal.action.id,
    outcome: 'APPROVED', detail: { requestedBy: rec.requestedBy === SERVICE_ACTOR_ID ? 'service' : 'human' },
  });
  if (!audited.ok) return denied(503, HUMAN_REASONS.unavailable, 'AUDIT_UNAVAILABLE');
  rec.status = 'approved';
  rec.approvedBy = p.sub;
  rec.approvedAt = now;
  return { ok: true, proposalId: rec.proposal.id, approvedBy: p.sub };
}

function safeNow(deps: RemediationDeps): number | null {
  try {
    const t = deps.now();
    return Number.isSafeInteger(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export type ApplyResult = { readonly ok: true; readonly result: RunResult } | HumanDenied;

export interface ApplyOptions {
  /** Live state of the bound ticket, from the ticket system. Production applies need 'approved'. */
  readonly ticketState?: TicketState;
}

/**
 * Apply an approved change. Requires change.apply, an approval by a different subject,
 * and (in production) an approved bound ticket. A replay returns the first result.
 */
export async function applyChange(
  deps: RemediationDeps, policy: TenantPolicy, principal: Principal | null | undefined, proposalId: string, opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const snap = snapshot(deps, principal);
  if (!snap.ok) return snap;
  const p = snap.principal;
  const rec = lookup(deps, proposalId);
  if (!rec) return denied(404, HUMAN_REASONS.notFound);
  const verdict = authorize(p, 'change.apply', changeResource(rec, {
    ...(rec.approvedBy === null ? {} : { approverSub: rec.approvedBy }), ticketState: opts.ticketState ?? 'none',
  }));
  if (!verdict.allow) return fromVerdict(verdict);
  const id = rec.proposal.id;
  // A replay is answered only after authorization, so it reveals nothing to an unauthorized caller.
  const first = deps.state.executions.get(id) ?? (deps.state.inflight.has(id) ? await deps.state.inflight.get(id) : undefined);
  if (first) return { ok: true, result: { ...first, replayed: true } };
  if (rec.status !== 'approved') return denied(409, DENY_REASONS.changeNotApproved);
  const result = await runProposal(deps, policy, id, { kind: 'human', sub: p.sub });
  if (result.status === 'rejected') {
    switch (result.reason) {
      case 'NOT_APPROVED': return denied(409, DENY_REASONS.changeNotApproved);
      case 'APPROVAL_EXPIRED': return denied(409, HUMAN_REASONS.expired);
      case 'RESOURCE_BUSY': return denied(409, HUMAN_REASONS.busy);
      case 'HALTED': return denied(409, HUMAN_REASONS.halted, 'HALTED');
      case 'CLASS_DENIED': return denied(403, HUMAN_REASONS.policy, 'CLASS_DENIED');
      case 'CAPACITY': return denied(409, HUMAN_REASONS.capacity);
      case 'NOT_FOUND': return denied(404, HUMAN_REASONS.notFound);
      case 'BAD_STATE': return denied(409, HUMAN_REASONS.badState);
      default: return denied(503, HUMAN_REASONS.unavailable, result.reason);
    }
  }
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

export type RollbackResult = { readonly ok: true; readonly outcome: RollbackOutcome } | HumanDenied;

/** Undo an executed reversible change. Same authority as applying it (change.apply). */
export async function rollbackChange(
  deps: RemediationDeps, policy: TenantPolicy, principal: Principal | null | undefined, proposalId: string, opts: ApplyOptions = {},
): Promise<RollbackResult> {
  const snap = snapshot(deps, principal);
  if (!snap.ok) return snap;
  const p = snap.principal;
  const rec = lookup(deps, proposalId);
  if (!rec) return denied(404, HUMAN_REASONS.notFound);
  const verdict = authorize(p, 'change.apply', changeResource(rec, {
    ...(rec.approvedBy === null ? {} : { approverSub: rec.approvedBy }), ticketState: opts.ticketState ?? 'none',
  }));
  if (!verdict.allow) return fromVerdict(verdict);
  const outcome = await rollbackProposal(deps, policy, rec.proposal.id, p.sub);
  if (outcome.status === 'rejected') {
    switch (outcome.reason) {
      case 'NOT_FOUND': return denied(404, HUMAN_REASONS.notFound);
      case 'NO_ROLLBACK_AVAILABLE': return denied(409, HUMAN_REASONS.noRollback);
      case 'RESOURCE_BUSY': return denied(409, HUMAN_REASONS.busy);
      case 'BAD_STATE': return denied(409, HUMAN_REASONS.badState);
      default: return denied(503, HUMAN_REASONS.unavailable, outcome.reason);
    }
  }
  return { ok: true, outcome };
}

// ---------------------------------------------------------------------------
// kill switch and circuit breaker
// ---------------------------------------------------------------------------

/** Engaging only makes things safer, so more roles may do it than may release. Both are assumptions the owner confirms. */
export const KILL_SWITCH_ENGAGE_ROLES: readonly Role[] = Object.freeze(['cto', 'finops_lead', 'eng_lead'] as const);
export const KILL_SWITCH_RELEASE_ROLES: readonly Role[] = Object.freeze(['cto', 'finops_lead'] as const);

export type AdminResult = { readonly ok: true; readonly changed: boolean } | HumanDenied;

/**
 * The permission matrix has no kill-switch action, and it is not edited here. The caller must
 * pass authorize('view.read') on the overview (which validates the principal and refuses the
 * shared service token) and hold a role in the lists above.
 */
function adminGate(deps: RemediationDeps, principal: unknown, roles: readonly Role[]): { ok: true; principal: Principal } | HumanDenied {
  const snap = snapshot(deps, principal);
  if (!snap.ok) return snap;
  const verdict = authorize(snap.principal, 'view.read', { kind: 'view', id: '/overview' });
  if (!verdict.allow) return fromVerdict(verdict);
  if (!roles.includes(snap.principal.role)) return denied(403, DENY_REASONS.role);
  return snap;
}

/** Engage or release the tenant kill switch, with an audit record naming the caller. */
export function setKillSwitch(deps: RemediationDeps, policy: TenantPolicy, principal: Principal | null | undefined, engaged: boolean): AdminResult {
  const gate = adminGate(deps, principal, engaged ? KILL_SWITCH_ENGAGE_ROLES : KILL_SWITCH_RELEASE_ROLES);
  if (!gate.ok) return gate;
  const r = applyKillSwitch(deps, policy, gate.principal.sub, engaged);
  return r.ok ? { ok: true, changed: r.changed } : denied(503, HUMAN_REASONS.unavailable, 'AUDIT_UNAVAILABLE');
}

/** Close a class's circuit breaker after a human has looked at why it opened. */
export function resetCircuitBreaker(deps: RemediationDeps, policy: TenantPolicy, principal: Principal | null | undefined, actionClass: string): AdminResult {
  const gate = adminGate(deps, principal, KILL_SWITCH_RELEASE_ROLES);
  if (!gate.ok) return gate;
  if (!deps.registry.classes().includes(actionClass)) return denied(400, HUMAN_REASONS.invalid);
  const r = applyBreakerReset(deps, policy, gate.principal.sub, actionClass);
  return r.ok ? { ok: true, changed: true } : denied(503, HUMAN_REASONS.unavailable, 'AUDIT_UNAVAILABLE');
}
