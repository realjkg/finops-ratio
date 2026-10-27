// buildAIContext — projects the live engine state (workloads) into the lean
// AIContext wire shape the /api/ai/chat route serializes into a system prompt.
// Pure over its inputs: the same initiative board the executive surface renders
// (one source of truth, persona-projected), plus per-initiative savings drawn
// from the configured cost-source findings and an optional workload drill-down.

import { savingsByWorkload } from '@/costsource/headline';
import { alertsFor } from '@/data/alerts';
import { DEMO_NOW } from '@/data/workloads';
import { deriveCacheHitRate } from '@/lib/derive';
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
  AIOmittedInitiative,
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

export function buildAIContext(
  workloads: Workload[],
  focusInitiativeId: string | null = null,
  asOf: Date = DEMO_NOW,
  context: ProjectionContext = {},
): AIContext {
  const { initiatives, summary } = buildInitiativeBoard(workloads, { ...context, now: asOf });
  const savings = savingsByWorkload();

  // The wire field is numeric; an N/A budget metric is left out rather than sent as 0 (follow-up: nullable wire field).
  const initiativeSnapshots: AIInitiativeSnapshot[] = initiatives.flatMap((i) => i.budgetConsumedPct === null || i.status === 'budget_na' ? [] : [{
    id: i.id,
    name: i.name,
    monthlyCost: i.monthlyCost,
    annualRunRate: i.monthlyCost * 12,
    budgetConsumedPct: i.budgetConsumedPct,
    status: INITIATIVE_STATUS_META[i.status].label as AIInitiativeSnapshot['status'],
    valueRatio: i.valueRatio,
    valueEvidenceStatus: i.valueEvidenceStatus,
    savingsOpportunity: Math.round(savings.get(i.id) ?? 0),
  }]);

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
    cacheHitRate: deriveCacheHitRate(
      w.costs.tokens_cached_today,
      w.costs.tokens_in_today,
    ),
    team: w.team,
    provider: w.model_provider,
    monthlyValue: w.value.total_value,
    monthlyBudget: w.costs.monthly_budget,
    dailyInferences: w.outputs.daily_inferences,
    tokensInToday: w.costs.tokens_in_today,
    tokensOutToday: w.costs.tokens_out_today,
    tokensCachedToday: w.costs.tokens_cached_today,
    alerts: alertsFor(w.id).map((a) => ({
      type: a.type,
      severity: a.severity,
      message: a.message,
      acknowledged: a.acknowledged,
    })),
  }));

  const omitted = initiatives
    .filter((i) => i.budgetConsumedPct === null || i.status === 'budget_na')
    .map((i) => ({ id: i.id, name: i.name, status: INITIATIVE_STATUS_META[i.status].label as AIOmittedInitiative['status'], reason: i.budgetConsumedNa ?? i.statusNa ?? 'Budget N/A' }));

  return {
    initiatives: initiativeSnapshots,
    ...(omitted.length ? { omitted } : {}),
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

