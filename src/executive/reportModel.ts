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
import { savingsByWorkload } from '@/costsource/headline';
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
  budgetConsumedPct: number | null;
  budgetConsumedNa: string | null;
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

/** Table/PDF cell text: whole percent, or "N/A" (the reason goes in a footnote). */
export function budgetCellText(r: Pick<ReportRow, 'budgetConsumedPct'>): string {
  return r.budgetConsumedPct === null ? 'N/A' : `${r.budgetConsumedPct}%`;
}

/** One footnote per N/A budget row, so the reason is never lost. */
export function budgetNaFootnotes(rows: ReportRow[]): string[] {
  return rows.filter((r) => r.budgetConsumedPct === null).map((r) => `${r.name}: Budget consumed N/A (${r.budgetConsumedNa})`);
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
      budgetConsumedNa: initiative.budgetConsumedNa,
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

