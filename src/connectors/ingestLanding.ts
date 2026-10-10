// Ingest landing derivations — pure functions + types over the store's landed
// ingest runs. Everything the connector walk needs to prove "data landed in the
// connected surfaces" is derived here from the actual CostRowsResult /
// CostFinding payloads the seam returned: no invented numbers, no recomputation
// from sources the ingest didn't produce.

import type { CostFinding, CostRowsResult } from '@/costsource/CostSourceClient';

/** One completed ingest through the CostSourceClient seam, keyed by source id. */
export interface IngestRun {
  sourceId: string;
  sourceName: string;
  at: string; // ISO 8601
  result: CostRowsResult;
  findings: CostFinding[];
}

/**
 * Connect-session state for one connector's demo walk. `open` = the adapter
 * passed its health probe (or, for the direct-ingest door, the door is
 * accepting rows); `error` carries the honest failure reason verbatim from
 * the seam — never paraphrased into something friendlier.
 */
export interface ConnectorSession {
  state: 'open' | 'error';
  /** Set when state === 'error': the seam's own message. */
  error?: string;
  openedAt: string; // ISO 8601
}

export type ConnectorBusyPhase = 'connecting' | 'ingesting';

/**
 * Walk key for Door 1 — the direct FOCUS ingest (POST /ingest/focus). Not an
 * adapter in the registry: a door. Its walk state lives in the same store
 * slices under this key so Door 1 completes the same connect → ingest →
 * data-lands → disconnect walk the adapters do.
 */
export const FOCUS_DOOR_WALK_ID = 'focus-ingest-door';

/** Display name for the direct-ingest door's landed runs. */
export const FOCUS_DOOR_SOURCE_NAME = 'FOCUS direct ingest';

/** Landed workload provenance, as the connected surfaces show it. */
export interface LandedProvenance {
  sourceName: string;
  at: string;
}

/**
 * Latest landed run per resolved workload id (later runs win). Canonical rows
 * carry the workload identity in x_RatioWorkloadId — rows that did not resolve
 * to a Ratio workload land nowhere and are skipped here.
 */
export function landedWorkloads(
  runs: Record<string, IngestRun>,
): Map<string, LandedProvenance> {
  const landed = new Map<string, LandedProvenance>();
  for (const run of Object.values(runs)) {
    for (const row of run.result.rows) {
      if (row.x_RatioWorkloadId) {
        landed.set(row.x_RatioWorkloadId, { sourceName: run.sourceName, at: run.at });
      }
    }
  }
  return landed;
}

/** Aggregate view of one landed run — the verification/proof numbers. */
export interface LandingSummary {
  sourceName: string;
  at: string;
  rows: number;
  workloadsResolved: number;
  teams: string[];
  findings: number;
  /** BilledCost summed per currency — never mixed into one figure. */
  costByCurrency: Record<string, number>;
  backfilledColumns: string[];
  sourceVersion: string;
  canonicalVersion: string;
}

export function landingSummary(run: IngestRun): LandingSummary {
  const teams = new Set<string>();
  const workloads = new Set<string>();
  const costByCurrency: Record<string, number> = {};
  for (const row of run.result.rows) {
    if (row.x_RatioTeam) teams.add(row.x_RatioTeam);
    if (row.x_RatioWorkloadId) workloads.add(row.x_RatioWorkloadId);
    costByCurrency[row.BillingCurrency] =
      (costByCurrency[row.BillingCurrency] ?? 0) + row.BilledCost;
  }
  return {
    sourceName: run.sourceName,
    at: run.at,
    rows: run.result.rows.length,
    workloadsResolved: workloads.size,
    teams: [...teams].sort(),
    findings: run.findings.length,
    costByCurrency,
    backfilledColumns: run.result.backfilledColumns,
    sourceVersion: run.result.sourceVersion,
    canonicalVersion: run.result.canonicalVersion,
  };
}

/** All landed DeepWaste findings across runs, tagged with the source that reported them. */
export function landedFindings(runs: Record<string, IngestRun>): Array<
  CostFinding & { sourceName: string }
> {
  return Object.values(runs).flatMap((run) =>
    run.findings.map((f) => ({ ...f, sourceName: run.sourceName })),
  );
}

/** Current calendar month as a half-open UTC window (the ingest default). */
export function currentMonthWindow(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

// --- Source variance (minimal cross-source comparison) ---

/**
 * Tolerance above which two sources' landed cost for the same workload counts
 * as a disagreement worth flagging. 5% is deliberately loose: allocation
 * methods (e.g. an ITBM overhead allocation vs a billing export) legitimately
 * differ by small amounts; the flag exists to surface real method disagreement,
 * not rounding.
 */
export const SOURCE_VARIANCE_TOLERANCE = 0.05;

/** One source's landed cost line for a workload, in its own currency. */
export interface WorkloadSourceLine {
  sourceName: string;
  currency: string;
  amount: number;
}

/** Per-workload cross-source readout for the ingest verification step. */
export interface WorkloadSourceVariance {
  workloadId: string;
  lines: WorkloadSourceLine[];
  /**
   * Largest same-currency spread across sources, (max-min)/min, when ≥2
   * sources landed the workload; null when fewer than 2 sources landed it.
   */
  variancePct: number | null;
  flagged: boolean;
}

/**
 * Compare landed runs per workload across sources (EffectiveCost, per
 * currency). Sources that land rows for a workload the others did not simply
 * show as a single line — no variance to compute against.
 */
export function sourceVarianceByWorkload(
  runs: Record<string, IngestRun>,
): WorkloadSourceVariance[] {
  // workloadId → currency → sourceName → summed EffectiveCost
  const byWorkload = new Map<string, Map<string, Map<string, number>>>();
  const namesBySource = new Map<string, string>();
  for (const run of Object.values(runs)) {
    namesBySource.set(run.sourceId, run.sourceName);
    for (const row of run.result.rows) {
      if (!row.x_RatioWorkloadId) continue;
      const byCurrency = byWorkload.get(row.x_RatioWorkloadId) ?? new Map();
      const bySource = byCurrency.get(row.BillingCurrency) ?? new Map();
      bySource.set(
        run.sourceId,
        (bySource.get(run.sourceId) ?? 0) + row.EffectiveCost,
      );
      byCurrency.set(row.BillingCurrency, bySource);
      byWorkload.set(row.x_RatioWorkloadId, byCurrency);
    }
  }

  const out: WorkloadSourceVariance[] = [];
  for (const [workloadId, byCurrency] of byWorkload) {
    const lines: WorkloadSourceLine[] = [];
    let worst: number | null = null;
    for (const [currency, bySource] of byCurrency) {
      for (const [sourceId, amount] of bySource) {
        lines.push({ sourceName: namesBySource.get(sourceId) ?? sourceId, currency, amount });
      }
      if (bySource.size >= 2) {
        const amounts = [...bySource.values()];
        const min = Math.min(...amounts);
        const max = Math.max(...amounts);
        if (min > 0) {
          const pct = (max - min) / min;
          worst = worst === null ? pct : Math.max(worst, pct);
        }
      }
    }
    lines.sort((a, b) => a.sourceName.localeCompare(b.sourceName));
    out.push({
      workloadId,
      lines,
      variancePct: worst,
      flagged: worst !== null && worst > SOURCE_VARIANCE_TOLERANCE,
    });
  }
  return out.sort((a, b) => a.workloadId.localeCompare(b.workloadId));
}
