// Tokenomics seed module — the single exported source of seed truth for the
// slice. Moved out of MockTokenomicsClient so the scenario playground derives
// its rates from the same seeds instead of re-declaring private constants.
//
// The values are chosen to produce the mock report:
//   Metric 1 — counter alignment ~99.85% (pass)
//   Metric 2 — pipeline integrity ~0.975 (pass, threshold 0.95)
//   Metric 3 — ledger delta exactly 0 (in-sync, pass)

import type {
  CounterAlignmentInputs,
  PipelineIntegrityInputs,
  LedgerSyncInputs,
} from './TokenomicsClient';

// ---------------------------------------------------------------------------
// Integrity-metric seed inputs
// ---------------------------------------------------------------------------

export const COUNTER_ALIGNMENT_SEED: CounterAlignmentInputs = {
  totalIngestedEvents: 99_850,
  totalHardwareReportedEvents: 100_000,
};

export const PIPELINE_INTEGRITY_SEED: PipelineIntegrityInputs = {
  uniqueProcessedTokens: 980_000,
  rawIngestedTokens: 1_000_000,
  // Fractional allowance: 0.5% of raw as expected heartbeat drop.
  // See ASSUMPTION note in calculations.ts and TokenomicsClient.ts.
  expectedDroppedHeartbeats: 0.005,
  threshold: 0.95,
};

// Ledger balances match exactly — delta should be 0, inSync true.
export const LEDGER_SYNC_SEED: LedgerSyncInputs = {
  uiDisplayedBalance: 842_350,
  immutableDatabaseBalance: 842_350,
};

// ---------------------------------------------------------------------------
// Metric labels — one wiring of layer/focus/formula, shared by the mock
// client and the scenario playground so the two can never drift.
// ---------------------------------------------------------------------------

export interface MetricLabel {
  layer: string;
  focus: string;
  formulaLabel: string;
}

export const METRIC_LABELS: {
  counterAlignment: MetricLabel;
  pipelineIntegrity: MetricLabel;
  ledgerSync: MetricLabel;
} = {
  counterAlignment: {
    layer: 'Hardware Ingest',
    focus: 'Counter Alignment',
    formulaLabel: '(Ingested Events ÷ Hardware-Reported Events) × 100',
  },
  pipelineIntegrity: {
    layer: 'Data Pipeline',
    focus: 'Deduplication & Loss',
    formulaLabel: '(Unique Processed Tokens ÷ Raw Ingested Tokens) − Expected Dropped Heartbeats',
  },
  ledgerSync: {
    layer: 'UI Presentation',
    focus: 'Ledger Sync',
    formulaLabel: 'UI Displayed Balance − Immutable Database Balance',
  },
};

// ---------------------------------------------------------------------------
// Scenario playground seeds
// ---------------------------------------------------------------------------

// Playground scenario constants. Each is a named, displayed seed — the UI
// shows them in the derivations panel so every output stays traceable.
export const SCENARIO_SEED = {
  // Growth compounds over a 3-month horizon — a quarter run-rate.
  horizonMonths: 3,
  // Days per month, matching historyFor's monthlySpend / 30 convention
  // in src/data/workloads.ts.
  daysPerMonth: 30,
  // Telemetry identity: each inference produces exactly one hardware-side
  // event (the integrity layers measure the usage ledger of the workload).
  eventsPerInference: 1,
  // Neutral growth default — the visitor opts into growth.
  defaultGrowthPctPerMonth: 0,
} as const;
