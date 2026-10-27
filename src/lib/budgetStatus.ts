// Composed budget status — the single source of truth that turns a workload +
// budget profile + clock into the daily/monthly numbers shown in the Budget tab
// and cited by the agent. Wraps the pure forecast math from forecast.ts.

import type { BudgetProfile, Workload } from '@/types';
import {
  confidenceInterval,
  daysInMonthOf,
  daysUntilBreach,
  forecastStatus,
  fractionalHour,
  projectDailySpend,
  projectMonthlySpend,
  remainingWeekdaysInMonth,
  type ConfidenceInterval,
  type ForecastStatus,
} from './forecast';
import { budgetConsumed } from './metricContracts';
import { thresholdStatus, type ThresholdStatus } from './scales';

export interface DailyStatus {
  spentToday: number;
  dailyBudget: number;
  pctUsed: number;
  /** Reason `pctUsed` (and the projected %) is not meaningful; null when the budget is valid. */
  pctUsedNa: string | null;
  remaining: number;
  hoursRemaining: number;
  projectedClose: number;
  projectedPctOfBudget: number;
  /** 'na' when the budget is invalid: no health claim is made from a zero budget. */
  status: ThresholdStatus | 'na';
}

export interface MonthlyStatus {
  spendMtd: number;
  monthlyBudget: number;
  pctUsed: number;
  /** Reason `pctUsed` (and the projected %) is not meaningful; null when the budget is valid. */
  pctUsedNa: string | null;
  remainingDays: number;
  projectedEom: number;
  projectedPctOfBudget: number;
  confidence: ConfidenceInterval;
  daysUntilBreach: number | null;
  avgDaily7d: number;
  /** 'na' when the budget is invalid (no breach claim, no breach days). */
  status: ForecastStatus | 'na';
}

export interface BudgetStatus {
  daily: DailyStatus;
  monthly: MonthlyStatus;
}

// Month-to-date spend reconstructed from the workload's run rate. Kept here so
// both the daily and monthly views agree on the same MTD figure.
export function spendMtdFor(workload: Workload, now: Date): number {
  if (workload.costs.recorded_mtd !== undefined) return workload.costs.recorded_mtd;
  const priorFullDays = now.getUTCDate() - 1;
  const base = workload.costs.monthly_spend / 30;
  return round2(base * priorFullDays + workload.costs.daily_spend);
}

export function computeBudgetStatus(
  workload: Workload,
  budget: BudgetProfile,
  now: Date,
): BudgetStatus {
  const hourOfDay = fractionalHour(now);
  const spentToday = workload.costs.daily_spend;
  const dailyBudget = workload.costs.daily_budget;

  const daily = projectDailySpend({
    spendSoFar: spentToday,
    hourOfDay,
    allocation: budget.daily_allocation,
  });
  const dailyPctUsed = dailyBudget > 0 ? spentToday / dailyBudget : 0;

  const dailyNa = budgetConsumed(spentToday, dailyBudget).naReason;
  const spendMtd = spendMtdFor(workload, now);
  const monthlyBudget = workload.costs.monthly_budget;
  const monthlyNa = budgetConsumed(spendMtd, monthlyBudget).naReason;
  const daysInMonth = daysInMonthOf(now);
  const remainingWeekdays = remainingWeekdaysInMonth(now);

  const monthly = projectMonthlySpend({
    spendMtd,
    dailySpendHistory: budget.daily_spend_history,
    allocation: budget.daily_allocation,
    currentDay: now.getUTCDate(),
    daysInMonth,
    remainingWeekdays,
  });
  const confidence = confidenceInterval(
    monthly.projectedEom,
    budget.daily_spend_history,
    monthly.remainingDays,
  );
  const breach = daysUntilBreach(
    monthly.projectedEom,
    monthlyBudget,
    spendMtd,
    monthly.avgDaily7d,
  );

  return {
    daily: {
      spentToday,
      dailyBudget,
      pctUsed: dailyPctUsed,
      pctUsedNa: dailyNa,
      remaining: round2(Math.max(dailyBudget - spentToday, 0)),
      hoursRemaining: round1(Math.max(24 - hourOfDay, 0)),
      projectedClose: round2(daily.projectedDailySpend),
      projectedPctOfBudget: dailyBudget > 0 ? daily.projectedDailySpend / dailyBudget : 0,
      status: dailyNa
        ? 'na'
        : thresholdStatus(
            dailyPctUsed,
            budget.soft_threshold_pct,
            budget.hard_threshold_pct,
            budget.kill_threshold_pct,
          ),
    },
    monthly: {
      spendMtd,
      monthlyBudget,
      pctUsed: monthlyBudget > 0 ? spendMtd / monthlyBudget : 0,
      pctUsedNa: monthlyNa,
      remainingDays: monthly.remainingDays,
      projectedEom: round2(monthly.projectedEom),
      projectedPctOfBudget: monthlyBudget > 0 ? monthly.projectedEom / monthlyBudget : 0,
      confidence: { low: round2(confidence.low), high: round2(confidence.high) },
      daysUntilBreach: monthlyNa ? null : breach,
      avgDaily7d: round2(monthly.avgDaily7d),
      status: monthlyNa ? 'na' : forecastStatus(monthly.projectedEom, monthlyBudget),
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

