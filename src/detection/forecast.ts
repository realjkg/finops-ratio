// Daily-series forecasting, month-end projection, fleet roll-up and backtest
// (checklist 2.1). Pure and deterministic: the caller passes the series and an
// explicit as-of UTC day; nothing here reads a clock or a random source.
//
// Trust boundary: the series are validated (viewSeries) before use; as-of and
// horizon are validated; errors are fixed text. Data after the as-of day is
// ignored, so a forecast can never use information from its own future.
//
// Rules (documented subset of design sections 3.2 to 3.7; deviations are in the
// README):
//  - Observed days: a day with a row is observed. gapPolicy 'missing' (default)
//    treats an absent day as unknown (it is skipped, counted in `gapDays`, and
//    imputed only for the month-to-date total). gapPolicy 'zero' treats an
//    absent day between the first observation and the as-of day as zero spend.
//  - Minimum history: 0 observed days gives status 'no_history' and no
//    numbers. 1 to 13 days gives the mean of the available days with a wide
//    interval (mean +/- 1.5 z sd, sd floored at 25 percent of the mean).
//    14 days or more is fitted. Fewer than 56 observed days is `estimated`.
//  - Month-end = actual month-to-date (through the as-of day) + the sum of the
//    daily forecasts for the remaining days of that UTC month. Its interval
//    is the sum of the daily bounds: a conservative (over-wide) interval, not
//    a calibrated one.
//  - Money is rounded to 6 decimals (round6). Currencies are never mixed: a
//    series has one currency, and the fleet roll-up groups by tenant+currency.

import { addDays, formatDay, monthEndOf, monthKeyOf, monthStartOf, parseDay } from './dates';
import { viewSeries } from './series';
import { mean, sum } from './stats';
import {
  MODEL,
  boundsFor,
  calibrate,
  fitModel,
  levelAt,
  predictAt,
  type Calibration,
  type Fit,
  type Obs,
} from './model';
import { DetectionError, LIMITS, compareStrings, round4, round6, type DailySeries } from './types';
import { weekdayOf } from './dates';

export type GapPolicy = 'missing' | 'zero';

export interface ForecastOptions {
  readonly gapPolicy?: GapPolicy;
}

export type ForecastReason =
  | 'short_history'
  | 'very_short_history'
  | 'sparse_history'
  | 'stale_history'
  | 'negative_days'
  | 'parametric_interval'
  | 'gaps_imputed';

export interface ForecastPoint {
  readonly day: string;
  readonly point: number;
  readonly lo80: number;
  readonly hi80: number;
  readonly lo95: number;
  readonly hi95: number;
  /** True beyond 14 days, where the interval is widened by the sqrt rule. */
  readonly extrapolated: boolean;
}

export interface MonthEndProjection {
  readonly month: string;
  readonly asOf: string;
  readonly daysInMonth: number;
  readonly remainingDays: number;
  /** Observed spend from the first of the month through the as-of day. */
  readonly actualToDate: number;
  readonly imputedDays: number;
  readonly imputedAmount: number;
  readonly forecastRemaining: number;
  /** actualToDate + imputedAmount + forecastRemaining. */
  readonly projected: number;
  readonly lo80: number;
  readonly hi80: number;
  readonly lo95: number;
  readonly hi95: number;
  readonly intervalMethod: 'sum_of_daily_bounds';
  /** Point forecast for each remaining day of the month, in date order. */
  readonly remainingDaily: readonly number[];
}

export interface SeriesForecast {
  readonly status: 'ok' | 'no_history';
  readonly seriesId: string;
  readonly tenant: string;
  readonly currency: string;
  readonly asOf: string;
  readonly method: 'level_trend_weekday' | 'mean_of_available' | 'none';
  /** True when history is short, sparse, stale or otherwise weak. */
  readonly estimated: boolean;
  readonly reasons: readonly ForecastReason[];
  readonly historyDays: number;
  readonly gapDays: number;
  readonly lastObservedDay: string | null;
  readonly intervalMethod: 'empirical' | 'parametric' | 'none';
  readonly points: readonly ForecastPoint[];
  readonly monthEnd: MonthEndProjection | null;
}

function validatePolicy(options: ForecastOptions | undefined): GapPolicy {
  if (options === undefined) return 'missing';
  if (options === null || typeof options !== 'object') throw new DetectionError('OPTIONS_INVALID');
  const policy = options.gapPolicy ?? 'missing';
  if (policy !== 'missing' && policy !== 'zero') throw new DetectionError('OPTIONS_INVALID');
  return policy;
}

export function validateHorizon(horizon: unknown): number {
  if (typeof horizon !== 'number' || !Number.isInteger(horizon) || horizon < 1 || horizon > LIMITS.maxHorizonDays) {
    throw new DetectionError('HORIZON_INVALID');
  }
  return horizon;
}

/** Observations through `asOfDn`, with the gap policy applied. */
export function observationsThrough(
  dns: readonly number[],
  values: readonly number[],
  asOfDn: number,
  policy: GapPolicy,
): Obs[] {
  const obs: Obs[] = [];
  for (let i = 0; i < dns.length; i += 1) {
    const dn = dns[i] as number;
    if (dn > asOfDn) break;
    obs.push({ dn, v: values[i] as number });
  }
  if (policy === 'zero' && obs.length > 0) {
    const have = new Map<number, number>();
    for (const o of obs) have.set(o.dn, o.v);
    const dense: Obs[] = [];
    for (let dn = (obs[0] as Obs).dn; dn <= asOfDn; dn += 1) dense.push({ dn, v: have.get(dn) ?? 0 });
    return dense;
  }
  return obs;
}

interface Projection {
  readonly points: ForecastPoint[];
  readonly intervalMethod: 'empirical' | 'parametric';
}

function projectFromFit(fit: Fit, calibration: Calibration, asOfDn: number, days: number): Projection {
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= days; h += 1) {
    const dn = asOfDn + h;
    const point = predictAt(fit, dn);
    const b = boundsFor(fit, calibration, point, dn);
    points.push({
      day: formatDay(dn),
      point: round6(point),
      lo80: round6(b.lo80),
      hi80: round6(b.hi80),
      lo95: round6(b.lo95),
      hi95: round6(b.hi95),
      extrapolated: b.extrapolated,
    });
  }
  return { points, intervalMethod: calibration.method };
}

function projectFromMean(obs: readonly Obs[], asOfDn: number, days: number): Projection {
  const values = obs.map((o) => o.v);
  const m = mean(values);
  const sd =
    values.length >= 2
      ? Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1))
      : 0;
  const w = Math.max(sd, 0.25 * Math.abs(m), MODEL.scaleFloor / 2) * MODEL.fallbackInflation;
  const point = Math.max(0, m);
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= days; h += 1) {
    points.push({
      day: formatDay(asOfDn + h),
      point: round6(point),
      lo80: round6(Math.max(0, point - MODEL.z80 * w)),
      hi80: round6(point + MODEL.z80 * w),
      lo95: round6(Math.max(0, point - MODEL.z95 * w)),
      hi95: round6(point + MODEL.z95 * w),
      extrapolated: h > MODEL.calibrationMaxHorizon,
    });
  }
  return { points, intervalMethod: 'parametric' };
}

/**
 * Forecasts one daily series for `horizon` days after the as-of day and
 * projects the as-of day's UTC month to its end.
 */
export function forecastSeries(
  series: DailySeries,
  asOf: string,
  horizon: number,
  options?: ForecastOptions,
): SeriesForecast {
  const asOfDn = parseDay(asOf);
  const days = validateHorizon(horizon);
  const policy = validatePolicy(options);
  const view = viewSeries(series);
  const obs = observationsThrough(view.dns, view.values, asOfDn, policy);

  const base = {
    seriesId: series.id,
    tenant: series.key.tenant,
    currency: series.key.currency,
    asOf: formatDay(asOfDn),
  };

  if (obs.length === 0) {
    return {
      ...base,
      status: 'no_history',
      method: 'none',
      estimated: true,
      reasons: ['very_short_history'],
      historyDays: 0,
      gapDays: 0,
      lastObservedDay: null,
      intervalMethod: 'none',
      points: [],
      monthEnd: null,
    };
  }

  const first = obs[0] as Obs;
  const last = obs[obs.length - 1] as Obs;
  const span = asOfDn - first.dn + 1;
  const gapDays = span - obs.length;
  const reasons: ForecastReason[] = [];
  if (obs.length < MODEL.minFitDays) reasons.push('very_short_history');
  else if (obs.length < MODEL.fullHistoryDays) reasons.push('short_history');
  if (policy === 'missing' && span >= MODEL.minFitDays && gapDays / span > 0.3) reasons.push('sparse_history');
  if (asOfDn - last.dn > 7) reasons.push('stale_history');

  const fit = fitModel(obs);
  const monthEndDn = monthEndOf(asOfDn);
  const remaining = monthEndDn - asOfDn;
  const projectDays = Math.max(days, remaining);

  let projection: Projection;
  let method: SeriesForecast['method'];
  let negativeInWindow: boolean;
  if (fit === null) {
    projection = projectFromMean(obs, asOfDn, projectDays);
    method = 'mean_of_available';
    negativeInWindow = obs.some((o) => o.v < 0);
  } else {
    const calibration = calibrate(obs);
    // Forecast days count from the as-of day; the fit's own horizon counts from
    // its last observation, which is the same day unless the tail is missing.
    projection = projectFromFit(fit, calibration, asOfDn, projectDays);
    method = 'level_trend_weekday';
    negativeInWindow = obs.slice(-MODEL.levelWindowDays).some((o) => o.v < 0);
  }
  if (negativeInWindow) reasons.push('negative_days');
  if (projection.intervalMethod === 'parametric' && fit !== null) reasons.push('parametric_interval');

  // Month-to-date actuals, with imputation for missing days (missing policy).
  const monthStartDn = monthStartOf(asOfDn);
  let imputedDays = 0;
  const observedInMonth = new Map<number, number>();
  for (const o of obs) if (o.dn >= monthStartDn) observedInMonth.set(o.dn, o.v);
  const monthParts: number[] = [];
  const imputedParts: number[] = [];
  for (let dn = monthStartDn; dn <= asOfDn; dn += 1) {
    const v = observedInMonth.get(dn);
    if (v !== undefined) {
      monthParts.push(v);
    } else if (policy === 'missing' && dn >= first.dn) {
      imputedDays += 1;
      imputedParts.push(fit !== null ? levelAt(fit, dn) : Math.max(0, mean(obs.map((o) => o.v))));
    }
  }
  const actualToDate = sum(monthParts);
  const imputedAmount = sum(imputedParts);
  if (imputedDays > 0) reasons.push('gaps_imputed');

  const remainingPoints = projection.points.slice(0, remaining);
  const totalOf = (pick: (p: ForecastPoint) => number): number => sum(remainingPoints.map(pick));
  const carried = actualToDate + imputedAmount;
  const monthEnd: MonthEndProjection = {
    month: monthKeyOf(asOfDn),
    asOf: formatDay(asOfDn),
    daysInMonth: monthEndDn - monthStartDn + 1,
    remainingDays: remaining,
    actualToDate: round6(actualToDate),
    imputedDays,
    imputedAmount: round6(imputedAmount),
    forecastRemaining: round6(totalOf((p) => p.point)),
    projected: round6(carried + totalOf((p) => p.point)),
    lo80: round6(carried + totalOf((p) => p.lo80)),
    hi80: round6(carried + totalOf((p) => p.hi80)),
    lo95: round6(carried + totalOf((p) => p.lo95)),
    hi95: round6(carried + totalOf((p) => p.hi95)),
    intervalMethod: 'sum_of_daily_bounds',
    remainingDaily: remainingPoints.map((p) => p.point),
  };

  const estimated =
    reasons.includes('very_short_history') ||
    reasons.includes('short_history') ||
    reasons.includes('sparse_history') ||
    reasons.includes('stale_history') ||
    reasons.includes('negative_days') ||
    reasons.includes('parametric_interval') ||
    reasons.includes('gaps_imputed');

  return {
    ...base,
    status: 'ok',
    method,
    estimated,
    reasons,
    historyDays: obs.length,
    gapDays,
    lastObservedDay: formatDay(last.dn),
    intervalMethod: projection.intervalMethod,
    points: projection.points.slice(0, days),
    monthEnd,
  };
}

// ---------------------------------------------------------------------------
// Fleet roll-up: bottom-up sums per (tenant, currency). Never across currencies.
// ---------------------------------------------------------------------------

export interface FleetGroupForecast {
  readonly tenant: string;
  readonly currency: string;
  readonly seriesCount: number;
  readonly forecastedSeries: number;
  readonly estimatedSeries: number;
  readonly noHistorySeries: number;
  readonly estimated: boolean;
  /** Sum of the series' daily forecasts; bounds are sums of bounds (conservative). */
  readonly points: readonly ForecastPoint[];
  readonly monthEnd: MonthEndProjection | null;
}

export interface FleetForecast {
  readonly asOf: string;
  readonly groups: readonly FleetGroupForecast[];
  readonly series: readonly SeriesForecast[];
}

export function forecastFleet(
  seriesList: readonly DailySeries[],
  asOf: string,
  horizon: number,
  options?: ForecastOptions,
): FleetForecast {
  if (!Array.isArray(seriesList)) throw new DetectionError('SERIES_INVALID');
  if (seriesList.length > LIMITS.maxSeries) throw new DetectionError('SERIES_CAP_EXCEEDED');
  const asOfDn = parseDay(asOf);
  validateHorizon(horizon);
  const results: SeriesForecast[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < seriesList.length; i += 1) {
    const s = seriesList[i] as DailySeries;
    const f = forecastSeries(s, asOf, horizon, options);
    if (seen.has(f.seriesId)) throw new DetectionError('SERIES_INVALID', i);
    seen.add(f.seriesId);
    results.push(f);
  }
  results.sort((a, b) => compareStrings(a.seriesId, b.seriesId));

  const grouped = new Map<string, SeriesForecast[]>();
  for (const r of results) {
    const key = `${r.tenant}|${r.currency}`;
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [r]);
    else list.push(r);
  }
  const groups: FleetGroupForecast[] = [];
  for (const key of Array.from(grouped.keys()).sort(compareStrings)) {
    const list = grouped.get(key) as SeriesForecast[];
    const ok = list.filter((r) => r.status === 'ok');
    const sample = list[0] as SeriesForecast;
    const points: ForecastPoint[] = [];
    for (let h = 0; h < horizon; h += 1) {
      const at = (pick: (p: ForecastPoint) => number): number =>
        round6(sum(ok.map((r) => pick(r.points[h] as ForecastPoint))));
      points.push({
        day: formatDay(asOfDn + h + 1),
        point: at((p) => p.point),
        lo80: at((p) => p.lo80),
        hi80: at((p) => p.hi80),
        lo95: at((p) => p.lo95),
        hi95: at((p) => p.hi95),
        extrapolated: ok.some((r) => (r.points[h] as ForecastPoint).extrapolated),
      });
    }
    let monthEnd: MonthEndProjection | null = null;
    if (ok.length > 0) {
      const months = ok.map((r) => r.monthEnd as MonthEndProjection);
      const m0 = months[0] as MonthEndProjection;
      const total = (pick: (m: MonthEndProjection) => number): number => round6(sum(months.map(pick)));
      monthEnd = {
        month: m0.month,
        asOf: m0.asOf,
        daysInMonth: m0.daysInMonth,
        remainingDays: m0.remainingDays,
        actualToDate: total((m) => m.actualToDate),
        imputedDays: months.reduce((acc, m) => acc + m.imputedDays, 0),
        imputedAmount: total((m) => m.imputedAmount),
        forecastRemaining: total((m) => m.forecastRemaining),
        projected: total((m) => m.projected),
        lo80: total((m) => m.lo80),
        hi80: total((m) => m.hi80),
        lo95: total((m) => m.lo95),
        hi95: total((m) => m.hi95),
        intervalMethod: 'sum_of_daily_bounds',
        remainingDaily: m0.remainingDaily.map((_, k) =>
          round6(sum(months.map((m) => m.remainingDaily[k] as number))),
        ),
      };
    }
    groups.push({
      tenant: sample.tenant,
      currency: sample.currency,
      seriesCount: list.length,
      forecastedSeries: ok.length,
      estimatedSeries: ok.filter((r) => r.estimated).length,
      noHistorySeries: list.length - ok.length,
      estimated: ok.length === 0 || ok.some((r) => r.estimated),
      points: ok.length > 0 ? points : [],
      monthEnd,
    });
  }
  return { asOf: formatDay(asOfDn), groups, series: results };
}

// ---------------------------------------------------------------------------
// Backtest: accuracy on a holdout, from rolling origins that never see the
// future of their own origin.
// ---------------------------------------------------------------------------

export interface BacktestOptions extends ForecastOptions {
  /** Days held out after each origin (1 to 30, default 14). */
  readonly holdoutDays?: number;
  /** Number of origins stepped back from the as-of day (1 to 8, default 1). */
  readonly origins?: number;
  /** Spacing between origins in days (1 to 30, default 7). */
  readonly stepDays?: number;
  /** MAPE ignores days whose absolute actual is below this (default 1). */
  readonly mapeFloor?: number;
}

export interface BacktestOrigin {
  readonly originDay: string;
  readonly evaluatedDays: number;
  readonly wape: number | null;
}

export interface BacktestAggregate {
  /** Holdout days scored across all origins. */
  readonly n: number;
  /** Mean of |a - p| / |a| over days with |a| >= mapeFloor; null if none. */
  readonly mape: number | null;
  readonly mapeDays: number;
  /** Sum |a - p| / sum |a|; null when the actuals sum to zero. */
  readonly wape: number | null;
  /** (sum p - sum a) / sum |a|: positive means over-forecast. */
  readonly bias: number | null;
  readonly coverage80: number | null;
  readonly coverage95: number | null;
}

export interface BacktestResult {
  readonly seriesId: string;
  readonly asOf: string;
  readonly holdoutDays: number;
  readonly origins: readonly BacktestOrigin[];
  readonly aggregate: BacktestAggregate;
}

function intIn(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new DetectionError('BACKTEST_INVALID');
  return value;
}

export function backtestSeries(series: DailySeries, asOf: string, options?: BacktestOptions): BacktestResult {
  const asOfDn = parseDay(asOf);
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new DetectionError('BACKTEST_INVALID');
  }
  const holdout = intIn(options?.holdoutDays, 14, 1, 30);
  const originCount = intIn(options?.origins, 1, 1, 8);
  const step = intIn(options?.stepDays, 7, 1, 30);
  const floor = options?.mapeFloor ?? 1;
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor <= 0) throw new DetectionError('BACKTEST_INVALID');
  const policy = validatePolicy(options);
  const view = viewSeries(series);
  const actualByDn = new Map<number, number>();
  for (let i = 0; i < view.dns.length; i += 1) {
    if ((view.dns[i] as number) <= asOfDn) actualByDn.set(view.dns[i] as number, view.values[i] as number);
  }

  const origins: BacktestOrigin[] = [];
  const absErrors: number[] = [];
  const absActuals: number[] = [];
  const signedErrors: number[] = [];
  const pctErrors: number[] = [];
  let cover80 = 0;
  let cover95 = 0;
  let scored = 0;

  for (let o = 0; o < originCount; o += 1) {
    const originDn = asOfDn - holdout - o * step;
    const originDay = formatDay(originDn);
    const f = forecastSeries(series, originDay, holdout, { gapPolicy: policy });
    let evaluated = 0;
    const originAbs: number[] = [];
    const originAct: number[] = [];
    if (f.status === 'ok') {
      for (const p of f.points) {
        const dn = parseDay(p.day);
        if (dn > asOfDn) continue;
        const actual = actualByDn.get(dn) ?? (policy === 'zero' ? 0 : undefined);
        if (actual === undefined) continue;
        evaluated += 1;
        const err = Math.abs(actual - p.point);
        originAbs.push(err);
        originAct.push(Math.abs(actual));
        absErrors.push(err);
        absActuals.push(Math.abs(actual));
        signedErrors.push(p.point - actual);
        if (Math.abs(actual) >= floor) pctErrors.push(err / Math.abs(actual));
        if (actual >= p.lo80 && actual <= p.hi80) cover80 += 1;
        if (actual >= p.lo95 && actual <= p.hi95) cover95 += 1;
        scored += 1;
      }
    }
    const denom = sum(originAct);
    origins.push({
      originDay,
      evaluatedDays: evaluated,
      wape: evaluated > 0 && denom > 0 ? round4(sum(originAbs) / denom) : null,
    });
  }

  const denominator = sum(absActuals);
  return {
    seriesId: series.id,
    asOf: formatDay(asOfDn),
    holdoutDays: holdout,
    origins,
    aggregate: {
      n: scored,
      mape: pctErrors.length > 0 ? round4(mean(pctErrors)) : null,
      mapeDays: pctErrors.length,
      wape: scored > 0 && denominator > 0 ? round4(sum(absErrors) / denominator) : null,
      bias: scored > 0 && denominator > 0 ? round4(sum(signedErrors) / denominator) : null,
      coverage80: scored > 0 ? round4(cover80 / scored) : null,
      coverage95: scored > 0 ? round4(cover95 / scored) : null,
    },
  };
}

/** Convenience: the weekday (0 = Sunday) of a day string, UTC. */
export function weekdayOfDay(day: string): number {
  return weekdayOf(parseDay(day));
}

/** Convenience: the UTC day string `n` days after `day`. */
export function dayPlus(day: string, n: number): string {
  return addDays(day, n);
}
