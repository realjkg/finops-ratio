// Tests for the cache-economics derivation (conformance audit A3 — the L3
// cache-hit-rate number). Confirms the hit rate is pure token math with honest
// edges (zero uncached, all-cached, no input at all → null, never a fabricated
// 0%), that dollars price from the same registry rates the seed booked with,
// and that the findings materiality gate selects exactly the workloads whose
// ratios cache economics genuinely explain.
import { describe, it, expect } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { findModel } from '@/data/models';
import type { Workload } from '@/types';
import {
  CACHE_HIT_RATE_MATERIAL,
  cachedInputRate,
  deriveCacheEconomics,
  deriveCacheHitRate,
} from './derive';

function byId(id: string): Workload {
  const w = WORKLOADS.find((x) => x.id === id);
  if (!w) throw new Error(`missing seed workload: ${id}`);
  return w;
}

describe('deriveCacheHitRate', () => {
  it('computes cached ÷ (cached + uncached input tokens)', () => {
    expect(deriveCacheHitRate(9_500_000, 48_000_000)).toBeCloseTo(9.5 / 57.5);
  });

  it('returns 1.0 when every input token is cached (zero-uncached / all-cached edge)', () => {
    expect(deriveCacheHitRate(5_000_000, 0)).toBe(1);
  });

  it('returns 0.0 when no input token is cached', () => {
    expect(deriveCacheHitRate(0, 48_000_000)).toBe(0);
  });

  it('returns null — not a fabricated 0% — when the workload used no input tokens', () => {
    expect(deriveCacheHitRate(0, 0)).toBeNull();
  });
});

describe('cachedInputRate', () => {
  it('uses the registry cached rate when the model publishes one', () => {
    const sonnet = findModel('claude-sonnet-4-20250514');
    expect(sonnet).toBeDefined();
    expect(cachedInputRate(sonnet!)).toBe(0.3);
  });

  it('falls back to 25% of the input rate when the registry publishes none', () => {
    const sonnet = findModel('claude-sonnet-4-20250514');
    expect(sonnet).toBeDefined();
    const noCachedRate = {
      ...sonnet!,
      pricing: { ...sonnet!.pricing, cached_input_per_1m: null },
    };
    expect(cachedInputRate(noCachedRate)).toBeCloseTo(0.75);
  });
});

describe('deriveCacheEconomics', () => {
  it('prices the split from the same registry rates the seed booked', () => {
    const support = byId('wl-support'); // claude-sonnet-4: $3.00 in / $0.30 cached
    const econ = deriveCacheEconomics(support);

    expect(econ.cachedTokens).toBe(support.costs.tokens_cached_today);
    expect(econ.uncachedInputTokens).toBe(support.costs.tokens_in_today);
    expect(econ.uncachedRatePer1m).toBe(3.0);
    expect(econ.cachedRatePer1m).toBe(0.3);
    expect(econ.cachedCostDaily).toBeCloseTo(2.85); // 9.5M × $0.30/1M
    expect(econ.cacheDiscountDaily).toBeCloseTo(25.65); // 9.5M × ($3.00 − $0.30)/1M
    expect(econ.hitRate).toBeCloseTo(9.5 / 57.5);
  });

  it('keeps the token split derivable when the model is unknown — zero rates, no guessed price', () => {
    const ghost: Workload = { ...byId('wl-support'), model: 'not-in-registry' };
    const econ = deriveCacheEconomics(ghost);

    expect(econ.hitRate).toBeCloseTo(9.5 / 57.5); // a token fact, pricing-independent
    expect(econ.uncachedRatePer1m).toBe(0);
    expect(econ.cachedRatePer1m).toBe(0);
    expect(econ.cachedCostDaily).toBe(0);
    expect(econ.cacheDiscountDaily).toBe(0);
  });

  it('reconciles with the seed: registry-priced token costs + 5% overhead equal daily_spend', () => {
    for (const w of WORKLOADS) {
      const econ = deriveCacheEconomics(w);
      const outputRate = findModel(w.model)?.pricing.output_per_1m ?? 0;
      const outputCost = (w.costs.tokens_out_today / 1_000_000) * outputRate;
      // buildWorkload's overhead applies to (uncached input + output) only —
      // cached tokens carry no compute overhead — then rounds to cents.
      const overhead = (econ.uncachedInputCostDaily + outputCost) * 0.05;
      expect(
        econ.uncachedInputCostDaily + econ.cachedCostDaily + outputCost + overhead,
      ).toBeCloseTo(w.costs.daily_spend, 1);
    }
  });

  it('materiality gate selects exactly the workloads whose ratios cache economics explain', () => {
    const material = WORKLOADS.filter((w) => {
      const econ = deriveCacheEconomics(w);
      return (
        econ.hitRate !== null &&
        econ.hitRate >= CACHE_HIT_RATE_MATERIAL &&
        econ.cacheDiscountDaily > 0
      );
    }).map((w) => w.id);
    // Seed hit rates: support 16.5%, sales 16.9%, codereview 12.3%, knowledge 10.1% —
    // everything else sits below the 10% gate (triage next at 8.1%).
    expect(material).toEqual(['wl-support', 'wl-sales', 'wl-codereview', 'wl-knowledge']);
  });
});
