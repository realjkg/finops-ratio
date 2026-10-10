// Tests for the grounded recommendation math (Wave 4 Slice 5). Confirms the
// recommended action + projected impact are computed from real registry pricing,
// budget profile, demand-shape factors, and the value-ratio invariant — and that
// uncomputable impact is reported honestly as null ("not quantified"), never faked.
import { describe, it, expect } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import type { Workload } from '@/types';
import {
  recommendFor,
  cheaperSameCapabilityModel,
  VALUE_MINIMUM,
  VALUE_CRITICAL,
} from './recommendationMath';

function byId(id: string): Workload {
  const w = WORKLOADS.find((x) => x.id === id);
  if (!w) throw new Error(`missing seed workload: ${id}`);
  return w;
}

describe('recommendationMath', () => {
  // Fraud Triage's revised defensible numerator is negative, so it exercises
  // the value-review route. The switch-lift premise needs a positive numerator:
  // build one from the fraud seed (same registry/token mix) with a small
  // positive value below the 2× critical floor.
  function valueCriticalPositive(): Workload {
    const fraud = byId('wl-fraud');
    return {
      ...fraud,
      value: { ...fraud.value, total_value: 5000, value_ratio: 1.2 },
    };
  }

  it('value-critical workload (<2\u00d7, positive value) gets a capability-preserving model switch that lifts the ratio', () => {
    const w = valueCriticalPositive();
    expect(w.value.value_ratio).toBeLessThan(VALUE_CRITICAL);

    const rec = recommendFor(w);
    expect(rec.kind).toBe('model_switch');
    expect(rec.projectedMonthlyImpact).not.toBeNull();
    expect(rec.projectedMonthlyImpact!).toBeGreaterThan(0);
    // Switch must improve the ratio above the current value.
    expect(rec.projectedRatio!).toBeGreaterThan(w.value.value_ratio);
  });

  it('a non-positive defensible numerator routes to a value review, never a cost-side rescue (C3/C4)', () => {
    const fraud = byId('wl-fraud');
    expect(fraud.value.total_value).toBeLessThanOrEqual(0);

    const rec = recommendFor(fraud);
    // Cutting spend on negative value deepens the ratio — the honest
    // recommendation fixes the value side instead.
    expect(rec.kind).toBe('sunset_review');
    expect(rec.projectedMonthlyImpact).toBeNull();
    expect(rec.action).toContain('value review');
  });

  it('model-switch impact ties out to the value-ratio invariant', () => {
    const w = valueCriticalPositive();
    const rec = recommendFor(w);
    expect(rec.kind).toBe('model_switch');

    // recomputed spend = current spend - projected saving
    const newSpend = w.costs.monthly_spend - rec.projectedMonthlyImpact!;
    // value-ratio invariant: total_value / recomputed spend === projected ratio
    const invariantRatio = w.value.total_value / newSpend;
    expect(invariantRatio).toBeCloseTo(rec.projectedRatio!, 1);
  });

  it('picks the cheapest same-capability alternative within one cost tier', () => {
    const fraud = byId('wl-fraud');
    const alt = cheaperSameCapabilityModel(fraud);
    expect(alt).not.toBeNull();
    // Opus (premium) \u2192 Sonnet (standard): one tier down, same 200k context + tools/vision.
    expect(alt!.model.model_name).toBe('claude-sonnet-4-20250514');
    expect(alt!.costRatio).toBeLessThan(1);
  });

  it('budget kill-breach + unmanaged demand recommends demand shaping with a computed saving', () => {
    const marketing = byId('wl-marketing'); // unmanaged, over budget
    const rec = recommendFor(marketing);
    expect(rec.kind).toBe('demand_shaping');
    expect(rec.projectedMonthlyImpact!).toBeGreaterThan(0);
    // recomputed spend must stay below current spend.
    expect(marketing.costs.monthly_spend - rec.projectedMonthlyImpact!).toBeLessThan(
      marketing.costs.monthly_spend,
    );
    expect(rec.projectedRatio!).toBeGreaterThan(marketing.value.value_ratio);
  });

  it('demand-shaping projected ratio ties out to total_value / recomputed spend', () => {
    const marketing = byId('wl-marketing');
    const rec = recommendFor(marketing);
    const newSpend = marketing.costs.monthly_spend - rec.projectedMonthlyImpact!;
    expect(marketing.value.total_value / newSpend).toBeCloseTo(rec.projectedRatio!, 1);
  });

  it('missing governance gate recommends the next sequential gate, impact not quantified', () => {
    const sales = byId('wl-sales'); // policy/ethics/cost passed, scale not
    const rec = recommendFor(sales);
    expect(rec.kind).toBe('governance_gate');
    expect(rec.action).toContain('Scale');
    expect(rec.projectedMonthlyImpact).toBeNull();
    expect(rec.projectedRatio).toBeNull();
  });

  it('healthy workload above the minimum with all gates is monitor-only', () => {
    const support = byId('wl-support'); // 14.9\u00d7, all gates passed
    expect(support.value.value_ratio).toBeGreaterThanOrEqual(VALUE_MINIMUM);
    const rec = recommendFor(support);
    expect(rec.kind).toBe('monitor');
    expect(rec.projectedMonthlyImpact).toBeNull();
  });

  it('never fabricates an impact: governance/monitor/sunset are always null', () => {
    for (const w of WORKLOADS) {
      const rec = recommendFor(w);
      if (rec.kind === 'governance_gate' || rec.kind === 'monitor' || rec.kind === 'sunset_review') {
        expect(rec.projectedMonthlyImpact).toBeNull();
      } else {
        expect(rec.projectedMonthlyImpact).not.toBeNull();
        expect(rec.projectedMonthlyImpact!).toBeGreaterThan(0);
      }
      // Every recommendation carries an honest basis + confidence note.
      expect(rec.basis.length).toBeGreaterThan(0);
      expect(rec.confidence.length).toBeGreaterThan(0);
    }
  });
});

