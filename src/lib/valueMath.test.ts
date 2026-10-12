// Defensible-value tests — audit C3/C4 (quality floor, harm subtraction).
// Verifies the revised value-ratio invariant: outputs missing the quality
// floor contribute no value, harm from misses is subtracted, a non-positive
// numerator is never floored to a fake positive ratio, and every seeded
// workload satisfies the invariant with honestly-marked components.

import { describe, it, expect } from 'vitest';
import {
  deriveDefensibleValue,
  deriveWorkloadValue,
} from './valueMath';
import { WORKLOADS } from '@/data/workloads';
import { headlineEvidenceStatus } from './valueEvidence';

describe('deriveDefensibleValue — quality floor gating (C3)', () => {
  it('counts only the floor-passing share of claimed value', () => {
    const r = deriveDefensibleValue(
      {
        revenue_protected: 100,
        cost_avoided: 100,
        quality_floor_pass_rate: 0.5,
      },
      100,
    );
    expect(r.gross_value).toBe(200);
    expect(r.counted_value).toBe(100);
    expect(r.total_value).toBe(100);
    expect(r.value_ratio).toBe(1.0);
    expect(r.floor_applied).toBe(true);
  });

  it('at a pass rate of 1 the numerator equals the claimed value', () => {
    const r = deriveDefensibleValue(
      {
        revenue_protected: 150,
        cost_avoided: 50,
        quality_floor_pass_rate: 1,
      },
      100,
    );
    expect(r.counted_value).toBe(200);
    expect(r.total_value).toBe(200);
  });

  it('clamps out-of-range pass rates — a bad rate can never inflate value above the claim', () => {
    const above = deriveDefensibleValue(
      { revenue_protected: 100, cost_avoided: 0, quality_floor_pass_rate: 1.2 },
      100,
    );
    expect(above.counted_value).toBe(100);
    const below = deriveDefensibleValue(
      { revenue_protected: 100, cost_avoided: 0, quality_floor_pass_rate: -0.1 },
      100,
    );
    expect(below.counted_value).toBe(0);
    expect(below.total_value).toBe(0);
  });
});

describe('deriveDefensibleValue — harm subtraction (C4)', () => {
  it('subtracts harm from misses after the floor gate', () => {
    const r = deriveDefensibleValue(
      {
        revenue_protected: 100,
        cost_avoided: 100,
        quality_floor_pass_rate: 0.5,
        harm_from_misses: 25,
      },
      100,
    );
    expect(r.counted_value).toBe(100);
    expect(r.total_value).toBe(75);
    expect(r.value_ratio).toBe(0.75);
  });

  it('harm applies even when the floor is not configured (harm-only shape)', () => {
    const r = deriveDefensibleValue(
      { revenue_protected: 100, cost_avoided: 50, harm_from_misses: 30 },
      100,
    );
    expect(r.floor_applied).toBe(false);
    expect(r.total_value).toBe(120);
    expect(r.value_ratio).toBe(1.2);
  });
});

describe('deriveDefensibleValue — legacy shapes pass through ungated', () => {
  it('without floor or harm the math is identical to the pre-C3/C4 invariant', () => {
    const r = deriveDefensibleValue(
      { revenue_protected: 100, cost_avoided: 50 },
      100,
    );
    expect(r.floor_applied).toBe(false);
    expect(r.total_value).toBe(150);
    expect(r.value_ratio).toBe(1.5);
  });
});

describe('deriveDefensibleValue — non-positive numerator renders honestly', () => {
  it('a negative numerator is never floored: the ratio goes negative', () => {
    const r = deriveDefensibleValue(
      {
        revenue_protected: 100,
        cost_avoided: 50,
        quality_floor_pass_rate: 0.5,
        harm_from_misses: 200, // harm exceeds counted value
      },
      100,
    );
    expect(r.total_value).toBe(-125);
    expect(r.value_ratio).toBe(-1.25);
  });

  it('exactly zero harm with a zero pass rate yields ratio 0, not a positive figure', () => {
    const r = deriveDefensibleValue(
      {
        revenue_protected: 100,
        cost_avoided: 50,
        quality_floor_pass_rate: 0,
        harm_from_misses: 0,
      },
      100,
    );
    expect(r.total_value).toBe(0);
    expect(r.value_ratio).toBe(0);
  });

  it('zero monthly spend does not divide by zero', () => {
    const r = deriveDefensibleValue(
      { revenue_protected: 100, cost_avoided: 0, quality_floor_pass_rate: 0.5 },
      0,
    );
    expect(r.value_ratio).toBe(0);
  });
});

describe('revised value-ratio invariant on the seed (by construction)', () => {
  it('every stored workload satisfies ratio = total_value / monthly_spend (2dp rounding)', () => {
    for (const w of WORKLOADS) {
      const derived = deriveWorkloadValue(w);
      expect(Math.round(derived.total_value)).toBe(w.value.total_value);
      expect(w.value.value_ratio).toBeCloseTo(
        w.value.total_value / w.costs.monthly_spend,
        2,
      );
    }
  });

  it('the stored numerator equals the gated, harm-subtracted components', () => {
    for (const w of WORKLOADS) {
      const { quality_floor_pass_rate, harm_from_misses } = w.value;
      const expected =
        (w.value.revenue_protected + w.value.cost_avoided) *
          (quality_floor_pass_rate ?? 1) -
        (harm_from_misses ?? 0);
      expect(w.value.total_value).toBe(Math.round(expected));
    }
  });

  it('the floor genuinely lowers at least one headline (the gate is not decorative)', () => {
    const gated = WORKLOADS.filter((w) => w.value.quality_floor_pass_rate !== undefined);
    expect(gated.length).toBeGreaterThan(0);
    for (const w of gated) {
      const gross = w.value.revenue_protected + w.value.cost_avoided;
      expect(w.value.total_value).toBeLessThan(gross);
    }
  });

  it('seeds the honest non-positive case: a workload whose misses destroy its value', () => {
    const fraud = WORKLOADS.find((w) => w.id === 'wl-fraud');
    expect(fraud).toBeDefined();
    expect(fraud!.value.total_value).toBeLessThanOrEqual(0);
    expect(fraud!.value.value_ratio).toBeLessThanOrEqual(0);
  });
});

describe('seed provenance for the new components (honesty: never measured)', () => {
  it('every seeded workload marks harm and floor, and the headline inherits the weakest', () => {
    for (const w of WORKLOADS) {
      expect(w.value.evidence?.harm_from_misses).toBe('assumed');
      expect(w.value.evidence?.quality_floor_pass_rate).toBe('assumed');
      expect(w.value.evidence?.revenue_protected).not.toBe('measured');
      expect(headlineEvidenceStatus(w.value)).toBe('assumed');
    }
  });
});
