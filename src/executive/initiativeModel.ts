// Executive surface view-model (Ratio v2 Wave 2a). The Initiative Dashboard is a
// pure projection of the *same* engine the technical Mission Board reads — no new
// math, no backend change. It re-labels the existing mission view-model into
// executive vocabulary (Initiative / Budget consumed / Cost efficiency) and adds
// the board-level Spend Summary, all derived from the bundled mock seed.
//
// Status mapping (mission → executive):
//   nominal  -> on_track          (value green)
//   caution  -> at_risk           (shape amber)
//   critical -> pending_approval  (gate purple — a decision is required)

import { budgetFor } from '@/data/budgets';
import { DEMO_NOW, WORKLOADS } from '@/data/workloads';
import { computeBudgetStatus } from '@/lib/budgetStatus';
import { headlineEvidenceStatus } from '@/lib/valueEvidence';
import { budgetColor, TOKEN_HEX } from '@/lib/scales';
import type { EvidenceStatus, Workload } from '@/types';
import { COST_SOURCES, findingsFor } from '@/costsource/seed';
import { toMissionView, type MissionStatus, type ProjectionContext } from '@/mission/missionModel';

export type InitiativeStatus = 'on_track' | 'at_risk' | 'pending_approval';

export interface InitiativeStatusMeta {
  label: string;
  color: string;
}

export const INITIATIVE_STATUS_META: Record<InitiativeStatus, InitiativeStatusMeta> = {
  on_track: { label: 'On Track', color: TOKEN_HEX.value },
  at_risk: { label: 'At Risk', color: TOKEN_HEX.shape },
  pending_approval: { label: 'Pending Approval', color: TOKEN_HEX.gate },
};

const MISSION_TO_INITIATIVE: Record<MissionStatus, InitiativeStatus> = {
  nominal: 'on_track',
  caution: 'at_risk',
  critical: 'pending_approval',
};

export interface InitiativeView {
  id: string;
  name: string;
  // Monthly run-rate cost — the headline number executives read first.
  monthlyCost: number;
  // Month-to-date budget consumed (0..100, clamped) + its threshold color.
  budgetConsumedPct: number;
  budgetConsumedColor: string;
  status: InitiativeStatus;
  // Cost efficiency = value ratio (R4 — cost is always paired with value).
  valueRatio: number;
  valueColor: string;
  /** Provenance mark on the ratio — weakest value input's status (audit C1/C2). */
  valueEvidenceStatus?: EvidenceStatus;
}

export interface SpendSummary {
  totalMonthlySpend: number;
  projectedSavings: number;
  initiativesActive: number;
  pendingApproval: number;
}

export function toInitiativeView(workload: Workload, context: ProjectionContext = {}): InitiativeView {
  const budget = context.budgets ? context.budgets.find(b => b.workload_id === workload.id) : budgetFor(workload.id);
  if (!budget) throw new Error(`No budget profile for workload ${workload.id}`);

  // Reuse the mission view-model so status + value coloring stay identical to
  // the technical surface (one source of truth, persona-projected).
  const mission = toMissionView(workload, context);
  const status = computeBudgetStatus(workload, budget, context.now ?? DEMO_NOW);
  const consumedRatio = status.monthly.pctUsed;

  return {
    id: workload.id,
    name: workload.name,
    monthlyCost: workload.costs.monthly_spend,
    budgetConsumedPct: Math.min(Math.round(consumedRatio * 100), 100),
    budgetConsumedColor: budgetColor(consumedRatio),
    status: MISSION_TO_INITIATIVE[mission.status],
    valueRatio: mission.valueRatio,
    valueColor: mission.valueColor,
    valueEvidenceStatus: headlineEvidenceStatus(workload.value),
  };
}

// Projected savings = sum of estimated monthly savings across the findings the
// configured cost sources surface (the same seed the CostSource page reads).
function projectedSavingsFromFindings(): number {
  const total = COST_SOURCES.filter(
    (s) => s.configured && s.capabilities.includes('findings'),
  )
    .flatMap((s) => findingsFor(s.id))
    .reduce((sum, f) => sum + f.estimatedMonthlySavings, 0);
  return Math.round(total);
}

export function buildInitiativeBoard(
  workloads: Workload[] = WORKLOADS,
  context: ProjectionContext = {},
): { initiatives: InitiativeView[]; summary: SpendSummary } {
  const initiatives = workloads.map(w => toInitiativeView(w, context));

  return {
    initiatives,
    summary: {
      totalMonthlySpend: Math.round(
        workloads.reduce((sum, w) => sum + w.costs.monthly_spend, 0),
      ),
      projectedSavings: projectedSavingsFromFindings(),
      initiativesActive: initiatives.length,
      pendingApproval: initiatives.filter((i) => i.status === 'pending_approval').length,
    },
  };
}

