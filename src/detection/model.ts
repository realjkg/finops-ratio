// Fixed, documented forecasting model used by forecast.ts and anomaly.ts.
// Pure and deterministic: no randomness, no optimizer, no clock.
//
// Method "level_trend_weekday" (a simplified member of the design's
// seasonal-naive / Holt-Winters ladder, chosen because every step is closed
// form and explainable):
//   1. Weekday factors. Over the last 56 days, the ratio of each day to the
//      centered 7-day moving average (days whose 7-day neighborhood is
//      complete), the median ratio per weekday, shrunk toward 1 when a weekday
//      has fewer than 4 ratios, renormalized to mean 1. Needs at least 14
//      ratios and 5 weekdays with 2+ ratios; otherwise all factors are 1. The
//      moving-average base keeps a trend or step from posing as seasonality.
//   2. Deseasonalize: z_i = y_i / f_weekday(i).
//   3. Trend. Over the last 28 days, the median of weekly differences
//      (z_i - z_{i-7}) / 7. A seven-day lag cancels any weekday effect and the
//      median ignores a spike. Needs 5+ pairs, and is applied only when it
//      exceeds 2.5 robust standard errors; otherwise slope 0.
//   4. Level. Over the same window, the median of z_i - slope * (i - last):
//      the intercept at the last observed day.
//   5. Forecast for day d at horizon h = d - last:
//      max(0, level + slope * phi(1 - phi^h)/(1 - phi)) * f_weekday(d),
//      with damping phi = 0.95 so the trend flattens (at most about 19 days of
//      slope are ever added).
//   6. Noise. sigma = 1.4826 * MAD of the window's deseasonalized residuals.
//
// Intervals are EMPIRICAL (see calibrate): the model is re-fit at up to 28
// earlier origins and its h-step errors (h = 1 to 14), divided by the series
// scale L (mean |y| over the fit window, floored), are bucketed by horizon
// (1-3, 4-7, 8-14). With too few errors the interval falls back to a labeled
// parametric rule. Beyond 14 days the h = 8-14 quantiles are widened by
// sqrt(h / 11) (the design's empty-bucket rule) and the point is flagged
// `extrapolated`.

import { weekdayOf } from './dates';
import { mean, median, quantile, scaledMad } from './stats';

export const MODEL = Object.freeze({
  /** Fewer observed days than this: mean-of-available, always estimated. */
  minFitDays: 14,
  /** At least this many observed days for a non-estimated forecast. */
  fullHistoryDays: 56,
  levelWindowDays: 28,
  factorWindowDays: 56,
  damping: 0.95,
  /** Trend is applied only above this many robust standard errors. */
  trendSignificance: 2.5,
  /** In-sample residuals are optimistic; widen the noise estimate by this. */
  sigmaInflation: 1.2,
  calibrationOrigins: 28,
  calibrationMaxHorizon: 14,
  minCalibrationErrors: 20,
  minBucketErrors: 12,
  /** Scale floor in currency units (a cent), so L is never zero. */
  scaleFloor: 0.01,
  z80: 1.2816,
  z95: 1.96,
  /** Inflation of the parametric fallback and of the short-history rule. */
  fallbackInflation: 1.5,
});

export interface Obs {
  readonly dn: number;
  readonly v: number;
}

export interface Fit {
  readonly firstDn: number;
  readonly lastDn: number;
  readonly count: number;
  /** Deseasonalized level at lastDn. */
  readonly level: number;
  /** Deseasonalized change per day. */
  readonly slope: number;
  /** Weekday factors indexed 0 = Sunday, mean 1. */
  readonly factors: readonly number[];
  /** Ratios behind each weekday factor (zeros when the factors are flat). */
  readonly factorCounts: readonly number[];
  readonly weekdayAdjusted: boolean;
  /** Observations in the level window. */
  readonly levelCount: number;
  /** Robust residual sd in deseasonalized units (not inflated). */
  readonly sigma: number;
  /** Mean |y| over the level window. */
  readonly scale: number;
}

const FLAT_FACTORS: readonly number[] = Object.freeze([1, 1, 1, 1, 1, 1, 1]);

const NO_COUNTS: readonly number[] = Object.freeze([0, 0, 0, 0, 0, 0, 0]);

function computeFactors(window: readonly Obs[]): {
  factors: readonly number[];
  counts: readonly number[];
  adjusted: boolean;
} {
  const flat = { factors: FLAT_FACTORS, counts: NO_COUNTS, adjusted: false };
  if (window.length < MODEL.minFitDays) return flat;
  // Ratio to a centered 7-day moving average, so a trend or a step is not
  // mistaken for a weekday effect (a plain per-weekday median would be).
  const byDn = new Map<number, number>();
  for (const o of window) byDn.set(o.dn, o.v);
  const ratios: number[][] = [[], [], [], [], [], [], []];
  let total = 0;
  for (const o of window) {
    let acc = 0;
    let complete = true;
    for (let k = -3; k <= 3; k += 1) {
      const v = byDn.get(o.dn + k);
      if (v === undefined) {
        complete = false;
        break;
      }
      acc += v;
    }
    if (!complete) continue;
    const ma = acc / 7;
    if (!(ma > 0)) continue;
    (ratios[weekdayOf(o.dn)] as number[]).push(o.v / ma);
    total += 1;
  }
  if (total < MODEL.minFitDays) return flat;
  const usable = ratios.filter((r) => r.length >= 2).length;
  if (usable < 5) return flat;
  const raw = ratios.map((r) => {
    if (r.length < 2) return 1;
    // Full weight from 4 ratios up; linear shrink toward 1 below that.
    const weight = Math.min(1, (r.length - 1) / 3);
    return 1 + (median(r) - 1) * weight;
  });
  const avg = mean(raw);
  return { factors: raw.map((f) => Math.max(0.05, f / avg)), counts: ratios.map((r) => r.length), adjusted: true };
}

/** Fits the model to observations (ascending, unique days). Null below the minimum. */
export function fitModel(obs: readonly Obs[]): Fit | null {
  const n = obs.length;
  if (n < MODEL.minFitDays) return null;
  const first = obs[0] as Obs;
  const last = obs[n - 1] as Obs;
  const levelFrom = last.dn - MODEL.levelWindowDays;
  const factorFrom = last.dn - MODEL.factorWindowDays;
  const levelWindow: Obs[] = [];
  const factorWindow: Obs[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const o = obs[i] as Obs;
    if (o.dn > factorFrom) factorWindow.push(o);
    else break;
    if (o.dn > levelFrom) levelWindow.push(o);
  }
  factorWindow.reverse();
  levelWindow.reverse();

  const { factors, counts, adjusted } = computeFactors(factorWindow);
  const z = new Map<number, number>();
  for (const o of levelWindow) z.set(o.dn, o.v / (factors[weekdayOf(o.dn)] as number));

  const diffs: number[] = [];
  for (const o of levelWindow) {
    const prior = z.get(o.dn - 7);
    if (prior !== undefined) diffs.push(((z.get(o.dn) as number) - prior) / 7);
  }
  // The trend is applied only when it is distinguishable from noise: the median
  // weekly difference must exceed 2.5 robust standard errors (successive
  // differences are not independent, so n is halved). A pure ramp has zero
  // spread and passes; trendless noise almost never does.
  let slope = 0;
  if (diffs.length >= 5) {
    const candidate = median(diffs);
    const se = (1.2533 * scaledMad(diffs)) / Math.sqrt(Math.max(1, diffs.length / 2));
    if (Math.abs(candidate) > MODEL.trendSignificance * se) slope = candidate;
  }
  const level = median(levelWindow.map((o) => (z.get(o.dn) as number) - slope * (o.dn - last.dn)));
  const residuals = levelWindow.map((o) => (z.get(o.dn) as number) - (level + slope * (o.dn - last.dn)));
  const sigma = scaledMad(residuals);
  const scale = mean(levelWindow.map((o) => Math.abs(o.v)));
  return {
    firstDn: first.dn,
    lastDn: last.dn,
    count: n,
    level,
    slope,
    factors,
    factorCounts: counts,
    weekdayAdjusted: adjusted,
    levelCount: levelWindow.length,
    sigma,
    scale,
  };
}

function dampedSum(h: number): number {
  if (h <= 0) return 0;
  const phi = MODEL.damping;
  return (phi * (1 - phi ** h)) / (1 - phi);
}

/** Point forecast for day `dn` (at least the fit's last day). Never negative. */
export function predictAt(fit: Fit, dn: number): number {
  const h = dn - fit.lastDn;
  const base = fit.level + fit.slope * dampedSum(h);
  return Math.max(0, base) * (fit.factors[weekdayOf(dn)] as number);
}

/** Deseasonalized level without trend, used to impute a missing past day. */
export function levelAt(fit: Fit, dn: number): number {
  return Math.max(0, fit.level) * (fit.factors[weekdayOf(dn)] as number);
}

export function scaleOf(fit: Fit): number {
  return Math.max(fit.scale, MODEL.scaleFloor);
}

export interface Quantiles {
  readonly lo80: number;
  readonly hi80: number;
  readonly lo95: number;
  readonly hi95: number;
}

export interface Calibration {
  readonly method: 'empirical' | 'parametric';
  /** Robust sd of the 1 to 3 day errors in scale units ((q90 - q10) / 2.563); 0 when parametric. */
  readonly sigma1: number;
  /** Errors divided by scale, per horizon bucket (1-3, 4-7, 8-14). */
  readonly buckets: readonly Quantiles[];
  readonly errorCount: number;
}

export function bucketOf(h: number): number {
  return h <= 3 ? 0 : h <= 7 ? 1 : 2;
}

function quantilesOf(errors: readonly number[]): Quantiles {
  const lo80 = Math.min(0, quantile(errors, 0.1));
  const hi80 = Math.max(0, quantile(errors, 0.9));
  const lo95 = Math.min(lo80, quantile(errors, 0.025));
  const hi95 = Math.max(hi80, quantile(errors, 0.975));
  return { lo80, hi80, lo95, hi95 };
}

/**
 * Rolling-origin empirical calibration using only `obs` (so only data up to
 * the as-of day). Cost: at most calibrationOrigins model fits.
 */
export function calibrate(obs: readonly Obs[]): Calibration {
  const n = obs.length;
  const perBucket: number[][] = [[], [], []];
  const lastOrigin = n - 2;
  const firstOrigin = Math.max(MODEL.minFitDays - 1, lastOrigin - MODEL.calibrationOrigins + 1);
  for (let k = firstOrigin; k <= lastOrigin; k += 1) {
    const sub = obs.slice(Math.max(0, k + 1 - 60), k + 1);
    const fit = fitModel(sub);
    if (fit === null) continue;
    const L = scaleOf(fit);
    const origin = obs[k] as Obs;
    for (let j = k + 1; j < n; j += 1) {
      const target = obs[j] as Obs;
      const h = target.dn - origin.dn;
      if (h > MODEL.calibrationMaxHorizon) break;
      (perBucket[bucketOf(h)] as number[]).push((target.v - predictAt(fit, target.dn)) / L);
    }
  }
  const all = perBucket.flat();
  if (all.length < MODEL.minCalibrationErrors) {
    return { method: 'parametric', sigma1: 0, buckets: [], errorCount: all.length };
  }
  const pooled = quantilesOf(all);
  const buckets = perBucket.map((errs) => (errs.length >= MODEL.minBucketErrors ? quantilesOf(errs) : pooled));
  const near = (perBucket[0] as number[]).length >= MODEL.minBucketErrors ? (perBucket[0] as number[]) : all;
  const sigma1 = (quantile(near, 0.9) - quantile(near, 0.1)) / 2.5631;
  return { method: 'empirical', sigma1, buckets, errorCount: all.length };
}

export interface Bounds {
  readonly lo80: number;
  readonly hi80: number;
  readonly lo95: number;
  readonly hi95: number;
  readonly extrapolated: boolean;
}

/** Interval around `point` for horizon `h` of a fitted series. */
export function boundsFor(fit: Fit, calibration: Calibration, point: number, dn: number): Bounds {
  const h = Math.max(1, dn - fit.lastDn);
  const floorAt = (x: number): number => (point >= 0 ? Math.max(0, x) : x);
  if (calibration.method === 'empirical') {
    const q = calibration.buckets[bucketOf(Math.min(h, MODEL.calibrationMaxHorizon))] as Quantiles;
    const extrapolated = h > MODEL.calibrationMaxHorizon;
    const mult = extrapolated ? Math.sqrt(h / 11) : 1;
    const L = scaleOf(fit);
    return {
      lo80: floorAt(point + L * q.lo80 * mult),
      hi80: point + L * q.hi80 * mult,
      lo95: floorAt(point + L * q.lo95 * mult),
      hi95: point + L * q.hi95 * mult,
      extrapolated,
    };
  }
  const f = fit.factors[weekdayOf(dn)] as number;
  const sd = fit.sigma * MODEL.sigmaInflation * f * MODEL.fallbackInflation * Math.sqrt(1 + h / 7);
  // Never narrower than a cent so a perfectly flat series still has an interval.
  const w = Math.max(sd, MODEL.scaleFloor / 2);
  return {
    lo80: floorAt(point - MODEL.z80 * w),
    hi80: point + MODEL.z80 * w,
    lo95: floorAt(point - MODEL.z95 * w),
    hi95: point + MODEL.z95 * w,
    extrapolated: h > MODEL.calibrationMaxHorizon,
  };
}
