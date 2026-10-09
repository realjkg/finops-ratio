// Shared report assembly for the three integrity metrics — the single place
// that wires seed inputs to layer/focus/formulaLabel labels. Both the mock
// client (the /api/tokenomics seam) and the scenario playground call this so
// the two surfaces can never drift.
import { counterAlignment, pipelineIntegrity, ledgerSyncDelta } from './calculations';
import { METRIC_LABELS } from './seeds';
import type {
  TokenomicsReport,
  CounterAlignmentInputs,
  PipelineIntegrityInputs,
  LedgerSyncInputs,
} from './TokenomicsClient';

export interface MetricInputsBundle {
  counterAlignment: CounterAlignmentInputs;
  pipelineIntegrity: PipelineIntegrityInputs;
  ledgerSync: LedgerSyncInputs;
}

export function buildTokenomicsReport(
  inputs: MetricInputsBundle,
  generatedAt: string,
): TokenomicsReport {
  const caResult = counterAlignment(inputs.counterAlignment);
  const piResult = pipelineIntegrity(inputs.pipelineIntegrity);
  const lsResult = ledgerSyncDelta(inputs.ledgerSync);

  return {
    generatedAt,
    overallHealthy: caResult.pass && piResult.pass && lsResult.inSync,
    metrics: {
      counterAlignment: {
        ...METRIC_LABELS.counterAlignment,
        value: caResult.percentage,
        pass: caResult.pass,
        inputs: inputs.counterAlignment,
      },
      pipelineIntegrity: {
        ...METRIC_LABELS.pipelineIntegrity,
        value: piResult.score,
        pass: piResult.pass,
        inputs: inputs.pipelineIntegrity,
      },
      ledgerSync: {
        ...METRIC_LABELS.ledgerSync,
        value: lsResult,
        pass: lsResult.inSync,
        inputs: inputs.ledgerSync,
      },
    },
  };
}
