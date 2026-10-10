import { AGENT_COMMANDS, AgentWorkflowError, executeAgentCommand, reviewWithFrank } from '@/agent-workflows/engine';
import { seedOutcome } from '@/outcomes/model';
import { executeOutcomeCommand, OUTCOME_COMMANDS } from '@/outcomes/commands';
import { randomUUID } from 'node:crypto';
import { WORKLOADS, DEMO_NOW } from '@/data/workloads';
import { BUDGET_PROFILES } from '@/data/budgets';
import { ALERTS } from '@/data/alerts';
import { MODEL_REGISTRY } from '@/data/models';
import type { DemandShape, GovernanceGateId } from '@/types';
import type { Command, SimIdentity, Workspace } from '../types';
import { SIM_SOURCES } from '../types';

export class WorkflowError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function requireThat(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new WorkflowError(status, message);
}
export function seedWorkspace(): Workspace {
  const workloads = structuredClone(WORKLOADS);
  // Currency arithmetic at ingestion uses integer cents. The existing display model uses dollars.
  for (const w of workloads) {
    w.costs.monthly_spend = Math.round(w.costs.monthly_spend * 100) / 100;
    w.costs.recorded_mtd = w.costs.monthly_spend;
    w.value.value_ratio = w.value.total_value / w.costs.monthly_spend;
  }
  const ledger = workloads.flatMap((w, i) => {
    const total = Math.round(w.costs.monthly_spend * 100);
    const base = Math.floor(total / 25);
    return Array.from({ length: 25 }, (_, d) => ({
      category: 'model_usage' as const, id: `seed:${w.id}:${d + 1}`, source: SIM_SOURCES[i % 3], workloadId: w.id,
      date: `2026-06-${String(d + 1).padStart(2, '0')}`, cents: base + (d < total % 25 ? 1 : 0), currency: 'USD' as const,
    }));
  });
  return { agentJobs: [], schema: 2, outcomes: Object.fromEntries(workloads.map(w => [w.id, seedOutcome(w)])), revision: 0, asOf: DEMO_NOW.toISOString(), workloads, ledger,
    budgets: structuredClone(BUDGET_PROFILES), alerts: structuredClone(ALERTS), imports: [], changes: {}, dismissed: [], audit: [], deliveries: [] };
}

export function assertWorkspaceLedger(s: Workspace): void {
  requireThat(
    Array.isArray(s.workloads) && Array.isArray(s.ledger),
    'Stored financial ledger failed integrity validation.',
    500,
  );
  const workloads = new Set(s.workloads.map((w) => w.id));
  const ids = new Set<string>();
  for (const candidate of s.ledger as unknown[]) {
    requireThat(
      candidate !== null && typeof candidate === 'object',
      'Stored financial ledger failed integrity validation.',
      500,
    );
    const row = candidate as Workspace['ledger'][number];
    const parsedDate = typeof row.date === 'string' ? Date.parse(row.date) : Number.NaN;
    requireThat(
      row.category === 'model_usage' &&
        typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 200 &&
        !ids.has(row.id) &&
        SIM_SOURCES.includes(row.source as typeof SIM_SOURCES[number]) &&
        workloads.has(row.workloadId) &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        Number.isFinite(parsedDate) && new Date(parsedDate).toISOString().slice(0, 10) === row.date &&
        Number.isSafeInteger(row.cents) && row.cents >= 0 &&
        row.currency === 'USD',
      'Stored financial ledger failed integrity validation.',
      500,
    );
    ids.add(row.id);
  }
}

export function assertLedgerAppendOnly(before: Workspace, after: Workspace, allowAppend: boolean): void {
  assertWorkspaceLedger(before);
  assertWorkspaceLedger(after);
  requireThat(
    after.ledger.length >= before.ledger.length &&
      (allowAppend || after.ledger.length === before.ledger.length) &&
      before.ledger.every((row, index) => JSON.stringify(row) === JSON.stringify(after.ledger[index])),
    'Financial ledger history is append-only and cannot be rewritten.',
    500,
  );
}

export function executeCommand(input: Workspace, actor: SimIdentity, command: Command): Workspace {
  const s = structuredClone(input);
  const now = new Date().toISOString();
  const permissions: Record<string, string[]> = {
    'review-with-frank': ['technical', 'executive', 'procurement'],
    'queue-agent-review': ['technical', 'executive', 'procurement'],
    'claim-agent-job': ['technical'], 'process-agent-job': ['technical'],
    'fail-agent-job': ['technical'], 'retry-agent-job': ['technical'],
    'review-agent-proposal': ['executive', 'procurement'],
    sync: ['technical'], thresholds: ['technical', 'executive', 'procurement'],
    gate: ['technical', 'executive', 'procurement'], shape: ['technical'],
    budget: ['executive', 'procurement'], 'request-change': ['technical'],
    'approve-change': ['executive', 'procurement'], 'apply-change': ['technical'],
    'dismiss-finding': ['executive', 'technical', 'procurement'],
    'restore-findings': ['executive', 'technical', 'procurement'],
    'acknowledge-alert': ['executive', 'technical', 'procurement'],
    'simulate-delivery': ['executive', 'technical', 'procurement'],
    'model': ['technical'],
    'save-outcome-plan': ['technical', 'executive', 'procurement'],
    'verify-outcome-plan': ['executive', 'procurement'],
    'save-value-measure': ['technical', 'executive', 'procurement'],
    'remove-value-measure': ['technical', 'executive', 'procurement'],
    'save-full-cost': ['technical', 'executive', 'procurement'],
    'verify-full-cost': ['executive', 'procurement'],
    'verify-value-measure': ['executive', 'procurement'],
    'record-outcome-decision': ['executive', 'procurement'],
  };
  requireThat(Object.hasOwn(permissions, command.type), 'Unknown action.');
  requireThat(permissions[command.type].includes(actor.persona), 'This identity does not have permission for this action.', 403);
  const w = s.workloads.find(x => x.id === command.workloadId);
  const budget = s.budgets.find(x => x.workload_id === command.workloadId);
  const target = typeof command.workloadId === 'string' ? command.workloadId : String(command.jobId ?? command.source ?? command.alertId ?? 'portfolio');
  const workActions = ['thresholds', 'gate', 'shape', 'budget', 'request-change', 'approve-change', 'apply-change', 'dismiss-finding', 'model', ...OUTCOME_COMMANDS];
  if (workActions.includes(command.type)) requireThat(w && budget, 'Workload not found.', 404);
  if (command.type === 'review-with-frank' || AGENT_COMMANDS.includes(command.type)) {
    try { if (!(command.type === 'review-with-frank' ? reviewWithFrank(s, actor, command.workloadId, now) : executeAgentCommand(s, actor, command, now))) return input; }
    catch (e) { throw new WorkflowError(e instanceof AgentWorkflowError ? e.status : 500, e instanceof AgentWorkflowError ? e.message : 'Agent processing failed.'); }
  } else if (OUTCOME_COMMANDS.includes(command.type)) {
    try { executeOutcomeCommand(s, actor, command, now); }
    catch (e) { throw new WorkflowError(400, e instanceof Error ? e.message : 'Invalid outcome input.'); }
  } else switch (command.type) {
    case 'sync': {
      requireThat(SIM_SOURCES.includes(command.source as typeof SIM_SOURCES[number]), 'Unknown simulated connector.');
      const batch = `fixture-june-v1:${command.source}`;
      if (s.imports.includes(batch)) return input;
      const rows = s.ledger.filter(x => x.source === command.source && x.date === '2026-06-25');
      for (const row of rows) {
        // Fixed late-arriving charges for the same simulated billing day; replay is idempotent.
        const cents = 1250;
        s.ledger.push({ ...row, id: `${batch}:${row.workloadId}`, cents });
        const workload = s.workloads.find(x => x.id === row.workloadId)!;
        workload.costs.monthly_spend = (Math.round(workload.costs.monthly_spend * 100) + cents) / 100;
        workload.costs.recorded_mtd = workload.costs.monthly_spend;
        workload.costs.daily_spend += cents / 100;
        workload.value.value_ratio = workload.value.total_value / workload.costs.monthly_spend;
        workload.updated_at = s.asOf;
      }
      s.imports.push(batch);
      break;
    }
    case 'thresholds': {
      const { soft, hard, kill } = command;
      requireThat([soft, hard, kill].every(x => typeof x === 'number' && Number.isFinite(x)), 'Thresholds must be finite numbers.');
      requireThat((soft as number) >= .1 && (soft as number) < (hard as number) && (hard as number) < (kill as number) && (kill as number) <= 1.2, 'Use ordered thresholds: 10% ≤ soft < hard < kill ≤ 120%.');
      Object.assign(budget!, { soft_threshold_pct: soft, hard_threshold_pct: hard, kill_threshold_pct: kill });
      break;
    }
    case 'budget':
      requireThat(typeof command.amount === 'number' && Number.isFinite(command.amount) && command.amount > 0 && command.amount <= 1e9, 'Monthly budget must be between $0 and $1 billion.');
      w!.costs.monthly_budget = Math.round(command.amount * 100) / 100;
      w!.costs.daily_budget = w!.costs.monthly_budget / 30;
      // The seed profiles are daily; keep their amount consistent with that period.
      budget!.budget_amount = budget!.period === 'monthly' ? w!.costs.monthly_budget : budget!.period === 'weekly' ? w!.costs.daily_budget * 7 : w!.costs.daily_budget;
      break;
    case 'gate': {
      const keys = ['policy_check', 'ethics_review', 'cost_approval', 'scale_authorized'] as const;
      const gates: GovernanceGateId[] = ['policy', 'ethics', 'cost', 'scale'];
      const idx = gates.indexOf(command.gate as GovernanceGateId);
      requireThat(idx >= 0, 'Unknown governance gate.');
      requireThat(idx < 2 ? actor.persona === 'technical' : actor.persona !== 'technical', 'This identity does not have permission for this gate.', 403);
      const turningOn = !w!.governance[keys[idx]];
      if (turningOn) {
        requireThat(keys.slice(0, idx).every(k => w!.governance[k]), 'Approve preceding governance gates first.', 409);
        if (idx === 2) requireThat(w!.value.value_ratio >= 3 && w!.costs.monthly_budget > 0, 'Cost approval requires a funded budget and at least 3× value.', 409);
        if (idx === 3) requireThat(w!.demand_shape !== 'unmanaged', 'Choose a managed demand shape before scale approval.', 409);
        w!.governance[keys[idx]] = true;
      } else {
        keys.slice(idx).forEach(k => { w!.governance[k] = false; });
        if (w!.demand_shape === 'always_on') w!.demand_shape = 'paused';
      }
      w!.governance.approved_by = actor.user;
      w!.governance.last_reviewed = now;
      break;
    }
    case 'shape': {
      const shapes: DemandShape[] = ['always_on', 'business_hours', 'throttled', 'batch_offpeak', 'paused', 'unmanaged'];
      requireThat(shapes.includes(command.shape as DemandShape), 'Unknown demand shape.');
      if (command.shape === 'always_on') requireThat(w!.governance.policy_check && w!.governance.ethics_review && w!.governance.cost_approval && w!.governance.scale_authorized, 'All four gates must pass for Always-On.', 409);
      w!.demand_shape = command.shape as DemandShape;
      break;
    }
    case 'model': {
      const model = MODEL_REGISTRY.find(m => m.model_name === command.model);
      requireThat(model, 'Unknown model.');
      requireThat(w!.governance.cost_approval, 'Cost approval is required before simulating a model switch.', 409);
      w!.model = model.model_name; w!.model_provider = model.provider;
      // Historical billed cost is immutable; model comparison remains prospective.
      break;
    }
    case 'request-change':
      requireThat(!s.changes[w!.id], 'A change is already tracked for this workload.', 409);
      s.changes[w!.id] = { ref: `SIM-${s.revision + 1}`, workloadId: w!.id, status: 'requested', requestedBy: actor.user, updatedAt: now };
      break;
    case 'approve-change': {
      const c = s.changes[w!.id];
      requireThat(c?.status === 'requested', 'A requested change is required.', 409);
      requireThat(c.requestedBy !== actor.user, 'A requester cannot approve their own change.', 403);
      c.status = 'approved'; c.approvedBy = actor.user; c.updatedAt = now;
      break;
    }
    case 'apply-change': {
      const c = s.changes[w!.id];
      requireThat(c?.status === 'approved', 'An approved change is required.', 409);
      c.status = 'applied'; c.appliedBy = actor.user; c.updatedAt = now;
      w!.demand_shape = 'business_hours';
      break;
    }
    case 'dismiss-finding':
      if (!s.dismissed.includes(w!.id)) s.dismissed.push(w!.id);
      break;
    case 'restore-findings': s.dismissed = []; break;
    case 'acknowledge-alert': {
      const alert = s.alerts.find(a => a.id === command.alertId);
      requireThat(alert, 'Alert not found.', 404);
      alert.acknowledged = true; alert.acknowledged_by = actor.user;
      break;
    }
    case 'simulate-delivery':
      requireThat(command.channel === 'email' || command.channel === 'slack', 'Unknown delivery channel.');
      s.deliveries.push({ id: randomUUID(), channel: command.channel, status: 'simulated', at: now });
      break;
  }
  assertLedgerAppendOnly(input, s, command.type === 'sync');
  s.revision += 1;
  s.audit.push({ id: randomUUID(), at: now, actor: actor.user, persona: actor.persona, action: command.type, target });
  return s;
}
