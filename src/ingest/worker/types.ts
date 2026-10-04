// Shared worker types: hooks (test seams / failure injection), results.
import { IngestError } from '../errors';
import { isTenantId } from '../db/tenant';

export type PublishStep = 'lock_run' | 'lock_period' | 'supersede_prior' | 'mark_published' | 'upsert_publication' | 'advance_checkpoint' | 'commit';

export interface HookContext {
  runId: string;
  batchId: string;
  billingPeriod: string;
}

/**
 * Programmatic seams. They are NOT reachable from the CLI or environment
 * (the only env-driven hook is the NODE_ENV=test kill pause, see config.ts).
 */
export interface WorkerHooks {
  /** Called before each step of the publish transaction; throwing aborts it (rollback). */
  beforePublishStep?(step: PublishStep, ctx: HookContext): Promise<void> | void;
  /** Called inside the quarantine transaction just before COMMIT; throwing aborts it. */
  beforeQuarantineCommit?(ctx: HookContext): Promise<void> | void;
  /** Called after reconciliation, before the publish transaction starts. */
  beforePublish?(ctx: HookContext): Promise<void> | void;
  /** Called after each committed fact chunk. */
  afterChunk?(info: { runId: string; batchId: string; artifactSha256: string; chunkRows: number; rowsInserted: number }): Promise<void> | void;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

/**
 * Thrown by a hook to simulate the process dying: the pipeline propagates it
 * WITHOUT finishing the run or cleaning up (the run stays `running` until its
 * lease expires), exactly like a killed process.
 */
export class SimulatedCrash extends Error {
  constructor(message = 'simulated crash') {
    super(message);
    this.name = 'SimulatedCrash';
  }
}

export type PeriodOutcome = 'published' | 'republished' | 'unchanged' | 'skipped_unchanged' | 'skipped_pinned' | 'quarantined' | 'failed';

export interface PeriodResult {
  billingPeriod: string;
  outcome: PeriodOutcome;
  batchId?: string;
  code?: string;
  message?: string;
  rowCount?: string;
  billedTotal?: string;
  reconciliation?: 'reconciled' | 'unverified' | 'variance';
  artifactSetFingerprint?: string;
}

export interface RunResult {
  runId: string;
  status: 'succeeded' | 'failed';
  periods: PeriodResult[];
  errorCode?: string;
  attempts: number;
  /** Evidence keys of the manifests stored during this run. */
  manifestEvidence: string[];
}

export const SUCCESS_OUTCOMES: ReadonlySet<PeriodOutcome> = new Set(['published', 'republished', 'unchanged', 'skipped_unchanged', 'skipped_pinned']);

/** Canonical lower-case tenant id, or INVALID_TENANT before any query runs. */
export function canonicalTenant(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || !isTenantId(tenantId)) throw new IngestError('INVALID_TENANT', 'tenant id must be a canonical UUID');
  return tenantId.toLowerCase();
}
