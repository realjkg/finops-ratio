// The executor interface and an in-memory test double. Trust boundary: the executor is the
// ONLY place a real effect would happen, and none ships in this build. A real adapter would
// implement `Executor` for one cloud; it must enforce its own deadline (the orchestrator has
// no timers, to stay deterministic) and must return only the fixed codes below. The
// orchestrator treats every executor answer as untrusted: it validates the shape and the
// rollback token, maps any thrown error to a fixed code, and never records executor text.
import type { DeployEnv } from '@/identity/types';
import { LIMITS } from './types';

export interface ExecutableAction {
  readonly proposalId: string;
  readonly tenant: string;
  readonly actionId: string;
  readonly actionClass: string;
  readonly env: DeployEnv;
  readonly resourceIds: readonly string[];
  readonly params: Readonly<Record<string, unknown>>;
}

export interface RollbackRecord {
  readonly proposalId: string;
  readonly tenant: string;
  readonly actionId: string;
  readonly actionClass: string;
  readonly env: DeployEnv;
  readonly resourceIds: readonly string[];
  /** Opaque handle issued by the executor; sufficient to undo the effect. */
  readonly token: string;
  readonly createdAt: number;
}

export type ExecFailureCode = 'EXEC_REJECTED' | 'EXEC_TIMEOUT' | 'EXEC_PARTIAL' | 'EXEC_UNKNOWN';
export const EXEC_FAILURE_CODES: readonly ExecFailureCode[] = Object.freeze(['EXEC_REJECTED', 'EXEC_TIMEOUT', 'EXEC_PARTIAL', 'EXEC_UNKNOWN'] as const);

export type ExecuteResult =
  | { readonly ok: true; readonly rollbackToken?: string }
  /** A failure may still carry a token when part of the effect was applied. */
  | { readonly ok: false; readonly code: ExecFailureCode; readonly rollbackToken?: string };

export interface Executor {
  /** With dryRun true the executor must change nothing and report whether it would succeed. */
  execute(action: ExecutableAction, opts: { dryRun: boolean }): Promise<ExecuteResult>;
  /** Verify the effect after execution (for example, the instance is really stopped). */
  postCheck(action: ExecutableAction): Promise<{ readonly ok: boolean }>;
  rollback(record: RollbackRecord): Promise<{ readonly ok: boolean }>;
}

export const ROLLBACK_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const isRollbackToken = (v: unknown): v is string => typeof v === 'string' && v.length <= LIMITS.maxRollbackTokenLen && ROLLBACK_TOKEN.test(v);

// ---------------------------------------------------------------------------
// In-memory double with failure injection
// ---------------------------------------------------------------------------

export type FailPhase = 'dry_run' | 'execute' | 'post_check' | 'rollback';
/** fail: report failure; throw: throw an Error; partial (execute only): apply the effect, then report failure with a token. */
export type FailMode = 'fail' | 'throw' | 'partial';

export interface Injection {
  readonly phase: FailPhase;
  readonly mode: FailMode;
  /** How many matching calls to fail; default 1. */
  readonly times?: number;
  /** Restrict to one proposal id. */
  readonly proposalId?: string;
}

export interface ExecutorCall {
  readonly phase: FailPhase;
  readonly proposalId: string;
  readonly dryRun: boolean;
}

export class InMemoryExecutor implements Executor {
  readonly calls: ExecutorCall[] = [];
  /** proposalId -> live effect. An entry exists from a successful or partial execute until it is rolled back. */
  readonly effects = new Map<string, { resourceIds: readonly string[]; token: string; rolledBack: boolean }>();
  /** Called before every real (non-dry-run) execute; lets a test hold a run open to force interleaving. */
  beforeExecute: ((action: ExecutableAction) => Promise<void>) | null = null;
  private injections: { i: Injection; left: number }[] = [];
  private counter = 0;

  inject(i: Injection): void {
    this.injections.push({ i, left: i.times ?? 1 });
  }

  clearInjections(): void {
    this.injections = [];
  }

  get executeCount(): number {
    return this.calls.filter((c) => c.phase === 'execute' && !c.dryRun).length;
  }

  get liveEffectCount(): number {
    return [...this.effects.values()].filter((e) => !e.rolledBack).length;
  }

  private take(phase: FailPhase, proposalId: string): FailMode | null {
    const hit = this.injections.find((x) => x.left > 0 && x.i.phase === phase && (x.i.proposalId === undefined || x.i.proposalId === proposalId));
    if (!hit) return null;
    hit.left -= 1;
    return hit.i.mode;
  }

  async execute(action: ExecutableAction, opts: { dryRun: boolean }): Promise<ExecuteResult> {
    this.calls.push({ phase: opts.dryRun ? 'dry_run' : 'execute', proposalId: action.proposalId, dryRun: opts.dryRun });
    const mode = this.take(opts.dryRun ? 'dry_run' : 'execute', action.proposalId);
    if (opts.dryRun) {
      if (mode === 'throw') throw new Error('injected dry-run failure');
      return mode ? { ok: false, code: 'EXEC_REJECTED' } : { ok: true };
    }
    if (this.beforeExecute) await this.beforeExecute(action);
    if (mode === 'throw') throw new Error('injected execute failure');
    if (mode === 'fail') return { ok: false, code: 'EXEC_REJECTED' };
    this.counter += 1;
    const token = `rbk-${this.counter}`;
    this.effects.set(action.proposalId, { resourceIds: action.resourceIds, token, rolledBack: false });
    return mode === 'partial' ? { ok: false, code: 'EXEC_PARTIAL', rollbackToken: token } : { ok: true, rollbackToken: token };
  }

  async postCheck(action: ExecutableAction): Promise<{ ok: boolean }> {
    this.calls.push({ phase: 'post_check', proposalId: action.proposalId, dryRun: false });
    const mode = this.take('post_check', action.proposalId);
    if (mode === 'throw') throw new Error('injected post-check failure');
    return { ok: mode === null };
  }

  async rollback(record: RollbackRecord): Promise<{ ok: boolean }> {
    this.calls.push({ phase: 'rollback', proposalId: record.proposalId, dryRun: false });
    const mode = this.take('rollback', record.proposalId);
    if (mode === 'throw') throw new Error('injected rollback failure');
    if (mode) return { ok: false };
    const e = this.effects.get(record.proposalId);
    if (!e || e.token !== record.token || e.rolledBack) return { ok: false }; // unknown token, or already undone
    e.rolledBack = true;
    return { ok: true };
  }
}
