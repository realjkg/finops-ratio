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
  (freshness) reads the live publication, and it states the rollup batch
  its coverage comes from (`rollup_batches_visible`, D.1; rev. 18).

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
tag. **It does not apply to `resource_id`** (rev. 19): every row belongs
to some series, account and category, so a sentinel group keeps all
rows, but a row without a resource id belongs to no resource. Such rows
are left out of `cost_resource_daily` and stay in `cost_daily` (D.1). A null and an empty source value therefore mean the same thing, and
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
  never reused or renumbered. `cost_series` **never deletes a row and
  never changes a row's identity columns** (`id`, the natural key,
  `leaf_id`): the analytics login has no DELETE on it and may UPDATE only
  `last_day`, and neither retention function touches it. Revisions 15 and
  16 called it "insert-only", which that `last_day` update contradicted
  (rev. 17); the same holds for `forecast_leaves` and `cost_accounts`. The batch-keyed rollups (`cost_daily`, `cost_resource_daily`)
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
    17):** **one** composite FK `(tenant_id, leaf_id, billing_currency,
    provider_name, billing_account_id, sub_account_id, service_name)` →
    `forecast_leaves (tenant_id, id, billing_currency, provider_name,
    billing_account_id, sub_account_id, service_name)`. It is backed by a
    `UNIQUE` on those `forecast_leaves` columns, so the referenced leaf is
    both the leaf with that id **and** the leaf the series' own components
    name.

    Revision 16 used two separate FKs, one by id and one by natural key.
    Each could be satisfied by a *different* leaf: a series with `leaf_id`
    = svcA's leaf and `service_name` = svcB was accepted, which the
    challenger reproduced on PG16.
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
| `analytics_runs` | **(tenant_id, id)**, kind ∈ {rollup, forecast, detect, backtest}, as_of date, status ∈ {running, succeeded, failed, abandoned}, **`run_seq bigint NOT NULL`** (per tenant and kind, strictly increasing, starting at 1; **allocated for every kind** inside the run's acquisition transaction, under the per-(tenant, kind) advisory lock, as `coalesce(max(run_seq), 0) + 1`; the trigger re-checks it, and `UNIQUE (tenant_id, kind, run_seq)` turns a bypassed lock into SQLSTATE 23505 → `RUN_SEQ_CONFLICT`, D.1), **`lease_token uuid`, `lease_expires_at`, `heartbeat_at`** (rev. 13; the worker's `sync_runs` lease pattern), **`batch_seq_hwm integer`** (rollup runs only: NULL on INSERT, set **by trigger** on the transition to `succeeded` to `coalesce(max(batch_seq), 0)` over the tenant's `rollup_batches`, then frozen; rev. 15, rev. 16), `UNIQUE (tenant_id, kind, run_seq)` (rev. 16); `succeeded`, `failed`, `abandoned` terminal (rev. 16); started_at, finished_at, code_version text, params jsonb, stats jsonb, error_code. **Grants (rev. 17):** column-level INSERT that excludes `batch_seq_hwm` and `finished_at`; column-level UPDATE of exactly (`status`, `lease_token`, `lease_expires_at`, `heartbeat_at`, `finished_at`, `stats`, `error_code`), so `run_seq`, `kind`, `as_of`, `batch_seq_hwm`, `started_at`, `code_version` and `params` are not updatable | analytics | analytics |
| `forecast_leaves` (rev. 15; **rows never deleted, identity columns immutable**, only `last_day` updated (rev. 17; previously called "insert-only"); outside retention, counted conservatively in every run's disk delta, B.5.12) | **(tenant_id, id bigint `GENERATED ALWAYS AS IDENTITY`)** = `leaf_id` (D.0), `UNIQUE NULLS NOT DISTINCT` (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name), and `UNIQUE (tenant_id, id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name)` as the target of `cost_series`' derivation FK (rev. 17), every component `NOT NULL` with the D.0 `''` sentinel; `account_id NOT NULL`, bound by **one composite FK `(tenant_id, account_id, billing_currency, provider_name, billing_account_id, sub_account_id)` → `cost_accounts (tenant_id, id, billing_currency, provider_name, billing_account_id, sub_account_id)`** (rev. 18, Copilot r4178908321: a plain `account_id` FK only proved that *some* account exists, so a leaf could name account B's components while pointing at account A); `UNIQUE (tenant_id, id, account_id)` as the target of the root-cause FK (rev. 18); first_day, last_day | analytics (INSERT; UPDATE of `last_day` only: identity columns immutable, no DELETE; rev. 17) | analytics |
| `cost_series` | **(tenant_id, id bigint `GENERATED ALWAYS AS IDENTITY`)** = `series_id` (D.0), `leaf_id` (immutable), with **one composite FK `(tenant_id, leaf_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name)` → `forecast_leaves (tenant_id, id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name)`** (rev. 17; replaces revision 16's two separate FKs), so a series can only belong to the leaf its own components name; **`UNIQUE (tenant_id, id, leaf_id)`** (the target of the root-cause FK); `UNIQUE NULLS NOT DISTINCT` (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name, region_key), every component `NOT NULL` with the D.0 `''` sentinel (`region_key` is `''` for global services and for every `fleet15k` series); `account_id NOT NULL`, bound by the same **composite FK to `cost_accounts`' id and natural key** as `forecast_leaves` (rev. 18); first_day, last_day | analytics (INSERT; UPDATE of `last_day` only: identity columns immutable, no DELETE; rev. 17) | analytics |
| `cost_accounts` (rev. 12) | **(tenant_id, id bigint `GENERATED ALWAYS AS IDENTITY`)** = `account_id` (D.0), `UNIQUE NULLS NOT DISTINCT` (tenant_id, billing_currency, provider_name, billing_account_id, sub_account_id), every component `NOT NULL` with the D.0 `''` sentinel (a billing-account-level tax, credit, fee or purchase row with a null `SubAccountId` belongs to the account row with `sub_account_id = ''`); **`UNIQUE (tenant_id, id, billing_currency, provider_name, billing_account_id, sub_account_id)`**, the target of the account FKs of `forecast_leaves` and `cost_series` (rev. 18); first_day, last_day | analytics (INSERT; UPDATE of `last_day` only: identity columns immutable, no DELETE; rev. 17) | analytics |
| `cost_daily` (narrow, usage only) | **(tenant_id, series_id, usage_date, batch_seq)**, `batch_seq integer` with a composite FK to `rollup_batches (tenant_id, batch_seq)`; `m_usage_effective` (`ChargeCategory = 'Usage'`, `ChargeFrequency = 'Usage-Based'`, no correction, and a charge period of **at most one day**: `ChargePeriodEnd − ChargePeriodStart ≤ 1 day`, rev. 15), `multi_day_usage_effective` (the `Usage` rows excluded by that last test, attributed to their start day), `billed_total`, `effective_total`, `committed_effective`, `untagged_usage_effective`, `row_count`; no other btree (217 B per row measured with a uuid batch key; ≈ 193 B estimated with `batch_seq`, Appendix B.5) | analytics (INSERT … SELECT from `cost_facts_published` per batch) | analytics; reader via `cost_daily_published` (the highest rolled-up batch ≤ the `rollup_pointer` mark per (source, period), D.1) |
| `billing_daily` (sparse; re-keyed in rev. 12, routing fixed in rev. 13) | **(tenant_id, batch_seq, account_id, usage_date, charge_category, charge_frequency, is_correction)**, all `NOT NULL` with the D.0 sentinels: every row with **`ChargeCategory IS DISTINCT FROM 'Usage'`** (Purchase, Tax, Credit, Adjustment, and a null category as `''`, shown `(unknown)`), by FOCUS `ChargeCategory` and `ChargeFrequency` (`''` when null), corrections flagged; billed, effective, row_count, `tags_invalid_rows`; **a row for every group with at least one fact row, zero amounts included** (rev. 15: revision 12's "only where non-zero" dropped zero-valued non-usage rows and their `row_count`, which broke exactly-once). `cost_daily` takes exactly the rows with `ChargeCategory = 'Usage'` (all frequencies, corrections and negative amounts included) in its `billed_total` / `effective_total`. The two predicates are complements under SQL's three-valued logic, so every published row lands in exactly one table | analytics | analytics; reader via `billing_daily_published` |
| `billing_daily_scope` (rev. 12) | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, usage_date, charge_category)**; billed, effective, row_count. **Every charge category**: `Usage` from `cost_daily`, the others from `billing_daily`; a row for every group with at least one fact row, zero amounts included (rev. 15) | analytics | reader via `billing_daily_scope_published` (the run in `rollup_pointer`) |
| `rollup_pointer` (rev. 12; monotone in rev. 13; HWM redefined in rev. 14; defined on an empty tenant in rev. 15) | **(tenant_id)**; run_id (composite FK to a `succeeded` `analytics_runs` row of kind `rollup`), `run_seq bigint NOT NULL`, **`batch_seq_hwm integer NOT NULL`** = **`coalesce(max(batch_seq), 0)`** over the tenant's `rollup_batches`, read in the run's success transaction under `assertLease` (not the run's own batches; 0 on a tenant with no rolled-up batch, where every view returns nothing), as_of, updated_at | UPDATE by analytics only, **in the same transaction** that marks the rollup run `succeeded` (mirrors `forecast_pointer`), after `assertLease`, and **only forwards**: `… WHERE run_seq < $run_seq AND batch_seq_hwm <= $hwm`; zero rows updated fails the run (`POINTER_STALE`) | every rollup reader view |
| `cost_resource_daily` | **(tenant_id, batch_seq, series_id, usage_date, resource_id)**, `resource_id text NOT NULL CHECK (resource_id <> '')`; `m_usage_effective`. **Named rows above the floor only (rev. 19, Copilot r4178975173):** the rollup selects `nullif(ResourceId, '') IS NOT NULL` and the per-currency floor: a quarter of the tenant's minimum impact in that currency (DESIGN §2.9, §4.4; defaults USD/EUR/GBP 25, JPY 3,750 per day), never converted between currencies; the floors used are recorded in the rollup run's `stats` (rev. 20, Copilot r4179014804: revision 19 had one literal $25). `resource_id` is the one key component that takes **no** `''` sentinel (D.0): an unnamed row is not a resource. Its cost stays in `cost_daily` and the totals, and root causes show it as the series' unattributed remainder (DESIGN §2.9). Revision 18 filtered by the floor alone, so a high-cost unnamed row (null after ingestion's normalization) would have failed the primary key's `NOT NULL` | analytics | analytics; reader via view |
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
- **`rollup_batches_visible` (rev. 18, Copilot r4178908362).** A definer
  view with the same filter: per (source, period), the `batch_id`,
  `batch_seq` and `rolled_up_at` of that visible batch, plus the
  pointer's `batch_seq_hwm`, run and as-of day. `freshness` reads it to
  say which batch its coverage came from, beside the live publication
  from `publications_published`, so a lagging snapshot is stated
  (`coverageStale`) instead of being labelled with the published batch.
  **The visible batch and the coverage sums are read in one statement**
  (a join of this view with `cost_daily_published`), so both see the same
  pointer (rev. 19, the challenger's L4).
- **Run-keyed views** (`cost_daily_scope_published`,
  `billing_daily_scope_published`, `account_dim_published`) return only the
  pointed run.

A rollup that is still running, or that failed, is never visible. A
restatement becomes visible in one step, when its run commits and moves
the pointer. Retention keeps a superseded batch's rows until its
replacement's `batch_seq` is ≤ `batch_seq_hwm`, so nothing a view can
return is ever removed.

**One writer per tenant and job kind (rev. 13 for rollups; every kind in
rev. 17, Copilot r4178820383).** Every analytics run uses the worker's
lease pattern (`src/ingest/worker/lease.ts`): rollup, forecast, detect and
backtest alike. `run_seq` is strictly increasing per tenant and kind, and
only one starter of a kind can be inside the allocation at a time.
- **Acquiring the lease.** The job takes
  `pg_advisory_xact_lock(hashtextextended('ratio.analytics.' || kind || ':' || tenant_id, 0))`
  for its own kind.
  - **Concurrency:** two starts of the same kind cannot both read
    `max(run_seq)`; starts of different kinds do not contend, since they
    have different counters.
  - **Allocation rule, the same for every kind:** inside the acquisition
    transaction that holds that lock, `run_seq := coalesce(max(run_seq),
    0) + 1` over the tenant's runs of that kind. The trigger re-checks the
    value on INSERT. `UNIQUE (tenant_id, kind, run_seq)` (rev. 16) is the
    backstop: a violation (SQLSTATE 23505) can only mean the lock was
    bypassed, so the start fails with `RUN_SEQ_CONFLICT` and commits
    nothing; it is not retried silently.
  - If a `running` run of that kind with a live lease exists, it refuses
    with `ALREADY_RUNNING`.
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
- **Pointer grants, one column list per pointer (rev. 17, Copilot
  r4178843669).** Revisions 13–16 gave both pointers one shared list. It
  named `batch_seq_hwm` on `forecast_pointer`, which has no such column,
  so that GRANT would fail when the migration ran.
  - `rollup_pointer`: `ratio_analytics` has SELECT, INSERT (the first
    row) and column-level UPDATE of (`run_id`, `run_seq`, `batch_seq_hwm`,
    `as_of`, `updated_at`).
  - `forecast_pointer`: SELECT, INSERT (the first row) and column-level
    UPDATE of (`run_id`, `run_seq`, `as_of`, `updated_at`).
  - Neither has DELETE or TRUNCATE. A catalogue test asserts each list
    exactly (4-1, 4-3).
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
- **Direct-INSERT tests (4-1, rev. 16; separated in rev. 17).**
  PostgreSQL checks privileges *before* triggers run. One test cannot
  therefore show both the grant and the trigger, so each defence has its
  own test and its own mutant:
  - **Grant test.** As the analytics login, an `INSERT` that supplies
    `batch_seq_hwm` fails with SQLSTATE **42501** (insufficient privilege).
    A catalogue assertion checks
    `has_column_privilege('ratio_analytics', 'ratio.analytics_runs',
    'batch_seq_hwm', 'INSERT') = false`. Mutant: widen the INSERT grant.
  - **Trigger test.** As a fixture role that *does* hold the column
    privilege (the owner, in the test fixture), an `INSERT` with
    `batch_seq_hwm` set, an `INSERT` already `succeeded`, and an `INSERT`
    with an out-of-order `run_seq` each fail with the trigger's own error
    code. Mutant: remove each check from the trigger.
  - **Re-succeed test.** succeeded → running → succeeded is refused by the
    trigger. Mutant: allow a change out of `succeeded`.
  - **`UNIQUE (tenant_id, kind, run_seq)` test.** Sequential inserts cannot
    show it, because the trigger's max + 1 check already rejects a
    sequential duplicate.
    - **Concurrent test:** two sessions under READ COMMITTED, *without*
      the advisory lock, insert the same kind for one tenant. Both compute
      the same max + 1. With the constraint the second fails with
      **23505**; without it, both commit.
    - **Catalogue assertion:** the constraint exists.
    - **Mutant:** drop the constraint.
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
  are allocated as `coalesce(max(…), 0) + 1` inside a transaction holding
  the per-(tenant, kind) advisory lock: the rollup lease holder's for
  `batch_seq`, and every kind's acquisition transaction for `run_seq`. No
  sequence grant exists for them.
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
`forecast_totals`, `detector_state`, `detector_scope_state` (rev. 18),
`detector_cohort_state`; keep the 2 latest succeeded runs).

## D.2 Migration 0003 — forecasts

| Object | Columns (key first) | Notes |
|---|---|---|
| `forecast_pointer` | **(tenant_id)**, run_id, `run_seq bigint NOT NULL`, as_of, updated_at | the current forecast run; INSERT/UPDATE by analytics only, UPDATE of (`run_id`, `run_seq`, `as_of`, `updated_at`) only (D.1; rev. 17); forwards only (`run_seq` increases) and only to a `succeeded` forecast run, enforced by the same kind of guard trigger as `rollup_pointer` (D.1) |
| `forecast_state` | **(tenant_id, run_id, leaf_id)** (the forecast leaf, D.0; composite FK to `forecast_leaves`); method ∈ {none, mean, m0, m1, m1_log} (`fleet15k`: fixed rule; `full`: selected in the calibration block), history_days, cold_start flag, alpha, beta, gamma, phi, level, trend, `season numeric[7]`, **calendar factors** `cal_start`, `cal_mid`, `cal_end` (log, 0 when not applied; median estimate on raw `y`) with their value counts m and t-statistics, last_day, `q80_lo/hi numeric[6]`, `q95_lo/hi numeric[6]` (per horizon bucket, as applied, in units of `scale_level`, clamped around 0 so the bounds are ordered, D.3; rev. 19), **`scale_level`** (the leaf's trailing 28-day mean of **`|M|`** at the as-of day, floored at min impact / 10,000, so always > 0: the scale the calibration errors are divided by, DESIGN §3.4; rev. 17, made positive in rev. 19), `CHECK (scale_level > 0)`, **`log_var`** (`m1_log` only: the one-step residual variance on the `log1p` scale, for the back-transform; rev. 17), **`q_source text[6]`**, one source per horizon bucket, each ∈ {own, cohort, extrapolated} (`extrapolated`: an empty bucket filled by √h scaling, never scored; rev. 18, Copilot r4178908381: revision 17's single scalar could not describe six buckets that fall back independently), cohort key (provider, service category, size decile; no `env`) | ≈ 37 k rows per `fleet15k` run, ≈ 107 k per `full` run, ≈ 0.4 KB each (**assumption**) |
| `forecast_points` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, day)**; expected, lo80, hi80, lo95, hi95 | aggregate scopes only, 90 days |
| `forecast_totals` | **(tenant_id, run_id, scope_kind, scope_key, billing_currency, window)** with window ∈ {month_end, next_30, next_90}; actual_to_date, expected_total, lo80, hi80, lo95, hi95 (ordered as in D.3, rev. 20), billed_month_end (month_end only), last_published_day, quantile source ∈ {own, cohort, extrapolated} (rev. 17), `clamped boolean` (rev. 20: the total's quantiles were widened to reach the point; reported next to FT-7) | all scopes, **including every leaf for all three windows** (rev. 17, Copilot r4178843716: revision 16 stored the leaf month-end total only, and a leaf's next-30 and next-90 intervals cannot be rebuilt from daily bounds, DESIGN §3.4); ≈ 111 k leaf rows per `fleet15k` run (B.5.12) |
| `forecast_backtests` | **(tenant_id, run_id, level, horizon_bucket, metric)**; value, n, origins, block ∈ {calibration, scoring}; the metrics include `clamped_share` (rev. 20: the share of buckets, and of total windows, whose quantiles were clamped, reported next to FT-7) | the accuracy report; kept (not touched by retention) |
| `forecast_backtest_points` | **(tenant_id, run_id, origin_day, scope_kind, scope_key, billing_currency, h)**; expected, lo80, hi80, lo95, hi95 | **aggregate scopes only** (≈ 0.01 GB per `fleet15k` run); leaf points are exported as gzip JSON Lines to the run's evidence directory (≈ 0.2 GB), never stored in the database; both kept (exempt from D-12) |
| `detector_cohort_state` (rev. 12) | **(tenant_id, run_id, cohort_key text)**; D6's per-cohort growth fit (μ̂_k numeric[13], σ̂, n_k) and the pooled scales `σ_pool`, `s₂` per cohort | one row per cohort per detect run; run-keyed, retention keeps 2 runs (previously kept in `detector_state` under a cohort key, which mixed key types) |
| `detector_state` | **(tenant_id, run_id, leaf_id)** (the forecast leaf, D.0; composite FK to `forecast_leaves`); D3: anchor_day and the **complete M1 state as of the anchor** (rev. 18, Copilot r4178908350): `anchor_method`, `anchor_level`, `anchor_trend`, `anchor_phi`, `anchor_season numeric[7]`, `anchor_cal_start`, `anchor_cal_mid`, `anchor_cal_end`, `anchor_log_var`, copied when the baseline is anchored from **the leaf's model state as of day a**: the state the daily O(1) update has carried to a (DESIGN §4.3), written in D.3's layout, whether or not a forecast run happened on a (refits are weekly, so a `forecast_state` row for day a usually does not exist; rev. 19, the challenger's L3), and never changed until the next re-anchoring, so `ŷ(t | a)` is D.3's formula on these columns alone and a weekly refit or a calendar-factor update cannot move it (revision 17 kept level, trend and season only, so `φ` and the calendar factors were read from the current state); `cusum_pos`, `cusum_neg`, days_since_anchor; the current episode (DESIGN §4.2, rev. 18): `ep_start`, `ep_excess_sum`, `ep_expected_sum`; D2: weekday medians numeric[7] and `mad` of calendar-adjusted `log y` over 56 days, `scale_floor`, `sigma_pool`; D8: previous day's one-step log residual, `s2` (pooled 2-day scale); intermittent: `scoring` ∈ {daily, weekly, hurdle}, zero share over 56 days, last 8 weekly sums numeric[8] (weekly), `q_hat`, `m_hat`, `v_hat` and `r1` with the route ∈ {warning, info_only} (hurdle), weekly `cusum_pos`; D4 reactivation: active days in the last 56, `last_active_before_dormancy`, the active share of the 28 days ending there and the active-day mean of the 56 days ending there (extended to at most 112 days for ≥ 3 values; the series keeps its last 3 active-day values); as-of error-bucket counts per cohort (fallback level in use), including 2-day sums, from which each detect run derives D1's `q₀.₉₉` / `q₀.₀₁`, `σ_pool` and `s₂` (none stored; rev. 18); D5/D7: trailing committed share, trailing untagged share; last_day | one row per leaf (`leaf_id`, D.0) per detect run (≈ 37 k in `fleet15k`, ≈ 0.7 KB each incl. forecast state, assumption; + ≈ 110 B for the rev. 18 anchor and episode columns, B.5.12); UPDATE by analytics; run-keyed, retention keeps 2 runs |
| `detector_scope_state` (rev. 18, Copilot r4178908395) | **(tenant_id, run_id, scope_kind, scope_key, billing_currency)** with `scope_kind` ∈ {billing_account, business_unit, provider, tenant} and `scope_key` as in D.0; D3 on aggregate scopes (DESIGN §4.2): anchor_day, **`baseline numeric[28]`** (the scope's bottom-up forecast `ŷ(a + 1 … a + 28 \| a)`, frozen when the baseline is anchored; 28 days is the oldest a baseline may be), size decile (for the pooled scale), `cusum_pos`, `cusum_neg`, days_since_anchor, `ep_start`, `ep_excess_sum`, `ep_expected_sum`; last_day | one row per aggregate scope per detect run (≈ 550 in `fleet15k`, ≈ 0.6 KB each, assumption: ≈ 0.001 GB for 2 runs, B.5.12); UPDATE by analytics; run-keyed, retention keeps 2 runs. Revision 17 had nowhere to keep an aggregate's anchor and sums between runs, since `detector_state` is keyed by `leaf_id` |

**Fixed-length arrays (rev. 17, Copilot r4178843775).** PostgreSQL does
not enforce a declared array size or dimension count: `numeric[7]` is the
same type as `numeric[]`, and a two-dimensional or a 6-element value would
be stored. Every fixed-length array column therefore carries
`CHECK (array_ndims(x) = 1 AND cardinality(x) = n AND array_lower(x, 1)
= 1 AND array_position(x, NULL) IS NULL)`:
- `forecast_state`: `season` (n = 7); `q80_lo`, `q80_hi`, `q95_lo`,
  `q95_hi` and `q_source` (n = 6), with `q_source <@
  ARRAY['own', 'cohort', 'extrapolated']` as well (rev. 18);
- `detector_state`: `anchor_season` and the weekday medians (n = 7);
  the last weekly sums (n = 8);
- `detector_scope_state`: `baseline` (n = 28; rev. 18);
- `detector_cohort_state`: `μ̂_k` (n = 13).

`'{}'` is rejected: its `array_ndims` is NULL, but its cardinality is 0, so the CHECK is false. A
lower bound other than 1 (`'[0:6]={…}'`) is rejected because D.3 indexes
from 1. The CHECK passes a NULL column, which is how a method without that
state (`none`) stores it. Rejection tests in 4-3: 6 and 8 elements, a
7-element two-dimensional array, an empty array, lower bound 0 and a NULL
element are each refused (SQLSTATE 23514), and so is a `q_source`
element outside the three values; mutant: drop one CHECK.

## D.3 Leaf forecasts on read

A leaf's daily forecast is a pure function of its `forecast_state` row.
Revision 16's formula left out the calendar factor, and it called
`level × q` the interval, although that is only the error term added to
the point (rev. 17, Copilot r4178843747). The full reconstruction, for a
row issued at as-of day `t` and a target day `d = t + h` (1 ≤ h ≤ 90):

1. **Weekly part `w(d)`.** Let `k` be the ISO weekday of `d` minus 1
   (Monday = 0) and `Φ(h) = φ + φ² + … + φ^h` (damped trend).
   - `mean` (cold start, DESIGN §3.5): `w = level × season[k + 1]`, where
     `season` holds the account's weekday ratios (all 1 without a
     profile).
   - `m0`: `w = season[k + 1]`, the 4-week weekday means; `level` and
     `trend` are unused.
   - `m1`: `w = level + Φ(h)·trend + season[k + 1]`.
   - `m1_log`: `w = exp(level + Φ(h)·trend + season[k + 1] + log_var / 2)
     − 1`, the back-transform of the fit on `log1p(y)` with its variance
     correction (DESIGN §3.2).
   - `none`: no forecast (`no_history`).
2. **Calendar factor `c(d)`.** `exp(cal_start)`, `exp(cal_mid)` or
   `exp(cal_end)` when `d` is a `month_start`, `mid_month` or `month_end`
   day (DESIGN §3.2; the class follows from the date alone), else 1. A
   factor that was not applied is stored as 0, so it gives 1.
3. **Point.** `ŷ(d) = w(d) × c(d)`.
4. **Bounds.** With `b` the index 1..6 of h's bucket {1, 2–7, 8–14, 15–30,
   31–60, 61–90}, `L = scale_level` (> 0) and `f(v) = max(0, v)` if
   `ŷ ≥ 0`, else `f(v) = v`:
   - `lo80 = f(ŷ + L × q80_lo[b])`, `hi80 = ŷ + L × q80_hi[b]`;
   - `lo95 = f(ŷ + L × q95_lo[b])`, `hi95 = ŷ + L × q95_hi[b]`.

   **Order (rev. 19, Copilot r4178975191).** The quantiles are stored
   clamped, `q95_lo ≤ q80_lo ≤ 0 ≤ q80_hi ≤ q95_hi` in every bucket (the job clamps them; the property test below checks it),
   and `L` > 0, so `lo95 ≤ lo80 ≤ ŷ ≤ hi80 ≤ hi95` for every row:
   - for `ŷ ≥ 0`, flooring at 0 keeps the lower bounds ≤ `ŷ`;
   - for `ŷ < 0` (net negative usage) there is no floor, so the lower
     bounds stay below the point and the upper bounds above it, negative
     or not.

   Revision 18 used the trailing mean of `M`, which can be ≤ 0 and flip
   the adjustments, and floored the lower bounds at 0 even below a
   negative point. The same rule is used by §3.4's aggregate intervals
   and by the backtest export, which call this function; D1 uses log
   errors on positive points only and is unaffected.

   The stored quantiles are those applied: the cold-start × 1.5 (DESIGN
   §3.5) and the √h scaling of an empty bucket (§3.4) are already in them,
   and `q_source[b]` says where bucket `b` came from. The API returns that
   source with every day (`quantileSource`), and scoring (FT-7, the
   detector budget) skips the days whose bucket is `extrapolated`
   (rev. 18). `L` is stored because `level` is on
   the log scale for `m1_log` and unused for `m0`, so `level × q` was not
   even on the right scale for those methods.

This is the formula the job uses for leaf points (whose sums are the
aggregate points, DESIGN §3.6) and for the leaf backtest export. It lives
in one shared module, used by the job and by the API (to answer a leaf
request). Tests (4-4b, and 5-3 for the anchor):
- **One function:** the job and the API give identical output for the
  same row.
- **Ordered bounds (rev. 19):** a property test over 10,000 random rows
  (negative trailing means, negative points, biased quantiles) finds
  `lo95 ≤ lo80 ≤ ŷ ≤ hi80 ≤ hi95` every time; a leaf with a negative
  28-day mean `M` gets `scale_level` > 0; a negative point keeps raw
  lower bounds. Mutants: the signed mean as `scale_level`; the 0 floor on
  a negative point; unclamped quantiles.
- **Per-bucket source (rev. 18):** a leaf whose buckets 1–3 are `own`, 4
  is `cohort` and 5–6 are `extrapolated` returns those sources day by day,
  and FT-7 skips exactly the days in buckets 5–6; mutant: one scalar
  source per row.
- **D3's anchor (rev. 18; rev. 19):** the anchor columns written on day
  a equal the leaf's daily-updated model state as of a, in D.3's layout,
  on a day with no forecast run; `ŷ(t | a)` from them equals D.3's
  formula on that state, and stays equal after a weekly refit and after a
  calendar-factor update. Mutants: read `φ` or the calendar factors from
  the current state; copy the last `forecast_state` row instead of the
  state as of a.
- **Equal to the backtest:** a `forecast` run with `as_of` equal to a
  backtest origin's day writes `forecast_state` rows whose reconstruction
  equals that origin's exported backtest points: the point and all four
  bounds, for every exported h, compared as exact decimal strings.

**Leaf totals are stored, not reconstructed (rev. 17).** DESIGN §3.4
calibrates the month-end, next-30 and next-90 totals on errors of the
totals themselves, and forbids summing daily bounds. `forecast_totals`
therefore holds all three windows for every leaf (D.2).

**Totals follow the same ordering rule (rev. 20, the challenger's L1).**
Every `forecast_totals` row, at every level and window, is computed as
step 4 above with:
- the window's total as the point;
- the scale `L_T = n × L`, where `n` is the window's number of forecast
  days (remaining days for month-end, 30 or 90) and `L` the scope's
  positive scale;
- the total-error quantiles clamped around 0;
- the floor at 0 only for a total ≥ 0.

So `lo95 ≤ lo80 ≤ total ≤ hi80 ≤ hi95` holds there too, negative totals
included. With `n` = 0 (month-end on the month's last published day) the
interval has zero width at the actuals. The 4-4b property test covers
`forecast_totals` rows as well.

Leaf storage is thus one `forecast_state` row and three `forecast_totals`
rows per **leaf** (`leaf_id`) per run, instead of 90 daily rows.

## D.4 Migration 0004 — anomalies

| Object | Columns (key first) | Notes |
|---|---|---|
| `anomalies` | **(tenant_id, id uuid)**; dedup key unique (tenant_id, scope_kind, scope_key, billing_currency, category, first_day), with `scope_key` as defined in D.0; category, scope_kind ∈ {leaf, account, billing_account_service, provider_service, billing_account, business_unit, provider, tenant}, scope_key, billing_currency, first_day, last_day, severity, status, status_reason, impact, expected, actual, relative, detectors text[], basis_batch_seqs integer[], merged_into uuid (null unless status_reason = `merged`), first_detected_at, last_evaluated_at, run_id_first, run_id_last | INSERT by analytics; UPDATE of last_day, severity (upwards), impact/expected/actual/relative, status (automatic open → resolved only), status_reason, merged_into, last_evaluated_at, basis_batch_seqs by analytics. Ids are UUID v5 of the dedup key (DESIGN §4.5). No other writer in Slices 3–5 (D-15 deferred) |
| `anomaly_days` | **(tenant_id, anomaly_id, day)**; actual, expected, lo80, hi80, lo95, hi95, z_mad, cusum | evidence for the detail view |
| `anomaly_root_causes` | **(tenant_id, anomaly_id, rank)** rank 1..10; `account_id NOT NULL` (rev. 18), `leaf_id` (null for an account-level cause), `series_id` (null unless the cause is region-specific), `resource_id` (null unless a resource), excess, share. **When both are set, the series' leaf must equal `leaf_id`** (rev. 16): a composite FK `(tenant_id, series_id, leaf_id)` → `cost_series (tenant_id, id, leaf_id)`, backed by `UNIQUE (tenant_id, id, leaf_id)` on `cost_series`, so no trigger is needed. That FK is `MATCH SIMPLE`: with `leaf_id` NULL it is not checked at all, so `series_id` = 999 would pass. Revision 17 therefore adds **`CHECK (series_id IS NULL OR leaf_id IS NOT NULL)`**, plus a plain FK `(tenant_id, series_id)` → `cost_series (tenant_id, id)`. **Leaf and account (rev. 18, the challenger's L3 and Copilot r4178908321):** revision 17 still accepted a nonexistent `leaf_id` with `series_id` NULL, and nothing tied `account_id` to the leaf's account. Two more FKs: `(tenant_id, leaf_id, account_id)` → `forecast_leaves (tenant_id, id, account_id)` (backed by that table's `UNIQUE (tenant_id, id, account_id)`; with `account_id NOT NULL` it is checked whenever `leaf_id` is set), and `(tenant_id, account_id)` → `cost_accounts (tenant_id, id)` for an account-level cause. A leaf's account is itself bound to its natural key (D.1), so a cause's series, leaf and account always agree | identities as in D.0; display names are joined from `cost_accounts` / `forecast_leaves` / `cost_series` |
| `anomaly_events` | **(tenant_id, anomaly_id, seq)**; at, from_status, to_status, reason, actor (`job` in Slices 3–5; a person's identity once D-15's deferral ends) | append-only: INSERT only, no UPDATE grant to anyone |
| reader views | `anomalies_current`, `anomaly_days_published`, `anomaly_root_causes_published`, `anomaly_events_published` | tenant predicate; nothing else |

## D.5 Grants summary (to be mirrored in `REVIEWED_PRIVILEGES`)

| Role | Grants added |
|---|---|
| `ratio_analytics` | USAGE on schema `ratio`; SELECT on `cost_facts_published`, `publications_published`; SELECT, INSERT on every table above, **except `analytics_runs`, where INSERT is column-level and excludes `batch_seq_hwm` and `finished_at`** (rev. 16); UPDATE on the listed columns; USAGE on the identity sequences of `cost_accounts`, `forecast_leaves` and `cost_series` (no others exist: `batch_seq` and `run_seq` are allocated, not sequences); column-level UPDATE on each pointer of its own list (D.1: `rollup_pointer` with `batch_seq_hwm`, `forecast_pointer` without) and on `analytics_runs` of exactly (`status`, `lease_token`, `lease_expires_at`, `heartbeat_at`, `finished_at`, `stats`, `error_code`) (never `run_seq`, `kind`, `as_of`, `batch_seq_hwm`); EXECUTE on `ratio.current_tenant_id()`, the secret-guard functions its CHECKs evaluate, and the two retention functions; **no DELETE on any table** (D-12) |
| `ratio_reader` | SELECT on the new reader views only |
| `ratio_worker` | none |
