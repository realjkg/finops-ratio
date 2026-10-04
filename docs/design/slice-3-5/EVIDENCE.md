# Slices 3–5 design — evidence and revision history

Part of [DESIGN.md](DESIGN.md). Branch `design/slice-3-5-forecast-anomaly`,
from `origin/main` at 827773f. Design documents only. Revisions 1–4 were
not pushed by the design agent; from revision 5 the branch is on
`origin/design/slice-3-5-forecast-anomaly` and revisions are added by
ordinary commits and plain pushes (never a force-push).

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
| 17 | `77a2faf`, `f288d2f`, this revision | Copilot's review 5407588631 of 6cad4cd (6 High, 4 Medium, 1 Low), §3o: one writer per tenant and job kind for `run_seq`; one day index `t` for every detector; fan-in before persistence with merge semantics; daily excess vs cumulative impact and `ρ` at expected 0; stale wording swept. The challenger's REQUEST CHANGES on 6cad4cd (2 Medium, 4 Low), §3p: one composite FK binds a series to its leaf; separate grant, trigger and concurrent-UNIQUE tests; a CHECK for root causes without a leaf; paginated per-leaf coverage; §5 wording. Copilot's review 5407636005 of 6cad4cd (six new threads), §3q: one UPDATE column list per pointer; leaf totals stored for all three windows (disk delta +0.066 GB per run, peak 5.22 GB); the full leaf reconstruction formula; CHECKs on fixed-length arrays; "insert-only" replaced. |

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

## 4. Measurements used by the design

| What | Value | How |
|---|---|---|
| Lean `fleet15k` fact row | 554.2 B (heap 409.6, `extra_columns` 100.5) | 400 k rows, `cost_facts`' exact columns and PK, ephemeral `postgres:16` container (Appendix B.5.2) |
| Narrow rollup row (uuid batch key) | 217.0 B | same |
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
| False-positive budget at z_T 4.5, h 9.0 (rev. 7) | **0.101/day** (0.131 with every conservative bound; 0.146 with the weekly term doubled); ±10 % jitter: P(pass) 0.993 / 0.959 | `budget5.py` (B.5.10) |
| Hurdle routes under the generator | ≈ 114 of 115 leaves `warning`, ≈ 1 `info` only; ≈ 0.03 % of reachable spend outside AT-2 | `budget5.py` (B.5.10) |
| Peak disk, rev. 7 | 5.15 GB (5.19 GB with natural-3) | `budget5.py` (B.5.10) |
| D4 reactivation false positives (rev. 8) | 3 × 10⁻⁵/day with the history condition (generator); without it 0.0017 (generator), 0.32 (persistence 0.6) | `reactivation.py` as of revision 8 (superseded in B.5.11) |
| D4 reactivation false positives (rev. 9; ρ > 0 underestimated, see rev. 10) | union of (i) and (ii): 1.4 × 10⁻⁵/day (generator; worst case 8.4 × 10⁻⁵), 0.00029 (ρ 0.3), 0.0079 (ρ 0.6) | `reactivation.py` as of revision 9 |
| D4 reactivation false positives (rev. 10, chain-simulated for ρ > 0) | union of (i) and (ii): 1.4 × 10⁻⁵/day (generator; worst case 8.5 × 10⁻⁵), 0.00094 (ρ 0.3), 0.054 (ρ 0.6) | `reactivation.py` (B.5.11) |
| `dormant_reactivation` label pass rate (rev. 9) | 1.000 as specified (0.970 if placed on any individual series) | `reactivation.py` (B.5.11) |
| Billing rollup disk delta (rev. 12; corrected in rev. 13; forecast leaves in rev. 15; leaf totals in rev. 17) | +0.066 GB per run (revs. 15–16: 0.031; rev. 13: 0.025; rev. 12: 0.026); peak 5.22 GB (5.26 GB with natural-3) | `rollup12.py` (B.5.12) |
| Garwood intervals, exact (rev. 12) | unchanged at three decimals (e.g. 7 groups: [0.046, 0.236]) | `budget3.py` (B.5.8) |
| Re-run of every embedded script (rev. 7) | all 9 SHA-256s match; Python outputs reproduce (`budget5.py` byte-identical twice, and from its Appendix B copy); SQL sizes reproduced on a fresh `postgres:16` container | §3d |

The measurement scripts are reproduced verbatim, with SHA-256, in
Appendix B (B.4, B.5.6–B.5.12).

## 5. Governance classification

`node scripts/governance/classify-risk.mjs --git origin/main...HEAD`,
at revision 17 (the commit that adds this line; the same eight reasons
as at `9e0d703`, revision 16). Revision 16 gave the same risk and classes
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

That is the correct classification for this content; the PR goes through
the restricted exception path. (Revision 2 at `461fbc2` classified `low`
only because of the wording reverted in §2.)
