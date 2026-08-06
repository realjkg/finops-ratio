// Normalization for the cost-ingest seam (PR D). Two stages prove the
// numerator/denominator composition the v2 spec (Workstream 2) calls for:
//
//   1. upgradeToCanonicalCost  — source FOCUS export -> v1.4 canonical cost rows
//      (the numerator). Lives in focusRows.ts.
//   2. attachRatioValue        — the engine resolves each row to a Ratio workload
//      and attaches value ratio, demand shape, and governance gates (the
//      denominator), yielding the normalized internal model.
//
// `composeRatioView` then runs the existing forecast/budget engine over the
// resolved workload so the demo can show value + forecast + gates on an
// ingested row — with no engine changes.

import { WORKLOADS, DEMO_NOW } from '@/data/workloads';
import { budgetFor } from '@/data/budgets';
import { governanceGatesPassed } from '@/lib/derive';
import { computeBudgetStatus, type BudgetStatus } from '@/lib/budgetStatus';
import type { FocusVersion } from './focusVersions';
import { columnsAddedAfter } from './focusVersions';
import type {
  CanonicalFocusRow,
  RatioFocusExtensions,
  RawSourceRow,
} from './focusRows';
import { upgradeToCanonicalCost } from './focusRows';
import { resolveWorkloadId } from './seed';

/**
 * Stage 2: attach the Ratio value denominator to a cost row.
 *
 * Generic over the cost shape so the same denominator logic serves both the
 * canonical v1.4 rows the ingest seam produces AND the version-pinned rows the
 * FinIO A2A seam emits for a peer that speaks an older FOCUS version. The only
 * column it needs is `ResourceId`, which carries the Ratio workload identity.
 */
export function attachRatioValue<T extends { ResourceId: string }>(
  cost: T,
  sourceId: string,
  sourceVersion: FocusVersion,
): T & RatioFocusExtensions {
  const workloadId = resolveWorkloadId(cost.ResourceId);
  const workload = workloadId ? WORKLOADS.find((w) => w.id === workloadId) : undefined;

  // An unresolved cost row still normalizes; its value is unknown (0) rather
  // than hidden — cost is never shown without a value context (R4).
  if (!workload) {
    return {
      ...cost,
      x_RatioWorkloadId: workloadId ?? '',
      x_RatioValueRatio: 0,
      x_RatioTotalValue: 0,
      x_RatioDemandShape: 'unmanaged',
      x_RatioGovernanceGates: 0,
      x_RatioSourceId: sourceId,
      x_RatioSourceVersion: sourceVersion,
    };
  }

  return {
    ...cost,
    x_RatioWorkloadId: workload.id,
    x_RatioValueRatio: workload.value.value_ratio,
    x_RatioTotalValue: workload.value.total_value,
    x_RatioDemandShape: workload.demand_shape,
    x_RatioGovernanceGates: governanceGatesPassed(workload),
    x_RatioSourceId: sourceId,
    x_RatioSourceVersion: sourceVersion,
  };
}

export interface NormalizedRows {
  rows: CanonicalFocusRow[];
  backfilledColumns: string[];
}

/** Full normalization: raw source rows -> canonical FOCUS rows + upgrade audit. */
export function normalizeRows(
  raws: RawSourceRow[],
  sourceId: string,
  sourceVersion: FocusVersion,
): NormalizedRows {
  return {
    rows: raws.map((raw) => attachRatioValue(upgradeToCanonicalCost(raw), sourceId, sourceVersion)),
    backfilledColumns: columnsAddedAfter(sourceVersion),
  };
}

/** Value + forecast + gates for an ingested row, via the unchanged engine. */
export interface ComposedRatioView {
  workloadId: string;
  name: string;
  monthlySpend: number;
  valueRatio: number;
  totalValue: number;
  gatesPassed: number;
  budget: BudgetStatus | null;
}

export function composeRatioView(row: CanonicalFocusRow): ComposedRatioView | null {
  const workload = WORKLOADS.find((w) => w.id === row.x_RatioWorkloadId);
  if (!workload) return null;
  const budget = budgetFor(workload.id);
  return {
    workloadId: workload.id,
    name: workload.name,
    monthlySpend: workload.costs.monthly_spend,
    valueRatio: workload.value.value_ratio,
    totalValue: workload.value.total_value,
    gatesPassed: row.x_RatioGovernanceGates,
    budget: budget ? computeBudgetStatus(workload, budget, DEMO_NOW) : null,
  };
}

