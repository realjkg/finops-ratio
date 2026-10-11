// Test-only helpers for src/detection: a seeded deterministic PRNG, row and
// series builders. Nothing in production code imports this file. The PRNG is
// defined here (not Math.random) so every test is offline and reproducible.

import { addDays, parseDay } from './dates';
import type { CostRowInput } from './series';
import { round6, seriesId, type DailySeries, type SeriesKey } from './types';

/** mulberry32: small, fast, deterministic 32-bit PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw by Box-Muller from a uniform generator. */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const TENANT = 'tenant-1';

export function row(overrides: Partial<CostRowInput> = {}): CostRowInput {
  return {
    BilledCost: 10,
    EffectiveCost: 8,
    BillingCurrency: 'USD',
    ChargePeriodStart: '2026-03-01T00:00:00Z',
    ChargePeriodEnd: '2026-03-02T00:00:00Z',
    BillingAccountId: TENANT,
    SubAccountId: 'acct-a',
    ServiceName: 'Compute',
    ChargeCategory: 'Usage',
    x_RatioRegion: 'us-east-1',
    ...overrides,
  };
}

export interface SeriesSpec {
  readonly tenant?: string;
  readonly currency?: string;
  readonly account?: string;
  readonly service?: string;
  readonly region?: string;
  readonly start: string;
  /** One value per consecutive day starting at `start`; null means no row that day. */
  readonly values: readonly (number | null)[];
}

/** Builds a DailySeries directly (bypassing buildDailySeries) for model tests. */
export function mkSeries(spec: SeriesSpec): DailySeries {
  const key: SeriesKey = {
    tenant: spec.tenant ?? TENANT,
    currency: spec.currency ?? 'USD',
    account: spec.account ?? 'acct-a',
    service: spec.service ?? 'Compute',
    region: spec.region ?? '',
  };
  const points: { day: string; value: number }[] = [];
  spec.values.forEach((v, i) => {
    if (v !== null) points.push({ day: addDays(spec.start, i), value: round6(v) });
  });
  return { id: seriesId(key), key, costField: 'EffectiveCost', points };
}

/** Day string `n` days after `start`. */
export function dayAfter(start: string, n: number): string {
  return addDays(start, n);
}

export function dayNumber(day: string): number {
  return parseDay(day);
}

/** Weekly multiplicative pattern indexed by weekday (0 = Sunday). */
export const WEEKLY_PATTERN: readonly number[] = [0.6, 1.05, 1.1, 1.1, 1.1, 1.05, 0.6];

export const START = '2026-01-01';

export interface SynthSpec {
  readonly n: number;
  readonly base: number;
  readonly noise: number;
  readonly seed: number;
  readonly start?: string;
  readonly tenant?: string;
  readonly currency?: string;
  readonly account?: string;
  readonly service?: string;
  readonly region?: string;
  /** Apply the weekly pattern (default true). */
  readonly weekly?: boolean;
  /** Per-index modifier of the generated value; return null to drop the day. */
  readonly mod?: (index: number, value: number) => number | null;
}

/** Deterministic noisy series: base x weekday pattern x (1 + noise * N(0, 1)), floored at 0. */
export function synth(spec: SynthSpec): DailySeries {
  const rng = mulberry32(spec.seed);
  const start = spec.start ?? START;
  const startDn = parseDay(start);
  const weekly = spec.weekly ?? true;
  const values: (number | null)[] = [];
  for (let i = 0; i < spec.n; i += 1) {
    const f = weekly ? (WEEKLY_PATTERN[(((startDn + i + 4) % 7) + 7) % 7] as number) : 1;
    const v = Math.max(0, spec.base * f * (1 + spec.noise * gaussian(rng)));
    values.push(spec.mod ? spec.mod(i, v) : v);
  }
  return mkSeries({
    start,
    values,
    ...(spec.tenant !== undefined ? { tenant: spec.tenant } : {}),
    ...(spec.currency !== undefined ? { currency: spec.currency } : {}),
    ...(spec.account !== undefined ? { account: spec.account } : {}),
    ...(spec.service !== undefined ? { service: spec.service } : {}),
    ...(spec.region !== undefined ? { region: spec.region } : {}),
  });
}

/** Day string for index `i` of a series that starts at START. */
export function dayAt(i: number, start: string = START): string {
  return addDays(start, i);
}
