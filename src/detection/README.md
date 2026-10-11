# src/detection

Pure, deterministic cost-signal detection for checklist Step 2 (items 2.1 to
2.4 and 2.6). No I/O, no clock reads, no randomness. Callers pass the rows,
the as-of day and the configuration. All date math is UTC civil-day integer
arithmetic and does not depend on the process time zone.

Trust boundary: all inputs (rows, series, previous finding records, config)
are untrusted and validated. Errors are `DetectionError` with fixed text that
never echoes input. Unknown config keys are refused.

## Public API (`index.ts`)

- `buildDailySeries(rows, { tenant, costField, ... })` returns `{ series, stats }`.
  `costField` is `BilledCost` or `EffectiveCost` and the caller must choose.
  Usage rows only; corrections, non-usage-based frequencies and multi-day rows
  are excluded and counted. Cross-tenant rows are refused. Exact duplicate
  RowIds are dropped; conflicting duplicates are an error. Negative Usage
  credits net by default (`negativeAmounts: 'reject'` refuses them).
- `forecastSeries`, `forecastFleet`, `backtestSeries`: model
  `level_trend_weekday`, empirical intervals from rolling-origin errors,
  month-end projection with `remainingDaily`. Fleet roll-up is per
  (tenant, currency); money is never summed across currencies. The backtest
  reports MAPE, WAPE, bias and 80/95 coverage.
- `detectAnomalies(series, asOf, config?)` returns findings with severity,
  impact, relative deviation, detectors, up to 10 contributors, and counts of
  skipped series.
- `reduceFindings(previous, current, asOf, opts)` is the idempotent lifecycle
  reducer (returns records and events).
- `evaluateBudgetThresholds`, `evaluateForecastBreach`: 70/90/100 percent
  thresholds (inclusive) and forecast breach status.
- `classifySeverity`, `resolveConfig`, `DEFAULT_MIN_IMPACT`, `FLOORS`, and
  date helpers.

## Caps (`LIMITS`)

maxRows 250,000; maxSeries 20,000; maxDaysPerSeries 400; maxHorizonDays 90;
maxFindings 5,000; maxContributors 10; maxMemberKeys 200; maxRecords 10,000;
maxIdentifierLength 256; maxAbsAmount 1e12. Exceeding a cap throws (or sets
`truncated` for findings).

## Behavior notes

- Forecast history rules: 0 days gives no_history; 1 to 13 days gives
  mean_of_available; 14 or more is fitted. Under 56 days, or with sparse,
  stale, negative, gap-imputed or parametric-interval conditions, results are
  flagged `estimated` with reasons. Beyond 14 days the interval widens by
  sqrt(h/11) and is flagged `extrapolated`.
- Severity (inclusive, 1e-9 tolerance): warning needs excess >= min impact and
  relative >= 20 percent; critical needs excess >= 10x min and relative >= 50
  percent, or cumulative >= 50x min. Decreases are info. Relative is null when
  expected <= 0. Default min impact: USD/EUR/GBP 100, JPY 15,000. A currency
  without a configured minimum is skipped.
- Lifecycle: same day never counted twice; resolves as auto_recovered after 3
  whole unseen days (1 to 14 configurable); resolved records never reopen;
  severity only rises; resolved records prune after 30 days unless referenced.

## Design deviations

1. Simplified level + damped trend + weekday-factor model instead of
   Holt-Winters/ETS grid search. No log variant, no calendar-event component,
   no Hampel cleaning.
2. Anomaly windows k = 1, 3, 7 days with a median-residual z (threshold 4.5)
   replace the design's D1/D2/D3/D8 detectors. No CUSUM, tag coverage (D5),
   cold-start guardrail (D6) or commitment coverage (D7).
3. Intermittent series (30 percent or more non-positive days) are skipped and
   counted; there is no hurdle or weekly statistic.
4. Reactivation is simplified (size override reduced to 10x min impact).
5. Grouping levels are tenant, service, account, leaf/region rather than the
   design's provider/billing-account levels; no persistence step 4b.
6. Dedup key excludes category; no occurrence counter or UUID v5.
7. Lifecycle is automatic open/resolve plus merge only: no new_baseline or
   restated reason and no acknowledge. Hysteresis is 3 days.
8. Month-end interval is the sum of daily bounds (conservative).
9. Backtest is a single-series rolling origin, not the nested protocol.
   Calibration uses at most 28 origins and up to 60 days.
10. Credit/refund rule (net by default, optional reject) is my own.
11. Budget severity mapping (soft=info, hard=warning, kill=critical) is an
    assumption.
12. One-day detections also require the actual above the 95 percent bound and
    an out-of-sample sigma check, to hold false alarms down.

## Known gaps

No persistence, scheduling, notification or UI. No FX conversion. No
tag-based or commitment-aware detection. Synthetic-data validation only: no
real billing data was used to tune thresholds. False-alarm rate measured on
seeded stationary noise: 0 of 28,800 series-days (Gaussian) and 1 (lognormal)
with grouping disabled; `falsealarm.test.ts` asserts a bound on 2,400.
