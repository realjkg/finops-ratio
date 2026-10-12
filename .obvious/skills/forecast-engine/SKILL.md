---
name: forecast-engine
description: Ratio's spend-forecast routine — daily (peak-aware) and monthly (weighted-7d) projections, 80% confidence interval, and days-until-budget-breach. Keep formulas exact.
version: 1.0.0
triggers:
  - forecast
  - daily forecast
  - monthly forecast
  - projected spend
  - days until breach
  - confidence interval
author: autobuild
created: 2026-06-26
---

# Forecast Engine — Ratio (`realjkg/finops-ratio`)

The forecast routine projects where spend will land and feeds the forecast-breach
alerts defined in `.obvious/obvious.md` (Alert & Threshold Rules). Keep these
formulas exact — they are the contract between seed data, the budget profile, and
the alert system.

## 1. Daily forecast (peak-aware)

Baseline run-rate extrapolation:

```
hourly_rate          = spend_so_far / hours_elapsed
projected_daily_spend = hourly_rate * 24
```

Adjust for the workload's daily allocation profile (`peak_hour_start`,
`peak_hour_end`, `peak_multiplier`):

```
if current_time < peak_hour_end:
    remaining_peak_hours    = peak_hour_end - current_time
    remaining_offpeak_hours = 24 - peak_hour_end
    projected = spend_so_far
              + (hourly_rate * peak_multiplier * remaining_peak_hours)
              + (hourly_rate * remaining_offpeak_hours)
else:
    remaining_hours = 24 - current_hour
    projected = spend_so_far + (hourly_rate * remaining_hours)
```

If the daily forecast projects hitting the kill threshold (100% of daily budget)
before end of business, raise an immediate forecast alert.

## 2. Monthly forecast (weighted 7-day average — default method)

```
avg_daily_7d  = sum(daily_spend[last 7 days]) / 7
remaining_days = days_in_month - current_day
projected_eom  = spend_mtd + (avg_daily_7d * remaining_days)
```

When the daily allocation profile distinguishes weekday vs weekend spend, prefer
the weekday/weekend mix over a flat average:

```
remaining_weekdays = count_weekdays(today, end_of_month)
remaining_weekends = remaining_days - remaining_weekdays
projected_eom = spend_mtd
  + (daily_allocation.weekday * remaining_weekdays)
  + (daily_allocation.weekend * remaining_weekends)
```

Forecast methods: `linear`, `weighted_avg_7d` (default), `exponential_smoothing`.

## 3. Confidence interval (80%, z = 1.28)

```
std_dev         = standard_deviation(daily_spend[last 14 days])
confidence_low  = projected_eom - (1.28 * std_dev * sqrt(remaining_days))
confidence_high = projected_eom + (1.28 * std_dev * sqrt(remaining_days))
// 1.28 = z-score for an 80% confidence interval
```

## 4. Days until budget breach

```
if projected_eom <= monthly_budget:
    days_until_breach = null            // no breach expected
else:
    daily_burn_rate   = avg_daily_7d
    remaining_budget  = monthly_budget - spend_mtd
    days_until_breach = floor(remaining_budget / daily_burn_rate)
```

## 5. Status thresholds

- `on_track` — `projected_eom <= monthly_budget`.
- `at_risk` — projected within tolerance of the budget ceiling but not yet over.
- `breach_projected` — `projected_eom > monthly_budget`; emit a forecast-breach
  alert with the overshoot amount and `days_until_breach`.

Forecast recalculates immediately when a workload changes model mid-month (new
pricing) or changes demand shape (new run-rate).

