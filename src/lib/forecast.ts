// Forecast algorithm — spec §6. Pure functions with explicit, unit-testable
// signatures: every input the math needs is a parameter, nothing reads a clock
// or global. The UI passes `now` so the demo is deterministic.

import type { BudgetProfile, DailyAllocation } from '@/types';

export interface DailyForecastInput {
  spendSoFar: number;
  hourOfDay: number; // 0–24 fractional hour elapsed today (UTC)
  allocation: DailyAllocation;
}

export interface DailyForecast {
  hourlyRate: number;
  projectedDailySpend: number;
}

// §6.1 — run-rate projection, peak-hour aware.
export function projectDailySpend(input: DailyForecastInput): DailyForecast {
  const { spendSoFar, hourOfDay, allocation } = input;
  const hoursElapsed = Math.max(hourOfDay, 0.01);
  const hourlyRate = spendSoFar / hoursElapsed;

  let projected: number;
  if (hourOfDay < allocation.peak_hour_end) {
    const remainingPeakHours = Math.max(allocation.peak_hour_end - hourOfDay, 0);
    const remainingOffpeakHours = 24 - allocation.peak_hour_end;
    projected =
      spendSoFar +
      hourlyRate * allocation.peak_multiplier * remainingPeakHours +
      hourlyRate * remainingOffpeakHours;
  } else {
    const remainingHours = 24 - hourOfDay;
    projected = spendSoFar + hourlyRate * remainingHours;
  }

  return { hourlyRate, projectedDailySpend: projected };
}

export interface MonthlyForecastInput {
  spendMtd: number;
  dailySpendHistory: number[]; // recent daily totals, most recent last
  allocation: DailyAllocation;
  currentDay: number; // 1-based day of month
  daysInMonth: number;
  // Number of remaining weekdays (Mon–Fri) left in the month, today excluded.
  remainingWeekdays: number;
}

export interface MonthlyForecast {
  method: BudgetProfile['forecast_method'];
  avgDaily7d: number;
  remainingDays: number;
  projectedEom: number;
}

// §6.2 — weighted 7-day average, adjusted for the weekday/weekend mix of the
// days that actually remain in the month.
export function projectMonthlySpend(input: MonthlyForecastInput): MonthlyForecast {
  const { spendMtd, dailySpendHistory, allocation, currentDay, daysInMonth, remainingWeekdays } =
    input;

  const last7 = dailySpendHistory.slice(-7);
  const avgDaily7d = last7.length > 0 ? last7.reduce((a, b) => a + b, 0) / last7.length : 0;

  const remainingDays = Math.max(daysInMonth - currentDay, 0);
  const remainingWeekends = Math.max(remainingDays - remainingWeekdays, 0);

  const projectedEom =
    spendMtd +
    allocation.weekday * remainingWeekdays +
    allocation.weekend * remainingWeekends;

  return { method: 'weighted_avg_7d', avgDaily7d, remainingDays, projectedEom };
}

// §6.3 — 80% confidence interval (z = 1.28) from 14-day spend volatility.
export interface ConfidenceInterval {
  low: number;
  high: number;
}

export function confidenceInterval(
  projectedEom: number,
  dailySpendHistory: number[],
  remainingDays: number,
): ConfidenceInterval {
  const sample = dailySpendHistory.slice(-14);
  const std = standardDeviation(sample);
  const margin = 1.28 * std * Math.sqrt(Math.max(remainingDays, 0));
  return { low: Math.max(projectedEom - margin, 0), high: projectedEom + margin };
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// §6.4 — days until the monthly budget is breached at current burn rate.
export function daysUntilBreach(
  projectedEom: number,
  monthlyBudget: number,
  spendMtd: number,
  avgDaily7d: number,
): number | null {
  if (projectedEom <= monthlyBudget) return null;
  if (avgDaily7d <= 0) return null;
  const remainingBudget = monthlyBudget - spendMtd;
  if (remainingBudget <= 0) return 0;
  return Math.floor(remainingBudget / avgDaily7d);
}

export type ForecastStatus = 'on_track' | 'at_risk' | 'breach_projected';

export function forecastStatus(projectedEom: number, monthlyBudget: number): ForecastStatus {
  if (projectedEom > monthlyBudget) return 'breach_projected';
  if (projectedEom >= monthlyBudget * 0.9) return 'at_risk';
  return 'on_track';
}

// --- Calendar helpers used to drive the deterministic demo clock ---
//
// The budget calendar is UTC (proleptic Gregorian): a budget day or month is
// the UTC calendar day or month of the instant, whatever the host time zone, so
// the server and every browser agree on "today" and on the month length. The
// Date-taking helpers below read only getUTC* fields, and never construct a
// Date from local-time fields. Month lengths are pure arithmetic on explicit
// (year, month) values.

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1–12, NOT 0-based) of `year`. Pure; no Date, no time zone. */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`month must be an integer 1–12, got ${month}`);
  }
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days in the UTC calendar month containing `date`. */
export function daysInMonthOf(date: Date): number {
  return daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

// Count Mon–Fri strictly after `date`'s UTC day through the end of its UTC
// month (today excluded). Weekdays come from Date.UTC + getUTCDay, so UTC only.
export function remainingWeekdaysInMonth(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const lastDay = daysInMonthOf(date);
  let count = 0;
  for (let day = date.getUTCDate() + 1; day <= lastDay; day += 1) {
    const dow = new Date(Date.UTC(year, month, day)).getUTCDay();
    if (dow >= 1 && dow <= 5) count += 1;
  }
  return count;
}

// Fractional hour of day in UTC, e.g. 17:48 -> 17.8.
export function fractionalHour(date: Date): number {
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}

