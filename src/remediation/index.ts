// Public surface of governed remediation. See README.md for the design, caps and known gaps.
// Not exported on purpose: the orchestrator's kill-switch and breaker helpers (applyKillSwitch,
// applyBreakerReset), which skip authorization and are reachable only through human.ts, and
// the test kit.
export { SERVICE_ACTOR_ID, LIMITS, DENY_CODES, ROUTE_CODES } from './types';
export type { Decision, Proposal, RunResult, RunStatus, ReasonCode, RiskTier } from './types';
export { ACTION_REGISTRY, SEED_ACTIONS, buildRegistry, RegistryInvariantError } from './registry';
export type { ActionDefinition, ActionRegistry } from './registry';
export { validateParams, PARAM_ERROR_TEXT } from './schema';
export { parseProposal, PROPOSAL_ERROR_TEXT } from './proposal';
export { parseTenantPolicy, createEmptyPolicy, POLICY_ERROR_TEXT } from './policy';
export type { TenantPolicy, ClassPolicy } from './policy';
export { decide } from './decide';
export { createState } from './state';
export type { RemediationState } from './state';
export { createAuditLog, verifyChain } from './audit';
export type { AuditLog, AuditRecord, ChainResult } from './audit';
export { InMemoryExecutor } from './executor';
export type { Executor, ExecutableAction, ExecuteResult, RollbackRecord } from './executor';
export { submitSystemProposal, runProposal, rollbackProposal } from './orchestrator';
export type { RemediationDeps, SubmitResult } from './orchestrator';
export { requestChange, approveChange, applyChange, rollbackChange, setKillSwitch, resetCircuitBreaker, HUMAN_REASONS } from './human';
export type { HumanDenied, RequestResult, ApproveResult, ApplyResult, RollbackResult } from './human';
