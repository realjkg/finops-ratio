// Scenario→math bridge — turns visitor scenario inputs (model mix, daily
// volume, monthly growth) into per-model token flows, monthly cost/value, the
// value ratio, and derived inputs for the three integrity metrics.
//
// No-invented-numbers discipline: every constant traces to seed data (model
// registry pricing, workload seeds, tokenomics seeds) or to the visitor's own
// inputs. The traceable structure:
//
//   mix weights ──normalize──▶ share per model
//   daily inferences × days/month × (1+growth)^horizon ──▶ monthly volume
//   share × volume ──▶ per-model inferences × seeded token profile ──▶ tokens
//   tokens × registry $/1M ──▶ monthly cost        (src/data/models.ts)
//   inferences × value/inference ──▶ monthly value (seeded ratio × seeded cost/inference)
//   value ÷ cost ──▶ value ratio                   (R4: value is the denominator)
//   volume ──▶ hardware events, raw/unique tokens, ledger ──▶ integrity inputs
//
// Integrity RATES are seeded structure (capture rate, dedup share, heartbeat
// allowance) derived from the exported tokenomics seeds, so they hold at any
// scenario scale; volume and mix move the counts and the economics.

import type { ModelProvider } from '@/types';
import { findModel } from '@/data/models';
import { WORKLOADS } from '@/data/workloads';
import {
  COUNTER_ALIGNMENT_SEED,
  PIPELINE_INTEGRITY_SEED,
  LEDGER_SYNC_SEED,
  SCENARIO_SEED,
} from './seeds';
import { buildTokenomicsReport } from './reportAssembly';
import type { TokenomicsReport } from './TokenomicsClient';

// ---------------------------------------------------------------------------
// Mix-model seeds — one per registry model a seeded workload actually uses
// ---------------------------------------------------------------------------

export interface MixModelSeed {
  /** Registry model_name (joins to MODEL_REGISTRY and WORKLOADS). */
  modelId: string;
  displayName: string;
  provider: ModelProvider;
  /** Registry pricing, $ per 1M input tokens. */
  inputPer1m: number;
  /** Registry pricing, $ per 1M output tokens. */
  outputPer1m: number;
  /** Seeded workload token profile — average tokens per inference. */
  avgInputTokens: number;
  avgOutputTokens: number;
  /** The seeded workload's value ratio (monthly value ÷ monthly spend). */
  valueRatioSeed: number;
}

// The first seeded workload using each model supplies its token profile and
// value basis (deterministic: WORKLOADS order). gpt-4.5 has no seeded
// workload, so it has no honest token/value basis and is excluded from the
// mix — registry pricing still governs the models below.
export const MIX_MODELS: MixModelSeed[] = (() => {
  const byModel = new Map<string, MixModelSeed>();
  for (const w of WORKLOADS) {
    if (byModel.has(w.model)) continue;
    const entry = findModel(w.model);
    if (!entry) continue;
    const daily = Math.max(w.outputs.daily_inferences, 1);
    byModel.set(w.model, {
      modelId: w.model,
      displayName: entry.display_name,
      provider: w.model_provider,
      inputPer1m: entry.pricing.input_per_1m,
      outputPer1m: entry.pricing.output_per_1m,
      avgInputTokens: Math.round(w.costs.tokens_in_today / daily),
      avgOutputTokens: Math.round(w.costs.tokens_out_today / daily),
      valueRatioSeed: w.value.value_ratio,
    });
  }
  return [...byModel.values()];
})();

/** Seeded cost structure: registry pricing × the seeded token profile. */
export function costPerInference(m: MixModelSeed): number {
  return (m.avgInputTokens * m.inputPer1m + m.avgOutputTokens * m.outputPer1m) / 1_000_000;
}

/**
 * Value basis: the seeded workload's value ratio applied to its own seeded
 * cost per inference. A 100% single-model mix therefore reproduces that
 * workload's seeded value ratio exactly, and mixes interpolate honestly
 * between seeded anchors.
 */
export function valuePerInference(m: MixModelSeed): number {
  return m.valueRatioSeed * costPerInference(m);
}

// ---------------------------------------------------------------------------
// Scenario inputs (visitor-facing)
// ---------------------------------------------------------------------------

export interface MixWeight {
  modelId: string;
  /** Raw slider weight 0–100; the bridge normalizes the mix to 100%. */
  weightPct: number;
}

export interface ScenarioInputs {
  /** Raw per-model weights; normalized to 100% before any math. */
  mixWeights: MixWeight[];
  /** Inferences per day at the start of the horizon. */
  dailyInferences: number;
  /** Growth %/month, compounded over the seeded horizon. */
  growthPctPerMonth: number;
}

// Seeded default scenario: the portfolio's own inference mix and total seeded
// daily volume, with no growth assumed. Shares are rounded to whole percents
// by largest remainder so they sum to exactly 100.
const PORTFOLIO_INFERENCE_WEIGHTS: number[] = MIX_MODELS.map((m) =>
  WORKLOADS.filter((w) => w.model === m.modelId).reduce(
    (sum, w) => sum + w.outputs.monthly_inferences,
    0,
  ),
);

function largestRemainderPct(weights: number[], total = 100): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const floors = raw.map((v) => Math.floor(v));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const byLargestFraction = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (const { i } of byLargestFraction) {
    if (remainder <= 0) break;
    out[i] += 1;
    remainder -= 1;
  }
  return out;
}

const DEFAULT_SHARES = largestRemainderPct(PORTFOLIO_INFERENCE_WEIGHTS);

export const DEFAULT_SCENARIO: ScenarioInputs = {
  mixWeights: MIX_MODELS.map((m, i) => ({
    modelId: m.modelId,
    weightPct: DEFAULT_SHARES[i] ?? 0,
  })),
  dailyInferences: WORKLOADS.reduce((sum, w) => sum + w.outputs.daily_inferences, 0),
  growthPctPerMonth: SCENARIO_SEED.defaultGrowthPctPerMonth,
};

// ---------------------------------------------------------------------------
// Derived integrity rates — seeded structure, carried over unchanged
// ---------------------------------------------------------------------------

// Metric 2's fractional-allowance unit assumption is carried over EXACTLY as
// seeded (blocked on confirmation — do not harden here).
export const SCENARIO_RATES = {
  /** Seeded capture rate: ingested ÷ hardware-reported events. */
  captureRate:
    COUNTER_ALIGNMENT_SEED.totalIngestedEvents /
    COUNTER_ALIGNMENT_SEED.totalHardwareReportedEvents,
  /** Seeded dedup share: unique ÷ raw tokens. */
  dedupShare: PIPELINE_INTEGRITY_SEED.uniqueProcessedTokens / PIPELINE_INTEGRITY_SEED.rawIngestedTokens,
  /** Seeded fractional heartbeat allowance (0–1 share of raw tokens). */
  heartbeatAllowance: PIPELINE_INTEGRITY_SEED.expectedDroppedHeartbeats,
  /** Seeded pipeline pass threshold. */
  pipelineThreshold: PIPELINE_INTEGRITY_SEED.threshold,
  /** Seeded ledger reconciliation: exact (delta 0). */
  ledgerDeltaSeed: LEDGER_SYNC_SEED.uiDisplayedBalance - LEDGER_SYNC_SEED.immutableDatabaseBalance,
} as const;

// ---------------------------------------------------------------------------
// Bridge output
// ---------------------------------------------------------------------------

export interface ModelContribution {
  modelId: string;
  displayName: string;
  /** Normalized share of the mix (0–100). */
  sharePct: number;
  /** Expected inferences over the horizon month, integer count. */
  monthlyInferences: number;
  tokensIn: number;
  tokensOut: number;
  /** USD for the horizon month, 2dp. */
  monthlyCost: number;
  monthlyValue: number;
  costPerInference: number;
  valuePerInference: number;
}

export type FlowUnit = 'events' | 'tokens' | 'usd';

/** One ingest→pipeline→presentation stage of the token-flow visual. */
export interface FlowStage {
  layer: string;
  inValue: number;
  outValue: number;
  unit: FlowUnit;
  /** 0 for the presentation layer (seeded exact reconciliation). */
  lossValue: number;
  lossLabel: string;
  /** The seed derivation behind this stage's rate, for display. */
  rateLabel: string;
}

export interface ScenarioDerivations {
  growthFactor: number;
  monthlyInferences: number;
  hardwareReportedEvents: number;
  captureRate: number;
  dedupShare: number;
  heartbeatAllowance: number;
  pipelineThreshold: number;
  horizonMonths: number;
  daysPerMonth: number;
  eventsPerInference: number;
}

export interface ScenarioBridge {
  perModel: ModelContribution[];
  monthlyInferences: number;
  monthlyCost: number;
  monthlyValue: number;
  valueRatio: number;
  integrityInputs: {
    counterAlignment: {
      totalIngestedEvents: number;
      totalHardwareReportedEvents: number;
    };
    pipelineIntegrity: {
      uniqueProcessedTokens: number;
      rawIngestedTokens: number;
      expectedDroppedHeartbeats: number;
      threshold: number;
    };
    ledgerSync: {
      uiDisplayedBalance: number;
      immutableDatabaseBalance: number;
    };
  };
  derivations: ScenarioDerivations;
  flow: [FlowStage, FlowStage, FlowStage];
}

/** Normalizes raw mix weights to shares of exactly 100% (all-zero → all zero). */
export function normalizeMix(mixWeights: MixWeight[]): Map<string, number> {
  const out = new Map<string, number>();
  const total = mixWeights.reduce((sum, w) => sum + Math.max(w.weightPct, 0), 0);
  for (const w of mixWeights) {
    out.set(w.modelId, total > 0 ? (Math.max(w.weightPct, 0) / total) * 100 : 0);
  }
  return out;
}

/** The pure scenario→math bridge. Sync, side-effect free, fully seed-traceable. */
export function deriveScenario(inputs: ScenarioInputs): ScenarioBridge {
  const shares = normalizeMix(inputs.mixWeights);
  const growthFactor = Math.pow(1 + inputs.growthPctPerMonth / 100, SCENARIO_SEED.horizonMonths);
  const monthlyVolume = inputs.dailyInferences * SCENARIO_SEED.daysPerMonth * growthFactor;

  const perModel: ModelContribution[] = MIX_MODELS.map((m) => {
    const sharePct = shares.get(m.modelId) ?? 0;
    const monthlyInferences = (sharePct / 100) * monthlyVolume;
    const tokensIn = monthlyInferences * m.avgInputTokens;
    const tokensOut = monthlyInferences * m.avgOutputTokens;
    const cpi = costPerInference(m);
    return {
      modelId: m.modelId,
      displayName: m.displayName,
      sharePct,
      monthlyInferences,
      tokensIn,
      tokensOut,
      // Exact products: derived counts and money stay unrounded in the bridge
      // so rates reproduce the seeds exactly and cost stays strictly linear
      // in volume. Renderers round for display; the math never does.
      monthlyCost: (tokensIn * m.inputPer1m + tokensOut * m.outputPer1m) / 1_000_000,
      monthlyValue: valuePerInference(m) * monthlyInferences,
      costPerInference: cpi,
      valuePerInference: valuePerInference(m),
    };
  });

  const monthlyInferences = perModel.reduce((s, p) => s + p.monthlyInferences, 0);
  const monthlyCost = perModel.reduce((s, p) => s + p.monthlyCost, 0);
  const monthlyValue = perModel.reduce((s, p) => s + p.monthlyValue, 0);
  // The ratio is a displayed scalar (not a summed intermediate) — rounded to
  // cents-scale precision here so the meter and cards agree on one figure.
  const valueRatio = monthlyCost > 0 ? round2(monthlyValue / monthlyCost) : 0;

  // Integrity-metric inputs derived from the scenario's token flows. The rates
  // are applied as exact products — totalIngestedEvents ÷ reported reproduces
  // the seeded capture rate identically at ANY volume, so rounding at
  // derivation (rather than display) is what would break the seed contract.
  const hardwareReportedEvents = monthlyInferences * SCENARIO_SEED.eventsPerInference;
  const totalIngestedEvents = hardwareReportedEvents * SCENARIO_RATES.captureRate;
  const rawIngestedTokens = perModel.reduce((s, p) => s + p.tokensIn + p.tokensOut, 0);
  const uniqueProcessedTokens = rawIngestedTokens * SCENARIO_RATES.dedupShare;
  // Ledger: the recorded balance is the scenario's own monthly cost, and the
  // seeded reconciliation is exact — the UI never diverges from the ledger.
  const ledgerBalance = monthlyCost;

  const integrityInputs: ScenarioBridge['integrityInputs'] = {
    counterAlignment: {
      totalIngestedEvents,
      totalHardwareReportedEvents: hardwareReportedEvents,
    },
    pipelineIntegrity: {
      uniqueProcessedTokens,
      rawIngestedTokens,
      // Fractional allowance, unit assumption unchanged (see SCENARIO_RATES).
      expectedDroppedHeartbeats: SCENARIO_RATES.heartbeatAllowance,
      threshold: SCENARIO_RATES.pipelineThreshold,
    },
    ledgerSync: {
      uiDisplayedBalance: ledgerBalance,
      immutableDatabaseBalance: ledgerBalance,
    },
  };

  const derivations: ScenarioDerivations = {
    growthFactor,
    monthlyInferences,
    hardwareReportedEvents,
    captureRate: SCENARIO_RATES.captureRate,
    dedupShare: SCENARIO_RATES.dedupShare,
    heartbeatAllowance: SCENARIO_RATES.heartbeatAllowance,
    pipelineThreshold: SCENARIO_RATES.pipelineThreshold,
    horizonMonths: SCENARIO_SEED.horizonMonths,
    daysPerMonth: SCENARIO_SEED.daysPerMonth,
    eventsPerInference: SCENARIO_SEED.eventsPerInference,
  };

  const flow: [FlowStage, FlowStage, FlowStage] = [
    {
      layer: 'Hardware Ingest',
      inValue: hardwareReportedEvents,
      outValue: totalIngestedEvents,
      unit: 'events',
      lossValue: hardwareReportedEvents - totalIngestedEvents,
      lossLabel: 'capture gap',
      rateLabel: `capture rate ${(SCENARIO_RATES.captureRate * 100).toFixed(2)}% (seed 99,850 ÷ 100,000) · ${SCENARIO_SEED.eventsPerInference} event per inference`,
    },
    {
      layer: 'Data Pipeline',
      inValue: rawIngestedTokens,
      outValue: uniqueProcessedTokens,
      unit: 'tokens',
      lossValue: rawIngestedTokens - uniqueProcessedTokens,
      lossLabel: 'dedup drop',
      rateLabel: `dedup share ${(SCENARIO_RATES.dedupShare * 100).toFixed(1)}% (seed 980,000 ÷ 1,000,000) · heartbeat allowance ${(SCENARIO_RATES.heartbeatAllowance * 100).toFixed(1)}% of raw (unit assumption pending)`,
    },
    {
      layer: 'UI Presentation',
      inValue: ledgerBalance,
      outValue: ledgerBalance,
      unit: 'usd',
      lossValue: 0,
      lossLabel: 'reconciled',
      rateLabel: 'ledger sync — seeded exact reconciliation (delta must be exactly 0)',
    },
  ];

  return {
    perModel,
    monthlyInferences,
    monthlyCost,
    monthlyValue,
    valueRatio,
    integrityInputs,
    derivations,
    flow,
  };
}

/** Builds the integrity-metric report for a scenario bridge (shared assembly). */
export function buildScenarioReport(bridge: ScenarioBridge): TokenomicsReport {
  return buildTokenomicsReport(bridge.integrityInputs, new Date().toISOString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
