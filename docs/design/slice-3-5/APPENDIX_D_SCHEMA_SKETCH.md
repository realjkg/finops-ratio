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
  filter on `ratio.current_tenant_id()` and join a **pointer**: rollup
  views the `rollup_pointer` (snapshot of rolled-up batches, D.1), forecast
  and detector views the `forecast_pointer`. Only `publications_published`
  (freshness) reads the live publication.

## D.0 Identities (stated once; rev. 12, sentinels rev. 13)

**Sentinel convention (rev. 13).** FOCUS leaves most identity columns
optional, and the worker requires only `BilledCost`, `BillingCurrency`,
`ChargePeriodStart`, `ChargePeriodEnd` and `BillingPeriodStart`. So
**every nullable text component of a natural key or primary key is stored
as `''` (empty string) when the source value is null or empty**, and is
declared `NOT NULL`.

The convention is the one `region_key` already used. It applies to
`provider_name`, `billing_account_id`, `sub_account_id`, `service_name`,
`region_key`, `charge_category`, `charge_frequency` and the business-unit
tag. A null and an empty source value therefore mean the same thing, and
no key can hold a NULL that `UNIQUE` would treat as distinct.

Display labels are applied on read, never stored:

| Component | Label for `''` |
|---|---|
| `charge_category` | `(unknown)` |
| `service_name`, `region_key` | `(not attributed)` |
| `sub_account_id`, `billing_account_id` | `(none)` |
| business unit | `untagged` |
| `provider_name` | `(unknown provider)` |

`fleet15k`'s generator emits all of these columns on every row, so the
sentinels matter for real data and for the `ci` null-column tests (DESIGN
§7, PR 4-2).

**Stable ids under nulls (rev. 13, Copilot r4178706470).** The facts carry
nullable identity columns: `provider_name`, `service_name`,
`sub_account_id` and `billing_account_id` are nullable in
`0001_ratio_schema.up.sql`, and `validate.ts` maps missing or empty cells
to NULL. A plain `UNIQUE` treats NULLs as distinct, so repeated batches
could allocate several `series_id` / `account_id` for one null-bearing
identity, which breaks the stable-id contract. Three layers prevent it:
1. **Normalization at identity allocation.** The rollup builds every
   natural-key component as `coalesce(nullif(col, ''), '')`: currency,
   provider, billing account, sub-account, service and region.
   `billing_currency` is already `NOT NULL` and checked as `^[A-Z]{3}$` by
   0001.
2. **`NOT NULL`** on every natural-key column of `cost_series` and
   `cost_accounts`.
3. **`UNIQUE NULLS NOT DISTINCT`** (PostgreSQL 15+; this project pins 16)
   on both natural keys. This is defence in depth: with `NOT NULL` it never
   changes a result, but if a later migration relaxed a `NOT NULL`, NULLs
   would still collide rather than mint new ids.

Ids are allocated only by the rollup writer, under its lease (D.1), with
`INSERT … ON CONFLICT (natural key) DO NOTHING` followed by a `SELECT` of
the id. A repeated batch, or a restatement, with a missing service,
sub-account or billing account therefore always resolves to the same id.

- **Series (rollup grain):** one `cost_series` row. Natural key:
  **(tenant_id, billing_currency, provider_name, billing_account_id,
  sub_account_id, service_name, region_key)**. Stable id
  **`series_id` = `cost_series.id`**, allocated once per natural key and
  never reused or renumbered; `cost_series` is insert-only and outside
  retention. The batch-keyed rollups (`cost_daily`, `cost_resource_daily`)
  carry `series_id`, and D4's region-novelty rule works at this grain.
- **Forecast leaf (forecast and detection grain; rev. 15, Copilot
  r4178753680):** one `forecast_leaves` row per **account × service**, with
  regions summed (DESIGN §3.1). Natural key: **(tenant_id,
  billing_currency, provider_name, billing_account_id, sub_account_id,
  service_name)**, without `region_key`. Stable id **`leaf_id` =
  `forecast_leaves.id`**, with the same rules as `series_id`.
  - Every `cost_series` row carries its `leaf_id`: a composite FK, set when
    the series is allocated and never changed. A leaf's daily values are
    the sum over its series. **Derivation is enforced in the schema (rev.
    16):** a second composite FK from the series' own (currency, provider,
    billing account, sub-account, service) to `forecast_leaves`' natural
    key makes a series under the wrong leaf impossible.
  - `forecast_state`, `detector_state`, the `leaf` anomaly scope and the
    leaf part of a root cause key on `leaf_id`.
  - Revision 12 keyed them on `series_id`. A regional account × service
    then had several ids and no single leaf id.
  - On `fleet15k`, `region_key` is `''` on every row, so leaf and series
    are one-to-one (≈ 37 k each). On `full`, ≈ 107 k leaves group ≈ 147 k
    series.
- Provider-local identifiers (a billing account id, a sub-account id) are
  never used alone as a key.
- **Account:** one `cost_accounts` row. Natural key: **(tenant_id,
  billing_currency, provider_name, billing_account_id, sub_account_id)**;
  stable id `account_id`, with the same rules.
- **Aggregate scope key** (`scope_key`, with `scope_kind`), a canonical
  text built only from full identities:
  - `leaf`: the `leaf_id`;
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
| `analytics_runs` | **(tenant_id, id)**, kind ∈ {rollup, forecast, detect, backtest}, as_of date, status ∈ {running, succeeded, failed, abandoned}, **`run_seq bigint NOT NULL`** (per tenant and kind, allocated by the lease holder as `coalesce(max(run_seq), 0) + 1`, strictly increasing, starting at 1), **`lease_token uuid`, `lease_expires_at`, `heartbeat_at`** (rev. 13; the worker's `sync_runs` lease pattern), **`batch_seq_hwm integer`** (rollup runs only: NULL on INSERT, set **by trigger** on the transition to `succeeded` to `coalesce(max(batch_seq), 0)` over the tenant's `rollup_batches`, then frozen; rev. 15, rev. 16), `UNIQUE (tenant_id, kind, run_seq)` (rev. 16); `succeeded`, `failed`, `abandoned` terminal (rev. 16); started_at, finished_at, code_version text, params jsonb, stats jsonb, error_code; `run_seq`, `kind`, `as_of` and `batch_seq_hwm` are not in the UPDATE grant | analytics | analytics |
| `forecast_leaves` (rev. 15; **insert-only**, outside retention, counted conservatively in every run's disk delta, B.5.12) | **(tenant_id, id bigint `GENERATED ALWAYS AS IDENTITY`)** = `leaf_id` (D.0), `UNIQUE NULLS NOT DISTINCT` (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name), every component `NOT NULL` with the D.0 `''` sentinel; `account_id` (composite FK to `cost_accounts`); first_day, last_day | analytics (INSERT; UPDATE of last_day) | analytics |
| `cost_series` | **(tenant_id, id bigint `GENERATED ALWAYS AS IDENTITY`)** = `series_id` (D.0), `leaf_id` (composite FK to `forecast_leaves`, immutable), and **a second composite FK `(tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name)` → `forecast_leaves`' unique natural key** (rev. 16), so a series can only belong to the leaf its own components name; `UNIQUE NULLS NOT DISTINCT` (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name, region_key), every component `NOT NULL` with the D.0 `''` sentinel (`region_key` is `''` for global services and for every `fleet15k` series); `account_id` (composite FK to `cost_accounts`); first_day, last_day | analytics (INSERT; UPDATE of last_day) | analytics |
| `cost_accounts` (rev. 12) | **(tenant_id, id bigint `GENERATED ALWAYS AS IDENTITY`)** = `account_id` (D.0), `UNIQUE NULLS NOT DISTINCT` (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id), every component `NOT NULL` with the D.0 `''` sentinel (a billing-account-level tax, credit, fee or purchase row with a null `SubAccountId` belongs to the account row with `sub_account_id = ''`); first_day, last_day | analytics (INSERT; UPDATE of last_day) | analytics |
| `cost_daily` (narrow, usage only) | **(tenant_id, series_id, usage_date, batch_seq)**, `batch_seq integer` with a composite FK to `rollup_batches (tenant_id, batch_seq)`; `m_usage_effective` (`ChargeCategory = 'Usage'`, `ChargeFrequency = 'Usage-Based'`, no correction, and a charge period of **at most one day**: `ChargePeriodEnd − ChargePeriodStart ≤ 1 day`, rev. 15), `multi_day_usage_effective` (the `Usage` rows excluded by that last test, attributed to their start day), `billed_total`, `effective_total`, `committed_effective`, `untagged_usage_effective`, `row_count`; no other btree (217 B per row measured with a uuid batch key; ≈ 193 B estimated with `batch_seq`, Appendix B.5) | analytics (INSERT … SELECT from `cost_facts_published` per batch) | analytics; reader via `cost_daily_published` (the highest rolled-up batch ≤ the `rollup_pointer` mark per (source, period), D.1) |
| `billing_daily` (sparse; re-keyed in rev. 12, routing fixed in rev. 13) | **(tenant_id, batch_seq, account_id, usage_date, charge_category, charge_frequency, is_correction)**, all `NOT NULL` with the D.0 sentinels: every row with **`ChargeCategory IS DISTINCT FROM 'Usage'`** (Purchase, Tax, Credit, Adjustment, and a null category as `''`, shown `(unknown)`), by FOCUS `ChargeCategory` and `ChargeFrequency` (`''` when null), corrections flagged; billed, effective, row_count, `tags_invalid_rows`; **a row for every group with at least one fact row, zero amounts included** (rev. 15: revision 12's "only where non-zero" dropped zero-valued non-usage rows and their `row_count`, which broke exactly-once). `cost_daily` takes exactly the rows with `ChargeCategory = 'Usage'` (all frequencies, corrections and negative amounts included) in its `billed_total` / `effective_total`. The two predicates are complements under SQL's three-valued logic, so every published row lands in exactly one table | analytics | analytics; reader via `billing_daily_published` |
| `billing_daily_scope` (rev. 12) | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, usage_date, charge_category)**; billed, effective, row_count. **Every charge category**: `Usage` from `cost_daily`, the others from `billing_daily`; a row for every group with at least one fact row, zero amounts included (rev. 15) | analytics | reader via `billing_daily_scope_published` (the run in `rollup_pointer`) |
| `rollup_pointer` (rev. 12; monotone in rev. 13; HWM redefined in rev. 14; defined on an empty tenant in rev. 15) | **(tenant_id)**; run_id (composite FK to a `succeeded` `analytics_runs` row of kind `rollup`), `run_seq bigint NOT NULL`, **`batch_seq_hwm integer NOT NULL`** = **`coalesce(max(batch_seq), 0)`** over the tenant's `rollup_batches`, read in the run's success transaction under `assertLease` (not the run's own batches; 0 on a tenant with no rolled-up batch, where every view returns nothing), as_of, updated_at | UPDATE by analytics only, **in the same transaction** that marks the rollup run `succeeded` (mirrors `forecast_pointer`), after `assertLease`, and **only forwards**: `… WHERE run_seq < $run_seq AND batch_seq_hwm <= $hwm`; zero rows updated fails the run (`POINTER_STALE`) | every rollup reader view |
| `cost_resource_daily` | **(tenant_id, batch_seq, series_id, usage_date, resource_id)**; `m_usage_effective` (rows above a floor only) | analytics | analytics; reader via view |
| `cost_daily_scope` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, usage_date)**; same measures as `cost_daily` | analytics | reader via view (the run in `rollup_pointer`) |
| `account_dim` | **(tenant_id, run_id, account_id)**; business_unit (modal tag, 28 days), account_age_days (identity columns via `cost_accounts`) | analytics | analytics; reader via view (the run in `rollup_pointer`) |
| `rollup_batches` | **(tenant_id, batch_seq integer)**, unique (tenant_id, batch_id); source_id, billing_period, rolled_up_at, run_id, row totals (to prove rollup = published totals). **Each batch is rolled up in one transaction** (rev. 13), under `assertLease`, that writes all its rollup rows and this row together. A `rollup_batches` row therefore means a complete batch. A batch completed by a run that later fails stays correct, and becomes visible only when a later run's pointer covers it | analytics | analytics |
| function `ratio.analytics_apply_retention()` | `SECURITY DEFINER`, owned by `ratio_owner`, `SET search_path = pg_catalog, pg_temp`, no arguments, fixed SQL; returns removed-row counts per table. Removes only: rollup rows (`cost_daily`, `cost_resource_daily`, `billing_daily`) of a batch below the visible batch of its (source, period), i.e. the highest rolled-up `batch_seq` ≤ `rollup_pointer.batch_seq_hwm` (rev. 13); run-keyed rows (`cost_daily_scope`, `billing_daily_scope`, `account_dim`) of runs other than the pointed run and the one before it. Nothing a reader can still see is removed. Never: anomalies and their children, backtests, `rollup_batches`, `analytics_runs`. On `REVIEWED_SECURITY_DEFINER_FUNCTIONS`; EXECUTE revoked from PUBLIC, granted to `ratio_analytics` | the job, after each rollup or forecast run | — |

Indexes: primary keys only; a BRIN on `cost_daily (usage_date)` is added
only if a measured query needs it (it was part of the wide variant measured
at 317 B per row).
The `source_id`, `billing_period` and `batch_id` of a rollup row are those
of its `batch_seq` (`rollup_batches`), not repeated per row.

**Which rollup rows a reader sees (rev. 12; corrected in rev. 13).** The
`rollup_pointer` names one succeeded rollup run and its high-water mark
`batch_seq_hwm`.
- **Batch-keyed views** (`cost_daily_published`, `billing_daily_published`,
  `cost_resource_daily_published`) return, per (source, period), only the
  rows of the **highest *rolled-up* `batch_seq` ≤ `batch_seq_hwm`**, as
  recorded in `rollup_batches`. Whether that batch is *still* the live
  publication does not matter. A rollup run is a snapshot of what it
  rolled up.

  Revision 12 also required the batch to be published. After a
  restatement publishes B2, B1 is superseded, but B2 is not rolled up until
  the next run, so the (source, period) would have vanished from every
  view. Now readers keep seeing B1 until the run that rolls up B2 commits
  and moves the pointer.
- **Run-keyed views** (`cost_daily_scope_published`,
  `billing_daily_scope_published`, `account_dim_published`) return only the
  pointed run.

A rollup that is still running, or that failed, is never visible. A
restatement becomes visible in one step, when its run commits and moves
the pointer. Retention keeps a superseded batch's rows until its
replacement's `batch_seq` is ≤ `batch_seq_hwm`, so nothing a view can
return is ever removed.

**One rollup writer per tenant (rev. 13).** Rollup runs use the worker's
lease pattern (`src/ingest/worker/lease.ts`):
- **Acquiring the lease.** The job takes
  `pg_advisory_xact_lock(hashtextextended('ratio.analytics.rollup:' || tenant_id, 0))`.
  - If a `running` rollup run with a live lease exists, it refuses with
    `ALREADY_RUNNING`.
  - An expired one is marked `abandoned`.
  - It then inserts its own run with a fresh `lease_token`, a TTL, and the
    next `run_seq`.
- **Writing.** Every write transaction of the run starts with
  `assertLease(run_id, lease_token) FOR UPDATE`. A run whose lease expired
  or was taken over fails with `LEASE_LOST` and commits nothing more
  (fencing).
- **`batch_seq`** is allocated only by the lease holder, inside its
  transaction, as **`coalesce(max(batch_seq), 0) + 1`** over the tenant's
  `rollup_batches`. It starts at 1 on an empty tenant (rev. 15; a bare
  `max + 1` is NULL there). Two writers can never interleave sequence
  numbers.
- **The high-water mark (rev. 14; rev. 15)** is
  **`coalesce(max(batch_seq), 0)`** over the tenant's `rollup_batches`,
  stored in a `NOT NULL` column. It is read in the run's success
  transaction, after `assertLease`; it is not the maximum of the run's own
  batches.
  - **On an empty tenant** the mark is **0**: the first run succeeds,
    inserts the pointer with mark 0, and every view returns nothing. A
    later run that rolls up a batch moves the mark to 1 or more.
  - Revision 14 used a bare `max`, which is NULL on an empty
    `rollup_batches`. The first pointer row would have stored NULL. Every
    later `… batch_seq_hwm <= $hwm` would then update nothing, failing each
    run with `POINTER_STALE`, and the trigger's "decreases" check would be
    NULL too: the pointer would be jammed for good.
  - **Why it is safe:** every `rollup_batches` row commits in the same
    transaction as all of its batch's rows, and there is one writer per
    tenant. So every batch at or below the maximum is complete.
  - **Why it matters:** a batch that run A completed before failing is
    exposed by the next successful run B, even if B rolls up nothing new.
    With revision 13's per-run definition, B's mark was either undefined
    (`POINTER_STALE`) or stayed below A's batch. B2 then stayed hidden
    forever, readers saw B1 forever, and retention kept B1 forever.
  - **It is monotone by construction:** `rollup_batches` is **never
    pruned**, because the retention function excludes it (D.1). Its maximum
    therefore never falls, and `coalesce(…, 0)` keeps the mark at 0 until
    the first batch.
- **Moving the pointer** is monotone: the run's success transaction updates
  `rollup_pointer` only if the stored `run_seq` is lower and the stored
  `batch_seq_hwm` is not higher. An older run that commits late therefore
  cannot move the pointer backwards. A run that rolled up nothing new still
  moves the pointer: `run_seq` grows, and the mark covers any batch
  completed by an earlier failed run.
- **What a reader can see** is exactly the pointed run's high-water mark.
  Rows of a run that has not moved the pointer are invisible, because
  their `batch_seq` is above it.

**Grants and database-side enforcement (rev. 13).** Copilot's review
summary also named pointer enforcement, sequence grants and publication
atomicity. Checking found two gaps, now closed: the pointer rules were
enforced only by the job, and the id sequences had no stated grants.
- **Pointer grants.** `rollup_pointer` and `forecast_pointer`:
  - `ratio_analytics` has SELECT, INSERT (the first row) and column-level
    UPDATE of (`run_id`, `run_seq`, `batch_seq_hwm`, `as_of`,
    `updated_at`); no DELETE, no TRUNCATE.
  - `ratio_reader` sees them only through the definer views.
  - `ratio_worker` has nothing.
- **Pointer guard in the database (rev. 13; tightened in rev. 15, Copilot
  r4178753639).** A `BEFORE INSERT OR UPDATE` trigger on each pointer
  (`ratio.tg_rollup_pointer_guard()`, `ratio.tg_forecast_pointer_guard()`:
  plain `SECURITY INVOKER`, `SET search_path` pinned, marked
  `ratio:allow-function`, owned by `ratio_owner`) rejects:
  - a `run_id` whose `analytics_runs` row is not `succeeded` or is of the
    wrong kind;
  - **`run_seq` or `as_of` different from that run row's**;
  - for `rollup_pointer`, **`batch_seq_hwm` different from the run row's
    recorded `batch_seq_hwm`**;
  - a `run_seq` that does not increase;
  - for `rollup_pointer`, a `batch_seq_hwm` that decreases.

  Revision 13's trigger only compared the supplied numbers with the old
  pointer. The analytics login, which may UPDATE those columns, could have
  pointed at a succeeded run while supplying an unrelated larger `run_seq`
  or a future mark. That would expose batches early or block valid runs.
  Now every number on the pointer must equal the referenced run's own.
- **The mark is recorded by the database (rev. 15; closed for INSERT in
  rev. 16).** A second trigger, `ratio.tg_analytics_run_success()`, runs
  **`BEFORE INSERT OR UPDATE`** on `analytics_runs`. The run row is
  protected twice: by this trigger, and by an INSERT grant that excludes
  `batch_seq_hwm`.
  - **On INSERT** it requires `status = 'running'`, `batch_seq_hwm IS NULL`
    and `run_seq = coalesce(max(run_seq), 0) + 1` for the tenant and kind.
    The column-level INSERT grant also leaves out `batch_seq_hwm` and
    `finished_at`.
  - **On UPDATE** it allows only these status transitions: `running` →
    `succeeded`, `running` → `failed`, `running` → `abandoned`.
    **`succeeded`, `failed` and `abandoned` are terminal**: any change out
    of them is refused, so succeeded → running → succeeded is impossible.
  - On a rollup run's transition to `succeeded`, it sets
    `batch_seq_hwm := coalesce(max(batch_seq), 0)` over the tenant's
    `rollup_batches`.
  - It refuses any change to `run_seq`, `kind`, `as_of` or
    `batch_seq_hwm` after INSERT, other than that one assignment.
  - `UNIQUE (tenant_id, kind, run_seq)` backs the sequence.

  The job therefore never supplies the mark, on INSERT or on UPDATE: it
  reads the mark back and copies it to the pointer, and the pointer trigger
  checks the copy.

  Revision 15's trigger ran on UPDATE only. With an unrestricted INSERT
  grant, the analytics login could insert a row already `succeeded` with
  any mark, `run_seq` or `as_of`, and the pointer guard would have
  accepted it.
- **Direct-INSERT tests (4-1, rev. 16).** As the analytics login, each of
  these is refused, each with a mutant that removes the guarding check:
  - an `INSERT` into `analytics_runs` of a run already `succeeded`;
  - an `INSERT` that supplies `batch_seq_hwm`, refused by the grant and by
    the trigger;
  - an `INSERT` with a duplicate or out-of-order `run_seq`;
  - an attempt to re-succeed a run (succeeded → running → succeeded).
- **Direct-UPDATE tests (4-1).** As the analytics login, run
  `UPDATE rollup_pointer` and `UPDATE analytics_runs` directly with each
  of these, and expect a rejection:
  - a foreign `run_seq`;
  - a future `batch_seq_hwm`;
  - a mismatched `as_of`;
  - a running or failed run;
  - a rewrite of a succeeded run's mark.

  The job's `WHERE` guard and these triggers enforce the same rule twice.
- **Reviewed triggers (Copilot r4178753707).** `privilegeModel.ts`
  allows only the triggers listed in `REVIEWED_TRIGGERS` (today the eleven
  of 0001), and `hookViolations` rejects any other. Migration 0002 adds
  `ratio.rollup_pointer:pointer_guard:ratio.tg_rollup_pointer_guard()` and
  `ratio.analytics_runs:run_success:ratio.tg_analytics_run_success()`;
  migration 0003 adds
  `ratio.forecast_pointer:pointer_guard:ratio.tg_forecast_pointer_guard()`.
  PRs 4-1 and 4-3 extend `REVIEWED_TRIGGERS` by exactly these entries
  (exact old set → exact new set, D-07). Without that, the existing
  privilege audit rejects the migrations.
  **The trigger guards against bugs, not against a compromised job.**
  `ratio_analytics` can mark its own run `succeeded`, so the "succeeded"
  check is self-certifying. What the login cannot do is disable or replace
  the trigger: the trigger and its function are owned by `ratio_owner`,
  and the login is neither the owner nor a superuser (checked at start-up,
  §6.1).
- **Sequences.** `cost_accounts.id`, `forecast_leaves.id` and
  `cost_series.id` are `GENERATED ALWAYS AS IDENTITY`, owned by
  `ratio_owner`. USAGE on these three sequences is granted to
  `ratio_analytics` only, since INSERT needs it;
  `ratio_reader`, `ratio_worker` and PUBLIC get nothing, and the catalogue
  check asserts it. `batch_seq` and `run_seq` are **not** sequences. They
  are allocated as `coalesce(max(…), 0) + 1` inside the lease holder's
  transaction, under the advisory lock, so no sequence grant exists for
  them.
- **Publication atomicity.** The worker publishes batches on its own
  schedule; the analytics side never changes what is published. What
  readers of analytics see changes only when a rollup run's success
  transaction marks the run `succeeded` and moves the pointer, one
  transaction, after `assertLease`. A batch published mid-run is either
  wholly in the run, when it was rolled up before the run's last batch
  transaction, or wholly in the next run.

`CREATE OR REPLACE` is not an expand statement, so 0002's function is never
redefined: **0003 adds a second reviewed function,
`ratio.analytics_apply_forecast_retention()`**, with the same properties,
for its own run-keyed tables (`forecast_state`, `forecast_points`,
`forecast_totals`, `detector_state`, `detector_cohort_state`; keep the 2
latest succeeded runs).

## D.2 Migration 0003 — forecasts

| Object | Columns (key first) | Notes |
|---|---|---|
| `forecast_pointer` | **(tenant_id)**, run_id, `run_seq bigint NOT NULL`, as_of, updated_at | the current forecast run; INSERT/UPDATE by analytics only; forwards only (`run_seq` increases) and only to a `succeeded` forecast run, enforced by the same kind of guard trigger as `rollup_pointer` (D.1) |
| `forecast_state` | **(tenant_id, run_id, leaf_id)** (the forecast leaf, D.0; composite FK to `forecast_leaves`); method ∈ {none, mean, m0, m1, m1_log} (`fleet15k`: fixed rule; `full`: selected in the calibration block), history_days, cold_start flag, alpha, beta, gamma, phi, level, trend, `season numeric[7]`, **calendar factors** `cal_start`, `cal_mid`, `cal_end` (log, 0 when not applied; median estimate on raw `y`) with their value counts m and t-statistics, last_day, `q80_lo/hi numeric[6]`, `q95_lo/hi numeric[6]` (per horizon bucket, relative to level), quantile source ∈ {own, cohort, extrapolated} (`extrapolated`: an empty bucket filled by √h scaling, never scored), cohort key (provider, service category, size decile; no `env`) | ≈ 37 k rows per `fleet15k` run, ≈ 107 k per `full` run, ≈ 0.4 KB each (**assumption**) |
| `forecast_points` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, day)**; expected, lo80, hi80, lo95, hi95 | aggregate scopes only, 90 days |
| `forecast_totals` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, window)** with window ∈ {month_end, next_30, next_90}; actual_to_date, expected_total, lo80, hi80, lo95, hi95, billed_month_end (month_end only), last_published_day | all scopes incl. leaves for month_end |
| `forecast_backtests` | **(tenant_id, run_id, level, horizon_bucket, metric)**; value, n, origins, block ∈ {calibration, scoring} | the accuracy report; kept (not touched by retention) |
| `forecast_backtest_points` | **(tenant_id, run_id, origin_day, scope_kind, scope_key, billing_currency, h)**; expected, lo80, hi80, lo95, hi95 | **aggregate scopes only** (≈ 0.01 GB per `fleet15k` run); leaf points are exported as gzip JSON Lines to the run's evidence directory (≈ 0.2 GB), never stored in the database; both kept (exempt from D-12) |
| `detector_cohort_state` (rev. 12) | **(tenant_id, run_id, cohort_key text)**; D6's per-cohort growth fit (μ̂_k numeric[13], σ̂, n_k) and the pooled scales `σ_pool`, `s₂` per cohort | one row per cohort per detect run; run-keyed, retention keeps 2 runs (previously kept in `detector_state` under a cohort key, which mixed key types) |
| `detector_state` | **(tenant_id, run_id, leaf_id)** (the forecast leaf, D.0; composite FK to `forecast_leaves`); D3: anchor_day, anchor state (level, trend, season numeric[7]), `cusum_pos`, `cusum_neg`, days_since_anchor; D2: weekday medians numeric[7] and `mad` of calendar-adjusted `log y` over 56 days, `scale_floor`, `sigma_pool`; D8: previous day's one-step log residual, `s2` (pooled 2-day scale); intermittent: `scoring` ∈ {daily, weekly, hurdle}, zero share over 56 days, last 8 weekly sums numeric[8] (weekly), `q_hat`, `m_hat`, `v_hat` and `r1` with the route ∈ {warning, info_only} (hurdle), weekly `cusum_pos`; D4 reactivation: active days in the last 56, `last_active_before_dormancy`, the active share of the 28 days ending there and the active-day mean of the 56 days ending there (extended to at most 112 days for ≥ 3 values; the series keeps its last 3 active-day values); as-of error-bucket counts per cohort (fallback level in use), including 2-day sums; D5/D7: trailing committed share, trailing untagged share; last_day | one row per leaf (`leaf_id`, D.0) per detect run (≈ 37 k in `fleet15k`, ≈ 0.7 KB each incl. forecast state, assumption); UPDATE by analytics; run-keyed, retention keeps 2 runs |

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
| `anomaly_root_causes` | **(tenant_id, anomaly_id, rank)** rank 1..10; `account_id`, `leaf_id` (null for an account-level cause), `series_id` (null unless the cause is region-specific), `resource_id` (null unless a resource), excess, share. **When both are set, the series' leaf must equal `leaf_id`** (rev. 16): a composite FK `(tenant_id, series_id, leaf_id)` → `cost_series (tenant_id, id, leaf_id)`, backed by a unique constraint on `cost_series (tenant_id, id, leaf_id)`, so no trigger is needed | identities as in D.0; display names are joined from `cost_accounts` / `forecast_leaves` / `cost_series` |
| `anomaly_events` | **(tenant_id, anomaly_id, seq)**; at, from_status, to_status, reason, actor (`job` in Slices 3–5; a person's identity once D-15's deferral ends) | append-only: INSERT only, no UPDATE grant to anyone |
| reader views | `anomalies_current`, `anomaly_days_published`, `anomaly_root_causes_published`, `anomaly_events_published` | tenant predicate; nothing else |

## D.5 Grants summary (to be mirrored in `REVIEWED_PRIVILEGES`)

| Role | Grants added |
|---|---|
| `ratio_analytics` | USAGE on schema `ratio`; SELECT on `cost_facts_published`, `publications_published`; SELECT, INSERT on every table above, **except `analytics_runs`, where INSERT is column-level and excludes `batch_seq_hwm` and `finished_at`** (rev. 16); UPDATE on the listed columns; USAGE on the identity sequences of `cost_accounts`, `forecast_leaves` and `cost_series` (no others exist: `batch_seq` and `run_seq` are allocated, not sequences); column-level UPDATE on the pointers and on `analytics_runs` as listed (never `run_seq`, `kind`, `as_of`, `batch_seq_hwm`); EXECUTE on `ratio.current_tenant_id()`, the secret-guard functions its CHECKs evaluate, and the two retention functions; **no DELETE on any table** (D-12) |
| `ratio_reader` | SELECT on the new reader views only |
| `ratio_worker` | none |
