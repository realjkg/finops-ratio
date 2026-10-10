// Tokenomics slice public API — mirrors src/finio/index.ts.
// Callers only ever see the TokenomicsClient interface and createTokenomicsClient;
// concrete implementations are internal details.
import { LiveTokenomicsClient } from './LiveTokenomicsClient';
import { MockTokenomicsClient } from './MockTokenomicsClient';
import type { TokenomicsClient } from './TokenomicsClient';

export type {
  TokenomicsClient,
  TokenomicsMetric,
  TokenomicsMetricInputs,
  TokenomicsReport,
  CounterAlignmentInputs,
  PipelineIntegrityInputs,
  LedgerSyncInputs,
} from './TokenomicsClient';

// Scenario playground public API — the pure bridge, its seeds, and derived
// rates. The playground component and tests import from here.
export {
  COUNTER_ALIGNMENT_SEED,
  PIPELINE_INTEGRITY_SEED,
  LEDGER_SYNC_SEED,
  METRIC_LABELS,
  SCENARIO_SEED,
} from './seeds';
export type { MetricLabel } from './seeds';
export {
  MIX_MODELS,
  DEFAULT_SCENARIO,
  SCENARIO_RATES,
  normalizeMix,
  deriveScenario,
  buildScenarioReport,
  costPerInference,
  valuePerInference,
} from './scenario';
export type {
  MixModelSeed,
  MixWeight,
  ScenarioInputs,
  ModelContribution,
  FlowStage,
  FlowUnit,
  ScenarioDerivations,
  ScenarioBridge,
} from './scenario';
export { buildTokenomicsReport } from './reportAssembly';
export type { MetricInputsBundle } from './reportAssembly';

/** Returns MockTokenomicsClient by default; pass `'live'` to get LiveTokenomicsClient. */
export function createTokenomicsClient(
  mode: 'mock' | 'live' = 'mock',
): TokenomicsClient {
  return mode === 'live' ? new LiveTokenomicsClient() : new MockTokenomicsClient();
}

