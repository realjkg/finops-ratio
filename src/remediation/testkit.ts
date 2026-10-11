// Test-only builders for the remediation suites. Not imported by application code.
// Everything is deterministic: the clock is a plain counter, the executor is the in-memory double.
import type { DeployEnv, Principal, Role } from '@/identity/types';
import { createAuditLog, type AuditLog } from './audit';
import { InMemoryExecutor } from './executor';
import type { RemediationDeps } from './orchestrator';
import { createEmptyPolicy, parseTenantPolicy, type TenantPolicy } from './policy';
import { parseProposal } from './proposal';
import { ACTION_REGISTRY } from './registry';
import { createState, type CreateStateOptions, type RemediationState } from './state';
import type { Proposal, ProposalOrigin } from './types';

export const TENANT = 't1';
export const PLATFORM = 'Platform Eng';
export const CX = 'CX Engineering';
/** A fixed "now" in epoch milliseconds. */
export const NOW = 1_800_000_000_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export interface Clock {
  now: () => number;
  set: (t: number) => void;
  advance: (ms: number) => void;
}
export function makeClock(start = NOW): Clock {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

export const classPolicy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  environments: ['dev', 'test'], maxResourcesPerAction: 5, maxCostAtStakePerAction: 100_000,
  window: { lengthMs: HOUR, maxResources: 10, maxCostAtStake: 250_000 }, cooldownMs: 10 * MINUTE, ...over,
});

export const rawPolicy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 'p-1', tenant: TENANT, currency: 'USD', circuitBreakerThreshold: 3, dryRunMaxAgeMs: 5 * MINUTE, approvalMaxAgeMs: 24 * HOUR,
  freezeWindows: [], denyClasses: [], classes: { idle_stop: classPolicy(), schedule: classPolicy() }, ...over,
});

export function mustPolicy(raw: unknown): TenantPolicy {
  const r = parseTenantPolicy(ACTION_REGISTRY, raw);
  if (!r.ok) throw new Error(`test policy rejected: ${r.code} ${r.field ?? ''}`);
  return r.policy;
}

/** A policy that enables idle_stop and schedule (dev and test only). */
export const enabledPolicy = (over: Record<string, unknown> = {}): TenantPolicy => mustPolicy(rawPolicy(over));
export const emptyPolicy = (tenant = TENANT): TenantPolicy => createEmptyPolicy(tenant);

export const stopInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'prop-1', tenant: TENANT, actionId: 'stop_idle_dev_instance', env: 'dev', team: PLATFORM,
  params: { instanceIds: ['i-aaa'], idleDays: 14 },
  impact: { currency: 'USD', estimatedMonthlySavingsMinor: 5_000, costAtStakeMinor: 6_000 }, ...over,
});

export const scheduleInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'prop-s1', tenant: TENANT, actionId: 'schedule_on_off', env: 'dev', team: PLATFORM,
  params: { resourceIds: ['i-sched'], onHourUtc: 8, offHourUtc: 18, weekdaysOnly: true },
  impact: { currency: 'USD', estimatedMonthlySavingsMinor: 3_000, costAtStakeMinor: 9_000 }, ...over,
});

export const resizeInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'prop-r1', tenant: TENANT, actionId: 'resize_down', env: 'dev', team: PLATFORM,
  params: { resourceId: 'i-big', fromSize: 'm5.2xlarge', toSize: 'm5.xlarge' },
  impact: { currency: 'USD', estimatedMonthlySavingsMinor: 7_000, costAtStakeMinor: 14_000 }, ...over,
});

export const deleteVolumeInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'prop-d1', tenant: TENANT, actionId: 'delete_unattached_volume', env: 'dev', team: PLATFORM,
  params: { volumeIds: ['vol-1'], unattachedDays: 30 },
  impact: { currency: 'USD', estimatedMonthlySavingsMinor: 800, costAtStakeMinor: 800 }, ...over,
});

export const commitmentInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'prop-c1', tenant: TENANT, actionId: 'buy_commitment', env: 'prod', team: PLATFORM,
  params: { scopeId: 'acct-1', commitmentKind: 'compute_savings_plan', term: '1y', payment: 'no_upfront', monthlyCommitMinor: 50_000 },
  impact: { currency: 'USD', estimatedMonthlySavingsMinor: 9_000, costAtStakeMinor: 600_000 }, ...over,
});

/** Parse a proposal or fail the test loudly. */
export function mustProposal(input: unknown, origin: ProposalOrigin = 'system'): Proposal {
  const r = parseProposal(ACTION_REGISTRY, input, origin);
  if (!r.ok) throw new Error(`test proposal rejected: ${r.code} ${r.field ?? ''} ${r.paramCode ?? ''}`);
  return r.proposal;
}

export interface Env {
  deps: RemediationDeps;
  executor: InMemoryExecutor;
  audit: AuditLog;
  state: RemediationState;
  clock: Clock;
  policy: TenantPolicy;
}

export function mkEnv(o: { policy?: TenantPolicy; tenant?: string; auditMax?: number; state?: CreateStateOptions; clock?: Clock } = {}): Env {
  const tenant = o.tenant ?? TENANT;
  const clock = o.clock ?? makeClock();
  const executor = new InMemoryExecutor();
  const audit = createAuditLog(tenant, o.auditMax === undefined ? {} : { maxRecords: o.auditMax });
  const state = createState(tenant, o.state);
  const policy = o.policy ?? enabledPolicy();
  return { deps: { registry: ACTION_REGISTRY, executor, audit, state, now: clock.now }, executor, audit, state, clock, policy };
}

export function principal(role: Role, over: Partial<Principal> = {}): Principal {
  return {
    sub: `sub-${role}`, role, teams: role === 'eng_lead' ? [PLATFORM] : '*', envs: ['dev', 'test', 'prod'] as DeployEnv[], tenant: TENANT,
    tokenId: `jti-${role}`, expiresAt: 4_102_444_800, authMethod: role === 'legacy_service' ? 'legacy-shared-token' : 'mock-idp', ...over,
  };
}

/** Distinct principals for the usual three-person flow. */
export const requester = (): Principal => principal('finops_lead', { sub: 'sub-requester' });
export const approver = (): Principal => principal('cto', { sub: 'sub-approver' });
export const applier = (): Principal => principal('eng_lead', { sub: 'sub-applier' });
