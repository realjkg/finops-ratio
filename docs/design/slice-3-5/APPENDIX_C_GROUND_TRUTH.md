# Appendix C — Ground truth: catalogue, label format, matching rules

Part of [DESIGN.md](DESIGN.md) §2.5 and §4.8.

## C.1 Principles

1. **Injected from the seed**, after the base series are generated, by
   separate PRNG streams per label kind (so adding a kind does not move the
   other kinds' draws).
2. **Every label's effect is in the rows, and nothing else is.** A unit test
   regenerates each series without the label and checks that the difference
   is exactly the label's effect, inside its window only (PR 3-1).
3. **Labels never enter the database** and are not in the source bucket.
   They are written to `<out>/ground-truth/labels.jsonl` and read only by
   the evaluator.
4. **Rates per account-month are fixed by profile kind**, so `ci`,
   `fleet15k` and `full` carry the same mix at different scales, with two
   exceptions. `ci` guarantees at least 2 labels of every kind
   (deterministic placement) so every code path is exercised in CI.
   `fleet15k` has no `new_region` (no region dimension), applies
   `tagging_loss` and `commitment_effect` to whole series, and **enriches
   its evaluation window** to ≥ 60 meaningful labels per main kind (spike,
   level shift, drift, new service, runaway resource, shared cause); each
   label records `enriched: true|false` so the evaluator can re-weight
   (C.4 rule 5).
5. **Placement:** labels are spread over the whole span (training data is
   contaminated, as in reality, which is what tests robust fitting), but
   **scored only in the evaluation window** (the last ≈ 6 months). No label
   starts in an account's first 30 days except `new_account_runaway` and
   `onboarding`.
6. **Impact classes:** for `alert` kinds, the injected excess per day is
   drawn so that ≈ 50 % are **meaningful** (≥ 2 × the minimum impact of
   DESIGN §4.4 in the label's currency), ≈ 25 % **near** (0.5–2 ×) and
   ≈ 25 % **sub-threshold** (< 0.5 ×). `impactClass` is in the label.

## C.2 Catalogue

| Kind | Expected | Entity | Injection (multiplicative on `M` unless stated) | Window | Notes for scoring |
|---|---|---|---|---|---|
| `spike` | alert | leaf series (account × service; one region) | × U(1.5, 6) for 1–3 days | start … start + len − 1 | scored by D1 ∧ D2 |
| `level_shift` | alert | leaf series | × U(1.2, 3.0) from start, permanent | start … start + 13 | after 14 days the new level is normal (`new_baseline`) |
| `gradual_drift` | alert | leaf series | extra linear slope reaching + U(30 %, 150 %) after U(14, 45) days, then held | start … start + ramp | TTD also scored from the day cumulative excess crosses min impact |
| `new_service` | alert | (account, service) never seen in the account | new series, level ≥ min impact (meaningful class) | first day … + 2 | account age ≥ 30 days |
| `new_region` | alert | (account, service, region) | new region row for an existing service | first day … + 2 | |
| `runaway_resource` | alert | named `ResourceId` in a leaf series | additive excess growing linearly or × U(1.1, 1.4) per day for U(5, 20) days, then back to 0 | start … fix day | root cause must list the resource |
| `tagging_loss` | alert (category `tagging`) | account | ≥ 50 % of the account's usage rows lose the `cost-center` tag from start; **`M` unchanged** | start … start + 6 | any cost-spike group on this account in the window is a false positive |
| `spend_drop` | alert at `info` (D-14) | leaf series | × U(0.1, 0.6) for ≥ 3 days | start … start + 6 | scored at ≥ `info` |
| `new_account_runaway` | alert | new account | spend ≥ 10 × min impact and above its cohort's p99 for day k ≤ 14 | its days | tests guardrail D6 |
| `shared_cause` | alert (one group) | (billing account, service) | the same `spike` or `level_shift` applied to the service in 5–20 accounts of one billing account on the same day | as the underlying kind | **exactly one** group expected (AT-6); each account is also listed as a child entity |
| `month_end_credit` | **no alert** | account | `Credit` rows, negative, on the last or first day | the day | |
| `commitment_purchase` | **no alert** | account | `Purchase` One-Time or Recurring, `EffectiveCost` 0 | the day | |
| `commitment_effect` | **no alert** at ≥ `warning` | leaf series | covered usage moves to `Committed`; `M` drops by the discount (10–40 %) | start … + 6 | an `info` `commitment_effect` group is correct, not a false positive |
| `tax` | **no alert** | account | `Tax` row monthly | the day | implicit label (every account-month) |
| `recurring_fee` | **no alert** | account | `Purchase`/`Recurring` on day 1 | the day | implicit label |
| `correction` | **no alert** | account | `ChargeClass=Correction` in a later period | the day | |
| `onboarding` | **no alert** | account | S-curve ramp over 10–40 days | ramp | warm-up (D6) must not fire unless cohort p99 is exceeded |
| `offboarding` | **no alert** at ≥ `warning` | account | decay to 0 over 7–30 days | decay | `info` drop groups are correct |
| `month_end_batch` | **no alert** (hard cohort) | account | × 1.3 on the last two business days of every month | those days | false positives reported separately (AT-7) |

## C.3 Label format (`labels.jsonl`, one JSON object per line)

```json
{"labelId":"gt-000123","kind":"level_shift","expected":"alert","impactClass":"meaningful",
 "tenantSlug":"synthetic-fleet-15k","currency":"USD",
 "entity":{"billingAccountId":"…","subAccountId":"…","serviceName":"…","regionId":null,"resourceId":null},
 "childEntities":[],
 "start":"2026-05-12","end":"2026-05-25","dailyExcess":"2140.0000000000","totalExcess":"…",
 "seedStream":"level_shift/…","generatorVersion":"…"}
```

- Money as decimal strings with 10 decimals (BigInt units), never JSON
  numbers.
- `childEntities` lists the accounts of a `shared_cause` label.
- Implicit labels (`tax`, `recurring_fee`) are not written one per row; the
  evaluator derives them from the kind's rule and `dataset.json`.
- `series-params.jsonl` holds each leaf's true parameters (level, monthly
  growth, weekly factors, noise σ, lifecycle dates, cohort), for the oracle
  forecast and for cohort reporting.

## C.4 Matching rules (evaluator)

Inputs: `labels.jsonl`, `series-params.jsonl`, `dataset.json`, and the API's
`GET /api/v1/anomalies` pages (with `anomalies/{id}` for root causes) after
an as-of replay over the evaluation window.

1. **Candidate pairs:** a group G and a label L are compatible when tenant
   and currency agree and G's first detection day
   ∈ [L.start, L.end + 3 days].
2. **Entity match:** L.entity equals G.scope, **or** L.entity is one of G's
   root causes, **or** (for `shared_cause`) G.scope is
   (L.billingAccountId, L.serviceName). An account-level G matches a leaf L
   of that account when L's leaf is among its root causes.
3. **Category compatibility:** `tagging_loss` only matches category
   `tagging_loss`; `commitment_effect` only matches `commitment_effect`;
   every other `alert` kind matches any spend category (the detector's
   naming of spike vs shift is reported as a confusion matrix, not
   penalised).
4. **One-to-many:** a group may match several labels (fan-in); a label is
   detected once its first matching group exists.
5. **Precision** (at ≥ `warning`): G is **correct** if it matches at least
   one `alert` label of any impact class; **false** if it matches only
   `no_alert` labels or none. On `fleet15k`, precision is also reported
   **re-weighted to natural label rates**: correct groups matching only
   enriched labels count with weight (natural rate ÷ enriched rate) of their
   kind; false groups count fully. AT-1 is judged on the re-weighted value.
6. **Recall:** over `alert` labels with `impactClass = meaningful`, by kind;
   a label counts as detected if a matching group reaches ≥ `warning`
   (≥ `info` for `spend_drop`).
7. **Time-to-detect:** first detection day − L.start; with data for day d
   available on d + 1, a same-day-available detection is TTD 1 at best. For
   `gradual_drift`, also first detection day − (first day the cumulative
   excess ≥ min impact).
8. **Alert volume:** groups at ≥ `warning` by first detection day, and
   false groups alone (the `fleet15k` form of AT-4).
9. **Determinism:** the evaluator's output (JSON) for a given dataset and
   API output is byte-identical across runs; the TypeScript job's own
   summary must agree with it (DESIGN §3.8).

## C.5 Mutation checks for the evaluation harness (PR 5-4)

Each must change the reported metrics in the expected direction, proving the
harness can see failure:

| Mutation (harness-only) | Expected effect |
|---|---|
| drop all groups of one kind from the API output | that kind's recall → 0 |
| shift every detection day by + 5 days | TTD rises; matches outside the window fall out |
| treat every label as not enriched | re-weighted precision equals raw precision; the test fails |
| add a group on every `month_end_credit` label | precision falls; AT-5 fails |
| split one `shared_cause` group into N groups | AT-6 fails |
| relabel a `no_alert` label as `alert` in a copy of `labels.jsonl` | recall falls by exactly that label |
