// Derived metrics — spec §2.1 unit_costs + value. Pure functions: given a
// workload's stored costs/outputs they compute the numbers the UI never stores.
// Cost is ALWAYS computed alongside its value context (spec R4).

import { findModel } from '@/data/models';
import type { ModelEntry, UnitCosts, Workload } from '@/types';

function safeDiv(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function deriveUnitCosts(workload: Workload): UnitCosts {
  const { costs, outputs } = workload;
  return {
    cost_per_call: safeDiv(costs.daily_spend, outputs.daily_inferences),
    cost_per_resolved: safeDiv(costs.daily_spend, outputs.resolved_queries),
    cost_per_user:
      outputs.active_users_monthly > 0
        ? costs.monthly_spend / outputs.active_users_monthly
        : null,
    cost_per_deflection:
      outputs.deflection_rate > 0
        ? safeDiv(costs.daily_spend, outputs.daily_inferences * outputs.deflection_rate)
        : null,
    cost_per_1k_tokens_in: safeDiv(costs.tokens_in_today / 1000, 1) > 0
      ? safeDiv(inputTokenCost(workload), costs.tokens_in_today / 1000)
      : 0,
    cost_per_1k_tokens_out: safeDiv(outputTokenCost(workload), costs.tokens_out_today / 1000),
  };
}

// Effective blended token costs are split from daily spend using the workload's
// stored input/output token volumes weighted by typical 1:4 input:output pricing.
// These are display approximations — the registry holds authoritative rates.
function inputTokenCost(workload: Workload): number {
  const { tokens_in_today, tokens_out_today, daily_spend } = workload.costs;
  const weightedIn = tokens_in_today;
  const weightedOut = tokens_out_today * 4;
  const total = weightedIn + weightedOut;
  return total > 0 ? daily_spend * (weightedIn / total) : 0;
}

function outputTokenCost(workload: Workload): number {
  const { tokens_in_today, tokens_out_today, daily_spend } = workload.costs;
  const weightedIn = tokens_in_today;
  const weightedOut = tokens_out_today * 4;
  const total = weightedIn + weightedOut;
  return total > 0 ? daily_spend * (weightedOut / total) : 0;
}

// --- Cache economics (conformance audit A3 — the L3 cache-hit-rate number) ---

/**
 * Materiality gate for surfacing cache economics: below this hit rate the cache
 * is not shaping a workload's cost story enough to earn UI space (calm register).
 */
export const CACHE_HIT_RATE_MATERIAL = 0.1;

/**
 * Cache-hit input rate for a registry model. Mirrors the seed's pricing rule:
 * when a model publishes no cached rate, cached tokens bill at 25% of input.
 */
export function cachedInputRate(model: ModelEntry): number {
  return model.pricing.cached_input_per_1m ?? model.pricing.input_per_1m * 0.25;
}

/**
 * Cache hit rate = cached tokens ÷ (cached + uncached input tokens). Pure over
 * token counts — a token fact, independent of pricing. `null` when the workload
 * used no input tokens at all: nothing to divide, never a fabricated 0%.
 */
export function deriveCacheHitRate(
  cachedTokens: number,
  uncachedInputTokens: number,
): number | null {
  const totalInput = cachedTokens + uncachedInputTokens;
  return totalInput > 0 ? cachedTokens / totalInput : null;
}

export interface CacheEconomics {
  /** Cache-hit input tokens today (billed at the cached rate). */
  cachedTokens: number;
  /** Uncached input tokens today (billed at the full input rate). */
  uncachedInputTokens: number;
  /** cached ÷ (cached + uncached) input; null with no input tokens. */
  hitRate: number | null;
  /** Registry rates behind the dollar split, per 1M tokens. */
  uncachedRatePer1m: number;
  cachedRatePer1m: number;
  /** Today's dollar split of the input tokens. */
  uncachedInputCostDaily: number;
  cachedCostDaily: number;
  /** What the cached tokens would have cost at the uncached rate, minus what they cost. */
  cacheDiscountDaily: number;
}

/**
 * The full cache picture for a workload: token split + hit rate + the
 * registry-priced dollars the seed's buildWorkload booked. Rates come from the
 * same registry the seed priced from; an unknown model keeps the token split
 * and reports zero rates rather than guessing one.
 */
export function deriveCacheEconomics(workload: Workload): CacheEconomics {
  const cachedTokens = workload.costs.tokens_cached_today;
  const uncachedInputTokens = workload.costs.tokens_in_today;
  const model = findModel(workload.model);
  const uncachedRatePer1m = model?.pricing.input_per_1m ?? 0;
  const cachedRatePer1m = model ? cachedInputRate(model) : 0;
  const uncachedInputCostDaily = (uncachedInputTokens / 1_000_000) * uncachedRatePer1m;
  const cachedCostDaily = (cachedTokens / 1_000_000) * cachedRatePer1m;
  return {
    cachedTokens,
    uncachedInputTokens,
    hitRate: deriveCacheHitRate(cachedTokens, uncachedInputTokens),
    uncachedRatePer1m,
    cachedRatePer1m,
    uncachedInputCostDaily,
    cachedCostDaily,
    cacheDiscountDaily: (cachedTokens / 1_000_000) * (uncachedRatePer1m - cachedRatePer1m),
  };
}

// Portfolio value ratio (spec §14.2 /portfolio/ratio).
export interface PortfolioRatio {
  portfolio_ratio: number;
  total_value: number;
  total_spend: number;
  workload_count: number;
  below_threshold: number;
  best: { id: string; name: string; ratio: number } | null;
  worst: { id: string; name: string; ratio: number } | null;
}

export function derivePortfolioRatio(
  workloads: Workload[],
  threshold = 3,
): PortfolioRatio {
  const total_value = workloads.reduce((sum, w) => sum + w.value.total_value, 0);
  const total_spend = workloads.reduce((sum, w) => sum + w.costs.monthly_spend, 0);
  const below_threshold = workloads.filter((w) => w.value.value_ratio < threshold).length;

  let best: PortfolioRatio['best'] = null;
  let worst: PortfolioRatio['worst'] = null;
  for (const w of workloads) {
    const entry = { id: w.id, name: w.name, ratio: w.value.value_ratio };
    if (!best || w.value.value_ratio > best.ratio) best = entry;
    if (!worst || w.value.value_ratio < worst.ratio) worst = entry;
  }

  return {
    portfolio_ratio: total_spend > 0 ? total_value / total_spend : 0,
    total_value,
    total_spend,
    workload_count: workloads.length,
    below_threshold,
    best,
    worst,
  };
}

export function governanceGatesPassed(workload: Workload): number {
  const g = workload.governance;
  return [g.policy_check, g.ethics_review, g.cost_approval, g.scale_authorized].filter(Boolean)
    .length;
}

export function allGatesPassed(workload: Workload): boolean {
  return governanceGatesPassed(workload) === 4;
}

