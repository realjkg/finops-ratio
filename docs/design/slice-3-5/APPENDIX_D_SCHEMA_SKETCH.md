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

## D.1 Migration 0002 — role, publication catalogue, rollups

| Object | Columns (key first) | Written by | Read by |
|---|---|---|---|
| role `ratio_analytics` | NOLOGIN, no attributes, no membership (guarded like 0001's roles) | — | — |
| view `publications_published` | tenant_id, source_id, billing_period, batch_id, published_at, row_count, loaded_billed_total, reconciliation, is_provisional — from `period_publications` ⋈ `ingest_batches` (`status = 'published'`) | — | analytics, reader (`freshness`) |
| `analytics_runs` | **(tenant_id, id)**, kind ∈ {rollup, forecast, detect, backtest}, as_of date, status ∈ {running, succeeded, failed}, started_at, finished_at, code_version text, params jsonb, stats jsonb, error_code | analytics | analytics |
| `cost_series` | **(tenant_id, id bigint)**, unique (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name, region_key) where `region_key` is `''` for global services; first_day, last_day | analytics (INSERT; UPDATE of last_day) | analytics |
| `cost_daily` | **(tenant_id, batch_id, series_id, usage_date)**; source_id, billing_period; `m_usage_effective`, `billed_total`, `effective_total`, `committed_effective`, `committed_share` inputs, `recurring_billed`, `one_time_billed`, `credit_billed`, `tax_billed`, `adjustment_billed`, `correction_billed`, `untagged_usage_effective`, `tags_invalid_rows`, `row_count` | analytics (INSERT … SELECT from `cost_facts_published` per batch) | analytics; reader via `cost_daily_published` (joins the current publication) |
| `cost_resource_daily` | **(tenant_id, batch_id, series_id, usage_date, resource_id)**; `m_usage_effective` (rows above a floor only) | analytics | analytics; reader via view |
| `cost_daily_scope` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, usage_date)**; same measures as `cost_daily` | analytics | reader via view (current rollup run) |
| `account_dim` | **(tenant_id, run_id, billing_account_id, sub_account_id)**; provider_name, billing_currency, business_unit (modal tag, 28 days), first_day, last_day, account_age_days | analytics | analytics; reader via view |
| `rollup_batches` | **(tenant_id, batch_id)**; source_id, billing_period, rolled_up_at, run_id, row totals (to prove rollup = published totals) | analytics | analytics |

Indexes: `cost_daily` btree `(tenant_id, series_id, usage_date)` and BRIN
`(usage_date)`; `cost_daily_scope` btree on its key.

## D.2 Migration 0003 — forecasts

| Object | Columns (key first) | Notes |
|---|---|---|
| `forecast_pointer` | **(tenant_id)**, run_id, as_of, updated_at | the current forecast run; UPDATE by analytics only |
| `forecast_state` | **(tenant_id, run_id, series_key)** where series_key = (sub_account_id, service_name, billing_currency); method ∈ {none, mean, m0, m1, m1_log}, history_days, cold_start flag, alpha, beta, gamma, phi, level, trend, `season numeric[7]`, last_day, `q80_lo/hi numeric[6]`, `q95_lo/hi numeric[6]` (per horizon bucket, relative to level), quantile source ∈ {own, cohort} | ≈ 107 k rows per run, ≈ 0.4 KB each (**assumption**) ⇒ ≈ 45 MB per run |
| `forecast_points` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, day)**; expected, lo80, hi80, lo95, hi95 | aggregate scopes only, 90 days |
| `forecast_totals` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, window)** with window ∈ {month_end, next_30, next_90}; actual_to_date, expected_total, lo80, hi80, lo95, hi95, billed_month_end (month_end only), last_published_day | all scopes incl. leaves for month_end |
| `forecast_backtests` | **(tenant_id, run_id, level, horizon_bucket, metric)**; value, n, origins | the accuracy report |

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
| `anomalies` | **(tenant_id, id uuid)**; dedup key unique (tenant_id, scope_kind, scope_key, category, first_day); category, scope_kind ∈ {leaf, account, billing_account_service, billing_account, business_unit, provider, tenant}, scope_key, billing_currency, first_day, last_day, severity, status, status_reason, impact, expected, actual, relative, detectors text[], basis_batch_ids uuid[], first_detected_at, last_evaluated_at, run_id_first, run_id_last | INSERT by analytics; UPDATE of last_day, severity (upwards), impact/expected/actual/relative, status (auto transitions only), last_evaluated_at, basis_batch_ids by analytics; status columns by `ratio_triage` only if D-15 = build |
| `anomaly_days` | **(tenant_id, anomaly_id, day)**; actual, expected, lo80, hi80, lo95, hi95, z_mad, cusum | evidence for the detail view |
| `anomaly_root_causes` | **(tenant_id, anomaly_id, rank)** rank 1..10; dimension set (sub_account_id, service_name, region_key, resource_id), excess, share | |
| `anomaly_events` | **(tenant_id, anomaly_id, seq)**; at, from_status, to_status, reason, actor (`job`, or the API key fingerprint if D-15 = build) | append-only: INSERT only, no UPDATE grant to anyone |
| role `ratio_triage` | only if D-15 = build | column-level UPDATE (status, status_reason) on `anomalies`, INSERT on `anomaly_events` |
| reader views | `anomalies_current`, `anomaly_days_published`, `anomaly_root_causes_published`, `anomaly_events_published` | tenant predicate; nothing else |

## D.5 Grants summary (to be mirrored in `REVIEWED_PRIVILEGES`)

| Role | Grants added |
|---|---|
| `ratio_analytics` | USAGE on schema `ratio`; SELECT on `cost_facts_published`, `publications_published`; SELECT, INSERT on every table above; UPDATE on the listed columns; USAGE on `cost_series`' identity sequence; EXECUTE on `ratio.current_tenant_id()` and the secret-guard functions its CHECKs evaluate; removal of derived rows only if D-12 adopts it |
| `ratio_reader` | SELECT on the new reader views only |
| `ratio_triage` (optional) | as above |
| `ratio_worker` | none |
