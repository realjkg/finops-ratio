// Budget threshold and forecast-breach evaluation (checklist 2.4).
//
// Rules implemented (from .obvious/obvious.md, "Alert & Threshold Rules"):
//  - Soft 70 percent, hard 90 percent, kill 100 percent of a budget, applied to
//    BOTH daily and monthly budgets. A threshold is reached when spend is at or
//    above it (inclusive): spend of exactly 70 percent is already soft.
//  - Forecast breach: projected month-end above the monthly budget, with the
//    overshoot amount and the number of days until the breach.
//
// Trust boundary: spend, budget and forecast arguments are untrusted. Every
// field is validated; a defect throws a fixed-text DetectionError. Spend and
// budget must share a currency and a period, or the call is refused: money is
// never compared across currencies. Pure: no clock, no I/O. Amounts are
// rounded to 6 decimals; ratios to 4.
//
// Severity mapping (an assumption the owner should confirm, README): soft is
// `info`, hard is `warning`, kill is `critical`, matching the alert severity
// vocabulary {info, warning, critical}.

import { addDays, formatDay, parseDay } from './dates';
import { DetectionError, LIMITS, isCurrency, round4, round6, type Severity } from './types';
import type { MonthEndProjection } from './forecast';

export type BudgetPeriod = 'daily' | 'monthly';
export type BudgetLevel = 'none' | 'soft' | 'hard' | 'kill';
export type BudgetAlertType = 'budget_soft' | 'budget_hard' | 'budget_kill';

export interface BudgetThresholds {
  readonly soft: number;
  readonly hard: number;
  readonly kill: number;
}

export const DEFAULT_THRESHOLDS: BudgetThresholds = Object.freeze({ soft: 0.7, hard: 0.9, kill: 1.0 });

export interface Budget {
  readonly currency: string;
  readonly period: BudgetPeriod;
  /** Budget for one period; must be greater than zero. */
  readonly amount: number;
  /** Override fractions; must satisfy 0 < soft < hard < kill <= 2. */
  readonly thresholds?: BudgetThresholds;
}

export interface Spend {
  readonly currency: string;
  readonly period: BudgetPeriod;
  /** Spend so far in the period. May be zero or negative (net credits). */
  readonly amount: number;
}

export interface ThresholdCrossing {
  readonly level: 'soft' | 'hard' | 'kill';
  readonly fraction: number;
  readonly amount: number;
}

export interface BudgetEvaluation {
  readonly currency: string;
  readonly period: BudgetPeriod;
  readonly spend: number;
  readonly budget: number;
  /** spend / budget, 4 decimals. */
  readonly ratio: number;
  readonly level: BudgetLevel;
  readonly alertType: BudgetAlertType | null;
  readonly severity: Severity | null;
  /** Every threshold at or below the current spend, lowest first. */
  readonly crossed: readonly ThresholdCrossing[];
  /** Budget remaining; negative when over budget. */
  readonly remaining: number;
  /** Spend above the budget, or 0. */
  readonly overBudgetBy: number;
  /** The next threshold above the current spend, or null at or past kill. */
  readonly next: (ThresholdCrossing & { readonly remaining: number }) | null;
  /** Actions the product rules attach to the level (obvious.md). */
  readonly actions: readonly string[];
}

const LEVEL_META: Readonly<
  Record<'soft' | 'hard' | 'kill', { alertType: BudgetAlertType; severity: Severity; actions: readonly string[] }>
> = Object.freeze({
  soft: { alertType: 'budget_soft', severity: 'info', actions: ['notify_owner_slack', 'notify_owner_email'] },
  hard: { alertType: 'budget_hard', severity: 'warning', actions: ['escalate_to_po', 'flag_workload_in_ui'] },
  kill: { alertType: 'budget_kill', severity: 'critical', actions: ['auto_throttle_or_pause'] },
});

function validateMoney(value: unknown, code: 'SPEND_INVALID' | 'BUDGET_INVALID'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > LIMITS.maxAbsAmount) {
    throw new DetectionError(code);
  }
  return value;
}

function validatePeriod(value: unknown, code: 'SPEND_INVALID' | 'BUDGET_INVALID'): BudgetPeriod {
  if (value !== 'daily' && value !== 'monthly') throw new DetectionError(code);
  return value;
}

function validateThresholds(value: BudgetThresholds | undefined): BudgetThresholds {
  if (value === undefined) return DEFAULT_THRESHOLDS;
  if (value === null || typeof value !== 'object') throw new DetectionError('BUDGET_INVALID');
  const { soft, hard, kill } = value;
  for (const f of [soft, hard, kill]) {
    if (typeof f !== 'number' || !Number.isFinite(f)) throw new DetectionError('BUDGET_INVALID');
  }
  if (!(soft > 0 && soft < hard && hard < kill && kill <= 2)) throw new DetectionError('BUDGET_INVALID');
  return { soft, hard, kill };
}

/**
 * Evaluates one spend figure against one budget of the same period and
 * currency. Call it once for the daily budget and once for the monthly budget.
 */
export function evaluateBudgetThresholds(spend: Spend, budget: Budget): BudgetEvaluation {
  if (budget === null || typeof budget !== 'object') throw new DetectionError('BUDGET_INVALID');
  if (spend === null || typeof spend !== 'object') throw new DetectionError('SPEND_INVALID');
  if (!isCurrency(budget.currency)) throw new DetectionError('BUDGET_INVALID');
  if (!isCurrency(spend.currency)) throw new DetectionError('SPEND_INVALID');
  const budgetPeriod = validatePeriod(budget.period, 'BUDGET_INVALID');
  const spendPeriod = validatePeriod(spend.period, 'SPEND_INVALID');
  const budgetAmount = validateMoney(budget.amount, 'BUDGET_INVALID');
  if (!(budgetAmount > 0)) throw new DetectionError('BUDGET_INVALID');
  const spendAmount = validateMoney(spend.amount, 'SPEND_INVALID');
  const thresholds = validateThresholds(budget.thresholds);
  if (spend.currency !== budget.currency) throw new DetectionError('CURRENCY_MISMATCH');
  if (spendPeriod !== budgetPeriod) throw new DetectionError('SPEND_INVALID');

  const spendRounded = round6(spendAmount);
  const crossings: ThresholdCrossing[] = (['soft', 'hard', 'kill'] as const).map((level) => ({
    level,
    fraction: thresholds[level],
    // Rounded first so 70 percent of 10 is exactly 7, not 7.000000000000001.
    amount: round6(budgetAmount * thresholds[level]),
  }));
  const crossed = crossings.filter((c) => spendRounded >= c.amount);
  const top = crossed.length > 0 ? (crossed[crossed.length - 1] as ThresholdCrossing) : null;
  const upcoming = crossings.find((c) => spendRounded < c.amount);
  const meta = top === null ? null : LEVEL_META[top.level];

  return {
    currency: budget.currency,
    period: budgetPeriod,
    spend: spendRounded,
    budget: round6(budgetAmount),
    ratio: round4(spendRounded / budgetAmount),
    level: top === null ? 'none' : top.level,
    alertType: meta === null ? null : meta.alertType,
    severity: meta === null ? null : meta.severity,
    crossed,
    remaining: round6(budgetAmount - spendRounded),
    overBudgetBy: round6(Math.max(0, spendRounded - budgetAmount)),
    next: upcoming === undefined ? null : { ...upcoming, remaining: round6(upcoming.amount - spendRounded) },
    actions: meta === null ? [] : meta.actions,
  };
}

// ---------------------------------------------------------------------------
// Forecast breach
// ---------------------------------------------------------------------------

export type ForecastBreachStatus = 'no_forecast' | 'on_track' | 'at_risk' | 'breach_projected' | 'breached';

/** The part of a SeriesForecast or FleetGroupForecast this function reads. */
export interface BreachForecastInput {
  readonly currency: string;
  readonly estimated: boolean;
  readonly monthEnd: MonthEndProjection | null;
}

export interface MonthlyBudget {
  readonly currency: string;
  readonly amount: number;
}

export interface ForecastBreachEvaluation {
  readonly status: ForecastBreachStatus;
  readonly currency: string;
  readonly month: string | null;
  readonly asOf: string | null;
  readonly budget: number;
  readonly projected: number | null;
  readonly actualToDate: number | null;
  /** max(0, projected - budget). */
  readonly overshoot: number;
  /** Overshoot if the 80 percent lower / upper bound were the outcome. */
  readonly overshootLow80: number;
  readonly overshootHigh80: number;
  /** projected / budget, 4 decimals. */
  readonly projectedRatio: number | null;
  /**
   * Whole days after the as-of day on which cumulative spend first exceeds the
   * budget: 0 when it already has; null when no breach is projected.
   */
  readonly daysUntilBreach: number | null;
  readonly breachDay: string | null;
  readonly alertType: 'forecast_breach' | null;
  readonly severity: Severity | null;
  /** True when the forecast itself is flagged estimated (short or weak history). */
  readonly estimated: boolean;
  readonly projectedLowerBoundBreaches: boolean;
}

function validateMonthEnd(m: MonthEndProjection): void {
  const nums = [m.actualToDate, m.imputedAmount, m.projected, m.lo80, m.hi80, m.forecastRemaining];
  for (const n of nums) if (typeof n !== 'number' || !Number.isFinite(n)) throw new DetectionError('SPEND_INVALID');
  if (!Number.isInteger(m.remainingDays) || m.remainingDays < 0 || m.remainingDays > 31) {
    throw new DetectionError('SPEND_INVALID');
  }
  if (!Array.isArray(m.remainingDaily) || m.remainingDaily.length !== m.remainingDays) {
    throw new DetectionError('SPEND_INVALID');
  }
  for (const d of m.remainingDaily) if (typeof d !== 'number' || !Number.isFinite(d)) throw new DetectionError('SPEND_INVALID');
  if (!/^\d{4}-\d{2}$/.test(m.month)) throw new DetectionError('SPEND_INVALID');
}

/**
 * Compares a month-end projection with a monthly budget. A breach needs
 * cumulative spend strictly above the budget (spend exactly equal to the
 * budget is at the kill threshold, not a forecast breach).
 */
export function evaluateForecastBreach(forecast: BreachForecastInput, budget: MonthlyBudget): ForecastBreachEvaluation {
  if (budget === null || typeof budget !== 'object') throw new DetectionError('BUDGET_INVALID');
  if (forecast === null || typeof forecast !== 'object') throw new DetectionError('SPEND_INVALID');
  if (!isCurrency(budget.currency)) throw new DetectionError('BUDGET_INVALID');
  const amount = validateMoney(budget.amount, 'BUDGET_INVALID');
  if (!(amount > 0)) throw new DetectionError('BUDGET_INVALID');
  if (!isCurrency(forecast.currency)) throw new DetectionError('SPEND_INVALID');
  if (typeof forecast.estimated !== 'boolean') throw new DetectionError('SPEND_INVALID');
  if (forecast.currency !== budget.currency) throw new DetectionError('CURRENCY_MISMATCH');

  const empty = {
    currency: budget.currency,
    budget: round6(amount),
    overshoot: 0,
    overshootLow80: 0,
    overshootHigh80: 0,
    projectedRatio: null,
    daysUntilBreach: null,
    breachDay: null,
    alertType: null,
    severity: null,
    estimated: forecast.estimated,
    projectedLowerBoundBreaches: false,
  } as const;
  if (forecast.monthEnd === null) {
    return { ...empty, status: 'no_forecast', month: null, asOf: null, projected: null, actualToDate: null };
  }
  const m = forecast.monthEnd;
  validateMonthEnd(m);
  const asOfDn = parseDay(m.asOf, 'SPEND_INVALID');

  const carried = m.actualToDate + m.imputedAmount;
  const projected = m.projected;
  const overshoot = round6(Math.max(0, projected - amount));

  let daysUntilBreach: number | null = null;
  let breachDay: string | null = null;
  if (carried > amount) {
    daysUntilBreach = 0;
    breachDay = formatDay(asOfDn);
  } else {
    let cumulative = carried;
    for (let k = 0; k < m.remainingDaily.length; k += 1) {
      cumulative += m.remainingDaily[k] as number;
      if (cumulative > amount) {
        daysUntilBreach = k + 1;
        breachDay = addDays(m.asOf, k + 1);
        break;
      }
    }
  }
  const lowerBreaches = round6(m.lo80) > amount;
  let status: ForecastBreachStatus;
  if (carried > amount) status = 'breached';
  else if (projected > amount) status = 'breach_projected';
  else if (projected >= amount * 0.9) status = 'at_risk';
  else status = 'on_track';

  let severity: Severity | null = null;
  if (status === 'breached' || (status === 'breach_projected' && lowerBreaches)) severity = 'critical';
  else if (status === 'breach_projected') severity = 'warning';
  else if (status === 'at_risk') severity = 'info';

  return {
    status,
    currency: budget.currency,
    month: m.month,
    asOf: formatDay(asOfDn),
    budget: round6(amount),
    projected: round6(projected),
    actualToDate: round6(m.actualToDate),
    overshoot,
    overshootLow80: round6(Math.max(0, m.lo80 - amount)),
    overshootHigh80: round6(Math.max(0, m.hi80 - amount)),
    projectedRatio: round4(projected / amount),
    daysUntilBreach,
    breachDay,
    alertType: status === 'breached' || status === 'breach_projected' ? 'forecast_breach' : null,
    severity,
    estimated: forecast.estimated,
    projectedLowerBoundBreaches: lowerBreaches,
  };
}
