import type { AgentJob } from '@/agent-workflows/types';
import type { OutcomeRecord } from '@/outcomes/types';
import type { Persona } from '@/lib/persona';
import type { Alert, BudgetProfile, Workload } from '@/types';

export interface SimIdentity { tenant: string; user: string; persona: Persona }
export interface CostEntry { category: 'model_usage'; id: string; source: string; workloadId: string; date: string; cents: number; currency: 'USD' }
export interface SimChange {
  ref: string; workloadId: string; status: 'requested' | 'approved' | 'applied';
  requestedBy: string; approvedBy?: string; appliedBy?: string; updatedAt: string;
}
export interface AuditEntry { id: string; at: string; actor: string; persona: Persona; action: string; target: string }
export interface Workspace {
  agentJobs: AgentJob[]; schema: 2; revision: number; asOf: string; workloads: Workload[]; budgets: BudgetProfile[]; alerts: Alert[];
  outcomes: Record<string, OutcomeRecord>; ledger: CostEntry[]; imports: string[]; changes: Record<string, SimChange>; dismissed: string[];
  audit: AuditEntry[]; deliveries: { id: string; channel: 'email' | 'slack'; status: 'simulated'; at: string }[];
}
export interface SimSession { identity: SimIdentity; csrf: string; expiresAt: number }
// Commands are validated at the server boundary; callers cannot submit an entire state document.
export type Command = { type: string; [key: string]: unknown };
export const PERSONA_LABELS = { executive: 'Executive', technical: 'Technical', procurement: 'Procurement' } as const;
export const SIM_SOURCES = ['aws', 'azure', 'gcp'] as const;
