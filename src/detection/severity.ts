// Anomaly configuration (with floors) and the severity matrix (design 4.4).
//
// Trust boundary: a config object is untrusted. Unknown keys are refused
// (deny by default), every number is range-checked against a floor so a
// threshold cannot be configured away (a zero minimum impact or a 0 percent
// deviation would alert on noise), and errors are fixed text.
//
// Severity matrix (per candidate, using its window's MEAN daily excess x and
// relative deviation r = sum(excess) / sum(expected); r is unbounded when the
// expected value is zero or less and the excess is positive):
//   critical: x >= criticalMultiple * min AND r >= criticalRelative
//             OR cumulative impact >= cumulativeCriticalMultiple * min
//   warning : x >= min AND r >= warningRelative
//   info    : anything else flagged; every decrease (spend_drop) is info.
// All comparisons are inclusive (>=) and tolerate 1e-9 relative rounding noise,
// so values exactly on a boundary classify deterministically.

import { DetectionError, isCurrency, type Severity } from './types';

export interface AnomalyConfig {
  /** Per-currency minimum daily impact; merged over the defaults. */
  readonly minImpact?: Readonly<Record<string, number>>;
  readonly warningRelative?: number;
  readonly criticalRelative?: number;
  readonly criticalMultiple?: number;
  readonly cumulativeCriticalMultiple?: number;
  /** Robust z threshold for the residual detectors (design z_T = 4.5). */
  readonly zThreshold?: number;
  /** Observed days a series needs before the statistical detectors run. */
  readonly minHistoryDays?: number;
  /** Account age in days before novelty detection applies to it. */
  readonly noveltyMinAccountAgeDays?: number;
  /** Fan-in size for service and account groups. */
  readonly groupMinMembers?: number;
  /** Share of a tenant-currency's scored leaves for a tenant-wide group. */
  readonly tenantFanInShare?: number;
  /** May lower the findings cap, never raise it. */
  readonly maxFindings?: number;
}

export interface ResolvedConfig {
  readonly minImpact: Readonly<Record<string, number>>;
  readonly warningRelative: number;
  readonly criticalRelative: number;
  readonly criticalMultiple: number;
  readonly cumulativeCriticalMultiple: number;
  readonly zThreshold: number;
  readonly minHistoryDays: number;
  readonly noveltyMinAccountAgeDays: number;
  readonly groupMinMembers: number;
  readonly tenantFanInShare: number;
  readonly maxFindings: number;
}

/** Design D-13 defaults: 100 per day, JPY 15,000. */
export const DEFAULT_MIN_IMPACT: Readonly<Record<string, number>> = Object.freeze({
  USD: 100,
  EUR: 100,
  GBP: 100,
  JPY: 15_000,
});

/** Floors: the lowest values an operator may configure. */
export const FLOORS = Object.freeze({
  minImpact: 0.01,
  warningRelative: 0.05,
  zThreshold: 3,
  minHistoryDays: 7,
  noveltyMinAccountAgeDays: 7,
  groupMinMembers: 2,
  tenantFanInShare: 0.05,
});

export const MAX_FINDINGS = 5_000;

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'minImpact',
  'warningRelative',
  'criticalRelative',
  'criticalMultiple',
  'cumulativeCriticalMultiple',
  'zThreshold',
  'minHistoryDays',
  'noveltyMinAccountAgeDays',
  'groupMinMembers',
  'tenantFanInShare',
  'maxFindings',
]);

function num(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new DetectionError('CONFIG_INVALID');
  }
  return value;
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  const n = num(value, min, max, fallback);
  if (!Number.isInteger(n)) throw new DetectionError('CONFIG_INVALID');
  return n;
}

export function resolveConfig(config?: AnomalyConfig): ResolvedConfig {
  if (config === undefined) return resolveConfig({});
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new DetectionError('CONFIG_INVALID');
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) throw new DetectionError('CONFIG_INVALID');
  }
  const minImpact: Record<string, number> = { ...DEFAULT_MIN_IMPACT };
  if (config.minImpact !== undefined) {
    const given = config.minImpact;
    if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new DetectionError('CONFIG_INVALID');
    const entries = Object.entries(given);
    if (entries.length > 64) throw new DetectionError('CONFIG_INVALID');
    for (const [currency, amount] of entries) {
      if (!isCurrency(currency)) throw new DetectionError('CONFIG_INVALID');
      minImpact[currency] = num(amount, FLOORS.minImpact, 1e12, 0);
    }
  }
  const warningRelative = num(config.warningRelative, FLOORS.warningRelative, 10, 0.2);
  const criticalRelative = num(config.criticalRelative, warningRelative, 100, Math.max(0.5, warningRelative));
  const criticalMultiple = num(config.criticalMultiple, 1, 1000, 10);
  return {
    minImpact,
    warningRelative,
    criticalRelative,
    criticalMultiple,
    cumulativeCriticalMultiple: num(config.cumulativeCriticalMultiple, criticalMultiple, 100_000, Math.max(50, criticalMultiple)),
    zThreshold: num(config.zThreshold, FLOORS.zThreshold, 20, 4.5),
    minHistoryDays: int(config.minHistoryDays, FLOORS.minHistoryDays, 120, 14),
    noveltyMinAccountAgeDays: int(config.noveltyMinAccountAgeDays, FLOORS.noveltyMinAccountAgeDays, 365, 30),
    groupMinMembers: int(config.groupMinMembers, FLOORS.groupMinMembers, 1000, 3),
    tenantFanInShare: num(config.tenantFanInShare, FLOORS.tenantFanInShare, 1, 0.2),
    maxFindings: int(config.maxFindings, 1, MAX_FINDINGS, MAX_FINDINGS),
  };
}

/** Inclusive comparison tolerant to 1e-9 relative floating point noise. */
export function atLeast(value: number, threshold: number): boolean {
  return value >= threshold - 1e-9 * Math.max(1, Math.abs(threshold));
}

export interface SeverityInput {
  readonly direction: 'up' | 'down';
  /** Mean daily excess over the candidate's window (positive for an increase). */
  readonly meanExcess: number;
  /** Sum of expected values over the same window. */
  readonly expectedSum: number;
  /** Sum of excess over the window (cumulative impact). */
  readonly cumulativeImpact: number;
  readonly windowDays: number;
}

/** Relative deviation, or null when it is unbounded (expected <= 0, excess > 0). */
export function relativeDeviation(meanExcess: number, expectedSum: number, windowDays: number): number | null {
  const excessSum = meanExcess * windowDays;
  if (expectedSum <= 0) return excessSum > 0 ? null : 0;
  return excessSum / expectedSum;
}

export function classifySeverity(input: SeverityInput, config: ResolvedConfig, minImpact: number): Severity {
  if (input.direction === 'down') return 'info'; // design D-14: drops are info by default
  const rel = relativeDeviation(input.meanExcess, input.expectedSum, input.windowDays);
  const relAtLeast = (threshold: number): boolean => rel === null || atLeast(rel, threshold);
  if (
    (atLeast(input.meanExcess, config.criticalMultiple * minImpact) && relAtLeast(config.criticalRelative)) ||
    atLeast(input.cumulativeImpact, config.cumulativeCriticalMultiple * minImpact)
  ) {
    return 'critical';
  }
  if (atLeast(input.meanExcess, minImpact) && relAtLeast(config.warningRelative)) return 'warning';
  return 'info';
}

const RANK: Readonly<Record<Severity, number>> = Object.freeze({ info: 0, warning: 1, critical: 2 });

export function severityRank(s: Severity): number {
  return RANK[s];
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}
