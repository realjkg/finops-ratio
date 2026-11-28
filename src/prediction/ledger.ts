// Prediction-error ledger — pure helpers over LedgerEntry[]. Scoring a change
// turns a predicted/realized pair into an entry; the rolling helpers compute
// the per-source / per-change-type error distribution that drives source
// selection and the confidence band. The ledger is the auditable back-test of
// the >=99% claim (spec art_MtDqOyd9, WS3).

import type {
  ChangeType,
  LedgerEntry,
  PredictionSourceId,
  SourceErrorDistribution,
} from './PredictionClient';
import { perChangeAccuracy } from './accuracy';
import { standardDeviation } from '@/lib/forecast';

/**
 * Minimum realized changes (per source + change type) before that source is
 * trusted to clear the confidence gate. Below this, the system stays in
 * estimated / cold-start mode and is honest about it.
 */
export const MIN_REALIZED_CHANGES = 5;

/**
 * Rolling window: only the most recent N scored entries shape the current
 * error distribution, so a source's standing adapts as evidence accumulates
 * ("recomputed as evidence accumulates", spec WS3).
 */
export const ROLLING_WINDOW = 30;

/**
 * Default validation window per change type (days). Model switches use 14 days
 * to match the forecast engine's 14-day volatility basis (§6.3) and absorb
 * day-of-week seasonality; the rest use 7 (the forecast engine's 7-day average, §6.2).
 */
export const VALIDATION_WINDOW_DAYS: Record<ChangeType, number> = {
  model_switch: 14,
  demand_shape: 7,
  scale: 7,
  budget: 7,
};

export function validationWindowFor(changeType: ChangeType): number {
  return VALIDATION_WINDOW_DAYS[changeType];
}

export interface ScoreChangeInput {
  id: string;
  workloadId: string;
  changeType: ChangeType;
  source: PredictionSourceId;
  predictedDeltaCost: number;
  actualDeltaCost: number;
  clearedConfidenceGate: boolean;
  predictedAt: string;
  realizedAt: string;
  validationWindowDays?: number; // defaults from the change type
}

/** Build a scored ledger entry from a predicted/realized pair. */
export function scoreChange(input: ScoreChangeInput): LedgerEntry {
  const pca = perChangeAccuracy(input.predictedDeltaCost, input.actualDeltaCost);
  return {
    id: input.id,
    workloadId: input.workloadId,
    changeType: input.changeType,
    source: input.source,
    predictedDeltaCost: input.predictedDeltaCost,
    actualDeltaCost: input.actualDeltaCost,
    validationWindowDays:
      input.validationWindowDays ?? validationWindowFor(input.changeType),
    perChangeAccuracy: pca.accuracy,
    isNoOp: pca.isNoOp,
    noOpPredictedCorrectly: pca.noOpPredictedCorrectly,
    clearedConfidenceGate: input.clearedConfidenceGate,
    predictedAt: input.predictedAt,
    realizedAt: input.realizedAt,
  };
}

export interface EntryFilter {
  source?: PredictionSourceId;
  changeType?: ChangeType;
}

export function filterEntries(
  entries: LedgerEntry[],
  filter: EntryFilter,
): LedgerEntry[] {
  return entries.filter(
    (e) =>
      (filter.source === undefined || e.source === filter.source) &&
      (filter.changeType === undefined || e.changeType === filter.changeType),
  );
}

/**
 * Absolute relative error of a scored entry: |predicted-actual|/|actual|,
 * which is exactly 1 - perChangeAccuracy for non-no-op entries. No-ops carry no
 * relative error (null).
 */
function absRelError(entry: LedgerEntry): number | null {
  if (entry.isNoOp || entry.perChangeAccuracy === null) return null;
  return 1 - entry.perChangeAccuracy;
}

/**
 * Rolling per-source / per-change-type error distribution, over the most recent
 * ROLLING_WINDOW scored (non-no-op) entries ordered by realizedAt. With no
 * history the mean error is Infinity so the source sorts last and never clears
 * the gate.
 */
export function rollingErrorDistribution(
  entries: LedgerEntry[],
  source: PredictionSourceId,
  changeType: ChangeType,
  window: number = ROLLING_WINDOW,
): SourceErrorDistribution {
  const scored = filterEntries(entries, { source, changeType })
    .filter((e) => !e.isNoOp && e.perChangeAccuracy !== null)
    .sort((a, b) => a.realizedAt.localeCompare(b.realizedAt))
    .slice(-window);

  const errors = scored
    .map(absRelError)
    .filter((v): v is number => v !== null);

  const meanAbsRelError =
    errors.length > 0
      ? errors.reduce((a, b) => a + b, 0) / errors.length
      : Infinity;

  return {
    source,
    changeType,
    sampleSize: errors.length,
    meanAbsRelError,
    stdAbsRelError: standardDeviation(errors),
    hasEnoughHistory: errors.length >= MIN_REALIZED_CHANGES,
  };
}

