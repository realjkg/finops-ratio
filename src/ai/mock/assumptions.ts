// Self-hosted open-model cost assumptions for the Frank mock.

/**
 * ILLUSTRATIVE ASSUMPTIONS, NOT DATA. The seed holds no open model, no GPU
 * price, no hosting cost and no throughput measurement. Every migration answer
 * computes the private-model side from this one object, echoes each value, and
 * lets the question override it ("at $2.50 per GPU hour", "8 GPUs", "migration
 * costs $40k"). These are illustrative assumptions, not data: replace them with
 * the owner's real quotes before using any migration figure for a decision.
 */
export const SELF_HOST_ASSUMPTIONS = {
  /** Price of one GPU-hour, USD. */
  gpuHourlyUsd: 2.5,
  /** GPUs to run. null = size to the workload volume (never below minGpus). */
  gpuCount: null as number | null,
  /** Floor when sizing automatically, for availability. */
  minGpus: 2,
  /** Share of peak throughput sustained in practice, 0-1. */
  utilisation: 0.5,
  /** Blended input+output tokens per second per GPU at 100% utilisation. */
  tokensPerSecondPerGpu: 1000,
  /** Always-on hours in a month. */
  hoursPerMonth: 730,
  /** Ops, monitoring and on-call as a fraction of GPU cost. */
  opsOverheadPct: 0.25,
  /** One-time migration cost, USD (engineering, evaluation, cutover). */
  migrationOneTimeUsd: 25000,
} as const;

/** Days per month used to scale the seed's daily volume (same as modelCompare). */
export const DAYS_PER_MONTH = 30;

/** User overrides parsed from a question; undefined keys use the defaults. */
export interface Overrides {
  gpuHourlyUsd?: number;
  gpuCount?: number;
  utilisation?: number;
  tokensPerSecondPerGpu?: number;
  opsOverheadPct?: number;
  migrationOneTimeUsd?: number;
}

/** Fully resolved assumptions for one calculation. */
export interface ResolvedAssumptions {
  gpuHourlyUsd: number;
  gpuCount: number | null;
  minGpus: number;
  utilisation: number;
  tokensPerSecondPerGpu: number;
  hoursPerMonth: number;
  opsOverheadPct: number;
  migrationOneTimeUsd: number;
}

export function resolveAssumptions(o: Overrides = {}): ResolvedAssumptions {
  const d = SELF_HOST_ASSUMPTIONS;
  return {
    gpuHourlyUsd: o.gpuHourlyUsd ?? d.gpuHourlyUsd,
    gpuCount: o.gpuCount ?? d.gpuCount,
    minGpus: d.minGpus,
    utilisation: o.utilisation ?? d.utilisation,
    tokensPerSecondPerGpu: o.tokensPerSecondPerGpu ?? d.tokensPerSecondPerGpu,
    hoursPerMonth: d.hoursPerMonth,
    opsOverheadPct: o.opsOverheadPct ?? d.opsOverheadPct,
    migrationOneTimeUsd: o.migrationOneTimeUsd ?? d.migrationOneTimeUsd,
  };
}
