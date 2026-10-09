// Scenario bridge tests — the math that turns a visitor scenario (model mix,
// daily volume, growth) into cost, value, and integrity inputs.
//
// Assertions are grounded in the actual seed/data sources — the exported
// tokenomics seeds (seeds.ts), the model registry (src/data/models.ts), and
// the seeded workloads (src/data/workloads.ts). Nothing is asserted from
// memory of what the numbers "should" be.
import { describe, it, expect } from 'vitest';
import {
  COUNTER_ALIGNMENT_SEED,
  PIPELINE_INTEGRITY_SEED,
  LEDGER_SYNC_SEED,
  METRIC_LABELS,
  SCENARIO_SEED,
  MIX_MODELS,
  DEFAULT_SCENARIO,
  SCENARIO_RATES,
  normalizeMix,
  deriveScenario,
  buildScenarioReport,
  costPerInference,
  valuePerInference,
  createTokenomicsClient,
} from './index';
import { MODEL_REGISTRY, findModel } from '@/data/models';
import { WORKLOADS } from '@/data/workloads';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** First seeded workload per model, in WORKLOADS order — the derivation MIX_MODELS mirrors. */
function expectedMixSeeds() {
  const seen = new Set<string>();
  const out: { modelId: string; valueRatioSeed: number; avgInputTokens: number; avgOutputTokens: number }[] = [];
  for (const w of WORKLOADS) {
    if (seen.has(w.model) || !findModel(w.model)) continue;
    seen.add(w.model);
    const daily = Math.max(w.outputs.daily_inferences, 1);
    out.push({
      modelId: w.model,
      valueRatioSeed: w.value.value_ratio,
      avgInputTokens: Math.round(w.costs.tokens_in_today / daily),
      avgOutputTokens: Math.round(w.costs.tokens_out_today / daily),
    });
  }
  return out;
}

describe('MIX_MODELS — traceable to the seeded portfolio', () => {
  it('mirrors the first seeded workload per registry model, in order', () => {
    const expected = expectedMixSeeds();
    expect(MIX_MODELS).toHaveLength(expected.length);
    MIX_MODELS.forEach((m, i) => {
      expect(m.modelId).toBe(expected[i].modelId);
      expect(m.valueRatioSeed).toBe(expected[i].valueRatioSeed);
      expect(m.avgInputTokens).toBe(expected[i].avgInputTokens);
      expect(m.avgOutputTokens).toBe(expected[i].avgOutputTokens);
    });
  });

  it('carries registry pricing for every model', () => {
    for (const m of MIX_MODELS) {
      const entry = findModel(m.modelId);
      expect(entry, `${m.modelId} must exist in MODEL_REGISTRY`).toBeDefined();
      expect(m.inputPer1m).toBe(entry!.pricing.input_per_1m);
      expect(m.outputPer1m).toBe(entry!.pricing.output_per_1m);
    }
  });

  it('excludes registry models with no seeded workload (no honest value basis)', () => {
    const workloadModels = new Set(WORKLOADS.map((w) => w.model));
    const unseeded = MODEL_REGISTRY.filter((m) => !workloadModels.has(m.model_name));
    expect(unseeded.length).toBeGreaterThan(0); // gpt-4.5 exists unseeded
    for (const m of unseeded) {
      expect(MIX_MODELS.map((x) => x.modelId)).not.toContain(m.model_name);
    }
  });
});

describe('normalizeMix', () => {
  it('normalizes weights to shares summing to exactly 100%', () => {
    const mix = normalizeMix([{ modelId: 'a', weightPct: 1 }, { modelId: 'b', weightPct: 2 }]);
    expect(sum([...mix.values()])).toBeCloseTo(100, 10);
  });

  it('is scale-invariant — shares depend only on relative weights', () => {
    const a = normalizeMix([{ modelId: 'a', weightPct: 40 }, { modelId: 'b', weightPct: 60 }]);
    const b = normalizeMix([{ modelId: 'a', weightPct: 4 }, { modelId: 'b', weightPct: 6 }]);
    expect([...a.values()]).toEqual([...b.values()]);
  });

  it('clamps negative slider values to zero share', () => {
    const mix = normalizeMix([{ modelId: 'a', weightPct: -10 }, { modelId: 'b', weightPct: 50 }]);
    expect(mix.get('a')).toBe(0);
    expect(mix.get('b')).toBe(100);
  });

  it('gives zero share to every model when all weights are zero (no NaN)', () => {
    const mix = normalizeMix([{ modelId: 'a', weightPct: 0 }, { modelId: 'b', weightPct: 0 }]);
    expect([...mix.values()].every((v) => v === 0)).toBe(true);
  });
});

describe('DEFAULT_SCENARIO — seeded portfolio defaults', () => {
  it('uses the portfolio total daily volume with zero growth assumed', () => {
    const dailyTotal = sum(WORKLOADS.map((w) => w.outputs.daily_inferences));
    expect(DEFAULT_SCENARIO.dailyInferences).toBe(dailyTotal);
    expect(DEFAULT_SCENARIO.growthPctPerMonth).toBe(SCENARIO_SEED.defaultGrowthPctPerMonth);
  });

  it('normalizes the mix weights to exactly 100%', () => {
    const total = sum(DEFAULT_SCENARIO.mixWeights.map((w) => Math.max(w.weightPct, 0)));
    expect(total).toBe(100);
    expect(DEFAULT_SCENARIO.mixWeights.map((w) => w.modelId)).toEqual(
      MIX_MODELS.map((m) => m.modelId),
    );
  });

  it('runs the portfolio volume through the horizon at the default growth', () => {
    const bridge = deriveScenario(DEFAULT_SCENARIO);
    const expected = DEFAULT_SCENARIO.dailyInferences * SCENARIO_SEED.daysPerMonth *
      Math.pow(1 + DEFAULT_SCENARIO.growthPctPerMonth / 100, SCENARIO_SEED.horizonMonths);
    // Per-model integer rounding can shift the total by at most 0.5 per model.
    expect(Math.abs(bridge.monthlyInferences - expected)).toBeLessThanOrEqual(MIX_MODELS.length / 2);
  });
});

describe('deriveScenario — cost', () => {
  it('prices each model from registry $/1M over its seeded token profile', () => {
    const bridge = deriveScenario(DEFAULT_SCENARIO);
    for (const c of bridge.perModel) {
      const m = MIX_MODELS.find((x) => x.modelId === c.modelId)!;
      const expected = (c.tokensIn * m.inputPer1m + c.tokensOut * m.outputPer1m) / 1_000_000;
      expect(c.monthlyCost).toBeCloseTo(expected, 2);
      expect(c.costPerInference).toBeCloseTo(costPerInference(m), 12);
    }
  });

  it('scales cost exactly linearly with volume (monotonic in dailyInferences)', () => {
    const small = deriveScenario({ ...DEFAULT_SCENARIO, dailyInferences: 10_000 });
    const large = deriveScenario({ ...DEFAULT_SCENARIO, dailyInferences: 20_000 });
    expect(large.monthlyCost).toBeGreaterThan(small.monthlyCost);
    expect(large.monthlyCost / small.monthlyCost).toBeCloseTo(2, 6);
  });

  it('increases cost when growth increases', () => {
    const flat = deriveScenario({ ...DEFAULT_SCENARIO, growthPctPerMonth: 0 });
    const growing = deriveScenario({ ...DEFAULT_SCENARIO, growthPctPerMonth: 5 });
    expect(growing.monthlyCost).toBeGreaterThan(flat.monthlyCost);
    const factor = Math.pow(1.05, SCENARIO_SEED.horizonMonths);
    expect(growing.monthlyInferences).toBeGreaterThan(flat.monthlyInferences);
    expect(growing.monthlyInferences / flat.monthlyInferences).toBeCloseTo(factor, 3);
  });
});

describe('deriveScenario — value (R4: value is the denominator)', () => {
  it('derives value per inference from the seeded ratio × seeded cost per inference', () => {
    for (const c of deriveScenario(DEFAULT_SCENARIO).perModel) {
      const m = MIX_MODELS.find((x) => x.modelId === c.modelId)!;
      expect(c.valuePerInference).toBeCloseTo(valuePerInference(m), 12);
      expect(c.valuePerInference).toBeCloseTo(m.valueRatioSeed * c.costPerInference, 12);
      expect(c.monthlyValue).toBeCloseTo(c.monthlyInferences * c.valuePerInference, 2);
    }
  });

  it('reproduces a workload value ratio exactly for a 100% single-model mix', () => {
    for (const m of MIX_MODELS) {
      const bridge = deriveScenario({
        dailyInferences: 50_000,
        growthPctPerMonth: 0,
        mixWeights: MIX_MODELS.map((x) => ({ modelId: x.modelId, weightPct: x.modelId === m.modelId ? 100 : 0 })),
      });
      // round2 on cost/value leaves the ratio within a cent's tolerance.
      expect(bridge.valueRatio).toBeCloseTo(m.valueRatioSeed, 1);
    }
  });

  it('keeps any mix inside the seeded scale bounds (weighted mean of seeded ratios)', () => {
    const seeds = MIX_MODELS.map((m) => m.valueRatioSeed);
    const lo = Math.min(...seeds);
    const hi = Math.max(...seeds);
    const mixes: number[][] = [
      [0, 0, 0, 0, 0, 100],
      [100, 0, 0, 0, 0, 0],
      [50, 50, 0, 0, 0, 0],
      [17, 0, 33, 0, 49, 1],
      [20, 20, 20, 20, 20, 0],
      [0, 25, 25, 25, 0, 25],
      [10, 10, 10, 10, 10, 50],
    ];
    for (const weights of mixes) {
      const bridge = deriveScenario({
        dailyInferences: 25_000,
        growthPctPerMonth: 3,
        mixWeights: MIX_MODELS.map((m, i) => ({ modelId: m.modelId, weightPct: weights[i] })),
      });
      expect(bridge.valueRatio).toBeGreaterThanOrEqual(lo - 0.05);
      expect(bridge.valueRatio).toBeLessThanOrEqual(hi + 0.05);
    }
  });

  it('is volume-invariant — volume scales cost and value equally', () => {
    const small = deriveScenario({ ...DEFAULT_SCENARIO, dailyInferences: 5_000 });
    const big = deriveScenario({ ...DEFAULT_SCENARIO, dailyInferences: 100_000 });
    expect(small.valueRatio).toBeCloseTo(big.valueRatio, 2);
    expect(big.monthlyCost).toBeGreaterThan(0);
  });
});

describe('deriveScenario — degenerate scenarios (no invented numbers)', () => {
  const zeroWeights = MIX_MODELS.map((m) => ({ modelId: m.modelId, weightPct: 0 }));

  it('costs and values zero on a zero-weight mix', () => {
    const bridge = deriveScenario({ dailyInferences: 1_000, growthPctPerMonth: 5, mixWeights: zeroWeights });
    expect(bridge.perModel.every((c) => c.monthlyCost === 0 && c.monthlyValue === 0 && c.monthlyInferences === 0)).toBe(true);
    expect(bridge.monthlyCost).toBe(0);
    expect(bridge.monthlyValue).toBe(0);
    expect(bridge.valueRatio).toBe(0);
  });

  it('reports failing integrity guards at zero volume (divide-by-zero guards, honest)', () => {
    const report = buildScenarioReport(deriveScenario({ ...DEFAULT_SCENARIO, dailyInferences: 0 }));
    expect(report.metrics.counterAlignment.pass).toBe(false);
    expect(report.metrics.pipelineIntegrity.pass).toBe(false);
    expect(report.metrics.ledgerSync.pass).toBe(true); // 0 − 0 is a legal pass
    expect(report.overallHealthy).toBe(false);
  });
});

describe('deriveScenario — derived integrity inputs', () => {
  const bridge = deriveScenario(DEFAULT_SCENARIO);
  const d = bridge.derivations;

  it('derives hardware events from volume × the seeded event factor', () => {
    expect(d.eventsPerInference).toBe(SCENARIO_SEED.eventsPerInference);
    expect(bridge.integrityInputs.counterAlignment.totalHardwareReportedEvents)
      .toBe(bridge.monthlyInferences * SCENARIO_SEED.eventsPerInference);
    expect(bridge.integrityInputs.counterAlignment.totalIngestedEvents)
      .toBe(bridge.monthlyInferences * d.captureRate);
  });

  it('derives raw and unique tokens from the scenario token flows and seeded factors', () => {
    const raw = bridge.perModel.reduce((s, p) => s + p.tokensIn + p.tokensOut, 0);
    expect(bridge.integrityInputs.pipelineIntegrity.rawIngestedTokens).toBe(raw);
    expect(bridge.integrityInputs.pipelineIntegrity.uniqueProcessedTokens)
      .toBe(raw * SCENARIO_RATES.dedupShare);
    expect(bridge.integrityInputs.pipelineIntegrity.expectedDroppedHeartbeats)
      .toBe(SCENARIO_RATES.heartbeatAllowance);
    expect(bridge.integrityInputs.pipelineIntegrity.threshold).toBe(SCENARIO_RATES.pipelineThreshold);
  });

  it('carries the seeded exact ledger reconciliation', () => {
    expect(bridge.integrityInputs.ledgerSync.uiDisplayedBalance).toBe(bridge.monthlyCost);
    expect(bridge.integrityInputs.ledgerSync.immutableDatabaseBalance).toBe(bridge.monthlyCost);
    expect(SCENARIO_RATES.ledgerDeltaSeed).toBe(0);
    expect(LEDGER_SYNC_SEED.uiDisplayedBalance).toBe(LEDGER_SYNC_SEED.immutableDatabaseBalance);
  });

  it('keeps the rates scale-invariant under volume change', () => {
    const other = deriveScenario({ ...DEFAULT_SCENARIO, dailyInferences: 123_456 });
    expect(other.derivations.captureRate).toBe(d.captureRate);
    expect(other.derivations.dedupShare).toBe(d.dedupShare);
    expect(other.derivations.heartbeatAllowance).toBe(d.heartbeatAllowance);
    expect(other.derivations.pipelineThreshold).toBe(d.pipelineThreshold);
  });

  it('derives flow stages coherently with the integrity inputs', () => {
    const [s1, s2, s3] = bridge.flow;
    expect(s1.inValue).toBe(bridge.integrityInputs.counterAlignment.totalHardwareReportedEvents);
    expect(s1.outValue).toBe(bridge.integrityInputs.counterAlignment.totalIngestedEvents);
    expect(s1.lossValue).toBe(s1.inValue - s1.outValue);
    expect(s1.unit).toBe('events');
    expect(s2.inValue).toBe(bridge.integrityInputs.pipelineIntegrity.rawIngestedTokens);
    expect(s2.outValue).toBe(bridge.integrityInputs.pipelineIntegrity.uniqueProcessedTokens);
    expect(s2.unit).toBe('tokens');
    expect(s3.inValue).toBe(s3.outValue);
    expect(s3.lossValue).toBe(0);
    expect(s3.unit).toBe('usd');
  });

  it('cites the seeds behind each rate in the flow labels (no-invented-numbers)', () => {
    const [s1, s2, s3] = bridge.flow;
    expect(s1.rateLabel).toContain('99,850 ÷ 100,000');
    expect(s2.rateLabel).toContain('980,000 ÷ 1,000,000');
    expect(s2.rateLabel).toContain('unit assumption pending');
    expect(s3.rateLabel).toContain('exactly 0');
    // And the rates equal the exported seeds exactly.
    expect(d.captureRate).toBe(COUNTER_ALIGNMENT_SEED.totalIngestedEvents / COUNTER_ALIGNMENT_SEED.totalHardwareReportedEvents);
    expect(d.dedupShare).toBe(PIPELINE_INTEGRITY_SEED.uniqueProcessedTokens / PIPELINE_INTEGRITY_SEED.rawIngestedTokens);
    expect(d.heartbeatAllowance).toBe(PIPELINE_INTEGRITY_SEED.expectedDroppedHeartbeats);
    expect(d.pipelineThreshold).toBe(PIPELINE_INTEGRITY_SEED.threshold);
  });
});

describe('buildScenarioReport', () => {
  it('reproduces the seeded integrity rates at the default scenario', () => {
    const report = buildScenarioReport(deriveScenario(DEFAULT_SCENARIO));
    const m = report.metrics;
    // Counter alignment reproduces the 99,850 ÷ 100,000 rate exactly.
    expect(m.counterAlignment.value).toBeCloseTo(99.85, 6);
    expect(m.counterAlignment.pass).toBe(true);
    // Pipeline integrity reproduces 98% unique − 0.5% heartbeat allowance.
    expect(m.pipelineIntegrity.value).toBeCloseTo(0.98 - 0.005, 9);
    expect(m.pipelineIntegrity.pass).toBe(true);
    // Ledger sync is exact.
    expect(m.ledgerSync.value).toEqual({ delta: 0, inSync: true });
    expect(m.ledgerSync.pass).toBe(true);
    expect(report.overallHealthy).toBe(true);
  });

  it('embeds the SAME metric labels as the mock report (one wiring, no drift)', async () => {
    const scenarioReport = buildScenarioReport(deriveScenario(DEFAULT_SCENARIO));
    const mockReport = await createTokenomicsClient('mock').getTokenomicsReport();
    for (const key of ['counterAlignment', 'pipelineIntegrity', 'ledgerSync'] as const) {
      expect(scenarioReport.metrics[key].layer).toBe(METRIC_LABELS[key].layer);
      expect(scenarioReport.metrics[key].focus).toBe(METRIC_LABELS[key].focus);
      expect(scenarioReport.metrics[key].formulaLabel).toBe(METRIC_LABELS[key].formulaLabel);
      expect(scenarioReport.metrics[key].formulaLabel).toBe(mockReport.metrics[key].formulaLabel);
    }
  });

  it('echoes the bridge integrity inputs verbatim into the report', () => {
    const bridge = deriveScenario({ ...DEFAULT_SCENARIO, dailyInferences: 40_000 });
    const report = buildScenarioReport(bridge);
    expect(report.metrics.counterAlignment.inputs).toEqual(bridge.integrityInputs.counterAlignment);
    expect(report.metrics.pipelineIntegrity.inputs).toEqual(bridge.integrityInputs.pipelineIntegrity);
    expect(report.metrics.ledgerSync.inputs).toEqual(bridge.integrityInputs.ledgerSync);
    // Cost per inference stays consistent with the bridge economics.
    expect(bridge.monthlyCost / bridge.monthlyInferences).toBeGreaterThan(0);
  });
});
