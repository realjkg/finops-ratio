// Multi-model cost comparison — spec §3.4.2, §8, §14.2 /workloads/{id}/models.
// Given a workload's volume, compute what every registry model would cost so a
// developer sees the cost/quality tradeoff before switching (R1).

import type { ModelEntry } from '@/types';

export interface VolumeProfile {
  calls: number;
  avgInputTokens: number;
  avgOutputTokens: number;
}

export interface ModelCostRow {
  model: ModelEntry;
  inputCost: number; // daily input cost at this volume
  outputCost: number; // daily output cost at this volume
  dailyCost: number;
  monthlyCost: number;
  savingsPct: number; // vs the current model, negative = cheaper
  isCurrent: boolean;
}

export function modelDailyCost(model: ModelEntry, volume: VolumeProfile): { input: number; output: number; total: number } {
  const input = (volume.calls * volume.avgInputTokens) / 1_000_000 * model.pricing.input_per_1m;
  const output = (volume.calls * volume.avgOutputTokens) / 1_000_000 * model.pricing.output_per_1m;
  return { input, output, total: input + output };
}

export function compareModels(
  registry: ModelEntry[],
  currentModelName: string,
  volume: VolumeProfile,
): ModelCostRow[] {
  const current = registry.find((m) => m.model_name === currentModelName);
  const baseDaily = current ? modelDailyCost(current, volume).total : 0;

  const rows: ModelCostRow[] = registry.map((model) => {
    const cost = modelDailyCost(model, volume);
    const savingsPct = baseDaily > 0 ? ((cost.total - baseDaily) / baseDaily) * 100 : 0;
    return {
      model,
      inputCost: cost.input,
      outputCost: cost.output,
      dailyCost: cost.total,
      monthlyCost: cost.total * 30,
      savingsPct,
      isCurrent: model.model_name === currentModelName,
    };
  });

  // §3.4.2: default sort by daily cost ascending (cheapest first).
  return rows.sort((a, b) => a.dailyCost - b.dailyCost);
}

// --- Daily-budget overshoot (Multi-Model Methodology Guardrail) -------------

// obvious.md Multi-Model Methodology Guardrails: "If a selected model would
// push daily spend over the daily budget, show a projected-overshoot warning."
// This projection is the warning's only math; the UI renders it before Apply
// and must not block on it — budgets/throttles are the enforcement layer.
export interface OvershootProjection {
  /** Projected daily spend on the candidate model at this volume. */
  projectedDaily: number;
  /** The workload's daily budget the projection is compared against. */
  dailyBudget: number;
  /** Dollars per day over the budget (> 0 by construction). */
  overAmount: number;
  /**
   * Percent over budget (e.g. 25 = +25%), in the same units as
   * `ModelCostRow.savingsPct`. `null` when the budget is zero — a percentage
   * of zero is undefined; the amount still tells the story.
   */
  overPct: number | null;
}

// `null` while the projection stays at or under budget — at-budget is not
// over, and no warning is invented for a switch that fits the budget.
export function projectedOvershoot(
  model: ModelEntry,
  volume: VolumeProfile,
  dailyBudget: number,
): OvershootProjection | null {
  const projectedDaily = modelDailyCost(model, volume).total;
  if (projectedDaily <= dailyBudget) return null;
  return {
    projectedDaily,
    dailyBudget,
    overAmount: projectedDaily - dailyBudget,
    overPct:
      dailyBudget > 0 ? ((projectedDaily - dailyBudget) / dailyBudget) * 100 : null,
  };
}

// Best cheaper alternative to the current model, used by the agent responder.
export function cheapestAlternative(rows: ModelCostRow[]): ModelCostRow | null {
  const current = rows.find((r) => r.isCurrent);
  if (!current) return null;
  const cheaper = rows.filter((r) => !r.isCurrent && r.dailyCost < current.dailyCost);
  if (cheaper.length === 0) return null;
  return cheaper.reduce((min, r) => (r.dailyCost < min.dailyCost ? r : min), cheaper[0]);
}

