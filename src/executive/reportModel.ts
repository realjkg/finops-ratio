// Report view-model (Ratio v2 Wave 2b). The on-demand PDF + XLSX exports are a
// pure projection of the *same* Initiative Dashboard engine — no new math, no
// backend change. It joins the executive initiative view (status, budget, value)
// with per-initiative savings opportunities surfaced by the configured cost
// sources, then shapes the eight user-approved report columns. Both export
// renderers (PDF, XLSX) read this single model so the two stay in lockstep.

import { outcomeReportRows, type OutcomeReportRow } from '@/outcomes/report';
import type { OutcomeRecord } from '@/outcomes/types';
import type { CostEntry } from '@/simulation/types';
import type { ProjectionContext } from '@/mission/missionModel';
import { WORKLOADS } from '@/data/workloads';
import { COST_SOURCES, findingsFor } from '@/costsource/seed';
import type { Workload } from '@/types';
import {
  buildInitiativeBoard,
  INITIATIVE_STATUS_META,
  type SpendSummary,
} from './initiativeModel';

// One report row per initiative. Field order matches the approved 8-column XLSX.
export interface ReportRow {
  name: string;
  monthlyCost: number;
  annualRunRate: number;
  budgetConsumedPct: number;
  status: string;
  costEfficiency: number;
  savingsOpportunity: number;
  lastUpdated: string;
}

export interface ReportModel {
  outcomeReports?: OutcomeReportRow[];
  generatedAt: string;
  periodLabel: string;
  summary: SpendSummary;
  rows: ReportRow[];
}

// Sum the estimated monthly savings each configured findings source attributes
// to a workload — the same seed the CostSource page + Spend Summary read.
function savingsByWorkload(): Map<string, number> {
  const byWorkload = new Map<string, number>();
  for (const source of COST_SOURCES) {
    if (!source.configured || !source.capabilities.includes('findings')) continue;
    for (const finding of findingsFor(source.id)) {
      if (!finding.workloadId) continue;
      const prior = byWorkload.get(finding.workloadId) ?? 0;
      byWorkload.set(finding.workloadId, prior + finding.estimatedMonthlySavings);
    }
  }
  return byWorkload;
}

export function buildReportModel(
  now: Date = new Date(),
  workloads: Workload[] = WORKLOADS,
  context: ProjectionContext = {},
  outcomes?: { records: Record<string, OutcomeRecord>; ledger: CostEntry[] },
): ReportModel {
  const { initiatives, summary } = buildInitiativeBoard(workloads, context);
  const savings = savingsByWorkload();
  const byId = new Map(workloads.map((w) => [w.id, w]));

  const rows: ReportRow[] = initiatives.map((initiative) => {
    const workload = byId.get(initiative.id);
    if (!workload) throw new Error(`No workload for initiative ${initiative.id}`);
    return {
      name: initiative.name,
      monthlyCost: Math.round(initiative.monthlyCost),
      annualRunRate: Math.round(initiative.monthlyCost * 12),
      budgetConsumedPct: initiative.budgetConsumedPct,
      status: INITIATIVE_STATUS_META[initiative.status].label,
      costEfficiency: initiative.valueRatio,
      savingsOpportunity: Math.round(savings.get(initiative.id) ?? 0),
      // updated_at is an ISO instant; the report needs the calendar date only.
      lastUpdated: workload.updated_at.slice(0, 10),
    };
  });

  return {
    outcomeReports: outcomes ? outcomeReportRows(workloads, outcomes.records, outcomes.ledger) : undefined,
    generatedAt: now.toISOString(),
    periodLabel: now.toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    summary,
    rows,
  };
}

