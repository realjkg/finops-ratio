// Test-only row builders for the recommendation engine suites. Not part of the
// public surface (index.ts does not export it).

import type { CommitmentFocusRow } from './commitments';

export const T0 = '2026-01-01T00:00:00Z';
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export const T0_MS = Date.parse(T0);

/** Window of `days` days starting at T0. */
export function win(days: number): { start: string; end: string } {
  return { start: T0, end: iso(T0_MS + days * DAY) };
}

const BASE: CommitmentFocusRow = {
  ChargePeriodStart: T0,
  ChargePeriodEnd: iso(T0_MS + HOUR),
  BillingCurrency: 'USD',
  ServiceName: 'Compute',
  ChargeCategory: 'Usage',
  ChargeFrequency: 'Usage-Based',
  PricingCategory: 'Standard',
  ListCost: 0,
  ContractedCost: 0,
  EffectiveCost: 0,
  BilledCost: 0,
};

/** On-demand usage row: `cost` is the on-demand basis (ContractedCost and ListCost). */
export function onDemand(cost: number, over: Partial<CommitmentFocusRow> = {}): CommitmentFocusRow {
  return { ...BASE, ContractedCost: cost, ListCost: cost, EffectiveCost: cost, BilledCost: cost, ...over };
}

/** Commitment-covered usage: `basis` on-demand equivalent, `effective` the amortized commitment cost. */
export function used(
  id: string,
  basis: number,
  effective: number,
  over: Partial<CommitmentFocusRow> = {},
): CommitmentFocusRow {
  return {
    ...BASE,
    PricingCategory: 'Committed',
    CommitmentDiscountId: id,
    CommitmentDiscountStatus: 'Used',
    CommitmentDiscountCategory: 'Spend',
    ContractedCost: basis,
    ListCost: basis,
    EffectiveCost: effective,
    BilledCost: 0,
    ...over,
  };
}

export function unused(id: string, effective: number, over: Partial<CommitmentFocusRow> = {}): CommitmentFocusRow {
  return {
    ...BASE,
    PricingCategory: 'Standard',
    CommitmentDiscountId: id,
    CommitmentDiscountStatus: 'Unused',
    CommitmentDiscountCategory: 'Spend',
    ContractedCost: 0,
    ListCost: 0,
    EffectiveCost: effective,
    BilledCost: 0,
    ...over,
  };
}

export function purchase(id: string, billed: number, over: Partial<CommitmentFocusRow> = {}): CommitmentFocusRow {
  return {
    ...BASE,
    ChargeCategory: 'Purchase',
    ChargeFrequency: 'One-Time',
    CommitmentDiscountId: id,
    ContractedCost: billed,
    ListCost: billed,
    EffectiveCost: 0,
    BilledCost: billed,
    ...over,
  };
}

/** One 24-hour on-demand row per day; `costOf(i)` is the day's on-demand cost in major units. */
export function dailyOnDemand(
  days: number,
  costOf: (day: number) => number,
  over: Partial<CommitmentFocusRow> = {},
): CommitmentFocusRow[] {
  const out: CommitmentFocusRow[] = [];
  for (let d = 0; d < days; d++) {
    out.push(
      onDemand(costOf(d), {
        ChargePeriodStart: iso(T0_MS + d * DAY),
        ChargePeriodEnd: iso(T0_MS + (d + 1) * DAY),
        ...over,
      }),
    );
  }
  return out;
}

/** One 1-hour on-demand row per hour for `days` days. */
export function hourlyOnDemand(
  days: number,
  costOf: (hourOfWindow: number) => number,
  over: Partial<CommitmentFocusRow> = {},
): CommitmentFocusRow[] {
  const out: CommitmentFocusRow[] = [];
  for (let h = 0; h < days * 24; h++) {
    out.push(
      onDemand(costOf(h), {
        ChargePeriodStart: iso(T0_MS + h * HOUR),
        ChargePeriodEnd: iso(T0_MS + (h + 1) * HOUR),
        ...over,
      }),
    );
  }
  return out;
}

/** Deterministic pseudo-random generator for property-style tests (LCG, no Math.random). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
