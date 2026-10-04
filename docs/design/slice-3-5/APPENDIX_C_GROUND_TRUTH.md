# Appendix C — Ground truth: catalogue, label format, matching and gate rules

Part of [DESIGN.md](DESIGN.md) §2.5, §4.8 and §4.9 (revision 3).

## C.1 Principles

1. **Injected from the seed**, after the base series are generated and
   **before** `fleet15k` folds tail services, by separate PRNG streams per
   label kind (adding a kind does not move the other kinds' draws).
2. **Every label's effect is in the rows, and nothing else is.** A unit test
   regenerates each series without the label and checks that the difference
   is exactly the label's effect, inside its window only (PR 3-1b).
3. **Labels never enter the database** and are not in the source bucket.
   They are written to `<out>/ground-truth/labels.jsonl` and read only by
   the evaluator.
4. **Seeds.** Each large profile has three seeds (DESIGN §2.6):
   - **tuning**: natural rates plus enriched kinds; used to tune and freeze
     thresholds; never scored;
   - **natural**: the natural rates of DESIGN §2.5 per account-month; used
     for precision, alert volume and forecast targets;
   - **enriched**: ≥ **100 meaningful** labels per gated kind of AT-2 in the
     evaluation window, placed on **individual** (never folded) series;
     used for recall and time-to-detect only.
   `ci` guarantees at least 2 labels of every kind (deterministic
   placement) so every code path is exercised in CI.
5. **Profile differences.** `fleet15k` has no `new_region` (no region
   dimension) and applies `tagging_loss`, `commitment_effect` and
   `commitment_expiry` to whole series. `mtd_restatement` and `late_data`
   exist only in the `ci` daily-delivery replay.
6. **Placement and windows.**
   - `fleet15k`: warm-up days 1–61 (P1–P2), evaluation window **days
     62–122** (P3–P4, 61 days). Natural-seed labels are placed over days
     15–122, so the warm-up is contaminated as real training data would be;
     only labels starting in days 62–122 are scored. Enriched labels are
     placed in days 62–115 so that each can be detected inside the span.
   - `full`: warm-up months 1–6, evaluation window months 7–13 (≈ 7 months).
   - No label starts in an account's first 30 days except
     `new_account_runaway` and `onboarding`.
7. **Impact classes:** for `alert` kinds, the injected excess per day is
   drawn so that ≈ 50 % are **meaningful** (≥ 2 × the minimum impact of
   DESIGN §4.4 in the label's currency), ≈ 25 % **near** (0.5–2 ×) and
   ≈ 25 % **sub-threshold** (< 0.5 ×); the enriched seed draws its gated
   labels as meaningful only. `impactClass` is in the label.
8. **Tail services.** On the natural seed, labels land on services in
   proportion to their natural rates, including services that `fleet15k`
   folds into `Other services`; those labels carry `folded: true`.

## C.2 Catalogue

| Kind | Expected | Entity | Injection (multiplicative on `M` unless stated) | Window | Notes for scoring |
|---|---|---|---|---|---|
| `spike` | alert | leaf series | × U(1.5, 6) for 1–3 days | start … start + len − 1 | gated (AT-2, 0.90) |
| `level_shift` | alert | leaf series | × U(1.2, 3.0) from start, permanent | start … start + 13 | gated (0.90); after 14 days the new level is normal (`new_baseline`) |
| `gradual_drift` | alert | leaf series | extra linear slope reaching + U(30 %, 150 %) after U(14, 45) days, then held | start … start + ramp | gated (0.75); TTD also from the day cumulative excess crosses min impact |
| `new_service` | alert | (account, service) never seen in the account | new series at ≥ min impact (meaningful class) | first day … + 2 | gated (0.90); account age ≥ 30 days |
| `new_region` | alert | (account, service, region) | new region row for an existing service | first day … + 2 | `ci` and `full` only |
| `runaway_resource` | alert | named `ResourceId` in a leaf series | additive excess growing linearly or × U(1.1, 1.4) per day for U(5, 20) days, then 0 | start … fix day | gated (0.90); the resource must be among the group's root causes for a top-k match |
| `tagging_loss` | alert (category `tagging_loss`) | account | ≥ 50 % of the account's usage spend loses the `cost-center` tag from start; **`M` unchanged** | start … start + 6 | gated (0.75); a spend group on this account in the window does not qualify |
| `commitment_expiry` | alert | leaf series with a commitment | the commitment ends without renewal: committed share falls ≥ 20 pp and effective cost rises + U(20 %, 60 %) | start … start + 6 | gated (0.75) |
| `spend_drop` | alert at `info` (D-14) | leaf series | × U(0.1, 0.6) for ≥ 3 days | start … start + 6 | scored at ≥ `info`, not gated |
| `new_account_runaway` | alert | new account | spend ≥ 10 × min impact and above its cohort's p99 for day k ≤ 14 | its days | gated (0.75); tests guardrail D6 |
| `shared_cause` | alert (one group per currency) | (billing account, service) | the same `spike` or `level_shift` in the service in 5–20 accounts of one billing account on the same day | as the underlying kind | AT-6: exactly one group; `childEntities` lists the accounts |
| `provider_shared_cause` | alert (one group per currency) | (provider, service) | the same `spike` or `level_shift` in the service across ≥ 2 billing accounts of one provider, ≥ 20 accounts, on the same day | as the underlying kind | AT-6 |
| `price_change` | alert (one group per currency) | (provider, service) | stressor: every account using the service × U(0.8, 1.3) from the day (increases scored; decreases at `info`) | start … start + 6 | AT-6 |
| `month_end_credit` | **no alert** | account | `Credit` rows, negative, on the last or first day | the day | AT-5 |
| `usage_based_credit` | **no alert** | account | `Credit` row with `ChargeFrequency=Usage-Based` | the day | AT-5; also a rollup unit test: never in `M` |
| `usage_based_tax` | **no alert** | account | `Tax` row with `ChargeFrequency=Usage-Based` | the day | AT-5; same unit test |
| `commitment_purchase` | **no alert** | account | `Purchase` One-Time or Recurring, `EffectiveCost` 0 | the day | AT-5 |
| `commitment_effect` | **no alert** at ≥ `warning` | leaf series | covered usage moves to `Committed`; `M` drops 10–40 % | start … + 6 | AT-5; an `info` `commitment_effect` group is correct |
| `tax`, `recurring_fee` | **no alert** | account | monthly rows | the day | implicit labels (every account-month) |
| `correction` | **no alert** | account | `ChargeClass=Correction` in a later period | the day | AT-5 |
| `onboarding` | **no alert** | account | S-curve ramp over 10–40 days | ramp | AT-5 (D6 must not fire unless cohort p99 is exceeded) |
| `offboarding` | **no alert** at ≥ `warning` | account | decay to 0 over 7–30 days | decay | `info` drop groups are correct |
| `constant_amortised` | **no alert**, gated | leaf series | the same effective cost every day | whole span | AT-5 |
| `month_end_batch`, `monthly_cycle`, `holiday`, `intermittent` | **no alert** (stressor cohorts) | account / series | DESIGN §2.3 | their days | AT-7: false positives reported, not gated |
| `mtd_restatement`, `late_data` | **no alert** (`ci` only) | source / period | revised or late month-to-date rows | revision day | no group from a revision alone; `restated` resolution tested |

## C.3 Label format (`labels.jsonl`, one JSON object per line)

```json
{"labelId":"gt-000123","kind":"level_shift","expected":"alert","impactClass":"meaningful",
 "seed":"natural","enriched":false,"folded":false,
 "tenantSlug":"synthetic-fleet-15k","currency":"USD",
 "entity":{"billingAccountId":"SYN-BA-03FZ","subAccountId":"SYN-A-7KQ2M9XD","serviceName":"…","regionId":null,"resourceId":null},
 "childEntities":[],
 "start":"2026-05-12","end":"2026-05-25",
 "dailyExcess":{"2026-05-12":"2140.0000000000","2026-05-13":"2161.4000000000"},
 "totalExcess":"…","seedStream":"level_shift/…","generatorVersion":"…"}
```

- Money as decimal strings with 10 decimals (BigInt units), never JSON
  numbers. `dailyExcess` per day is what the 30 % rule (C.4) needs.
- `childEntities` lists the accounts (and billing accounts) of a fan-in
  label.
- `folded` is true when the label's service is folded into
  `Other services` in `fleet15k`; its `entity.serviceName` stays the
  original service, and the evaluator maps it to the account's
  `Other services` leaf.
- Implicit labels (`tax`, `recurring_fee`) are not written one per row; the
  evaluator derives them from the kind's rule and `dataset.json`.
- `series-params.jsonl` holds each leaf's true parameters (level, monthly
  growth, weekly factors, noise σ, lifecycle dates, cohort, stressor
  flags), for the oracle forecast and for cohort reporting.

## C.4 Matching rules (evaluator)

Inputs: `labels.jsonl`, `series-params.jsonl`, `dataset.json`, the API's
`GET /api/v1/anomalies` pages (with `anomalies/{id}` for root causes and
daily expected/actual) after an as-of replay over the evaluation window,
and the evaluator's own actuals computed from the source bucket.

1. **Window:** G and L are compatible when tenant and currency agree and
   G's first detection day ∈ [L.start, L.end + 3 days]. Groups resolved as
   `merged` are not evaluated; their survivor is.
2. **Qualification (X = 30 %, k = 3).** A compatible label L qualifies for
   G if either
   - **excess share:** Σ L.dailyExcess over G's days, restricted to the part
     of L's entity inside G's scope, ÷ G's measured excess (Σ actual −
     expected over G's days and scope) is **≥ 0.30**; a group with measured
     excess ≤ 0 has share 0; or
   - **root cause:** L's entity (for `folded` labels: the account's
     `Other services` leaf; for fan-in labels: the label's scope or any
     child entity) is among **G's top 3 root causes**.

   Rationale (DESIGN §4.8): at most three labels can each reach 30 %, which
   bounds the multi-label case; 30 % tolerates a few days of expected-value
   error without crediting a label that is a sliver of the group; top 3 is
   what a reader sees first.
3. **Category compatibility:** `tagging_loss` qualifies only for groups of
   category `tagging_loss`; `commitment_effect` only for
   `commitment_effect`; `commitment_expiry` for `commitment_expiry` or any
   increase category; every other `alert` kind for any spend category (the
   detector's naming is reported as a confusion matrix, not penalised).
4. **Multi-label:** G may qualify for several labels; each counts as
   detected by G.
5. **Precision** (natural seed, groups at ≥ `warning`): G is **correct** if
   it qualifies for at least one `alert` label (any impact class) not
   already detected by an earlier group; it is a **duplicate** if every
   `alert` label it qualifies for was already detected by an earlier group
   (order: first detection day, then id): duplicates count **false** and
   are reported under AT-6; it is **false** if it qualifies only for
   `no_alert` labels or none.
6. **Recall** (enriched seed): per gated kind, over meaningful `alert`
   labels on individual series; a label is detected if a qualifying group
   reaches ≥ `warning`.
7. **Time-to-detect** (enriched seed): first detection day of the first
   qualifying group − L.start, with data for day d available on d + 1; for
   `gradual_drift` also − (first day the cumulative excess ≥ min impact).
8. **Alert volume** (natural seed): groups at ≥ `warning` by first
   detection day, and false groups alone.
9. **Folded labels** (natural seed, `fleet15k`): reported as detected
   (a qualifying group exists) or lost; not gated.
10. **Determinism:** the evaluator's JSON output for a given dataset and API
    output is byte-identical across runs; the TypeScript job's own summary
    must agree with it.

## C.5 Gate decision rules

Wilson score interval, 95 % (z = 1.96), for a proportion p̂ over n:
`(p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)`.

| Gate | Seed | Statistic | Passes when |
|---|---|---|---|
| AT-1 precision | natural | correct ÷ all groups at ≥ `warning` | p̂ ≥ 0.80 **and** Wilson lower ≥ 0.70, n ≥ 100 (fewer: "insufficient n", escalated) |
| AT-2 recall, per kind | enriched | detected ÷ meaningful labels | p̂ ≥ target **and** Wilson lower ≥ target − 0.10, n ≥ 100 per kind |
| AT-3 time-to-detect | enriched | median, p90 | point estimates ≤ targets |
| AT-4 volume | natural | groups per day; false groups per day | means and p95 days ≤ targets |
| AT-5 suppression | natural, enriched | count | exactly 0 |
| AT-6 one group per shared event | natural, enriched | groups per fan-in label per currency; duplicates | exactly 1; 0 duplicates |

Reference values: at n = 100, p̂ = 0.80 gives a lower bound of ≈ 0.71;
p̂ = 0.90 gives ≈ 0.83; p̂ = 0.75 gives ≈ 0.66.

## C.6 Mutation checks for the evaluation harness (PR 5-4)

Each must change the reported metrics in the expected direction, proving
the harness can see failure:

| Mutation (harness-only) | Expected effect |
|---|---|
| drop all groups of one kind from the API output | that kind's recall → 0 |
| shift every detection day by + 5 days | TTD rises; matches outside the window fall out |
| add a group on every `month_end_credit` label | precision falls; AT-5 fails |
| split one `shared_cause` group into N groups | AT-6 fails (N − 1 duplicates) |
| matcher accepts a label explaining 5 % of the excess and ranked 4th | precision rises spuriously; the C.4 rule test fails |
| compute precision on the enriched seed | the seed check fails (precision is natural-only) |
| replace the Wilson rule by the point estimate | a fixture with p̂ = 0.80, n = 20 passes wrongly; the test fails |
| count duplicates as correct | AT-6 and precision tests fail |
| relabel a `no_alert` label as `alert` in a copy of `labels.jsonl` | recall falls by exactly that label |
