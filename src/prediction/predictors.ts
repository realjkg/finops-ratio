// Predictors — turn a proposed change into a predicted cost-and-value impact,
// reusing the existing engine math (no reinvention): the multi-model registry
// (spec §8, lib/modelCompare) for model switches and the demand-shaping factors
// (lib/demandShape) for shape changes, calibrated to the workload's realized
// run rate (spec §6) when the forecast_engine source is in play.
//
// `buildPrediction` is the orchestrator: it selects the lowest-error source for
// the change type, predicts the impact, attaches the confidence band, and marks
// the prediction confident or estimated against the >=99% gate.

import type { DemandShape, ModelEntry, Workload } from '@/types';
import type {
  ChangePrediction,
  CostImpact,
  LedgerEntry,
  PredictionSourceId,
  ProposedChange,
} from './PredictionClient';
import { modelDailyCost, type VolumeProfile } from '@/lib/modelCompare';
import { SHAPE_FACTOR, alwaysOnBaseline } from '@/lib/demandShape';
import {
  clearsConfidenceGate,
  confidenceBand,
  selectSource,
  type SourceSelection,
} from './sourceSelection';

/** A month is treated as 30 days, consistent with lib/modelCompare. */
const DAYS_PER_MONTH = 30;

export interface PredictionContext {
  workload: Workload;
  registry: ModelEntry[];
}

/** Beyond this magnitude a Δ value ratio is shown as a bound, not a point estimate. */
export const DELTA_RATIO_DISPLAY_CAP = 10;

/** Shown wherever a capped Δ value ratio renders. */
export const DELTA_RATIO_CAP_CAVEAT =
  'Upper bound, not a forecast: assumes total value stays constant while spend moves, and the cold-start ledger has no error history. A cheaper model may lower quality and value.';

/**
 * Display form of a predicted Δ value ratio. The estimator holds total value
 * constant while spend moves, so a large switch yields an extreme ratio that is
 * an upper bound, not a forecast: past the cap it renders as "> +10.0×".
 */
export function formatDeltaValueRatio(delta: number): { text: string; capped: boolean } {
  const cap = DELTA_RATIO_DISPLAY_CAP;
  if (delta > cap) return { text: `> +${cap.toFixed(1)}\u00d7`, capped: true };
  if (delta < -cap) return { text: `< -${cap.toFixed(1)}\u00d7`, capped: true };
  return { text: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}\u00d7`, capped: false };
}

/** Per-call token volume implied by the workload's current daily run rate. */
function volumeOf(workload: Workload): VolumeProfile {
  const calls = workload.outputs.daily_inferences;
  return {
    calls,
    avgInputTokens: calls > 0 ? workload.costs.tokens_in_today / calls : 0,
    avgOutputTokens: calls > 0 ? workload.costs.tokens_out_today / calls : 0,
  };
}

/**
 * Compose a CostImpact from a daily/monthly Δspend. R4: the value-ratio effect
 * is computed alongside — total_value is held constant while monthly_spend
 * shifts by the predicted delta.
 */
function impactFrom(
  workload: Workload,
  deltaDaily: number,
  deltaMonthly: number,
): CostImpact {
  const newMonthly = workload.costs.monthly_spend + deltaMonthly;
  const newRatio = newMonthly > 0 ? workload.value.total_value / newMonthly : 0;
  return {
    deltaDailySpend: deltaDaily,
    deltaMonthlySpend: deltaMonthly,
    deltaValueRatio: newRatio - workload.value.value_ratio,
  };
}

/**
 * Model switch — list pricing over the registry (§8). The forecast_engine
 * source additionally calibrates the list-implied delta to the workload's
 * realized run rate (§6), since real token mix rarely matches list assumptions.
 */
function predictModelSwitch(
  workload: Workload,
  registry: ModelEntry[],
  fromModel: string,
  toModel: string,
  source: PredictionSourceId,
): CostImpact {
  const from = registry.find((m) => m.model_name === fromModel);
  const to = registry.find((m) => m.model_name === toModel);
  if (!from || !to) {
    throw new Error(
      `Unknown model in switch: ${!from ? fromModel : toModel}`,
    );
  }
  const volume = volumeOf(workload);
  const fromDaily = modelDailyCost(from, volume).total;
  const toDaily = modelDailyCost(to, volume).total;
  let deltaDaily = toDaily - fromDaily;

  // forecast_engine: scale the list-implied delta by realized/list run rate.
  if (source === 'forecast_engine' && fromDaily > 0) {
    const calibration = workload.costs.daily_spend / fromDaily;
    deltaDaily *= calibration;
  }
  return impactFrom(workload, deltaDaily, deltaDaily * DAYS_PER_MONTH);
}

/** Demand-shape change — relative monthly factors vs. always-on (lib/demandShape). */
function predictDemandShape(
  workload: Workload,
  fromShape: DemandShape,
  toShape: DemandShape,
): CostImpact {
  const baseline = alwaysOnBaseline(workload);
  const deltaMonthly = baseline * (SHAPE_FACTOR[toShape] - SHAPE_FACTOR[fromShape]);
  return impactFrom(workload, deltaMonthly / DAYS_PER_MONTH, deltaMonthly);
}

/** Scale change — spend moves linearly with the volume multiplier. */
function predictScale(workload: Workload, volumeMultiplier: number): CostImpact {
  const deltaDaily = workload.costs.daily_spend * (volumeMultiplier - 1);
  const deltaMonthly = workload.costs.monthly_spend * (volumeMultiplier - 1);
  return impactFrom(workload, deltaDaily, deltaMonthly);
}

/**
 * Budget change — moves the guardrail, not the run rate, so the predicted spend
 * delta is exactly zero. A natural no-op: realized Δspend should also be ~0,
 * exercising the ledger's no-op handling.
 */
function predictBudget(): CostImpact {
  return { deltaDailySpend: 0, deltaMonthlySpend: 0, deltaValueRatio: 0 };
}

/** Predict the cost impact of a change using the engine math for its type. */
export function predictImpact(
  change: ProposedChange,
  ctx: PredictionContext,
  source: PredictionSourceId,
): CostImpact {
  switch (change.type) {
    case 'model_switch':
      return predictModelSwitch(
        ctx.workload,
        ctx.registry,
        change.fromModel,
        change.toModel,
        source,
      );
    case 'demand_shape':
      return predictDemandShape(ctx.workload, change.fromShape, change.toShape);
    case 'scale':
      return predictScale(ctx.workload, change.volumeMultiplier);
    case 'budget':
      return predictBudget();
  }
}

function buildRationale(selection: SourceSelection, gate: boolean): string {
  const { source, changeType, distribution, coldStart } = selection;
  if (coldStart) {
    return (
      `Cold-start: no source has ${'\u2265'}5 realized ${changeType} changes yet. ` +
      `Showing ${source} as an estimate, routed to human confirmation.`
    );
  }
  const errPct = (distribution.meanAbsRelError * 100).toFixed(2);
  const verb = gate ? 'clears' : 'does not clear';
  return (
    `Selected ${source}: lowest historical error (${errPct}%) over ` +
    `${distribution.sampleSize} ${changeType} changes; ${verb} the 99% gate.`
  );
}

/**
 * Orchestrate a full prediction: select the source, predict the impact, attach
 * the confidence band, and mark confident vs. estimated against the gate.
 */
export function buildPrediction(
  entries: LedgerEntry[],
  change: ProposedChange,
  ctx: PredictionContext,
): ChangePrediction {
  const selection = selectSource(entries, change.type);
  const impact = predictImpact(change, ctx, selection.source);
  const confidence = confidenceBand(impact.deltaMonthlySpend, selection.distribution);
  const gate = clearsConfidenceGate(selection.distribution);
  const estimated = selection.coldStart || !gate;
  return {
    workloadId: change.workloadId,
    changeType: change.type,
    source: selection.source,
    impact,
    confidence,
    clearsConfidenceGate: gate,
    estimated,
    mode: estimated ? 'estimated' : 'confident',
    rationale: buildRationale(selection, gate),
  };
}

