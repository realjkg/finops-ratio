// Mutable run-time state for one tenant: proposals, idempotency results, dry-run evidence,
// resource locks and cooldowns, rolling-window usage, circuit breakers, the kill switch.
// Trust boundary: internal. Only the orchestrator and the admin helpers mutate it; callers
// pass it to `decide`, which only reads. State is per tenant (a tenant mismatch is refused),
// and every collection has a cap: when a cap is reached the operation is refused (fail closed)
// rather than evicting an entry that a safety rail depends on.
import { ID_PATTERN } from './proposal';
import { LIMITS, type Decision, type Proposal, type RunResult } from './types';

export interface StateLimits {
  readonly maxProposals: number;
  readonly maxWindowEntries: number;
  readonly maxTrackedResources: number;
}

export interface DryRunEvidence {
  readonly ok: boolean;
  readonly at: number;
}

export type ProposalStatus = 'proposed' | 'approved' | 'executed' | 'failed' | 'rolled_back' | 'denied';

export interface ProposalRecord {
  readonly proposal: Proposal;
  /** SHA-256 of the canonical proposal, so a replay with a different payload is detectable. */
  readonly digest: string;
  readonly requestedBy: string;
  status: ProposalStatus;
  decision: Decision;
  approvedBy: string | null;
  approvedAt: number | null;
}

export interface RollbackEntry {
  readonly proposalId: string;
  readonly actionId: string;
  readonly actionClass: string;
  readonly env: Proposal['env'];
  readonly resourceIds: readonly string[];
  readonly token: string;
  readonly createdAt: number;
  rolledBack: boolean;
}

export interface WindowEntry {
  readonly at: number;
  readonly actionClass: string;
  readonly resources: number;
  readonly currency: string;
  readonly costMinor: bigint;
}

export interface BreakerState {
  consecutiveFailures: number;
  open: boolean;
}

export interface KillSwitchState {
  engaged: boolean;
  changedBy: string | null;
  changedAt: number | null;
}

export interface RemediationState {
  readonly tenant: string;
  readonly limits: StateLimits;
  readonly killSwitch: KillSwitchState;
  /** Optional operator-owned halt that applies across tenants. Throwing counts as halted. */
  readonly platformHalt?: () => boolean;
  readonly proposals: Map<string, ProposalRecord>;
  /** The first terminal result per proposal id. Replays return it. */
  readonly executions: Map<string, RunResult>;
  readonly inflight: Map<string, Promise<RunResult>>;
  readonly dryRuns: Map<string, DryRunEvidence>;
  /** Resources with an execution in flight. */
  readonly locks: Set<string>;
  /** Last time each resource was touched, for cooldowns. */
  readonly lastTouched: Map<string, number>;
  windowUsage: WindowEntry[];
  readonly breakers: Map<string, BreakerState>;
  readonly rollbacks: Map<string, RollbackEntry>;
}

export interface CreateStateOptions {
  /** Lower the default caps (never raise them). */
  readonly limits?: Partial<StateLimits>;
  readonly platformHalt?: () => boolean;
}

const clamp = (v: number | undefined, max: number): number =>
  v !== undefined && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : max;

export function createState(tenant: string, opts: CreateStateOptions = {}): RemediationState {
  if (typeof tenant !== 'string' || !ID_PATTERN.test(tenant)) throw new Error('Invalid tenant');
  return {
    tenant,
    limits: Object.freeze({
      maxProposals: clamp(opts.limits?.maxProposals, LIMITS.maxProposals),
      maxWindowEntries: clamp(opts.limits?.maxWindowEntries, LIMITS.maxWindowEntries),
      maxTrackedResources: clamp(opts.limits?.maxTrackedResources, LIMITS.maxTrackedResources),
    }),
    killSwitch: { engaged: false, changedBy: null, changedAt: null },
    ...(opts.platformHalt ? { platformHalt: opts.platformHalt } : {}),
    proposals: new Map(),
    executions: new Map(),
    inflight: new Map(),
    dryRuns: new Map(),
    locks: new Set(),
    lastTouched: new Map(),
    windowUsage: [],
    breakers: new Map(),
    rollbacks: new Map(),
  };
}

/** True if autonomy is halted: the tenant switch is engaged, or the platform halt is on (or throws). */
export function isHalted(state: RemediationState): boolean {
  if (state.killSwitch.engaged) return true;
  if (!state.platformHalt) return false;
  try {
    return state.platformHalt() !== false; // anything but an explicit false halts
  } catch {
    return true;
  }
}

/** Drop window entries older than the longest allowed window; they can never count again. */
export function pruneWindow(state: RemediationState, now: number): void {
  const floor = now - LIMITS.maxWindowMs;
  if (state.windowUsage.length > 0 && state.windowUsage[0].at <= floor) state.windowUsage = state.windowUsage.filter((e) => e.at > floor);
}

/** Drop cooldown timestamps older than the longest allowed cooldown. */
export function pruneTouched(state: RemediationState, now: number): void {
  if (state.lastTouched.size < state.limits.maxTrackedResources) return;
  const floor = now - LIMITS.maxCooldownMs;
  for (const [k, at] of state.lastTouched) if (at <= floor && !state.locks.has(k)) state.lastTouched.delete(k);
}
