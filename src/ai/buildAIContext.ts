// buildAIContext — projects the live engine state (workloads) into the lean
// AIContext wire shape the /api/ai/chat route serializes into a system prompt.
// Pure over its inputs: the same initiative board the executive surface renders
// (one source of truth, persona-projected), plus per-initiative savings drawn
// from the configured cost-source findings and an optional workload drill-down.

import { COST_SOURCES, findingsFor } from '@/costsource/seed';
import { DEMO_NOW } from '@/data/workloads';
import {
  buildInitiativeBoard,
  INITIATIVE_STATUS_META,
} from '@/executive/initiativeModel';
import type { ProjectionContext } from '@/mission/missionModel';
import { headlineEvidenceStatus } from '@/lib/valueEvidence';
import type { Workload } from '@/types';
import type {
  AIContext,
  AIInitiativeSnapshot,
  AIWorkloadSnapshot,
} from './AIClient';

// Boolean governance gate fields, in their enforced order (Policy → Scale).
const GATE_FIELDS = [
  'policy_check',
  'ethics_review',
  'cost_approval',
  'scale_authorized',
] as const;

function gatesPassed(workload: Workload): number {
  return GATE_FIELDS.filter((field) => workload.governance[field]).length;
}

// Sum each configured findings source's monthly-savings estimates per workload.
// Mirrors projectedSavingsFromFindings() in initiativeModel, but keeps the
// per-initiative breakdown the agent needs to answer "how much can we save?".
function savingsByWorkload(): Map<string, number> {
  const totals = new Map<string, number>();
  for (const source of COST_SOURCES) {
    if (!source.configured || !source.capabilities.includes('findings')) continue;
    for (const finding of findingsFor(source.id)) {
      if (!finding.workloadId) continue;
      totals.set(
        finding.workloadId,
        (totals.get(finding.workloadId) ?? 0) + finding.estimatedMonthlySavings,
      );
    }
  }
  return totals;
}

export function buildAIContext(
  workloads: Workload[],
  focusInitiativeId: string | null = null,
  asOf: Date = DEMO_NOW,
  context: ProjectionContext = {},
): AIContext {
  const { initiatives, summary } = buildInitiativeBoard(workloads, { ...context, now: asOf });
  const savings = savingsByWorkload();

  const initiativeSnapshots: AIInitiativeSnapshot[] = initiatives.map((i) => ({
    id: i.id,
    name: i.name,
    monthlyCost: i.monthlyCost,
    annualRunRate: i.monthlyCost * 12,
    budgetConsumedPct: i.budgetConsumedPct,
    status: INITIATIVE_STATUS_META[i.status].label as AIInitiativeSnapshot['status'],
    valueRatio: i.valueRatio,
    valueEvidenceStatus: i.valueEvidenceStatus,
    savingsOpportunity: Math.round(savings.get(i.id) ?? 0),
  }));

  const workloadSnapshots: AIWorkloadSnapshot[] = workloads.map((w) => ({
    id: w.id,
    name: w.name,
    model: w.model,
    monthlySpend: w.costs.monthly_spend,
    valueRatio: w.value.value_ratio,
    valueEvidenceStatus: headlineEvidenceStatus(w.value),
    demandShape: w.demand_shape,
    governanceGatesPassed: gatesPassed(w),
    costTrendPct: w.cost_trend_pct,
  }));

  return {
    initiatives: initiativeSnapshots,
    summary: {
      totalMonthlySpend: summary.totalMonthlySpend,
      projectedSavings: summary.projectedSavings,
      initiativesActive: summary.initiativesActive,
      pendingApproval: summary.pendingApproval,
    },
    workloads: workloadSnapshots,
    focusInitiativeId,
    asOf: asOf.toISOString(),
  };
}

