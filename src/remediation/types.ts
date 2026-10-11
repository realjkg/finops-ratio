// Shared vocabulary for governed remediation: caps, fixed reason codes, result shapes.
// Trust boundary: none of these types carry input; every string a caller can see from this
// module is a member of a fixed set, so no error ever echoes caller input.
import type { ChangeImpact, DeployEnv } from '@/identity/types';

/** The fixed actor id recorded when autonomy (no human) acts. Humans may never use it. */
export const SERVICE_ACTOR_ID = 'svc:remediation-autonomy';
/** Reserved prefix: a human `sub` that starts with this is refused, so it cannot impersonate the service. */
export const RESERVED_ACTOR_PREFIX = 'svc:';

/** Caps. Every collection and every string in this module is bounded by one of these. */
export const LIMITS = Object.freeze({
  maxParamKeys: 16,
  maxIdLen: 64,
  maxResourceIdLen: 128,
  maxTeamLen: 64,
  maxResourcesHard: 100,
  maxRegistryActions: 64,
  maxPolicyClasses: 16,
  maxFreezeWindows: 32,
  maxProposals: 10_000,
  maxWindowEntries: 10_000,
  maxTrackedResources: 50_000,
  maxAuditRecords: 100_000,
  maxAuditRecordBytes: 1024,
  maxAuditDetailKeys: 12,
  maxAuditDetailValueLen: 120,
  auditHeadroom: 8, // records kept in reserve so the closing records of a run can always be written
  maxWindowMs: 30 * 24 * 60 * 60 * 1000,
  maxCooldownMs: 30 * 24 * 60 * 60 * 1000,
  maxFreezeMs: 90 * 24 * 60 * 60 * 1000,
  maxApprovalAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxRollbackTokenLen: 128,
});

export type RiskTier = 'low' | 'medium' | 'high';
export const RISK_TIERS: readonly RiskTier[] = Object.freeze(['low', 'medium', 'high'] as const);
export const CHANGE_IMPACTS: readonly ChangeImpact[] = Object.freeze(['cost', 'commitment', 'operational'] as const);

/** Who originated a proposal. Only a system-originated proposal can ever be auto-executed. */
export type ProposalOrigin = 'system' | 'human';

/** The descriptor of what an action would touch. Resource count is derived from the validated params. */
export interface BlastRadius {
  readonly resourceCount: number;
  readonly currency: string;
  /** Monthly run-rate cost of the affected resources (for a commitment: the total obligation), in minor units. */
  readonly costAtStakeMinor: bigint;
}

/** Figures supplied by the trusted recommendation pipeline (never by an end user), in minor units. */
export interface ProposedImpact {
  readonly currency: string;
  readonly estimatedMonthlySavingsMinor: bigint;
  readonly costAtStakeMinor: bigint;
}

/** A frozen copy of the registry facts a decision depends on. Taken from the registry, never from the caller. */
export interface ActionMeta {
  readonly id: string;
  readonly class: string;
  readonly risk: RiskTier;
  readonly reversible: boolean;
  readonly autonomyEligible: boolean;
  readonly impact: ChangeImpact;
}

/**
 * A validated proposal. Only `parseProposal` can create one (it is registered in a module
 * WeakSet), so `decide` can trust the derived fields: class, risk, resource list and count.
 */
export interface Proposal {
  readonly id: string;
  readonly tenant: string;
  readonly origin: ProposalOrigin;
  readonly env: DeployEnv;
  readonly team: string;
  readonly action: ActionMeta;
  readonly params: Readonly<Record<string, unknown>>;
  readonly resourceIds: readonly string[];
  readonly impact: ProposedImpact;
  readonly blastRadius: BlastRadius;
}

/** Gates that deny outright (the request is not eligible for the approval path either). */
export const DENY_CODES = Object.freeze(['BAD_PROPOSAL', 'TENANT_MISMATCH', 'CLASS_DENIED'] as const);
export type DenyCode = (typeof DENY_CODES)[number];

/** Gates that route a proposal to a human. Each one is checked independently. */
export const ROUTE_CODES = Object.freeze([
  'HUMAN_ORIGIN', 'BAD_TIME', 'POLICY_INVALID', 'CLASS_NOT_ENABLED', 'ACTION_NOT_ELIGIBLE', 'ENV_NOT_ALLOWED',
  'PROD_NOT_PERMITTED', 'DRY_RUN_NOT_PASSED', 'COUNT_CAP', 'CURRENCY_MISMATCH', 'COST_CAP', 'WINDOW_COUNT_CAP',
  'WINDOW_COST_CAP', 'COOLDOWN', 'RESOURCE_BUSY', 'KILL_SWITCH', 'CHANGE_FREEZE', 'CIRCUIT_OPEN',
] as const);
export type RouteCode = (typeof ROUTE_CODES)[number];

export type ReasonCode = DenyCode | RouteCode | 'AUTO_ALL_GATES_PASSED';

export interface Decision {
  readonly kind: 'auto_execute' | 'require_approval' | 'deny';
  /** The first gate that failed, in a fixed order, or AUTO_ALL_GATES_PASSED. */
  readonly reason: ReasonCode;
  /** Every gate that failed, so an approver sees the whole picture. Empty for auto_execute. */
  readonly blockers: readonly ReasonCode[];
  readonly policyVersion: string;
}

/** Outcome of one run of a proposal through the orchestrator. */
export type RunStatus =
  | 'succeeded' // executed and the post-check passed
  | 'failed' // execution failed and nothing could be rolled back
  | 'rolled_back' // execution or post-check failed, and the rollback succeeded
  | 'rollback_failed' // a rollback was needed and failed: a human must intervene
  | 'dry_run_failed' // no effect occurred
  | 'not_executed' // policy routed the proposal to a human, or denied it
  | 'rejected'; // a precondition failed; nothing was executed

export type RunReason =
  | 'OK' | 'EXECUTE_FAILED' | 'POSTCHECK_FAILED' | 'ROLLBACK_FAILED' | 'ROLLBACK_TOKEN_MISSING' | 'NO_ROLLBACK_AVAILABLE'
  | 'DRY_RUN_FAILED' | 'NOT_FOUND' | 'BAD_STATE' | 'NOT_APPROVED' | 'APPROVAL_EXPIRED' | 'RESOURCE_BUSY' | 'HALTED' | 'AUDIT_UNAVAILABLE'
  | 'BAD_TIME' | 'CAPACITY' | 'INTERNAL_ERROR' | 'TENANT_MISMATCH' | 'CLASS_DENIED' | ReasonCode;

export interface RunResult {
  readonly proposalId: string;
  readonly status: RunStatus;
  readonly reason: RunReason;
  /** True when this is a replay of an earlier result rather than a new run. */
  readonly replayed: boolean;
  readonly decision?: Decision;
}

export type { ChangeImpact, DeployEnv };
