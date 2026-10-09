// Attribution seam — "Who ran up this cost?" — mirrors src/tokenomics/TokenomicsClient.ts.
//
// Deliberately VALUE-AGNOSTIC by construction: the report ranks ABSOLUTE burn
// (tokens + inference cost in USD) and carries no value-ratio field anywhere.
// Value context is a display concern (R4 lives in the UI next to the ranking,
// never in the sort). A contract test pins the absence so it cannot drift.
//
// Units: tokens and USD. No "credits" unit exists anywhere in the codebase, so
// none is invented here.

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Who is being ranked. 'team' rolls up workloads; 'user' rolls up query events. */
export type AttributionDimension = 'team' | 'user';

export const ATTRIBUTION_DIMENSIONS: AttributionDimension[] = ['team', 'user'];

export function isAttributionDimension(v: unknown): v is AttributionDimension {
  return v === 'team' || v === 'user';
}

// ---------------------------------------------------------------------------
// Row types (tokenomics honesty style: formula + named inputs on every row)
// ---------------------------------------------------------------------------

/**
 * The named inputs behind one row, so the UI can always show the working.
 * `sources` identifies the records summed into this row (workload ids for the
 * team dimension; the referenced workload ids behind a user's sampled events).
 */
export interface AttributionRowInputs {
  /** Workload ids the summed records resolve to (ResourceId → workload → team). */
  workloadIds: string[];
  /** How many source records were summed (workloads, or sampled AgentQuery events). */
  recordCount: number;
  /** Σ of the cost field over this row's records, USD. */
  summedInferenceCost: number;
  /** Σ of the same field across every row in the report — the share denominator. */
  totalInferenceCost: number;
}

export interface AttributionRow {
  dimension: AttributionDimension;
  /** Team name, or demo user id. */
  key: string;
  /** Σ tokens in — tokens_in_mtd (team) or tokens_used.input (user). */
  tokensIn: number;
  /** Σ tokens out — tokens_out_mtd (team) or tokens_used.output (user). */
  tokensOut: number;
  /** Σ inference cost, USD — monthly_spend (team) or query_cost (user). */
  inferenceCost: number;
  /**
   * inferenceCost ÷ totalInferenceCost, guarded to 0 when the total is 0
   * (the calculations.ts divide-by-zero precedent).
   */
  shareOfTotal: number;
  /** Human-readable share formula, in the TokenomicsMetric style. */
  formulaLabel: string;
  inputs: AttributionRowInputs;
  /** Plain-language statement of exactly what this row sums. */
  basis: string;
}

export interface AttributionReport {
  generatedAt: string; // ISO 8601
  dimension: AttributionDimension;
  /** The reporting window, stated on the report itself (e.g. "month-to-date …"). */
  window: string;
  /** Sorted by inferenceCost descending (worst burner first), key ascending as tiebreak. */
  rows: AttributionRow[];
  /** Portfolio totals the shares are computed against. */
  totalInferenceCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface AttributionClient {
  readonly mode: 'mock' | 'live';
  getAttributionReport(dimension: AttributionDimension): Promise<AttributionReport>;
}
