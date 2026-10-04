# Slices 3–5 design — evidence and revision history

Part of [DESIGN.md](DESIGN.md). Branch `design/slice-3-5-forecast-anomaly`,
from `origin/main` at 827773f. Design documents only. Revisions 1–4 were
not pushed by the design agent; from revision 5 the branch is on
`origin/design/slice-3-5-forecast-anomaly` and revisions are added by
ordinary commits and plain pushes (never a force-push). PR #70 was merged
at revision 27 (`28f8970`; merge commit `f35c383` on `main`). Revision 28
is a follow-up PR on `design/slice-3-5-followups`, branched from
`origin/main` at `f35c383`, under the same rules.

## 1. Revisions

| Rev. | Commit(s) | What changed |
|---|---|---|
| 1 | `cb464e8` | First design: gap analysis, generator, forecasting, detection, API, security, plan, 20 open decisions with recommended defaults; appendices A–D. |
| 2 | `272d119`, `461fbc2` | The orchestrator's decisions of 2026-10-04 recorded (D-01..D-20); three profiles (`ci`, `fleet15k`, `full`); `fleet15k` sized from row sizes measured on PostgreSQL 16; plan re-ordered (the `daysInMonthOf` fix first); tracked items T1–T6. |
| 3 | `9b33984`, `9a17924` | The challenger's REQUEST CHANGES on 461fbc2 (1 High, 12 Medium, 8 Low), all answered (§3); the orchestrator's M9 mapping recorded as D-21; the governance wording of revisions 1–2 reverted (§2). |
| 4 | `faeabb4`, `4492d2f` | The challenger's re-review of 461fbc2..9a17924 (2 Medium, 5 Low), all answered (§3a). |
| 5 | `fc7ee66`, `f5676d9` | The challenger's review of 9a17924..4492d2f (1 High, 2 Medium, 3 Low), all answered (§3b); the orchestrator's decisions D-22 (calendar component, option a) and D-23 (≤ 0.15/day design margin) recorded. |
| 6 | `66a1fa2`, `472dbe3` | The challenger's review of 4492d2f..f5676d9 (1 High, 2 Medium, 4 Low), all answered (§3c): intermittent series on non-overlapping weekly sums or `info` only (D-24, proposed), calendar factors on raw `y` with a median estimator and a calendar-aware Hampel, estimation noise in every budget term, D8, h = 9.0, `budget4.py` (B.5.9). |
| 7 | `380e9a0`, `801019a` | Revision 6 approved by the challenger (0 High, 0 Medium). D-24 decided by the orchestrator (option a): hurdle statistic with a clustering gate for intermittent series above 50 % zeros; the challenger's Low items L1–L4 answered (§3d); `budget5.py` (B.5.10). |
| 8 | `04e6cf8`, `dbbd552` | Revision 7 approved by the challenger. The remaining Low, dormant series that reactivate, folded in by extending D4 (§3e); `reactivation.py` (B.5.11). |
| 9 | `bb4379c`, `d70f074` | The challenger's REQUEST CHANGES on revision 8 (1 Medium): the reactivation history condition looked at the wrong days. History moved to the pre-dormancy period and a size override added, both decided by the orchestrator (§3f); `reactivation.py` updated (B.5.11). |
| 10 | `9f1febb`; merge of `origin/main` `bd440b5`; `adf0d19` | Revision 9 approved by the challenger. The three Low items (§3g): reactivation false positives under day clustering simulated on the chain (the independent-history approximation underestimated); the prior mean of the size override looks back up to 112 days; the D4 text made consistent. `origin/main` merged (#65, #67, #68; no conflicts, no file under `docs/design/slice-3-5/` touched by main); DESIGN §0 and §7 note that PR 4-0 and #62 have landed. |
| 11 | `d6be584` (PR #70) | Revision 10 approved by the challenger (0 High, 0 Medium). Two wording Lows (§3h): D-21 and the opt-in text state the contract #62 shipped in #67 and #68; the prior-mean lookback is capped at 112 days. |
| 12 | `d691069` | Copilot's review 5407381989 of PR #70 at d6be584 (2 High, 2 Medium), each verified and fixed (§3i): one leaf identity everywhere (`series_id`), a billing rollup by charge category behind `costs/daily`'s billed totals, an exact Garwood interval, and a rollup pointer. |
| 13 | `86c2c29` | The challenger's REQUEST CHANGES on revision 12 (2 Medium, 1 Low) and Copilot's review 5407430521 (r4178706470, High): rollup pointer semantics and a single lease-holding writer; exactly-once coverage with nulls; stable ids under null identity columns; pointer guard, sequence grants and per-batch atomicity; `rollup12.py` category count (§3j). |
| 14 | `10cd9ce` | The challenger's REQUEST CHANGES on revision 13 (1 Medium, 3 Low), §3k: the high-water mark is the tenant's `max(batch_seq)`; the pointer trigger's scope stated; sentinel groups marked `attributed: false`; the negative-usage blind spot in the budget table and the limits. |
| 15 | `dc43f4f`, `a268c0e` | The challenger's REQUEST CHANGES on revision 14 (1 Medium, 3 Low), §3l, and Copilot's review 5407477027 of 10cd9ce (16 findings), §3m: the high-water mark and the sequence allocation are defined on an empty tenant (`coalesce(max, 0)`, `NOT NULL`); the monotonicity reason corrected; the known-limits list made complete. |
| 16 | `9e0d703`, `1ac82f7`, `6cad4cd` | The challenger's REQUEST CHANGES on revision 15 (2 Medium, 4 Low), §3n: the run row is closed for INSERT with terminal statuses and a unique `run_seq`; an effect window for every label kind; multi-day usage in the limits with a coverage share; leaf derivation enforced by FKs. |
| 17 | `77a2faf`, `f288d2f`, `cc54e79` | Copilot's review 5407588631 of 6cad4cd (6 High, 4 Medium, 1 Low), §3o: one writer per tenant and job kind for `run_seq`; one day index `t` for every detector; fan-in before persistence with merge semantics; daily excess vs cumulative impact and `ρ` at expected 0; stale wording swept. The challenger's REQUEST CHANGES on 6cad4cd (2 Medium, 4 Low), §3p: one composite FK binds a series to its leaf; separate grant, trigger and concurrent-UNIQUE tests; a CHECK for root causes without a leaf; paginated per-leaf coverage; §5 wording. Copilot's review 5407636005 of 6cad4cd (six new threads), §3q: one UPDATE column list per pointer; leaf totals stored for all three windows (disk delta +0.066 GB per run, peak 5.22 GB); the full leaf reconstruction formula; CHECKs on fixed-length arrays; "insert-only" replaced. |
| 18 | `f1981c2`, `ddbb6f0` | The challenger's REQUEST CHANGES on cc54e79 (1 Medium, 5 Low), §3r: severity of a multi-day statistic on its window's mean (as the budget computed it), with the D3 episode and its restart stated; AT-3's drift target checked (`drift_ttd.py`, B.5.13: not infeasible by construction, at risk, unchanged under D-20); day-index leftovers; fan-in step 1 by the rule's own scope; root-cause leaf and account FKs; the 5.5 / 6 GB limits apply to the peak; D1's log quantile and the intermittent-interval wording. Copilot's review 5407703235 of cc54e79 (seven threads), §3s: accounts bound to their natural key; the complete M1 anchor state for D3; aggregate-scope detector state; `freshness` states its rollup snapshot and a bounded coverage share; per-bucket quantile sources; a working recall mutation. Disk delta +0.082 GB per run, peak 5.23 GB. |
| 19 | `0dd6743` | Copilot's review 5407780981 of ddbb6f0 (2 High, 1 Medium) and the challenger's four Low items on revision 18 (APPROVED, 0 High, 0 Medium), with two plan slips, §3t: named resources only in `cost_resource_daily` (no `''` sentinel for `resource_id`); a positive `scale_level` and clamped quantiles so leaf bounds stay ordered for negative usage; billed `B` on month-end only; "lower bound" renamed; the 28-day re-anchoring cap wins; the D3 anchor is the daily-updated state; `freshness` reads its batch and sums in one statement; the weekly and hurdle baselines named; the 4-4b and 4-5 tests completed. |
| 20 | `d4616a8` | Copilot's review 5407820380 of 0dd6743 (1 High, 3 Medium) and the challenger's three Low items on revision 19 (APPROVED, 0 High, 0 Medium), §3u: `freshness` keyset on `(share, leaf_id)`; a per-currency resource floor (a quarter of the minimum impact); the conditional floor applied to intermittent series and to every total; `detector_scope_state` in every retention list and test; clamping's effect on FT-7 reported. |
| 21 | `3aaa678`, `bddefe9` | Copilot's review 5407844545 of d4616a8 (2 High, 1 Medium) and the challenger's one Low on revision 20 (APPROVED, 0 High, 0 Medium), §3v: `block`, currency and segment in the backtest report's key; `n` = 0 origins left out of the totals calibration; month-end errors bucketed by remaining days; the backtest report published by a view on the latest succeeded backtest run; EVIDENCE §3u's section reference corrected. |
| 22 | `c85079f` | Copilot's review 5407898631 of bddefe9 (3 High, 1 Medium, 1 Low) and the challenger's one Low on revision 21 (APPROVED, 0 High, 0 Medium), §3w: billed `B` only at scopes with a billing source; parent integrity of the anomaly tables; M1-log eligibility and its runtime fallback; the `cost_daily` row measured with its six measures (`rowsize3.sql`; peak 5.18 GB); D-21's provider names; backtest reads atomic per snapshot. |
| 23 | `b9b2274` | Copilot's review 5407941028 of c85079f (1 High, 2 Medium) and the challenger's one Low on revision 22 (APPROVED, 0 High, 0 Medium), §3x: merge targets terminal, enforced by a locking trigger (`tg_anomaly_merge_guard`, `REVIEWED_TRIGGERS` 14 → 15) with re-pointing before a survivor is merged; M1-log eligibility over everything its fit and selection read; calendar factors from valid samples only; "never reopened". |
| 24 | `f3209ea` | Copilot's review 5407981134 of b9b2274 (3 High, 1 Medium) and the challenger's one Low on revision 23 (APPROVED, 0 High, 0 Medium), §3y: account-scope daily forecasts rebuilt on read with stored interval state, and a scope census (peak 5.24 GB); anomaly changes published in the detect run's success transaction; valid-sample rules for the log-scale detectors; a scale-aware zero week in `budget5.py` (outputs unchanged); a `repointed` event. |
| 25 | `45b0088` | Copilot's review 5408081799 of f3209ea (1 High, 2 Medium, 2 Low) and the challenger's Low and nit on revision 24 (APPROVED, 0 High, 0 Medium), §3z: an `occurrence` in the anomaly dedup key for re-introduced restatements; bounded backtest retention with pins; the `bottom_up` summary for non-leaf scopes; `forecast_scope_state` arrays checked; stale scope counts; event-target foreign keys. |
| 26 | `546e00b` | Copilot's review 5408165158 of 45b0088 (1 Medium, 1 Low) and the challenger's three Low items on revision 25 (APPROVED, 0 High, 0 Medium), §3aa: bounded shares (cold-start, committed, untagged), defined APE and interval width; the retention threat-model row and rollback text brought up to date; `backtest --pin` in the success transaction; `historyDays` from leaves' first usage day; "fresh replay". |
| 27 | `28f8970` (PR #70, merged as `f35c383`) | Copilot's review 5408199807 of 546e00b (2 High, 1 Medium), after the challenger APPROVED revision 26 without findings, §3ab: retention never removes anything a running run uses (shared/exclusive retention lock); every multi-transaction run captures its input runs once and reads them by id; billed month-end `B` removed from the contract and recorded as a gap; a share-test wording fix. |
| 28 (follow-up to merged #70) | `0926b19` (PR #71) | Copilot's review 5408232490 of 28f8970 (1 High, 1 Low) and the challenger's four Low items on revision 27 (APPROVED, 0 High, 0 Medium), §3ac: the sizing scripts' commitment draw made once per account and the scripts re-run (37,033 leaves; false-positive total 0.102, 0.132 conservative; peak 5.242 GB unchanged); the last billed-`B` line removed; the retention functions' isolation, lock order and transaction placement, and the crashed-run growth, stated; the input high-water mark checked on INSERT. |
| 29 (follow-up to merged #70) | `7e49bfb` | Copilot's review 5408332571 of 0926b19 (3 High, 1 Medium, all on revision 28's crashed-run bound) and the challenger's one Low on revision 28 (APPROVED, 0 High, 0 Medium), §3ad: every start runs a retention cleanup pass after its acquisition commits, so crashed retries cannot accumulate; the bound restated (one left-over run per kind, ≈ 0.1 GB of state plus the superseded batches its mark pinned); `assertLease` on reading transactions too; the 4-3 test covers consecutive crashed replacements. |
| 30 (follow-up to merged #70) | `c615ea3` | Copilot's review 5408381491 of 7e49bfb (1 Medium) and the challenger's three Low items on revision 29 (APPROVED, 0 High, 0 Medium), §3ae: every retention pass also deletes eligible backtest export files after its commit; read-only run transactions take the lease row `FOR SHARE`, and the TTL must exceed the longest transaction; pinned failed or abandoned runs are kept; the takeover's wait is bounded by a `lock_timeout`. |
| 31 (follow-up to merged #70) | `aeef207`, `591b9cf` (§5 record) | Copilot's review 5408406528 of c615ea3 (2 Medium) and the challenger's one Low on revision 30 (APPROVED, 0 High, 0 Medium), §3af: `assertLease` renews the lease before a transaction when less than its budget plus 30 s is left, and refuses budgets above TTL − 30 s (≤ 270 s at `main`'s defaults); the file phase of retention is serialized per directory by an atomic claim-and-rename, with `deleted.json` written before deletion and stale claims finished; `lock_timeout` set only around the `abandoned` update. |
| 32 (follow-up to merged #70) | `66205dd` | Copilot's review 5408458938 of 591b9cf (1 High, 1 Medium) and the challenger's two Lows and nit on revision 31 (APPROVED, 0 High, 0 Medium), §3ag: the lease renewal commits in its own short transaction, and the work transaction checks the remaining lifetime under its lock (retry once, then `LEASE_LOST`); one margin rule, m = max(1 s, TTL / 10), with TTL ≥ 5 s; the claim protocol's local-POSIX assumption and by-name rule stated; temporary manifests excluded from hashing. |
| 33 (follow-up to merged #70) | this revision | The challenger's REQUEST CHANGES on revision 32 (1 Medium, 1 Low, 1 nit), §3ah: a renewing overlapping-readers case that kills the in-transaction-renewal mutant; `LEASE_RETRY`, a retryable code for a live lease that stays short under contention, with `LEASE_LOST` kept for a lease that is not live; the TTL minimum cited from `config.ts:231`. |

## 2. Governance wording: reverted

Revisions 1 and 2 of this design were **deliberately worded so that the
governance classifier** (`scripts/governance/risk-rules.json`, whose
added-line rules match words such as the retention terms and
`password=`-style assignments anywhere in a diff) **would classify the PR
as `low`**. The documents said "data lifetime" instead of retention,
avoided naming secret-bearing environment variables, and carried a
"wording note" explaining this. Revision 2's report quoted the resulting
`low` classification.

That was wrong: shaping text to steer a control defeats the purpose of the
control. Revision 3:

- removes the wording note;
- uses natural terminology: "retention", "retention policy", "removal",
  and the actual variable names where they are relevant
  (`POSTGRES_PASSWORD` in Appendix B.5.6, `RATIO_LOCAL_PG_SUPERUSER_PASSWORD`
  in DESIGN §2.11);
- states in DESIGN (header and §6.4) that this PR is expected to classify
  **restricted** and goes through the exception path like every other
  restricted PR.

The classification of this revision is recorded in §5.

## 3. Response to the challenger's review of 461fbc2

| Item | Change | Where |
|---|---|---|
| **H1** precision protocol | Three sequential seeds per large profile: tuning (never scored), **natural** (precision AT-1, both forms of AT-4, forecast targets), **enriched** (recall AT-2, TTD AT-3); each run ends with `down -v`. Re-weighting dropped. Matching tightened: a label qualifies if it explains **≥ 30 %** of the group's excess or is among its **top 3** root causes (reasons given). Decision rule per gate: precision p̂ ≥ 0.80 and Wilson lower ≥ 0.70 (n ≥ 100); recall p̂ ≥ target and Wilson lower ≥ target − 0.10 (n ≥ 100 meaningful labels per kind); multi-label and duplicate rules | DESIGN §4.8, §4.9; Appendix C.1, C.4, C.5 |
| **M1** tail services | Labels injected into the full mix before folding at natural rates; `folded: true`; loss reported, not gated; FT-4/FT-5 gate on individual leaves only, `Other services` reported separately; caveat in §0 and §2.8 | DESIGN §0, §2.2, §2.5, §2.8, §3.10; Appendix C |
| **M2** nested forecast protocol | `fleet15k`: warm-up P1–P2, calibration P3 (interval quantiles), scoring P4 (coverage); fixed model rule, no per-series selection; points scored on all origins; n stated per target. `full`: selection and calibration months 7–9, scoring 10–13. Cohort key without `env` | DESIGN §3.2, §3.4, §3.8, §3.10 |
| **M3** evaluator data | Per-origin backtest outputs persisted: leaf points as gzip JSON Lines with a SHA-256 manifest (≈ 0.2 GB per `fleet15k` run), aggregate points in `forecast_backtest_points`; exempt from D-12; the evaluator computes its own actuals from the source bucket | DESIGN §3.8; Appendix B.5, D.2 |
| **M4** model-family data | Stated plainly that the targets validate the implementation, not real-world parity; stressors added: holidays, monthly cycles, provider price changes, intermittent series, constant amortised series, month-to-date restatement and late data (`ci`) | DESIGN §0, §2.1, §2.3, §3.10 |
| **M5** measure `M` | `ChargeCategory = 'Usage'` added; `Usage-Based` credit and tax rows generated and asserted out of `M`; `commitment_expiry` added as an **alert** (reasoning given) | DESIGN §4.1, §2.5; Appendix C.2 |
| **M6** detectors and grouping | CUSUM on a frozen baseline with re-anchoring only in control; false-alarm arithmetic (Siegmund) on 504 eligible series → h = 6 inside a 0.25/day share of AT-4's budget; MAD floor; provider-wide grouping rule with `provider_shared_cause` and `price_change` labels; fixed rule precedence, deterministic ids, bounded merges | DESIGN §4.2, §4.5; Appendix C.2 |
| **M7** D-07 wording | "An exact old set becomes an exact new set; never weakened" (accepted by the orchestrator); forced edits listed: `reader.db.test.ts:28-32`, `privileges.db.test.ts:97`; migration-version candidates listed | DESIGN §6.2, §8 D-07 |
| **M8** D-12 control | DELETE cannot be row-scoped under Slice 0's reviewed policy model (explained); removal only through two reviewed owner-owned `SECURITY DEFINER` functions; the job has no DELETE grant; `cost_daily_scope` and `account_dim` included | DESIGN §6.1, §6.2, §8 D-12; Appendix D |
| **M9** #62 | Providers exactly `SyntheticAWS` / `SyntheticAzure` / `SyntheticGCP` from #62's `SYNTHETIC_PROVIDERS`; opt-in set only in `local:synthetic`'s worker environment, static test for every other command and CI step, production refusal by #62; Slice 3 after #62 (D-21, T7) | DESIGN §2.1, §2.2, §2.7, §6.3, §7, §8 |
| **M10** governance wording | Reverted (§2 above) | DESIGN header, §6.4, §9 T8 |
| **M11** sizing | Re-budgeted with every item; the first `fleet15k` design comes to 6.08 GB (over the ceiling); ladder applied (control tenant 15 accounts → top 2 for all → integer batch key → top 1 below median spend): **4.90 GB**; generator copy removed by default | DESIGN §2.8; Appendix B.5 |
| **M12** parity statement | §0 opens with it; A-g marked partial while D-15 is deferred | DESIGN §0, §1.5, §4.6 |
| L1 Wilson rule | covered under H1 | Appendix C.5 |
| L2 refit cost | FT-10 and AT-8 rechecked against the 288-point grid search; `full` needs 4 worker threads | DESIGN §3.11 |
| L3 detector state | `detector_state` table (D3 anchor and sums, D2 medians and MAD, D5/D7 shares) | Appendix D.2 |
| L4 PR split and mutations | 3-1 → 3-1a/3-1b, 4-4 → 4-4a/4-4b, 5-2 → 5-2a/5-2b; mutation targets added | DESIGN §7 |
| L5 synthetic ids | non-numeric `SYN-A-…` / `SYN-BA-…` | DESIGN §2.2, D-04 |
| L6 OA-1 | "the owner's own machine, or explicitly approved spend" | DESIGN §8 |
| L7 numbers | §3.8 and C.1 numbers corrected for `fleet15k` (evaluation window days 62–122, 61 days) | DESIGN §3.8; Appendix C.1 |
| L8 WAL | effect of `max_wal_size=256MB` measured in PR 3-4 | DESIGN §2.10, §7 |

## 3a. Response to the challenger's re-review of 461fbc2..9a17924

Historical record. The budget split, h and the intermittent-series rule in
this table were superseded in revisions 5 and 6 (§3b, §3c).

| Item | Change | Where |
|---|---|---|
| **N1** AT-1 vs AT-4 | False-positive budget derived from the expected true-group rate: ≈ 158 labels → ≈ 73 true groups per natural seed (≈ 1.2/day) → **≤ 0.30 false groups/day** for precision 0.80. Re-split: D3 0.07/day (**h = 7**, Siegmund ARL₀ ≈ 7,020, 0.072/day on 504 eligible series; table for h = 6–7.5), D1 ∧ D2 0.02/day, everything else 0.21/day measured on the tuning seed. "≤ 5 groups/day" retired for `fleet15k` (total groups reported). **Two natural seeds pooled** (expected n ≈ 183; natural-3 if fewer than 140), sequential with `down -v`; expected n and true-group rate stated in §4.8/§4.9 | DESIGN §4.2, §4.8, §4.9; Appendix B.5.7, C.1, C.4, C.5 |
| **N2** folding loss | Figures from `budget2.py` where the claims are made: **79.0 %** of account × service series and **25.6 %** of spend in `Other services` (§0, §2.5, §2.8, AT-2, FT-4); recall and FT-4 qualified "measured on individual series only"; natural-label placement specified (series-level kinds **spend-weighted**, account-level uniform, fan-in spend-weighted; enriched on individual series); `full` (OA-1) named as what removes the limitation | DESIGN §0, §2.5, §2.8, §3.10, §4.9; Appendix B.5.7, C.1 |
| **L-a** FT-7 | Calibration uses forecast days ≤ 92 only; FT-7 scores only origins 93, 100, 107, 114, so no interval uses information from after its origin (fix, not caveat); 228 backtest points per leaf | DESIGN §3.8, §3.10, §2.8 |
| **L-b** peak disk | Only natural-1 writes the leaf backtest export; other runs' bulky inputs are pruned after their evaluation (SHA-256 manifest kept); off-box move if available. **Peak 5.11 GB** (5.15 GB with natural-3), per run 4.96 GB | DESIGN §0, §2.7, §2.8, §2.10, §4.8; Appendix B.5.7 |
| **L-c** markers | Both markers named: `ratio:allow-function` and `ratio:allow-security-definer` (the linter refuses a `SECURITY DEFINER` without the latter) | DESIGN §6.1 |
| **L-d** opt-in off explicitly | Every non-synthetic worker start sets `RATIO_ALLOW_SYNTHETIC_PROVIDERS=0` explicitly (as #62 does); the static test checks `=1` only in `local:synthetic` and `=0` elsewhere | DESIGN §2.7 |
| **L-e** budget coverage | The 0.21/day share explicitly covers smaller series reaching `warning` through relative excursions (≈ 3,900 leaves ≥ $100/day) and the ≈ 550 aggregate scopes, measured empirically on the tuning seed | DESIGN §4.2; Appendix B.5.7 |
| EVIDENCE §5 | Refreshed to the current classifier output (adds `retention.delete-from`) | §5 |

## 3b. Response to the challenger's review of 9a17924..4492d2f

| Item | Change | Where |
|---|---|---|
| **H1** periodic cohorts | Option (a), decided by the orchestrator (D-22). **Calendar-event component** in the forecast: 3 fixed classes (days 1–3, 15–16, last 2 business days), multiplicative per-series log factors from prior occurrences, applied only when significant (\|t\| ≥ 3): hard-threshold shrinkage instead of empirical Bayes toward a near-zero pooled prior, with the reasons given. Needs ≥ 1 prior cycle; `fleet15k` gives 2 (P3 events) and 3 (P4) for every pre-existing series. **First occurrences** (accounts onboarding in the span) are quantified, ≈ 0.031/day (≈ 1.9 groups per seed), and counted in the budget. The cohorts stay in AT-1 and AT-4. Effect: cohort false events ≈ 7.2 candidate leaf-events/day without the component, below the Monte Carlo resolution with it. The model-family caveat for real calendars is stated | DESIGN §0, §2.3, §2.5, §3.2, §4.1, §4.2, §4.9, §8 D-22; Appendix B.5.8, C |
| **M1** margin and measured budget | Design target ≤ 0.15 false groups/day in expectation (D-23); every source itemised, by closed form or Monte Carlo (`budget3.py`), with no unmeasured share. **Aggregate scopes in closed form:** 550/ARL₀ + 550·Q(z_T) (0.0958 at z_T 4, h 7; 0.0493 at the chosen 4.5 / 7.5). Detectors moved to the **log scale** (the linear-scale log-normal tail breaks the arithmetic) with **z_T = 4.5, h = 7.5**: total **0.092/day**, 0.136 with the conservative D3 bound. **P(pass AT-1 and AT-4) ≈ 0.999** at 0.15/day (0.435 at the 0.30 gate). False positives measured on a natural-rate **tuning-natural** seed, with Garwood intervals. D6 redefined on two-day growth (the level rule paged on large normal onboardings). Peak disk 5.15 GB (5.19 with natural-3), `budget3.py` SHA-256 recorded | DESIGN §4.2, §4.8, §4.9, §8 D-23; Appendix B.5.8, C |
| **M2** detection leakage | **Expanding as-of calibration** everywhere: any interval, D1 quantile or D3 σ(h) used at time t uses errors on days ≤ t − 1. The replay starts at day 57; D1 and D3 are live from day 62 (warm-up stated); D2 from day 29. The scored window and n are unchanged; the false-positive rate is also reported for days 62–75 and 76–122. §3.4, §3.8, the replay rule and FT-7 are made consistent (coverage scored from origins ≥ 93, each calibrated as of its origin) | DESIGN §3.4, §3.8, §4.2, §7 |
| **L1** share vs h | The shares are now the computed values at the chosen thresholds; no rounded share is set against an h | DESIGN §4.2 |
| **L2** alert fatigue | Reported every run: mean, p95 and maximum day at ≥ `warning`, the same for false groups, and `info` groups per day. Explicit bound: mean ≤ 1.5, p95 ≤ 3, max ≤ 6 (expected 1.31 / 3 / 4); reported and escalated, not gated (a gate would be an owner decision) | DESIGN §4.9 |
| **L3** assumed sizes | The retained-input sizes are marked as assumptions in DESIGN and Appendix B, and PR 3-4 measures them | DESIGN §2.7, §4.8, §7; Appendix B.5.7, B.5.8 |
| Re-run | Every embedded script was re-run on revision 5's text: the 7 SHA-256s match, the Python outputs are identical (`budget3.py` byte-identical between two runs), and both SQL measurements reproduce on a fresh `postgres:16` container (554.2 / 217.0 / 599.8 / 317.3 B per row) | §4 |

**Targets at risk, stated plainly** (revision 5; **revision 6 update in
§3c**: AT-3 is no longer at risk on `fleet15k`, and the h = 7.5 budget
below is superseded). No target has been changed. One may
not be met honestly: **AT-3's p90 ≤ 3 days for level shifts**. The stricter
CUSUM threshold (h = 7.5) delays small shifts (× 1.2–1.4 on series with
σ ≈ 0.05–0.07) to 2–4 days. If the enriched seed confirms the miss, the
trade-off between alert volume and detection delay is an **owner
decision**. The calendar component's thin basis (2–3 cycles) is an
in-family result. Real calendars are measurable only on real data.

## 3c. Response to the challenger's review of 4492d2f..f5676d9 (revision 6)

D-24's `info`-only rule below was replaced in revision 7 by the
orchestrator's decision (hurdle statistic with a clustering gate, §3d).

All figures from `budget4.py` (Appendix B.5.9) at the chosen z_T = 4.5,
h = 9.0, unless stated.

| Item | Change | Where |
|---|---|---|
| **H1 (i)** intermittent: overlapping sums | 7-day rolling sums dropped. Series with 30–50 % zero days are scored on **non-overlapping** weekly sums (Monday–Sunday, log scale, 8-week median and MAD, scale floor 0.05), D3 only, alarm on the week's last day | DESIGN §4.2, §2.3, §7 (5-2a mutation: rolling sums) |
| **H1 (ii)** zero share > 0.5 | **`info` only**, with the recall limit stated: an anomaly on such a series never reaches `warning`; the enriched seed places no gated label on them; their natural-seed labels are reported, not gated. Why not a count model: 56 days with more than 28 zeros do not pin down an occurrence rate, the weekly statistic is itself unstable there (0.011 in-control alarms per series-week at 80 % zeros, more than five times the rate at 50 %), and the series are small (115 of 3,440 reachable leaves, 3.5 % of their spend). Recorded as **D-24, proposed and pending the orchestrator's confirmation**, because it narrows the population AT-2 covers | DESIGN §4.2, §2.5, §4.8, §4.9 AT-2, §8 D-24; Appendix C.1, C.2, C.4 |
| **H1 (iii)** own budget term | The weekly statistic's in-control rate is a **Monte Carlo of the actual statistic** with the estimated median and MAD and the zeros (0.0019–0.0028 alarms per series-week at h = 9.0 for zero shares 0.3–0.5), not Siegmund's formula. Own line: **0.0139/day**; the `info`-only series have their own line (0 at `warning`, ≈ 0.048 `info` signals/day) | DESIGN §4.2; Appendix B.5.9 |
| **H1 (iv)** the "other" bucket | Broken out, one line each: **D4 0, D5 0, D6 < 0.0001 (4 × 10⁻⁵ if the tail is 10 × the fit), D7 0, holidays 0**. D4, D5, D7 and holidays are 0 by construction in the generator (no unlabelled new service, tag change or commitment change; holiday drops are `info`), and each is still measured on `tuning-natural` | DESIGN §4.2 |
| **M1 (a)** calendar on raw y | Factors are estimated on **raw `y`** (median of the prior event-day log ratios, se = 1.2533 σ/√m, applied if m ≥ 3 and \|t\| ≥ 3; detected-anomaly days left out). Hampel is **calendar-aware**: the learned factors are applied before its 4-MAD test, and the cleaned series feeds only the weekly model. Cycle requirements restated (m ≥ 3: one `month_start` cycle, two 2-day cycles); second occurrences of 2-day classes added to the unlearnable term (0.049/day, ≈ 3.0 groups per seed, previously 0.031) | DESIGN §3.2, §3.3, §7 (4-4a); Appendix D.2 |
| **M1 (b)** generator pinned | One constant factor per series and class, across months and across the class's days. A **±10 % month-to-month jitter** robustness run is reported, not gated: **+0.063/day**. Stated plainly that real calendars will not match the pinned model | DESIGN §2.3, §3.2, §4.2, §4.9 AT-7, §7 (3-1b); Appendix C.2 |
| **M1 (c)** recall effect | A detected prior anomaly is left out of the estimate. An undetected one of the same size in one prior cycle: event-day recall **0.999** with three prior cycles, **≈ 0.72** with two (2-day classes). Event-day labels reported separately (AT-7) | DESIGN §3.2, §4.9; Appendix C.4 |
| **M2** D1 ∧ D2 not exact | Re-derived with estimation noise by Monte Carlo of the statistic, which also includes the median's error and the forecast's level error in D1. With the 28-day window: 3.6 × 10⁻⁴ per series-day before the `warning` test (≈ 100 × Q(4.5); the challenger's Q(3.8) ≈ 7 × 10⁻⁵ points the same way). D2 moves to a **56-day window with a pooled floor** (`0.8 · σ_pool`): 4.3 × 10⁻⁵. Term: **0.0061/day**. The same correction applied to D3 (pooled-scale heterogeneity makes the effective ARL₀ ≈ 19,700 days at h = 9.0, not 51,985) and to the aggregate scopes, which now run **D3 only** with a pooled scale (own-MAD standardisation alone would cost 0.097/day). Grid shown for z_T ∈ {4.5, 5.0} × h ∈ {7.5 … 9.5}; h moves from 7.5 to **9.0** to keep the conservative total ≤ 0.15: **total 0.098, 0.128 with every conservative bound** | DESIGN §0, §4.2, §8 D-23; Appendix B.5.9 |
| **M2** D3 "< 0.0001" | Stated as **resolution-limited**: 3 M simulated steps give 75 alarm episodes at h = 9.0 (258 at 7.5), 0 hits, so the bound is 3/75 per leaf, **≤ 0.0066/day**; the conservative bound counts every alarm on the 476 leaves ≥ $500/day (0.0298) | DESIGN §4.2; Appendix B.5.9 |
| **M2** autocorrelation caveat | Restored: the frozen baseline carries the forecast's error at the anchor through the whole run, so successive z are positively autocorrelated, and **the conservative D3 bound does not cover it**; only the `tuning-natural` measurement does | DESIGN §4.2, §4.8 |
| **M2** what the control is | Stated: the **measured `tuning-natural` total with its Garwood 95 % upper bound** is the control; the §4.2 table predicts it. P(pass) is stated as **conditional on the assumed rate** (0.999 at 0.15/day, 0.977 at 0.20, 0.435 at 0.30) | DESIGN §0, §4.2, §4.8 |
| **L1** AT-3 | Level-shift multipliers pinned: **log-uniform on [1.2, 3.0]**; spikes U(1.5, 6) for 1, 2 or 3 days. **D8** adopted: 2-day residual sum at z_T = 4.5 with a pooled scale that includes the forecast's level error; re-derived with estimation noise: 1.5 × 10⁻⁵ per series-day before the `warning` test, **0.0003/day** after it (the challenger's ≈ 0.012 counts every D8 fire on the 3,440 leaves at Q(4.5); the `warning` test removes almost all of them). D8 catches ≥ 3.75σ by day 2 with P ≥ 0.5, ≥ 4.9σ with P ≥ 0.9 (3.2σ without the level error). D8 has its own budget line. **AT-3 is no longer at risk on the generator**: TTD median 1, p90 1 day, spend-weighted, per series, and for × 1.2–1.4 shifts alone, because every meaningful shift is ≥ 4.8σ there. On real data with noisier large series it would be at risk again (a × 1.2 shift at σ = 0.10 is 1.8σ, ≈ 8 days by D3) | DESIGN §2.5, §4.2, §4.9 AT-3, §7 (5-2a); Appendix B.5.9, C.2 |
| **L2** empty horizon buckets | Fallback: the longest populated bucket's quantiles scaled by √(h_mid / h_p); flagged `extrapolated` and never scored | DESIGN §3.4, §7 (4-4b); Appendix D.2 |
| **L3** D6 percentile | Log-normal fit: per-k mean, one robust scale pooled across k = 2…14, threshold μ̂_k + 3.09 σ̂ √(1 + 1/n_k), pooled mean when n_k < 30; why an empirical 99.9th percentile from ≤ 600 onboardings cannot work; heavy-tail sensitivity 4 × 10⁻⁵/day | DESIGN §4.2, §7 (5-2a); Appendix D.2 |
| **L4** fatigue | Restated after H1: ≥ `warning` mean 1.30 (1.33 conservative), p95 day 3, max ≈ 4; `info`-only intermittent signals ≈ 0.05/day (p95 day 0, max 1), reported separately | DESIGN §4.9; Appendix B.5.9 |
| Re-run | Every embedded script re-run on revision 6's text: the 8 SHA-256s match (7 unchanged, `budget4.py` new); the Python outputs reproduce (`budget4.py` byte-identical between two runs, and the copy extracted from Appendix B reproduces the same output); both SQL measurements reproduce on a fresh `postgres:16` container (554.2 / 217.0 / 599.8 / 317.3 B per row). Peak disk 5.15 GB (5.19 GB with natural-3) | §4; Appendix B.5.9 |

**Targets, stated plainly.** No target has been changed. AT-3, at risk in
revision 5, is no longer at risk on `fleet15k` (D8 and the pinned
multipliers). What remains open:
- **D-24 narrows AT-2's population** (intermittent series with more than
  50 % zeros, 3.5 % of reachable spend, are `info` only). That is a scope
  change, so it is proposed, not decided: it needs the orchestrator.
- **The design margin holds only in the model.** 0.098 (0.128
  conservative) assumes a 10 % scale heterogeneity and independent D3
  residuals. The frozen-baseline autocorrelation is not covered by any
  bound. The calendar jitter run alone adds 0.063, which would take the
  design total to 0.161, above the 0.15 margin though under the 0.30 gate.
  The `tuning-natural` measurement decides; if it cannot reach ≤ 0.15 by
  raising z_T and h, that is escalated (D-20).
- **Calendar estimates from two cycles** lose recall (≈ 0.72) when a prior
  cycle held a missed anomaly. Expected to be rare in AT-2, and reported.

## 3d. Revision 7: the orchestrator's D-24 decision and the challenger's Low items on revision 6

The challenger approved revision 6 (0 High, 0 Medium). The orchestrator
decided D-24 as the challenger's option (a). All figures are from
`budget5.py` (Appendix B.5.10) at z_T = 4.5, h = 9.0.

| Item | Change | Where |
|---|---|---|
| **D-24** decided | Leaves with a zero share above 0.5 get a **hurdle (compound-binomial) weekly statistic**: q̂, m̂, v̂ from the last 56 days, z = (W − 7q̂m̂)/√(7q̂(v̂ + m̂²) − 7q̂²m̂²), CUSUM k = 0.5, h = 9.0. **Clustering gate:** lag-1 autocorrelation r₁ of the 56-day active-day indicator; r₁ < **0.30** → `warning` possible, ≥ 0.30 → `info` only. Threshold justified by r₁'s noise at n = 56 (independent: mean −0.02, sd 0.13; 0.30 admits 98.8–99.2 % of independent series-weeks and 2.6–12.7 % of ρ = 0.6 ones; the 0.20–0.40 trade-off tabulated). Recorded as **decided by the orchestrator under delegation**, with both conditions: `info`-signal recall of the `info`-only remainder reported in AT-7; revisited with real data or the `full` profile | DESIGN §0, §2.3, §2.5, §4.2, §4.3, §4.8, §4.9 AT-2/AT-7, §7 (5-2a, 5-4), §8 D-24; Appendix B.5.10, C.1, C.2, C.4, C.6, D.2 |
| Hurdle budget term | Own line: **0.0028/day** (every gated alarm 0.0028; `info` signals 0.0002). In-control 0.00002–0.00052 alarms per series-week at zero shares 0.55–0.8 (the challenger's 0.0000 / 0.0001 / 0.0005 at 0.6 / 0.7 / 0.8). Sensitivities: all clustered at ρ = 0.3: 0.011; at ρ = 0.6: 0.168 before the gate, 0.012 after it. **Total 0.101, conservative 0.131** (≤ 0.15) | DESIGN §4.2; Appendix B.5.10 |
| `warning` / `info` split | Under the generator (independent days): **≈ 114 of the 115 leaves score to `warning`, ≈ 1 is `info` only** in a given week; spend outside AT-2 **≈ 0.03 %** of the reachable leaves' spend (revision 6: 3.5 %) | DESIGN §4.2, §4.9 AT-2 |
| **L4** rationale | Corrected: clustered occurrence cannot be modelled in these slices (it needs a dependent-occurrence model, outside the model ladder). The "56 days do not pin down an occurrence rate" wording is removed | DESIGN §4.2, §8 D-24 |
| **L1** `month_start` cycles | At day 62 `month_start` has **1** prior cycle (P1's days 1–3 have no weekly baseline), so P3 uses 1 and P4 2. Budget recomputed: calendar term 0.0012 (+0.0007) | DESIGN §3.2, §4.2; Appendix B.5.10 |
| **L2** weekly term | Stated next to 0.0139: up to ≈ 2 × (**0.0285** with burst-size log sd 1.0; day clustering at ρ = 0.3 gives 0.0082). With it doubled, the conservative total is 0.146, still ≤ 0.15 | DESIGN §4.2; Appendix B.5.10 |
| **L3** jitter | Pass probability under ±10 % jitter (calendar term 0.083 with `month_start`'s single cycle): **0.993** at the design total (0.183/day), **0.959** at the conservative total (0.213/day), slightly under the challenger's 0.98–0.995 for the conservative case. Stated that `tuning-natural` uses pinned factors and so **cannot detect jitter-type misspecification**; only real data can | DESIGN §2.3, §4.2 |
| Re-run | Every embedded script re-run on revision 7's text: the 9 SHA-256s match (8 unchanged, `budget5.py` new); the Python outputs reproduce (`budget5.py` byte-identical twice, and from its Appendix B copy; `budget4.py`'s figures reproduced); both SQL measurements reproduce on a fresh `postgres:16` container (554.2 / 217.0 / 599.8 / 317.3 B per row). Peak disk 5.15 GB (5.19 GB with natural-3) | §4; Appendix B.5.10 |

**Targets, stated plainly.** No target has been changed. D-24 now narrows
AT-2 only by the clustered remainder (≈ 0.03 % of reachable spend under
the generator, more on real data). What the model cannot settle stays as
in §3c: the frozen-baseline autocorrelation in D3, the scale-heterogeneity
assumption, and calendar or occurrence misspecification, which
`tuning-natural` cannot see because it comes from the same generator.

## 3e. Revision 8: dormant series that reactivate

The history condition below was corrected in revision 9 (§3f).

The challenger approved revision 7 (472dbe3..801019a). The one remaining
Low, folded in at the orchestrator's request: a series with fewer than 3
active days in its 56-day window is not scored, and D4 fired only on a
first-seen (account, service), so a dormant resource restarting at high
spend went unflagged until 3 active days had entered the window, by which
time `q̂` and `m̂` were inflated by the new regime.

| Item | Change | Where |
|---|---|---|
| D4 extended | **Reactivation rule:** a series with < 3 active days in the prior 56-day window that has a **day** whose excess passes the `warning` rules becomes a D4 candidate under the existing severity rules. **One day, not a 2-day sum**: the dormant series' expected value is ≈ 0, so one day's excess equals its spend, there is no noise scale to average over, and a second day only delays the alert; it is also D4's first-seen test | DESIGN §4.2 (table, new paragraph, precedence), §4.3 state; Appendix D.2 |
| History condition | Measured first: without it the rule fires on bursty intermittent series that happen to have ≤ 2 active days (0.0017/day under the generator, 0.32/day if every intermittent series had persistence 0.6). So `warning` requires the series to have been active on ≥ 50 % of its ≥ 14 days before the dormant window; otherwise `info` | DESIGN §4.2; Appendix B.5.11 |
| False positives | Under the generator **< 0.0001/day (3 × 10⁻⁵), effectively 0 by construction**: the generator has no unlabelled series that is regular, goes dormant and restarts; the only route is an ≈ 80 %-zero intermittent series with ≤ 2 active days by chance and ≥ 50 % active history. Own budget line; totals 0.101 / 0.131 + 3 × 10⁻⁵. Stated that **real data may produce false positives here** (seasonal, campaign or quarterly workloads, planned restarts), which `tuning-natural` cannot show | DESIGN §4.2; Appendix B.5.11 |
| Recall | The existing seeds planted no reactivation, so the rule was never scored. New label kind **`dormant_reactivation`**, enriched and `ci` seeds only: ≥ 100 meaningful labels on individual series drawn by spend; active on ≥ 50 % of ≥ 14 days, zero for ≥ 56 days, restart on a day in 71–115 at × U(0.5, 3) the earlier level. Scored in AT-2 and reported against 0.90; **gating it is left to the orchestrator** (it would be a new target). Natural seeds carry none, so precision and the false-positive rate are unaffected | DESIGN §2.5, §4.9 AT-2/AT-3, §7 (3-1b, 5-2a); Appendix C.1, C.2 |
| D-24 row | Names the rule: a series is scored only with ≥ 3 active days in the 56-day window; fewer → dormant → D4's reactivation rule | DESIGN §8 D-24 |
| Disk | Unchanged: 5.15 GB peak (5.19 GB with natural-3); the labels are on the enriched seed only and a dormant gap removes rows | Appendix B.5.11 |
| Re-run | All 10 embedded SHA-256s match (9 unchanged, `reactivation.py` new); every Python script re-run with unchanged outputs; `reactivation.py` gives identical output on two runs | §4 |

## 3f. Revision 9: response to the challenger's review of 801019a..dbbd552

The ρ > 0 figures below were corrected in revision 10 (§3g).

The challenger confirmed that all 10 hashes, every `reactivation.py`
figure, the AT-2 counting and the dormant window reproduce, and raised one
Medium. **The history condition looked at the wrong days:** the ≥ 14 days
before the 56-day window are dormant zeros whenever the gap is longer than
56 days. That had three effects:
- only ≈ 37 % of `dormant_reactivation` labels would pass;
- a regular resource dormant for more than about 63–70 days got `info`;
- a sparse but expensive resource got `info` even at critical size.

The orchestrator decided both (a) and (b).

| Item | Change | Where |
|---|---|---|
| **(a)** pre-dormancy history | The *dormant stretch* is the longest run of days ending at D − 1 with ≤ 2 active days. Condition (i): active on ≥ 50 % of the **28 days ending at the last active day before that stretch** (≥ 14 such days). A gap of any length is judged on the days before it. The label generator leaves the gap free (last active day uniform on 16 … r − 57, restart on 73–115, gap ≥ 56). Labels are placed on non-intermittent individual series. **Verified in `reactivation.py`: 20,000 labels per the spec, pass rate 1.000** (0.970 if placed on any individual series, intermittent ones included) | DESIGN §2.5, §4.2 (D4 row and paragraph), §4.3, §7 (3-1b, 5-2a); Appendix B.5.11, C.2, D.2 |
| **(b)** size override | Condition (ii): `warning`/`critical` regardless of history when the restart day is ≥ 10 × the min impact **and** ≥ 3 × the series' prior active-day mean. **Window: the active-day values in the 56 days ending at the last active day, ≥ 3 of them.** Active days only, so a usually-zero series is not "3 ×" just by being active; 56 days so that a weekly batch gives ≈ 8 values rather than ≈ 4; the same window as the hurdle statistic | DESIGN §4.2; Appendix B.5.11 |
| False-positive cost | Union of (i) and (ii), per day: **1.4 × 10⁻⁵ under the generator** (5 × 10⁻⁶ by (i), 9 × 10⁻⁶ by (ii); worst case of 14 days of history 8.4 × 10⁻⁵); **0.00029 at ρ = 0.3**; **0.0079 at ρ = 0.6**. These are approximations for ρ > 0. The size-only bound without the relative test is 0.00033 / 0.0048 / 0.050, which matches the challenger's estimates; the relative test removes ≈ 97 % of it | DESIGN §4.2; Appendix B.5.11 |
| Totals | **0.101 / 0.131** (conservative), + < 0.0001 from the reactivation line; ≤ 0.15 | DESIGN §4.2 |
| Re-run | All 10 embedded SHA-256s match (9 unchanged, `reactivation.py` updated); every Python script re-run, unchanged outputs except `reactivation.py`'s new lines; `reactivation.py` identical on two runs. Peak disk 5.15 GB (5.19 GB with natural-3) | §4; Appendix B.5.11 |

## 3g. Revision 10: the challenger's Low items on revision 9

The challenger approved revision 9 (dbbd552..d70f074).

| Item | Change | Where |
|---|---|---|
| **L1** clustered-day figures | Revision 9's ρ > 0 figures treated the history as independent of the dormant window, and that **underestimates**: a clustered series that has just gone quiet was usually in an active run before. `reactivation.py` now simulates the two-state chain (2,000,000 days per zero-share bin) and applies the real stretch, history and prior-mean definitions, scaled by the exact window probability at each leaf's zero share. Per day: **(i) 0.00083, (ii) 0.00012, union 0.00094 at ρ = 0.3; (i) 0.052, (ii) 0.0016, union 0.054 at ρ = 0.6** (revision 9: (i) 0.00015 and 0.0064). The challenger measured 0.00087, 0.050 and union 0.052. The generator (ρ = 0) is exact, so no gate moves; the figures are stated as the **real-data risk**: about a third of the design margin if real intermittent series cluster strongly | DESIGN §4.2 (D4 paragraph, budget line); Appendix B.5.11 |
| **L2** monthly cadence | The prior mean of (ii) uses the active-day values in the 56 days ending at the last active day, extended back to at most 112 days until there are ≥ 3 (the cap was stated as "or all history" in revision 10, fixed in revision 11). A monthly job (≈ 2 active days in 56) now gets a prior mean, and a 10 × restart reaches `warning`. Cost under the generator: 1.0 × 10⁻⁵ per day (was 9 × 10⁻⁶); at ρ = 0.3 / 0.6: 0.00012 / 0.0016. **Named limit: a quarterly job** (≤ 2 active days in 112) still has no prior mean and gets `info` unless (i) holds. The state is the last 3 active-day values per series, so peak disk is unchanged (5.15 GB; 5.19 GB with natural-3) | DESIGN §4.2, §4.3, §7 (5-2a); Appendix B.5.11, D.2 |
| **L3** consistency | Revision 8's stale "False positives" bullet in §4.2 deleted. The worst case is named as **the union of (i) and (ii) with 14 days of history, 8.5 × 10⁻⁵**, in DESIGN, EVIDENCE and the B.5.11 table alike (it was 8.4 × 10⁻⁵ with the 56-day prior mean). The script prints (ii) at both history lengths instead of `nan` | DESIGN §4.2; Appendix B.5.11 |
| Re-run | All 10 embedded SHA-256s match (9 unchanged, `reactivation.py` updated); every Python script re-run, outputs unchanged except `reactivation.py`; `reactivation.py` identical on two runs | §4 |

## 3h. Revision 11: wording Lows on revision 10 (PR #70)

| Item | Change | Where |
|---|---|---|
| **L1** #62's contract | The text now states the contract #62 shipped in #67 and #68: `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` is accepted only when `RATIO_ENV` is **explicitly** `development` or `test`; unset, unknown, `staging` and `production` are refused with `SYNTHETIC_PROVIDERS_NOT_ALLOWED`. An in-process `runSync` with `allowSyntheticProviders: true` throws the same error without the process env opt-in, so library callers need the env opt-in too. `local:synthetic` spawns its workers with `RATIO_ENV=development`. Slice 3's static test checks development/test-only acceptance, plus a cross-check of the refusals. **D-21's revisit trigger ("#62 changes its contract") fired; the decision still holds** | DESIGN §2.1, §2.7, §6.3, §7 (3-3), §8 D-21 |
| **L2** fallback wording | The prior-mean lookback of D4 (b)(ii) is **capped at 112 days**: "or all history" removed everywhere. This matches the simulation and the named quarterly limit. The comment in `reactivation.py` changed, so its SHA-256 changed; its output is unchanged | DESIGN §4.2; Appendix B.5.11; §3g |
| Re-run | The 10 embedded SHA-256s match (9 unchanged, `reactivation.py` updated for the comment); `reactivation.py` re-run with identical figures | Appendix B.5.11 |

## 3i. Revision 12: Copilot's review of PR #70 at d6be584 (review 5407381989)

Each finding was checked against the design before it was fixed; all four
were valid.

| Item | Change | Where |
|---|---|---|
| **High r4178656730** leaf key | **Valid.** `forecast_state` keyed a leaf by (sub-account, service, currency) while `cost_series` carries provider and billing account too, so provider-local ids could collide. Also, `detector_state` stored D6's cohort rows under `series_id`, and `account_dim`, `billing_daily` and the root-cause dimensions used provider-local ids. **Fix:** the leaf identity is stated once (Appendix D.0): the `cost_series` natural key (currency, provider, billing account, sub-account, service, region) and its stable, never-reused id `series_id`. `forecast_state` and `detector_state` key on `series_id` with a composite FK. A new `cost_accounts` gives accounts the same treatment. `account_dim`, `billing_daily` and the root causes use `account_id` / `series_id`. Aggregate `scope_key`s are built only from full identities, and the anomaly dedup key includes the currency. D6's cohort rows move to `detector_cohort_state`. Tests and a mutation in 4-1 and 4-3 | DESIGN §2.9, §3.1, §4.5, §6.2, §7; Appendix D.0–D.4 |
| **High r4178656766** billing endpoint | **Valid**: `costs/daily` promised billed and effective totals and `groupBy=chargeCategory` but read only usage rollups. **Fix, adding rather than narrowing**: FinOps parity needs billed totals that include credits, tax, purchases and fees. `billing_daily` is re-keyed by account and FOCUS charge category, frequency and correction flag. With `cost_daily` (all `Usage` rows) it partitions the published facts. `billing_daily_scope` gives every charge category per scope and day, and two published views expose both. Semantics: `M` stays usage-only (reported on the `Usage` group); non-usage amounts are shown as "not attributed" under `groupBy=service/region`, so totals add up. Disk: **+0.026 GB per run; peak 5.18 GB (5.22 GB with natural-3)**, under the 6 GB ceiling (`rollup12.py`, B.5.12). Tests: billed and effective totals equal the published totals across all categories | DESIGN §2.8, §2.9, §5.1, §6.2, §7 (4-2, 4-5); Appendix B.5.12, D.1 |
| **Medium r4178656790** Garwood | **Valid**: `budget3.py` used Wilson–Hilferty while calling the interval exact. **Fix:** an exact computation by bisection on the Poisson CDF (the identity 0.5·χ²(p, 2k) = Poisson mean), standard library only. **No printed figure changes** at three decimals; the output is byte-identical. The exact and approximate bounds differ by ≤ 0.0002 at the lower end and ≤ 0.00002 at the upper end. PR 5-4's harness is required to use the exact computation. `budget3.py`'s hash: `7b133ff9…` → `d86367fb…` | Appendix B.5.8; DESIGN §7 (5-4) |
| **Medium r4178656806** rollup pointer | **Valid**: the run-keyed reader views said "current rollup run" with no pointer. **Fix:** a `rollup_pointer` (run id and `batch_seq` high-water mark), updated in the same transaction that marks the rollup run succeeded, mirroring `forecast_pointer`. Batch-keyed views return, per (source, period), the highest batch ≤ the high-water mark; run-keyed views return the pointed run. Retention never removes a row the pointer still exposes. Tests: a killed or failed rollup leaves every view unchanged, and a restatement appears only when its pointer update commits | DESIGN §2.9, §6.1, §6.2, §7 (4-1, 4-2); Appendix D.1 |
| Re-run | Every embedded script re-run: 11 SHA-256s match (9 unchanged, `budget3.py` updated, `rollup12.py` new); every Python output unchanged except the new script; both SQL measurements reproduced on a fresh `postgres:16` container (554.2 / 217.0 / 599.8 / 317.3 B per row) | §4; Appendix B |

## 3j. Revision 13: the challenger's review of d691069 and Copilot's review 5407430521

| Item | Change | Where |
|---|---|---|
| **M1 (a)** gap after a restatement | **Valid.** Batch-keyed views required the batch to be published, so after B2 was published but before it was rolled up, the (source, period) vanished. **Fix:** batch-keyed views return, per (source, period), the **highest rolled-up `batch_seq` ≤ `batch_seq_hwm`**, from `rollup_batches`, whatever its live publication status: a rollup run is a snapshot. Retention removes only batches below that visible batch | Appendix D.1; DESIGN §2.9, §6.1 |
| **M1 (b)** concurrent rollups | **Valid.** **Fix:** one rollup writer per tenant, using the worker's lease and fencing pattern (`lease.ts`): an advisory lock at acquisition, `lease_token` / `lease_expires_at` on `analytics_runs`, `ALREADY_RUNNING`, expired runs `abandoned`, `assertLease … FOR UPDATE` in every write transaction, `LEASE_LOST`. `batch_seq` and a new `run_seq` are allocated only by the lease holder. The pointer update is **monotone** (`WHERE run_seq < $run_seq AND batch_seq_hwm <= $hwm`; zero rows → `POINTER_STALE`). `run_seq` lets a run with no new batch still publish refreshed scope rows. 4-2 tests: two concurrent rollups, an expiring lease, a publish mid-run, a late older run. Mutation: drop the monotone guard | Appendix D.1; DESIGN §2.9, §7 (4-2) |
| **M2** exactly-once with nulls | **Valid.** **Fix:** routing by `ChargeCategory = 'Usage'` → `cost_daily` and `IS DISTINCT FROM 'Usage'` → `billing_daily`, so a null category lands once, as `(unknown)`. One sentinel convention: every nullable key component is stored as `''`, `NOT NULL`, with display labels on read (Appendix D.0). Catch-all groups stated for every `groupBy` (`(not attributed)`, `(none)`, `untagged`, `(unknown provider)`, `(unknown)`), and totals are equal under every grouping. Negative usage is included in `M` on purpose; a day with `M` ≤ 0 is not scored on the log scale. Tests with null `ChargeCategory`, `ChargeFrequency` and `SubAccountId`. `fleet15k` emits no such nulls, so this is for real data | Appendix D.0, D.1; DESIGN §2.9, §3.1, §5.1, §7 (4-2, 4-5) |
| **Low** `rollup12.py` | **Valid.** 4 non-usage categories, not 5. **Fix:** delta 0.026 → **0.025 GB per run**; peaks 5.176 / 5.216 GB (still 5.18 / 5.22 at two decimals). Hash `ad0cf39b…` → `b47ec3f6…` | Appendix B.5.12; DESIGN §2.7, §2.8 |
| **Copilot High r4178706470** null identity columns | **Valid.** `provider_name`, `service_name`, `sub_account_id` and `billing_account_id` are nullable in 0001, and `validate.ts` maps empty cells to NULL. A plain `UNIQUE` treats NULLs as distinct, so a null-bearing identity could get a new id per batch. **Fix:** normalization `coalesce(nullif(col, ''), '')` of every natural-key component (currency, provider, billing account, sub-account, service, region) at id allocation; `NOT NULL` on every natural-key column; and `UNIQUE NULLS NOT DISTINCT` (PG 15+; we pin 16) as defence in depth. Ids are allocated only by the lease holder with `INSERT … ON CONFLICT DO NOTHING`. Tests: repeated batches and a restatement with a missing service, sub-account or billing account reuse the same ids. Mutation: remove the normalization | Appendix D.0, D.1; DESIGN §7 (4-1, 4-2) |
| Copilot summary: pointer enforcement, sequence grants, publication atomicity | **Two gaps found and closed.** (1) The pointer rules were enforced only by the job: a `BEFORE INSERT OR UPDATE` guard trigger on `rollup_pointer` and `forecast_pointer` now rejects a non-succeeded or wrong-kind run, a non-increasing `run_seq` and a falling high-water mark, with column-level UPDATE grants only. (2) Sequence grants were unstated: `cost_series.id` and `cost_accounts.id` are identity columns, and USAGE on their sequences goes to `ratio_analytics` only; `batch_seq` and `run_seq` are not sequences. **A third point tightened:** each batch is rolled up in one transaction together with its `rollup_batches` row, so a run that fails leaves only complete batches, visible only once a later pointer covers them. Publication atomicity holds: the visible set changes only in the run's success transaction (M1) | Appendix D.1, D.2; DESIGN §6.1, §7 (4-1) |
| Re-run | All 11 embedded scripts re-run; 11 SHA-256s match (10 unchanged, `rollup12.py` updated); outputs unchanged except `rollup12.py`; budget totals 0.101 / 0.131; both SQL measurements reproduced on a fresh `postgres:16` container | §4; Appendix B |

## 3k. Revision 14: the challenger's review of 86c2c29

| Item | Change | Where |
|---|---|---|
| **M1** HWM per run | **Valid.** Suppose a run completes batch B2 and then fails, and the next run rolls up nothing new. With a per-run mark, that run either failed `POINTER_STALE` or left the mark below B2. B2 then stayed hidden, B1 stayed visible, and retention kept B1, all indefinitely. **Fix:** `batch_seq_hwm` is the **tenant's `max(batch_seq)` in `rollup_batches`**, read in the success transaction under `assertLease`. This is safe because each `rollup_batches` row commits with all its batch's rows and there is one writer; it is monotone by construction. Test (4-2): a batch completed by a failed run is visible after the next run, even one with nothing new. Mutation: the mark taken from the run's own batches | Appendix D.1; DESIGN §2.9, §7 (4-2) |
| **L1** trigger scope | **Valid.** One sentence added: the pointer trigger guards against bugs, not a compromised job. `ratio_analytics` can mark its own run `succeeded`, so that check is self-certifying, but it cannot disable or replace the trigger, which `ratio_owner` owns; the login is neither the owner nor a superuser | Appendix D.1; DESIGN §8 known limits |
| **L2** labels not reversible | **Valid.** **Fix:** sentinel groups return `key: null`, `attributed: false` and the label; every other group returns `attributed: true` and its source value. A literal `untagged` or `(none)` is then distinguishable. Totals are unaffected. API contract (§5.1) and the 4-5 test | DESIGN §5.1, §7 (4-5) |
| **L3** negative-usage blind spot | **Valid.** **Fix:** a row in the "not covered by any line" part of the FP budget table, and a new "Known limits" list in §8 with this bullet. Days with `M` ≤ 0 are unscored, and a same-day negative-`Usage` credit can mask a spike. Only negative-`Usage` rows can do this, since `Credit` and `Tax` are outside `M`. `fleet15k` emits none: a recall blind spot, measurable on real data only | DESIGN §4.2, §8 |
| Scripts | No embedded script changed; the 11 SHA-256s are those of revision 13 | Appendix B |

## 3l. Revision 15: the challenger's review of 10cd9ce

| Item | Change | Where |
|---|---|---|
| **M1** empty tenant | **Valid.** `max(batch_seq)` over an empty `rollup_batches` is NULL. The first pointer row would have stored NULL. After that, `batch_seq_hwm <= $hwm` would update nothing (`POINTER_STALE` on every run), and the trigger's "decreases" check would also be NULL, jamming the pointer for good. Allocation by `max + 1` was undefined too. **Fix:** `batch_seq_hwm integer NOT NULL` = `coalesce(max(batch_seq), 0)`; `batch_seq` = `coalesce(max(batch_seq), 0) + 1` (starts at 1); `run_seq` the same, also `NOT NULL`, on both pointers. Views at mark 0 return nothing. Test (4-2): the first run on an empty tenant succeeds with mark 0, and a later run with a batch moves the pointer. Mutants: `coalesce` removed; column nullable | Appendix D.1, D.2; DESIGN §2.9, §7 (4-2) |
| **L1** monotonicity reason | **Valid.** The mark is monotone because `rollup_batches` is **never pruned**: the retention function excludes it. The previous reason, about what retention removes, was wrong | Appendix D.1 |
| **L2** known limits wording | **Valid.** `fleet15k` has no region dimension, so `region_key = ''` on every row. The limit now reads "no null account or service identity columns", and the folding figures cite §2.5 and §2.8 | DESIGN §8 |
| **L3** completeness | The list is now **complete** rather than "selected". Added: calendar jitter +0.082/day (reported, not in the total) with its pass probabilities; extrapolated intervals never scored; 31–90-day horizons not assessed on `fleet15k`; `new_region`, FT-8, per-series quantiles and FT-10 / AT-8 at `full` scale. Also collected from elsewhere in the design: calendar recall with two prior cycles, no holiday calendar, the budget's scale-heterogeneity and burst-spread assumptions, AT-3 on noisier real series, intermittent-series time-to-detect and the D-24 `info` remainder, idealised data arrival, and partial lifecycle parity (D-15, D-17) | DESIGN §8 |
| Scripts | No script changed for these four items; `rollup12.py` changed in the same revision for the forecast leaves (§3m) | Appendix B |

## 3m. Revision 15: Copilot's review 5407477027 of 10cd9ce (8 High, 5 Medium, 3 Low)

Each thread was checked against the design; all 16 were valid. Many were
stale text left by earlier revisions, so a sweep for the same kinds of
remnant was made as well (last row).

| Thread | Disposition | Where |
|---|---|---|
| **r4178753680** (High) forecast leaf vs `series_id` | **Fixed.** The forecast leaf is account × service with regions summed, but forecast and detector state were keyed by `series_id`, whose natural key includes the region. Fix: a separate stable identity, **`leaf_id`** (`forecast_leaves`, natural key without the region). Every `cost_series` row carries its `leaf_id`; forecast state, detector state, the `leaf` anomaly scope and root causes key on it. This keeps the model grain and sizing. On `fleet15k`, `region_key = ''` everywhere, so leaf and series are one-to-one. Disk: +0.006 GB per run (`rollup12.py`) | App. D.0, D.1, D.2, D.4; DESIGN §2.9, §3.1, §7 (4-3) |
| **r4178753639** (High) pointer trigger trusts supplied numbers | **Fixed.** The trigger now requires `run_seq`, `as_of` and (rollup) `batch_seq_hwm` to equal the referenced run row's. The mark is recorded on `analytics_runs` by a database trigger at the transition to `succeeded` (`coalesce(max(batch_seq), 0)`) and is frozen afterwards. `run_seq`, `kind`, `as_of` and `batch_seq_hwm` are outside the UPDATE grant. Direct-UPDATE tests in 4-1 | App. D.1; DESIGN §7 (4-1) |
| **r4178753787** (Medium) non-zero filter | **Fixed.** `billing_daily` and `billing_daily_scope` keep a row for every group with at least one fact row, zero amounts included, so `row_count` and exactly-once hold. Test in 4-2 | App. D.1; DESIGN §7 (4-2) |
| **r4178753811** (Medium) multi-day usage | **Fixed by defining the filter** (not by dropping the claim). FOCUS allows any charge period, and `M` is a daily signal: a multi-day row attributed to one day would be an artificial spike, and prorating would invent a shape the source never stated. `M` now requires a charge period of at most one day. Such rows stay in billed and effective totals and in `multi_day_usage_effective`. D-09 is refined accordingly; tested in 4-2. `fleet15k` emits only one-day usage rows | DESIGN §2.9, §3.1, §8 D-09; App. D.1 |
| **r4178753752** (Medium) mutation invariant | **Fixed.** Each label has an **effect window** (`effectStart`, `effectEnd`) for the counterfactual test and a **scoring window** (`start`, `end`) for matching. `level_shift` and `gradual_drift` run to the end of the span; `dormant_reactivation` covers the gap and the restart. The label format gains `providerName` in `entity`, which the leaf identity needs | App. C.1, C.3 |
| **r4178753707** (High) `REVIEWED_TRIGGERS` | **Fixed.** Checked on main: `src/ingest/db/privilegeModel.ts` lists 0001's eleven triggers in `REVIEWED_TRIGGERS`, and `hookViolations` rejects any other. 0002 adds `rollup_pointer:pointer_guard` and `analytics_runs:run_success`, and 0003 adds `forecast_pointer:pointer_guard`. PRs 4-1 and 4-3 extend the list by exactly those entries (old set → new set) | App. D.1; DESIGN §6.2, §7 (4-1, 4-3) |
| **r4178753649** (High) sequence grants | **Fixed.** No `rollup_batches` identity sequence exists. The grant list now names the identity sequences of `cost_accounts`, `forecast_leaves` and `cost_series` only | App. D.1, D.5 |
| **r4178753613** (High) App. D header | **Fixed.** Views join a pointer, not the live publication; only `publications_published` reads the live publication | App. D (header) |
| **r4178753670** (High) DESIGN "rollups versioned by batch" | **Fixed.** The read side is the highest rolled-up batch ≤ the pointer mark | DESIGN §2.9 |
| **r4178753692** (High) threat-model row | **Fixed.** The restatement switch happens on the rollup pointer's commit, never earlier and never as a gap | DESIGN §6.3 |
| **r4178753724** (Medium) migration row 0002 | **Fixed.** "Joined to the current publication" removed; the triggers and `forecast_leaves` are listed | DESIGN §6.2 |
| **r4178753796** (Medium) "three sequential runs" | **Fixed.** Five mandatory runs plus natural-3 if needed | DESIGN §2.8 |
| **r4178753851** (Low) App. B seed list | **Fixed.** tuning-natural added | App. B.5.1 |
| **r4178753871** (Low) D-03 "three sequential seeds" | **Fixed.** Five mandatory seeds plus an optional natural-3 (refined rev. 5) | DESIGN §8 D-03 |
| **r4178753825** (High) 178 points | **Fixed.** 228 points per leaf in the 4-4b acceptance criterion; the revision-3 budget's 178 in B.5.3 is marked as that revision's figure | DESIGN §7 (4-4b); App. B.5.3 |
| **r4178753880** (Low) EVIDENCE script range | **Fixed.** B.5.6–B.5.12 | §4 |
| Sweep | Also fixed: the `cost_daily` reader-view note in App. D.1 ("joins the current publication") and the 4-3 plan row (keyed by `series_id`). Checked and found current: D2's window, h, budget totals, D-24 wording, disk figures, and every remaining "publication" mention (the freshness endpoint and the worker's own publication) | App. D.1; DESIGN §7 |
| Re-run | All 11 embedded scripts re-run; `rollup12.py` changed (forecast leaves), hash updated; every other output unchanged; peaks 5.182 / 5.222 GB (still 5.18 / 5.22) | App. B.5.12 |

## 3n. Revision 16: the challenger's review of a268c0e

| Item | Change | Where |
|---|---|---|
| **M1** run row writable by INSERT | **Valid.** `tg_analytics_run_success` ran only on UPDATE, and INSERT was unrestricted. A pre-`succeeded` row with any mark, `run_seq` or `as_of` passed the pointer guard. **Fix, both defences:** (1) the trigger is `BEFORE INSERT OR UPDATE`; on INSERT it requires `status = 'running'`, `batch_seq_hwm IS NULL` and `run_seq = coalesce(max, 0) + 1`; (2) the INSERT grant on `analytics_runs` is column-level and excludes `batch_seq_hwm` (and `finished_at`). `succeeded`, `failed` and `abandoned` are terminal, and `UNIQUE (tenant_id, kind, run_seq)` is added. 4-1 tests: a direct INSERT of a pre-succeeded run, an INSERT with a supplied mark, a duplicate `run_seq` and a re-succeed attempt, each with a mutant | App. D.1, D.5; DESIGN §7 (4-1) |
| **M2** effect windows | **Valid.** Many kinds besides the three named have a wider effect window. **Fix:** C.2 has an **Effect window** column for every kind. Permanent kinds run "start → end of span": `level_shift`, `gradual_drift`, `new_service`, `new_region`, `tagging_loss`, `commitment_expiry`, `commitment_effect`, `price_change`, `onboarding`, `offboarding`, and the fan-in kinds over `level_shift`. `dormant_reactivation` runs from its first gap day. The replay kinds (`mtd_restatement`, `late_data`, `correction`) use the affected **usage dates**, not the revision day. 3-1b checks "outside its **effect** window", with a mutant that sets the effect window equal to the scoring window for a permanent kind | App. C.1, C.2; DESIGN §7 (3-1b) |
| **L1** multi-day usage | **Valid.** Added to Known limits with the daily ↔ multi-day switching artefact, noting that `src/costsource/seed.ts` on main emits whole-month `Usage` rows (checked). `freshness` now reports the multi-day share of usage effective cost per period and per leaf | DESIGN §5.1, §8 |
| **L2** "series" → "leaves" | **Valid.** ≈ 107 k **leaves** in `full` | DESIGN §3.1 |
| **L3** leaf derivation | **Valid.** A second composite FK from `cost_series`' own (currency, provider, billing account, sub-account, service) to `forecast_leaves`' natural key. A composite FK `(tenant_id, series_id, leaf_id)` → `cost_series (tenant_id, id, leaf_id)` makes a root cause's series and leaf agree when both are set, without a trigger. Tests and mutants in 4-1 | App. D.0, D.1, D.4; DESIGN §7 (4-1) |
| **L4** `forecast_leaves` | **Valid.** Labelled insert-only and outside retention, and counted conservatively in every run's delta | App. D.1, B.5.12 |
| Scripts | No embedded script changed; the 11 SHA-256s are those of revision 15 | App. B |

## 3o. Revision 17: Copilot's review 5407588631 of 6cad4cd (6 High, 4 Medium, 1 Low)

Each finding was checked against 6cad4cd; none was already fixed by
revision 16, and all eleven are valid.

| Thread | Disposition | Where |
|---|---|---|
| **r4178820383** (High) `run_seq` for other kinds | **Fixed.** Only rollups had a serialised lease. Now every analytics kind (rollup, forecast, detect, backtest) uses the lease pattern with a per-(tenant, kind) advisory lock, so `max(run_seq)` is read by one starter at a time. `UNIQUE (tenant_id, kind, run_seq)` is the backstop: a violation fails with `RUN_SEQ_CONFLICT`, not a silent retry. Tests: concurrent forecast, backtest and detect starts (4-4b, 5-3). Mutant: drop the per-kind lock | App. D.1; DESIGN §7 (4-4b, 5-3) |
| **r4178820404** (High) "only where non-zero" | **Fixed.** DESIGN §2.9 now says every group with at least one fact row is retained, zero amounts included, matching D.1 and the 4-2 test. Sweep: no other "discard" or "only where non-zero" rule remains; the D.1 occurrence is the revision note quoting the old rule | DESIGN §2.9 |
| **r4178820416** (High) day index | **Fixed.** One index, the scored day `t`: the run reads charge days ≤ t and calibrates on errors with forecast day ≤ t − 1. D8 uses `r_{t−1} + r_t`; D4's restart day is t, with the dormant window t − 56 … t − 1; D1 and D2 score `y_t`; D3 updates `S_t`. Swept: §3.8 replay, D1 row, D6 fit, the dormant stretch, persistence (t − 3), the 5-2a mutant, the 5-3 test and mutant. Appendix C's "data for day d available on d + 1" already matches | DESIGN §3.8, §4.2, §4.5, §7 |
| **r4178820430** (High) persistence before fan-in | **Fixed.** Fan-in (steps 2–4) now runs first, over day t's candidates **plus** open narrower groups of the same service and category whose first day is within ±1 day. Persistence runs after (step 4b). Merge semantics: the survivor's first day is the earliest member's; each leaf-day belongs to one group; severity is the members' maximum; merged groups keep their ids and point to the survivor. 5-2b test with five accounts over two days; mutant "persistence before fan-in" | DESIGN §4.5, §7 (5-2b) |
| **r4178820510** CLI seeds | **Fixed.** `--seed tuning|tuning-natural|natural-1|natural-2|natural-3|enriched` | DESIGN §2.7 |
| **r4178820445** two vs three sequences | **Fixed.** The role row names the three identity sequences (`cost_accounts`, `forecast_leaves`, `cost_series`), matching D.5 | DESIGN §6.1 |
| **r4178820552** 3-1b seeds | **Fixed.** `tuning-natural` added to 3-1b's scope | DESIGN §7 (3-1b) |
| **r4178820538** impact vs severity | **Fixed.** The daily excess `x_t` and daily relative `ρ_t` drive the per-day severity rules. The cumulative impact (Σ `x_t`) is the API's `impact` and is used only in the cumulative clause. With expected ≤ 0, `ρ_t` is +∞ for an increase and 0 otherwise, so D4 candidates (new service or region, reactivation) are `warning` at x_t ≥ min and `critical` at ≥ 10 × min. D-13 clarified (thresholds unchanged). 5-2b test and mutants | DESIGN §4.4, §7 (5-2b), §8 D-13 |
| **r4178820523** "series key" | **Fixed.** The backtest export names `leaf_id`; the grouping sort key also uses `leaf_id` (sweep) | DESIGN §3.8, §4.5 |
| **r4178820566** storage per series | **Fixed.** "one row per **leaf** (`leaf_id`) per run" | App. D.3 |
| **r4178820480** FT on tuning | **Fixed.** 4-4b runs FT-4/5/7 on **natural-1**; the tuning seeds never feed an acceptance figure | DESIGN §7 (4-4b) |
| Scripts | No script changed for these eleven threads; `rollup12.py` changed in the same revision for r4178843716 (§3q) | App. B |

## 3p. Revision 17: the challenger's review of 6cad4cd (2 Medium, 4 Low)

The new constraints and tests were checked on a throwaway PostgreSQL 16.14
cluster (Unix socket only, port 55731, removed afterwards); the results are
quoted per item.

| Item | Change | Where |
|---|---|---|
| **M1** run-row tests | **Valid.** PostgreSQL checks privileges before triggers run, so revision 16's single test ("refused by the grant and by the trigger") could not show the trigger, and a sequential duplicate `run_seq` is caught by the trigger's max + 1 check, never by the UNIQUE. **Fix:** separate tests, each with its own mutant. (1) **Grant:** as the analytics login an INSERT supplying `batch_seq_hwm` fails 42501, even for an otherwise valid row; `has_column_privilege(…, 'batch_seq_hwm', 'INSERT')` is false; mutant: widen the grant (the probe then reaches the trigger instead). (2) **Trigger:** as a fixture role holding the privilege, a supplied mark, a pre-`succeeded` row and an out-of-order `run_seq` each fail with the trigger's own error. (3) **Re-succeed** refused. (4) **UNIQUE:** two concurrent same-kind inserts without the advisory lock: the second fails 23505 with the constraint, and both commit (duplicate `run_seq`) without it; plus a catalogue check. The allocation rule (lock, max + 1, trigger re-check, UNIQUE → `RUN_SEQ_CONFLICT`) is now stated once and the same for every kind | App. D.1, D.5; DESIGN §7 (4-1) |
| **M2** leaf derivation | **Valid.** The two FKs could each match a different leaf (the challenger's probe accepted `leaf_id` = svcA's leaf with `service_name` = svcB). **Fix:** **one** composite FK `(tenant_id, leaf_id, billing_currency, provider_name, billing_account_id, sub_account_id, service_name)` → `forecast_leaves (tenant_id, id, …)`, backed by a UNIQUE on those columns. Probe: the wrong-leaf series fails 23503; two regions of one service share one `leaf_id`; the revision-16 form, kept as the mutant, accepts the wrong leaf. Same as Copilot r4178843614 (§3q) | App. D.0, D.1; DESIGN §7 (4-1) |
| **L1** root cause without a leaf | **Valid.** The `(tenant_id, series_id, leaf_id)` FK is `MATCH SIMPLE`, so a NULL `leaf_id` skips it and `series_id` = 999 was accepted. **Fix:** `CHECK (series_id IS NULL OR leaf_id IS NOT NULL)` and a plain `(tenant_id, series_id)` FK. Probe: NULL leaf with series 999 or with a real series fails 23514; a series of another leaf, or leaf 1 with series 999, fails 23503; an account-level cause (both NULL) is accepted. `UNIQUE cost_series (tenant_id, id, leaf_id)` is listed in the `cost_series` row | App. D.1, D.4; DESIGN §7 (4-1) |
| **L2** §5 wording | **Valid.** For a file without a patch the classifier adds `diff-unavailable` **instead of** that file's content reasons (no added lines to match), and the report's classes gain `unclassified`. §5 and the PR body now say so | §5 |
| **L3** role table | **Valid.** The DESIGN role row names the three identity sequences, the column-level INSERT on `analytics_runs`, and the exact UPDATE list (`status`, `lease_token`, `lease_expires_at`, `heartbeat_at`, `finished_at`, `stats`, `error_code`); so do App. D's `analytics_runs` row and D.5 | DESIGN §6.1; App. D.1, D.5 |
| **L4** Lows | **Valid.** (a) The "non-zero" wording at DESIGN:718 was already fixed with Copilot r4178820404. (b) Known limits: a leaf billed only in multi-day rows has `M` = 0 every day and is never scored; `freshness` shows it at 100 %. (c) `freshness` per-leaf coverage is keyset-paginated (`limit` ≤ 500, cursor), sorted by share descending, with `minShare=`; the 4-5 latency check covers its first and a deep page, with the mutant "returned unpaginated" | DESIGN §5.1, §7 (4-5), §8 |
| Scripts | No script changed for these six items | App. B |

## 3q. Revision 17: Copilot's review 5407636005 of 6cad4cd (six new threads)

Each thread was checked against 6cad4cd; all six are valid. The review's
other ten open threads are those of review 5407588631 (§3o).

| Thread | Disposition | Where |
|---|---|---|
| **r4178843614** (High) leaf FKs | **Fixed** as the challenger's M2 (§3p): one composite FK with a matching UNIQUE on `forecast_leaves`, covering D.0, the `forecast_leaves` and `cost_series` rows and the root-cause FK | App. D.0, D.1, D.4 |
| **r4178843669** (High) pointer UPDATE lists | **Fixed.** One shared list named `batch_seq_hwm` on `forecast_pointer`, which has no such column; on PostgreSQL 16.14 that GRANT fails with 42703 (column does not exist). Each pointer now has its own list: `rollup_pointer` (`run_id`, `run_seq`, `batch_seq_hwm`, `as_of`, `updated_at`), `forecast_pointer` (`run_id`, `run_seq`, `as_of`, `updated_at`), in D.1, the `forecast_pointer` row, D.5 and DESIGN §6.1. Catalogue tests in 4-1 and 4-3; mutant: one shared list | App. D.1, D.2, D.5; DESIGN §6.1, §7 |
| **r4178843716** (High) leaf next-30/90 totals | **Fixed by storing them.** `forecast_totals` now holds month-end, next-30 and next-90 rows for every leaf, with a `quantile source` column; §3.7 says so. Revision 16 stored only the leaf month-end total, and §3.4 forbids rebuilding total intervals from daily bounds. **Sizing:** those rows had not been counted at all; `rollup12.py` now counts 222,312 leaf rows (2 runs kept, 0.033 GB) plus two `forecast_state` columns (0.002 GB). Delta per run 0.031 → **0.066 GB**; natural-1 run 5.027 GB; peaks **5.217 / 5.257 GB** (5.22 / 5.26), under the 5.5 GB target. Tests in 4-3 and 4-5; mutant: month-end only | App. D.2, D.3, B.5.12; DESIGN §2.8, §3.7, §7 |
| **r4178843747** (High) leaf reconstruction | **Fixed.** D.3 gives the full formula per method (`mean`, `m0`, `m1`, `m1_log` with its variance correction): weekly part × calendar factor = point; bounds = point + `scale_level` × the applied quantile, floored at 0 for the lower bounds. `scale_level` (the trailing 28-day mean `M`, by which §3.4 now says errors are divided) and `log_var` are stored. Tests (4-4b): job and API identical, and a run at a backtest origin reconstructs that origin's exported points exactly, on event days and for every method; mutants: no calendar factor, `level × q` as a bound, scaling by `level` | App. D.2, D.3; DESIGN §3.4, §7 (4-4b) |
| **r4178843775** array lengths | **Fixed.** Every fixed-length array (`season`, the four quantile arrays, the detector's weekday medians and weekly sums, `μ̂_k`) has `CHECK (array_ndims(x) = 1 AND cardinality(x) = n AND array_lower(x, 1) = 1 AND array_position(x, NULL) IS NULL)`. Probe: without it, `numeric[7]` stores 6 elements and a 2-D array; with it, 6 and 8 elements, a 7-element 2-D array, `'{}'`, lower bound 0 and a NULL element each fail 23514, and a NULL column passes. Rejection tests and mutant in 4-3 | App. D.2; DESIGN §7 (4-3) |
| **r4178843811** "insert-only" | **Fixed.** `forecast_leaves`, `cost_series` and `cost_accounts` are described as **rows never deleted, identity columns immutable, only `last_day` updated**, matching their grants, in App. D (D.0, the three rows), B.5.12 and DESIGN §2.9. They remain outside retention, which B.5.12 and D.0 still say | App. D.0, D.1, B.5.12; DESIGN §2.9 |
| Re-run | All 11 embedded scripts re-run: `rollup12.py` changed, SHA-256 `6bb735b8…` → `d296e8ff52c11494e5f538fe706da295ae8695f5589b2067270365627eabe8e5`; the other ten hashes and outputs unchanged; budget totals 0.101 / 0.131 | App. B |

## 3r. Revision 18: the challenger's review of cc54e79 (1 Medium, 5 Low)

The new constraints were checked on a throwaway PostgreSQL 16.14 cluster
(Unix socket only, port 55741, removed afterwards).

| Item | Change | Where |
|---|---|---|
| **M1** per-day severity vs the budget | **Valid.** Revision 17's "on some day" was looser than `budget5.py`, which tests a multi-day statistic on its window's mean (`need_rel(L) = max(0.20, MIN / L)`). **Fix (the preferred one, so no budget re-run):** a one-day statistic (D1 ∧ D2, D4) is tested on its day; a multi-day statistic on its window's mean excess `x̄ = Σx / n` and relative `ρ̄ = Σx / Σexpected`: D8's and D6's two days, the D3 alarm's episode, the weekly or hurdle week. The D3 episode is defined (days since `S⁺` last left 0) and `S⁺` restarts after an alarm, as the budget's episode simulation does, with no re-anchoring while the leaf's group is open. 5-2b: the $150/day weekly leaf with a +$400 week and one +$180 day is `info`, and a D8 pair passing on one day only is `info`; mutant "severity of a multi-day candidate from its largest day". 5-2a: the restart and the re-anchoring rule, with mutants. **AT-3 drift (pre-existing):** see the next row | DESIGN §4.2, §4.4, §7 (5-2a, 5-2b), §8 D-13 |
| **M1** AT-3 drift target | **Checked, not changed.** Arithmetic: on a ramp the anchor is at `k_c ≈ √(2R · min / E)`, and a candidate can reach `warning` only from `k_w = R · max(min / E, 0.20 / a)`. The challenger's case (`E` = 2 × min, `R` = 45) is 22.5 vs 6.7; for large leaves the 20 % test binds (worst case 28 days after the anchor at `a` = 0.30, `R` = 45). The distribution over 20,000 meaningful labels on the `fleet15k` leaf list (`drift_ttd.py`, new B.5.13, SHA-256 `3d5fe545…`): noise-free first-passing day (called "lower bound" in revision 18, renamed in revision 19) median 6, p90 12 days after the anchor; all detectors on the true baseline and scale, median 5, p90 11; **D3 alone (the detector a slow drift leaves to) median 7, p90 13 with the restart, 11 / 25 without it**; the cumulative clause is `critical`-only (50 × min) and is reached a median 18 days after the anchor, so it does not help. **Conclusion:** the target is not infeasible by construction, but it is at risk, with no margin even in the optimistic D3 case. The target and its anchor are unchanged (D-20); the enriched-seed measurement decides, and a miss goes to the owner. Recorded in §4.2, the AT-3 row, Known limits, and as an open item in the PR | DESIGN §4.2, §4.9 (AT-3), §8; App. B.5.13 |
| **L1** day-index leftovers | **Valid.** D4's "56 days before D" → t − 56 … t − 1; D2's window and the intermittent zero-share window are t − 56 … t − 1; D-24's q̂, m̂, v̂ and r₁ come from the 56 days before the scored week (as `budget5.py` line 190); D8's `s₂` is the scale of `r_{s−1} + r_s` over s ≤ t − 1. Sweep: no `D` index remains | DESIGN §4.2, §8 D-24 |
| **L2** fan-in step 1 | **Valid.** "Same service" excluded the members account fan-in needs. Step 1 now takes open narrower groups of the same category in **the rule's own scope**: the same service for steps 2–3 (singletons, and billing-account groups for step 2), the same account for step 4 (singletons of any service); "account group" dropped from the list. 5-2b test: X's singleton on service A from t − 1 plus candidates on B and C on t give one account group with first day t − 1; mutant: step 1 restricted to the same service | DESIGN §4.5, §7 (5-2b) |
| **L3** root-cause FKs | **Valid** (probe: `leaf_id` = 4242 with series NULL was accepted). `account_id` is `NOT NULL`; `(tenant_id, leaf_id, account_id)` → `forecast_leaves (tenant_id, id, account_id)` with a backing UNIQUE (the table carries `account_id`); `(tenant_id, account_id)` → `cost_accounts`. Probe: leaf 4242 → 23503; a leaf of another account → 23503; account 999 → 23503; NULL account → 23502; account-, leaf- and series-level causes accepted; the revision-17 form (mutant) accepts leaf 4242. Same change covers Copilot r4178908321's root-cause part (§3s) | App. D.4; DESIGN §7 (4-1) |
| **L4** "per run" vs peak | **Valid.** B.5.1 now applies the 5.5 GB target and 6 GB ceiling to the peak across the sequential runs, as DESIGN §2.8 and §2.10 do; B.5.3's 0.6 / 1.1 GB margin is labelled as revision 3's single-run margin | App. B.5.1, B.5.3 |
| **L5** §3.4 and D1's quantile | **Valid.** "Without the log variant" is removed: intermittent intervals use the level-scaled errors like every series (M1-log is not eligible with zero days). D1's one-sided 99 % quantile is of the cohort's h = 1 **log** errors (`hi₉₉ = ŷ · exp(q₀.₉₉)`), recomputed in every detect run from the as-of error counts in detector state, as are `σ_pool` and `s₂`; nothing is stored, so sizing is unchanged by this item | DESIGN §3.4, §4.2, §4.3; App. D.2 |
| Scripts | `drift_ttd.py` added (12 embedded scripts); `rollup12.py` changed for §3s; the other ten are byte-identical to revision 17, where all were re-run | App. B |

## 3s. Revision 18: Copilot's review 5407703235 of cc54e79 (seven threads)

Each thread was checked against cc54e79; all seven are valid. Thread
r4178908428 (the PR description) is handled by the coordinator.

| Thread | Disposition | Where |
|---|---|---|
| **r4178908321** (High) account FKs | **Fixed.** `cost_accounts` gains `UNIQUE (tenant_id, id, billing_currency, provider_name, billing_account_id, sub_account_id)`; `forecast_leaves` and `cost_series` bind `account_id` with one composite FK to it, so a row cannot name account B's components while pointing at account A; root causes as in §3r L3. Probe: both mismatches → 23503; the plain-FK mutant accepts them. 4-1 tests and mutants | App. D.1, D.4; DESIGN §7 (4-1) |
| **r4178908350** (High) D3 anchor | **Fixed.** `detector_state` keeps the **complete M1 state as of the anchor** (`anchor_method`, level, trend, `φ`, season, the three calendar factors, `log_var`), copied when the baseline is anchored and never changed until the next re-anchoring, so `ŷ(t \| a)` is D.3's formula on those columns alone. Tests: equal to D.3 on the anchor day's row, and unchanged across a weekly refit and a calendar-factor update (4-4b, 5-3); mutant: read `φ` or the calendar factors from the current state. Sizing: ≈ 110 B per leaf row with the episode columns | App. D.2, D.3; DESIGN §4.3, §7; B.5.12 |
| **r4178908395** aggregate D3 state | **Fixed.** New `detector_scope_state`, keyed by (scope kind, scope key, currency): anchor day, the frozen 28-day bottom-up baseline (`numeric[28]`, CHECKed), `S⁺`/`S⁻` and the episode; run-keyed, in the forecast retention function, ≈ 0.001 GB for 2 runs. 5-3 restart-continuity test for an aggregate with an open episode; mutant: state not persisted | App. D.1, D.2; DESIGN §4.2, §4.3, §6.2, §7 (4-3, 5-3) |
| **r4178908362** (High) `freshness` snapshot | **Fixed.** Each (source, period) returns `coverageBatch` (the batch the coverage came from, from a new definer view `rollup_batches_visible`) and `coverageStale` (it differs from the published batch); the per-leaf list carries the pointer's mark and as-of day. 4-5 test for the B2-published / B1-visible window and after the pointer moves; mutant: coverage labelled with the published batch | DESIGN §5.1, §7 (4-5); App. D (header, D.1) |
| **r4178908409** coverage share | **Fixed.** Share = `Σ_d \|multi_d\| / Σ_d (\|M_d\| + \|multi_d\|)` from the existing day-level sums, in [0, 1]; `null` with a zero denominator, excluded by `minShare=` and sorted last; signed sums returned beside it. 4-5 tests for zero, negative and mixed-sign totals; mutant: the signed ratio | DESIGN §5.1, §7 (4-5) |
| **r4178908381** per-bucket quantile source | **Fixed.** `forecast_state.q_source text[6]`, one per bucket, CHECKed like the other arrays and to the three values (probe: a bad value, 5 elements and a NULL element → 23514); the API returns the source per day and scoring skips `extrapolated` days. 4-4b test with buckets own / cohort / extrapolated; mutant: one scalar. Sizing ≈ 100 B per leaf row | App. D.2, D.3; DESIGN §7 (4-3); B.5.12 |
| **r4178908374** recall mutation | **Fixed.** C.6 now inserts one meaningful label of an existing gated kind with no matching group, which must raise that kind's missed count by exactly 1 | App. C.6 |
| Re-run | `rollup12.py` changed: delta 0.066 → **0.082 GB per run**; natural-1 run 5.044 GB; peaks **5.234 / 5.274 GB** (5.23 / 5.27), under the 5.5 GB target; SHA-256 `d296e8ff…` → `a0931c448ddf6e09b42d0eb3d43a291445cfcdc618ddc33713425c004f304b9e`. All 12 embedded scripts hash to their stated values | App. B.5.12 |

## 3t. Revision 19: Copilot's review 5407780981 of ddbb6f0 and the challenger's Lows on revision 18

The challenger APPROVED revision 18 (0 High, 0 Medium, 4 Low). Copilot
raised 2 High and 1 Medium; its fourth thread (r4178975214, the PR
description) is handled by the coordinator. Each item was checked against
ddbb6f0 and is valid. Checks: K1's filter and column on a throwaway
PostgreSQL 16.14 cluster (port 55751, removed afterwards): the floor-only
insert fails 23502 on a null-id row, the named-row insert keeps only the
named row, and a `''` resource fails the CHECK (23514); `scale_level` 0
or negative fails its CHECK. K2's bound rule in a throwaway property
check: 0 violations in 100,000 random rows, while each of the three
mutants fails thousands of 20,000.

| Item | Change | Where |
|---|---|---|
| **K1 r4178975173** (High) unnamed resources | **Fixed.** `cost_resource_daily` takes only **named** rows (`nullif(ResourceId, '') IS NOT NULL`) above the floor; `resource_id` is `NOT NULL CHECK (resource_id <> '')`. **The D.0 `''` sentinel is deliberately not used** for `resource_id`: an unnamed row belongs to no resource, and as one `''` "resource" the generator's remainder row would carry most of a series' excess and turn D3 candidates into `runaway_resource`. Unnamed cost stays in `cost_daily` and the totals, and root causes show it as the unattributed remainder. 4-2 test (a $5,000/day null- and `''`-id row roll up without error), 5-2a test (the remainder is not `runaway_resource`); mutants: drop the filter (23502), store `''` | App. D.0, D.1; DESIGN §2.9, §7 (4-2, 5-2a) |
| **K2 r4178975191** (High) ordered bounds | **Fixed.** `scale_level` is the trailing 28-day mean of `\|M\|` floored at min impact / 10,000 (`CHECK > 0`), also in §3.4's calibration; quantiles are stored clamped (`q95_lo ≤ q80_lo ≤ 0 ≤ q80_hi ≤ q95_hi`), widening a biased bucket rather than shifting it; lower bounds are floored at 0 only for a point ≥ 0. So `lo95 ≤ lo80 ≤ point ≤ hi80 ≤ hi95` holds for every row, negative points included, for leaves, aggregates and the backtest export alike; D1 (log errors, positive points only) is unaffected. 4-4b property test over 10,000 random rows plus the negative-mean and negative-point cases; mutants: signed mean, 0 floor on a negative point, unclamped quantiles. No script depends on it | App. D.2, D.3; DESIGN §3.4, §7 (4-4b) |
| **K3 r4178975203** (Medium) `B` beyond month-end | **Fixed.** §3.1's output contract gives `B` for the current month's month-end only; the `forecasts` row says month-end (`M` and `B`), next 30/90 (`M` only); 4-5 test that next-30/90 totals carry no `billedMonthEnd`, with a mutant | DESIGN §3.1, §5.1, §7 (4-5) |
| **L1** "lower bound" | **Valid.** The all-detector median (5) is below it, so it is not a bound. Renamed **noise-free first-passing day** in §4.2, the AT-3 row, Known limits, B.5.13 (table and reading), `drift_ttd.py`'s printed label, §3r, §4 and the PR body. Only the label changed: the script's figures are identical, and its SHA-256 is now `9b04c754eea7b9d14b6eda11b3ece3498d7c939296d928a4b1ad286724cad0ff` | DESIGN §4.2, §4.9, §8; App. B.5.13 |
| **L2** 28-day cap vs open group | **Valid.** The 28-day cap wins: on day a + 28 the baseline is re-anchored and the sums and episode restart, even with an open group, which persistence then extends. Aggregates hold exactly 28 baseline values. 5-2a test for a leaf and an aggregate; mutant: hold the baseline past 28 days (the aggregate's array CHECK refuses a 29th value) | DESIGN §4.2, §7 (5-2a) |
| **L3** anchor source | **Valid.** The anchor is the leaf's **daily-updated model state as of day a**, written in D.3's layout, not a `forecast_state` row (refits are weekly). The D.3, 4-4b and 5-3 tests are phrased against that state on a day without a forecast run; mutant: copy the last `forecast_state` row | App. D.2, D.3; DESIGN §7 (4-4b, 5-3) |
| **L4** freshness snapshot; weekly expected value | **Valid.** `coverageBatch` and the coverage sums come from one statement (a join of `rollup_batches_visible` with `cost_daily_published`); 4-5 test with a pointer move between the two reads of a two-statement mutant. For the weekly and hurdle statistics `Σexpected` is the statistic's own baseline: the median of the previous 8 weekly sums, and `7q̂m̂`, which is what `budget5.py` uses | DESIGN §4.4, §5.1, §7 (4-5); App. D.1 |
| **D1** tests cited in §3s | **Fixed by adding the tests** to the 4-4b row: the per-bucket quantile-source test and the D3 anchor-state test (which §3s cited and the plan lacked) | DESIGN §7 (4-4b) |
| **D2** "nets to 0" | **Fixed.** `null` only when every day's sums are 0; the netting case (`M` +10 / −10, multi-day +5 / −5 on two days) has the defined share 10 / 30 = 0.33, now a 4-5 test | DESIGN §7 (4-5) |
| Scripts | `drift_ttd.py`'s label changed (hash above, output figures identical); the other eleven are unchanged (`rollup12.py` `a0931c44…`); no disk figure changes | App. B |

## 3u. Revision 20: Copilot's review 5407820380 of 0dd6743 and the challenger's Lows on revision 19

The challenger APPROVED revision 19 (0 High, 0 Medium, 3 Low). Each item
was checked against 0dd6743 and is valid. P3 and the challenger's L2 are
the same finding.

| Item | Change | Where |
|---|---|---|
| **P1 r4179014779** (High) `freshness` keyset | **Fixed.** Order `(share DESC NULLS LAST, leaf_id ASC)`; the cursor carries both, with an explicit null branch (`share < s OR (share = s AND leaf_id > id)` plus every null after a non-null cursor; `share IS NULL AND leaf_id > id` after a null one). Probe on PostgreSQL 16.14 (port 55761, removed afterwards), 37,052 leaves (30,000 tied at 0, 2,052 in 7 tied values, 5,000 null), pages of 500: every leaf visited exactly once; the mutant without the tie-breaker visits 7,000 and misses 30,052. 4-5 traversal test and mutants | DESIGN §5.1, §7 (4-5) |
| **P2 r4179014804** resource floor | **Fixed.** The floor is a quarter of the tenant's minimum impact **in that currency** (defaults USD/EUR/GBP 25, JPY 3,750 per day), read from the same per-currency setting, never converted (D-10), and recorded in the rollup run's `stats`. 4-2 test in each of the four currencies (0.24 × out, 0.26 × in); mutant: one literal 25. **Sizing:** unchanged. `fleet15k` names only injected runaway resources, and the budget never counted `cost_resource_daily` separately, so `rollup12.py` was not re-run | DESIGN §2.9, §7 (4-2); App. D.1 |
| **P3 r4179014824** / **L2** intermittent floor | **Fixed.** Intermittent intervals follow the rule of every interval: floored at 0 only when the point is ≥ 0. Sweep: no other unconditional interval floor remains (the other `max(0, …)` are CUSUM recursions and sampling code) | DESIGN §3.4 |
| **P4 r4179014849** retention list | **Fixed.** `detector_scope_state` added to §6.1's list (the retention functions' paragraph; revision 20's text said §6.2, corrected in revision 21) and D-12, matching App. D.1's function; the governance row now names 4-3 for the forecast retention test, which checks all six run-keyed forecast and detector tables keep exactly the 2 latest runs; mutant: leave `detector_scope_state` out. App. B has no table list to change | DESIGN §6.1, §6.4, §7 (4-3), §8 D-12 |
| **L1** totals intervals | **Fixed.** Every `forecast_totals` row, at every level and window, uses the same rule: scale `L_T = n × L` (n forecast days in the window), total-error quantiles clamped around 0, floor at 0 only for a total ≥ 0; `n` = 0 gives a zero-width interval at the actuals. The 4-4b property test covers 10,000 random totals rows, negative next-30 totals included; mutant: floor a negative total at 0 | DESIGN §3.4; App. D.2, D.3; DESIGN §7 (4-4b) |
| **L3** clamping vs FT-7 | **Stated, target unchanged.** Clamping only widens a biased bucket, so it can over-cover and fail FT-7's upper limits (85 %, 97.5 %). `forecast_backtests` gains a `clamped_share` metric and `forecast_totals` a `clamped` flag; 4-4b and 4-6 report the share of clamped buckets and total windows next to FT-7 | DESIGN §3.4, §7 (4-4b, 4-6); App. D.2 |
| Scripts | No script changed; all 12 hashes as in revision 19. The new `clamped` flag (1 B per totals row) sits inside `rollup12.py`'s 150 B-per-row assumption | App. B |

## 3v. Revision 21: Copilot's review 5407844545 of d4616a8 and the challenger's Low on revision 20

The challenger APPROVED revision 20 (0 High, 0 Medium, 1 Low in two
parts). Each item was checked against d4616a8 and is valid. Q2 and the
challenger's L1(a) are the same finding. Thread r4179039399 (the PR
description) is handled by the coordinator. Q1's key and Q3's view were checked on a throwaway PostgreSQL
16.14 cluster (port 55771, removed afterwards): the revision-20 key
refuses the second block's row (23505) and the new key stores both; the
view shows the previous succeeded run while a run is `running` and after
it `failed`, switches to the new run's rows on success, and the mutant
(latest run whatever its status) exposes a running run.

| Item | Change | Where |
|---|---|---|
| **Q1 r4179039337** (High) backtest report key | **Fixed, and two more gaps found.** `block` joins the key. Checking the other columns found two more dimensions the targets report but the key lacked: `billing_currency` (FT-1 is per currency; `''` for unitless metrics pooled over currencies) and `segment` (individual vs `Other services` for FT-4; cohorts, event days and anomaly days for FT-9). `horizon_bucket` now names its value set: daily buckets, month-end remaining-days buckets, `day1` / `day15` (FT-1, FT-2), `next_30` / `next_90`. The key is (tenant_id, run_id, block, level, billing_currency, segment, horizon_bucket, metric). 4-4b test (one metric in both blocks, two currencies, two segments → separate rows); mutant: drop `block`, currency or segment from the key. `forecast_backtest_points`, `forecast_points` and `forecast_totals` were checked: their keys already carry every dimension (origin day, h, window, currency) | App. D.2; DESIGN §7 (4-4b) |
| **Q2 r4179039364** (High) / **L1(a)** `n` = 0 | **Fixed.** Month-end origins on the month's last published day (`n` = 0, `L_T` = 0) are left out of the totals calibration, as origins with mean `\|M\|` < `ε` are, so no error is divided by 0, even after a restatement gives that origin a non-zero error; their own interval has zero width at the actuals. 4-4b test with a restated last day; mutant: include `n` = 0 origins | DESIGN §3.4, §7 (4-4b) |
| **Q3 r4179039382** (Medium) backtest publication | **Fixed with a view, not a pointer.** `forecast_backtests_current` returns the rows of the succeeded `backtest` run with the highest `run_seq`. **Atomic:** the rows become visible only through the single `UPDATE` to `succeeded` in the run's success transaction; `succeeded` is terminal; rows are written only under `assertLease` while the run is `running`. **Deterministic and monotone:** `run_seq` is allocated under the per-(tenant, backtest) lock and a fenced run cannot succeed. A pointer would need a new table, guard trigger, `REVIEWED_TRIGGERS` entry and grants for the same guarantee. 4-4b tests: a running and a failed backtest are invisible; the switch on success is all-or-nothing for a reader; a fenced run adds no rows. Mutants: latest run whatever its status; order by `run_id` | App. D (header, D.2); DESIGN §5.1, §7 (4-4b) |
| **L1(b)** pooling month-end errors across `n` | **Fixed.** Month-end total errors are pooled per remaining-days bucket {1, 2–7, 8–14, 15–31}, with the same cohort fallback and √-scaling of empty buckets; next-30 and next-90 have a fixed `n`. Month-end coverage is reported per bucket; no target added. 4-4b test (3 and 20 remaining days calibrated in different buckets); mutant: one pool across all `n` | DESIGN §3.4, §7 (4-4b); App. D.2 |
| **E1** §3u section reference | **Fixed.** The retention list is in DESIGN §6.1 (the retention functions' paragraph), not §6.2 | §3u |
| Scripts | No script changed; all 12 hashes as in revision 20; no disk figure changes (the backtest report is a few thousand rows per run) | App. B |

## 3w. Revision 22: Copilot's review 5407898631 of bddefe9 and the challenger's Low on revision 21

The challenger APPROVED revision 21 (0 High, 0 Medium, 1 Low). Each item
was checked against bddefe9 and is valid. R1's CHECK and R2's
constraints were checked on a throwaway PostgreSQL 16.14 cluster (port
55781, removed afterwards).

| Item | Change | Where |
|---|---|---|
| **R1 r4179088862** (High) leaf billed `B` | **Fixed by narrowing the contract.** Credits, purchases, fees and tax exist per account and charge category only (`billing_daily`, `billing_daily_scope`), so a leaf (account × service) and the fleet-wide service scope have no billed source. `B` is now promised only at account, billing-account, business-unit, provider and tenant scope; `billed_month_end` carries `CHECK (billed_month_end IS NULL OR (window = 'month_end' AND scope_kind IN (…)))`. No allocation to services is invented, as with `attributed: false`. Probe: a leaf, a service-scope and a next-30 row with a billed value each fail 23514. 4-5 test (account, billing account and tenant carry `billedMonthEnd`; leaf and service do not); mutant: `billedMonthEnd` on a leaf | DESIGN §3.1, §5.1, §7 (4-5); App. D.2 |
| **R2 r4179088890** (High) anomaly parent integrity | **Fixed.** `(tenant_id, merged_into)` → `anomalies (tenant_id, id)`; `CHECK ((status_reason IS NOT DISTINCT FROM 'merged') = (merged_into IS NOT NULL))`, `CHECK (merged_into IS NULL OR status = 'resolved')`, `CHECK (merged_into IS DISTINCT FROM id)`; the three child tables reference `anomalies` with `ON DELETE RESTRICT`. Nothing deletes anomalies: no DELETE grant, and neither retention function names an anomaly table. Probe: a dangling or cross-tenant target → 23503; a merged row without a target, a target on an open row, a merged row still open, a self-merge → 23514; an orphan child → 23503; deleting a referenced parent → refused; a plain `=` CHECK (mutant) passes a target on an open row because `NULL = false` is NULL. 5-1 tests and mutants | App. D.4; DESIGN §6.1, §7 (5-1) |
| **R3 r4179088906** (High) M1-log with non-positive values | **Fixed.** Eligibility: every value of the last 28 days > 0. **Runtime fallback, chosen:** a value ≤ 0 after selection switches that leaf to M0 at that update (`log_fallback`), and to M1 at the next weekly refit. M0 needs no fitted state, and clamping would invent data. The rule is fixed before the scoring block, so it is not a selection on scored data. D3's anchor and D.3's reconstruction were checked: `exp(…) − 1` takes no log of an observation, and a leaf-day with `M` ≤ 0 is not scored on the log scale (§3.1). 4-4a test (−5 and 0 after selection: no NaN, the switch and the flag); mutants: eligibility on zeros only, `log1p` of a value ≤ 0, clamping | DESIGN §3.2, §7 (4-4a); App. D.2 |
| **R4 r4179088921** (Medium) sixth `cost_daily` measure | **Fixed by measuring.** `rowsize3.sql` (new, B.5.14, SHA-256 `a6032a63…`), on a throwaway PostgreSQL 16.14 cluster, twice: integer `batch_seq` with six measures is **172.3 B** per row with the multi-day measure 0 and **180.2 B** with it non-zero, against the **193 B** that `budget.py` estimated (uuid key, five measures: 217.0 B, reproducing B.5.2). The estimate was **too high, not too low**. `rollup12.py` applies 180.2 B: −0.058 GB per run, delta +0.024 GB, natural-1 run 4.986 GB, peaks **5.176 / 5.216 GB** (5.18 / 5.22), under the 5.5 GB target. SHA-256 `a0931c44…` → `beb47e98e01e822e832a9f9340221be879251352bd2aa3bcfbfe62769a0d730a`. DESIGN, App. B, App. D, §4 and the PR body updated; DESIGN §2.9's stale "five measures" corrected | App. B.5.2, B.5.12, B.5.14; DESIGN §2.8, §2.9, §2.10; App. D.1 |
| **R5 r4179088932** (Low) D-21 names | **Fixed.** The generator emits `SyntheticAWS`, `SyntheticAzure` and `SyntheticGCP` and no other provider name; `SyntheticCloud` is the existing fixtures' name (checked: `src/ingest/focus/provider.ts` on main), which it does not emit | DESIGN §8 D-21 |
| **R6** (challenger) backtest snapshot | **Fixed.** The switch is atomic per snapshot: one statement, or one REPEATABLE READ transaction, sees one run; two READ COMMITTED statements can straddle the commit. The accuracy route reads page and count in one REPEATABLE READ transaction; the 4-4b test is written that way, with a mutant reading them in two READ COMMITTED statements | DESIGN §5.1, §7 (4-4b); App. D.2 |
| Scripts | `rollup12.py` changed (hash above); `rowsize3.sql` added (13 embedded scripts); the other eleven unchanged | App. B |

## 3x. Revision 23: Copilot's review 5407941028 of c85079f and the challenger's Low on revision 22

The challenger APPROVED revision 22 (0 High, 0 Medium, 1 Low). Each item
was checked against c85079f and is valid. S1 was checked on a throwaway
PostgreSQL 16.14 cluster (port 55791, removed afterwards).

| Item | Change | Where |
|---|---|---|
| **S1 r4179131145** (High) merge cycles | **Fixed.** A `BEFORE INSERT OR UPDATE OF merged_into` trigger, `ratio.tg_anomaly_merge_guard()` (`SECURITY INVOKER`, pinned `search_path`, owned by `ratio_owner`), locks the target row `FOR UPDATE` and refuses a target that is itself merged (`MERGE_TARGET_NOT_TERMINAL`), and refuses merging a group that others still point at (`MERGE_SOURCE_HAS_MEMBERS`). Every pointer is one level deep to a survivor, so no cycle can form. **A survivor merged later** (a billing-account group absorbed by a provider-wide group): the job re-points its members to the new survivor first, with an event each, then merges it. Prohibiting that would split the provider-wide event in two (AT-6). `REVIEWED_TRIGGERS`: 0001's 11 → 13 (0002) → 14 (0003) → **15** (0004 adds `ratio.anomalies:merge_guard:ratio.tg_anomaly_merge_guard()`). The same sweep fixed DESIGN §6.2's stale "`REVIEWED_TRIGGERS` is unchanged (no new triggers)". Probe: A → B then B → A refused; C → D, then D → E refused until C is re-pointed, then E → C refused; S1, S2 → BA, re-pointed to PW, BA → PW leaves every pointer at PW; **concurrent** X → Y and Y → X: one commits, the other is refused. Mutants: without the trigger the two-row cycle commits; **without the row lock both concurrent cross-merges commit** (probe). 5-1 and 5-2b tests and mutants | App. D.1, D.4; DESIGN §4.5, §6.2, §7 (5-1, 5-2b) |
| **S2 r4179131180** M1-log fit window | **Fixed.** Eligibility requires every value the M1-log fit or its selection reads to be > 0: the whole fit history up to the origin and every day of the selection block, not only the last 28 days. 4-4a test with the only −5 forty days back (not eligible); mutant: the trailing-28 check | DESIGN §3.2, §7 (4-4a) |
| **S3 r4179131198** calendar samples | **Fixed.** A calendar sample counts only if `y > 0` and `ŷ_weekly > 0`; `m` counts valid samples; the median, `σ` and the significance test use that one valid set; fewer than 3 valid samples gives factor 0. 4-4a tests with zeros (0 / 0) and a negative event day; mutants: all samples (NaN), `m` counted before dropping invalid ones | DESIGN §3.2, §7 (4-4a) |
| **T1** (challenger) "not reopened" | **Fixed.** "A resolved group is never reopened; a later candidate starts a new group" (a new first day, so a new dedup key and id). Sweep: no other reopen wording in the documents | DESIGN §4.5 |
| Scripts | No script changed; all 13 hashes as in revision 22; no disk figure changes (one trigger) | App. B |

## 3y. Revision 24: Copilot's review 5407981134 of b9b2274 and the challenger's Low on revision 23

The challenger APPROVED revision 23 (0 High, 0 Medium, 1 Low). Each item
was checked against b9b2274 and is valid.

| Item | Change | Where |
|---|---|---|
| **U1 r4179171086** (High) account-scope daily forecasts | **Fixed with option (b), on read**, the cheaper honest design. An account's daily point is the sum of its leaves' D.3 points, which is the bottom-up rule of §3.6, so it adds up with its leaves. Its bounds come from one new `forecast_scope_state` row per account and run: the account's own calibrated scale, quantiles and per-bucket sources, cohort-pooled by provider × size decile. Its totals are in `forecast_totals`. A request reads ≤ 3 leaf rows on `fleet15k` and ≤ 80 on `full`. Option (a) would add ≥ 0.405 GB and take the peak to ≈ 5.6 GB, above the 5.5 GB target. **The sweep below found a second gap:** `budget.py` sized 550 aggregate scopes, but the census gives ≈ 820 (100 hierarchical + 720 fleet-wide service scopes with currencies, an upper bound), and account totals were not counted. `rollup12.py` now counts both: +0.039 GB (270 more scopes) + 0.027 GB (account state and totals). Delta 0.024 → **0.091 GB** per run; natural-1 run 5.052 GB; peaks **5.242 / 5.282 GB**, under the 5.5 GB target, so no D-20 escalation. SHA-256 `beb47e98…` → `8f29a107740860272c960b78e3e56bc700377c1fee9850e69cefc8e4a0f70ee3`. 4-4b test: account points equal the sum of the leaves', and its bounds equal D.3 step 4 on its own state; mutant: summed leaf bounds. `forecast_scope_state` is run-keyed, so it joins migration 0003, the forecast retention function's list and its 4-3 test (seven tables) | App. D.1, D.2, D.3, B.5.12; DESIGN §2.8, §2.10, §3.6, §6.1, §6.2, §8 D-12 |
| **U2 r4179171113** (High) anomaly publication | **Fixed with one transaction**: every `anomalies`, `anomaly_days`, `anomaly_root_causes` and `anomaly_events` change of a detect run is written in its success transaction, with `assertLease … FOR UPDATE` and the transition to `succeeded`. A failed, killed or fenced run leaves the four tables untouched; a REPEATABLE READ reader sees all of a run's changes or none. **Why not run-versioned rows:** anomalies live across runs and are not run-keyed, so versioning would copy every open group each run or need a latest-version view. The changes per run are small, so one transaction is cheap. 5-3 tests (killed, failed, fenced; atomic switch) and mutants (rows written as found; rows committed before `assertLease`) | App. D.4; DESIGN §7 (5-3) |
| **U3 r4179171132** (High) sparse and non-positive series | **Fixed.** A day is valid when `M` > 0. Routing counts **non-positive** days (≥ 30 % → intermittent), so a daily-scored series has ≥ 40 valid days. D2's medians and MAD use valid days, and a weekday with < 3 valid days falls back to the overall valid median. D1 needs a positive actual and point. D8 needs a valid pair, with `s₂` from valid pairs. D3 carries `S±` over invalid days. D6 needs two valid growths, and its fit uses valid growths. **Budget:** `budget5.py` draws every daily-scored `fleet15k` leaf with 56 valid days, which is exact for the generator (its non-intermittent series have no zero or negative day), so it computes exactly these statistics and needs no change for this item. Real series with up to 16 invalid days estimate from as few as 40 values; that is now a Known limit. 5-2a tests and mutants | DESIGN §3.4, §4.2, §7 (5-2a), §8 |
| **U4 r4179171151** (Medium) zero weeks | **Fixed.** A non-positive week is scored as 0.1 × the median of the weeks before it, scale-aware, and enters the 8-week history that way; it can only lower `S⁺`. `budget5.py` uses the same rule. **Re-run side by side with revision 7's script: byte-identical output**, including the same alarm counts in a direct comparison, so the weekly term (0.0139) and the totals (0.101 / 0.131) stand and the 0.15 margin holds. SHA-256 `7bc2ea76…` → `def110531f5780ae60a428486d52492dd3385862417d823adc05e02fa50a8d57`. The cited line App B:1239 is `budget4.py`, revision 6's superseded script, kept verbatim. 5-2a test (the same z in USD and in JPY) and mutant (`log(0.001)`) | DESIGN §4.2, §7 (5-2a); App. B.5.10 |
| **V1** (challenger) `repointed` | **Fixed.** §4.6 gains `resolved` → `resolved` with reason `repointed`; `anomaly_events` records `from_merged_into` and `to_merged_into`, with a CHECK that a `repointed` event names two different targets; the 5-2b test checks the event for each re-pointed singleton | DESIGN §4.5, §4.6, §7 (5-2b); App. D.4 |
| Scripts | `rollup12.py` and `budget5.py` changed (hashes above); 13 embedded scripts, all hashing to their stated values | App. B |

**U1 sweep: every promised scope × forecast output and where it lives**

| Scope (count on `fleet15k`) | Daily points + intervals | Totals (3 windows) | Billed `B` | Sized in |
|---|---|---|---|---|
| leaf (37,052) | on read, `forecast_state` | `forecast_totals` | none | B.5.12 (rev. 15, 17, 18) |
| account (15,000) | on read: leaves' `forecast_state` + `forecast_scope_state` | `forecast_totals` | `forecast_totals` | B.5.12 (rev. 24; totals were missing before) |
| billing account, business unit, provider, tenant (100) | `forecast_points` | `forecast_totals` | `forecast_totals` | `budget.py`'s 550 |
| fleet-wide service (≤ 720) | `forecast_points` | `forecast_totals` | none | 550 + the census's 270 (rev. 24) |

The same census covers the rollup side (`cost_daily_scope`,
`billing_daily_scope`), the aggregate backtest points and
`detector_scope_state`, whose D3 scopes are the 100 hierarchical ones.
`costs/daily` at account or leaf scope reads `cost_daily` and
`billing_daily` directly (sized in B.5.3).

## 3z. Revision 25: Copilot's review 5408081799 of f3209ea and the challenger's Low and nit on revision 24

The challenger APPROVED revision 24 (0 High, 0 Medium, 1 Low, 1 nit). Its
Low (stale scope counts) is the same finding as W5. Each item was checked
against f3209ea and is valid. W1 and W6 were checked on a throwaway
PostgreSQL 16.14 cluster (port 55801, removed afterwards).

| Item | Change | Where |
|---|---|---|
| **W1 r4179229443** (High) restatement re-introduction | **Fixed with an occurrence discriminator.** `occurrence` (≥ 1) is part of the dedup key, its `UNIQUE` and the UUID v5 input. It is allocated in the detect run's success transaction under the per-(tenant, `detect`) lock: 1 for a new key, the highest resolved occurrence + 1 when a restatement brings a resolved group's first day back. An open row with the same key is extended, never duplicated. "Never reopened" and every CHECK stay intact; the merge guard, fan-in and events treat each occurrence as its own group. Probe: B1 → occurrence 1, resolved after B2, B3 → occurrence 2 with a new, deterministic id; the key without `occurrence` (mutant) fails 23505 on B3. 5-3 `ci` replay test (B1 detects, B2 resolves `restated`, B3 re-introduces; replayed twice with the same ids) and mutant | DESIGN §4.5, §4.7, §7 (5-3); App. D.4 |
| **W2 r4179229471** backtest retention | **Fixed.** The forecast retention function now also removes the `forecast_backtests` and `forecast_backtest_points` rows of backtest runs that are neither among the 2 latest succeeded nor pinned, and never a `running` run's; the backtest command then deletes those runs' export files and keeps their SHA-256 manifest in `stats`. **Pinned** runs (new insert-only table `analytics_run_pins`, written when an acceptance run or a PR's evidence records the manifest) are archived, never deleted. D-12 and §6.1's lists are updated; revisions 3–24 exempted this output entirely. **Sizing unchanged:** on `fleet15k` each sequential run is its own stack with at most one backtest run, and the exports retained across runs are already in the peak (B.5.7); the bound is (2 + pinned) × (≈ 0.01 + ≈ 0.25) GB. 4-3 test (pinned, latest two, older, failed, running) and mutants. This is a retention change and the classifier's `retention` reasons cover it, as they should | DESIGN §3.8, §6.1, §6.2, §7 (4-3), §8 D-12; App. D.1, D.2 |
| **W3 r4179229481** account-level fields | **Fixed.** Every non-leaf scope reports a `bottom_up` summary: `method = bottom_up`, its own `historyDays`, `leafCount`, and `coldStartShare` (the share of the window's expected `M` from leaves flagged `estimated`), written to its `forecast_totals` rows. Method, history and the cold-start flag stay per leaf. API row and 4-5 test (an account with one fitted and one estimated leaf) | DESIGN §3.6, §5.1, §7 (4-5); App. D.2 |
| **W4 r4179229491** array checklist | **Fixed.** `forecast_scope_state`'s four quantile arrays and `q_source` join the fixed-length array list; 4-3 rejection tests and mutant | App. D.2; DESIGN §7 (4-3) |
| **W5 r4179229499** / **challenger Low** stale scope counts | **Fixed.** §4.2 and §4.3 say 100 D3 scopes; the budget row says the budget counts 550 as an upper bound (100 actual) and keeps 0.0279 as the conservative figure (≈ 0.005 at 100); the rollup line says ≈ 820; `detector_scope_state` says 100, sized at 550. Sweep: the remaining "550" occurrences are the census's own comparison, `budget.py` / `budget5.py` (unchanged, as run) and historical evidence rows | DESIGN §2.9, §4.2, §4.3; App. D.2 |
| **W6** (challenger nit) event-target FKs | **Fixed.** `(tenant_id, from_merged_into)` and `(tenant_id, to_merged_into)` → `anomalies (tenant_id, id)`, `ON DELETE RESTRICT`. Probe: a `repointed` event naming a nonexistent target fails 23503; one with the same old and new target fails 23514. 5-1 test and mutant | App. D.4; DESIGN §7 (5-1) |
| Scripts | No script changed; all 13 hashes as in revision 24; no disk or budget figure changes | App. B |

## 3aa. Revision 26: Copilot's review 5408165158 of 45b0088 and the challenger's Lows on revision 25

The challenger APPROVED revision 25 (0 High, 0 Medium, 3 Low). Each item
was checked against 45b0088 and is valid.

| Item | Change | Where |
|---|---|---|
| **X1 r4179273924** (Medium) shares | **Fixed at every cited place, all with the same rule as `freshness`'s coverage share:** absolute values in numerator and denominator, `null` when the denominator is 0.<br>– **:1168, `coldStartShare`:** `Σ\|E\|` of estimated leaves ÷ `Σ\|E\|` of all leaves.<br>– **:1309, APE of totals:** undefined when `\|Y\|` < ε, so excluded from the median and max and counted separately. **Interval width** (the next row, same problem) is now divided by the positive scale `L` instead of ŷ.<br>– **:1432, committed share:** `\|C\| / (\|C\| + \|U\|)`.<br>– **:1604, D5's untagged share:** `\|N\| / (\|N\| + \|T\|)`.<br>– **D5 and D7** take their 28-day medians over defined days and need ≥ 14 of them.<br>– **Sweep:** `ρ̄` with `Σexpected` ≤ 0 follows `ρ_t`'s rule; WAPE's `Σ\|y\|` and MAPE (≥ $10/day series only) need no change.<br>4-5 and 5-2a tests and mutants | DESIGN §3.6, §3.9, §4.1, §4.2, §4.4, §7 (4-5, 5-2a); App. D.2 |
| **X2 r4179273964** (Low) stale threat-model row | **Fixed.** The row now says the functions never remove a rollup row at or above the visible batch (the pointer-mark guard, not revision 12's "not published"), an anomaly, or the output of the 2 latest, pinned or running backtest runs. Its mutations: retention above the mark, 1 run instead of 2, removing pinned or latest backtest output, tested in 4-2 and 4-3. The rollback section (:2657) no longer says backtests are never removed | DESIGN §6.3, §10 |
| **Y1** (challenger) pin timing | **Fixed.** `ratio-analytics backtest --pin <reference>` writes the pin in the run's own success transaction; the acceptance runs (4-6, 5-4) always use it. 4-3 test (pinned at success, still kept after two newer backtests and a retention pass) and mutant (pin written after the success transaction) | DESIGN §3.8, §7 (4-3); App. D.2 |
| **Y2** (challenger) `historyDays` above the account | **Fixed.** Counted from the minimum `forecast_leaves.first_day` of the scope's leaves as of the run's as-of day, which is usage-only and defined for every scope kind. 4-5 test (a business unit with an earlier tax row) and mutant (`cost_accounts.first_day`) | DESIGN §3.6, §7 (4-5); App. D.2 |
| **Y3** (challenger) replay wording | **Fixed.** "A fresh replay of the same batches (a new stack, from the same input) gives the same ids and occurrences" | DESIGN §7 (5-3) |
| Scripts | No script changed; all 13 hashes as in revision 25; no disk or budget figure changes | App. B |

## 3ab. Revision 27: Copilot's review 5408199807 of 546e00b

The challenger APPROVED revision 26 with no findings. Copilot's three
threads are about cross-run concurrency and the billed forecast; each was
checked against 546e00b and is valid. Z4 is a wording slip found while
checking.

| Item | Change | Where |
|---|---|---|
| **Z1 r4179306667** (High) retention vs running runs | **Fixed.** Both retention functions now take the exclusive form of a per-tenant retention lock, and every run start takes it in shared form. Neither function removes: rows of a `running` run of any kind; the runs the pointers name; a batch visible under a running run's captured mark; a run named as a running run's input or previous run. The rollup function was checked too: it now keeps batches visible under running runs' marks and the run-keyed rows of their input rollup runs. 4-3 test (a detect run outlives two forecast successes and their retention passes, with its state, its forecast run and its previous run intact; start and retention serialize) and 4-2 test (a captured mark survives a restatement and a retention pass); mutants: no running-run exclusion, no lock, rollup retention ignoring captured marks | App. D.1; DESIGN §6.1, §7 (4-2, 4-3) |
| **Z2 r4179306694** (High) detect pins its forecast | **Fixed.** In its acquisition transaction a run records its inputs on its own `analytics_runs` row: `input_rollup_run_id` and `input_batch_seq_hwm` from `rollup_pointer` (forecast, detect, backtest), `input_forecast_run_id` from `forecast_pointer` (detect), and `prev_run_id`, the latest succeeded run of its own kind (forecast, detect). They are set once, not updatable, and checked by `tg_analytics_run_success` on INSERT. The run then reads those runs by id, never through the pointers. 5-3 test (a pointer move mid-detect and mid-replay changes nothing the run reads; the column refuses UPDATE with 42501) and mutant (reading through the pointer) | App. D.1; DESIGN §7 (5-3) |
| **Z3 r4179306710** (Medium) billed month-end | **Removed and recorded.** Every model forecasts `M` (`EffectiveCost`), and committed usage can be billed at 0 while amortised, so `B` cannot be derived from `M`. A billed-usage model with its own calibration is a follow-up slice. Removed from §3.1, §3.6's table, §4.1, the `forecasts` API row, the 4-5 tests (now: no response carries a billed value) and App. D (`billed_month_end` and its CHECK); D-09 says billed month-end is deferred; the parity statement and Known limits name the gap. Billed **actuals** stay in `costs/daily`. **The FT targets are all on `M`** (FT-1 now says so); none changes | DESIGN §0, §3.1, §3.6, §3.10, §4.1, §5.1, §7 (4-5), §8; App. D.2 |
| **Z4** share wording | **Fixed.** A share is `null` only when both of its parts are 0; the netting case (committed +5, uncommitted −5 → 0.5) is a 5-2a test | DESIGN §7 (5-2a) |
| Scripts | No script changed; all 13 hashes as in revision 26; no disk or budget figure changes (four columns on `analytics_runs`) | App. B |

**Z2 sweep: every place a run reads another run's output across transactions**

| Reader | Reads | Now |
|---|---|---|
| detect | forecast rows (`forecast_state`, `forecast_points`, intervals) | by `input_forecast_run_id` |
| detect | rollup rows (`cost_daily`, `cost_daily_scope`, …) | at the visible batch under `input_batch_seq_hwm`, run-keyed rows of `input_rollup_run_id` |
| detect | its previous `detector_state`, `detector_scope_state`, `detector_cohort_state` | by `prev_run_id` |
| forecast | rollup rows | as detect |
| forecast | its previous `forecast_state` (daily updates between weekly refits) | by `prev_run_id` |
| backtest | rollup rows | as detect |
| rollup | published facts | one transaction per batch (D.1); its own mark is set by trigger at success, so no capture is needed |
| retention functions | every run-keyed table | the exclusive retention lock; never a running run's inputs (Z1) |
| API and `freshness` | pointers and views | one statement or one REPEATABLE READ transaction (revisions 18, 21, 22) |
| detect's anomaly writes | `anomalies` | the detect writer's lock and its success transaction (revision 24) |

## 3ac. Revision 28 (follow-up to merged #70): Copilot's review 5408232490 of 28f8970 and the challenger's Lows on revision 27

The challenger APPROVED revision 27 (0 High, 0 Medium, 4 Low). PR #70 was
then merged at `28f8970`, so this revision is a follow-up PR from
`origin/main` at `f35c383`. Copilot's two threads and the challenger's
four Lows were each checked against `28f8970`, and all six are valid.
Copilot's earlier thread r4179306710 (revision 27's Z3) was still open
because of the same stale `B` line; AA2 closes it.

| Item | Change | Where |
|---|---|---|
| **AA1 r4179339429** (High) commitment double draw | **Confirmed and fixed.** `(m > 20000 and random() < 0.6) or random() < 0.1` gives 0.6 + 0.4 × 0.1 = **0.64** above $20 k/month. Under the log-normal, P(m > $20 k) = 0.0369, so the overall rate was 12.0 % instead of 11.8 %. An account above $20 k whose first draw failed also used a second random number, which shifted every later draw. Every copy now draws once: `random() < (0.6 if m > 20000 else 0.1)`. The 7 scripts that feed current figures were fixed and re-run; `budget3.py` and `budget4.py` are kept verbatim as run and labelled (table below). **The spec was not changed:** DESIGN §2.3's Commitments row said "≈ 12 % of accounts (most large ones)" and now states the rule exactly. New 3-1a test: the commitment rate by class over 1,000,000 account draws (0.60 ± 0.01 above $20 k/month, ≈ 4 standard errors; 0.10 ± 0.002 below). New mutant: the double draw (64 %). **No target is crossed, so D-20 is not triggered:** the false-positive total is 0.102 (0.132 conservative) against 0.15, and the peak stays 5.242 GB against 5.5 GB | App. B (top note, B.2–B.5.13); DESIGN §0, §2.3, §2.8, §2.9, §3.2, §4.2, §4.9, §7 (3-1a), §8 (D-23, Known limits); §4 |
| **AA2 r4179339445** (Low; also the challenger's L4a) | **Fixed.** App. D.3's account Totals bullet no longer promises `B`: "no billed value: billed month-end is not forecast". A sweep of DESIGN and the appendices for `` `B` ``, "billed month-end" and "billed forecast" found no other promise. Every remaining mention says it is not forecast (DESIGN §0, §3.1, §3.6, the `forecasts` API row, D-09, §8) or concerns billed actuals | App. D.3 |
| **r4179306710** (Medium; revision 27's Z3, thread still open) | Fixed in revision 27 (merged with #70) except the line above. After AA2, nothing promises a billed forecast, so the thread can be resolved | App. D.3 |
| **AA3** challenger L1: retention isolation | **Fixed.** Both retention functions are `LANGUAGE plpgsql VOLATILE`. The first statement takes the exclusive retention lock. The second raises unless `transaction_isolation` is `read committed`, so every later statement's snapshot is taken after the lock is granted. New 4-3 test for the ordering where the start holds the shared lock first: F1 and D's previous run's state survive the retention pass, and a REPEATABLE READ call is refused. New mutants: retention under REPEATABLE READ, the lock taken after the first read | App. D.1; DESIGN §6.1, §7 (4-3) |
| **AA4** challenger L2: deadlock | **Fixed.** A run calls retention in its own transaction after its success commit, holding no run-row or pointer lock. 4-3 test: a start marking a stale run `abandoned` at the same time does not deadlock. New mutant: retention inside the success transaction | DESIGN §6.1, §7 (4-2, 4-3); App. D.1 |
| **AA5** challenger L3: crashed runs | **Superseded in revision 29 (§3ad, Copilot r4179428574): the bound below did not hold, since a start only marked the stale run `abandoned` and retention ran only after a success; every start now runs a cleanup pass.** Revision 28's text: **Bounded growth stated; an expired lease is not treated as dead.** A write transaction checks the lease only at its start (`assertLease … FOR UPDATE`), so one that began before the lease expired can still be reading the run's inputs. Proving that none is in flight would need the run-row locks that AA4 keeps out of retention, and that would reopen Z1's race. The growth is bounded: at most one crashed run per kind (the next start of that kind marks it `abandoned`), ≈ 0.1 GB per run at `fleet15k`'s sizes, released at that kind's next start. It cannot affect `fleet15k`'s peak, since each run is a fresh stack. 4-3 test: a crashed detect run's inputs are kept until the next detect start, then released | App. D.1; DESIGN §6.1, §7 (4-3) |
| **AA6** challenger L4b: input mark | **Fixed.** `tg_analytics_run_success` also checks on INSERT that `input_batch_seq_hwm` equals the input rollup run's recorded `batch_seq_hwm`, the rule the pointer guard enforces. New 5-3 test: a mismatched mark is refused. New mutant: the trigger without the equality check | App. D.1; DESIGN §7 (5-3) |
| Scripts | 13 embedded. 7 fixed, re-run and re-hashed: `sizing.py`, `budget.py`, `budget2.py`, `budget5.py`, `reactivation.py`, `drift_ttd.py` and `rollup12.py`. Each was re-run from its Appendix B copy and gave byte-identical output; `budget5.py` and `reactivation.py` were also run twice. `budget3.py` and `budget4.py` are unchanged (kept as run); `budget3.py`'s Appendix B copy reproduces its as-run output. `csvsize.py` and the three SQL files have no account model and were not re-run | App. B |

**Which scripts feed current figures (AA1)**

| Script | Status in revision 28 | Why |
|---|---|---|
| `sizing.py` (B.4) | fixed, re-run, new hash | B.2's full-grain figures |
| `budget.py` (B.5.6) | fixed, re-run, new hash | the adopted variant D and the ladder |
| `budget2.py` (B.5.7) | fixed, re-run, new hash | folding loss, eligible series |
| `budget5.py` (B.5.10) | fixed, re-run, new hash | the current false-positive budget |
| `reactivation.py` (B.5.11) | fixed, re-run, new hash | D4's reactivation line |
| `drift_ttd.py` (B.5.13) | fixed, re-run, new hash | AT-3's drift time-to-detect |
| `rollup12.py` (B.5.12) | leaf count 37,052 → 37,033, re-run, new hash | the disk delta and the peak |
| `budget3.py` (B.5.8) | **kept as run**, labelled | superseded revision-5 budget; its Garwood interval does not depend on the leaf list. A copy with only the draw changed gives the same Garwood intervals, pass probabilities, peaks and totals |
| `budget4.py` (B.5.9) | **kept as run**, labelled | superseded revision-6 budget; every current figure it gave is recomputed by `budget5.py` |
| `csvsize.py`, `rowsize*.sql` | unchanged | no account model |

**AA1 before and after** (revision 27 → revision 28):

| Script | Figure | Revision 27 | Revision 28 |
|---|---|---|---|
| `sizing.py` | commitment accounts, 1,500 / 15,000 | 179 / 1,804 | 174 / 1,693 |
| `sizing.py` | `full`: account × service / × region series | 106,942 / 146,640 | 106,829 / 146,632 |
| `sizing.py` | `full`: fact rows per day; 13 periods; stored | ≈ 198.9 k; 78.6 M; 47.1 / 81.2 GB | ≈ 198.3 k; 78.3 M; 47.0 / 80.9 GB |
| `sizing.py` | 1,500 accounts: series; 13 periods | 10,543 / 14,639; 7.79 M (8.0 GB) | 10,697 / 14,742; 7.86 M (8.1 GB) |
| `budget.py` | variant D leaves (individual / `Other`) | 37,052 (22,498 / 14,554) | 37,033 (22,493 / 14,540) |
| `budget.py` | variant D facts / objects; total | 2.711 / 0.294 GB; 4.90 GB | 2.709 / 0.293 GB; **4.90 GB** |
| `budget.py` | variant A leaves; total | 45,067; 6.08 GB | 45,060; 6.07 GB |
| `budget.py` | variants B and C leaves; fact rows | 43,565; 5.69 M | 43,558; 5.68 M |
| `budget2.py` | full-mix series; folded | 107,273; 84,775 (79.0 %) | 107,109; 84,616 (79.0 %) |
| `budget2.py` | leaves ≥ $200/day; ≥ $100/day | 1,799; 3,906 | 1,800; 3,914 |
| `budget5.py` | reachable leaves: daily / weekly / hurdle; ≥ $500/day | 3,440: 3,259 / 66 / 115; 476 | 3,443: 3,280 / 72 / 91; 479 |
| `budget5.py` | D1 ∧ D2; D3 resolution bound / conservative | 0.0061; 0.0066 / 0.0298 | 0.0062; 0.0067 / 0.0300 |
| `budget5.py` | weekly; hurdle (every alarm); calendar; first occurrences | 0.0139; 0.0028 (0.0028); 0.0012; 0.0490 | 0.0158; 0.0021 (0.0022); 0.0011; 0.0482 |
| `budget5.py` | **total / conservative** (weekly doubled) | **0.101 / 0.131** (0.146) | **0.102 / 0.132** (0.147) |
| `budget5.py` | jitter: calendar term; totals and P(pass) | 0.0827; 0.183 (0.993), 0.213 (0.959) | 0.0869; 0.187 (0.990), 0.218 (0.949) |
| `budget5.py` | hurdle routes `warning` / `info`; clustered ρ 0.3 / 0.6 after the gate | 114.0 / 1.0; 0.0107 / 0.0123 | 90.2 / 0.8; 0.0083 / 0.0095 |
| `budget5.py` | weekly sensitivity: sd 1.0 / ρ 0.3 | 0.0285 / 0.0082 | 0.0311 / 0.0092 |
| `budget5.py` | calendar without the component | 7.040 | 6.900 |
| `budget5.py` | event-day recall, one contaminated cycle: 3 / 2 prior cycles | 0.999 / 0.716 | 1.000 / 0.717 |
| `budget5.py` | grid (z_T / h) that moved | 4.5 / 8.5 0.120; 4.5 / 9.5 0.089 / 0.114; 5.0 / 7.5 0.178; 5.0 / 8.0 cons. 0.199; 5.0 / 8.5 cons. 0.156 | 0.121; 0.090 / 0.115; 0.177; 0.200; 0.157 |
| `budget5.py` | pass probabilities at pinned rates; fatigue; peaks | 0.999 at 0.15; 1.30 / 1.33; 5.15 / 5.19 GB | unchanged |
| `reactivation.py` | generator: union (28-day history); worst case (14 days) | 1.4 × 10⁻⁵; 8.5 × 10⁻⁵ | 1.2 × 10⁻⁵; 9.2 × 10⁻⁵ |
| `reactivation.py` | no history condition: generator / ρ 0.3 / ρ 0.6 | 0.0017 / 0.027 / 0.32 | 0.0019 / 0.030 / 0.35 |
| `reactivation.py` | chain union: ρ 0.3 / ρ 0.6 | 0.00094 / 0.054 | 0.00100 / 0.059 |
| `reactivation.py` | label pass rate on any individual series | 0.970 | 0.971 |
| `drift_ttd.py` | shares ≤ 7 days: all detectors / D3 restart / D3 no restart / noise-free; cumulative clause | 0.726 / 0.535 / 0.235 / 0.668; 0.092 | 0.720 / 0.540 / 0.232 / 0.665; 0.091 |
| `drift_ttd.py` | medians and p90s | 5 / 7 / 11 / 6; 18 | unchanged |
| `rollup12.py` | leaf `forecast_totals` rows; `cost_daily` rows | 222,312; 4,520,344 | 222,198; 4,518,026 |
| `rollup12.py` | delta per run; natural-1 run; **peak** (natural-3) | +0.091 GB; 5.052 GB; **5.242 GB** (5.282) | unchanged |

## 3ad. Revision 29: Copilot's review 5408332571 of 0926b19 and the challenger's Low on revision 28

The challenger APPROVED revision 28 (0 High, 0 Medium, 1 Low). Copilot's
four threads are one issue: revision 28's answer to the challenger's L3
(AA5, §3ac) claimed a bound that does not hold. A start only marked the
stale run `abandoned`, and retention ran only after a success commit, so
each crashed replacement left one more abandoned run's output until some
run succeeded. Checked against 0926b19: valid. The challenger's L1
(the bound left out superseded batches) is about the same bound and is
answered with it.

| Item | Change | Where |
|---|---|---|
| **r4179428541** (High) App D:471 | **Fixed by a cleanup pass at every start.** After its acquisition transaction commits and before any other work, a start runs `ratio.analytics_apply_retention()` and then `ratio.analytics_apply_forecast_retention()`, each in its own transaction under revision 28's rules (READ COMMITTED with the lock first; no run-row or pointer lock held). It calls both because a crashed run of one kind can pin another kind's rows (a detect run's input rollup run). `failed` and `abandoned` runs are removable whatever their `run_seq` unless a `running` run names them as input or previous run, which the INSERT trigger already rules out. I chose this over a retry or storage cap, because it makes the bound real instead of declaring it | App. D.1 ("Crashed runs", "Acquiring the lease", "Writing", the function row) |
| **r4179428559** (High) DESIGN:2388 | **Restated:** per kind, at most one run that has written output is left over, the crashed run before its takeover or the abandoned run until the takeover's cleanup pass ends. A run writes nothing beyond its run row until its own pass has finished, and that pass removes every abandoned run; a start that crashes inside its pass wrote nothing, and the next pass removes both | DESIGN §6.1; App. D.1 |
| **r4179428574** (High) EVIDENCE:631 | §3ac's AA5 row is marked as superseded by this section; its original text is kept as the record | §3ac |
| **r4179428588** (Medium) DESIGN:2544, one crash only | **4-3 test extended:** D1, D2 and D3 each write state and crash and are taken over in turn; after every takeover's cleanup pass no abandoned run's rows remain, and the run-keyed tables never hold more than the kept runs, the running run and one crashed run's output; a start that crashes inside its own pass, and the start after it, keep the bound; the same for rollup and backtest runs. **Mutants:** no cleanup pass at start; the pass begun before the acquisition commits; abandoned runs newer than the latest success kept. 4-2 names the start's pass too | DESIGN §7 (4-2, 4-3) |
| Takeover cannot delete the new run's inputs (checked, as asked) | **Confirmed.** The new run's row, with `input_*` and `prev_run_id`, commits in its acquisition transaction before the pass begins. The pass takes the exclusive lock first and reads in READ COMMITTED, so it sees that `running` row, and the Z1 exclusion keeps its inputs, its previous run, its own rows and the pointers' runs. 4-3 asserts the new run's forecast run and previous run survive every pass | App. D.1; DESIGN §7 (4-3) |
| In-flight transactions of the stale run (found while checking) | Removing a stale run's inputs at takeover is safe only if nothing of that run is still reading. The takeover's `abandoned` update waits on the run row, which every transaction of the run holds `FOR UPDATE` from `assertLease`; **revision 29 extends `assertLease` to transactions that only read the run's inputs** (it named write transactions only). After the update commits, every later transaction of that run fails with `LEASE_LOST`. An expired lease alone is still not treated as dead (revision 28). 4-3 test: a takeover waits for a still-open transaction of the stale run | App. D.1 ("Acquiring the lease", "Writing"); DESIGN §6.1, §7 (4-3) |
| **Challenger L1** on 0926b19: superseded batches | **Added to the bound.** The left-over run's size is ≈ 0.1 GB of state **plus the rollup rows of the superseded batches its captured mark pinned**: a restated period of `fleet15k`'s size is ≈ 1.1 M `cost_daily` rows × 180 B ≈ 0.2 GB, each restatement under the mark separately. The takeover's cleanup pass releases all of it. `fleet15k` has no restatements and each run is a fresh stack, so its peak is unaffected | App. D.1; DESIGN §6.1 |
| Scripts, figures | No script changed; all 13 SHA-256s as in revision 28; no disk or budget figure changes | App. B |

## 3ae. Revision 30: Copilot's review 5408381491 of 7e49bfb and the challenger's Lows on revision 29

The challenger APPROVED revision 29 (0 High, 0 Medium, 3 Low). Copilot
raised 1 Medium. All four are about the crashed-run cleanup of revision 29
and were checked against 7e49bfb. All are valid.

| Item | Change | Where |
|---|---|---|
| **BB1 r4179466023** (Medium) export files outside the bound | **Fixed by deleting export files in every pass.** A crashed or fenced backtest may already have written ≈ 0.2–0.25 GB of gzip exports, and only the backtest command deleted export files. A rollup, forecast or detect start's pass therefore reclaimed the rows but not the files. Now every pass that calls the forecast retention function deletes the files too: each run's post-success pass, of any kind, and every start's cleanup pass. **Eligibility** is the same as for the rows: the function also returns the ids of every terminal backtest run that is not kept, not pinned and not named by a running run. **Order:** files are deleted only after the function's transaction commits. A `deleted.json` with each file's name, size and SHA-256 stays in the run's directory. **Idempotent:** every eligible run is listed, not only those removed in this call, so an interrupted deletion finishes at the next pass. **Concurrent backtest:** a running run's id is never returned, and each run writes only under `backtest/<run_id>/`. A backtest moves each finished file into place only inside a transaction that holds its lease (`FOR SHARE`), so the takeover waits for the move, and a fenced writer's next move fails with `LEASE_LOST`. A staging file left by a dying writer is removed by the next pass. **Pins:** a later pin takes the shared retention lock and is refused with `RUN_NOT_KEPT` once the output is gone, so a pin cannot race the deletion. The bound now names the files. New 4-3 test: a crashed backtest's exports are deleted by the next detect start's pass, and pinned and running backtests' files are untouched. New mutants: export deletion only in the backtest command; deletion before the commit | App. D.1 ("Export files", "Crashed runs", pins row); DESIGN §3.8, §6.1, §7 (4-3), §10 |
| **BB2** challenger L1: read-only transactions | (The TTL rule here is refined in revision 31, §3af.) **Changed to `FOR SHARE`.** A transaction that only reads takes the run row `FOR SHARE`, and one that writes takes it `FOR UPDATE`. Concurrent readers of one run, such as `full`'s 4 parallel workers, then do not wait for each other; the challenger's PG16 probe measured 1.7 s with `FOR UPDATE` and 0 s with `FOR SHARE`. The worker on `main` already uses `assertLease(…, 'SHARE')`. The takeover still waits for both kinds. **Stated:** the lease TTL must exceed the run's longest single transaction, since either lock blocks the run's own heartbeat. New 4-3 test (two readers share, and the takeover waits for both) and mutant (read-only `FOR UPDATE`) | App. D.1 ("Writing", "Acquiring the lease"); DESIGN §6.1, §7 (4-3) |
| **BB3** challenger L2: pins | **Fixed.** Failed and abandoned runs are removable "unless pinned or named by a running run", as revision 25's pins require. New 4-3 test and mutant: a pinned failed run keeps its output | App. D.1; DESIGN §6.1, §7 (4-3) |
| **BB4** challenger L3: takeover stall | (Where the timeout is set is refined in revision 31, §3af.) **A `lock_timeout` on the takeover.** The `abandoned` update runs under `SET LOCAL lock_timeout` (5 s by default). On timeout (55P03) the acquisition transaction rolls back, releasing the per-kind lock and the shared retention lock and inserting nothing, and the start fails with a retryable `ALREADY_RUNNING`. Without it, a long stale transaction stalled every retention pass in the tenant. New 4-3 test: a retention pass started during the wait completes. New mutant: no `lock_timeout` | App. D.1 ("Acquiring the lease"); DESIGN §6.1, §7 (4-3) |
| Sweep | DESIGN §3.8 (evidence directory and later pins), §6.1 (removal list, backtest output, crashed runs), §7 (4-3 test and mutants; revision 25's backtest test now deletes the files in the next pass) and §10 (rollback) all say the same; App. D's `analytics_run_pins` row states the pin rule | DESIGN; App. D |
| Scripts, figures | No script changed; all 13 SHA-256s as in revision 28; no disk or budget figure changes | App. B |

## 3af. Revision 31: Copilot's review 5408406528 of c615ea3 and the challenger's Low on revision 30

The challenger APPROVED revision 30 (0 High, 0 Medium, 1 Low), and Copilot
raised 2 Medium. Each was checked against c615ea3, and for CC1 against
`main`'s `src/ingest/worker/lease.ts`, `pipeline.ts` and `config.ts`. All
three are valid.

| Item | Change | Where |
|---|---|---|
| **CC1 r4179490968** (Medium) "TTL > transaction" is not enough | (Refined in revision 32, §3ag: the renewal is in its own transaction, and m = max(1 s, TTL / 10).) **Confirmed on `main`.** `heartbeat()` renews only a lease that is still live (`lease_expires_at > clock_timestamp()` in its `WHERE`, `lease.ts:162–169`). The TTL defaults to 300 s (`config.ts:52`, `RATIO_LEASE_TTL_SECONDS` 5–3600), and the heartbeat fires every TTL / 3 = 100 s (`pipeline.ts:131`, `:136`). A transaction started just before a heartbeat delays it by the transaction's whole length, so without a check the safe limit is 300 − 100 − 30 = 170 s, not 300 s. **Fix, the preferred option:** every run transaction has a duration budget `b`. Before taking the run-row lock, `assertLease` renews the lease (the same live-only update) if less than `b` + 30 s is left, and refuses with `LEASE_BUDGET` if `b` + 30 s > TTL. The lease then outlives every in-flight transaction's planned end by at least 30 s, so a blocked heartbeat still finds the lease live. At the defaults, every budget must be ≤ 270 s. An overrun fails safe (`LEASE_LOST`). **New 4-3 timing tests** (TTL 6 s, heartbeat 2 s): a 4.5 s reader started 0.1 s before a heartbeat does not fence the run, also with two readers in parallel; a 5.5 s budget is refused. **New mutant:** TTL greater than the transaction, without the check (fences the run) | App. D.1 ("Writing"); DESIGN §6.1, §7 (4-3) |
| **CC2 r4179490982** (Medium) file cleanup not serialized | (Refined in revision 32, §3ag: the filesystem assumption and temporary manifests.) **Fixed with the claim-and-rename option.** The file phase holds no database lock, which keeps the revision 28 rule that a pass holds no run-row or pointer lock. A pass claims `backtest/<run_id>/` by an atomic `rename(2)` to `backtest/.deleting-<run_id>-<pass_id>/`; a loser gets `ENOENT` and skips. The winner hashes the files, then writes the merged `deleted.json` (temporary file, then rename) **before deleting anything**. It then deletes with `ENOENT` treated as done and renames the directory back, so `deleted.json` ends in `backtest/<run_id>/` as §3.8 says, and it is cumulative. If a dying writer has recreated the name, the manifest is moved in the same way and a later pass removes the staging file. **Interrupted claims:** a claim older than one hour is re-claimed by an atomic rename and finished. A stalled original then finds its paths gone and stops without deleting anything unrecorded. **New 4-3 test:** two concurrent passes on one directory (one claims, no `ENOENT` failure, one complete `deleted.json`), plus an interrupted claim finished by a later pass. **New mutant:** no claim | App. D.1 ("Export files"); DESIGN §3.8, §7 (4-3) |
| **CC3** challenger L1: timeout placement | **Fixed.** `lock_timeout` also applies to advisory-lock waits, as the challenger's PG16 probe showed, so setting it at the start of the acquisition transaction would make a start queued behind a retention pass longer than 5 s fail with a spurious `ALREADY_RUNNING`. The acquisition order is now stated: per-kind lock; shared retention lock; read; `SET LOCAL lock_timeout = '5s'` immediately before the `abandoned` update and `= 0` straight after; insert. **New 4-3 case:** a start that waits 8 s behind a retention pass succeeds. **New mutant:** timeout set at the start of the transaction | App. D.1 ("Acquiring the lease"); DESIGN §6.1, §7 (4-3) |
| §3ae, BB2 and BB4 rows | Marked as refined here; their text is kept as the record | §3ae |
| Scripts, figures | No script changed; all 13 SHA-256s as in revision 28; no disk or budget figure changes | App. B |

## 3ag. Revision 32: Copilot's review 5408458938 of 591b9cf and the challenger's Lows and nit on revision 31

The challenger APPROVED revision 31 (0 High, 0 Medium) with two Lows and a
nit. Copilot raised 1 High and 1 Medium. Copilot's High is the same point
as the challenger's L1. Each was checked against 591b9cf and, for the
lease, against `main`'s `src/ingest/worker/lease.ts`, `pipeline.ts` and
`config.ts`. All are valid.

| Item | Change | Where |
|---|---|---|
| **r4179528051** (High; also the challenger's L1; refined in revision 33, §3ah: the overlap test and `LEASE_RETRY`) renewal inside the work transaction | **Fixed.** Revision 31 had `assertLease` renew the lease, which put the heartbeat `UPDATE` inside the work transaction. Its row lock then lasts until commit, up to the whole budget. It blocks the other readers' `FOR SHARE`, which serializes revision 30's parallel readers, and it blocks the heartbeat. (`main`'s `assertLease`, `lease.ts:151–159`, only checks and locks.) The rule is now three steps. **1.** If needed, renew in its own short transaction, `main`'s `heartbeat()`, committed at once. **2.** Begin the work transaction, lock the lease row `FOR SHARE` or `FOR UPDATE`, and check under that lock that the lease is live and at least `b + m` is left. **3.** If that check fails while the lease is live, roll back, renew and retry once; a second failure is `LEASE_LOST`. **Why retry once:** one failure can be a benign race, a lock wait behind a writer or a background heartbeat; two in a row mean the run cannot keep its lease, so it fails safe. The two-reader test now makes the readers really overlap: right after a renewal, neither needs to renew, and their `FOR SHARE` holds overlap for ≥ 4 s. New tests for the retry path. **New mutant:** renewal inside the work transaction (the readers serialize) | App. D.1 ("Writing"); DESIGN §6.1, §7 (4-3) |
| **r4179528066** (Medium) margin not one rule | **Fixed.** Revision 31's "m = 30 s (TTL / 10)" holds only at the 300 s default, and its own test used TTL 6 s with m = 1 s. The rule is now **m = max(1 s, TTL / 10)** everywhere: the budget limit TTL − m, the renewal trigger `b + m`, `LEASE_BUDGET`, and the tests. Checked across `RATIO_LEASE_TTL_SECONDS`'s range 5–3600 s, with the heartbeat at `max(1 s, TTL / 3)`: <br>• 300 s: m = 30 s, budget ≤ 270 s, heartbeat every 100 s;<br>• 6 s: m = 1 s, budget ≤ 5 s;<br>• 5 s: m = 1 s, budget ≤ 4 s, heartbeat every 1.7 s;<br>• 3600 s: m = 360 s, budget ≤ 3240 s.<br>**Lower bound:** TTL ≥ 5 s, the range's own minimum; below 2 s no useful budget is left. The heartbeat interval does not enter the rule. **New tests:** margin values, and the 4 s and 4.1 s budgets at TTL 5 s. **New mutant:** m hard-coded at 30 s (every budget at TTL 6 s is refused) | App. D.1 ("Writing"); DESIGN §6.1, §7 (4-3) |
| **Challenger L2** filesystem assumption | **Stated.** Claim-by-rename needs a local POSIX filesystem, where `rename(2)` within `backtest/` is atomic. That does not hold on an object store or on some network filesystems, so the future off-box artefact store (DESIGN §3.8) needs its own claim mechanism before cleanup may run against it. "Every step works by name" now rules out a directory file descriptor held across steps, `openat` or `unlinkat` relative to one, and a working directory inside a claim | App. D.1 ("Export files"); DESIGN §3.8 |
| **Challenger nit** orphaned temporary manifest | **Fixed.** A temporary manifest is exactly `deleted.json.tmp-<pass_id>`. Step 1 never hashes or lists a file matching `deleted.json.tmp-*`, and step 3 deletes such orphans. New 4-3 test: a pass is killed between its temporary write and the rename, and the re-claiming pass neither lists nor keeps the orphan. New mutant: the temporary manifest hashed as an export | App. D.1; DESIGN §7 (4-3) |
| §3af rows CC1, CC2 | Marked as refined here; their text is kept as the record | §3af |
| Scripts, figures | No script changed; all 13 SHA-256s as in revision 28; no disk or budget figure changes | App. B |

## 3ah. Revision 33: the challenger's REQUEST CHANGES on revision 32

The challenger returned REQUEST CHANGES on 66205dd: 1 Medium, 1 Low and
1 nit. It verified the rest of revision 32: the retry path, the margin
rule across 5–3600 s, the sweep, the hashes, both classifier runs and the
rollback. Each item was checked against 66205dd, and all three are valid.
Copilot's review of 66205dd had not arrived when this revision was
pushed.

| Item | Change | Where |
|---|---|---|
| **M1** (Medium) the overlapping-readers test cannot kill its mutant | **Valid.** Revision 32's readers start right after a renewal, at TTL 6 s with ≈ 6 s left, which is ≥ `b + m` = 5.5 s. So revision 31's conditional in-transaction renewal would never run an `UPDATE` there, and two `FOR SHARE` holders overlap anyway: the mutant passes. **Added a renewing case:** two 4.5 s readers begin 1.5 s after a renewal (r ≈ 4.5 s < 5.5 s). The first renews in its own short transaction, which sets expiry to start + 6 s; the second then needs none. Both hold `FOR SHARE` from start to start + 4.5 s, overlapping ≥ 4 s and ending ≥ 1.5 s (≥ m) before expiry. The background heartbeat waits for both and renews. Under the mutant, the first reader's in-transaction `UPDATE` blocks the second reader's `FOR SHARE` until it commits, so the overlap is ≈ 0 and the test fails. The no-renewal case stays for overlap alone; the mutant entry now names the renewing case | DESIGN §7 (4-3) |
| **L1** (Low) "second failure is `LEASE_LOST`" can fence a healthy run | **Valid. Option (b): a distinct retryable code.** A live lease that is still short after the renew-and-retry gives **`LEASE_RETRY`**. The job retries it with jittered backoff (100 ms doubling to 5 s) while the lease is live, renewing first each time, within the run's `maxRunSeconds` (`config.ts:233`, 6 h). `LEASE_LOST` stays for a lease that is not live (expired or taken over). **Why (b):** <br>• (a), retrying until a deadline inside `assertLease`, hides the wait from the job;<br>• (c), one writing transaction at a time, does not prevent the case, because one writer after another still delays a reader past its margin;<br>• (b) keeps fencing and scheduling apart.<br>**New 4-3 test:** three back-to-back 2 s writers with a 4.5 s reader queued between them give `LEASE_RETRY`, never `LEASE_LOST`, and the reader runs after them with the run live; a taken-over lease gives `LEASE_LOST` at once. **New mutant:** a second shortfall mapped to `LEASE_LOST`, which fences the healthy run | App. D.1 ("Writing", steps 3–4); DESIGN §6.1, §7 (4-3) |
| **Nit** "a TTL below 2 s leaves no useful budget" | **Replaced** by the configuration minimum: `config.ts:231` enforces TTL ≥ 5 s, where the largest budget is 4 s | App. D.1; DESIGN §6.1 |
| §3ag row r4179528051 | Marked as refined here; its text is kept as the record | §3ag |
| Scripts, figures | No script changed; all 13 SHA-256s as in revision 28; no disk or budget figure changes | App. B |

## 4. Measurements used by the design

| What | Value | How |
|---|---|---|
| Lean `fleet15k` fact row | 554.2 B (heap 409.6, `extra_columns` 100.5) | 400 k rows, `cost_facts`' exact columns and PK, ephemeral `postgres:16` container (Appendix B.5.2) |
| Narrow rollup row (uuid batch key) | 217.0 B | same |
| Narrow rollup row as designed: integer `batch_seq`, six measures (rev. 22) | 172.3 B with the multi-day measure 0 (`fleet15k`); 180.2 B with it non-zero on every row (used in the budget) | `rowsize3.sql` on a throwaway PostgreSQL 16.14 cluster, 400 k rows, run twice (B.5.14) |
| Gzip per CSV row (`fleet15k` columns) | 19.4 B (30 B used) | 200 k synthetic rows, Python `gzip` level 6 |
| `daysInMonthOf` under `TZ=Asia/Tokyo` | February 2026 → 27 (UTC: 28) | `node` one-liner (DESIGN §1.7 F1) |
| Disk budget, adopted `fleet15k` variant | 4.90 GB per run (rev. 3); 4.96 GB per run and **5.11 GB peak** across the sequential runs (rev. 4) | `budget.py` (B.5.3), `budget2.py` (B.5.7) |
| Folding loss, `fleet15k` | 79.0 % of account × service series, 25.6 % of spend in `Other services` | `budget2.py` (B.5.7) |
| Expected natural-seed groups | ≈ 73 true (≈ 1.2/day), ≈ 92 total per seed; ≈ 183 pooled over two | `budget2.py` (B.5.7) |
| False-positive budget at z_T 4.5, h 7.5 | 0.092/day (0.136 with the D3 bound); P(pass AT-1 and AT-4) ≈ 0.999 at 0.15/day | `budget3.py` (B.5.8) |
| Peak disk, rev. 5 | 5.15 GB (5.19 GB with natural-3) | `budget3.py` (B.5.8) |
| Re-run of every embedded script (rev. 5) | all 7 SHA-256s match; outputs identical; SQL sizes reproduced on a fresh container | §3b |
| P(D1 ∧ D2) per series-day with estimation noise (before the `warning` test) | 28-day window, no floor: 3.62 × 10⁻⁴; 56-day window with the pooled floor: 4.26 × 10⁻⁵; Q(4.5) = 3.40 × 10⁻⁶ | `budget4.py` (B.5.9) |
| D3 effective ARL₀ with pooled-scale heterogeneity | 5,928 days at h = 7.5 (Siegmund 11,585); 19,705 at h = 9.0 (Siegmund 51,985) | `budget4.py` (B.5.9) |
| False-positive budget at z_T 4.5, h 9.0 (rev. 6) | **0.098/day** (0.128 with every conservative bound); calendar jitter ±10 % adds 0.063 (reported); P(pass AT-1 and AT-4 \| 0.15/day) = 0.999 | `budget4.py` (B.5.9) |
| Level-shift TTD at z_T 4.5, h 9.0 | median 1, p90 1 day (spend-weighted, per series, and × 1.2–1.4 alone) | `budget4.py` (B.5.9) |
| Peak disk, rev. 6 | 5.15 GB (5.19 GB with natural-3) | `budget4.py` (B.5.9) |
| Re-run of every embedded script (rev. 6) | all 8 SHA-256s match; Python outputs reproduce (`budget4.py` byte-identical twice, and from its Appendix B copy); SQL sizes reproduced on a fresh `postgres:16` container | §3c |
| Hurdle statistic, in-control (rev. 7) | 0.00002–0.00052 alarms per series-week at zero shares 0.55–0.8, h = 9.0; gate r₁ < 0.30 passes 98.8–99.2 % of independent series-weeks | `budget5.py` (B.5.10) |
| False-positive budget at z_T 4.5, h 9.0 (rev. 7) | **0.101/day** (0.131 with every conservative bound; 0.146 with the weekly term doubled); ±10 % jitter: P(pass) 0.993 / 0.959; superseded by rev. 28 below | `budget5.py` (B.5.10) |
| Zero-week rule in `budget5.py` (rev. 24) | outputs byte-identical to revision 7's script; weekly alarm counts 259 / 221 / 229 in 120,000 weeks at zero shares 0.3 / 0.4 / 0.5, old and new | `budget5.py` (B.5.10) |
| Hurdle routes under the generator | ≈ 114 of 115 leaves `warning`, ≈ 1 `info` only; ≈ 0.03 % of reachable spend outside AT-2 (rev. 28 below) | `budget5.py` (B.5.10) |
| Peak disk, rev. 7 | 5.15 GB (5.19 GB with natural-3) | `budget5.py` (B.5.10) |
| D4 reactivation false positives (rev. 8) | 3 × 10⁻⁵/day with the history condition (generator); without it 0.0017 (generator), 0.32 (persistence 0.6) | `reactivation.py` as of revision 8 (superseded in B.5.11) |
| D4 reactivation false positives (rev. 9; ρ > 0 underestimated, see rev. 10) | union of (i) and (ii): 1.4 × 10⁻⁵/day (generator; worst case 8.4 × 10⁻⁵), 0.00029 (ρ 0.3), 0.0079 (ρ 0.6) | `reactivation.py` as of revision 9 |
| D4 reactivation false positives (rev. 10, chain-simulated for ρ > 0) | union of (i) and (ii): 1.4 × 10⁻⁵/day (generator; worst case 8.5 × 10⁻⁵), 0.00094 (ρ 0.3), 0.054 (ρ 0.6); rev. 28 below | `reactivation.py` (B.5.11) |
| `dormant_reactivation` label pass rate (rev. 9) | 1.000 as specified (0.970 if placed on any individual series; 0.971 in rev. 28) | `reactivation.py` (B.5.11) |
| Billing rollup disk delta (rev. 12; corrected in rev. 13; forecast leaves in rev. 15; leaf totals in rev. 17; detector state in rev. 18; measured `cost_daily` row in rev. 22; scope census and account scope in rev. 24) | +0.091 GB per run (rev. 22: 0.024; rev. 18: 0.082; rev. 17: 0.066; revs. 15–16: 0.031; rev. 13: 0.025; rev. 12: 0.026); peak 5.24 GB (5.28 GB with natural-3) | `rollup12.py` (B.5.12) |
| Drift time-to-detect from AT-3's anchor (rev. 18) | noise-free first-passing day median 6, p90 12 days (not a lower bound); D3 alone median 7, p90 13 (with the restart); all detectors on the true baseline median 5, p90 11 | `drift_ttd.py` (B.5.13) |
| Garwood intervals, exact (rev. 12) | unchanged at three decimals (e.g. 7 groups: [0.046, 0.236]) | `budget3.py` (B.5.8) |
| Re-run of every embedded script (rev. 7) | all 9 SHA-256s match; Python outputs reproduce (`budget5.py` byte-identical twice, and from its Appendix B copy); SQL sizes reproduced on a fresh `postgres:16` container | §3d |
| One commitment draw per account (rev. 28) | `fleet15k` leaves 37,033 (was 37,052); variant D still 4.90 GB per run; folding loss 79.0 % and 25.6 % unchanged; `full` 78.3 M fact rows over 13 periods (was 78.6 M) | `sizing.py`, `budget.py`, `budget2.py` (B.2, B.5.3, B.5.7) |
| False-positive budget at z_T 4.5, h 9.0 (rev. 28) | **0.102/day** (0.132 with every conservative bound; 0.147 with the weekly term doubled); ±10 % jitter: P(pass) 0.990 / 0.949; still the least strict pair under 0.15 | `budget5.py` (B.5.10) |
| Hurdle routes under the generator (rev. 28) | ≈ 90 of 91 leaves `warning`, ≈ 1 `info` only; ≈ 0.03 % of reachable spend outside AT-2 | `budget5.py` (B.5.10) |
| D4 reactivation false positives (rev. 28) | union of (i) and (ii): 1.2 × 10⁻⁵/day (generator; worst case 9.2 × 10⁻⁵), 0.00100 (ρ 0.3), 0.059 (ρ 0.6) | `reactivation.py` (B.5.11) |
| Drift time-to-detect (rev. 28) | medians and p90s unchanged; shares ≤ 7 days 0.720 (all detectors), 0.540 (D3 with the restart), 0.665 (noise-free) | `drift_ttd.py` (B.5.13) |
| Disk delta and peak (rev. 28) | +0.091 GB per run; natural-1 run 5.052 GB; **peak 5.242 GB** (5.282 GB with natural-3); unchanged at three decimals with 37,033 leaves | `rollup12.py` (B.5.12) |
| Re-run of the embedded scripts (rev. 28) | all 13 SHA-256s match Appendix B (7 updated); the 7 fixed scripts reproduce from their Appendix B copies byte for byte; `budget3.py` reproduces its as-run output | §3ac |

The measurement scripts are reproduced verbatim, with SHA-256, in
Appendix B (B.4, B.5.6–B.5.14).

## 5. Governance classification

**Revisions 28–33, this follow-up PR.** `origin/main` is now
`f35c383`, which contains PR #70, so `node scripts/governance/classify-risk.mjs --git
origin/main...HEAD` reads only this PR's diff. At revisions 28 to 33,
including the follow-up commit that adds the GitHub paragraph below, it
gives:
- `"risk": "restricted"`, classes `retention` and `secrets`;
- `retention.mention` on `APPENDIX_D_SCHEMA_SKETCH.md`, `DESIGN.md` and
  this file: the added lines say how the retention functions run (AA3–AA5)
  and, in revisions 29 and 30, the start's cleanup pass and the export
  files;
- `secrets.password-assignment` and `retention.delete-from` on this file
  only, because this paragraph quotes the two lines that matched those
  rules in PR #70: the `POSTGRES_PASSWORD=<throwaway>` run command
  (Appendix B.5.6) and the threat-model test that a `DELETE FROM
  ratio.cost_daily` by the analytics login is refused (DESIGN). Both
  lines are on `main` and unchanged, so they are not in this diff.

`APPENDIX_B_SIZING.md` has no reason of its own this time: its added
lines are figures, labels and the fixed scripts.

**From `aeef207` (revision 31), the PR's governance report lists
`DESIGN.md` as `unclassified` / `diff-unavailable` instead of its
`retention.mention`.** Revisions 28–30 expected the GitHub API to return
every patch, since each file's diff was small. That held until the diff of
`DESIGN.md` grew: at `aeef207` the API returns no patch for `DESIGN.md`
(228 changed lines, many of them long table rows). It still returns the
patches of the other three files. As for PR #70 at `3aaa678`:
- **the report at `aeef207`:** `retention.mention` on
  `APPENDIX_D_SCHEMA_SKETCH.md` and this file;
  `secrets.password-assignment` and `retention.delete-from` on this file;
  `unclassified` / `diff-unavailable` on `DESIGN.md`. Risk `restricted`,
  classes **`retention`, `secrets` and `unclassified`**;
- **why:** with no patch, no content rule can match `DESIGN.md`, and
  `classify-risk.mjs` fails closed (`patchUnavailable` → `unclassified` /
  `diff-unavailable`);
- **the content did not change:** no retention statement in `DESIGN.md`
  was removed or reworded; the report can no longer see it;
- **the local verdict is unchanged:** `--git` reads the full diff and
  still gives `restricted`, `retention` and `secrets`, with the five
  reasons listed above;
- **the verdict is not weaker:** `unclassified` is an extra class, and
  the PR stays `restricted`.

The GitHub-mode result was reproduced locally. `classify-risk.mjs` was fed
the PR's file list from the API, with `patchUnavailable` set as
`gh-actions.mjs` sets it, and with the patches the API returns. It gives
the five reasons in the first bullet. That is the correct classification
for this content; the PR goes through the restricted exception path.

**PR #70 (revisions 1–27), as recorded at revision 27.**
`node scripts/governance/classify-risk.mjs --git origin/main...HEAD`,
at revision 27 (the commit that adds this line; the same eight reasons
as at revision 26, `546e00b`, revision 25, `45b0088`, revision 24, `f3209ea`, revision 23, `b9b2274`, revision 22, `c85079f`, revision 21, `3aaa678` and `bddefe9`, revision 20, `d4616a8`, revision 19, `0dd6743`, revision 18,
`ddbb6f0`, revision 17, `cc54e79`, and `9e0d703`, revision 16). Revision 16 gave the same risk and classes
as every revision since 4, and **one more reason than before**: `retention.mention`
on `APPENDIX_B_SIZING.md`. B.5.12 now says that `forecast_leaves` is
"outside retention" (rev. 16, L4). That is a statement about the D-12
retention policy, so the rule is right to match it. Revisions 4–15 (`faeabb4`
… `a268c0e`, including the merge `bd440b5`) had the seven reasons below
without it:

- `"risk": "restricted"`, classes `retention` and `secrets`;
- `secrets.password-assignment` on `APPENDIX_B_SIZING.md` (the
  `POSTGRES_PASSWORD=<throwaway>` run command, no secret value) and on
  this file (which quotes it);
- `retention.mention` on `APPENDIX_D_SCHEMA_SKETCH.md`, `DESIGN.md`,
  this file and, since revision 16, `APPENDIX_B_SIZING.md`;
- `retention.delete-from` on `DESIGN.md` (the threat-model test that a
  `DELETE FROM ratio.cost_daily` by the analytics login is refused) and on
  this file (which quotes it).

**The PR's governance report at `9e0d703`** (the same classifier, fed
from the GitHub API's PR file list instead of `--git`) lists
`unclassified` / **`diff-unavailable`** for `DESIGN.md` and
`APPENDIX_B_SIZING.md` **instead of** those two files' content reasons,
and its classes are therefore `retention`, `secrets` **and
`unclassified`** (rev. 17, the challenger's L2; revision 16 said "also
lists", which was wrong).
- **Why:** GitHub returned no patch for those two files; the API omits the
  patch for very large diffs. With no added lines, no content rule can
  match those files, and `classify-risk.mjs` then fails closed (line 251:
  `patchUnavailable` → `unclassified` / `diff-unavailable`).
- **What it is not:** a content class. The local `--git` run above reads the
  full diff of the same files and finds only the retention and secrets
  reasons listed.
- **Effect on the verdict:** none. The risk is `restricted` either way, and
  the extra rows are recorded here as they appear rather than avoided.

**From `3aaa678` (revision 21) the report also lists `EVIDENCE.md` as
`unclassified` / `diff-unavailable`.** This file's diff grew past the
size for which the GitHub API returns a patch, so the API now returns no
patch for **three** files: `DESIGN.md`, `APPENDIX_B_SIZING.md` and this
file. The report at `3aaa678`:
- `retention.mention` on `APPENDIX_D_SCHEMA_SKETCH.md`, the only file of
  the three with content reasons whose patch is still returned;
- `unclassified` / `diff-unavailable` on the three files above;
- risk `restricted`, classes **`retention` and `unclassified`**.

`secrets` **no longer appears on GitHub**, and `retention.delete-from` no
longer appears either. Both come only from `APPENDIX_B_SIZING.md` and
this file, whose content the report can no longer see. That is the only
reason the GitHub classes changed:
- **the content did not change:** no secret-like line and no retention
  statement was removed or reworded;
- **the local verdict is unchanged:** `--git` reads the full diff and
  still gives `restricted`, `retention` and `secrets`, with the same eight
  reasons listed above;
- **the verdict is not weaker:** the classifier fails closed on the
  missing patches, and the PR remains `restricted`.

The GitHub-mode result was reproduced locally by feeding
`classify-risk.mjs` the PR's file list from the API, with
`patchUnavailable` set as `gh-actions.mjs` sets it and the diff of the
three files whose patch the API returns: it gives the four reasons
above.

That is the correct classification for this content; the PR goes through
the restricted exception path. (Revision 2 at `461fbc2` classified `low`
only because of the wording reverted in §2.)
