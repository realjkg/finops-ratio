# Appendix D — Schema sketch for migrations 0002–0004

Part of [DESIGN.md](DESIGN.md) §2.9, §3, §4.6, §6.2. A sketch for review,
not DDL: column lists and keys only. The migrations themselves are written
test-first in PRs 4-1, 4-3 and 5-1, and every object follows the Slice 0
invariants enforced by the existing catalogue tests:

- `tenant_id uuid NOT NULL` on every table; every foreign key composite and
  including `tenant_id`;
- RLS **enabled and forced**, policy `tenant_isolation` with exactly the
  0001 predicate shape (`tenant_id = ratio.current_tenant_id()`);
- money `numeric` (finite: `abs(x) < 'Infinity'`), never float; timestamps
  `timestamptz`; dates `date`;
- every `jsonb` column is an object and refuses secret-like keys and values
  (`ratio.jsonb_has_secret_like_key/value`);
- owned by `ratio_owner`; grants only to the roles in DESIGN §6.1; nothing
  to PUBLIC; reviewed in `privilegeModel.ts`;
- reader access only through definer-rights `security_barrier` views that
  filter on `ratio.current_tenant_id()` and join the **current** publication
  or the **current** run pointer.

## D.0 Identities (stated once; rev. 12)

- **Leaf (forecast and detection series):** one `cost_series` row. Natural
  key: **(tenant_id, billing_currency, provider_name, billing_account_id,
  sub_account_id, service_name, region_key)**. Stable id:
  **`series_id` = `cost_series.id`**. It is allocated once per natural key,
  never reused or renumbered; `cost_series` is insert-only and outside
  retention. Every leaf-keyed table (`cost_daily`, `cost_resource_daily`,
  `forecast_state`, `detector_state`) carries `series_id` with a composite
  FK `(tenant_id, series_id)` → `cost_series`. Provider-local identifiers
  (a billing account id, a sub-account id) are never used alone as a key.
- **Account:** one `cost_accounts` row. Natural key: **(tenant_id,
  billing_currency, provider_name, billing_account_id, sub_account_id)**;
  stable id `account_id`, with the same rules.
- **Aggregate scope key** (`scope_key`, with `scope_kind`), a canonical
  text built only from full identities:
  - `leaf`: the `series_id`;
  - `account`: the `account_id`;
  - `billing_account`: `provider_name` ␟ `billing_account_id`;
  - `billing_account_service`: `provider_name` ␟ `billing_account_id` ␟ `service_name`;
  - `provider_service`: `provider_name` ␟ `service_name`;
  - `business_unit`: the tag value;
  - `provider`: `provider_name`;
  - `tenant`: the empty string.

  ␟ is the unit separator U+001F, refused inside any component. The
  currency is always a separate key column, so two providers that reuse
  the same local id never share a key.

## D.1 Migration 0002 — role, publication catalogue, rollups

| Object | Columns (key first) | Written by | Read by |
|---|---|---|---|
| role `ratio_analytics` | NOLOGIN, no attributes, no membership (guarded like 0001's roles) | — | — |
| view `publications_published` | tenant_id, source_id, billing_period, batch_id, published_at, row_count, loaded_billed_total, reconciliation, is_provisional — from `period_publications` ⋈ `ingest_batches` (`status = 'published'`) | — | analytics, reader (`freshness`) |
| `analytics_runs` | **(tenant_id, id)**, kind ∈ {rollup, forecast, detect, backtest}, as_of date, status ∈ {running, succeeded, failed}, started_at, finished_at, code_version text, params jsonb, stats jsonb, error_code | analytics | analytics |
| `cost_series` | **(tenant_id, id bigint)** = `series_id` (D.0), unique (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name, region_key) where `region_key` is `''` for global services and for every `fleet15k` series; `account_id` (composite FK to `cost_accounts`); first_day, last_day | analytics (INSERT; UPDATE of last_day) | analytics |
| `cost_accounts` (rev. 12) | **(tenant_id, id bigint)** = `account_id` (D.0), unique (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id); first_day, last_day | analytics (INSERT; UPDATE of last_day) | analytics |
| `cost_daily` (narrow, usage only) | **(tenant_id, series_id, usage_date, batch_seq)**, `batch_seq integer` with a composite FK to `rollup_batches (tenant_id, batch_seq)`; `m_usage_effective` (`ChargeCategory = 'Usage'` and `ChargeFrequency = 'Usage-Based'`, no correction), `billed_total`, `effective_total`, `committed_effective`, `untagged_usage_effective`, `row_count`; no other btree (217 B per row measured with a uuid batch key; ≈ 193 B estimated with `batch_seq`, Appendix B.5) | analytics (INSERT … SELECT from `cost_facts_published` per batch) | analytics; reader via `cost_daily_published` (joins the current publication) |
| `billing_daily` (sparse; re-keyed in rev. 12) | **(tenant_id, batch_seq, account_id, usage_date, charge_category, charge_frequency, is_correction)**: every row whose `ChargeCategory` is **not** `Usage` (Purchase, Tax, Credit, Adjustment), by FOCUS `ChargeCategory` and `ChargeFrequency`, corrections flagged; billed, effective, row_count, `tags_invalid_rows`; a row only where the amount is non-zero. Usage rows (all frequencies, corrections included) are in `cost_daily`'s `billed_total` / `effective_total`, so the two tables partition the published facts | analytics | analytics; reader via `billing_daily_published` |
| `billing_daily_scope` (rev. 12) | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, usage_date, charge_category)**; billed, effective, row_count. **Every charge category**: `Usage` from `cost_daily`, the others from `billing_daily`; a row only where non-zero | analytics | reader via `billing_daily_scope_published` (the run in `rollup_pointer`) |
| `rollup_pointer` (rev. 12) | **(tenant_id)**; run_id (composite FK to a `succeeded` `analytics_runs` row of kind `rollup`), `batch_seq_hwm integer` (the highest `batch_seq` that run committed), as_of, updated_at | UPDATE by analytics only, **in the same transaction** that marks the rollup run `succeeded` (mirrors `forecast_pointer`) | every rollup reader view |
| `cost_resource_daily` | **(tenant_id, batch_seq, series_id, usage_date, resource_id)**; `m_usage_effective` (rows above a floor only) | analytics | analytics; reader via view |
| `cost_daily_scope` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, usage_date)**; same measures as `cost_daily` | analytics | reader via view (the run in `rollup_pointer`) |
| `account_dim` | **(tenant_id, run_id, account_id)**; business_unit (modal tag, 28 days), account_age_days (identity columns via `cost_accounts`) | analytics | analytics; reader via view (the run in `rollup_pointer`) |
| `rollup_batches` | **(tenant_id, batch_seq integer)**, unique (tenant_id, batch_id); source_id, billing_period, rolled_up_at, run_id, row totals (to prove rollup = published totals) | analytics | analytics |
| function `ratio.analytics_apply_retention()` | `SECURITY DEFINER`, owned by `ratio_owner`, `SET search_path = pg_catalog, pg_temp`, no arguments, fixed SQL; returns removed-row counts per table. Removes only: rollup rows (`cost_daily`, `cost_resource_daily`, `billing_daily`) whose `batch_seq`'s batch is no longer the published batch of its (source, period); run-keyed rows (`cost_daily_scope`, `billing_daily_scope`, `account_dim`) of runs other than the pointed run and the one before it. A superseded batch's rows are removed only once the replacing batch's `batch_seq` is ≤ `rollup_pointer.batch_seq_hwm`, so nothing a reader can still see is removed. Never: anomalies and their children, backtests, `rollup_batches`, `analytics_runs`. On `REVIEWED_SECURITY_DEFINER_FUNCTIONS`; EXECUTE revoked from PUBLIC, granted to `ratio_analytics` | the job, after each rollup or forecast run | — |

Indexes: primary keys only; a BRIN on `cost_daily (usage_date)` is added
only if a measured query needs it (it was part of the wide variant measured
at 317 B per row).
The `source_id`, `billing_period` and `batch_id` of a rollup row are those
of its `batch_seq` (`rollup_batches`), not repeated per row.

**Which rollup rows a reader sees (rev. 12).** The `rollup_pointer` names
one succeeded rollup run and its high-water mark `batch_seq_hwm`.
- **Batch-keyed views** (`cost_daily_published`, `billing_daily_published`,
  `cost_resource_daily_published`) return, per (source, period), only the
  rows of the **highest `batch_seq` ≤ `batch_seq_hwm`** whose batch is
  published.
- **Run-keyed views** (`cost_daily_scope_published`,
  `billing_daily_scope_published`, `account_dim_published`) return only the
  pointed run.

A rollup that is still running, or that failed, is never visible. A
restatement becomes visible in one step, when its run commits and moves
the pointer. Until then, readers keep seeing the previous batch rather than
a gap or a half-written mix.

`CREATE OR REPLACE` is not an expand statement, so 0002's function is never
redefined: **0003 adds a second reviewed function,
`ratio.analytics_apply_forecast_retention()`**, with the same properties,
for its own run-keyed tables (`forecast_state`, `forecast_points`,
`forecast_totals`, `detector_state`, `detector_cohort_state`; keep the 2
latest succeeded runs).

## D.2 Migration 0003 — forecasts

| Object | Columns (key first) | Notes |
|---|---|---|
| `forecast_pointer` | **(tenant_id)**, run_id, as_of, updated_at | the current forecast run; UPDATE by analytics only |
| `forecast_state` | **(tenant_id, run_id, series_id)** (the leaf, D.0; composite FK to `cost_series`); method ∈ {none, mean, m0, m1, m1_log} (`fleet15k`: fixed rule; `full`: selected in the calibration block), history_days, cold_start flag, alpha, beta, gamma, phi, level, trend, `season numeric[7]`, **calendar factors** `cal_start`, `cal_mid`, `cal_end` (log, 0 when not applied; median estimate on raw `y`) with their value counts m and t-statistics, last_day, `q80_lo/hi numeric[6]`, `q95_lo/hi numeric[6]` (per horizon bucket, relative to level), quantile source ∈ {own, cohort, extrapolated} (`extrapolated`: an empty bucket filled by √h scaling, never scored), cohort key (provider, service category, size decile; no `env`) | ≈ 37 k rows per `fleet15k` run, ≈ 107 k per `full` run, ≈ 0.4 KB each (**assumption**) |
| `forecast_points` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, day)**; expected, lo80, hi80, lo95, hi95 | aggregate scopes only, 90 days |
| `forecast_totals` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, window)** with window ∈ {month_end, next_30, next_90}; actual_to_date, expected_total, lo80, hi80, lo95, hi95, billed_month_end (month_end only), last_published_day | all scopes incl. leaves for month_end |
| `forecast_backtests` | **(tenant_id, run_id, level, horizon_bucket, metric)**; value, n, origins, block ∈ {calibration, scoring} | the accuracy report; kept (not touched by retention) |
| `forecast_backtest_points` | **(tenant_id, run_id, origin_day, scope_kind, scope_key, billing_currency, h)**; expected, lo80, hi80, lo95, hi95 | **aggregate scopes only** (≈ 0.01 GB per `fleet15k` run); leaf points are exported as gzip JSON Lines to the run's evidence directory (≈ 0.2 GB), never stored in the database; both kept (exempt from D-12) |
| `detector_cohort_state` (rev. 12) | **(tenant_id, run_id, cohort_key text)**; D6's per-cohort growth fit (μ̂_k numeric[13], σ̂, n_k) and the pooled scales `σ_pool`, `s₂` per cohort | one row per cohort per detect run; run-keyed, retention keeps 2 runs (previously kept in `detector_state` under a cohort key, which mixed key types) |
| `detector_state` | **(tenant_id, run_id, series_id)** (the leaf, D.0; composite FK to `cost_series`); D3: anchor_day, anchor state (level, trend, season numeric[7]), `cusum_pos`, `cusum_neg`, days_since_anchor; D2: weekday medians numeric[7] and `mad` of calendar-adjusted `log y` over 56 days, `scale_floor`, `sigma_pool`; D8: previous day's one-step log residual, `s2` (pooled 2-day scale); intermittent: `scoring` ∈ {daily, weekly, hurdle}, zero share over 56 days, last 8 weekly sums numeric[8] (weekly), `q_hat`, `m_hat`, `v_hat` and `r1` with the route ∈ {warning, info_only} (hurdle), weekly `cusum_pos`; D4 reactivation: active days in the last 56, `last_active_before_dormancy`, the active share of the 28 days ending there and the active-day mean of the 56 days ending there (extended to at most 112 days for ≥ 3 values; the series keeps its last 3 active-day values); as-of error-bucket counts per cohort (fallback level in use), including 2-day sums; D5/D7: trailing committed share, trailing untagged share; last_day | one row per leaf (`series_id`, D.0) per detect run (≈ 37 k in `fleet15k`, ≈ 0.7 KB each incl. forecast state, assumption); UPDATE by analytics; run-keyed, retention keeps 2 runs |

## D.3 Leaf forecasts on read

A leaf forecast for day `t + h` is a pure function of its
`forecast_state` row: `level + Σφ^i·trend + season[(t+h) mod 7]` (or its
log form), with interval `level × q(bucket(h))`. The function lives in a
shared module used by the job (to write aggregates and backtests) and by the
API (to answer a leaf request), and a test asserts both give identical
output for the same row. This keeps leaf storage at one row per series per
run instead of 90.

## D.4 Migration 0004 — anomalies

| Object | Columns (key first) | Notes |
|---|---|---|
| `anomalies` | **(tenant_id, id uuid)**; dedup key unique (tenant_id, scope_kind, scope_key, billing_currency, category, first_day), with `scope_key` as defined in D.0; category, scope_kind ∈ {leaf, account, billing_account_service, provider_service, billing_account, business_unit, provider, tenant}, scope_key, billing_currency, first_day, last_day, severity, status, status_reason, impact, expected, actual, relative, detectors text[], basis_batch_seqs integer[], merged_into uuid (null unless status_reason = `merged`), first_detected_at, last_evaluated_at, run_id_first, run_id_last | INSERT by analytics; UPDATE of last_day, severity (upwards), impact/expected/actual/relative, status (automatic open → resolved only), status_reason, merged_into, last_evaluated_at, basis_batch_seqs by analytics. Ids are UUID v5 of the dedup key (DESIGN §4.5). No other writer in Slices 3–5 (D-15 deferred) |
| `anomaly_days` | **(tenant_id, anomaly_id, day)**; actual, expected, lo80, hi80, lo95, hi95, z_mad, cusum | evidence for the detail view |
| `anomaly_root_causes` | **(tenant_id, anomaly_id, rank)** rank 1..10; `account_id`, `series_id` (null for an account-level cause), `resource_id` (null unless a resource), excess, share | identities as in D.0; display names are joined from `cost_accounts` / `cost_series` |
| `anomaly_events` | **(tenant_id, anomaly_id, seq)**; at, from_status, to_status, reason, actor (`job` in Slices 3–5; a person's identity once D-15's deferral ends) | append-only: INSERT only, no UPDATE grant to anyone |
| reader views | `anomalies_current`, `anomaly_days_published`, `anomaly_root_causes_published`, `anomaly_events_published` | tenant predicate; nothing else |

## D.5 Grants summary (to be mirrored in `REVIEWED_PRIVILEGES`)

| Role | Grants added |
|---|---|
| `ratio_analytics` | USAGE on schema `ratio`; SELECT on `cost_facts_published`, `publications_published`; SELECT, INSERT on every table above; UPDATE on the listed columns; USAGE on the identity sequences of `cost_series` and `rollup_batches`; EXECUTE on `ratio.current_tenant_id()`, the secret-guard functions its CHECKs evaluate, and the two retention functions; **no DELETE on any table** (D-12) |
| `ratio_reader` | SELECT on the new reader views only |
| `ratio_worker` | none |
