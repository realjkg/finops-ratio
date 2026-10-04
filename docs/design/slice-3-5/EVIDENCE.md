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
| 10 | `9f1febb`; merge of `origin/main` `bd440b5`; this commit | Revision 9 approved by the challenger. The three Low items (§3g): reactivation false positives under day clustering simulated on the chain (the independent-history approximation underestimated); the prior mean of the size override looks back up to 112 days; the D4 text made consistent. `origin/main` merged (#65, #67, #68; no conflicts, no file under `docs/design/slice-3-5/` touched by main); DESIGN §0 and §7 note that PR 4-0 and #62 have landed. |

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
| **L2** monthly cadence | The prior mean of (ii) uses the active-day values in the 56 days ending at the last active day, extended back to up to 112 days (or all history) until there are ≥ 3. A monthly job (≈ 2 active days in 56) now gets a prior mean, and a 10 × restart reaches `warning`. Cost under the generator: 1.0 × 10⁻⁵ per day (was 9 × 10⁻⁶); at ρ = 0.3 / 0.6: 0.00012 / 0.0016. **Named limit: a quarterly job** (≤ 2 active days in 112) still has no prior mean and gets `info` unless (i) holds. The state is the last 3 active-day values per series, so peak disk is unchanged (5.15 GB; 5.19 GB with natural-3) | DESIGN §4.2, §4.3, §7 (5-2a); Appendix B.5.11, D.2 |
| **L3** consistency | Revision 8's stale "False positives" bullet in §4.2 deleted. The worst case is named as **the union of (i) and (ii) with 14 days of history, 8.5 × 10⁻⁵**, in DESIGN, EVIDENCE and the B.5.11 table alike (it was 8.4 × 10⁻⁵ with the 56-day prior mean). The script prints (ii) at both history lengths instead of `nan` | DESIGN §4.2; Appendix B.5.11 |
| Re-run | All 10 embedded SHA-256s match (9 unchanged, `reactivation.py` updated); every Python script re-run, outputs unchanged except `reactivation.py`; `reactivation.py` identical on two runs | §4 |

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
| Re-run of every embedded script (rev. 7) | all 9 SHA-256s match; Python outputs reproduce (`budget5.py` byte-identical twice, and from its Appendix B copy); SQL sizes reproduced on a fresh `postgres:16` container | §3d |

The measurement scripts are reproduced verbatim, with SHA-256, in
Appendix B (B.4, B.5.6–B.5.11).

## 5. Governance classification

`node scripts/governance/classify-risk.mjs --git origin/main...HEAD`,
at `bd440b5` (revision 10 after merging `origin/main`; the same reasons as at
`9f1febb` before the merge, `bb4379c`, revision 9, `04e6cf8`, revision 8,
`380e9a0`, revision 7,
`66a1fa2`, revision 6, `fc7ee66`, revision 5, and `faeabb4`, revision 4):

- `"risk": "restricted"`, classes `retention` and `secrets`;
- `secrets.password-assignment` on `APPENDIX_B_SIZING.md` (the
  `POSTGRES_PASSWORD=<throwaway>` run command, no secret value) and on
  this file (which quotes it);
- `retention.mention` on `APPENDIX_D_SCHEMA_SKETCH.md`, `DESIGN.md` and
  this file;
- `retention.delete-from` on `DESIGN.md` (the threat-model test that a
  `DELETE FROM ratio.cost_daily` by the analytics login is refused) and on
  this file (which quotes it).

That is the correct classification for this content; the PR goes through
the restricted exception path. (Revision 2 at `461fbc2` classified `low`
only because of the wording reverted in §2.)
