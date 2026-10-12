// Tests for the Multi-Model guardrail's daily-budget overshoot projection
// (obvious.md: "If a selected model would push daily spend over the daily
// budget, show a projected-overshoot warning"). Pins the over/under boundary —
// including exactly-at-budget (no warning) and zero-budget (percent undefined)
// — and grounds the warning in real registry + seed numbers (Fraud Triage).
import { describe, it, expect } from 'vitest';
import { projectedOvershoot, modelDailyCost } from './modelCompare';
import { MODEL_REGISTRY, findModel } from '@/data/models';
import { WORKLOADS } from '@/data/workloads';
import type { ModelEntry, Workload } from '@/types';

function mkModel(inputPer1m: number, outputPer1m: number): ModelEntry {
  return {
    id: `mdl-test-${inputPer1m}-${outputPer1m}`,
    provider: 'custom',
    model_name: `test-${inputPer1m}-${outputPer1m}`,
    display_name: `Test $${inputPer1m}/$${outputPer1m}`,
    pricing: {
      input_per_1m: inputPer1m,
      output_per_1m: outputPer1m,
      cached_input_per_1m: null,
      batch_input_per_1m: null,
      batch_output_per_1m: null,
    },
    context_window: 128_000,
    max_output: 8_192,
    supports_vision: false,
    supports_tools: false,
    supports_streaming: false,
    cost_tier: 'standard',
    last_price_update: '2026-06-01T00:00:00Z',
  };
}

// 1 call × 1M input + 1M output tokens → daily cost = input + output rates.
const ONE_EACH_VOLUME = { calls: 1, avgInputTokens: 1_000_000, avgOutputTokens: 1_000_000 };

function byId(id: string): Workload {
  const w = WORKLOADS.find((x) => x.id === id);
  if (!w) throw new Error(`missing seed workload: ${id}`);
  return w;
}

describe('projectedOvershoot — over/under boundary', () => {
  const model = mkModel(1, 2); // $3/day at ONE_EACH_VOLUME

  it('under budget → no warning', () => {
    expect(projectedOvershoot(model, ONE_EACH_VOLUME, 3.01)).toBeNull();
  });

  it('exactly at budget → no warning (over means strictly over)', () => {
    expect(projectedOvershoot(model, ONE_EACH_VOLUME, 3)).toBeNull();
  });

  it('just over → warning carries the exact overage amount and percent', () => {
    const o = projectedOvershoot(model, ONE_EACH_VOLUME, 2.99);
    expect(o).not.toBeNull();
    expect(o!.overAmount).toBeCloseTo(0.01, 10);
    expect(o!.overPct).toBeCloseTo((0.01 / 2.99) * 100, 6);
    expect(o!.projectedDaily).toBeCloseTo(3, 10);
    expect(o!.dailyBudget).toBe(2.99);
  });

  it('well over → amount and percent-over both correct', () => {
    const o = projectedOvershoot(model, ONE_EACH_VOLUME, 1.5);
    expect(o).not.toBeNull();
    expect(o!.overAmount).toBeCloseTo(1.5, 10);
    expect(o!.overPct).toBeCloseTo(100, 6); // $1.50 over a $1.50 budget = +100%
  });

  it('zero budget → amount is the full projection; percent honestly null', () => {
    const o = projectedOvershoot(model, ONE_EACH_VOLUME, 0);
    expect(o).not.toBeNull();
    expect(o!.overAmount).toBeCloseTo(3, 10);
    expect(o!.overPct).toBeNull();
  });

  it('zero volume at zero budget → nothing spent, no warning', () => {
    expect(
      projectedOvershoot(model, { calls: 0, avgInputTokens: 0, avgOutputTokens: 0 }, 0),
    ).toBeNull();
  });
});

describe('projectedOvershoot — grounded in the seeded registry + workloads', () => {
  // Fraud Triage Agent: current model opus, $160 daily budget. Volume derivation
  // mirrors MultiModelTab's (avg tokens per call, rounded).
  const fraud = byId('wl-fraud');
  const volume = {
    calls: fraud.outputs.daily_inferences,
    avgInputTokens: Math.round(fraud.costs.tokens_in_today / fraud.outputs.daily_inferences),
    avgOutputTokens: Math.round(fraud.costs.tokens_out_today / fraud.outputs.daily_inferences),
  };

  it('switching Fraud Triage (opus) to the ultra-tier GPT-4.5 breaks the $160 daily budget', () => {
    const gpt45 = findModel('gpt-4.5');
    if (!gpt45) throw new Error('missing registry model: gpt-4.5');
    const o = projectedOvershoot(gpt45, volume, fraud.costs.daily_budget);
    expect(o).not.toBeNull();
    // 5.58M input × $75 + 2.79M output × $150 = $837.00/day.
    expect(o!.projectedDaily).toBeCloseTo(837, 2);
    expect(o!.overAmount).toBeCloseTo(677, 2);
    expect(o!.overPct).toBeCloseTo(423.125, 6);
  });

  it('the current model already projects over budget (honest, not a switch artifact)', () => {
    const opus = findModel('claude-opus-4-20250514');
    if (!opus) throw new Error('missing registry model: claude-opus-4-20250514');
    const o = projectedOvershoot(opus, volume, fraud.costs.daily_budget);
    expect(o).not.toBeNull();
    // 5.58M input × $15 + 2.79M output × $75 = $292.95/day.
    expect(o!.projectedDaily).toBeCloseTo(292.95, 2);
    expect(o!.overAmount).toBeCloseTo(132.95, 2);
  });

  it('switching down to Sonnet stays under the daily budget → no warning', () => {
    const sonnet = findModel('claude-sonnet-4-20250514');
    if (!sonnet) throw new Error('missing registry model: claude-sonnet-4-20250514');
    expect(projectedOvershoot(sonnet, volume, fraud.costs.daily_budget)).toBeNull();
  });

  it('every registry model classifies consistently against one budget', () => {
    for (const model of MODEL_REGISTRY) {
      const o = projectedOvershoot(model, volume, fraud.costs.daily_budget);
      if (o === null) {
        expect(modelDailyCostTotal(model, volume)).toBeLessThanOrEqual(fraud.costs.daily_budget);
      } else {
        expect(o.overAmount).toBeGreaterThan(0);
      }
    }
  });
});

function modelDailyCostTotal(model: ModelEntry, volume: Parameters<typeof modelDailyCost>[1]): number {
  return modelDailyCost(model, volume).total;
}
