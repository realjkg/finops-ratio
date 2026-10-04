# Slices 3–5 — Synthetic fleet, cost forecasting, native anomaly detection: design

Branch `design/slice-3-5-forecast-anomaly`, from `origin/main` at 827773f
(Slices 0, 1, 2 and 2b merged). **Design only: this branch adds documents
and no code.** The decisions in §8 were **decided by the orchestrator under
the owner's delegation on 2026-10-04**. This third revision answers the
challenger's REQUEST CHANGES on 461fbc2 (1 High, 12 Medium, 8 Low), and
revision 4 its re-review of 461fbc2..9a17924 (2 Medium, 5 Low), and
revision 5 its review of 9a17924..4492d2f (1 High, 2 Medium, 3 Low),
revision 6 its review of 4492d2f..f5676d9 (1 High, 2 Medium, 4 Low), and
revision 7 the orchestrator's D-24 decision and the challenger's four Low
items on revision 6 (approved, 0 High, 0 Medium), and revision 8 the one
Low left on revision 7 (approved): dormant series that reactivate, and
revision 9 the challenger's Medium on revision 8 (the history condition
looked at the wrong days), and revision 10 the three Low items on
revision 9 (approved), revision 11 two wording Lows, revision 12 the
Copilot review of PR #70 (2 High, 2 Medium), revision 13 the
challenger's two Medium items on revision 12, revision 14 its Medium
and three Low items on revision 13, and revision 15 its Medium and three
Low items on revision 14 together with Copilot's review of 10cd9ce, and
revision 16 the challenger's two Medium and four Low items on revision 15,
and revision 17 Copilot's review of 6cad4cd (6 High, 4 Medium, 1 Low)
together with the challenger's review of the same commit (2 Medium, 4 Low)
and Copilot's second review of it (six threads, four of them High),
and revision 18 the challenger's review of cc54e79 (1 Medium, 5 Low)
together with Copilot's review of the same commit (seven threads),
and revision 19 Copilot's review of ddbb6f0 (2 High, 1 Medium) with the
challenger's four Low items on revision 18, which it approved, and
revision 20 Copilot's review of 0dd6743 (1 High, 3 Medium) with the
challenger's three Low items on revision 19, which it approved, and
revision 21 Copilot's review of d4616a8 (2 High, 1 Medium) with the
challenger's Low on revision 20, which it approved, and revision 22
Copilot's review of bddefe9 (3 High, 1 Medium, 1 Low) with the
challenger's Low on revision 21, which it approved, and revision 23
Copilot's review of c85079f (1 High, 2 Medium) with the challenger's Low
on revision 22, which it approved, and revision 24 Copilot's review of
b9b2274 (3 High, 1 Medium) with the challenger's Low on revision 23,
which it approved, and revision 25 Copilot's review of f3209ea (1 High,
2 Medium, 2 Low) with the challenger's Low and nit on revision 24, which
it approved, and revision 26 Copilot's review of 45b0088 (1 Medium,
1 Low) with the challenger's three Low items on revision 25, which it
approved, and revision 27 Copilot's review of 546e00b (2 High, 1 Medium)
after the challenger approved revision 26 without findings;
the revision history and the item-by-item responses are in
[EVIDENCE.md](EVIDENCE.md).

**Owner's goal.** Analyse cloud spend across **15,000 simulated accounts**,
**predict expected costs** and **flag meaningful anomalies automatically**,
so that FinOps Ratio is at par with today's FinOps tools on those
capabilities.

**Boundary (BOUNDARY v2, unchanged).** Local and ephemeral only. No
production infrastructure, no hosting spend, no real billing data, no real
cloud credentials. All data in these slices is **synthetic** and labelled as
such. The production go-live sign-off stays the owner's non-delegable gate
(brief §7).

**How to read this.**

| § | Content |
|---|---|
| 0 | Summary and parity statement |
| 1 | Gap analysis: what exists, what the reference tools do, what "at par" means, what is out of scope |
| 2 | Slice 3: the synthetic FOCUS generator at 15,000 accounts, profiles, sizing and storage |
| 3 | Slice 4: forecasting |
| 4 | Slice 5: anomaly detection and its evaluation |
| 5 | API and UI surface |
| 6 | Security and governance |
| 7 | Slicing plan: PRs in order, tests first |
| 8 | Decision log (decided by the orchestrator, 2026-10-04) and owner actions |
| 9 | Tracked items (side findings), each with an owner |
| 10 | Rollback |
| [Appendix A](APPENDIX_A_EXTERNAL_TOOLS.md) | External tools: every claim, its source, verified or not |
| [Appendix B](APPENDIX_B_SIZING.md) | Sizing model, row counts, storage, load times, the `fleet15k` disk budget |
| [Appendix C](APPENDIX_C_GROUND_TRUTH.md) | Ground-truth catalogue, label format, matching and gate rules |
| [Appendix D](APPENDIX_D_SCHEMA_SKETCH.md) | Schema sketch for migrations 0002–0004 |
| [EVIDENCE.md](EVIDENCE.md) | Revision history, measurements, challenger response |

Citations in square brackets (`[A3]`) point to Appendix A. A claim marked
**(unverified)** could not be checked against a primary source in this
session; a claim marked **(assumption)** is ours.

This design discusses data retention, row removal and secret-bearing
settings in plain terms. A PR that adds it is expected to be classified
**restricted** by the governance gate, and goes through the exception path
like any other restricted PR.

## 0. Summary

**Parity statement.** With Slices 3–5, FinOps Ratio is **at par for
detection and forecasting, except notification delivery, human
acknowledge/feedback and a billed month-end forecast; data arrival
idealised on `fleet15k`.** Notification
delivery is a follow-up slice (D-17); the acknowledge/resolve write path is
deferred until per-user identity exists (D-15), so lifecycle parity (A-g) is
**partial**. On `fleet15k`, closed months are loaded at once; late data and
month-to-date restatement are exercised on `ci` only (§2.7). The forecast
and detection targets are measured on synthetic data generated from the
models' own family, so they **validate the implementation, not real-world
parity** (§3.10).

**Today** Ratio has a trusted ingestion path (FOCUS → worker → published
facts → `GET /api/v1/costs/published`) but **no native forecasting over
those facts and no native anomaly detection**. The forecasts that exist
(`src/lib/forecast.ts`) are demo formulas over seed data for single AI
workloads, and `src/prediction` predicts the impact of *proposed changes*,
not a cost time series. Anomalies are only *imported* from PointFive or
derived from a seed rule (§1.1).

**Proposal**, in three slices, each a series of small PRs (§7):

1. **Slice 3 — synthetic fleet.** A deterministic generator produces a
   15,000-account FOCUS 1.0 estate with the providers `SyntheticAWS`,
   `SyntheticAzure` and `SyntheticGCP` (the names #62 accepts under its
   synthetic opt-in), four currencies, **ground-truth labelled anomalies**,
   **labelled billing artefacts that must not alert**, and misspecification
   stressors. It goes through the **real** worker and the **real** published
   view; there is no backdoor. Three profiles (§2.8):
   - **`ci`**: 150 accounts, 4 billing periods, full grain; runs in CI.
   - **`fleet15k`: the profile that proves the owner's goal.** All
     **15,000 accounts**, account × service × day, minimal columns, **4
     billing periods (122 days)**. **Tail-service caveat:** accounts at or
     above median spend keep their top 2 services as individual series,
     accounts below the median keep their top 1, and each account's other
     services are summed into one `Other services` series (≈ 37 k series,
     ≈ 22.5 k of them individual). **What that folds: ≈ 79 % of the
     account × service series and ≈ 26 % of fleet spend sit in
     `Other services`** (Appendix B.5.7). Anomalies on a folded service are
     injected at natural rates (spend-weighted) and their loss is reported,
     not gated (§2.5); **recall and leaf-forecast figures on `fleet15k`
     are measured on individual series only.** The `full` profile (owner
     action OA-1) removes this limitation. **Disk: ≈ 5.05 GB per run,
     ≈ 5.24 GB peak** across the sequential runs (tuning, tuning-natural,
     two pooled natural-rate seeds, enriched; §4.8), including WAL,
     temporary files,
     the control tenant and the retained evaluator exports, from per-row
     sizes measured on PostgreSQL 16 (Appendix B.5).
   - **`full`**: 13 periods at region level, all services individual,
     ≈ 78.6 M rows, 47–81 GB; needs owner action OA-1.
2. **Slice 4 — forecasting.** A TypeScript batch job (`ratio-analytics`)
   reads only published facts, builds daily rollup tables in SQL and fits a
   transparent model (robust Holt-Winters, damped trend, weekly seasonality,
   plus a **calendar-event component** for month-start, mid-month and
   month-end patterns; seasonal-naive as baseline and fallback) per
   **account × service**. It
   produces daily expected cost, **month-end** and **next 30/90 days** with
   **80 % and 95 % intervals** at every level of the hierarchy. The
   backtest protocol is **nested**: what is calibrated is never scored on
   the same block, and every interval and detector threshold is
   calibrated **as of** the day it is used (§3.8).
3. **Slice 5 — anomaly detection.** Residuals against the forecast
   interval, a floored robust z-score (MAD), a 2-day residual sum, CUSUM on
   a frozen baseline with a false-alarm budget derived from AT-4
   (intermittent series on non-overlapping weekly sums or a hurdle
   statistic), new-dimension and reactivation
   detection,
   tag-coverage loss, commitment-coverage rules and a cold-start guardrail.
   Severity by **dollar impact and relative deviation**. Candidates are
   **grouped across the hierarchy by a fixed precedence**, provider-wide
   first. The lifecycle maps onto `CostFinding`. Precision is measured at
   **natural label rates** pooled over two seeds, recall on an
   **enriched** seed (individual series only on `fleet15k`), with Wilson
   bounds (§4.9).

**Acceptance targets** (§3.10, §4.9, each with its profile and decision
rule): month-end forecast of each currency's fleet total within **5 %**
median absolute error when made on day 1; 30-day WAPE ≤ 20 % and ≥ 10 %
better than seasonal-naive, **measured on individual series only** on
`fleet15k` (the `Other services` leaves are reported separately); 80 %
interval coverage 75–85 % on held-out origins; anomaly **precision ≥ 0.80**
(Wilson 95 % lower bound ≥ 0.70, n ≥ 100 groups pooled over two
natural-rate seeds); **recall ≥ 0.90** on meaningful spikes, level shifts,
new services and runaway resources, **measured on individual series only**
on `fleet15k` (lower bound ≥ 0.80, ≥ 100 labels per kind); **median
time-to-detect ≤ 1 day** after data availability; at natural rates,
**≤ 0.30 false-positive groups per day** on `fleet15k` (gate, derived from
the expected ≈ 1.2 true groups per day), with the detector **tuned to
≤ 0.15 per day** (design total 0.101, 0.131 with every conservative
bound, at z_T = 4.5 and h = 9.0). If the true rate is 0.15 per day, both
precision and false-positive gates pass with probability ≈ 0.999; that
probability is conditional on the assumed rate, and the real control is the
rate measured on the `tuning-natural` seed (§4.2, §4.9). The month-start and month-end
stressor cohorts stay inside these gates. No vendor publishes comparable
figures (Appendix A), so these are Ratio's own.

**Decisions** (§8) are all decided (2026-10-04); this revision amends D-07
(exact-set wording, accepted by the orchestrator), D-12 (removal only
through a reviewed `SECURITY DEFINER` function) and D-04 (non-numeric
synthetic ids), and records the #62 dependency. D-24 (intermittent series
with more than 50 % zero days: a hurdle statistic with a clustering gate)
was decided by the orchestrator in revision 7. The `full` profile needs
owner action OA-1. The plan starts with the `daysInMonthOf` bug fix, and
Slice 3 starts only after #62 merges (§7). **Status when `origin/main` was
merged into this branch (revision 10):** the bug fix has landed as PR 4-0
(#65), and #62 has landed through #67 and #68. Its `SYNTHETIC_PROVIDERS`
set is exactly `{SyntheticCloud, SyntheticAWS, SyntheticAzure,
SyntheticGCP}`, behind `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1`, as D-21
assumes. Slice 3 can therefore start.

## 1. Gap analysis

### 1.1 What exists today

| Capability | Where | State | Reuse for Slices 3–5 |
|---|---|---|---|
| Trusted FOCUS ingestion (AWS Data Exports layout, evidence, quarantine, reconcile, publish, restatement) | `src/ingest/**` (Slices 0–1) | merged; proven on the synthetic fixture and on the public FOCUS 1.0 sample (Slice 2b) | **The only way data enters.** The generator writes what this path reads. |
| Published-facts boundary | `ratio.cost_facts_published` (definer-rights view, FORCE RLS, `ratio_reader` grant) | merged | Analytics reads **only** this view (plus a new published-batch catalogue view, §6.2). |
| Read API for row-level facts | `GET /api/v1/costs/published` (`src/server/costs/**`) | merged | Its auth, tenant binding, reader-login check, pool settings, keyset cursor and error mapping are the conventions for every new endpoint (§5). |
| Aggregated spend by any dimension | — | **missing** | New: daily rollups + `GET /api/v1/costs/daily` (§5). |
| Spend forecasting | `src/lib/forecast.ts` | demo-only: per AI workload, over seed data; run-rate daily projection, weighted 7-day monthly projection, 80 % interval = 1.28 × σ(14 d) × √days; JS `number` money | Formulas are the baseline to beat (§3.10); the calendar helpers need a fix first (§1.7, F1). |
| Change-impact prediction | `src/prediction/**` | merged: predicts Δcost of a proposed model switch / demand shape / scale / budget change; accuracy ledger; ≥ 99 % gate | Partly reusable, see §1.2. |
| Anomalies | `src/costsource/**` | **imported only**: PointFive Anomalies mapped to `CostFinding` (`PointFiveLiveAdapter.mapAnomalyToFinding`); the offline seed derives a `spend_spike` finding when a workload's `cost_trend_pct ≥ 15` | `CostFinding` is the output type (§4.6). No detector exists. |
| Product alert rule | `.obvious/obvious.md`, "Anomaly detection": today's projected spend > 15 % over yesterday's actual ⇒ alert (per workload) | rule text; implemented only as seed alerts (`src/data/alerts.ts`) | Kept for AI-workload budgets; the fleet detector is a separate rule set (D-19). |

### 1.2 `src/prediction`: what can and cannot be reused

`src/prediction` answers "what will this *proposed change* do to a
workload's monthly cost?" It is not a time-series forecaster: it never looks
at a history of daily costs, it has no seasonality or trend, and its inputs
are the seed `Workload` object.

| Reusable (as a pattern or a function) | Not reusable |
|---|---|
| The **ledger idea**: every prediction is recorded with what was predicted, then scored against the realised value (`LedgerEntry`, `scoreChange`). Slice 4's forecast snapshots and Slice 5's anomaly evaluation follow it. | `ProposedChange`, `CostImpact`, `predictImpact`: change types, not time series. |
| `percentile()` (`accuracy.ts`): linear-interpolated percentile, pure and tested. Usable for empirical interval quantiles. | The **≥ 99 % accuracy gate** (`ACCURACY_TARGET`, `clearsConfidenceGate`): a per-change accuracy bar. Daily cost forecasts at account × service level cannot meet 99 %; applying it would mark every forecast "estimated". |
| **Empirical intervals from historical error** (`confidenceBand`: the band comes from the source's error distribution, not from a parametric assumption). Slice 4 does the same per horizon (§3.4). | `DAYS_PER_MONTH = 30` and JS-`number` money: forecasts at fleet scale need calendar months and per-currency decimal outputs. |
| **Honest cold start** (`coldStart`, "estimated" mode). Slice 4's cold-start ladder (§3.5) reports it the same way. | `Workload`-bound inputs (`daily_inferences`, `tokens_in_today`, value ratio). |
| Source selection by lowest historical error (`selectSource`). Slice 4 uses the same rule to pick a model per series from backtest error (§3.2). | The `forecast_engine` source of `PredictionSourceId`: it points at the demo formulas, not at Slice 4. It can be re-pointed later (§8 D-19). |

### 1.3 `src/costsource`: anomalies are imported, not detected

`CostSourceClient.fetchFindings` returns `CostFinding[]`. The live PointFive
adapter validates PointFive's records and maps them (`type: 'anomaly'`,
`observedSpendDelta`, `severity`, `status`). The mock derives findings from
seed workloads. There is **no** code that computes expected spend, compares
actuals and raises an anomaly from Ratio's own published facts. Slice 5 adds
a native source (`ratio-native`) behind the same seam, so the UI and API
consumers see native and imported anomalies through one type.

### 1.4 Reference tools

What each tool does, from its public documentation (sources and
verification status in Appendix A).

| | Forecast | Anomaly detection |
|---|---|---|
| **AWS Cost Explorer / Cost Anomaly Detection** | ML forecast with an **80 % prediction interval**; daily granularity up to 3 months, monthly up to **18 months** (since Nov 2025, with up to 38 months of history and AI explanations); no forecast without enough history (typically under one billing cycle) [A1–A3]. | Runs **about three times a day** on net unblended cost; data latency up to 24 h; AWS-managed monitors for services, linked accounts, cost allocation tags and cost categories (top 5,000 values each); **at least 10 days** of history before a series is evaluated; alert threshold by **absolute $ and %** (getting-started default: daily summary for anomalies **above $100 and 40 %**); individual, daily or weekly alerts by email or SNS; **up to 10 ranked root causes** over service × account × region × usage type; since Nov 2025, rolling 24-hour windows compared with the same hours of earlier days [A4–A9]. |
| **Azure Cost Management** | Cost-analysis forecast, documented as a time-series linear-regression model that adjusts for reservation purchases, up to a year ahead; lookback 28–90 days by horizon **(partly unverified)** [A11]. | Daily evaluation at **subscription** scope, run **36 hours after the end of the UTC day**; univariate **WaveNet** model trained on **60 days**; anomaly alert rules only at subscription scope; alert e-mail summarises resource-group changes [A10]. |
| **Google Cloud Billing** | ML forecast in Billing reports up to **12 months**, handles outliers, gaps and shifts, models daily, weekly and monthly cycles; end-of-month projection [A12]. | **Cost Anomaly Detection** GA (dashboard GA 30 Oct 2025): per-project expected daily spend from historical and seasonal patterns, checked **hourly**; thresholds by **cost impact and % deviation**; root cause by service, region and SKU; auto-enabled alerts; claims to handle **cold start** for new projects [A13, A14]. |
| **Tanzu CloudHealth** (Broadcom) | ML forecast from the past **12 months**, up to **36 months** ahead; growth factors, service exclusions, business-unit Perspectives [A15]. | Anomalies over the past 90 days, increases and decreases, dashboard of count and cost impact; root cause through FlexReports [A15]. |
| **Vantage** | Forecasts on cost reports **(details unverified)**. | Per cost report, series by provider / service / cost category; ML forecast on up to **6 months** of daily cost; a series needs **> 12 days**; a day above the forecast's **upper bound** is a candidate; **noise filters**: below $5 on the day, or below 0.5 % of the report's daily total, is suppressed; alerts to e-mail, Slack, Teams, Jira; resource attribution [A17]. |
| **PointFive** | — (positioned on waste detection) | ML baseline, actual vs expected, usage-vs-price attribution, resource-level root cause, near-real-time claims [A18]. Ratio already imports these (§1.3). |
| **FinOps Foundation** (framework, not a tool) | Forecast variance guidance: ≤ 20 % (Crawl), 15 % (Walk), **12 % (Run)** [A16]. | Anomaly lifecycle: record, notify, analyse, resolve; KPIs include mean time to detect and to notify [A19]. |

### 1.5 What "at par" means here

Parity is judged on **capabilities a FinOps practitioner relies on**, not on
vendor-specific features. P0 = required for "at par"; P1 = should have;
P2 = later.

**Forecasting**

| # | Capability | Reference behaviour | Ratio plan | Priority |
|---|---|---|---|---|
| F-a | Daily expected cost per account, service and any rolled-up scope | AWS daily ≤ 3 months; GCP per report filter | §3.1: leaf account × service, roll-ups to sub-account, billing account, business unit, provider, service, tenant (per currency) | P0 |
| F-b | Month-end forecast (current month) | AWS, Azure, GCP | §3.7 | P0 |
| F-c | Next 30 and 90 days | AWS daily ≤ 3 months | §3.7 | P0 |
| F-d | Prediction intervals | AWS 80 % | 80 % **and** 95 %, calibrated by backtest | P0 |
| F-e | Honest cold start | AWS gives no forecast without enough data | Cold-start ladder, flagged "estimated" (§3.5) | P0 |
| F-f | Accuracy shown, not claimed | none of the cited vendors publishes accuracy (Appendix A) | Backtest report per scope (§3.8), API endpoint | P1 (differentiator) |
| F-g | Monthly horizon 12–36 months, annual seasonality, AI explanations, growth what-ifs | AWS 18 m, GCP 12 m, CloudHealth 36 m | **Out of scope** (needs > 1 year of history and an annual model) | P2 |

**Anomaly detection**

| # | Capability | Reference behaviour | Ratio plan | Priority |
|---|---|---|---|---|
| A-a | Automatic, no-setup monitoring of every account and service | AWS managed monitors, GCP auto-enabled | Every leaf series evaluated daily (§4.2) | P0 |
| A-b | Dimensions: service, account, tag / cost category (business unit), region | AWS 4 monitor dimensions + RCA by region / usage type; GCP service / region / SKU | Leaf account × service; region and resource in root cause; business unit and billing account as grouping levels | P0 |
| A-c | Thresholds by $ impact **and** % deviation | AWS ($100 / 40 % default summary), GCP, Vantage ($5 / 0.5 % floors) | Severity matrix (§4.4) | P0 |
| A-d | Root cause: ranked contributors | AWS up to 10; GCP services / regions / SKUs | Up to 10 contributors by excess $ (§4.5) | P0 |
| A-e | New service / new region | AWS evaluates new services after 10 days | Dimension-novelty detector from day 1 (§4.2 D4) | P0 |
| A-f | Detection latency ≤ 1 day after data availability | AWS ≤ 24 h data latency; Azure 36 h after day end | Daily run; TTD target (§4.9) | P0 |
| A-g | Lifecycle and feedback | CloudHealth / Vantage dashboards; FinOps lifecycle | **Partial while D-15 is deferred:** findings open and resolve automatically (§4.6); no human acknowledge or feedback until per-user identity exists | P0 (partial) |
| A-h | One root cause, not 50 alerts | AWS groups by monitor; RCA | Hierarchical grouping (§4.5) | P0 |
| A-i | Notifications (e-mail, Slack, SNS, webhooks) | all | **Not in Slices 3–5** (network egress is a restricted class); the API supports polling; webhooks are the follow-up (D-17) | P1 |
| A-j | Intra-day / hourly detection | GCP hourly; AWS rolling 24 h | **Out of scope**: the source is a daily-grain FOCUS export | P2 |
| A-k | AI-assisted investigation | AWS (2026), PointFive | Out of scope | P2 |

### 1.6 Out of scope for Slices 3–5

Commitment purchase recommendations, rightsizing and waste detection (that is
PointFive's role, already imported); cost allocation, showback and chargeback
rules; budgets and budget UI changes; unit economics and value attribution;
FX conversion to a reporting currency (D-10); real billing data and any
cloud credential; production deployment; Kubernetes and container cost
splitting; notification delivery (D-17); annual seasonality and long
monthly horizons (F-g); intra-day detection (A-j).

### 1.7 Side findings while reading the code

| # | Finding | Effect | Proposed handling |
|---|---|---|---|
| F1 | `daysInMonthOf` (`src/lib/forecast.ts`) builds the last day with the **local-time** `Date` constructor and reads it back with `getUTCDate()`. Verified: with `TZ=Asia/Tokyo`, February 2026 returns **27**; with `TZ=UTC`, 28. `remainingWeekdaysInMonth` and `budgetStatus.ts` inherit it. | Wrong month length on any server east of UTC. | Fixed first, as an independent bug fix (PR 4-0, §7); tracked as T5 (§9). Restricted (`financial_semantics`). |
| F2 | Rule **R4** ("every cost shown MUST be paired with its value context") cannot hold for fleet cloud spend: the synthetic estate has no value attribution. | A fleet anomaly or forecast view would violate a non-negotiable rule. | D-16 (decided: label "value context: not attributed"); tracked as T2. |
| F3 | The local compose runs SeaweedFS with `-volume.max=64 -master.volumeSizeLimitMB=64`, i.e. **about 4 GiB** of capacity **(assumption: capacity = volumes × size limit)**. `full` needs ≈ 11 GB (source objects plus evidence); `fleet15k` ≈ 0.3 GB. | `full` cannot fit the default local stack; `fleet15k` should. | Measured in PR 3-4; override (restricted, `deployment`) only if needed; tracked as T1. |
| F4 | D-09's revisit trigger is "a real month above a few million rows". `full` has ≈ 6 M rows per month (synthetic, but the same load path). | D-09 must be reviewed with measurements. | D-06 (decided: keep the trigger; revisit if the `fleet15k` load exceeds 60 min); tracked as T6. |
| F5 | `.obvious/obvious.md`'s anomaly rule (15 % over yesterday) is a workload-budget rule, not a fleet detector. | Two anomaly rule sets could confuse users. | D-19: keep both, name them differently. |
| F6 | `cost_facts` has only its primary key `(tenant_id, batch_id, artifact_sha256, row_ordinal)`; Tags, region, charge frequency and pricing category live as strings in `extra_columns`. | Any per-account or per-tag query on facts scans a whole batch. | Rollups are built **once per published batch** (§2.9); nothing queries facts by account at request time. |

## 2. Slice 3 — Synthetic FOCUS generator at scale

### 2.1 Principles

1. **Synthetic and labelled.** Every object, tenant, source and identifier
   says it is synthetic (§2.2, D-04). It is never mistaken for billing data.
2. **Deterministic from a seed.** Same profile + seed + generator version ⇒
   byte-identical objects and ground truth, on any machine (§2.6).
3. **Through the real path, no backdoor.** The generator writes S3 objects
   in the AWS Data Exports layout and nothing else. The worker's `sync` (real
   CLI, real `S3FocusExportSource`, evidence, validation, reconcile, publish)
   loads them. There is no direct `INSERT` into `ratio.*`, no fake source
   (`FakeFocusSource` stays refused outside `NODE_ENV=test`) and no test
   hook. The **only** switch is #62's synthetic-provider opt-in
   (`RATIO_ALLOW_SYNTHETIC_PROVIDERS=1`, accepted only with `RATIO_ENV`
   explicitly `development` or `test`), set by `local:synthetic` for its
   own worker processes and nowhere else (§2.7, §6.3). Analytics reads only
   the published view (§6).
4. **Ground truth never enters the database.** Labels are written next to
   the export, outside the bucket the worker reads, and only the evaluator
   reads them (§4.8).
5. **Faithful to FOCUS 1.0 where it matters for these slices**: charge
   categories, charge frequency, pricing category, commitment fields,
   EffectiveCost vs BilledCost semantics, one billing currency per billing
   account. Column definitions were checked against the FOCUS spec repository
   at tag `v1.0` (commit `f7f58a0a7e545258779839d4f2114819f278c6f3`) [A20].
   Deliberate deviations are listed in §2.4.
6. **Generated from the models' own family, plus stressors.** The base
   series follow the structure the forecaster assumes (level, damped growth,
   weekly seasonality, multiplicative noise). That makes the targets a test
   of the **implementation**, not of real-world accuracy. Misspecification
   stressors that the models do not assume (§2.3) are added so that the
   implementation is also exercised where its assumptions fail; their
   cohorts are reported separately.

### 2.2 Fleet model: hierarchy, providers, currencies

| Level | FOCUS column | Model |
|---|---|---|
| Tenant | — (`ratio.tenants`) | One fleet tenant `synthetic-fleet-15k`, plus one **15-account control tenant** loaded next to it in `fleet15k` (and in `ci`) to prove tenant isolation at scale. |
| Provider | `ProviderName`, `InvoiceIssuerName` | Exactly the names in #62's fixed `SYNTHETIC_PROVIDERS` set: `SyntheticAWS` (60 % of accounts), `SyntheticAzure` (25 %), `SyntheticGCP` (15 %). (`SyntheticCloud`, the fourth member, stays the existing fixture's name.) No other provider name is ever emitted. |
| Source type | `sources.kind`, layout | Every billing account is a `focus_file` source in the AWS Data Exports layout, the worker's only real layout. Under #62, with the opt-in on, every `SYNTHETIC_PROVIDERS` name is accepted for any layout; with it off, none is. So `SyntheticAzure` and `SyntheticGCP` rows are not quarantined under the AWS layout, and no provider-to-layout mapping is needed. |
| Organisation = billing account | `BillingAccountId`, `BillingAccountName` | **36 billing accounts**: 20 AWS-style, 10 Azure-style, 6 GCP-style. Each is **one ingestion source** (one export). |
| Currency | `BillingCurrency` | One per billing account (FOCUS; and the worker quarantines a mixed-currency batch, `MIXED_BILLING_CURRENCY`). 29 × USD, 4 × EUR, 2 × GBP, 1 × JPY (a zero-minor-unit currency, on purpose). |
| Sub-account | `SubAccountId`, `SubAccountName` | **15,000** sub-accounts, assigned to billing accounts with a heavy-tailed share. **Ids are non-numeric** (D-04): `SYN-A-` + 8 Crockford base-32 characters (e.g. `SYN-A-7KQ2M9XD`); billing accounts `SYN-BA-` + 4 (e.g. `SYN-BA-03FZ`). They cannot be mistaken for AWS's 12-digit account ids, Azure GUIDs or GCP project ids. |
| Business unit | `Tags` key `business-unit` | 12 business units spanning providers. The analytics layer derives an account's unit as its modal `business-unit` tag over the trailing 28 days of tagged spend, so tagging loss does not move an account between units. |
| Other tags | `Tags` keys `cost-center` (≈ 400 values); in `ci`/`full` also `env`, `app` | `cost-center` is the governed key for tag-coverage detection. `env` drives the generator's weekly seasonality but is **not emitted** in `fleet15k`, and **no analytics cohort key uses it** (§3.4). |
| Service | `ServiceName`, `ServiceCategory` | ≈ 60 invented service names per provider across FOCUS service categories. |
| Region | `RegionId`, `RegionName` | `ci`/`full` only: 70 % of services are regional; 1 region with probability 0.65, more with a geometric tail capped at 6. |

**Account size** is heavy-tailed: monthly spend is log-normal with median
$800 and σ = 1.8 (log scale): ≈ $59 M per month for the fleet, p99 account
≈ $50 k, largest ≈ $0.8 M; the top 1 % of accounts carry ≈ 29 % of spend
and the top 10 % ≈ 69 %; the bottom half carries ≈ 3.6 % (Φ(−1.8)).
Services per account grow with size (`3 + 4·log10(1 + spend/100)` +
noise): mean 7, p99 15. Service shares within an account are geometric
(each next service half the previous), so the dominant service carries
50–60 %. Non-USD amounts use the same distribution in their own currency
(no FX model, D-10).

**`fleet15k` service folding.** The generator always builds the **full**
service mix and injects labels into it at natural rates. Only then does
`fleet15k` fold: accounts at or above the median spend keep their top 2
services as individual series, accounts below it their top 1, and the rest
are summed into one `Other services` series per account. The result is
≈ 37 k leaf series, ≈ 22.5 k individual and ≈ 14.6 k `Other services`
(Appendix B.5). A label on a folded service is marked `folded: true`
(§2.5).

### 2.3 Series model

Each leaf series is generated as

`y(d) = L · g(d) · w(dow(d)) · m(d) · s(d) · ε(d) + (injected effects)`

| Component | Model |
|---|---|
| Level `L` | From the account's size and the service's geometric share. |
| Trend `g(d)` | Compound monthly growth drawn per account, mean +2 %, sd 3 % (some accounts shrink). |
| Weekly seasonality `w` | By `env`: `prod` flat (weekend factor 0.95–1.0); `dev`/`sandbox` weekday-heavy (weekend 0.4–0.7); 5 % of accounts are weekend-batch (weekend 1.3–1.8). |
| Noise `ε` | Multiplicative log-normal, σ from 3 % (large accounts) to 15 % (small). |
| Lifecycle | Accounts **onboard** (S-curve ramp over 10–40 days) and **offboard** (decay to zero over 7–30 days) at ≈ 600 / 300 per 13 months. Expected, not anomalies. |
| Commitments | ≈ 12 % of accounts (most large ones): a purchase row (`ChargeCategory=Purchase`, `ChargeFrequency=One-Time` or `Recurring`, `EffectiveCost=0` per FOCUS when it covers future charges); covered usage with `PricingCategory=Committed`, `CommitmentDiscountId`, `CommitmentDiscountStatus=Used`, `BilledCost=0`, `EffectiveCost` = amortised rate; **one `Unused` row per commitment per day** when the commitment is not fully used. A commitment **starts** (effective cost drops: *commitment effect*) and some **expire** without renewal (effective cost rises back to on-demand: *commitment expiry*, §4.1). |
| Spot / dynamic (`ci`, `full`) | ≈ 8 % of compute series split a `PricingCategory=Dynamic` row. |
| Credits | `ChargeCategory=Credit`, negative, `EffectiveCost = BilledCost` (FOCUS), mostly on the last or first day of a month (≈ 15 % of accounts per month). Some credit rows carry `ChargeFrequency=Usage-Based` on purpose (§4.1). |
| Tax | `ChargeCategory=Tax`, `PricingCategory` null (FOCUS), monthly; some tax rows carry `ChargeFrequency=Usage-Based` on purpose (§4.1). |
| Recurring fees | Support-plan style `Purchase`/`Recurring` rows on day 1 of each month. |
| Corrections | `ChargeClass=Correction` rows restating an earlier period, in a later period. |
| Untagged remainder (`ci`, `full`) | 30 % of account-services carry an untagged remainder row, so tag coverage is realistic. In `fleet15k` a series is wholly tagged or wholly untagged. |

**Misspecification stressors** (the models do not assume these; each cohort
is reported separately, §3.10, §4.9):

| Stressor | Model | Expected behaviour |
|---|---|---|
| `month_end_batch` (5 % of accounts) | × 1.3 on the last two business days of each month: the same factor on both days and in every month (pinned) | **not an anomaly; learned by the calendar component (§3.2)**; any detection counts as a false positive against AT-1 and AT-4 |
| `monthly_cycle` (5 % of accounts) | billing runs on days 1–3 and 15–16; **one factor per series and class**, drawn once from U(1.2, 1.6), then constant across months and across the class's days (pinned) | **not an anomaly; learned by the calendar component**; detections count against AT-1 and AT-4; WAPE reported |
| `holiday` (all accounts) | a fixed synthetic holiday calendar (≈ 1 day per month in the span), × 0.5–0.8 on `prod` and × 0.2–0.5 on others | not an anomaly; not learnable in 4 periods (no holiday calendar in the model); drops are `info` (D-14) and grouped provider-wide (§4.5 step 2b); any `warning`+ detection counts against AT-1 and AT-4 |
| `price_change` (provider-wide) | one provider changes one service's unit price on one day, × 0.8–1.3 for every account using it | an **alert**, expected as **one provider-wide group** (§4.5) |
| `intermittent` (5 % of series) | zero on 30–80 % of days, Poisson-like bursts | forecast reported separately (MAPE excluded); zero share ≤ 50 %: scored on non-overlapping weekly sums; > 50 %: a hurdle (compound-binomial) weekly statistic, `info` only when the active days are clustered (§4.2, D-24) |
| `constant_amortised` (commitment-only series) | the same effective cost every day (pure amortisation) | **zero** `warning`+ groups (gated, AT-5); exercises the MAD floor |
| `mtd_restatement`, `late_data` (`ci` only) | month-to-date exports that revise earlier days; rows for day d first appearing on day d + 2 | `restated` resolution; no group from a revision alone. On `fleet15k` data arrival is idealised: closed months load at once (§0) |

**Pinned calendar factors, and what that does not show (rev. 6, M1).**
The calendar cohorts use one constant factor per series and class, so the
calendar component (§3.2) faces exactly the pattern it models. That makes
the gated false-positive figure an implementation check, not evidence about
real billing. A **robustness run** draws each month's factor with ±10 %
uniform jitter around the series' factor (e.g. 1.17–1.43 around 1.3); it
is **reported, not gated**. At the chosen thresholds it adds **≈ 0.082
false groups per day** (Appendix B.5.10), on its own more than half the
design margin. Under it, the pass probability of AT-1 and AT-4 is ≈ 0.993
at the design total and ≈ 0.959 at the conservative total. **`tuning-natural`
cannot see this:** it is generated with the same pinned factors, so it
cannot detect jitter-type misspecification; only real data can. Real calendars will not match the pinned model: business-day
shifts, quarter-ends, irregular billing dates and month-to-month changes in
size all leave residual on event days, and only real data can measure it
(D-22).

### 2.4 FOCUS rows and the grain

**Grain (decided, D-01), per profile.** FOCUS rows are already aggregated
to the day and to the series, with `ChargePeriodStart/End` = the UTC day.
Non-usage rows (purchase, Unused commitment, tax, credit, recurring fee,
correction) are added at their natural frequency.

| Profile | Usage-row grain | Columns |
|---|---|---|
| `ci`, `full` | account × service × region × (pricing / tag split) × day | the existing fixture's `COLUMNS` set |
| `fleet15k` | **account × service × day** after folding (§2.2); no region, pricing or tag split; a series switches wholly (e.g. to `Committed`, or loses its tag) | **minimal**: the worker's five required columns (`BilledCost`, `BillingCurrency`, `ChargePeriodStart`, `ChargePeriodEnd`, `BillingPeriodStart`) plus `EffectiveCost`, `ProviderName`, `BillingAccountId`, `SubAccountId`, `ServiceName`, `ServiceCategory`, `ChargeCategory`, `ChargeClass` (corrections only), `ChargeFrequency`, `PricingCategory` (committed rows only), `CommitmentDiscountId`/`CommitmentDiscountStatus` (commitment rows only), `ResourceId` (injected runaway resources only), `Tags` (`business-unit`, `cost-center` only). Measured `extra_columns`: ≈ 100 B per row (Appendix B.5). |

In `fleet15k` an injected runaway resource is the one exception to "no
split": it is emitted as its own row with `ResourceId` for its window.

Why not charge level: at a realistic 25 resources per series, resource ×
hourly rows over 13 months would be **≈ 35 billion rows**, and resource ×
daily **≈ 1.45 billion** (Appendix B). Neither fits a local Postgres 16, and
neither is needed: the reference tools evaluate daily series too (AWS daily
spend per monitor value; Azure daily per subscription; Vantage daily per
report series [A4, A10, A17]).

**Deliberate deviations from a real export** (written into the generator's
README and the dataset manifest):

- **Resource ids.** `ResourceId` is set only for a few *named* resources per
  account (`ci`, `full`) and for every injected runaway resource; the
  remaining series cost is one row with `ResourceId` empty.
- **Provider fidelity.** Rows are FOCUS-shaped for three provider *styles*;
  they are not copies of any provider's real export (service names, SKU ids
  and usage types are invented), and they all use the AWS Data Exports
  layout.
- **Lean extra columns** (`fleet15k`) and the existing fixture's column set
  (`ci`, `full`).
- **Service folding** (`fleet15k`, §2.2).
- **Commitment amortisation** follows the FOCUS 1.0 column rules above; the
  exact `Unused` representation is checked against the spec's commitment
  examples in PR 3-1a (**unverified until then**).

### 2.5 Ground truth: injected anomalies, artefacts and stressors

Injected deterministically from the seed. Counts below are **natural rates
for `full`** (15,000 accounts, 13 periods); `fleet15k` uses the same rates
per account-month on its natural-rate seed, has no `new_region`, and
applies `tagging_loss`, `commitment_effect` and `commitment_expiry` to whole
series. The enriched seed is described in §4.8. Full catalogue, label
format, matching and gate rules: Appendix C.

| Kind | Label | What is injected | ≈ count (`full`) |
|---|---|---|---|
| `spike` | alert | 1, 2 or 3 days (equally likely), multiplier drawn from U(1.5, 6), on one leaf series | 300 |
| `level_shift` | alert | permanent step from day d; multiplier drawn **log-uniform on [1.2, 3.0]** (+20 % … +200 %, pinned) | 150 |
| `gradual_drift` | alert | extra linear slope reaching +30 % … +150 % over 14–45 days | 100 |
| `new_service` | alert | a service never used by the account starts with meaningful spend | 150 |
| `new_region` (`ci`, `full`) | alert | an existing account-service starts spending in a new region | 100 |
| `runaway_resource` | alert | one named resource grows daily (linear or ×1.1–1.4/day) for 5–20 days, then is "fixed" | 100 |
| `tagging_loss` | alert (governance) | ≥ 50 % of an account's spend loses `cost-center` from day d; **total spend unchanged** | 80 |
| `commitment_expiry` | alert | a commitment ends without renewal; covered usage reverts to on-demand pricing (+20 % … +60 % effective cost on the series) | 60 |
| `spend_drop` | alert (`info` by default, D-14) | −40 % … −90 % unexpected drop | 60 |
| `shared_cause` | alert (**one** group) | the same spike or shift in one service across 5–20 accounts of one billing account on one day | 40 |
| `provider_shared_cause` | alert (**one** group) | the same spike or shift in one service across ≥ 2 billing accounts of one provider (≥ 20 accounts) on one day | 15 |
| `price_change` | alert (**one** group) | a stressor (§2.3): provider-wide unit-price change of one service | 10 |
| `new_account_runaway` | alert | a newly onboarded account spends far above its cohort in its first 14 days | 20 |
| `dormant_reactivation` (rev. 8, placement pinned in rev. 9; **enriched and `ci` seeds only**) | alert | a non-intermittent individual series, drawn by spend, active every day up to a last active day a ≥ 16, then zero for a gap of **any length ≥ 56 days** (a ≤ r − 57), then restarting on day r ∈ 73–115 at × U(0.5, 3) its earlier level | ≥ 100 meaningful on the enriched seed; none on natural seeds |
| `month_end_credit` | **no alert** | Credit rows at month end | ≈ 2,250 per month |
| `usage_based_credit`, `usage_based_tax` | **no alert** | Credit / Tax rows with `ChargeFrequency=Usage-Based` (§4.1) | ≈ 50 each |
| `commitment_purchase` | **no alert** | Purchase rows (one-time / recurring), EffectiveCost 0 | ≈ 150 |
| `commitment_effect` | **no alert** at ≥ `warning` | covered usage moves to Committed pricing; effective cost **drops** | ≈ 150 |
| `tax`, `recurring_fee` | **no alert** | monthly rows | every account-month |
| `correction` | **no alert** | `ChargeClass=Correction` in a later period | ≈ 100 |
| `onboarding`, `offboarding` | **no alert** | ramps up / decays | ≈ 600 / 300 |
| `month_end_batch`, `monthly_cycle`, `holiday`, `intermittent` | **no alert** (stressor cohorts; detections at ≥ `warning` are **false** and stay in AT-1 and AT-4) | §2.3 | cohorts |
| `constant_amortised` | **no alert**, gated | §2.3 | ≈ 2 % of series |

Impacts are drawn so that ≈ 50 % of `alert` events are **meaningful**
(≥ 2 × the minimum impact of §4.4), ≈ 25 % near the threshold (0.5–2 ×) and
≈ 25 % below it. Recall is scored only on meaningful labels (§4.8).

**Placement of natural-seed labels (N2).**
- **Series-level kinds** (spike, level shift, drift, runaway resource,
  commitment expiry, drop, new service): the target series is drawn with
  probability **proportional to its mean spend** (`M`) over the full
  service mix, before folding. Rationale: impact thresholds are in
  dollars, so it is the spend-heavy series that produce meaningful
  anomalies; a per-series-uniform draw would put ≈ 79 % of labels on tail
  services worth a few dollars a day. Expected share of these labels on
  folded services: **≈ 26 %** (the spend share of `Other services`).
- **Account-level kinds** (tagging loss, new-account runaway): accounts
  drawn uniformly.
- **Fan-in kinds**: the (provider or billing account, service) drawn
  proportional to the service's spend there.
- **Enriched seed:** gated kinds on **individual** series only. Intermittent
  series are included; a label on a series whose occurrence is clustered
  at detection time (`info` only, §4.2, D-24) is reported in AT-7, not
  gated.

**Tail services (`fleet15k`).** Labels on services that fold into
`Other services` carry `folded: true`. The evaluator reports how many of
them are detected (through the `Other services` leaf or a parent scope) and
how many are lost: **reported, not gated**. Because recall is gated on the
enriched seed's individual-series labels and FT-4/FT-5 on individual
leaves, every `fleet15k` recall and leaf-forecast figure is **"measured on
individual series only"**: it says nothing about the ≈ 79 % of
account × service series and ≈ 26 % of spend that `fleet15k` folds. The
`full` profile, which keeps every service individual, is what removes this
limitation (owner action OA-1); the trade-off is surfaced to the owner.

The generator also writes each series' **true parameters**, so the
evaluator can compute the **oracle** expected value (§3.9).

### 2.6 Determinism and seeds

- **PRNG:** a counter-based integer generator keyed by `(seed, entity id,
  stream name)` (SplitMix-style, integer arithmetic only), so adding a
  stream or an account never shifts the draws of existing ones.
- **Arithmetic:** shapes use float64 with **only** `+ − × ÷` and `sqrt`
  (IEEE-754 correctly rounded, therefore identical everywhere). `exp`/`log`
  are not used at generation time: log-normal draws come from fixed
  integer-indexed tables committed with their SHA-256. **Money is integer**
  (BigInt units of 1e-10, as in `src/ingest/fixtures/syntheticFocus.ts`),
  quantised once per row, printed with exactly 10 decimals. Control totals
  are BigInt sums.
- **Bytes:** gzip with header mtime 0 and a fixed level; file splits by row
  count; sorted object keys.
- **Golden digest:** the `ci` profile's manifest SHA-256 (over every object
  and the ground truth) is pinned in a test.
- **Seeds:** named seeds per large profile, fixed in the generator:
  **tuning** (label-dense; recall-side tuning, never scored);
  **tuning-natural** (natural rates; false-positive thresholds z_T and h are
  tuned here, never scored);
  **natural-1** and **natural-2** (natural label rates, pooled for
  precision and false-positive rate; forecast targets on natural-1 only),
  plus **natural-3** if the pooled group count is below 140 (§4.9); and
  **enriched** (recall and time-to-detect; §4.8). The evaluation seeds are
  not generated until the tuned parameters are frozen and committed.

### 2.7 Output and delivery through the real path

```
generator --profile ci|fleet15k|full --seed tuning|tuning-natural|natural-1|natural-2|natural-3|enriched --out <dir>
  <dir>/export/<billing-account>/focus/<exportName>/data/BILLING_PERIOD=YYYY-MM/<runId>/part-00001.csv.gz …
  <dir>/export/<billing-account>/focus/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/<exportName>-Manifest.json
  <dir>/ground-truth/labels.jsonl, series-params.jsonl
  <dir>/dataset.json        (profile, seed, generator version, SHA-256 of every object, row counts, control totals)
local:synthetic --profile … --seed …   (scripts/local, its own project and ports, like local:acceptance)
  up → migrate → PUT export/** into the source bucket, verify every object's SHA-256 against dataset.json
     → remove the generator's local copy of export/** (default; keep ground-truth/ and dataset.json)
     → provision the tenants and 36 + 1 sources as the owner login, display names "SYNTHETIC …"
     → worker sync per source, N in parallel, each worker process started with RATIO_ALLOW_SYNTHETIC_PROVIDERS=1 and RATIO_ENV=development
     → assert every period published + reconciled, totals == dataset.json, re-sync skipped_unchanged
     → ratio-analytics rollup, backtest, forecast, detect --replay
     → export the evaluator's inputs (API pages, backtest files, evidence record) to the run's evidence directory
     → down -v (always)
```

- **#62 synthetic opt-in.** `local:synthetic` sets
  `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` **in the environment of the worker
  processes it spawns, and nowhere else**. Every other command that starts
  a worker (`local:test`, `local:acceptance`, `local:sync`, the compose
  `worker` profile) sets **`RATIO_ALLOW_SYNTHETIC_PROVIDERS=0` explicitly**
  in the worker's environment, as #62 now does, so an inherited parent
  value cannot switch it on. A static test asserts both: `=1` only in
  `local:synthetic`'s worker spawn, `=0` in every other worker start, and
  never `=1` in compose files or non-synthetic CI steps. **The contract
  #62 shipped (#67, #68), which Slice 3 relies on:**
  - `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` is accepted only when `RATIO_ENV`
    is **explicitly** `development` or `test`. Unset, unknown, `staging`
    and `production` are all refused with `SYNTHETIC_PROVIDERS_NOT_ALLOWED`;
    any value other than unset, empty, `0` or `1` is `CONFIG_INVALID`.
  - **In-process callers need the same env opt-in.** `runSync` with an
    explicit `allowSyntheticProviders: true` throws
    `SYNTHETIC_PROVIDERS_NOT_ALLOWED` unless *its own process* has
    `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` with `RATIO_ENV` explicitly
    `development` or `test`. A library caller cannot enable synthetic
    providers by asking.
  - `local:synthetic` therefore spawns its workers with **both**
    `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` **and `RATIO_ENV=development`**.
  - Slice 3's static test also checks that the `=1` spawn sets `RATIO_ENV`
    to `development` or `test`, never `staging` or `production`. Slice 3
    adds a cross-check test that the worker refuses `=1` under `staging`,
    `production` and an unset `RATIO_ENV`.

  **Slice 3 PRs start only after #62 merges** (§7); it has.
- **Sequential runs per large profile** (tuning, tuning-natural,
  natural-1, natural-2 [, natural-3], enriched), each ending with
  `down -v`, so the disk holds one run at a time plus the retained
  evaluator exports. Only natural-1 writes the per-origin leaf backtest
  export (the forecast targets use it); the other runs skip it. **Peak
  disk ≈ 5.24 GB** (5.28 GB with natural-3; the billing rollup, the forecast leaves, the leaf totals and the detector state of revisions 12–18 add 0.082 GB per run, the measured `cost_daily` row of revision 22 takes 0.058 GB off, and revision 24's scope census and account-scope forecasts add 0.066 GB, a net +0.091 GB; Appendix B.5.12, B.5.14), against the 5.5 GB target and
  the 6 GB ceiling; if an off-box artefact store is available, the
  retained exports (≤ 0.52 GB) move there after their SHA-256 is recorded
  (Appendix B.5.8). The retained-input sizes are **assumptions** until PR
  3-4 measures them.
- Manifests carry `x-ratio-control` (row count and billed total), so every
  batch must be `reconciled`.
- Every period's rows have `BillingPeriodStart` equal to the folder's period
  and one currency. Files are split at ≤ 500 k rows; the largest batch is
  ≈ 0.9 M rows per month in `full`, ≈ 60 k in `fleet15k`.
- **Independent totals:** for `ci` and `fleet15k`, the Python control
  calculator pattern of Slice 2b (stdlib only) recomputes per-period totals
  **and the per-leaf daily actuals** the evaluator needs, from the gzip
  objects read back from the source bucket (the local copy is gone), never
  from the generator's own sums.
- **Daily-delivery replay** (`ci`, one source, one month): the current
  month is delivered as 30 successive month-to-date exports (new execution
  id each day), including the `mtd_restatement` and `late_data` stressors,
  so the worker's supersede-and-republish path and the analytics job's
  restatement handling (§4.7) run as they would on a live export.

### 2.8 Profiles, time span and sizing (decided: D-01, D-02, D-03)

Full model, measurements and arithmetic: Appendix B (B.5 for `fleet15k`).

| Profile | Accounts | Grain | Span | Leaf series | Fact rows | Disk | Single-worker load (20 k / 6 k rows/s) | Where it runs |
|---|---|---|---|---|---|---|---|---|
| `ci` | 150 (+ 15 control) | full | 4 periods (≈ 120 d) | ≈ 1.5 k | ≈ 0.24 M | < 0.3 GB | ≤ 1 min | CI, every PR |
| **`fleet15k`** | **15,000** (+ 15 control) | account × service × day; top 2 services individually at or above median spend, top 1 below, + `Other services` (**tail-service caveat**) | **4 periods (122 d)** | **≈ 37.1 k** (22.5 k individual) | **≈ 4.89 M** | **≈ 5.05 GB** per run, **≈ 5.24 GB peak** across the sequential runs, all-in (Appendix B.5.8; revisions 12–24 delta in B.5.12) | **4 / 14 min** | this container class (≈ 10 GB free, 4 CPU, 15 GB RAM); five sequential runs (tuning, tuning-natural, natural-1, natural-2, enriched), plus natural-3 if needed |
| `full` | 15,000 | full | 13 periods (395 d) | ≈ 147 k | ≈ 78.6 M | 60–95 GB | 65–218 min | owner action OA-1 |

**`fleet15k` per-row sizes are measured** on an ephemeral PostgreSQL 16
container: **554 B per fact row** (`cost_facts`' exact columns and primary
key, `fleet15k` shape) and **217 B per narrow rollup row**; the integer
batch key of §2.9 was estimated to bring the rollup to ≈ 193 B, and
measured in revision 22 at 172.3 B with all six measures (180.2 B when
the multi-day measure is non-zero; Appendix B.5.14).

**The budget, re-done (M11).** The first `fleet15k` design (top 2 / top 4
services, uuid batch key, a 150-account control tenant) re-budgeted with
`cost_daily_scope`, the `Unused` commitment rows, the backtest exports, the
control tenant, WAL and temporary files comes to **6.08 GB: over the 6 GB
ceiling.** The escalation ladder (accounts are never reduced) was applied
in order, each step re-budgeted (Appendix B.5):

| Step | Change | Total |
|---|---|---|
| 0 | remove the generator's local copy after a verified upload (now the default) | included in every row |
| — | first design, all items counted | 6.08 GB |
| 1 | control tenant 150 → 15 accounts (two tenants still coexist at scale) | — |
| 2 | top 2 individual services for every account (no top 4) | 5.71 GB (steps 1 + 2) |
| 3 | integer batch key in `cost_daily` instead of a uuid (estimated −24 B/row) | 5.59 GB |
| 4 | **top 1 for accounts below median spend** (they carry ≈ 3.6 % of spend), top 2 at or above | **4.90 GB** |
| rev. 4 | P4 scoring origins for FT-7 (228 instead of 178 backtest points per leaf, +0.06 GB); retained exports across the sequential runs | 4.96 GB per run; 5.11 GB peak |
| rev. 5 | calendar factors in the forecast and detector state (+0.002 GB); one more sequential run, `tuning-natural` (§4.8) | 4.96 GB per run; 5.15 GB peak (5.19 GB with natural-3) |
| rev. 12 | billing rollup by charge category (`billing_daily_scope`, `cost_accounts`, `rollup_pointer`; rev. 15 `forecast_leaves`; +0.031 GB per run, Appendix B.5.12) | 4.99 GB per run; 5.18 GB peak (5.22 GB with natural-3) |
| rev. 17 | leaf `forecast_totals` for all three windows and two `forecast_state` columns (+0.035 GB per run; the delta is now +0.066 GB, Appendix B.5.12) | 5.03 GB per run; 5.22 GB peak (5.26 GB with natural-3) |
| rev. 18 | complete D3 anchor state and episode, per-bucket quantile sources, aggregate-scope detector state (+0.016 GB per run; the delta is now +0.082 GB, Appendix B.5.12) | 5.04 GB per run; 5.23 GB peak (5.27 GB with natural-3) |
| rev. 22 | `cost_daily` measured with its six measures and the integer key: 180.2 B per row instead of the 193 B estimated (−0.058 GB per run; the delta is now +0.024 GB, Appendix B.5.12, B.5.14) | 4.99 GB per run; 5.18 GB peak (5.22 GB with natural-3) |
| rev. 24 | scope census (≈ 820 aggregate scopes, not 550) and account-scope forecasts on read with their interval state and totals (+0.066 GB per run; the delta is now +0.091 GB, Appendix B.5.12) | **5.05 GB per run; 5.24 GB peak** (5.28 GB with natural-3) |

Step 4 is needed to reach the **5.5 GB target**; with it the peak has
≈ 0.26 GB margin to the target and ≈ 0.76 GB to the ceiling (rev. 24; ≈ 0.22 / 0.72 GB with natural-3).

**What the folding costs (N2, Appendix B.5.7):** **≈ 79.0 %** of the
fleet's account × service series (84,775 of 107,273) and **≈ 25.6 %** of
fleet spend sit in `Other services`. `fleet15k`'s recall and leaf-forecast
figures are therefore **measured on individual series only**; the `full`
profile (OA-1) removes this limitation. If PR 3-4's
measured total still exceeds 5.5 GB, the next step is **not** a shorter
span (the nested backtest of §3.8 needs 4 periods) and **not** fewer
accounts: it is escalated to the orchestrator with the measurements.

**Why 4 periods for `fleet15k`.** With periods of 31, 30, 31 and 30 days:
days 1–61 (P1–P2) are warm-up and training only, and give every series 2
prior calendar cycles; P3 (days 62–92) is the first month of expanding
as-of calibration; P4 (days 93–122) is where interval coverage is scored,
from origins whose calibration has ≥ 31 days of errors (§3.8). Day 62
gives 61 days of history (≥ 56, eight weeks). Three periods would leave no
month in which coverage is scored on mature calibration, and only one
prior calendar cycle at the start of the evaluation window.

**What each profile can assess:**

| Capability or target | `ci` | `fleet15k` | `full` |
|---|---|---|---|
| All 15,000 accounts analysed, forecast and monitored (the owner's goal) | no (150) | **yes** (with the tail-service caveat) | yes |
| FT-1, FT-2 (tenant month-end, day 1 / 15) | smoke | yes; n = 8 each (2 months × 4 currencies), reported with n | yes |
| FT-3 … FT-6 | smoke | yes; FT-4 and FT-5 on **individual** leaves (≈ 22.5 k), `Other services` reported separately | yes |
| FT-7 (coverage on held-out data) | no | yes: calibrated as of each origin, scored from origins 93–114 | yes |
| FT-8 (90-day horizon) | no | **no** | yes |
| FT-10 runtime | no | at ≈ 37 k leaves | at ≈ 107 k leaves |
| Precision (AT-1), false-positive rate (AT-4) | no | **yes, two pooled natural-rate seeds** | yes |
| Recall (AT-2), time-to-detect (AT-3) | smoke (≥ 2 labels per kind) | **yes, enriched seed, individual series only** | yes, all series |
| `new_region`, region root causes | **yes** | **no** | yes |
| `provider_shared_cause`, `price_change` (AT-6) | smoke | yes | yes |
| Tail-service loss (≈ 79 % of series, ≈ 26 % of spend folded) | n/a | **reported** | n/a (nothing folded) |
| Late data, month-to-date restatement | **yes** (daily-delivery replay) | no (idealised arrival) | no |
| Load time and D-06's 60-minute trigger | no | **yes** | yes |
| Storage at 78.6 M rows, D-09 at ≈ 6 M rows per month | no | no | yes |

### 2.9 Storage strategy

Three options were considered for making the facts (≈ 4.9 M in `fleet15k`,
78.6 M in `full`) queryable:

| Option | Verdict | Reason |
|---|---|---|
| **Materialised views** | **Rejected** | On PostgreSQL 16, `REFRESH MATERIALIZED VIEW` needs **ownership** (the grantable `MAINTAIN` privilege only arrived in PostgreSQL 17 [A21]); the job would have to be a `ratio_owner` member, which Slices 0–2 refuse. A materialised view also cannot be tenant-filtered by RLS, and cannot be refreshed incrementally. D-08 of the brief pins PG16. |
| **Partitioning `cost_facts`** | **Not now** | It would rewrite Slice 0's table (a contract-phase change touching triggers, FKs, the view and the foundation manifest). Facts are read **once per published batch** by the rollup job, through the primary-key prefix `(tenant_id, batch_id)`. Revisit trigger: a real tenant whose monthly batches exceed tens of millions of rows. |
| **Daily rollup tables, written by a least-privilege job** | **Adopted (D-05)** | Plain tables in schema `ratio`, FORCE RLS, composite tenant FKs, `numeric` only, filled by `INSERT … SELECT … FROM ratio.cost_facts_published WHERE batch_id = $1 GROUP BY …` once per newly published batch. |

Rollup design (schema sketch in Appendix D):

- `rollup_batches`: one row per rolled-up published batch, with a small
  **integer `batch_seq`** per tenant, its source, period and totals.
- `cost_series`: one row per (currency, provider, billing account,
  sub-account, service, region); ≈ 37 k in `fleet15k`, ≈ 147 k in `full`.
  Its stable id `series_id` keys the batch-keyed rollups. **The forecast
  leaf is a separate identity, `leaf_id`** (`forecast_leaves`: account ×
  service, regions summed). It keys every forecast, detector and anomaly
  leaf table (Appendix D.0; rev. 15). On `fleet15k` the two coincide, since
  `region_key` is `''` everywhere. `cost_accounts` does the same for
  accounts. No table keys on a provider-local id alone. These three
  identity tables **never delete a row and never change a row's identity
  columns**; the job updates only `last_day` (rev. 17: the appendices had
  called two of them "insert-only", which that update contradicted).
- `cost_daily` (**narrow**, usage only): one row per (series, UTC charge
  day, `batch_seq`) with six measures (`multi_day_usage_effective` since
  rev. 15) and a row count; primary key only. Measured 217 B/row with a
  uuid batch key; with `batch_seq` and all six measures, 172.3 B
  (180.2 B with a non-zero multi-day measure; rev. 22, Appendix B.5.14;
  193 B was the earlier estimate). ≈ 4.5 M rows / ≈ 0.81 GB in
  `fleet15k`.
- `billing_daily` (**sparse**): every row with `ChargeCategory IS DISTINCT
  FROM 'Usage'` (Purchase, Tax, Credit, Adjustment, and a null category as
  `(unknown)`), per (account, day, `ChargeCategory`, `ChargeFrequency`,
  correction flag): **every group with at least one fact row is
  retained, zero amounts included** (rev. 15; Copilot r4178820404). With `cost_daily` (exactly the
  rows with `ChargeCategory = 'Usage'`) it partitions the published facts,
  nulls included. Null key components are stored as `''` sentinels
  (Appendix D.0).
- `billing_daily_scope` (rev. 12): per rollup run, scope, day and **charge
  category** (`Usage` included), the billed and effective totals the API
  needs for `groupBy=chargeCategory` and for billed totals at aggregate
  scopes.
- `rollup_pointer` (rev. 12, rev. 13): the current succeeded rollup run
  and its `batch_seq` high-water mark (`coalesce(max(batch_seq), 0)` over
  the tenant's `rollup_batches`, `NOT NULL`, 0 on an empty tenant; rev. 14,
  rev. 15), moved **forwards only** in the same transaction that marks the
  run succeeded. Rollups have **one writer per
  tenant**, under the worker's lease and fencing pattern, which also
  allocates `batch_seq`. Batch-keyed views show, per (source, period), the
  highest **rolled-up** batch at or below the mark, so a restatement never
  leaves a gap. Every rollup reader view joins the pointer, so a partial,
  failed or late run is never visible (Appendix D.1).
- `cost_resource_daily`: **named** resource rows above a **per-currency
  floor: a quarter of the tenant's minimum impact in that currency**
  (§4.4, D-13; with the defaults USD/EUR/GBP 25 and JPY 3,750 per day).
  It is read at rollup time from the same per-currency setting as the
  minimum impact, never converted between currencies (D-10), and the
  floors used are recorded in the rollup run's `stats`, so a later change
  applies from the next rolled-up batch (rev. 20, Copilot r4179014804:
  revision 19's "$25/day equivalent" was one literal, which JPY would have
  been compared with). A row is named when its `ResourceId` is non-null and
  non-empty after the D.0 normalization. **Unnamed rows** (null or empty
  `ResourceId`, the generator's remainder row and any real row without an
  id) are never resource rows, however large: their cost stays in
  `cost_daily` and the billed totals, and root-cause ranking shows it as
  the series' unattributed remainder (rev. 19, Copilot r4178975173).
  `resource_id` is a primary-key column, so revision 18's dollar-only
  filter would have failed the insert on a high-cost unnamed row. The D.0
  `''` sentinel is **not** used here: it would make the unnamed remainder
  one "resource", which would usually carry most of the series' excess
  and turn D3 candidates into `runaway_resource` (§4.2).
- `cost_daily_scope`: precomputed daily totals for the API's aggregate
  scopes, per rollup run (≈ 820 scopes in `fleet15k` by the rev. 24
  census, §3.6).
- `account_dim`: per rollup run (business unit, age, first/last day).
- **Rollups are versioned by batch**: the read side shows, per (source,
  period), the highest rolled-up batch at or below the `rollup_pointer`'s
  mark (a snapshot, not the live publication; Appendix D.1). A restated
  period gets new rows, and the superseded batch's rows become unreachable
  once the run that rolls up the replacement moves the pointer. Their removal, and the removal of old
  run-keyed rows, is the **retention policy of D-12** (§6.1, a reviewed
  `SECURITY DEFINER` function; the job holds no DELETE grant).
- **No partitioning of the rollups initially:** primary keys serve the
  job's per-series scans and the API's narrow reads.
- **Charge day:** the UTC date of `ChargePeriodStart`. A row spanning more
  than one day is attributed to its start day in the billed and effective
  totals. **A `Usage` row whose charge period exceeds one day is excluded
  from `M`** (rev. 15) and kept in `cost_daily.multi_day_usage_effective`.
  - **Why exclude rather than drop the claim:** FOCUS lets a row cover any
    period. `M` is a daily usage signal, and a multi-day row attributed to
    one day is an artificial spike that the detectors would page on.
  - **Why not prorate:** splitting it across days would invent a daily
    shape the source never stated.
  - **Totals are unaffected:** billed and effective totals still include
    these rows, so exactly-once holds.
  - **Scope:** `fleet15k`'s usage rows are all one day long, so this
    matters for real data (tested in 4-2).

### 2.10 Slice 3 performance targets

| Target | `ci` | `fleet15k` (this container class) | `full` (OA-1) |
|---|---|---|---|
| Generation (streaming, bounded memory) | ≤ 10 s | ≤ 5 min, peak RSS ≤ 1 GB | ≤ 30 min, peak RSS ≤ 1 GB |
| Upload + verification to local S3 | ≤ 10 s | ≤ 3 min | ≤ 20 min |
| Worker load, all sources | ≤ 60 s | **measured**; estimate 4–14 min single worker; **> 60 min triggers the D-06 review** | measured; ≤ 90 min wall with 4 parallel sources |
| Re-sync (all `skipped_unchanged`) | ≤ 15 s | ≤ 1 min | ≤ 2 min |
| Stored bytes per fact row | ≤ 0.6 KB | ≤ 0.56 KB (554 B measured) | ≤ 0.6 KB |
| Disk, all-in (Appendix B.5) | < 0.3 GB | **≤ 5.5 GB target at peak** (≈ 5.05 GB per run, ≈ 5.24 GB peak across the sequential runs; 6 GB ceiling) | ≤ 100 GB |
| WAL | — | `max_wal_size` set to 256 MB; **its effect on peak WAL size and on load time is measured in PR 3-4** | measured |
| End-to-end CI step | ≤ 120 s | n/a | n/a |

### 2.11 Local stack implications

- `local:synthetic` follows `local:acceptance`: its own project and ports,
  the preflight that refuses existing state, every step under a hard
  deadline, `down -v` always, pass/fail in one place; it is the only
  command that sets `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` (§2.7).
- **SeaweedFS capacity** (T1): the default local settings give ≈ 4 GiB
  (assumption: volumes × size limit). `fleet15k` needs ≈ 0.3 GB in the two
  buckets and should fit; PR 3-4 measures it. `full` needs ≈ 11 GB and does
  need an override (`deployment` class, restricted).
- Postgres runs with `max_wal_size=256MB` for `fleet15k` (measured, §2.10).
- The local stack's secrets (`RATIO_LOCAL_PG_SUPERUSER_PASSWORD` and the
  login passwords) are generated per project into `.ratio-local/<project>/env`
  exactly as in Slice 2; nothing new is committed.
- CI gains one step (the `ci` profile) after `local:acceptance`.

## 3. Slice 4 — Forecasting

### 3.1 What is forecast

**Measures** (per currency; never summed across currencies, D-10):

- **Monitored cost** `M` = Σ `EffectiveCost` over rows with
  `ChargeCategory = 'Usage'`, `ChargeFrequency = 'Usage-Based'`,
  `ChargeClass` null and a charge period of at most one day (rev. 15,
  §2.9): amortised, usage-driven daily spend (§4.1).
  **Negative usage** (a credit recorded as `Usage` with a negative
  amount) is included in `M` on purpose: it lowers the usage cost the way
  the bill does. A leaf-day with `M` ≤ 0 is not scored on the log scale.
  It counts as an inactive day for the intermittent and reactivation
  rules, and the drop rules (`info`) apply to it. `fleet15k` emits no
  negative usage; this matters for real data. It excludes purchases, recurring fees, credits, tax,
  adjustments and corrections **by definition** (D-09). This is what the
  daily forecast and the anomaly detector use.
- **Billed month-end `B` is not forecast in Slices 3–5 (rev. 27, Copilot
  r4179306710).** Every model forecasts `M`, which is `EffectiveCost`.
  Committed usage can have `BilledCost` 0 while its `EffectiveCost` is
  amortised, so `B` cannot be derived from `M`. It would need a
  billed-usage model of its own: for example month-to-date billed actuals,
  plus the remaining days' `M` converted by a calibrated per-scope
  billed-to-effective ratio, plus the known schedule of fees and tax.
  That model would also need its own interval calibration and tests.
  Revisions 1–26 promised `B` without that model, so it is **removed from
  the API contract** and recorded as a gap (§0, §8 Known limits). It is a
  follow-up slice. Billed **actuals** are unaffected: `costs/daily`
  returns billed and effective totals over every charge category (§5.1).

**Scopes.** Leaf = **account × service**, identified by its `leaf_id`
(`forecast_leaves`). Its natural key carries currency, provider, billing
account, sub-account and service; regions are summed over the leaf's
`cost_series` rows (Appendix D.0; rev. 15). That is ≈ 107 k leaves in
`full`, with regions summed; ≈ 37 k in `fleet15k`, of which ≈ 22.5 k individual services and
≈ 14.6 k `Other services`; region-level novelty is a detector, §4.2). Roll-ups: sub-account, business
unit, billing account, provider, service (fleet-wide), tenant; each per
currency.

**Outputs per scope:** expected daily `M` for the next 90 days with 80 % and
95 % intervals; expected `M` for the current month (month-end) and the
next 30 and 90 days, with intervals; method, history length and the
cold-start flag. **No billed forecast** (rev. 27; above). Revisions 19
and 22 had narrowed `B` to the month-end at account scope and above; it
is now removed altogether.

### 3.2 Method ladder

Simple and explainable first.

| Model | When eligible | Why |
|---|---|---|
| **M0 seasonal-naive mean**: the mean of the same weekday over the last 4 weeks | ≥ 14 days | The baseline every other model must beat; robust, obvious to explain. |
| **M1 Holt-Winters, additive weekly seasonality, damped additive trend** (ETS(A,Ad,A) family) | ≥ 56 days | Captures level, growth that flattens, and day-of-week pattern; the damped trend keeps 90-day forecasts from running away. Parameters (α, β, γ, φ) by grid search over a fixed grid of 6 × 4 × 4 × 3 = 288 points minimising one-step SSE on outlier-cleaned data: deterministic, no optimiser dependency. |
| **M1-log**: M1 on `log1p(y)` (multiplicative seasonality) | ≥ 56 days, **every value the M1-log fit or its selection reads > 0**: the whole fit history up to the origin, and every day of the selection block (rev. 23, Copilot r4179131180: revision 22 checked only the last 28 days, so an earlier −5 still reached `log1p` during the fit; rev. 22: no zero or negative day; `log1p` is undefined at ≤ −1, and a log model of negative spend means nothing). **Fallback after selection (rev. 22, Copilot r4179088906):** if a value ≤ 0 arrives later, that leaf switches to **M0** from that day's update, with the flag `log_fallback`, and to **M1** (additive) at the next weekly refit, for the rest of the run. M0 needs no fitted state, so the switch is immediate; clamping would invent data. The rule is fixed before the scoring block, so it is not a selection on scored data | For series whose weekend dip scales with level; back-transformed with the variance correction; points still summed bottom-up. |

**Which model a series uses** depends on the profile, so that nothing is
both selected and scored on the same data (§3.8):

- **`fleet15k`: a fixed rule, no per-series selection.** A series uses M1
  once it has ≥ 56 days of history, M0 from 14 to 55 days, and the
  cold-start rule below 14 (§3.5). Fitting M1's parameters at an origin
  uses only data before that origin; that is estimation, not selection.
- **`full`: per-series selection inside a selection block** (months 7–9,
  never scored). Each series picks M0, M1 or M1-log by the lowest WAPE
  over that block's origins (the `selectSource` rule of `src/prediction`, applied to models;
  ties go to the simpler model), and the choice is frozen before the
  scoring block.

**Calendar-event component (decided, D-22).** Real billing has strong
month-start and month-end patterns (fees, commitment charges, batch jobs,
billing runs), and a tool at par must not page on them. M0 and M1 are
multiplied by per-series factors for three fixed **event classes**:

| Class | Days | Typical cause |
|---|---|---|
| `month_start` | calendar days 1–3 | billing runs, month-start jobs |
| `mid_month` | calendar days 15–16 | mid-month billing runs |
| `month_end` | the last 2 business days (Mon–Fri) | close and batch jobs |

- **Form:** `ŷ(t) = ŷ_weekly(t) × exp(f̂_e)` on an event day of class `e`
  (1 otherwise); `f̂_e` is a log factor.
- **Estimate (rev. 6, M1):** on the **raw** `y`, not on Hampel-cleaned
  data (cleaning would replace the very event days the factor must learn,
  §3.3). `r̃_e` = **median** over the series' **prior occurrences** (n
  cycles × d days, m = n·d values) of `log(y / ŷ_weekly)`, with standard
  error `se = 1.2533 · σ / √m` (the median's asymptotic standard error
  under normal noise; σ the floored robust log-scale noise of §4.2). The
  median, not the mean, so that one anomalous day moves the estimate
  little. Event days inside a **detected** anomaly (open, or resolved
  other than as `new_baseline`) are left out.
- **Valid samples only (rev. 23, Copilot r4179131198).** `log(y /
  ŷ_weekly)` is undefined when either is ≤ 0 (0 / 0 on an intermittent
  series, or negative usage), and M0 accepts intermittent series. So a
  sample counts only if **`y > 0` and `ŷ_weekly > 0`**. `m` is the number
  of valid samples. The median, `σ` (computed on the same valid days) and
  the significance test all use that one valid set.
- **Applied only when estimable and significant:** `f̂_e = r̃_e` if
  m ≥ 3 valid samples and `|r̃_e| / se ≥ 3`, else 0 (no adjustment). This is shrinkage to zero by a hard
  threshold.
- **Why this form.**
  - Multiplicative, because these effects scale with the series' level.
  - Three fixed classes, because they can be estimated from 2–3 cycles,
    which is what `fleet15k` has, and are explainable. A full
    day-of-month seasonality has 31 parameters and needs many more
    cycles. Monthly Fourier terms are smooth and miss 2–3-day spikes.
  - The hard threshold, not soft empirical-Bayes shrinkage toward a pooled
    estimate: in a population where ≈ 90 % of series have no calendar
    effect, a pooled prior sits near 0. It shrinks the real effects of the
    10 % heavily and leaves a residual bias on exactly the series that
    page. It also adds estimation noise to the event days of the other
    90 %. The threshold applies nothing to a series without evidence
    (false application ≈ 0.3 % of series-classes at |t| ≥ 3), and lets a
    real factor through whole once it is significant.
  - Measured effect (Appendix B.5.10): at the chosen thresholds the
    cohorts' expected false groups fall from **≈ 7.0 candidate leaf-events
    per day without the component** to **≈ 0.0012 per day with it**,
    with the generator's pinned factors (§2.3). With ±10 % month-to-month
    jitter in the factors (a reported robustness run, not gated) the
    residual is **≈ 0.083 per day** (Appendix B.5.10).
- **How many cycles it needs.** At least **m = 3 prior values**: one
  cycle of `month_start` (d = 3), two of `mid_month` or `month_end`
  (d = 2); then only if the effect is significant. A × 1.3 effect (log
  0.26) passes with m = 3 when σ ≤ 0.12, with m = 4 (two 2-day cycles)
  when σ ≤ 0.14, and with m = 6 when σ ≤ 0.17.
- **Before that:** no factor. The **first occurrence** of a class, and the
  second occurrence of a 2-day class, are unlearnable; their false groups
  are counted explicitly in the budget (§4.2), not hidden.
- **What `fleet15k`'s 4 periods give.** A series that exists from day 1
  has **2 prior cycles** of `mid_month` and `month_end` at day 62 (P1, P2),
  so its P3 events use 2 cycles and its P4 events use 3. For
  **`month_start` it has only 1** (rev. 7, L1): P1's days 1–3 have no
  weekly baseline to form `log(y / ŷ_weekly)` against, so P3's
  `month_start` uses P2 alone (m = 3) and P4's uses P2 and P3. The budget
  assumes exactly that (+0.0007 per day against revision 6). Accounts onboarding during the span
  meet a class for the first or second time inside the evaluation window:
  about **3.0 false groups per 61-day seed**, or 0.049 per day (Appendix
  B.5.10). Two or three cycles is a thin basis. It works here because the
  generator's cohorts follow exactly these classes with one constant
  factor per series and class (§2.3). **Real calendars will not match
  that:** shifted business days, quarter-ends, irregular billing dates and
  factors that change from month to month will leave more residual (the
  jitter run gives one measure of the cost), and only real data can
  measure it.
- **Recall effect of an anomaly in a prior cycle (rev. 6, M1c).** A
  detected anomaly is left out of the estimate, so it costs nothing. An
  **undetected** one on the same series' event days in a prior cycle pulls
  the factor towards itself, and the next event-day anomaly of the same
  size is then partly explained away. Measured (Appendix B.5.9, × 1.5–3
  anomalies, meaningful only): with **three** prior cycles, one of them
  contaminated, recall on the event days is **0.999** (1.000 clean); with
  **two** prior cycles of a 2-day class, the median of 4 values is the
  mean of the middle two, and recall falls to **≈ 0.72**. It needs a
  missed anomaly on the same series' event days in an earlier month, so
  its effect on AT-2 is expected to be small, but the evaluator reports
  event-day labels on calendar-cohort series separately (AT-7).
- The factors apply to forecasts (FT-4) and detection alike. D2's robust
  z is computed on the calendar-adjusted value `y / exp(f̂_e)`.

Explicitly not in these slices: ARIMA, Prophet-style regressors,
gradient-boosted or neural models, annual seasonality, and a holiday
calendar (the `holiday` stressor measures what its absence costs). The
fpp3 textbook [A22] treats seasonal-naive and ETS as the reference simple
methods.

### 3.3 Robustness to outliers

Anomalies in the training data must not teach the model that spikes are
normal:

1. **Hampel cleaning before fitting, calendar-aware (rev. 6, M1):** the
   learned calendar factors are applied first (an event day's value is
   divided by `exp(f̂_e)`), then a day is replaced by its weekday-adjusted
   rolling median when it lies more than 4 scaled MADs from it over a
   28-day window, with the same scale floor as detector D2 (§4.2), so
   constant series are never "cleaned". Without the first step, a learned
   month-end factor of × 1.3 on a σ = 0.05 series (5σ) would be cleaned
   away every month. The cleaned series is used for the weekly model only;
   the calendar factors are estimated on raw `y` (§3.2).
2. **Open anomalies are masked:** days inside an open anomaly (§4.6) are
   replaced the same way, so a level shift is learnt only once it is
   confirmed as the new normal (`new_baseline` after 14 days).
3. **Grid search on cleaned data, residual quantiles on raw data:** the
   intervals stay honest about real volatility.

### 3.4 Prediction intervals

Empirical, per horizon, with **expanding as-of calibration** (M2): an
interval issued at time `t` (a forecast origin, or a detection day) uses
only forecast errors whose forecast day is ≤ `t − 1`. This is how the job
behaves in production and leaves nothing to leak (§3.8).

- For each series and horizon bucket h ∈ {1, 2–7, 8–14, 15–30, 31–60,
  61–90}, collect the h-step errors **observed before `t`**, divided by
  the series scale `L` at the error's origin (stored per leaf as
  `scale_level`, Appendix D.3). **`L` is positive (rev. 19, Copilot
  r4178975191):** the trailing 28-day mean of **`|M|`**, floored at
  `ε` = min impact / 10,000 (USD 0.01, JPY 1.5). Revision 17 used the
  trailing mean of `M`, which negative usage can make 0 or negative,
  flipping every quantile adjustment. An origin whose 28-day mean `|M|`
  is below `ε` (no usage) contributes no errors.
- Series with ≥ 26 errors in a bucket use their own quantiles (`full`);
  all others use the **pooled** quantiles of their cohort. In `fleet15k`
  every series uses the pooled quantiles (too few origins for its own).
- **Cohort key:** provider × service category × size decile (by trailing
  28-day mean `M`). Only emitted, analytics-visible columns are used; `env`
  is not part of the key (it is not emitted in `fleet15k`).
- 80 % and 95 % intervals = point + `L` × (q₀.₁, q₀.₉) and (q₀.₀₂₅,
  q₀.₉₇₅). The point includes the calendar factor; Appendix D.3 gives the
  full formula per method.
- **Ordered bounds (rev. 19).** Each bucket's quantiles are stored
  **clamped around 0**: `q95_lo ≤ q80_lo ≤ 0 ≤ q80_hi ≤ q95_hi` (a biased
  bucket is widened towards the point, never shifted past it). With
  `L` > 0 the bounds are then ordered around the point. **Lower bounds
  are floored at 0 only when the point is ≥ 0**; a negative point (net
  negative usage) keeps its raw lower bounds. So `lo95 ≤ lo80 ≤ point ≤
  hi80 ≤ hi95` holds for every row, negative points included (Appendix
  D.3). D1 is not affected: it works on log errors and scores only
  leaf-days with `M` > 0 and a positive point (§3.1).
- **Clamping and FT-7 (rev. 20, the challenger's L3).** Clamping only
  widens: a bucket whose errors are biased (both 80 % quantiles on one
  side of 0) gets an interval reaching back to the point, so it can
  **over-cover**. FT-7 is two-sided (80 % coverage at most 85 %, 95 % at
  most 97.5 %), so heavy clamping could fail FT-7 from above. 4-4b and
  4-6 report the share of clamped buckets (and of clamped total windows)
  next to FT-7, per level and horizon bucket. The FT-7 target is
  unchanged.
- Month-end and 30/90-day totals: intervals come from as-of errors **of
  the totals themselves**, not from summing daily bounds.
- **Totals use the same ordering rule (rev. 20, the challenger's L1).**
  For a total over a window with `n` forecast days (the remaining days of
  the month for month-end; 30 or 90 otherwise), the scale is
  `L_T = n × L`, with `L` the scope's positive scale above; the total's
  errors are divided by `L_T` at their origin. Its quantiles are clamped
  around 0 like the daily ones, and its lower bounds are floored at 0
  only when the total's point is ≥ 0. So `lo95 ≤ lo80 ≤ total ≤ hi80 ≤
  hi95` for every `forecast_totals` row at every level and window. Every
  interval the job writes (daily points, totals, backtest points) goes
  through this one rule (Appendix D.3).
- **`n` = 0 (rev. 21, Copilot r4179039364 and the challenger's L1(a)).** A
  month-end origin on the month's last published day has no forecast
  days, so `L_T` = 0. Such origins are **left out of the totals
  calibration**, as §3.4 leaves out origins with mean `|M|` < `ε`, so no
  error is ever divided by 0, even when a later restatement gives that
  origin a non-zero error. Its own interval has zero width at its
  actuals.
- **Month-end errors are bucketed by remaining days (rev. 21, the
  challenger's L1(b)).** Dividing by `n × L` assumes an error that grows
  linearly in `n`; pooling month-end errors across all `n` would make the
  interval too wide late in the month and too narrow early. Month-end
  total errors are therefore pooled **per remaining-days bucket**, the
  daily buckets {1, 2–7, 8–14, 15–31} (15–30 widened to 31 for the
  longest months), with the cohort fallback and the √-scaling of an
  empty bucket as for the daily ones. Next-30 and next-90 totals have a
  fixed `n` and one bucket each. Month-end coverage is reported per
  bucket; it is not an FT gate, and no target is added.
- A cohort bucket with fewer than 1,000 errors falls back to its parent
  (provider × size decile), then to the global pool, so the early days of
  a replay use wider-pooled quantiles rather than unstable ones.
- **Empty horizon buckets (rev. 6, L2).** Early in a replay a bucket can be
  empty even in the global pool: errors at horizon h exist only from day
  57 + h − 1. Such a bucket uses the quantiles of the **longest populated
  bucket**, scaled by `√(h_mid / h_p)`, where `h_mid` is the empty bucket's
  midpoint and `h_p` the midpoint of the populated one (errors that grow
  like a random walk). The interval is flagged `extrapolated` in the
  output and is **not scored**: FT-7 and the detector budget use only
  intervals built from errors at their own horizon. On `fleet15k` this
  affects origins before day 87 for the 15–30 bucket and every 31–90 day
  horizon, which `fleet15k` does not assess anyway (§3.8).
- For intermittent series (≥ 30 % non-positive days in the 56 days before the
  origin), the interval is computed on the level-scaled errors like every
  other series' (M1-log is not eligible for a series with zero days,
  §3.2), and the lower bounds follow the same rule as every interval:
  floored at 0 when the point is ≥ 0, raw below a negative point (rev.
  20, Copilot r4179014824 and the challenger's L2: revision 19 still said
  "the lower bound is 0" here). (Revision 17 said "without the log
  variant", which no section defined; rev. 18.)

### 3.5 Cold start

| History of the series | Point | Interval | Flag |
|---|---|---|---|
| 0 days | none (no forecast, like AWS) | — | `no_history` |
| 1–13 days | mean of the available days, with the account's weekday profile if the account is older | cohort pooled quantiles × 1.5 | `estimated` |
| 14–55 days | M0 | cohort pooled | `estimated` |
| ≥ 56 days | M1 (`fleet15k`) or the selected model (`full`) | own or pooled | `fitted` |

A new **account** is in a 14-day warm-up for anomaly scoring (§4.2), but its
spend still contributes to every parent scope's actuals and, after day 1, to
its forecasts.

### 3.6 Hierarchy and reconciliation

- **Points: bottom-up.** Every parent's expected value is the sum of its
  leaves' (same currency), so the hierarchy is coherent by construction and
  the business-unit, billing-account and tenant views always add up.
- **Intervals: per level.** Each parent's interval comes from the empirical
  backtest errors **of that parent's bottom-up forecast** (§3.4 applied to
  the parent), so intervals are calibrated at every level although they do
  not sum.
- **Where each output lives (rev. 24, Copilot r4179171086).** Every
  promised scope × output pair is stored or rebuilt on read, and is
  sized (Appendix B.5.12):

  | Scope | Daily points + intervals (90 d) | Totals: month-end, next 30, next 90 | Method, history, cold-start |
  |---|---|---|---|
  | leaf (≈ 37 k) | on read from `forecast_state` (D.3) | `forecast_totals` | `forecast_state` |
  | account (15,000) | **on read**: sum of its leaves' points, bounds from `forecast_scope_state` (D.3) | `forecast_totals` (counted in rev. 24) | `bottom_up` summary in `forecast_totals` (below) |
  | billing account, business unit, provider, tenant (≈ 100) | `forecast_points` | `forecast_totals` | `bottom_up` summary in `forecast_totals` |
  | fleet-wide service (≤ 720 with currencies) | `forecast_points` | `forecast_totals` | `bottom_up` summary in `forecast_totals` |

  Billed month-end `B` has no column: it is not forecast (§3.1, rev. 27).

  **Method, history and cold start above the leaf (rev. 25, Copilot
  r4179229481).** One account's leaves can differ: one fitted, one cold
  start. So every non-leaf scope reports a **summary**, not a leaf's
  values:
  - `method = bottom_up`;
  - `historyDays`: days from the scope's **first usage day** to the run's
    as-of day. That first day is the minimum of `forecast_leaves.first_day`
    over the scope's leaves as of that day. It is usage-only and defined
    for every scope kind (rev. 26, the challenger's Low:
    `cost_accounts.first_day` also counts non-usage rows, and the
    business-unit, provider, tenant and service scopes had no defined
    first usage day);
  - `leafCount`;
  - `coldStartShare`: `Σ |E_ℓ|` over leaves flagged `estimated` divided
    by `Σ |E_ℓ|` over all the scope's leaves, where `E_ℓ` is a leaf's
    expected `M` over the window. It lies in [0, 1], and is `null` when
    the denominator is 0. A `no_history` leaf has no forecast and
    contributes nothing (rev. 26, Copilot r4179273924: a share of signed
    expected values could divide by 0 or leave [0, 1]; the same pattern as
    `freshness`'s coverage share, rev. 18).

  `method`, `historyDays` and the cold-start flag of §3.5 are reported per
  leaf only. The summary is written to the scope's `forecast_totals` rows
  by the forecast run.

  `budget.py` counted 550 aggregate scopes. The rev. 24 census finds ≈ 820
  (100 + 720, an upper bound), and the 270 above 550 are now counted in
  `forecast_points`, `forecast_totals`, `cost_daily_scope`,
  `billing_daily_scope` and the aggregate backtest points. Storing account
  daily points instead would add ≥ 0.405 GB and take the peak above the
  5.5 GB target.
- **Recorded alternative:** MinT optimal reconciliation [A22] can improve
  accuracy at aggregate levels. It needs a covariance estimate across
  ≈ 107 k series; it is P2 and only worth it if the aggregate targets of
  §3.10 are missed.

### 3.7 Month-end, 30 and 90 days

- **Month-end (current month):** actuals to date (published days only) +
  Σ daily expected for the remaining days. The **as-of day** and the last
  published day are returned, so a reader sees how much is actual and how
  much is forecast.
- **Next 30 / 90 days:** Σ daily expected from tomorrow; intervals from
  backtests of 30- and 90-day totals.
- **Stored for every scope, leaves included (rev. 17).** All three
  windows are written to `forecast_totals` for every leaf as well as every
  aggregate scope. A leaf's total intervals cannot be rebuilt on read from
  its daily bounds, so storing only the leaf month-end total (revision 16)
  left the leaf API without next-30 and next-90 intervals (Appendix D.2,
  D.3; +0.033 GB per run, B.5.12).
- The current month is usually **provisional** in a real export (the
  worker's `is_provisional`); the forecast reports the provisional state of
  the batches it used.

### 3.8 Backtesting protocol (nested rolling origin)

**Rule:** everything is calibrated **as of** the time it is used: an
interval, a D1 quantile or a D3 `σ(h)` at time `t` uses only errors on
days ≤ `t − 1` (expanding as-of calibration, M2). Parameter estimation at
an origin uses only data before that origin. Model selection (`full` only)
and detector thresholds are fitted on blocks or seeds that are never
scored (`full`'s selection block; the tuning seeds).

**`fleet15k`** (4 periods: P1 31 d, P2 30 d, P3 31 d, P4 30 d; natural-rate
seed for scoring):

| Block | Days | Used for |
|---|---|---|
| Warm-up | 1–61 (P1, P2) | training only; never scored. Every pre-existing series has ≥ 56 days of history at day 62. |
| First calibration month | 62–92 (P3) | expanding as-of calibration accumulates; points scored; coverage **not** scored (the quantiles are still building) |
| Coverage scoring | 93–122 (P4) | interval coverage (FT-7) **from origins ≥ 93 only**: 93 (h 1–30), 100 (h 1–23), 107 (h 1–16), 114 (h 1–9), each calibrated as of its origin (≥ 31 days of errors); points also scored here |

- **Point forecasts** (FT-1…FT-6) use the fixed rule of §3.2, so nothing is
  selected; they are scored on **all origins** in P3 and P4.
- **Origins:** weekly at days 62, 69, 76, 83, 90 for horizons 1–30, and
  the P4 origins 93, 100, 107, 114 for the horizons that stay inside day
  122: **228 forecast points per leaf**. Every interval is calibrated as
  of its origin, so **no interval uses information from after its
  origin**.
  Month-end origins: day 1 and day 15 of P3 and P4 (days 62, 76, 93, 107).
- **n:** FT-4/FT-5 ≈ 22.5 k individual leaves × 228 points ≈ 5.1 M
  leaf-days (plus ≈ 14.6 k `Other services` leaves reported separately);
  FT-7 ≈ 22.5 k × 78 points ≈ 1.8 M leaf-days from origins 93–114 (all
  ≈ 37 k leaves pooled per level are reported too); FT-1/FT-2 n = 8 each
  (2 months × 4 currencies); FT-3 n = 72 (36 billing accounts × 2 months).
- 90-day horizons are not assessable on `fleet15k`.
- **Detection replay (as-of, M2).** The replay runs days 57–122. Days
  57–61 only accumulate one-step errors (M1 becomes eligible at day 56).
  **D1 and D3 are live from scored day 62** (index `t`, §4.2): D1 uses the
  as-of 99 % quantile of one-step errors with forecast day ≤ t − 1 (≥ 5
  days × ≈ 150 leaves per cohort, with the fallback above). D3's first
  anchor is day 62, and on scored day t it needs `σ(h)` for h ≤ t − 62 + 1,
  from errors at that horizon with forecast day ≤ t − 1. These exist from
  day 57 + h − 1 ≤ t − 1, so they are always available. D2 (56-day medians) and D8 are live from day 62 too (D2's
window is full from day 57). The scored window is
  unchanged (days 62–122, 61 days), so n and the precision sample are
  unchanged in expectation. Because days 62–75 run on ≤ 2 weeks of
  errors, the false-positive rate is also **reported separately** for
  days 62–75 and 76–122.

**`full`** (13 periods): warm-up months 1–6; **selection block** months
7–9 (model selection per series, frozen afterwards); **scoring block**
months 10–13 (weekly origins for horizons 1–30, monthly origins for 90
days, day 1 and day 15 of each month for month-end). Intervals and detector
thresholds are calibrated as of each origin or day throughout, using own
quantiles where a series has ≥ 26 as-of errors in the bucket.

- **No leakage:** at an origin `t`, fitting and cleaning use data with
  charge day < `t` only; the generator's labels and true parameters are
  never visible to the job.
- **Two scorings:** *all days*, and *clean days* (excluding ground-truth
  anomaly windows).
- **Baselines scored on the same origins:** M0, and the existing
  `projectMonthlySpend` weighted-7-day method for month-end.
- **Per-origin outputs are persisted for the evaluator (M3).** For every
  origin, leaf and horizon, `ratio-analytics backtest` writes (origin day,
  **`leaf_id`**, h, expected, lo80, hi80, lo95, hi95) as gzip JSON Lines with
  a SHA-256 manifest into the run's evidence directory, and the same for
  every aggregate scope into `forecast_backtest_points` in the database.
  Size: ≈ 0.25 GB for the `fleet15k` natural-1 run (37 k leaves × 228
  points × ≈ 30 B gzip; the other runs skip the leaf export; Appendix
  B.5.7).
- **Backtest retention is bounded (rev. 25, Copilot r4179229471).**
  Each backtest run adds ≈ 0.01 GB to the database and ≈ 0.2 GB to the
  evidence directory, while the API shows only the latest succeeded run.
  - **Kept:** the **2 latest succeeded backtest runs**, plus every run
    **pinned** as evidence. A pin is a row in `analytics_run_pins` (run,
    reference).
  - **Pinned at success (rev. 26, the challenger's Low).** `ratio-analytics
    backtest --pin <reference>` writes the pin **in the run's own success
    transaction**, so no retention pass can fall between the run's
    success and its pin. On a long-lived stack, two newer backtests plus a
    retention pass could otherwise delete an acceptance run before its
    evidence pinned it. The acceptance runs (PR 4-6, 5-4) always use
    `--pin`. A later pin for an existing run (a PR's evidence) is still
    possible, but only while the run is kept.
  - **Database:** the forecast retention function removes the
    `forecast_backtests` and `forecast_backtest_points` rows of every
    other backtest run that is `succeeded`, `failed` or `abandoned`. It
    never touches a `running` run.
  - **Evidence directory:** after the function has run, the backtest
    command deletes the per-origin export files of those same runs.
    Their SHA-256 manifest stays in the run's `stats`, so it remains on
    record what was produced and deleted.
  - **Archived, never deleted:** pinned runs' exports, kept in the
    evidence directory, or moved to an off-box artefact store once one
    exists, with their manifest.
  - **Bound:** (2 + pinned) × (≈ 0.01 + ≈ 0.25) GB. On `fleet15k` every
    sequential run is its own stack with at most one backtest run, and the
    exports retained across runs are already in the peak (B.5.7), so the
    sizing does not change.

  Revisions 3–24 exempted these outputs from D-12 entirely, so they grew
  with every backtest run.
- **Two implementations of every metric:** the TypeScript backtest computes
  them; the independent Python (stdlib only) evaluator recomputes them from
  the exported per-origin points and from actuals **it computes itself**
  from the gzip objects in the source bucket (§2.7), never from the job's
  rollups. The two must agree exactly on the inputs and within 1e-9 on the
  metrics (Slice 2b's "different language, different code path" rule).

### 3.9 Metrics

| Metric | Definition | Where used |
|---|---|---|
| **WAPE** | Σ\|y − ŷ\| / Σ\|y\| over series and days in a slice | primary, at every level; spend-weighted by construction |
| **MAPE** | mean \|y − ŷ\| / \|y\| | only for series with no zero day and ≥ $10/day; never for `intermittent` series |
| **APE of totals** | \|Y − Ŷ\| / \|Y\| for month-end and 30/90-day totals; **undefined when \|Y\| < ε** (min impact / 10,000, §3.4): such a scope-origin is excluded from the median and max and counted separately (rev. 26) | per scope and origin; median and max, with n |
| **Interval coverage** | share of actuals inside the 80 % / 95 % interval | per level and horizon bucket, scoring block only |
| **Interval width** | mean (hi − lo) / `L`, the series' positive scale of §3.4 (rev. 26: revision 25 divided by ŷ, which can be 0 or negative) | so coverage is not bought with useless width |
| **Skill vs baseline** | 1 − WAPE(model) / WAPE(M0) | per level |
| **Skill vs oracle** | WAPE(model) − WAPE(oracle), oracle = the generator's true expectation | synthetic only |

### 3.10 Acceptance targets

**What these targets show.** The base series are generated from the same
family as the model (§2.1, principle 6). Meeting the targets shows that the
forecaster, intervals and backtest are **implemented correctly and
calibrated**; it does **not** show real-world accuracy or parity with a
vendor's forecast on real bills. The stressor cohorts (§2.3) show where the
model's assumptions fail; they are reported, not gated. Real-world accuracy
can only be measured on real billing data (brief owner action 4).

**Decision rule:** forecast targets are judged on the **point estimate**
over the stated n, on the natural-rate seed; n is reported with every
figure, and a figure with n < 8 is reported, not gated. The gating profile
is `fleet15k` wherever it can assess the target; `full` gates the rest once
OA-1 exists.

| # | Target | Assessed on | Reference point |
|---|---|---|---|
| FT-1 | Month-end forecast of each currency's tenant total of `M`, made on **day 1**: median APE ≤ **5 %**, max ≤ 12 % | `fleet15k` (n = 8), `full` | FinOps Foundation variance guidance: ≤ 12 % at Run [A16] |
| FT-2 | Same, made on **day 15**: median APE ≤ 3 % | `fleet15k` (n = 8), `full` | — |
| FT-3 | Billing-account month-end (day 1): median APE ≤ 10 % | `fleet15k` (n = 72), `full` | FinOps Run 12 % |
| FT-4 | Daily WAPE, horizons 1–30: ≤ **20 %**, **measured on individual series only** on `fleet15k`; `Other services` leaves are excluded from the gate and reported separately | `fleet15k` (≈ 5.1 M leaf-days), `full` (all services individual) | no vendor publishes one |
| FT-5 | Individual-leaf skill vs M0 ≥ **10 %** | `fleet15k`, `full` | our baseline |
| FT-6 | Month-end WAPE not worse than the weighted-7-day method at any level, ≥ 20 % better at tenant level | `fleet15k`, `full` | `src/lib/forecast.ts` |
| FT-7 | On the **scoring block** only, from **origins inside it** (no interval uses information after its origin): 80 % coverage in [75 %, 85 %], 95 % in [92 %, 97.5 %], pooled per level and horizon bucket | `fleet15k` (origins 93–114, individual leaves), `full` (origins in months 10–13) | AWS publishes an 80 % interval, not its coverage [A1] |
| FT-8 | 90-day total at billing-account level: median APE ≤ 15 % | **`full` only** | — |
| FT-9 | All days (anomalies included), `Other services` leaves, stressor cohorts (`holiday`, `monthly_cycle`, `month_end_batch`, `intermittent`, `price_change`), event days vs other days: reported, not gated | all | contamination and misspecification effects |
| FT-10 | Fit + forecast for all scopes ≤ **15 min** wall, ≤ 4 GB RSS; backtest ≤ 60 min | `fleet15k` (this container class), `full` (OA-1) | cost estimate below |

A target that is missed is **recorded and escalated** with the measured
value, **never relaxed** (D-20).

### 3.11 Where it runs

| Part | Language | Why |
|---|---|---|
| Rollups and every money aggregation | **SQL** (Postgres `numeric`) | Exact; one pass per batch; no money leaves Postgres as a float. |
| Model fitting, intervals, backtests, detection | **TypeScript** batch job `ratio-analytics` in the worker build (`dist-worker/analytics/cli.js rollup | forecast | detect | backtest`), a one-shot job like the worker | The repo's runtime stack is Node + Postgres; no new runtime dependency. Recursive Holt-Winters updates in SQL would be slow and opaque. |
| Independent evaluation | **Python 3 stdlib** (already a dev dependency for Slice 2b) | A second implementation of the metrics and the ground-truth matching, sharing no code with the job. |

Rejected: a Python runtime with numpy/statsmodels (a second production stack
and dependency tree for one job); SQL-only (seasonal-naive and MAD are easy,
Holt-Winters is not).

**Refit cost (L-item: FT-10 and AT-8 rechecked against the grid search).**
One M1 refit runs the Holt-Winters recursion once per grid point over the
series' history. Assumption: ≈ 1 × 10⁸ recursion steps per second per
thread in V8 (to be measured in PR 4-4b).

| | Steps per full refit | Single thread | 4 worker threads |
|---|---|---|---|
| `fleet15k`: 37 k leaves × 288 × ≈ 100 days | ≈ 1.1 × 10⁹ | ≈ 11 s | ≈ 3 s |
| `full`: 107 k leaves × 288 × ≈ 300 days | ≈ 9.2 × 10⁹ | ≈ 92 s | ≈ 23 s |

- Backtest: `fleet15k` 9 origins ≈ 1.6 min; `full` ≈ 35 origins ≈ 54 min
  single-threaded, **so `full` uses 4 worker threads** (≈ 14 min) to stay
  inside FT-10's 60 minutes.
- Detection replay (AT-8, weekly refits, daily O(1) updates): `fleet15k`
  9 refits ≈ 1.6 min; `full` 26 refits ≈ 40 min single-threaded, ≈ 10 min
  with 4 threads. A daily run with its weekly refit: ≤ 30 s (`full`,
  4 threads).
- If the measured rate is 3 × lower, `full` still fits with 4 threads; if
  10 × lower, it does not, and the grid is narrowed around the previous
  week's parameters (recorded as the fallback, not the default).

**Floats stay inside the model.** Inputs are read as decimal strings and
converted to float64 only inside `src/analytics/model/**`; outputs are
rounded to 6 decimal places and written as `numeric` text. Anomaly impact
`actual − expected` is computed in SQL on the stored `numeric` expected
value. An import-boundary test keeps float-producing modules out of the
rollup and API paths. Slice 0's catalogue scan (no float columns) keeps
holding.

**Privilege model.** The job runs as a login that is a member of the new
NOLOGIN role `ratio_analytics` only, and checks its own login at start-up
like the worker and the reader do (§6.1). It reads the published view and
the published-batch catalogue view; it writes only analytics tables and
removes derived rows only through the reviewed retention function (D-12).

### 3.12 Reuse

- From `src/lib/forecast.ts`: `standardDeviation`; the calendar helpers
  **after** F1 is fixed; `projectMonthlySpend` as a scored baseline.
- From `src/prediction`: `percentile`, the ledger pattern, the honest
  cold-start flag, model selection by lowest historical error (§1.2).
- From Slices 0–2: `withTenantTransaction`, `inspectRole`/`roleProblems`,
  the redacting JSON-lines logger and evidence record, the CLI's exit-code
  conventions, the bounded pg session settings.

## 4. Slice 5 — Anomaly detection

### 4.1 Monitored measure and billing artefacts

The detector watches **`M` = Σ `EffectiveCost` over rows with
`ChargeCategory = 'Usage'` AND `ChargeFrequency = 'Usage-Based'` AND
`ChargeClass` IS NULL** (D-09, tightened by M5): usage-driven, amortised
spend, corrections excluded. Requiring both the category and the frequency
matters because a provider may tag a credit or a tax row as
`Usage-Based`; the generator emits such rows on purpose
(`usage_based_credit`, `usage_based_tax`) and a test asserts they never
reach `M`. Whether FOCUS 1.0 `Unused` commitment rows are `Usage` /
`Usage-Based` (and therefore in `M`) is checked against the spec's
commitment examples in PR 3-1a (**unverified until then**); either way the
generator and the rollup follow the same rule.

| Artefact | Why it cannot alert on `M` |
|---|---|
| Month-end credits, including `Usage-Based` ones | not `ChargeCategory = 'Usage'` |
| Commitment purchase (one-time or recurring) | `Purchase` rows; FOCUS sets their `EffectiveCost` to 0 when they cover future charges |
| Tax, including `Usage-Based` tax | not `Usage` |
| Recurring fees on day 1 | `ChargeFrequency = 'Recurring'` |
| Corrections of earlier periods | `ChargeClass = 'Correction'` |

What **can** move `M` without being a spend anomaly, and the rules:

- **Committed share (rev. 26, Copilot r4179273924).** A series' committed
  share on a day is `|C| / (|C| + |U|)`, where `C` is its committed usage
  effective cost and `U` the rest of its usage effective cost (`M` − `C`).
  It lies in [0, 1] and is `null` when both are 0. Revision 25 divided by
  the signed effective cost, which negative usage can make 0 or negative.
  The 20-pp tests below compare the day's value with the trailing 28-day
  median of the **defined** days, and need ≥ 14 of them. With fewer, D7
  does not test.
- **Commitment effect** (covered usage gets cheaper): a **drop** whose
  start day coincides (±1 day) with a rise of ≥ 20 percentage points in the
  series' committed share of effective cost is classified
  `commitment_effect`, severity `info`, not notified.
- **Commitment expiry** (a commitment ends without renewal): a **rise**
  whose start day coincides (±1 day) with a fall of ≥ 20 pp in the
  committed share is classified `commitment_expiry` and **alerts** with the
  normal severity rules. Reasoning: it is a real, recurring cost increase
  that someone can act on (renew, or accept the on-demand price), and it
  is invisible in `BilledCost` terms until the invoice. Labelled `alert`
  in Appendix C.
- **Onboarding / offboarding:** a new account's ramp is in warm-up (D6);
  decays to zero produce `drop` candidates, `info` by default (D-14).
- **Stressor cohorts** (`month_end_batch`, `monthly_cycle`, `holiday`):
  not suppressed. Month-end and monthly patterns are learned by the
  calendar component (§3.2). Holidays are drops (`info`). Their remaining
  false positives are **inside** AT-1 and AT-4, and also reported per
  cohort (§4.9).

Billing artefacts (credits, purchases, tax) are visible in the daily cost
API's billed totals; they are never anomalies, and they are not forecast
(§3.1, rev. 27).

### 4.2 Detectors

**Day index (rev. 17, Copilot r4178820416).** Every detector, window,
calibration rule and test below uses one index, the **scored day `t`**. A
detection run scores the last published charge day `t`. It runs on the
as-of date `t + 1`, when that day's data is published.
- It reads data with **charge day ≤ `t`**: day `t` is the day being
  scored, not a future day.
- It **calibrates only on errors whose forecast day is ≤ `t − 1`**, so the
  scored day never calibrates itself.

In this index:
- D8 uses `r_{t−1} + r_t`;
- D4's restart day is `t`, and its dormant window is the 56 days `t − 56 …
  t − 1`;
- D1 and D2 score `y_t`, and D3 updates `S_t`;
- the replay (§3.8) and the 5-3 leakage test use the same `t`.

Earlier revisions mixed an as-of `D` (data ≤ `D − 1`) with formulas that
read `r_D`; there is no `D` any more.

**Log scale and scale floor.** Cost noise is multiplicative, so D1, D2, D3
and D8 work on `log(y)` (calendar-adjusted, §3.2). On a linear scale, a
log-normal right tail at 4 linear σ is 5–60 times more frequent than the
normal tail, and the false-positive arithmetic below would not hold. D2's
robust log-scale noise is
`σ = max(1.4826 · MAD₅₆ʷ(log y), 0.8 · σ_pool, 0.02, min_impact / (20 · median₅₆ʷ))`
(weekday-adjusted, over the **56 days t − 56 … t − 1**; `σ_pool` is the series' as-of pooled
one-step scale, (q₀.₉ − q₀.₁) / 2.563 of its cohort's h = 1 log errors,
§3.4; min_impact per currency, §4.4). The 0.02 and min-impact floors stop
a constant or near-constant series (pure amortisation, the
`constant_amortised` stressor) from producing infinite z-scores on a
one-cent change. The `0.8 · σ_pool` floor stops a series whose MAD happens
to come out small from paging on ordinary noise.

**Why 56 days and a pooled floor (rev. 6, M2).** With an estimated median
and MAD, `z ≥ 4.5` is not a 4.5σ event. A Monte Carlo of the actual
statistic (Appendix B.5.9: the window's median and MAD, D1's as-of
quantile and the forecast's own level error, sd 0.42σ) gives a per
series-day probability for D1 ∧ D2, before the `warning` test, of
**3.6 × 10⁻⁴ with a 28-day window and no floor**, about 100 × Q(4.5) =
3.4 × 10⁻⁶. The challenger's estimate (effective sd ≈ 1.18, P ≈ Q(3.8) ≈
7 × 10⁻⁵) points the same way; the simulation, which also includes the
median's error and D1's bias, finds more. With 56 days and the pooled floor
it is **4.3 × 10⁻⁵**. Every term of the budget below uses these simulated
probabilities, not `Q(z_T)`.

**Valid samples for the log-scale detectors (rev. 24, Copilot
r4179171132).** A day is **valid** when `M` > 0. Zero and negative days
have no log, so every log-scale statistic uses valid samples only:
- **Routing.** A series with ≥ 30 % **non-positive** days (zero or
  negative; revision 23 counted zeros only) in t − 56 … t − 1 takes the
  intermittent route below. A daily-scored series therefore has ≥ 40
  valid days in its window.
- **D2.** The weekday medians, `median₅₆ʷ` and `MAD₅₆ʷ` are taken over the
  valid days of the window. A weekday with fewer than 3 valid days uses
  the window's overall valid median for its adjustment.
- **D1.** Evaluated only when `y_t` > 0 and the point `ŷ_t` > 0. Its
  `q₀.₉₉` and `σ_pool` come from log errors of valid (actual, point)
  pairs only.
- **D8.** Evaluated only when both days of the pair (t − 1, t) are valid
  and both points are > 0. `s₂` is pooled from valid pairs only.
- **D3.** `z_t` exists only on a valid day; on an invalid day `S⁺` and
  `S⁻` carry over unchanged. The episode's mean excess (§4.4) counts the
  invalid days with `x_t = actual − expected`, so a drop day lowers it.
- **D6.** A growth `log(M_k / M_{k−1})` exists only when both days are
  valid. The two-consecutive-days rule needs two valid growths in a row,
  and the cohort fit uses valid growths only.
- **A scored day `t` that is invalid** is not scored on the log scale;
  the drop rules (`info`) apply to it (§3.1).
- **What the budget assumes.** `budget5.py` draws every daily-scored
  `fleet15k` leaf with 56 valid days: the generator's non-intermittent
  series have no zero or negative day. For that population it computes
  exactly these statistics. A real series with up to 16 invalid days
  estimates its median and MAD from as few as 40 values, which widens D2's
  estimation noise beyond the budget's (Known limits).

**Intermittent series (rev. 6, H1).** A series with ≥ 30 % non-positive days in
the 56 days t − 56 … t − 1 is not scored daily, so that bursts do not look like spikes:
- **Zero share ≤ 50 %: weekly.** D3 runs on **non-overlapping** weekly
  sums (Monday–Sunday, log scale), standardised by the median and MAD of
  the previous 8 weekly sums (scale floor 0.05), with k = 0.5 and the same
  h. **A non-positive week** (all zero, or netting to ≤ 0) has no log. It
  is scored as **0.1 × the median of the weekly sums before it**, and that
  value also enters the 8-week history (rev. 24, Copilot r4179171151).
  The floor scales with the series, so the result does not depend on the
  currency unit. Revision 23's `budget5.py` used `log(0.001)` instead.
  Such a week can only lower `S⁺`, never raise an alarm. With no earlier
  week it is skipped (warm-up), and a series with no positive week in its
  history is dormant (D4). Non-overlapping sums keep successive values close to independent,
  which the ARL arithmetic needs; a 7-day rolling sum shares 6 of its 7
  days with the previous day's, so its alarms cluster and its i.i.d. ARL₀
  does not hold. The in-control rate is **not** taken from Siegmund's
  formula: it is a Monte Carlo of exactly this statistic, zeros and
  estimated median and MAD included, **0.0019–0.0028 alarms per
  series-week at h = 9.0** depending on the zero share (Appendix B.5.9).
  An alarm is a candidate on the week's last day; it is `warning` only if
  the week's **mean** daily excess and relative value pass §4.4 (rev. 18:
  the window mean, not its largest day). Time-to-detect on these series is up to
  7 days longer, and their labels are reported separately (AT-7).
  The term is sensitive to the burst model: with a burst-size spread of
  sd 1.0 on the log scale instead of 0.5 it doubles, to ≈ 0.03 per day
  (day clustering at ρ = 0.3 lowers it, to 0.008; Appendix B.5.10).
- **Zero share > 50 %: hurdle statistic (D-24, decided by the
  orchestrator, rev. 7).** The median and MAD of weekly sums are unstable
  when most days are zero (0.011 in-control alarms per series-week at 80 %
  zeros, more than five times the rate at 50 %), so these series get a
  **hurdle (compound-binomial) weekly statistic**. From the 56 days before
  the week: `q̂` = share of active days, `m̂` and `v̂` = mean and variance
  of the active-day values. For the week's sum `W`:
  `z = (W − 7q̂m̂) / √(7q̂(v̂ + m̂²) − 7q̂²m̂²)`, the mean and variance of a
  sum of 7 independent days that are active with probability `q̂`. One-sided
  CUSUM with k = 0.5 and the same h = 9.0; scored only with **≥ 3 active
  days in the window** (a series with fewer is dormant: D4's reactivation
  rule covers it, below). In-control rate, by Monte Carlo of exactly this
  statistic with independent days: **0.00002–0.00052 alarms per
  series-week** for zero shares 0.55–0.8 (the challenger's simulation:
  0.0000 / 0.0001 / 0.0005 at 0.6 / 0.7 / 0.8).
- **Clustering gate.** The hurdle variance assumes independent active
  days. If active days come in runs, the week-to-week variance is larger
  and the statistic over-alarms: with lag-1 persistence ρ = 0.6 on every
  one of these series, 0.17 alarms per day before the gate. So each week
  the job computes **r₁, the lag-1 autocorrelation of the active-day
  indicator over the same 56 days**. **r₁ < 0.30:** treated as
  independent, alarms can reach `warning` (tested on the week's mean,
  §4.4). **r₁ ≥ 0.30:** clustered,
  candidates are capped at `info`. Why 0.30: at n = 56, r₁ for an
  independent series has mean ≈ −0.02 and sd ≈ 0.13 (≈ 1/√56), so 0.30 is
  ≈ 2.4 sd above it and admits 98.8–99.2 % of independent series-weeks;
  for ρ = 0.6, r₁ has mean 0.52–0.56 and sd 0.12–0.19, and only 2.6–12.7 %
  of series-weeks pass (the spread grows with the zero share, since fewer
  transitions are observed). A lower threshold rejects more independent
  series (0.20 admits 94–95 %); a higher one admits more clustered ones
  (0.40 admits 10–21 % at ρ = 0.6). After the gate the ρ = 0.6 case costs
  0.012 per day, and ρ = 0.3 (inside the gate half the time) 0.011.
- **Why clustered series stay `info`.** Clustered occurrence cannot be
  modelled in these slices: it needs a model of dependent occurrence (a
  two-state switching process or a self-exciting count), which is outside
  Slices 3–5's model ladder (§3.2). Under the generator, whose intermittent
  days are independent, **≈ 114 of the 115 leaves score to `warning` and
  ≈ 1 is `info` only** in a given week; the spend left out of AT-2 is
  **≈ 0.03 % of the reachable leaves' spend** (rev. 6: 3.5 %). Real data
  will have more clustered series. AT-7 reports the `info`-signal recall
  of the `info`-only remainder, and D-24 is revisited with real data or
  the `full` profile.

| Id | Detector | Fires when | Targets |
|---|---|---|---|
| D1 | **Residual vs interval** | `y_t > hi₉₉` (one-sided 99 % empirical quantile of the cohort's h = 1 **log** errors, **calibrated on errors with forecast day ≤ t − 1**, so `hi₉₉ = ŷ_t · exp(q₀.₉₉)`; recomputed in every detect run from the as-of error counts in detector state, not stored; rev. 18) or `y_t < lo₉₉` | spikes, drops, runaway onset |
| D2 | **Robust z (floored MAD, log scale)** | `z = (log y − median₅₆ʷ(log y)) / σ`, `\|z\| ≥ z_T` with **z_T = 4.5** | spikes when the model is mis-fit |
| D3 | **CUSUM on a frozen baseline** | see below | level shifts, gradual drift, runaway growth |
| D4 | **New dimension, or reactivation** | (a) a (account, service) or (account, service, region) first seen with `M ≥` min impact on any of its first 3 days, in an account older than 30 days; (b) **reactivation (rev. 8; history fixed in rev. 9):** a series with **< 3 active days in the prior 56-day window** has a **day** with an excess over its expected value that passes the `warning` rules (§4.4), in an account older than 30 days. It reaches `warning` (or `critical`) if **(i)** the series was active on ≥ 50 % of the **28 days ending at its last active day before the dormant stretch** (≥ 14 such days required), or **(ii)** the restart day is ≥ 10 × the min impact **and** ≥ 3 × its prior active-day mean: the active-day values in the 56 days ending at that last active day, extended back to at most 112 days until there are ≥ 3 (none within 112: (ii) does not apply); otherwise `info` | new service, new region, dormant resource restarting |
| D5 | **Tag coverage** | the account's untagged share of `M` (key `cost-center`) rises ≥ 20 pp vs its trailing 28-day median and the untagged amount ≥ min impact. **Share (rev. 26):** `\|N\| / (\|N\| + \|T\|)` with `N` the untagged and `T` the tagged usage effective cost; `null` when both are 0; the median is over defined days, with ≥ 14 required | tagging loss (category `tagging_loss`) |
| D6 | **Cold-start guardrail** | in an account's first 14 days, on **2 consecutive days**, the day-over-day growth of `M` above the **fitted** 99.9th percentile of its cohort's growth at the same day k (below), **and** `M` ≥ 10 × min impact. Growth rather than level, because a large account onboarding normally is not an anomaly | runaway in a new account |
| D7 | **Commitment coverage** | the committed-share rules of §4.1 | `commitment_effect`, `commitment_expiry` |
| D8 | **2-day residual sum (rev. 6, L1)** | `r_{t−1} + r_t ≥ z_T · s₂` with the same z_T, where `r = log y − log ŷ` is the one-step log residual and `s₂` the as-of pooled scale of 2-day residual sums (the cohort's (q₀.₉ − q₀.₁) / 2.563 of `r_{s−1} + r_s` over days s ≤ t − 1, so the scored pair is never part of its own scale; §3.4) | level shifts and 2-day spikes too small for D2 on one day |

**D4 reactivation (rev. 8).** A dormant series (fewer than 3 active days
in the 56 days t − 56 … t − 1) is not scored by the hurdle statistic, and D4's
first-seen rule does not apply to it, because the (account, service) has
been seen. Without a rule, a dormant resource that restarts at high spend
would go unflagged until 3 active days entered the window, and by then
`q̂` and `m̂` would already include the new regime. Hence rule (b):
- **A single day, not a 2-day sum.** A dormant series' expected value is
  ≈ 0, so one day's excess already equals its spend; there is no noise
  scale to average over, and waiting for a second day only delays the
  alert (AT-3's median ≤ 1 day). This is also the test D4's first-seen
  rule uses. The severity rules of §4.4 apply unchanged (`critical` at
  ≥ 10 × min and ≥ 50 %).
- **The history condition (corrected in rev. 9).** Without one, the rule
  fires on bursty intermittent series that happen to have had ≤ 2 active
  days: under the generator ≈ 0.0017 candidates per day, and if every
  intermittent series had lag-1 persistence 0.6, ≈ 0.32 per day (Appendix
  B.5.11). A dormant *resource* was active on most days before it stopped;
  a bursty series was not. Revision 8 looked at the 14 days just before
  the 56-day window, which are themselves dormant zeros whenever the gap
  is longer than 56 days: a resource forgotten for a quarter got `info`
  whatever its size. The history is now the **pre-dormancy period**. The
  *dormant stretch* is the longest run of days ending at t − 1 (the day before the restart day t) that holds
  at most 2 active days; its day before is the series' last active day
  before dormancy, and (i) looks at the 28 days ending there. A gap of any
  length is judged on the days before it.
- **The size override (rev. 9).** A sparse but expensive resource (a
  weekly batch is active on ≈ 14 % of days) fails (i) however large its
  restart. Rule (ii) lets a restart reach `warning`/`critical` regardless
  of history when it is ≥ 10 × the min impact **and** ≥ 3 × the series'
  prior active-day mean. The relative test is what keeps bursty series
  out: a normal burst is about 1 × the active-day mean, and only the right
  tail of the burst-size distribution reaches 3 ×. Without it, a
  size-only rule would cost 0.00033 per day under the generator and 0.050
  at persistence 0.6. **Prior-mean window: the active-day values in the 56
  days ending at the last active day; if there are fewer than 3, the
  lookback extends to at most 112 days for the 3 most recent (rev. 10;
  the 112-day cap fixed in rev. 11).** It is the mean of *active* days, not of all
  days, so a series that is usually zero is not "3 ×" just by being
  active. 56 days rather than 28 gives a weekly batch ≈ 8 values, not ≈ 4,
  and matches the hurdle statistic's window. The extension covers a
  **monthly** job (≈ 2 active days in 56, ≈ 4 in 112), which would
  otherwise never have 3 values and reach only `info` even at 10 × its
  size; it barely moves the cost, because the 3 × relative test does the
  filtering (generator 1.0 × 10⁻⁵ per day, was 9 × 10⁻⁶). **Named limit:
  a quarterly job** (≤ 2 active days in 112) still has no prior mean, so
  (ii) does not apply and its restart is `info` unless (i) holds.
  The extra state is a few numbers per series (the last 3 active-day
  values), so peak disk is unchanged.
- **False positives** (Appendix B.5.11). **Under the generator** the line
  is **< 0.0001 per day**: 1.4 × 10⁻⁵ with 28 days of history (5 × 10⁻⁶ by
  (i), 1.0 × 10⁻⁵ by (ii)); the **worst case, the union of (i) and (ii) for
  a series with only 14 days of history, is 8.5 × 10⁻⁵**. These figures
  are exact for independent days. The generator has no unlabelled series
  that is regular, goes dormant and restarts. The only route is an
  intermittent series with ≈ 80 % zero days that by chance has ≤ 2 active
  days in a window, and either a mostly active pre-dormancy month or an
  outsized restart.
- **Real-data risk with clustered days (rev. 10, corrected).** Revision 9
  treated the history as independent of the dormant window, and that
  **underestimates** when days cluster: a clustered series that has just
  gone quiet was usually in an active run before. Simulating the
  two-state chain with the real stretch, history and prior-mean
  definitions gives, per day across the intermittent leaves:
  - at persistence ρ = 0.3: (i) 0.00083, (ii) 0.00012, union **0.00094**;
  - at ρ = 0.6: (i) 0.052, (ii) 0.0016, union **0.054**.

  Revision 9's figures were 0.00015 and 0.0064 for (i). The challenger's
  independent simulation gives 0.00087 and 0.050, and a union of 0.052 at
  ρ = 0.6. The generator's days are independent, so no gate moves. On
  real data with strongly clustered intermittent series, though, route
  (i) alone could take about a third of the 0.15 design margin.
  Seasonal or campaign workloads, quarterly jobs and planned restarts
  look like this rule's target too. They are measured on real data only;
  `tuning-natural` cannot show them.
- **Recall.** The natural and existing enriched seeds plant no
  reactivation, so the rule would never be scored. The enriched seed gains
  a label kind **`dormant_reactivation`** (§2.5, Appendix C.2): ≥ 100
  meaningful labels on non-intermittent individual series, placed by
  spend, with the gap length left free (≥ 56 days). Simulated per the spec
  (`reactivation.py`, 20,000 labels), **every label reaches `warning` by
  construction under (i): pass rate 1.000** (revision 8's rule: ≈ 0.37
  by the challenger's simulation). Placed on any individual series,
  intermittent ones included, the pass rate would be 0.970.

**D8 (rev. 6, L1)** is the challenger's parallel short-window detector.
Its scale is pooled from the cohort's 2-day sums, so it includes the
forecast's level error, which both days share (`s₂ ≈ √(2 + 4 · 0.42²)` in
units of σ). Before the `warning` test it fires with probability
**1.5 × 10⁻⁵ per series-day** (Appendix B.5.9). It catches a shift of
**≥ 3.75σ by day 2 with probability ≥ 0.5**, and of ≥ 4.9σ with
probability ≥ 0.9. The challenger's 3.2σ is the same rule without the
forecast's level error.

**D3, CUSUM on a frozen baseline (M6).** An adaptive one-step residual
absorbs a slow drift into the model state, so CUSUM would never see it.
D3 instead compares actuals with a **baseline frozen at an anchor day `a`**:

- the expected value is `ŷ(t | a)`: the M1 forecast for day `t` made from
  the model state **as of `a`**, so normal growth (the damped trend) and
  weekly seasonality are in the baseline, but nothing learnt after `a` is;
- `zₜ = (log yₜ − log ŷ(t | a)) / σ(t − a)`, where `σ(h)` is the as-of
  interval scale at horizon `h` ((q₀.₉ − q₀.₁) / 2.563, log scale,
  calibrated on errors with forecast day ≤ t − 1), floored as above;
- `S⁺ₜ = max(0, S⁺ₜ₋₁ + zₜ − k)`, `S⁻ₜ = max(0, S⁻ₜ₋₁ − zₜ − k)`,
  k = 0.5; an upward alarm when `S⁺ > h`, with **h = 9.0** (rev. 6; 7.5
  before);
- **re-anchoring:** every 14 days, and only when `S⁺ = S⁻ = 0` (in
  control); a baseline is never older than 28 days (then it is re-anchored
  and the sums restart). While a sum is positive the baseline stays
  frozen, so a drift cannot be absorbed.
- **The 28-day cap wins (rev. 19, the challenger's L2).** On day a + 28
  the baseline is re-anchored and the sums and the episode restart, even
  if a sum is positive or the leaf's group is still open. An aggregate
  scope stores exactly 28 baseline days (Appendix D.2), and a forecast
  older than 28 days is outside the horizons `σ(h)` is calibrated for at
  this cadence. An open group is not closed by the re-anchoring: its
  later candidates extend it through persistence (§4.5, step 4b).
- **Alarm episode and restart (rev. 18).** An upward alarm's **episode**
  is the run of days since `S⁺` last left 0, up to the alarm; its mean
  excess is the candidate's statistic (§4.4). After an alarm `S⁺`
  restarts at 0, and the next episode begins the next day, as the
  budget's simulation of alarm episodes does (Appendix B.5.10). The
  14-day re-anchoring also waits until the leaf's open group resolves, so
  the restart does not let a drift into the baseline; the 28-day cap
  (above) still applies. Without the
  restart, a slow drift's episode mean trails its current level and the
  drift's time-to-detect roughly doubles (Appendix B.5.13).
- **Scale error (rev. 6, M2).** `σ(h)` is pooled, so on a given series it
  is off by that series' difference from its cohort (assumed log-normal,
  sd 0.1; **assumption**, measured on `tuning-natural`). CUSUM is convex in
  that error: a scale 10 % too small lowers k and h together in true
  units. The scale-mixed in-control rate is about twice Siegmund's: an
  effective ARL₀ of **≈ 5,930 days at h = 7.5** (Siegmund 11,585) and
  **≈ 19,700 at h = 9.0** (Siegmund 51,985). The budget uses the
  scale-mixed rate.
- **Not covered: the frozen baseline's autocorrelation.** `ŷ(t | a)`
  carries the forecast's error at `a` for the whole run, so successive
  `zₜ` share a component and are positively autocorrelated. `σ(h)`
  includes that error's variance at each horizon, but the ARL arithmetic
  assumes independent `zₜ`, and positive autocorrelation shortens the
  in-control run. **The conservative D3 bound below does not cover this**
  (as revision 4 stated). Only the `tuning-natural` measurement does.

**Aggregate scopes (rev. 6)** (billing account, business unit, provider,
tenant; **100** on `fleet15k`, the D3 scopes of the rev. 24 census; the
budget counts 550 as an upper bound) run **D3 only** (state between runs in
`detector_scope_state`, rev. 18), on their own bottom-up forecast, standardised by the pooled scale of aggregates of the same kind
and size decile. Standardising by their own 56-day MAD instead gives an
in-control rate of 4.4 × 10⁻⁴ per day at h = 7.5 (five times Siegmund's)
and would cost 0.097 false groups per day at h = 9.0 on its own. Spikes and
2-day jumps at an aggregate scope are seen through its leaves (D1, D2, D8
on each leaf) and grouped upward (§4.5). The aggregate scope adds what no
single leaf shows: a drift spread thinly over many leaves.

**D6's percentile (rev. 6, L3).** With ≈ 600 onboardings per 13 months
(≈ 185 in `fleet15k`'s span), an empirical 99.9th percentile per day k
cannot be estimated: even one exceedance needs ≈ 1,000 values on average.
D6 therefore fits a log-normal to day-over-day growth. For each k = 2…14:
the mean `μ̂_k` of `log(M_k / M_{k−1})` over the cohort's onboardings
whose day k is ≤ t − 1. One robust scale `σ̂` is pooled across k (1.4826 ×
the MAD of the centred values, ≈ 13 × the per-k count). The threshold is
`μ̂_k + 3.09 · σ̂ · √(1 + 1/n_k)`. With n_k < 30, `μ̂_k` falls back to the
pooled mean. The two-consecutive-days rule makes a false fire ≈ q² per
account-day. If the true tail is ten times heavier than the fit (q =
0.01 instead of 0.001), the D6 term is still **4 × 10⁻⁵ per day**
(Appendix B.5.9).

**False-positive budget (N1, rev. 5 M1, rev. 6 H1 and M2).** The gate is
derived from the expected true-group rate. On `fleet15k`'s natural-rate
seeds the 61-day window holds ≈ 158 labels of kinds that can reach
`warning`, giving **≈ 73 true groups per seed (≈ 1.2 per day)** (Appendix
B.5.7). Precision ≥ 0.80 then allows at most ≈ 0.30 false groups per day:
that is the **AT-4 gate**. The detector is **tuned to a margin: ≤ 0.15
false groups per day in expectation, all sources included**.

Every source has its own line, derived by closed form or Monte Carlo over
the `fleet15k` leaf list (`budget5.py`, Appendix B.5.10; natural rates,
z_T = 4.5, h = 9.0). The figures count candidate leaf-events, an upper
bound on groups, since grouping only merges.

| Source | Derivation | Expected false groups / day |
|---|---|---|
| D1 ∧ D2 on the 3,259 daily-scored leaves that can reach `warning` (≥ 20 % and ≥ $100 excess) | per series-day probability from the Monte Carlo of the 56-day median and MAD with the pooled floor, D1's as-of quantile and the forecast's level error, with the `warning` test | **0.0061** |
| D8 on the same leaves | the same Monte Carlo for the 2-day sum against `z_T · s₂`, with the `warning` test on the 2-day mean | **0.0003** |
| D3 on leaves | scale-mixed in-control rate (effective ARL₀ ≈ 19,700 days) × P(the alarm episode's mean excess reaches `warning`), from 3 M simulated steps = **75 alarm episodes** at h = 9.0 | estimate **< 0.0001**, but **resolution-limited**: 0 hits in 75 episodes bound P(`warning` \| alarm) by 3/75 per leaf, i.e. **≤ 0.0066**. Conservative bound (every alarm on the 476 daily-scored leaves ≥ $500/day counted as `warning`, the resolution bound on the rest): **0.0298**. Neither covers the frozen-baseline autocorrelation |
| Intermittent, weekly-scored (66 leaves, zero share 30–50 %) | Monte Carlo of the weekly statistic (8-week estimated median and MAD) × P(the week's excess reaches `warning`) ÷ 7 | **0.0139** (could be up to ≈ 2 ×, ≈ 0.03, with a wider burst-size spread) |
| Intermittent, hurdle-scored (115 leaves, zero share > 50 %) | Monte Carlo of the hurdle statistic with the clustering gate, independent days as generated, × P(the week's excess reaches `warning`) ÷ 7; conservative: every gated alarm | **0.0028** (every alarm: 0.0028; `info` signals ≈ 0.0002 per day) |
| Aggregate scopes, D3 only, **every alarm counted** | the budget counts **550 as an upper bound (100 actual**, rev. 24 census; rev. 25) × the scale-mixed in-control rate | **0.0279** (conservative: ≈ 0.005 at 100) |
| Calendar cohorts after the component (pinned factors; P3 and P4 events with 2 and 3 prior cycles, `month_start` with 1 and 2) | Monte Carlo of the median estimator and of D1 ∧ D2, D8 and D3 on the residual | **0.0012** (without the component: ≈ 7.0) |
| First and second occurrences of a calendar class (cohort accounts onboarding in the span; no factor yet) | Monte Carlo, × onboarding probability | **0.0490** (≈ 3.0 groups per seed) |
| D4 new dimension | the generator emits no unlabelled new service or region; measured on `tuning-natural` | **0** by construction |
| D4 reactivation (rev. 9, 10) | exact two-state-chain probability of ≤ 2 active days in 56, then an active day at ≥ min impact, with the pre-dormancy history condition (i) or the size override (ii) (Appendix B.5.11) | **< 0.0001** (1.4 × 10⁻⁵; worst case, the union of (i) and (ii) with 14 days of history, 8.5 × 10⁻⁵; `info` candidates ≈ 0.0017 per day). Real data with clustered days: 0.00094 (ρ 0.3), 0.054 (ρ 0.6) |
| D5 tag coverage | no unlabelled tag change; measured | **0** by construction |
| D6 cold start | two consecutive days above the fitted 99.9th percentile, × onboardings | **< 0.0001** (4 × 10⁻⁵ if the tail is 10 × the fit) |
| D7 commitment coverage | every commitment change is labelled (`commitment_effect` is `info`, `commitment_expiry` an alert) | **0** by construction |
| Holidays | drops are `info` (D-14); the return to normal is not an excess over the forecast | **0** by construction; measured |
| **Total** | | **0.101** (**0.131** with every conservative bound; 0.146 if the weekly term is also doubled); the reactivation line adds < 0.0001 |
| *Reported, not in the total:* calendar factors with ±10 % month-to-month jitter (§2.3) | same Monte Carlo, jittered factors | +0.082 (calendar term 0.083 instead of 0.0012); P(pass) 0.993 / 0.959 at the design / conservative total |
| *Not covered by any line:* frozen-baseline autocorrelation in D3 | — | measured on `tuning-natural` only |
| *Not covered by any line (rev. 14):* **negative usage**. Leaf-days with `M` ≤ 0 are not scored on the log scale, and a same-day negative-`Usage` row (a credit booked as usage) can net a spike down below the thresholds | only `ChargeCategory = 'Usage'` rows can do this: `Credit` and `Tax` are outside `M` by definition (D-09). `fleet15k` emits no negative usage, so the generator cannot measure it | a **recall** blind spot, not a false-positive cost; real data only |

**Choice of thresholds.** With k = 0.5 (Siegmund ARL₀ shown; the budget
uses the scale-mixed rate):

| z_T | h | ARL₀ (Siegmund, days) | Total | Total, conservative |
|---|---|---|---|---|
| 4.5 | 7.5 | 11,585 | 0.183 | 0.269 |
| 4.5 | 8.0 | 19,112 | 0.145 | 0.205 |
| 4.5 | 8.5 | 31,523 | 0.120 | 0.162 |
| **4.5** | **9.0** | **51,985** | **0.101** | **0.131** |
| 4.5 | 9.5 | 85,723 | 0.089 | 0.114 |
| 5.0 | 7.5 | 11,585 | 0.178 | 0.264 |
| 5.0 | 8.0 | 19,112 | 0.140 | 0.199 |
| 5.0 | 8.5 | 31,523 | 0.115 | 0.156 |
| 5.0 | 9.0 | 51,985 | 0.096 | 0.126 |
| 5.0 | 9.5 | 85,723 | 0.084 | 0.109 |

**z_T = 4.5, h = 9.0** is the least strict pair (lowest z_T, then lowest
h) whose total stays ≤ 0.15 **with every conservative bound** (rev. 7: still
so with the hurdle term and `month_start`'s single cycle). h rises
from 7.5 to 9.0 because the scale error roughly doubles CUSUM's in-control
rate. Raising z_T buys little, since D1 ∧ D2 and D8 are already small; the
large terms are D3 on leaves and aggregates (set by h) and the unlearnable
calendar occurrences (set by neither).

**Probability of passing, and what it is conditional on.** Precision and
false-positive count were simulated over two pooled natural seeds (122
days, true groups ~ Poisson(146)). **If** the true false-positive rate is
0.15 per day, AT-1 and AT-4 both pass with **probability ≈ 0.999**; at
0.20, ≈ 0.977; at the 0.30 gate, ≈ 0.435. These are probabilities
**conditional on an assumed rate**. They say what the margin buys; they do
not say what the rate is. **Under ±10 % calendar jitter** (rev. 7, L3) the
rate would be ≈ 0.183 per day from the design total (P(pass) ≈ 0.993) or
≈ 0.213 from the conservative one (≈ 0.959).

**The real control is the measurement (M1, rev. 6 M2).** The table above
predicts the rate from a model of the generator, with assumptions
(scale heterogeneity, the forecast's level error, D3's independence). The
control is the **total measured on the `tuning-natural` seed**, a
natural-rate seed used only for tuning (§4.8), **with its exact Poisson
(Garwood) 95 % upper bound**. The label-dense `tuning` seed is used only
for recall-side tuning. On `tuning-natural` the job measures every source
in the table, and raises z_T and h, in steps of 0.25, until:
- the **measured total is ≤ 0.15 per day**; and
- the **Garwood 95 % upper bound is ≤ 0.30 per day**.

For example, 7 false groups in 61 days is 0.115 per day, with a 95 %
interval of [0.046, 0.236]; 9 groups is 0.148, [0.067, 0.280]. The frozen
values are committed before any evaluation seed is generated.

**What the control cannot see.** `tuning-natural` comes from the same
generator: pinned calendar factors, independent intermittent days, the
generator's burst sizes. It measures the implementation against that
model, so it **cannot detect** misspecification of the jitter kind (or
clustered occurrence, or wider bursts). Only real data can.

**Delay cost, and AT-3 (rev. 6, L1).** CUSUM detection delay is ≈
`(h + 1.166) / (δ − k)` days: at h = 9.0, ≈ 2.9 days for a 4σ shift and
≈ 6.8 days for 2σ. D1 ∧ D2 catches shifts of ≳ 4.5σ on day 1, and D8
catches ≥ 3.75σ by day 2 with probability ≥ 0.5. **Level-shift
multipliers are pinned** (§2.5: log-uniform on [1.2, 3.0]). On the
generator, every meaningful level shift is ≥ 4.8σ: a shift needs
L · (m − 1) ≥ $200 per day to be meaningful, so L ≥ $1,000 per day at
× 1.2, and series that large have σ ≤ 0.04 in the generator. Measured
time-to-detect (Appendix B.5.9): **median 1 day, p90 1 day**, spend-weighted
or per series, and the same for × 1.2–1.4 shifts alone. **AT-3 is no
longer at risk on `fleet15k`.** It would be at risk on real data where
large series are noisier: a × 1.2 shift on a σ = 0.10 series is 1.8σ, which
only D3 catches, in ≈ 8 days. If that happens on real data, the trade-off
between alert volume and delay is an **owner decision** (D-20).

**Drift time-to-detect under the per-candidate severity (rev. 18, the
challenger's M1).** AT-3 measures drift from the day its cumulative
excess reaches the minimum impact. A ramp of plateau excess `E` over `R`
days has daily excess `E·k / R` on day `k`, so that anchor is at
`k_c ≈ √(2R · min / E)`. A candidate can reach `warning` only from the
day its excess reaches `min` and its relative value 20 %. The
challenger's case, `E` = 2 × min over 45 days, gives day 22.5 against an
anchor at ≈ 6.7. The binding test on large leaves is the 20 %: at
`a` = 0.30 over 45 days it is 28 days after the anchor.

What that means for the target (`drift_ttd.py`, Appendix B.5.13: 20,000
meaningful labels as Appendix C.2 draws them, on the `fleet15k` leaf list):
- **Noise-free first-passing day** (the first day the injected excess
  itself passes, + 1 day for data availability): **median 6, p90 12
  days** after the anchor; 67 % of labels within 7. It is not a lower
  bound: noise can push a day over the thresholds earlier (rev. 19, the
  challenger's L1).
- **All detectors on the true baseline and scale** (optimistic): median
  **5**, p90 11.
- **D3 alone** (D1 and D8 compare with adaptive one-step forecasts,
  which follow a slow ramp): median **7**, p90 13 with the restart after
  an alarm (above); median 11, p90 25 without it.
- **The cumulative clause does not help:** it is `critical` only, at 50 ×
  min, reached a median 18 days after the anchor. There is no cumulative
  `warning` clause.

So the target (median ≤ 7 days) is **not infeasible by construction**,
but it is **at risk**: D3, the detector that sees a slow drift, reaches
the target with no margin even with the true scale. Its `σ(h)` grows with
the horizon and carries the scale error, which make it slower. The target
and its anchor are unchanged (D-20). The measured figure on the enriched
seed decides. A miss is recorded and escalated to the owner, not relaxed
(Known limits; open item for the owner).

**Combination and precedence.** A leaf-day is a candidate if (D1 **and**
D2), or D8, or D3, or D4, or D5, or D6, or D7 (intermittent series: the
weekly D3 only). When several fire, the candidate's category is taken from
the first match in this order: D7 (`commitment_expiry` /
`commitment_effect`), D5 (`tagging_loss`), D4 (`new_service` /
`new_region` / `dormant_reactivation`), D6 (`new_account_runaway`), D3 (`level_shift` if the CUSUM
run started on one day with ≥ 80 % of its excess in the first 3 days, else
`gradual_drift`; `runaway_resource` when one resource row carries ≥ 50 % of
the excess), D8 (`level_shift`, re-categorised `spend_spike` if the series
is back inside its 80 % interval within 2 days), D1 ∧ D2 (`spend_spike`, or
`spend_drop` downwards). Aggregate scopes run D3 only, on their own
bottom-up forecast (§4.5, step 6).

### 4.3 Detector state and cost

Per series the job carries, between daily runs: the M1 state and the
calendar factors (with their value counts m and t-statistics), the anchor
day and anchor state for D3, `S⁺`/`S⁻`, the 56-day weekday medians and MAD
of `log y` for D2, the previous day's one-step residual for D8, for
intermittent series the last 8 weekly sums (zero share ≤ 50 %) or the
hurdle's q̂, m̂, v̂ and r₁ (> 50 %), and the weekly `S⁺`; for D4's
reactivation rule the active-day count over 56 days, the last active day
before the dormant stretch, the active share of the 28 days ending there
and its last 3 active-day values (for the prior mean of up to 112 days);
the
trailing committed and untagged shares for D5/D7, and the per-cohort as-of
error buckets, including the 2-day sums for `s₂` (Appendix D,
`detector_state`). D1's `q₀.₉₉` and `q₀.₀₁`, `σ_pool` and `s₂` are
derived from those counts in every detect run; none of them is stored
(rev. 18). D6's per-k growth fit is per cohort, recomputed daily
from the onboardings' first 14 days. Per D3 aggregate scope (100; rev. 25): D3's
anchor day, its frozen 28-day baseline, `S⁺`/`S⁻` and the current
episode (Appendix D, `detector_scope_state`, rev. 18). The leaf anchor
holds the **complete** M1 state as of the anchor (`φ` and the calendar
factors included), so a refit or a calendar update after the anchor
cannot move `ŷ(t | a)` (rev. 18). Holt-Winters and CUSUM updates are O(1) per series per
day; refits are weekly (cost in §3.11).

### 4.4 Impact and severity

- **Two amounts (rev. 17, Copilot r4178820538).**
  - **Daily excess** `x_t = actual_t − expected_t`, and **daily relative**
    `ρ_t = x_t / expected_t`, for each day `t` of the anomaly.
  - **Cumulative impact** = Σ `x_t` over the anomaly's days. It is the
    amount the API returns as `impact`, in the billing currency, positive
    for increases, computed in SQL.
- **Severity uses the daily values**, plus the cumulative impact only in
  the explicit "cumulative" clause below. Revision 16 compared a
  cumulative impact with per-day thresholds.
- **Which daily values: the candidate's own statistic (rev. 18, the
  challenger's M1).**
  - A candidate from a **one-day** statistic (D1 ∧ D2, D4) is tested on
    its day's `x_t` and `ρ_t`.
  - A candidate from a **multi-day** statistic is tested on **its
    window's mean**: the mean daily excess `x̄ = Σx / n` and the relative
    value `ρ̄ = Σx / Σexpected` over that window (with `Σexpected` ≤ 0,
    `ρ̄` follows the rule for `ρ_t` below; rev. 26). The windows are D8's and
    D6's two days, the D3 alarm's episode (§4.2) and the 7 days of the
    weekly or hurdle statistic.
  - **Expected value of a week (rev. 19, the challenger's L4).** For the
    weekly and hurdle statistics, `Σexpected` is the statistic's own
    baseline, not the forecast: the **median of the previous 8 weekly
    sums** (taken on the log scale and back-transformed) for the weekly
    statistic, and **`7q̂m̂`** for the hurdle. `Σx` is the week's sum minus
    that baseline. `budget5.py` computes exactly these
    (`exp(x − med) − 1` and `W / (7q̂m̂) − 1`).
  - This is the test the false-positive budget applied (`budget5.py`:
    `need_rel(L) = max(0.20, MIN / L)` against the window's mean or
    relative excess), so the budget's figures stand. Revision 17's "on
    some day" read looser than the budget. For example, a weekly-scored
    leaf at `L` = $150/day whose week is +$400 (+38 %) and whose largest
    day is +$180 would have been `warning`; its week mean is $57/day, so
    it is `info`.
- **Expected value 0 or below.** This happens for new services, new
  regions and reactivations (D4), where there is no baseline. Then
  `ρ_t` is defined as **+∞ when `x_t` > 0** and as 0 otherwise. So a D4
  candidate's severity depends on `x_t` against the minimum impact alone,
  deterministically: `warning` at ≥ min, `critical` at ≥ 10 × min.
- **Minimum impact** per currency (D-13): USD 100, EUR 100, GBP 100,
  JPY 15,000 per day, configurable per tenant and per billing account.
  (AWS's getting-started default summary is above $100 and 40 %; Vantage
  floors at $5 and 0.5 % of the report total [A7, A17].)

| Severity | Rule (per candidate: its day's `x_t`, `ρ_t`, or its window's `x̄`, `ρ̄`; unless "cumulative") | Notified (once D-17 exists) |
|---|---|---|
| `critical` | some candidate of the group: excess ≥ 10 × min **and** relative ≥ 50 %; or cumulative impact ≥ 50 × min | yes |
| `warning` | some candidate of the group: excess ≥ min **and** relative ≥ 20 % | yes |
| `info` | flagged but below `warning`; all `spend_drop` and `commitment_effect` by default | no; visible with `severity=info` |

Severity is re-evaluated each day the anomaly persists and only goes **up**
automatically.

### 4.5 Grouping, deduplication and root cause

Goal: **one root cause, one alert group**, the same groups for the same
input. Each day's candidates are sorted by (currency, provider, billing
account, service, sub-account, `leaf_id`, category), and the rules below run
**in this order**; each rule claims, in sort order, the candidates it
applies to that no earlier rule has claimed. A candidate belongs to exactly
one group.

| Step | Rule | Group scope |
|---|---|---|
| 1 | **Fan-in first (rev. 17, Copilot r4178820430):** steps 2–4 run before persistence, over day t's candidates **plus every open narrower group** of the same category **whose first day is within ±1 day** of the broader group's start and that lies in **the rule's own scope** (rev. 18, the challenger's L2): for steps 2–3, singletons and (for step 2) billing-account groups of the same service; for step 4, singletons of the same account, whatever their service. A persisted singleton therefore counts as a member and is merged, rather than hiding its leaf from the fan-in thresholds. (Revision 17 required the same service for every step, which excludes exactly the members account fan-in needs.) | see steps 2–4 |
| 2 | **Provider-wide (new, M6):** candidates of one service and category across **≥ 2 billing accounts of one provider**, covering ≥ 20 accounts or ≥ 50 % of the provider's `M` for that service, starting within ±1 day | (provider, service), one group **per currency** |
| 2b | **Provider-wide, many services:** candidates of one category in ≥ 20 % of a provider's services and accounts on one day (e.g. a holiday drop) | (provider), one group per currency |
| 3 | **Billing-account fan-in:** ≥ 5 accounts of one billing account, or ≥ 50 % of that service's `M` there, starting within ±1 day | (billing account, service) |
| 4 | **Account fan-in:** ≥ 3 services of one account starting within ±1 day | (account) |
| 4b | **Persistence:** a candidate on a leaf and category not claimed above, whose open group's last day is ≥ t − 3, extends that group (no new alert) | the existing group |
| 5 | **Singleton:** anything left | (leaf) |
| 6 | **Aggregate-only:** an aggregate-scope candidate whose excess is < 80 % explained by groups already formed that day | (aggregate scope), top contributors as root causes |

- **Deterministic chaining across days.** Group ids are derived from the
  dedup key (UUID v5 of tenant, scope kind, scope key, currency, category, first day and occurrence (rev. 25); scope keys as in Appendix D.0),
  so the same input always gives the same ids. When a broader rule (steps
  2–4) on scored day t claims leaves whose own groups started within ±1 day
  of the broader group's start, those groups are **merged** into the
  broader group: they are resolved with reason `merged` and a pointer to
  the survivor, and an event is recorded. **Merge semantics (rev. 17):**
  - The survivor's first day is the **earliest first day among its
    members**, which fixes its dedup key and UUID v5.
  - Each leaf-day belongs to exactly one group, so the survivor's impact
    is the sum over its members' leaf-days, with no double count.
  - Its severity is the highest any member reached; it only goes up.
  - Merged groups keep their ids, point to the survivor, and stop being
    extended.
  - **Merge targets are terminal (rev. 23, Copilot r4179131145).** A group
    may be merged only into a group that is itself **not merged** (its
    `merged_into` is NULL), and only while **no other group points at
    it**. A database trigger, `tg_anomaly_merge_guard`, checks both under
    row locks (Appendix D.4). So every merged group points directly at a
    survivor, and no cycle (A → B → A, or longer) can form.
  - **A survivor that is later merged itself** (a billing-account group
    absorbed the next day by a provider-wide group): in one transaction
    the job first **re-points** every group merged into it at the new
    survivor, recording a `repointed` event for each (old and new target,
    §4.6), and then merges it. Pointers
    stay one level deep, and the evaluator and the API never follow a
    chain. Prohibiting the merge instead would leave the provider-wide
    event as two groups, which is what fan-in exists to prevent (AT-6). Merges are allowed only inside that
  ±1-day window, so chaining always terminates. The evaluator counts the
  survivor only, and reports how many groups were merged and how late.
- **Root causes:** up to **10** contributors ranked by excess over the
  group's days, from leaf `M`, region rows and resource rows, each with its
  amount and share (AWS ranks up to 10 root causes [A8]).
- **Dedup key:** (tenant, scope kind, scope key, currency, category, first day, **occurrence**), with the full-identity scope keys of Appendix D.0. A
  resolved group is **never reopened**; a later candidate on the same
  scope and category starts a new group (rev. 23, the challenger's Low:
  revision 22 said a group resolved "more than 7 days ago" is not
  reopened, which implied a reopening that §4.6 has no transition for).
- **Occurrence (rev. 25, Copilot r4179229443).** Usually the new group
  has a later first day, and so a new key. But a restatement can bring
  back a candidate with the **same** first day: batch B1 detects it, B2's
  restatement removes the excess and the group is resolved `restated`
  (§4.7), and B3 restates the day back. Without a discriminator that
  candidate's dedup key and UUID v5 would collide with the resolved row.
  - `occurrence` (1, 2, …) is part of the dedup key, its `UNIQUE`
    constraint and the UUID v5 input.
  - It is allocated in the detect run's success transaction, under the
    per-(tenant, `detect`) lock: 1 when no row has the key's other six
    parts, the highest existing occurrence + 1 when every such row is
    resolved. An open row with those parts is the same group and is
    extended (persistence, step 4b), never duplicated.
  - Because allocation follows the input order, the same input gives the
    same occurrences and ids.
  - Merge guard, fan-in and events treat each occurrence as its own
    group: it has its own id, its own `detected` event and its own merge
    pointer. A survivor's first day is the earliest member's, and its key
    takes the occurrence allocated then.

### 4.6 Lifecycle and the `CostFinding` mapping

**States:** `open → acknowledged → resolved` (the existing `FindingStatus`),
with a reason on every transition, recorded in an append-only events table:

| Transition | By | Reason codes |
|---|---|---|
| → `open` | job | `detected` |
| `open` → `resolved` | job | `auto_recovered` (3 consecutive days back inside the 80 % interval), `new_baseline` (a level shift persisting 14 days is accepted as the new normal), `restated` (§4.7), `merged` (§4.5) |
| `resolved` → `resolved` | job | `repointed` (rev. 24, the challenger's Low): a merged group's target changes from a survivor that is about to be merged to the new survivor (§4.5); the event records the old and the new target |
| `open` → `acknowledged`, → `resolved` by a person | — | **Deferred (D-15).** No write endpoint until per-user identity exists. So lifecycle parity (A-g) is **partial**: findings open and resolve automatically, but nobody can acknowledge one or give feedback. Reason codes reserved for later: `acknowledged`, `expected`, `fixed`, `not_an_anomaly`. |

**Mapping onto `CostFinding`** (`src/costsource/CostSourceClient.ts`), via a
new `ratio-native` source behind the CostSource seam:

| `CostFinding` field | Native anomaly |
|---|---|
| `id` | `ratio-native:anomaly:<uuid>` |
| `sourceId` | `ratio-native` |
| `type` | `'anomaly'` |
| `category` | `spend_spike`, `level_shift`, `gradual_drift`, `new_service`, `new_region`, `runaway_resource`, `tagging_loss`, `spend_drop`, `commitment_effect`, `commitment_expiry`, `new_account_runaway` (`spend_spike` is the seed's existing value) |
| `title` | generated, e.g. "SyntheticAWS · SYN-A-7KQ2M9XD · Object Storage: +$2,140/day (+180 %) since 2026-05-12" |
| `resourceId` | top root-cause resource id if any, else the scope key (`account:<id>/service:<name>`, `provider:<name>/service:<name>`) |
| `workloadId` | `null` (fleet accounts are not Ratio workloads) |
| `estimatedMonthlySavings` | `0` |
| `observedSpendDelta` | cumulative impact, rounded to 2 decimals (display only; the decimal string stays in the native API) |
| `severity`, `status` | same vocabulary; `status` is never `acknowledged` while D-15 is deferred |
| `detectedAt` | first detection time (ISO 8601) |

**Gap in the type:** `CostFinding` has no currency, no decimal amount and no
scope; D-18 adds **optional fields** (`currency?`, `impact?` as a decimal
string, `scope?`, `firstDay?`, `lastDay?`, `expected?`, `actual?`) so the
PointFive mapping is unchanged.

### 4.7 Restatements

Each anomaly records the batches its evidence came from
(`basis_batch_seqs`). When a period is republished, the rollups of the new
batch replace the old ones on the read side, and the next detection run
re-evaluates the affected days: an anomaly whose excess no longer holds is
resolved with reason `restated`; one that still holds is updated and keeps
its id. If a later restatement brings the excess back on the same first
day, the candidate opens a **new occurrence** with a new id (§4.5, rev.
25); the resolved group stays resolved. The `ci` daily-delivery replay (§2.7) exercises this with the
`mtd_restatement` and `late_data` stressors.

### 4.8 Evaluation against ground truth

**Sequential runs per large profile (H1, N1).** Each is a full
`local:synthetic` run that ends with `down -v`, so only one is on disk at a
time; between runs only the evaluator's compact inputs (API pages, root
causes, matches, evidence record: ≈ 0.04 GB per run) and natural-1's
backtest export and actuals (≈ 0.28 GB) are kept (both sizes are
assumptions until PR 3-4 measures them). Peak ≈ 5.24 GB (5.28 GB with natural-3; Appendix B.5.12).

| Run | Seed | Label rates | Used for | Not used for |
|---|---|---|---|---|
| 1 | **tuning** | natural + enriched kinds (label-dense) | recall-side tuning: grouping thresholds, category precedence checks, D4–D7 behaviour on labelled events | any gate; **not** used for false-positive rates |
| 1b | **tuning-natural** | natural rates, spend-weighted placement, its own seed | **measuring every false-positive source of §4.2 at natural rates** and raising z_T and h until the measured total is ≤ 0.15/day with a Garwood 95 % upper bound ≤ 0.30/day; freezing the thresholds in a committed config. This measurement, not the §4.2 table, is the control (it alone covers D3's frozen-baseline autocorrelation and the real scale heterogeneity) | any gate |
| 2 | **natural-1** | natural rates, spend-weighted placement (§2.5) | **precision (AT-1)** and **false-positive rate (AT-4)**, pooled with natural-2; AT-5, AT-6; **forecast targets** (§3.10; the only run with the leaf backtest export) | recall |
| 3 | **natural-2** | natural rates, a different seed | pooled with natural-1 for AT-1 and AT-4; AT-5, AT-6 | recall, forecast targets |
| (3b) | **natural-3** | natural rates | only if natural-1 + natural-2 give fewer than **140** groups at ≥ `warning` (the n at which p̂ = 0.80 has a Wilson lower bound ≥ 0.72); pooled the same way | recall, forecast targets |
| 4 | **enriched** | ≥ 100 **meaningful** labels per gated kind in the evaluation window, on individual series only, intermittent series included (labels on series that are `info` only at detection time are reported in AT-7, D-24) | **recall (AT-2)**, time-to-detect (AT-3), AT-5, AT-6 | precision, false-positive rate |

**Expected n (N1, Appendix B.5.7).** Per natural seed on `fleet15k`:
≈ 158 labels of the kinds that can reach `warning` in the 61-day window,
≈ 73 true groups (≈ 1.2 per day) and, at precision 0.80, ≈ 92 groups in
total. Two pooled seeds give **≈ 183 groups** (Wilson lower bound at
p̂ = 0.80 ≈ 0.735), comfortably above n ≥ 100; natural-3 is the fallback if
the measured count is low. On `full`, with no folding and new regions, the
same derivation gives ≈ 1.6 true groups per day over ≈ 213 days, so one
natural seed suffices there.

The re-weighting scheme of the previous revision is **dropped**: precision
is only ever measured at natural rates.

**Evaluation window:** `fleet15k` days 62–122 (61 days; days 1–61 are
warm-up, though labels are also placed there so training data is
contaminated as in reality); `full` months 7–13.

**Matching (tightened, Appendix C.4).** A label L **qualifies** for a group
G when the tenant and currency agree, G's first detection day is in
[L.start, L.end + 3 days], and either

- **L explains ≥ 30 % of G's excess** (L's injected excess over G's days and
  scope, divided by G's measured excess, actual − expected), or
- **L's entity is one of G's top 3 root causes.**

Why X = 30 % and k = 3: at 30 % at most three labels can each explain a
group, which bounds the multi-label case; it tolerates the expected-value
error of a few days (≈ ± 20 % of the excess) without crediting a label that
contributes only a sliver; and top-3 is what a reader sees first in the
root-cause list, so a label below rank 3 that explains < 30 % is not what
the group is about.

- **Multi-label:** a group may qualify for several labels; it is correct if
  it qualifies for at least one `alert` label, and each qualifying label
  counts as detected by it.
- **Duplicates:** if a group qualifies only for labels already detected by
  an earlier group (by first detection day, then id), it is a
  **duplicate**: counted **false** for precision and reported against AT-6.
- A group qualifying only for `no_alert` labels, or none, is **false**.
- `folded: true` labels count for precision like any other, and their
  detection rate is reported separately (§2.5).

### 4.9 Acceptance targets and decision rules

| # | Target | Run | Decision rule |
|---|---|---|---|
| AT-1 | Precision at ≥ `warning` ≥ **0.80** | natural-1 + natural-2 pooled (+ natural-3 if needed) on `fleet15k`; natural on `full` | point estimate ≥ 0.80 **and** Wilson 95 % lower bound ≥ 0.70; requires n ≥ 100 pooled groups (expected ≈ 183), otherwise "insufficient n", reported and escalated (not a pass) |
| AT-2 | Recall on meaningful labels ≥ **0.90** for `spike`, `level_shift`, `new_service`, `runaway_resource` (and `new_region` on `full`); `dormant_reactivation` (rev. 8) is scored and reported against 0.90 (whether to gate it is the orchestrator's decision); ≥ **0.75** for `gradual_drift`, `tagging_loss`, `new_account_runaway`, `commitment_expiry`. On `fleet15k`: **measured on individual series only** (≈ 79 % of account × service series and ≈ 26 % of spend are folded and not covered; `full` covers them), and not on intermittent series whose occurrence is clustered (`info` only; ≈ 1 of 115 hurdle-scored leaves under the generator, ≈ 0.03 % of the spend of leaves that can reach `warning`, D-24) | enriched | per kind: point estimate ≥ target **and** Wilson 95 % lower bound ≥ target − 0.10, with n ≥ 100 meaningful labels per kind (at n = 100 and p = 0.90 the lower bound is ≈ 0.83; at p = 0.75, ≈ 0.66) |
| AT-3 | Median time-to-detect ≤ **1 day** after data availability for spikes, level shifts, new service/region, runaway (and reported for `dormant_reactivation`); p90 ≤ 3 days; drift: median ≤ 7 days after its cumulative excess crosses the minimum impact (**at risk**, rev. 18: optimistic median 7 for D3 alone, noise-free first-passing day 6; §4.2, B.5.13; unchanged under D-20). With D8 and the pinned multipliers, level shifts on `fleet15k` are expected at median 1, p90 1 day (§4.2): **no longer at risk on the generator**; weekly-scored intermittent series are reported separately | enriched | point estimates |
| AT-4 | False-positive groups at ≥ `warning`, **all cohorts included** (month-end, monthly-cycle and holiday cohorts are not excluded): mean ≤ **0.25 × the expected true-group rate**, i.e. **≤ 0.30 per day on `fleet15k`** and ≤ 0.40 per day on `full`; p95 day ≤ 2. Design margin: tuned to ≤ 0.15 per day (§4.2). The earlier "≤ 5 groups per day" form is retired: at ≈ 1.2 true groups per day it could never bind | natural seeds pooled | point estimates over the pooled 61-day windows; also reported for days 62–75 and 76–122 separately |
| AT-5 | **Zero** `warning`+ groups qualifying only for credit (incl. `Usage-Based`), purchase, tax (incl. `Usage-Based`), recurring-fee, correction, onboarding, commitment-effect and `constant_amortised` labels | natural and enriched | exact |
| AT-6 | One group per shared-cause event per currency (`shared_cause`, `provider_shared_cause`, `price_change`), no duplicates | natural and enriched | exact |
| AT-7 | Per-cohort breakdown of the false groups already counted in AT-1 and AT-4 (`month_end_batch`, `monthly_cycle`, `holiday`, `intermittent` weekly- and hurdle-scored, first and second occurrences of a calendar class), the **`info`-signal recall** of intermittent series that are `info` only because their occurrence is clustered (D-24), the number of hurdle-scored series in each route, labels on calendar-cohort event days (detected / missed), and folded tail labels (detected / lost); the ±10 % calendar-jitter robustness run on `tuning-natural`: reported | natural seeds | — |
| AT-8 | Daily detection run ≤ **5 min**; as-of replay of the evaluation window ≤ 60 min | `fleet15k` (this container class), `full` (4 threads) | measured (§3.11) |

**Alert-fatigue outputs (L2, restated in rev. 6 after H1 and in rev. 7),
reported every run and stated as a bound.** At natural rates, groups at
≥ `warning` per day are ≈ 1.2 true + 0.101 false (0.131 with every
conservative bound). Under a Poisson approximation: **mean ≈ 1.30 (1.33),
p95 day 3, maximum over a 61-day window ≈ 4** (Appendix B.5.10). The
hurdle-scored series' `info` signals (clustered series, or alarms the
gate caps) are ≈ 0.0002 per day under the generator, and are not
notified. The evaluator reports, for each natural seed and
pooled:
- mean, p95 and maximum day of groups at ≥ `warning`;
- the same for false groups;
- the number of `info` groups per day (mean, p95, maximum), which are not
  notified once D-17 exists.

The explicit bound is **mean ≤ 1.5, p95 day ≤ 3, maximum day ≤ 6 at
≥ `warning`** on `fleet15k`'s natural seeds. A measured value above it is
reported and escalated (D-20). Gating it would be a new target, and so an
owner decision; it is reported, not gated.

For comparison: none of the reference vendors publishes precision, recall or
alert-volume figures (Appendix A). AWS's 24-hour data latency and Azure's
36-hour run delay [A5, A10] put AT-3 in the same range as their detection
latency on a daily source.

## 5. API and UI surface

### 5.1 Endpoints (all GET unless noted; all under `/api/v1/`)

| Endpoint | Returns | Reads (definer views, §6.2) |
|---|---|---|
| `costs/daily?scope=…&groupBy=…&from=&to=&currency=&cursor=&limit=` | daily `M` (usage only, §3.1) and **billed and effective totals over every charge category** (usage, purchases, recurring fees, tax, credits, adjustments) per group; `groupBy` ∈ billingAccount, subAccount, businessUnit, provider, service, region, chargeCategory. With `groupBy=chargeCategory`, `M` is reported on the `Usage` group only, and rows with a null category form the `(unknown)` group. **Catch-all groups (rev. 13)**, using the sentinels of Appendix D.0:<br>– `service` / `region`: `(not attributed)` holds non-usage amounts (which `billing_daily` keeps per account) and usage with a null service or region;<br>– `subAccount` / `billingAccount`: `(none)` holds billing-account-level rows with a null `SubAccountId`;<br>– `businessUnit`: `untagged`;<br>– `provider`: `(unknown provider)`.<br>**Billed and effective totals for the same scope and days are equal under every `groupBy`** (tested in 4-5). **Sentinel groups are marked (rev. 14):** a group built from an `''` sentinel is returned with its key as `null`, its display label, and **`attributed: false`**. Every other group has `attributed: true` and its source value as key. A literal source value such as `untagged` or `(none)` therefore never looks like a catch-all group; totals are unaffected | `cost_daily_published`, `cost_daily_scope_published`, **`billing_daily_published`, `billing_daily_scope_published`** (rev. 12); all through `rollup_pointer` |
| `forecasts?scope=&key=&currency=` | daily expected + 80/95 % intervals (90 days), month-end, next 30/90 days (all of `M`; no billed forecast, rev. 27), method, history and cold-start flag at a leaf, and at any other scope the `bottom_up` summary (`method`, `historyDays`, `leafCount`, `coldStartShare`; rev. 25, §3.6), as-of and last published day | `forecasts_current` |
| `forecasts/accuracy?level=&horizon=` | the latest backtest report (§3.9): the rows of the **succeeded `backtest` run with the highest `run_seq`** (rev. 21, Copilot r4179039382; Appendix D.2), read in one REPEATABLE READ transaction so a page and its count come from the same run (rev. 22) | `forecast_backtests_current` |
| `anomalies?status=&severity=&category=&scope=&from=&to=&cursor=&limit=` | anomaly groups (decimal strings), keyset by `(first_day desc, id)` | `anomalies_current` |
| `anomalies/{id}` | group + daily expected / actual / interval + root causes + transitions | same |
| `freshness` | per source and period: published batch, published at, provisional flag, reconciliation; **coverage (rev. 16):** the share of usage effective cost in multi-day rows (outside `M`), per period and per leaf over the last 28 days, so the exclusion is visible on real data.<br>– **One snapshot, stated (rev. 18, Copilot r4178908362).** The publication fields are live, but coverage comes from the rollup snapshot, which can lag: after B2 is published, readers still see B1 until the rollup run that covers B2 moves the pointer (Appendix D.1). Each (source, period) therefore also returns **`coverageBatch`** (the batch the coverage was computed from: the visible batch of `rollup_batches_visible`) and **`coverageStale`** (true when it differs from the published batch). The per-leaf list carries the pointer's `batch_seq_hwm` and as-of day. **`coverageBatch` and the coverage sums come from one SQL statement** (one snapshot), so a pointer move between two reads cannot pair B1's label with B2's sums (rev. 19, the challenger's L4).<br>– **Bounded share (rev. 18, Copilot r4178908409).** `Usage` can be negative, so revision 16's `multi_day_usage_effective ÷ usage effective` could divide by zero or a negative total and leave [0, 1]. The share is now `Σ_d \|multi_d\| / Σ_d (\|M_d\| + \|multi_d\|)` over the window's days `d`, from the leaf-day (or period-day) sums of `m_usage_effective` and `multi_day_usage_effective`, so it lies in [0, 1] without new columns. With a zero denominator it is `null`, excluded by `minShare=` and sorted last. The signed sums are returned beside it as decimal strings.<br>– The per-leaf list (≈ 37 k rows on `fleet15k`) is **keyset-paginated** (`limit` ≤ 500, `cursor`) and **sorted by `(share DESC NULLS LAST, leaf_id ASC)`**, with `minShare=` to filter, so a top-N is one page (rev. 17). **The cursor carries both values** (rev. 20, Copilot r4179014779): shares tie constantly (on `fleet15k` every share is 0), so a cursor on the share alone would skip or repeat rows. The next page is `share < s OR (share = s AND leaf_id > id)` for a non-null `s`, plus every null share; after a null cursor, `share IS NULL AND leaf_id > id` | `publications_published`, `rollup_batches_visible` (rev. 18), `cost_daily_published` |
| `POST anomalies/{id}/status` | **deferred (D-15, decided)** until per-user identity exists; not built in Slices 3–5 | — |

The CostSource seam gains `ratio-native` (`fetchFindings` maps §4.6), so
`pages/api/costsource/findings.ts` and the existing UI list native and
PointFive anomalies through one type.

### 5.2 Conventions inherited from Slice 2 (unchanged)

`evaluateLiveDataAuth` before anything (401 / 429 / 503 `weak_token`);
`withGateway` (405, body cap, per-tenant 1,000 req/min, `requestId`);
tenant only from `RATIO_API_TENANT_ID`, never from the request (a `tenant`
parameter is 400); strict hand-written validation with fixed messages;
keyset cursors, no OFFSET, `limit` ≤ 500; money, quantities and counts as
decimal strings from Postgres; dates and timestamps formatted in SQL;
`Cache-Control: no-store`; reader pool pinned to REPEATABLE READ, read-only,
`search_path=pg_catalog,pg_temp`, the same timeouts and client-side
deadlines; per-request reader-login check (extended: the reader must not
reach `ratio_analytics` or `ratio_triage`, §6.1); 503 `unsafe_db_login` with
reason codes only.

### 5.3 Latency SLOs at 15,000 accounts

Server-side p95 at **15,000 accounts on `fleet15k`** in this container class (and on `full` when available), warm cache, measured by a scripted load
run in PR 5-6 (targets, not yet measurements):

| Request | p95 |
|---|---|
| `anomalies` page (limit 100), any filter | ≤ 300 ms |
| `anomalies/{id}` | ≤ 300 ms |
| `forecasts` for any precomputed scope | ≤ 300 ms |
| `forecasts` for one leaf (computed from stored state, Appendix D §D.3) | ≤ 200 ms |
| `costs/daily` over 90 days for a precomputed scope (tenant, billing account, BU, provider, service) | ≤ 500 ms |
| `costs/daily` with `groupBy=subAccount` (15,000 groups, paged) | ≤ 1 s per page |
| `costs/daily` ad-hoc filter on one account | ≤ 1 s |
| Any request | hard limit: the existing 10 s statement timeout and 20 s request deadline |

### 5.4 UI

Minimal and inside the existing information architecture: native anomalies
appear in the Findings / CostSource views through `CostFinding`; one forecast
panel (actual, expected, 80/95 % band, month-end figure) per scope;
"estimated" and "no history" flags shown, never hidden; currency always
shown. How R4's value pairing applies is D-16. No new signature component
(obvious.md, UI direction).

## 6. Security and governance

### 6.1 Roles

| Role (NOLOGIN; logins are members) | Can | Cannot |
|---|---|---|
| `ratio_owner` (existing) | owns everything; owns the reviewed retention function | — (migration only) |
| `ratio_worker` (existing) | unchanged | read or write analytics tables |
| `ratio_reader` (existing, **widened** by SELECT on the new definer views only, D-08) | read published facts and published analytics views | any base table, any write |
| **`ratio_analytics`** (new) | SELECT on `cost_facts_published` and `publications_published`; SELECT/INSERT on analytics tables (on `analytics_runs` a **column-level INSERT** without `batch_seq_hwm` and `finished_at`); column-level UPDATE on lifecycle columns, on `analytics_runs` exactly (`status`, `lease_token`, `lease_expires_at`, `heartbeat_at`, `finished_at`, `stats`, `error_code`), on each pointer of its own column list (`batch_seq_hwm` on `rollup_pointer` only; guarded by a database trigger: forwards only, succeeded runs only) and detector state; USAGE on the three identity sequences of `cost_accounts`, `forecast_leaves` and `cost_series` (no other role has it; Appendix D.5); **EXECUTE on the two retention functions only** for removal | **any DELETE**; any ingestion base table (`cost_facts`, batches, artifacts, …); any reader view write; DDL; role membership |
| `ratio_triage` | **deferred** with the write endpoint (D-15); not created in Slices 3–5 | — |

Every login is checked at start-up / per request, reusing Slice 1's
`inspectRole` + `roleProblems` and Slice 0's `REFUSED_PREDEFINED_ROLES`:
refused if it is superuser or BYPASSRLS, can reach a privileged or refused
predefined role, is a member of `ratio_owner`, or can reach another ratio
role it should not (analytics ↛ worker, reader, owner; reader ↛ worker,
analytics). The tenant is set with `withTenantTransaction`
(transaction-local, bound parameter). One analytics run = one tenant
(`--tenant <uuid>`).

**Retention of derived data (D-12, M8).** A DELETE grant **cannot be
row-scoped here**. PostgreSQL could scope it with a `FOR DELETE` RLS
policy, but Slice 0's reviewed model admits only the exact tenant-isolation
policy shape on every table (`REVIEWED_POLICY_SHAPES`; the migration linter
refuses any other permissive policy), and a restrictive policy that knows
which batches are superseded would have to read `ingest_batches` /
`period_publications`, which `ratio_analytics` cannot SELECT. A plain DELETE
grant would therefore let the job remove **any** derived row of its tenant,
including current rollups and anomalies. So:

- **`ratio.analytics_apply_retention()`** (0002, rollup tables) and
  **`ratio.analytics_apply_forecast_retention()`** (0003, forecast and
  detector state; `CREATE OR REPLACE` is not expand, so the first is never
  redefined): `SECURITY DEFINER` functions owned by `ratio_owner`, with `SET search_path = pg_catalog, pg_temp`, a
  fixed SQL body (no dynamic SQL, no arguments), marked
  **both** migration markers the linter requires for such a statement,
  `ratio:allow-function` and `ratio:allow-security-definer`
  (`migrationFiles.ts` refuses a `SECURITY DEFINER` without the latter),
  and added to `REVIEWED_SECURITY_DEFINER_FUNCTIONS`
  (its first entries). EXECUTE is revoked from PUBLIC and granted to
  `ratio_analytics` only.
- They run as the owner, who is non-superuser, non-BYPASSRLS and bound by
  FORCE RLS, so it only ever sees the **current tenant's** rows
  (`ratio.current_tenant_id()`, set by `withTenantTransaction`).
- **What it removes**, and nothing else:
  - `cost_daily`, `cost_resource_daily`, `billing_daily` rows of a
    batch that is **below the visible batch** of its (source, period),
    meaning the highest rolled-up `batch_seq` ≤ the **`rollup_pointer`'s
    high-water mark** (so nothing a reader can still see is removed);
  - run-keyed rows of **`cost_daily_scope`, `billing_daily_scope`,
    `account_dim`** other than the pointed rollup run and the one before it,
    and of `forecast_state`, `forecast_points`, `forecast_totals`,
    `forecast_scope_state` (rev. 24), `detector_state`,
    `detector_scope_state` (rev. 18; listed here in rev. 20, Copilot
    r4179014849) and `detector_cohort_state` older than
    the **2 latest succeeded runs** of their kind.
  - **backtest output** (rev. 25): `forecast_backtests` and
    `forecast_backtest_points` rows of `backtest` runs that are neither
    among the 2 latest succeeded backtest runs nor pinned in
    `analytics_run_pins`, and never a `running` run's; the backtest
    command then deletes those runs' per-origin export files, keeping
    their manifest (§3.8).
  - **Never anything still in use (rev. 27, Copilot r4179306667).**
    Both functions run under the exclusive form of a per-tenant retention
    lock that every run start takes in shared form. Neither removes:
    - rows of a `running` run of any kind;
    - the runs the pointers name;
    - a batch visible under a running run's captured mark;
    - a run named as a running run's input or previous run (Appendix D.1,
      "Run inputs").

    Forecast and detect runs may overlap, and a forecast run's retention
    pass no longer deletes a running detect run's state or the forecast
    run it reads.
- **What it never touches:** `anomalies`, `anomaly_days`,
  `anomaly_root_causes`, `anomaly_events`, `rollup_batches`,
  `analytics_runs`, `analytics_run_pins`, the current batch's rollups,
  the 2 latest and the pinned backtest runs' output, and their per-origin
  exports (M3, bounded since rev. 25). The anomaly child tables reference
  `anomalies` with `ON DELETE RESTRICT` foreign keys, so nothing can
  remove a parent and leave orphans either (rev. 22, Appendix D.4).
- They return counts per table, which the job writes to its evidence
  record.

### 6.2 Migrations and their effect on Slice 0

The first migrations after 0001, each `expand`, each with its generated
foundation manifest and catalogue check:

| Migration | Adds |
|---|---|
| **0002** | role `ratio_analytics` (DO block marked `ratio:allow-do`, same RT010-style guard as 0001); definer view `publications_published`; `analytics_runs`, `rollup_batches`, `cost_accounts`, `cost_series`, `cost_daily`, `billing_daily`, `billing_daily_scope`, `cost_resource_daily`, `cost_daily_scope`, `account_dim`, **`rollup_pointer`**; `forecast_leaves` (rev. 15); the triggers `tg_rollup_pointer_guard` and `tg_analytics_run_success`, added to `REVIEWED_TRIGGERS`; reader views joined to **the rollup pointer** (Appendix D.1); **`ratio.analytics_apply_retention()`** |
| **0003** | `forecast_pointer`, `forecast_state`, `forecast_points`, `forecast_totals`, `forecast_scope_state` (rev. 24), `analytics_run_pins` (rev. 25), `forecast_backtests`, `forecast_backtest_points` (aggregate scopes), `detector_state`, `detector_scope_state` (rev. 18), `detector_cohort_state`; the trigger `tg_forecast_pointer_guard`, added to `REVIEWED_TRIGGERS`; reader views; **`ratio.analytics_apply_forecast_retention()`** |
| **0004** | `anomalies`, `anomaly_days`, `anomaly_root_causes`, `anomaly_events` (append-only); reader views; **the trigger `tg_anomaly_merge_guard`** (rev. 23), added to `REVIEWED_TRIGGERS`. No `ratio_triage` (D-15) |

Consequences (D-07, amended wording accepted by the orchestrator):

- `privilegeModel.ts`: `RATIO_ROLES`, `CheckedRole` and
  `REVIEWED_PRIVILEGES` gain `ratio_analytics`; the reader's reviewed set
  widens by the new views; `REVIEWED_SECURITY_DEFINER_FUNCTIONS` gains its
  first entries (the two retention functions). `REVIEWED_TRIGGERS` gains
  exactly the new triggers, one migration at a time (exact old set →
  exact new set, D-07): 0001's eleven, then + `tg_rollup_pointer_guard`
  and `tg_analytics_run_success` (0002, 13), + `tg_forecast_pointer_guard`
  (0003, 14), + `tg_anomaly_merge_guard` (0004, 15; Appendix D.1).
  (Earlier revisions still said "unchanged (no new triggers)" here, which
  the triggers added since revision 13 contradicted; rev. 23.)
- `scripts/local/bootstrap.mjs` pre-creates `ratio_analytics` and a
  `ratio_local_analytics` login (the migrator stays NOCREATEROLE);
  `verifyBootstrap`'s managed set grows accordingly.
- **Slice 0 / Slice 1 test edits: an exact old set becomes an exact new
  set; never weakened.**
  - **Forced by D-08** (the reader is widened):
    - `src/ingest/db/reader.db.test.ts:28-32`: the exact list of
      `ratio_reader`'s table grants, today
      `[{cost_facts_published, SELECT}]`, becomes the exact new list
      (`cost_facts_published` plus each new reader view, `SELECT` only).
      The INSERT/UPDATE/DELETE/TRUNCATE assertions that follow stay as they
      are and are extended to every new view.
    - `src/ingest/db/privileges.db.test.ts:97`: the exact set of the
      reader's `relation:` privileges, today
      `['relation:ratio.cost_facts_published:SELECT']`, becomes the exact
      new set.
  - **Migration-version assertions** (candidates found by grep at 827773f;
    PR 4-1 classifies each, since some run against temporary migration
    directories and need no change): `migrate.db.test.ts:196, 224, 264,
    266, 281, 284, 302`; `privileges.db.test.ts:79, 88`;
    `foundation.db.test.ts:63`. Where one changes, `['0001']` becomes the
    exact new list, never a weaker matcher (no `arrayContaining`, no length
    check in place of a list).
  - Each edit is listed in PR 4-1 with before/after and gets challenger
    scrutiny. Any other Slice 0/1 test that would need to change stops the
    PR for escalation (T3).
- Every new table follows the Slice 0 invariants, which the existing
  catalogue tests enforce generically: `tenant_id uuid NOT NULL`, composite
  tenant FKs, RLS enabled **and** forced with the exact tenant policy shape,
  `numeric` money (no float), `timestamptz`, `jsonb` objects checked for
  secret-like keys and values.

### 6.3 Threat model (new surface)

| Threat | Control | Test |
|---|---|---|
| Analytics reads staged, quarantined or superseded data | only the published view and the published-batch view are granted; rollups key on the published batch | DB: tenants seeded with every batch state; rollup totals = published totals exactly |
| Analytics job writes facts or publishes | no grant on ingestion tables; startup login check | DB: an INSERT into `ratio.cost_facts` as the analytics login ⇒ 42501; mutation: add the grant ⇒ the catalogue check fails |
| Analytics job removes rows it should not | no DELETE grant at all; removal only through the two reviewed `SECURITY DEFINER` functions with fixed criteria | DB: a `DELETE FROM ratio.cost_daily` as the analytics login ⇒ 42501; the functions never remove a rollup row of a batch at or above the visible batch of its (source, period) (the highest rolled-up `batch_seq` ≤ the pointer's mark), an anomaly or anomaly child row, the output of the 2 latest succeeded backtest runs or of a pinned or running one (rev. 26, Copilot r4179273964: revision 25 still said "never a backtest row" and named the revision-12 "not published" criterion); mutations: remove a batch at or above the visible batch (retention above the mark), keep 1 run instead of 2, remove a pinned or the latest backtest run's output ⇒ tests fail (4-2, 4-3) |
| The retention function crosses tenants or is hijacked | owner bound by FORCE RLS; pinned `search_path`; no arguments; EXECUTE for `ratio_analytics` only | DB: two tenants, the function run under A leaves B untouched; catalogue check: function on the reviewed list, PUBLIC has no EXECUTE |
| Synthetic-provider opt-in leaks into a real path | `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` only in `local:synthetic`'s worker environment, spawned with `RATIO_ENV=development`. The worker (#62, as shipped in #67 and #68) accepts `=1` **only when `RATIO_ENV` is explicitly `development` or `test`** and refuses it under unset, unknown, `staging` and `production` (`SYNTHETIC_PROVIDERS_NOT_ALLOWED`). An in-process `runSync` with `allowSyntheticProviders: true` throws the same error without the process env opt-in | static test over `scripts/local/**`, compose files and `.github/workflows/**`: only `local:synthetic` sets `=1`, and only together with `RATIO_ENV=development` or `test`; #62's refusal tests (staging, production, unset `RATIO_ENV`; explicit library request without the opt-in) |
| Tenant A's forecasts or anomalies visible to tenant B | FORCE RLS on every new table, definer views with the tenant predicate, API binding unchanged | DB matrix per new table and view; the 15-account control tenant next to `fleet15k` at scale |
| Derived data outlives a restatement | batch-keyed rollups; reader views show the highest rolled-up batch ≤ the `rollup_pointer` mark (a snapshot, rev. 13), so the switch to the restated batch happens **when the run that rolls it up commits and moves the pointer**, never earlier and never as a gap; `restated` resolution | DB: republish ⇒ unchanged views until the next rollup's pointer commit, then API totals and anomalies follow the new batch |
| A float leaks into money | numeric columns (catalogue scan), SQL-side impact, import boundary for model code | catalogue test; unit: model module not importable from rollup/API code |
| Ground truth leaks into the detector (overstated accuracy) | labels outside the DB and outside the source bucket; the job has no file input for them; evaluation seeds unused until tuned parameters are committed | static test: the analytics CLI has no labels path; evaluator-only module |
| Synthetic data mistaken for billing data | `Synthetic*` provider names, `SYN-` ids, tenant slug and display names, dataset manifest marker (D-04) | generator unit tests; local run asserts display names |
| Resource exhaustion through new endpoints | precomputed scopes, keyset, `limit` ≤ 500, existing timeouts and rate limit | route tests at limits; load run (§5.3) |
| Status write abuse | no write surface in Slices 3–5 (D-15 deferred) | static test: no non-GET handler under the anomaly routes |
| Analytics job login drifts to a privileged role | per-start login check (Slice 1 logic) + catalogue check after migrations | serial DB suite per edge kind, as for the reader |

### 6.4 Restricted classes touched (governance gate)

| Paths or content | Class | PRs |
|---|---|---|
| `src/ingest/db/migrations/**`, `*.sql`, `privilegeModel.ts`, foundation manifests | `migrations`, `financial_semantics` | 4-1, 4-3, 5-1 |
| `src/ingest/fixtures/**` (generator), `src/lib/forecast*` (F1) | `financial_semantics` | 3-1a, 3-1b, 3-2, 4-0 |
| `src/analytics/**`, `src/server/analytics/**` | unclassified ⇒ restricted (fail closed) | 4-2 … 5-6 |
| `src/costsource/**` (`ratio-native`, `CostFinding` fields) | `financial_semantics` | 5-5 |
| `pages/api/v1/**` | `routes` | 4-5, 5-5 |
| `scripts/local/**`, `docker-compose*`, `.github/workflows/**` | `deployment` | 3-3, 3-4 |
| file names containing `role`, `tenant`, `auth` under `src/` | `auth_tenancy` | 4-1 |
| `package.json` (scripts only; **no new dependency**) | `dependencies` | 3-2, 4-2 |
| retention functions and their tests (removal of derived rows) | `retention` | 4-1, 4-2, 4-3 |
| this design (it discusses retention and names secret-bearing settings) | `retention` (added-line rule) | 3-0 |

Every PR in this plan, including this design PR, is expected to classify
**restricted** and goes through the exception path.

### 6.5 Data stays synthetic; BOUNDARY v2

- No real billing data, no real account ids, no cloud credentials; the
  local S3 accepts any key pair and is loopback-only, as in Slice 2.
- No production infrastructure, no hosting spend; nothing here changes the
  owner actions of brief §7.
- Generator output and the fleet stack are ephemeral (`down -v`). The
  public FOCUS sample of Slice 2b is not reused for the fleet: it is real
  (anonymised) data under CC BY 4.0, while the fleet must be wholly
  synthetic.

## 7. Slicing plan

Each PR is small, opens with a **red** commit (tests that fail for the right
reason, evidence under `docs/evidence/slice-N/red/`), then the
implementation, then evidence. Gates for every PR: CI green (lint,
typecheck, `npm test`, build, `check:bundle`, `local:test`,
`local:acceptance`, and from 3-3 on `local:synthetic --profile ci`),
`test:db` (×3, no skips), the governance gate's class and the exception path
for restricted PRs, the challenger review, and the Copilot review resolved.
Mutation targets are code changes that must make at least one test fail;
each PR records them in its evidence.

**Order (decided):** PR **4-0 comes first**, as an independent bug fix.
**Slice 3 starts only after #62 merges** (its `SYNTHETIC_PROVIDERS` set
and `RATIO_ALLOW_SYNTHETIC_PROVIDERS` opt-in are what the generator's
output relies on; D-21). PR ids keep their slice numbers. **Status at
revision 10:** 4-0 landed as #65; #62 landed through #67 and #68 (§0).

| Order | PR | Scope | Tests-first acceptance criteria | Mutation targets |
|---|---|---|---|---|
| 0 | **3-0** | This design and its decision log | review only | — |
| 1 | **4-0** | **Bug fix, independent:** F1 (`daysInMonthOf`, `remainingWeekdaysInMonth`, and `budgetStatus.ts` through them, under a non-UTC process time zone) | red tests under `TZ=Asia/Tokyo` and `TZ=America/Los_Angeles` (February 2026 = 28 days; a leap February = 29; weekday counts at month ends); existing forecast and budget tests unchanged and green | local-time `Date` constructor restored; off-by-one in the weekday loop |
| — | *#62* | worker provider check with `SYNTHETIC_PROVIDERS` and the opt-in (its own PR) | as in #62 | as in #62 |
| 2 | **3-1a** | Generator core (pure): fleet model, `SYN-` ids, `Synthetic*` provider names, series model, PRNG, BigInt money, FOCUS row rules, commitments (incl. `Unused` and expiry), the three profiles' grain and columns, `fleet15k` folding | deterministic digests; adding an account leaves others' draws unchanged; heavy tail (top-1 % share within ±3 pp); **every row passes the worker's own validator** (`src/ingest/focus/validate.ts`); one currency per billing account; `BillingPeriodStart` = period; FOCUS rules (Purchase ⇒ not Usage-Based; Committed ⇔ commitment id; Tax ⇒ no pricing category); only `SYNTHETIC_PROVIDERS` names; ids match `^SYN-(A|BA)-[0-9A-HJKMNP-TV-Z]+$` and never a 12-digit number; `fleet15k`: exactly 15,000 accounts, ≤ 3 usage series per account, minimal columns only, `Other services` = the exact sum of the folded services | PRNG stream shared across entities; credit sign flipped; mixed currency in a billing account; float in the money path; a non-synthetic provider name; a numeric id; an account dropped; folding loses a cent |
| 3 | **3-1b** | Ground truth, stressors and seeds: every label kind of Appendix C, tuning / tuning-natural / natural-1..3 / enriched seeds, spend-weighted placement, folded-label marking, `usage_based_credit`/`_tax` rows, `series-params.jsonl` | each label's effect present in the rows and absent outside its **effect** window (Appendix C.2's Effect window column, rev. 16); level-shift multipliers log-uniform on [1.2, 3.0] (KS test on 10,000 draws); calendar factors constant per series and class across months and days, and the `--calendar-jitter 0.10` option (robustness run only) varying them by month within ±10 %; natural seed rates within ±10 % of Appendix C; enriched seed ≥ 100 meaningful labels per gated kind in the evaluation window, all on individual series, plus ≥ 100 meaningful `dormant_reactivation` labels (non-intermittent series active every day up to a last active day ≥ 16, then zero for a gap of any length ≥ 56 days, restarting on a day in 73–115; none on natural seeds); `folded: true` exactly for labels on folded services; stressor cohorts present; seeds produce disjoint label sets | label written without its effect; enriched labels placed on folded services; tuning and natural seeds identical; `Usage-Based` credit emitted as `Usage`; a `dormant_reactivation` label with a dormant gap shorter than 56 days; calendar factor redrawn each month without the jitter option; **effect window equal to the scoring window for a permanent kind** (e.g. `level_shift`, so the counterfactual test misses the days after `start + 13`) |
| 4 | **3-2** | Writer: AWS Data Exports layout, gzip, manifests with `x-ratio-control`, file splits, `dataset.json`, labels; `npm run synthetic:generate` | output accepted by `src/ingest/sources/s3/layout.ts`; bounded memory on a 1 M-row run; byte-identical re-run; pinned `ci` golden digest; control totals = BigInt sums = Python recomputation | manifest lists a file twice; control total off by 1e-10; split drops the last row; gzip mtime not zeroed |
| 5 | **3-3** | `local:synthetic` (own project and ports; upload + SHA-256 verification; local copy removed by default; 36 + 1 sources; parallel sync with the opt-in in the worker environment only; asserts; evaluator export; `down -v`) + CI step for `ci` | every period `published` and `reconciled`; totals = `dataset.json`; re-sync all `skipped_unchanged`; no fake source, no hook (static test like 2b's A9); **static test: `RATIO_ALLOW_SYNTHETIC_PROVIDERS` set only by `local:synthetic`'s worker spawn, and there only together with `RATIO_ENV=development` (or `test`), never by `local:test`, `local:acceptance`, other `local:*` commands, compose files or non-synthetic CI steps**; cross-check that the worker refuses `=1` under `staging`, `production` and an unset `RATIO_ENV`; cleanup always | opt-in set globally (in the parent environment or compose); skip one source; assert only row counts; keep the local copy; run with the fake source |
| 6 | **3-4** | **`fleet15k` runs in this container class** (tuning, tuning-natural, natural-1, natural-2 [, natural-3], enriched; sequential; **measures the retained evaluator-input sizes**, assumed 0.04 GB per run and 0.03 GB of actuals in `budget2.py`/`budget3.py`; peak disk measured against 5.24 GB) + evidence: load time (D-06 trigger), bytes per row, the int batch key's real size, total disk per run vs 5.5 GB / 6 GB, peak WAL with and without `max_wal_size=256MB`, SeaweedFS fit (T1) | §2.10 targets measured and recorded; a miss is reported and escalated (D-20) | — (measurement PR) |
| 7 | **4-1** | Migration 0002 (incl. the retention function) + privilege model + bootstrap + the D-07 test edits | catalogue check passes with the new reviewed sets; analytics login refused for each unsafe shape (serial suite); reader cannot see base analytics tables; tenant matrix on each new table; retention function on the reviewed list, PUBLIC without EXECUTE, analytics without DELETE; foundation manifest regenerated and drift-tested; **every edited Slice 0/1 assertion listed, exact old set → exact new set**; `cost_series` and `cost_accounts` unique on the full natural key (two providers, or two billing accounts, reusing one sub-account id get two rows); `rollup_pointer` only references a succeeded rollup run; **the pointer guard triggers** refuse a backwards move, a non-succeeded run and a wrong-kind run, **and a `run_seq`, `as_of` or `batch_seq_hwm` that differs from the referenced run's own**, even for a direct `UPDATE` by the analytics login; the run-success trigger records the mark and refuses rewriting it; `rollup_pointer`'s UPDATE grant is exactly (`run_id`, `run_seq`, `batch_seq_hwm`, `as_of`, `updated_at`) (catalogue); `REVIEWED_TRIGGERS` extended by exactly the two 0002 triggers (old set → new set); **run-row tests (rev. 16, separated in rev. 17; Appendix D.1):** – **grant:** as the analytics login, an `INSERT` supplying `batch_seq_hwm` fails 42501, and `has_column_privilege(…, 'batch_seq_hwm', 'INSERT')` is false; – **trigger:** as a fixture role holding that privilege, a supplied mark, a pre-`succeeded` run and an out-of-order `run_seq` each fail with the trigger's code; – **re-succeed:** refused; – **concurrency:** two concurrent same-kind INSERTs without the advisory lock make the second fail 23505, and a catalogue check confirms the unique constraint exists; **Leaf-derivation tests (rev. 17):** – a `cost_series` row with `leaf_id` of svcA's leaf and `service_name` svcB is refused by the single composite FK; – a root cause whose series belongs to another leaf is refused; – a root cause with `leaf_id` NULL and any `series_id` is refused by the CHECK; **accounts (rev. 18):** a `forecast_leaves` or `cost_series` row whose `account_id` is account A while its components name account B is refused by the composite account FK, and so is a root cause with a nonexistent `leaf_id` (series NULL) or with the `leaf_id` of another account's leaf; `cost_series` rows of one account × service in two regions share one `leaf_id`; USAGE on the identity sequences only for `ratio_analytics` (reader, worker and PUBLIC without it); natural keys `NOT NULL` and `UNIQUE NULLS NOT DISTINCT` | grant analytics SELECT on `cost_facts`; drop `provider_name` or `billing_account_id` from a natural key; drop the pointer guard trigger; grant sequence USAGE to `ratio_reader`; let the pointer trigger accept a supplied `run_seq` or mark without comparing it to the run row; omit a trigger from `REVIEWED_TRIGGERS`; run the run-success trigger on UPDATE only (a pre-`succeeded` INSERT then passes); grant INSERT on `analytics_runs.batch_seq_hwm`; allow a status change out of `succeeded`; drop `UNIQUE (tenant_id, kind, run_seq)` (the concurrent test catches it); replace the single derivation FK by revision 16's two separate FKs (id, natural key); a plain `account_id` FK on `forecast_leaves` or `cost_series`; drop the root cause's (leaf, account) FK; make the root cause's `account_id` nullable; drop the root-cause series/leaf FK; drop the `series_id IS NULL OR leaf_id IS NOT NULL` CHECK; make a natural-key column nullable; grant analytics DELETE on `cost_daily`; remove FORCE RLS from one new table; widen reader to a base table; float column; retention function without pinned `search_path` |
| 8 | **4-2** | `ratio-analytics rollup` (incremental by published batch, `batch_seq`); narrow `cost_daily` + sparse `billing_daily` by charge category + `billing_daily_scope`; `rollup_pointer` moved in the run's success transaction; retention call after each rollup | rollup totals per (source, period, currency) = published totals **exactly**, billed and effective, **over every charge category** (`cost_daily` + `billing_daily`, and `billing_daily_scope` at each scope); **pointer atomicity**: a rollup killed mid-run, or failed, leaves every reader view byte-identical to before; a restatement becomes visible only when its run's pointer update commits, and **while it is published but not yet rolled up, every view still returns the previous batch** (no gap); the reader views never return rows above `batch_seq_hwm`; **concurrency** (rev. 13): two rollups started together → the second is refused `ALREADY_RUNNING`; a run whose lease expires mid-run is fenced (`LEASE_LOST`) and a later run proceeds; a publish landing mid-run is picked up by the next run, not half by this one; a late commit of an older run cannot move the pointer backwards (`POINTER_STALE`); **a batch completed by a run that then fails is visible after the next successful run, even when that run rolls up nothing new** (rev. 14); **the first run on an empty tenant succeeds with mark 0 and every view empty, and a later run with a batch moves the pointer** (rev. 15); **captured marks (rev. 27):** a forecast run that captured mark 10, while B2 (batch 11) restates B1 (batch 9) and a later rollup run moves the pointer and runs retention, still reads B1 until it ends, and B1 is removed only after it; **null columns** (rev. 13): rows with a null `ChargeCategory`, a null `ChargeFrequency` and a null `SubAccountId` each land in exactly one table, under the `''` sentinels, and the rollup totals still equal the published totals exactly; **unnamed resources (rev. 19):** a $5,000/day `Usage` row with a null `ResourceId` and one with `''` roll up without error, add no `cost_resource_daily` row, and stay in `cost_daily` and the totals, while a named $30/day row is kept; **per-currency floor (rev. 20):** in each of USD, EUR, GBP and JPY a named row at 0.24 × that currency's minimum impact is left out and one at 0.26 × is kept (JPY: ¥3,600 out, ¥3,900 in), and the floors appear in the run's `stats`; **multi-day usage** (rev. 15): a 3-day `Usage` row lands in its start day's billed and effective totals and in `multi_day_usage_effective`, not in `M`, and the `freshness` coverage share reflects it (rev. 16); **zero-valued rows** (rev. 15): a non-usage row with billed and effective both 0 still creates its `billing_daily` group and its `row_count`; **stable ids under nulls** (Copilot r4178706470): two batches, and a restatement, each with rows missing `ServiceName`, `SubAccountId` or `BillingAccountId`, resolve to the **same** `series_id` / `account_id` (no new id is allocated); `M` excludes `Usage-Based` credit and tax rows; restatement switches the read side; idempotent re-run; tag parsing failure counted, never crashes (`pg_input_is_valid` on PG16 [A21]); EXPLAIN shows the PK-prefix path through the security-barrier view **(to verify)**; retention removes exactly the superseded batch's rows and old runs, nothing else, and never a row the pointer still exposes | group by the wrong day; move the pointer before the run's rows commit; drop the monotone guard from the pointer update; take the high-water mark from the run's own batches instead of the tenant's `max(batch_seq)`; remove the `coalesce(…, 0)` from the mark or from `batch_seq` allocation; make `batch_seq_hwm` nullable; filter batch-keyed views on live publication status; route with `<> 'Usage'` (drops null categories); store a nullable key component as NULL; **remove the `coalesce(nullif(…, ''), '')` normalization at id allocation** (a second batch with a missing service then mints a new `series_id`); omit `Credit` or `Tax` from `billing_daily_scope`; retention removes a batch above the pointer's high-water mark; include a superseded batch; drop `ChargeCategory = 'Usage'` from `M`; skip the untagged measure; retention removes a current batch's row; **rollup retention ignoring running runs' captured marks** (B1 removed mid-forecast); **drop the named-resource filter** (the null-`ResourceId` row then fails the insert, 23502); **one literal floor of 25 for every currency** (a ¥100 row is then kept); **store an unnamed row as a `''` resource, with the `resource_id <> ''` CHECK dropped** (the 5-2a `runaway_resource` test then fires on the remainder; with the CHECK the insert fails 23514) |
| 9 | **4-3** | Migration 0003 (forecast tables, backtest points, detector state, detector cohort state, pointer, views) | as 4-1, for the new objects; `forecast_state` and `detector_state` keyed by `leaf_id` with a composite FK to `forecast_leaves`; a regional account × service has one `leaf_id` and several `series_id`; `REVIEWED_TRIGGERS` gains exactly the forecast pointer guard; **forecast retention (rev. 20):** after three succeeded forecast and detect runs, `ratio.analytics_apply_forecast_retention()` leaves exactly the 2 latest runs' rows in each of `forecast_state`, `forecast_points`, `forecast_totals`, `forecast_scope_state` (rev. 24), `detector_state`, `detector_scope_state` and `detector_cohort_state`, touches no other table, and returns a count for each of the seven; **pin at success (rev. 26):** a backtest run with `--pin acceptance:4-6` is pinned in its success transaction, and after two newer backtests and a retention pass its output and exports are still there; **retention vs running runs (rev. 27):** while detect run D (input forecast run F1) is `running`, two forecast runs F2 and F3 succeed and each runs forecast retention: D's `detector_*` rows, F1's rows and D's `prev_run_id`'s rows are all still there, and D then succeeds; a detect start blocks while a retention pass holds the lock, and vice versa; **backtest retention (rev. 25):** with backtest runs 1 (pinned), 2, 3 and 4 succeeded, 5 failed and 6 running, it keeps the output of 1, 3, 4 and 6 and removes that of 2 and 5, and the backtest command then deletes 2's and 5's export files while their manifests stay in `stats`; **`forecast_scope_state` arrays (rev. 25):** its four quantile arrays and `q_source` refuse 5 elements, a 2-D array, `'{}'`, lower bound 0, a NULL element and (for `q_source`) an unknown source; **`forecast_pointer`'s UPDATE grant is exactly (`run_id`, `run_seq`, `as_of`, `updated_at`)** (catalogue; rev. 17); **fixed-length arrays (rev. 17, Appendix D.2):** for each array column, 6 or 8 elements, a 7-element two-dimensional array, `'{}'`, lower bound 0 and a NULL element are each refused with 23514, and a NULL column is accepted; `forecast_totals` holds month-end, next-30 and next-90 rows for every leaf; **rev. 18:** a `q_source` element outside {own, cohort, extrapolated} is refused (23514); `detector_scope_state` keyed by (scope kind, scope key, currency), with a `baseline` of exactly 28 values | as 4-1; key a leaf table by (sub-account, service, currency); key forecast state by `series_id`; one shared UPDATE list for both pointers (the migration then fails on `batch_seq_hwm`); drop one array CHECK; write leaf totals for month-end only; **leave `detector_scope_state` out of the forecast retention function** (its old runs then remain); **write the `--pin` row after the success transaction** (a retention pass in between then removes the run); **retention without the running-run exclusion** (D's state disappears mid-run); **retention without the lock** (a start between its read and its delete loses F1); **remove a pinned backtest run's output; remove the latest succeeded backtest run's; remove a running run's; never remove backtest output** (unbounded); **drop one of `forecast_scope_state`'s array CHECKs**; a scalar quantile source per `forecast_state` row; aggregate D3 state kept in memory only |
| 10 | **4-4a** | Model library (pure): M0, M1, M1-log, **calendar-event component** (3 classes, significance-gated factors), Hampel with the scale floor, 288-point grid search, cold-start ladder, the `fleet15k` fixed rule | known-answer tests on hand-computed series; independent Python reference for small cases; constant series: no cleaning, finite outputs; intermittent series: no NaN; calendar: factors estimated on raw `y` by the median of m ≥ 3 values; a × 1.3 month-end factor is applied after 2 cycles at σ ≤ 0.13 and after 3 at σ ≤ 0.17, never with m < 3, never on a series without the effect at \|t\| < 3; one anomalous day in 3 cycles moves the factor by less than half its effect; Hampel applies the learned factors before its 4-MAD test (a × 1.3 month-end on a σ = 0.05 series is not cleaned); **calendar samples (rev. 23):** an intermittent series whose event days include zeros (y = 0, and a weekly baseline of 0) and a series with a negative event day count only their valid pairs; with 2 valid samples of a × 1.3 effect the factor is 0, with 3 it is estimated, and no NaN or infinity appears; **M1-log fallback (rev. 22; rev. 23):** a series with a negative day in its last 28 is not M1-log eligible, and neither is one whose only negative day (−5) lies 40 days before the origin, outside the trailing 28 but inside the fit history; an M1-log leaf that receives −5 (and, separately, 0) after selection switches to M0 at that update with `log_fallback`, to M1 at the next weekly refit, and no state or output is ever NaN; a D3 anchor taken while it was M1-log still reconstructs (D.3's `exp(…) − 1` needs no log of an observation); the business-day rule handles months ending on a weekend; refit throughput measured (§3.11) | seasonal index off by one weekday; trend undamped; scale floor removed; grid point skipped; factor estimated on cleaned data; mean instead of median; Hampel before the factors; **calendar estimate over all samples** (a 0 / 0 sample then gives NaN); **`m` counted before dropping invalid samples** (a factor then applied from 2 valid values); **M1-log eligibility on zeros only** (a series with a negative day is then selected); **M1-log eligibility on the trailing 28 days only** (the −5 forty days back then reaches `log1p`); **`log1p` applied to a value ≤ 0 after selection** (NaN), or the value clamped instead of the fallback |
| 11 | **4-4b** | Intervals with **expanding as-of calibration**, cohort fallback, bottom-up hierarchy, backtest blocks, per-origin exports, forecast and backtest commands | invariants: bottom-up coherence, intervals ordered, lower ≥ 0 when the point is ≥ 0; **ordered bounds as a property (rev. 19, Appendix D.3):** over 10,000 random `forecast_state` rows, negative trailing means, negative points and biased quantiles included, `lo95 ≤ lo80 ≤ point ≤ hi80 ≤ hi95` always holds; **and over 10,000 random `forecast_totals` rows (rev. 20)**, every level and window, negative totals included (a negative next-30 total keeps its raw lower bounds); **clamping reported (rev. 20):** the share of clamped buckets and total windows is in the backtest report next to FT-7; **`n` = 0 and remaining-days buckets (rev. 21):** a month-end origin on the month's last published day, whose last day is later restated with a non-zero error, contributes no calibration error and no division, and gets a zero-width interval at its actuals; month-end errors with 3 and 20 remaining days land in buckets 2–7 and 15–31 and are calibrated separately; a leaf whose 28-day mean `M` is negative (credits booked as usage) gets a positive `scale_level`; a negative point keeps its raw lower bounds; **per-bucket quantile source (rev. 18, Appendix D.3):** a leaf whose buckets 1–3 are `own`, 4 is `cohort` and 5–6 are `extrapolated` returns those sources day by day, and FT-7 skips exactly the days in buckets 5–6; **D3 anchor state (rev. 18, rev. 19):** the anchor columns written on day a equal the leaf's daily-updated model state as of a, in D.3's layout, whether or not a forecast run happened on a, and `ŷ(t \| a)` from them equals D.3's formula on that state; **no leakage** (an origin cannot see later data: poisoned-future test); **as-of calibration** (test: poisoning the errors of days ≥ t leaves every interval issued at t unchanged); exports complete (228 points per leaf on `fleet15k`: 5 calibration origins × 30 points + scoring origins 93/100/107/114 with 30 + 23 + 16 + 9) with SHA-256 manifest; an empty horizon bucket uses the √h-scaled quantiles of the longest populated bucket, flagged `extrapolated` and excluded from FT-7; FT-4/5/7 on **natural-1** (the tuning seeds never feed an acceptance figure); **one writer per tenant and kind (rev. 17):** two concurrent `forecast` starts, and two concurrent `backtest` starts, give one run and one `ALREADY_RUNNING`, never a duplicate or skipped `run_seq`; a `forecast` and a `detect` start together both proceed (separate counters); **backtest publication (rev. 21):** while a backtest run is `running`, and after one `failed`, `forecast_backtests_current` returns the previous succeeded run's rows; when the new run's success commits, a reader **in one statement, or in one REPEATABLE READ transaction**, sees either all old rows or all new rows, never a mix (rev. 22: under READ COMMITTED each statement takes its own snapshot, so a page read followed by a count straddling the commit mixes runs; the test shows that for a two-statement READ COMMITTED reader, and the API reads page and count in one REPEATABLE READ transaction); a fenced run (`LEASE_LOST`) cannot add rows; **backtest report key (rev. 21):** the same level, bucket and metric in the calibration and the scoring block, in two currencies and for two segments, are stored as separate rows; **account scope on read (rev. 24, Appendix D.3):** an account's daily points equal the sum of its leaves' reconstructed points, its bounds equal D.3 step 4 on its own `forecast_scope_state` row, and its month-end, next-30 and next-90 totals are read from `forecast_totals`; **leaf reconstruction (rev. 17, Appendix D.3):** the job and the API give identical output for one `forecast_state` row, and a `forecast` run at a backtest origin's day reconstructs exactly that origin's exported leaf points (point and four bounds, every exported h), on calendar-event days and on `m0`, `m1` and `m1_log` leaves; leaf next-30 and next-90 totals come from total-error quantiles | interval quantiles from in-sample residuals; **omit the calendar factor on read; use `level × q` as a bound; **an account's bounds summed from its leaves' bounds**; scale by `level` instead of `scale_level`; **`scale_level` as the signed mean of `M`; floor the lower bounds at 0 for a negative point; store unclamped quantiles** (the property test then fails); **floor a negative total's lower bounds at 0** (lo80 > total); **include `n` = 0 origins in the totals calibration** (division by 0); **pool month-end errors across all remaining-day counts**; one scalar quantile source per row; anchor copied from the last `forecast_state` row instead of the daily state; leaf next-30/90 interval from summed daily bounds**; calibration from the scoring block; `env` in the cohort key; selection enabled on `fleet15k`; an export missing a horizon; an `extrapolated` interval scored; **drop the per-kind advisory lock** (two concurrent forecast starts then collide on `run_seq`); `forecast_backtests_current` choosing the latest backtest run whatever its status, or by `run_id`; the accuracy route reading page and count in two READ COMMITTED statements; `block` (or currency, segment) dropped from the `forecast_backtests` key |
| 12 | **4-5** | API: `costs/daily`, `forecasts`, `forecasts/accuracy`, `freshness` | Slice 2 route test set (auth, 400s, keyset, tenant, unsafe login, no-store, decimal strings); `costs/daily` billed and effective totals equal the published billed and effective totals for the same days and scope, credits, tax, purchases and fees included; `groupBy=chargeCategory` returns every category present (including `(unknown)`) and `M` only on `Usage`; the same scope and days give equal billed and effective totals under every `groupBy`, catch-all groups included; sentinel groups come back with `key: null`, `attributed: false` and their label, while a source value that literally reads `untagged` or `(none)` comes back as its own group with `attributed: true`; a leaf request to `forecasts` returns month-end, next-30 and next-90 totals with intervals, read from `forecast_totals`; **no billed forecast (rev. 27):** no `forecasts` response, at any scope or window, carries a billed value (revisions 19–26 tested `billedMonthEnd` at account scope and above); **valid shares (rev. 26):** `coldStartShare` is `null` for a scope whose leaves' expected values are all 0, and stays in [0, 1] when one leaf's expected value is negative; `historyDays` of a business unit is counted from its earliest leaf's first usage day, ignoring a tax row on an earlier day; **non-leaf summary (rev. 25):** an account with one fitted leaf and one `estimated` leaf returns `method: bottom_up`, the account's own `historyDays`, `leafCount: 2` and `coldStartShare` equal to the estimated leaf's share of the window's expected `M`, and a leaf returns its own method, history and flag; latency check on `fleet15k`, **including the paginated per-leaf coverage of `freshness` (≈ 37 k leaves; first page and a deep cursor page, ≤ 1 s each)**; **`freshness` snapshot (rev. 18):** with B2 published and B1 still the visible rollup batch, the response gives published batch B2, `coverageBatch` B1, `coverageStale: true` and B1's coverage values; after the rollup run covering B2 moves the pointer, B2 and `false`; **bounded share (rev. 18, wording fixed in rev. 19):** a leaf whose `M` and multi-day sums are 0 on every day of the window gets `null` and is excluded by `minShare=0`; a leaf whose usage **nets** to 0 over the window (`M` +10 and −10, multi-day +5 and −5, on the same two days) gets the defined share 10 / 30 = 0.33; one whose usage nets negative and one with mixed-sign days get shares in [0, 1], and the sort order stays total; **full traversal (rev. 20):** over 37 k leaves with every share 0, then a mix of tied shares and 5,000 null shares, paging with `limit` 500 visits every leaf exactly once (no duplicate, no gap, count equal to the total), in `(share DESC NULLS LAST, leaf_id)` order; **one snapshot (rev. 19):** `coverageBatch` and the coverage sums are read in one statement; a test moves the pointer between the batch lookup and the coverage query of a two-statement mutant and gets a batch and sums that disagree, while the real query returns a consistent pair | read tenant from the query; OFFSET pagination; number instead of string; billed totals from `cost_daily` alone; `freshness` per-leaf coverage returned unpaginated; **cursor on the share alone, without the `leaf_id` tie-breaker**; nulls ordered first or dropped by the cursor; coverage labelled with the published batch; share as `multi ÷ usage` (signed); `coverageBatch` and the coverage sums read in two separate statements under READ COMMITTED; `coldStartShare` from signed expected values; `historyDays` from `cost_accounts.first_day`; **any billed forecast field returned** |
| 13 | **4-6** | Forecast acceptance on `fleet15k` (natural-1) + Python evaluator (own actuals from the bucket) | FT-1…FT-7, FT-9, FT-10 recorded with n; FT-7 reported with the share of clamped buckets and total windows beside it (rev. 20; the target unchanged); `Other services` reported separately; evaluator and job agree; FT-8 marked "`full` only, pending OA-1" | evaluator reading the job's rollups instead of the bucket; `Other services` included in the FT-4 gate |
| 14 | **5-1** | Migration 0004 (anomaly tables, events, views; no `ratio_triage`) | as 4-1; **parent integrity (rev. 22, Appendix D.4):** a `merged_into` naming a nonexistent anomaly or another tenant's is refused (23503); a merged row without a target, a target on a row that is not `merged`, a merged row still `open`, and a self-merge are refused (23514); an `anomaly_days`, `anomaly_root_causes` or `anomaly_events` row for a nonexistent anomaly is refused (23503); deleting an anomaly that has children is refused (`ON DELETE RESTRICT`), and neither retention function names an anomaly table; **event targets (rev. 25):** a `merged` or `repointed` event naming a nonexistent anomaly as its old or new target is refused (23503); **merge cycles (rev. 23):** A → B then B → A is refused, A → B, B → C, then C → A is refused (a merged target, or a target with groups pointing at it), and two concurrent sessions merging A → B and B → A cannot both commit (one is refused or aborts on the lock); merging a group that still has groups pointing at it is refused; `REVIEWED_TRIGGERS` gains exactly `tg_anomaly_merge_guard` (14 → 15) | as 4-1; drop the `merged_into` FK; drop the merge CHECK; drop a child FK; `ON DELETE CASCADE` on a child FK; **drop the merge guard trigger** (the cycles then commit); drop an event-target FK; **guard without the row lock** (the concurrent cross-merge then commits twice); omit the trigger from `REVIEWED_TRIGGERS` |
| 15 | **5-2a** | Detectors D1–D8 (pure) on the **log scale**, calendar-adjusted: 56-day D2 window with the pooled floor, D8 on 2-day sums with the pooled `s₂`, frozen-baseline CUSUM with re-anchoring and as-of `σ(h)`, D6 on two-day growth with the fitted percentile, intermittent series on **non-overlapping** weekly sums (zero share ≤ 50 %) or the **hurdle statistic with the clustering gate** (> 50 %, D-24), aggregate scopes on D3 only, commitment rules, category precedence | unit cases per detector; a slow drift that an adaptive one-step CUSUM misses is caught; **valid shares (rev. 26; wording fixed in rev. 27):** a share is `null` only when both of its parts are 0 that day, and D5/D7 skip that day; a day whose usage **nets** to 0 with committed +5 and uncommitted −5 has the defined committed share 5 / 10 = 0.5; a day with negative uncommitted usage still gives a committed share in [0, 1]; with fewer than 14 defined days in 28, D5 and D7 do not test; **valid samples (rev. 24):** a daily-scored series with 16 zero days and 2 negative days in its window routes to the intermittent path (≥ 30 % non-positive), one with 10 zero days keeps finite D2 state from its 46 valid days, D8 skips a pair with a zero day, D3 carries `S⁺` over an invalid day, and D6 needs two valid growths; no statistic is ever NaN or infinite; **zero week (rev. 24):** an all-zero week is scored at 0.1 × the prior median week, lowers `S⁺`, never alarms, and gives the same z for amounts in USD and in JPY; **after an upward alarm `S⁺` restarts at 0, the next episode starts the next day, and the baseline is not re-anchored while the leaf's group is open** (rev. 18); **the 28-day cap wins (rev. 19):** a leaf and an aggregate scope with a positive sum and an open group on day a + 28 are re-anchored that day, the sums and the episode restart, and the open group is extended by the next candidate through persistence; **unnamed remainder (rev. 19):** a D3 drift on a leaf whose excess sits in its unnamed remainder row is `gradual_drift`, not `runaway_resource`; ARL₀ of D3 on simulated N(0,1) within ±15 % of Siegmund's value at h = 7.5 and 9.0; **per series-day rates of D1 ∧ D2 and D8 on simulated series with estimated median, MAD and pooled scale within ±25 % of `budget5.py`'s 4.3 × 10⁻⁵ and 1.5 × 10⁻⁵**; the weekly statistic's in-control rate within ±25 % of `budget5.py`'s per zero share; the hurdle statistic's mean and variance match the compound-binomial formula on simulated independent days (±5 %), its in-control rate is within a factor of 2 of `budget5.py`'s at zero shares 0.6–0.8, and a series with lag-1 persistence 0.6 is routed to `info` in ≥ 85 % of weeks while an independent one passes in ≥ 97 %; D8 fires by day 2 on a 4.9σ shift in ≥ 85 % of 2,000 trials; a hurdle-scored series whose r₁ ≥ 0.30 never yields `warning`; D6's threshold from a log-normal fit with n_k < 30 falling back to the pooled mean; constant series never fire; a calendar-cohort series with its factor applied does not fire on event days; **D4 reactivation:** a series regular for 20 days, dormant for 60, fires on its first restart day at ≥ min impact; a series with 3 active days in the window is not under the rule; a series dormant for 90 days after a regular month reaches `warning` (history taken before the gap, not before the window); a bursty series (< 50 % active pre-dormancy) restarting at 1 × its active-day mean yields `info`, at ≥ 10 × min and ≥ 3 × that mean reaches `warning`; a monthly job (2 active days per 56) restarting at 10 × reaches `warning` through the 112-day lookback, a quarterly one (≤ 2 in 112) gets `info`; precedence table exact | **committed or untagged share as a signed ratio** (outside [0, 1] or a division by 0); **MAD of `log y` over all 56 days** (a zero day then gives −∞); **routing on zero days only** (negative days stay daily-scored); **D8 on a pair with a zero day**; **zero week as `log(0.001)`** (the z then depends on the currency unit); CUSUM on adaptive one-step residuals; re-anchor while `S⁺ > 0`; re-anchor while the leaf's group is open; episode mean taken from the anchor day instead of from the last restart; hold the baseline past 28 days while the group is open (the aggregate then needs a 29th baseline value, which its array CHECK refuses); MAD floor removed; pooled floor removed; 28-day window; `commitment_expiry` classified as `commitment_effect`; precedence order swapped; z on the linear scale; σ(h) from errors with forecast day ≥ t (the scored day or later); calendar factor not applied to D2; weekly sums overlapping (rolling); D8 on the series' own MAD; clustering gate removed; hurdle variance without the −7q̂²m̂² term; aggregate scopes running D2; D6 on the empirical percentile; reactivation dormancy threshold 3 → 4 active days; reactivation history condition removed; history taken before the 56-day window instead of before the dormant stretch; size override without the 3 × relative test; prior-mean lookback not extended to 112 days; reactivation on a 2-day sum |
| 16 | **5-2b** | Grouping steps 1–6 (fan-in first, provider-wide first), deterministic ids, merges, root causes, severity | one group per provider-wide, billing-account and account fan-in; same input ⇒ same groups and ids; merges only within ±1 day; root causes ranked by excess; **a survivor merged later (rev. 23):** a billing-account group that absorbed two singletons on day t is absorbed by a provider-wide group on t + 1: both singletons and the billing-account group end up pointing directly at the provider-wide survivor, with a `repointed` event for each singleton carrying the old target (the billing-account group) and the new one (the provider-wide group), and the evaluator counts one group; **persisted singletons join fan-in (rev. 17):** two accounts of a billing account start singleton groups on day t − 1 and three more accounts have candidates on day t, giving one billing-account group with first day t − 1 that absorbs both singletons (`merged`), no double-counted leaf-day, and severity the members' maximum; **severity from daily values:** a 3-day anomaly whose cumulative impact passes `warning` but no single day does stays `info`; a D4 candidate with expected 0 is `warning` at x_t ≥ min and `critical` at ≥ 10 × min; **window means (rev. 18):** a weekly-scored leaf at $150/day whose week is +$400 (+38 %) with one +$180 day yields `info`, and a D8 pair whose second day alone passes but whose 2-day mean does not yields `info`; **account fan-in over a persisted singleton (rev. 18):** account X has an open singleton on service A from t − 1, and services B and C of X have candidates on t: one account group with first day t − 1 absorbs the singleton | provider-wide rule skipped; **severity of a multi-day candidate from its largest day**; **fan-in step 1 restricted to the same service** (the account case then stays a singleton plus two new singletons); fan-in threshold off by one; random group ids; severity downgrade allowed; merge window unbounded; **persistence before fan-in** (the five-account case then gives two singletons and a three-account group); **merge a survivor without re-pointing its members first** (the guard then refuses the merge); severity from cumulative impact; `ρ` undefined (NaN) when expected is 0 |
| 17 | **5-3** | `ratio-analytics detect` (daily + as-of replay from day 57, live from day 62), automatic open and resolve, restatement | thresholds tuned on **tuning-natural** (false positives: measured total ≤ 0.15/day, Garwood upper ≤ 0.30/day) and on tuning (recall side), frozen and committed before any evaluation seed is generated; replay scores day t with data ≤ t and errors with forecast day ≤ t − 1 (poisoned-future test); `restated` path via the `ci` daily-delivery replay; **re-introduction (rev. 25):** a `ci` replay where B1 detects a group, B2's restatement resolves it `restated` and B3 brings the same first day back opens occurrence 2 with a new id while occurrence 1 stays resolved, and **a fresh replay of the same batches** (a new stack, from the same input) gives the same ids and occurrences (rev. 26); `new_region` on `ci`; two concurrent `detect` starts give one run and one `ALREADY_RUNNING` (rev. 17); **restart continuity (rev. 18):** a replay stopped after day t and resumed on t + 1 gives, for an aggregate scope with an open D3 episode and for a leaf, the same anchor, `S⁺`, episode and alarms as an uninterrupted replay; **forecast version pinned (rev. 27):** a detect run (and a replay) that captured forecast run F1 keeps reading F1 in every transaction after F2 succeeds and moves `forecast_pointer` mid-run, and its `z_t` and intervals equal a run with no pointer move; `input_forecast_run_id` cannot be updated (42501); **anomaly publication (rev. 24, Appendix D.4):** a detect run killed after evaluating half the fleet, one that fails before its success transaction and one that is fenced (`LEASE_LOST`) each leave `anomalies`, `anomaly_days`, `anomaly_root_causes`, `anomaly_events` and the API byte-identical; after a successful run a REPEATABLE READ reader sees all of its changes or none; **frozen anchor (rev. 18; rev. 19):** the anchor is the leaf's daily-updated model state as of day a (no forecast run on a needed), and a weekly refit and a calendar-factor update between the anchor and the alarm leave every `z_t` of D3 unchanged | calibrate scored day t on its own error, or read any charge day > t (leakage); D8 on `r_t + r_{t+1}`; auto-resolve after 1 day; drop the per-kind advisory lock for `detect`; aggregate D3 state not persisted (recomputed from a new anchor each run); D3 baseline rebuilt from the current `forecast_state` instead of the anchor columns; **detect reading forecast rows through `forecast_pointer`** (the run then mixes F1 and F2); **`occurrence` left out of the dedup key or the UUID v5 input** (B3 then collides with the resolved row: 23505, or the same id); **write anomaly rows as candidates are found, outside the success transaction; commit anomaly rows before `assertLease`** |
| 18 | **5-4** | Evaluation harness (Python) + `fleet15k` acceptance: precision and AT-4 on the pooled natural seeds (cohorts included), recall and TTD on the enriched seed (individual series only) | matching with X = 30 %, k = 3; duplicates counted false; Wilson rules of §4.9; Garwood intervals on every false-positive rate (exact: bisection on the Poisson CDF, as `budget3.py`, never an approximation); alert-fatigue outputs (mean, p95, max; `info` per day, hurdle-scored series' `info` signals and routes separately; `info`-signal recall of clustered intermittent series); per-cohort, first- and second-occurrence and calendar-event-day breakdowns; the calendar-jitter robustness run reported; folded labels reported; `new_region` and FT-8 marked "`full` only" | matcher accepts any day; matcher ignores the 30 % / top-3 rule; no-alert labels ignored; precision computed on the enriched seed; Wilson bound replaced by the point estimate; duplicates counted correct |
| 19 | **5-5** | API `anomalies`, `anomalies/{id}` (GET only); `ratio-native` CostSource adapter; `CostFinding` optional fields (D-18) | route test set; PointFive mapping unchanged (existing tests untouched); decimal string ↔ number display rounding; no non-GET handler | wrong status vocabulary; impact sign flipped |
| 20 | **5-6** | UI: forecast panel, native anomalies in Findings with the R4 label (D-16, T2); latency run (§5.3) on `fleet15k` | component tests; SLOs measured | — |
| — | *5-7 (deferred, D-15)* | status write endpoint + `ratio_triage` | not built until per-user identity exists | — |
| — | *`full` runs* | 3-4, 4-6 and 5-4 repeated on `full` | after owner action OA-1 | — |
| — | *follow-up slice* | notification delivery (D-17) | own design and egress review | — |

## 8. Decision log (decided by orchestrator, 2026-10-04)

Every decision below was **decided by the orchestrator under the owner's
delegation on 2026-10-04**. "As recommended" means the first revision's
default was adopted unchanged. "Refined (rev. 3)" marks a change made in
answer to the challenger's review of 461fbc2, inside the decision as taken.
D-24 was proposed in revision 6 and decided by the orchestrator, under the
owner's delegation, for revision 7.

| Id | Decision | Decided | Revisit when |
|---|---|---|---|
| D-01 | Fact grain | **Three profiles.** `ci` and `full`: account × service × region × pricing/tag split × day. **`fleet15k`: account × service × day, minimal columns**, all 15,000 accounts. Refined (rev. 3): the escalation ladder (§2.8) set the folding to top 2 services at or above median spend and top 1 below, + `Other services`; labels injected before folding | measured `fleet15k` disk > 5.5 GB (escalate; never fewer accounts) |
| D-02 | Span | `ci` 4 periods; **`fleet15k` 4 periods (122 days)**: warm-up P1–P2, calibration P3, scoring P4 (§3.8); `full` 13 periods | a target needs more origins than `fleet15k` provides |
| D-03 | Where each profile runs | `ci` in CI; `fleet15k` in this container class, as sequential runs (refined rev. 5: five mandatory seeds, tuning, tuning-natural, natural-1, natural-2, enriched, plus natural-3 if the pooled group count is below 140); `full` needs **OA-1** | OA-1 is done |
| D-04 | Synthetic identity | as recommended, refined (rev. 3): providers exactly `SyntheticAWS` / `SyntheticAzure` / `SyntheticGCP` (D-21); **non-numeric ids** `SYN-A-…` / `SYN-BA-…`; tenant `synthetic-fleet-15k`; display names "SYNTHETIC"; manifest marker | — |
| D-05 | Storage | as recommended: batch-keyed rollup tables; no materialised views; no partitioning initially. Refined: narrow `cost_daily` with an integer `batch_seq`, sparse `billing_daily` | §5.3 SLOs missed |
| D-06 | Per-row staged-only trigger (brief D-09) | **keep it**; load time measured on `fleet15k`. **Trigger: a `fleet15k` load above 60 minutes ⇒ revisit with that evidence** | the trigger fires |
| D-07 | First post-0001 migration | accepted: 0002–0004 as expand migrations. **Amended wording (accepted by the orchestrator): for Slice 0 and Slice 1 tests, an exact old set becomes an exact new set; never weakened.** The edits forced by D-08 are `reader.db.test.ts:28-32` and `privileges.db.test.ts:97`; migration-version assertions are listed in §6.2. Each gets challenger scrutiny | any other Slice 0/1 test would need to change: stop and escalate |
| D-08 | Read access | as recommended: widen `ratio_reader` by SELECT on the new definer views only | — |
| D-09 | Monitored measure | as recommended, refined (rev. 3): `EffectiveCost` where `ChargeCategory = 'Usage'` **and** `ChargeFrequency = 'Usage-Based'` and `ChargeClass` IS NULL; billed month-end separately (**deferred in rev. 27**: not forecast in Slices 3–5, §3.1; the FT targets are all on `M`). Refined (rev. 15, Copilot r4178753811): only rows whose charge period is at most one day, so a multi-day usage row does not become a one-day spike (it stays in billed and effective totals; §2.9) | — |
| D-10 | Currency | as recommended: per billing currency; no FX in Slices 3–5 | a reporting currency is required |
| D-11 | Compute stack | as recommended: SQL rollups + TypeScript job; Python stdlib only as the independent evaluator | — |
| D-12 | Retention of derived data | accepted **as a restricted change**. Refined (rev. 3): removal only through two reviewed `SECURITY DEFINER` functions, `ratio.analytics_apply_retention()` (0002) and `ratio.analytics_apply_forecast_retention()` (0003) (owner-owned, fixed criteria; the job has **no DELETE grant**); covers superseded-batch rollups and run-keyed `cost_daily_scope`, `billing_daily_scope`, `account_dim`, forecast and detector state (`forecast_state`, `forecast_points`, `forecast_totals`, `forecast_scope_state`, `detector_state`, `detector_scope_state`, `detector_cohort_state`) beyond the 2 latest runs; anomalies and events are kept; backtest metrics and per-origin backtest outputs are kept for the 2 latest succeeded backtest runs and every pinned run (rev. 25, Copilot r4179229471: revisions 3–24 kept all of them, so they grew without bound) | — |
| D-13 | Default thresholds | as recommended: min impact USD/EUR/GBP 100, JPY 15,000 per day; `warning` ≥ min and ≥ 20 %; `critical` ≥ 10 × min and ≥ 50 %, or ≥ 50 × min cumulative. Clarified (rev. 17, rev. 18): the per-day thresholds apply to one candidate's daily excess and relative value, which for a multi-day statistic (D8, D6, a D3 episode, a weekly or hurdle week) is its window's mean; the cumulative clause to the anomaly's total; with expected 0 the relative value is +∞ for an increase (§4.4) | measured precision or recall disagree (escalate, D-20) |
| D-14 | Spend drops | as recommended: detected, `info` by default | — |
| D-15 | Manual acknowledge / resolve | **deferred** until per-user identity exists; findings open and resolve automatically; lifecycle parity is partial | per-user identity exists |
| D-16 | R4 for fleet spend | as recommended: "value context: not attributed" next to every fleet cost, forecast and anomaly (T2) | value attribution exists for fleet accounts |
| D-17 | Notifications | **a follow-up slice** with its own egress review | — |
| D-18 | `CostFinding` shape | as recommended: additive optional fields | — |
| D-19 | Relation to existing rules | as recommended: keep obvious.md's workload rule; fleet rules named separately | — |
| D-20 | Missed acceptance targets | **recorded and escalated, never relaxed** | — |
| D-22 | Month-start and month-end patterns | **decided by the orchestrator (rev. 5, option a):** the forecast gains a calendar-event component (§3.2: month-start, mid-month, month-end; multiplicative, per series, significance-gated); the `month_end_batch` and `monthly_cycle` cohorts stay in AT-1 and AT-4; first occurrences are counted in the budget | the real-data residual on calendar days is measured |
| D-23 | False-positive design margin | **decided by the orchestrator (rev. 5):** the detector is tuned to ≤ 0.15 false groups per day in expectation (gate 0.30), measured on a natural-rate tuning seed (`tuning-natural`) with a Garwood interval; the aggregate-scope term is derived in closed form. Rev. 6 applies it with estimation noise in every term, D8 added and h = 9.0; rev. 7 adds the hurdle term and `month_start`'s single prior cycle (total 0.101, 0.131 with every conservative bound); the decision itself is unchanged | measured rates differ from the derivation |
| D-24 | Intermittent series with a zero share above 50 % | **decided by the orchestrator under the owner's delegation (rev. 7; the challenger's option a):** a **hurdle (compound-binomial) weekly statistic** (q̂, m̂, v̂ from the 56 days before the scored week, as `budget5.py` computes them; z = (W − 7q̂m̂)/√(7q̂(v̂ + m̂²) − 7q̂²m̂²); CUSUM k = 0.5, h = 9.0) with a **clustering gate** (lag-1 autocorrelation of the active-day indicator over the same 56 days: < 0.30 → `warning` possible; ≥ 0.30 → `info` only, since clustered occurrence cannot be modelled in these slices). **A series is scored only with ≥ 3 active days in the 56-day window**; one with fewer is dormant and covered by D4's reactivation rule (rev. 8). Conditions: the `info`-signal recall of the `info`-only remainder is reported in AT-7; series with 30–50 % zeros keep the non-overlapping weekly sums | real data, or the `full` profile (OA-1) |
| D-21 | Synthetic providers under #62 | **decided by the orchestrator (rev. 3):** #62 exports a fixed `SYNTHETIC_PROVIDERS` set `{SyntheticCloud, SyntheticAWS, SyntheticAzure, SyntheticGCP}`; with the opt-in every name in it is accepted for any layout, without it none is. The generator emits three of those names, `SyntheticAWS`, `SyntheticAzure` and `SyntheticGCP`, and never any other provider name; `SyntheticCloud`, the fourth member, is the existing fixtures' name (§2.2; `src/ingest/focus/provider.ts`), which the generator does not emit (rev. 22, Copilot r4179088932: "uses exactly those names" overstated it); `local:synthetic` sets the opt-in for its own workers only; Slice 3 starts after #62 merges. **Revisit trigger fired (rev. 11):** #62 shipped (#67, #68) a stricter contract than first assumed. `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` is accepted only with `RATIO_ENV` explicitly `development` or `test`; unset, unknown, `staging` and `production` are refused. An explicit in-process `allowSyntheticProviders: true` throws `SYNTHETIC_PROVIDERS_NOT_ALLOWED` without the process env opt-in. **The decision still holds**: `local:synthetic` spawns its workers with `RATIO_ENV=development`, and Slice 3's static test checks development/test-only acceptance (§2.7, §6.3) | #62 changes its contract again |

### Known limits (complete; rev. 14, completed in rev. 15)

Each limit is stated where it arises; this list collects **all** of them,
so that the decision log carries them.
- **Folding on `fleet15k`.** 79.0 % of account × service series and 25.6 %
  of spend are folded; recall and leaf-forecast figures are measured on
  individual series only (§2.5, §2.8). `full` (OA-1) removes this.
- **Generator-only validation.** The targets validate the implementation,
  not real-world accuracy (§3.10). Several generator properties are shared
  by `tuning-natural`, so it cannot detect their misspecification:
  - pinned calendar factors;
  - independent intermittent days;
  - no null account or service identity columns (`region_key` is `''` on
    every `fleet15k` row, since there is no region dimension);
  - no negative usage.
- **Calendar jitter.** With ±10 % month-to-month factors, the cohorts add
  ≈ +0.082 false groups per day. This is **reported, not in the total**;
  the pass probability is then 0.993 at the design total and 0.959 at the
  conservative total (§2.3, §4.2). Real calendars are measured on real
  data only.
- **Calendar recall with two prior cycles** falls to ≈ 0.72 when a prior
  cycle held an undetected anomaly (§3.2).
- **No holiday calendar.** Holiday drops are `info` (§2.3, §3.2).
- **Budget assumptions.** The false-positive budget assumes a 10 % scale
  heterogeneity, and the intermittent weekly term could be up to ≈ 2 × with
  a wider burst-size spread (§4.2).
- **Sparse daily-scored series on real data (rev. 24).** A series with
  up to 29 % non-positive days stays daily-scored and estimates D2's
  median and MAD from as few as 40 values; `budget5.py` assumes 56, which
  is exact for `fleet15k`. Its estimation noise, and so its false-positive
  rate, is higher on such real series (§4.2).
- **D3's frozen-baseline autocorrelation** is covered by no bound, only by
  the `tuning-natural` measurement (§4.2).
- **AT-3 on real data.** On the generator every meaningful level shift is
  ≥ 4.8σ. On noisier real series a × 1.2 shift can take ≈ 8 days by D3
  (§4.2).
- **AT-3 drift target at risk (rev. 18).** Under the per-candidate
  severity rule a slow drift reaches `warning` only once a day's excess
  (or an episode's mean) passes the minimum impact and 20 %. Measured
  from AT-3's anchor, the optimistic median is 7 days for D3 alone and
  the noise-free first-passing day 6, against a target of 7 (§4.2, B.5.13). The target is
  unchanged. If the enriched seed misses it, D-20 applies and the owner
  decides.
- **Intermittent series.** Weekly scoring lengthens time-to-detect by up
  to 7 days. Clustered series with more than 50 % zero days are `info`
  only, outside AT-2 (D-24; §4.2).
- **Reactivation false positives on real data.** With clustered
  intermittent days, about 0.00094 per day at ρ = 0.3 and 0.054 at ρ = 0.6
  (§4.2, D4).
- **Quarterly jobs** get no size override in D4 (b)(ii) (§4.2).
- **Negative usage (rev. 14).** Leaf-days with `M` ≤ 0 are not scored on
  the log scale, and a same-day negative-`Usage` credit can mask a spike.
  Only negative-`Usage` rows can do this, since `Credit` and `Tax` are
  outside `M`. `fleet15k` emits none, so this recall blind spot is
  unmeasured until real data (§3.1, §4.2 budget table).
- **Multi-day usage is outside `M` (rev. 15, listed in rev. 16).** A
  `Usage` row whose charge period exceeds one day is excluded from `M`
  (§2.9). On a series that bills some days daily and others in multi-day
  rows, `M` shows an artificial drop on the multi-day days, and a jump when
  the series switches back. That is a switching artefact, not spend. The
  shape exists on main: `src/costsource/seed.ts` emits whole-month `Usage`
  rows. The share is reported per period and per leaf under `freshness`
  (§5.1), so it is visible on real data; `fleet15k` emits none.
  **A leaf billed only in multi-day rows** (rev. 17) has `M` = 0 on every
  day: it is inactive throughout, and no detector ever scores it. Its
  spend is still in the billed totals and its share in `freshness` is
  100 %, which is how it shows up.
- **Intervals and horizons.** An `extrapolated` interval (an empty horizon
  bucket filled by √h scaling) is never scored. 31–90-day horizons are not
  assessed on `fleet15k` (§3.4, §3.8).
- **`full`-only targets.** `new_region` (no region dimension on
  `fleet15k`), FT-8, per-series interval quantiles, and FT-10 / AT-8 at
  ≈ 107 k leaves need the `full` profile, so they wait for OA-1 (§2.5,
  §3.10, §8 OA-1).
- **Idealised data arrival on `fleet15k`.** Closed months load at once;
  late data and month-to-date restatement are exercised on `ci` only
  (§0, §2.7).
- **Partial lifecycle parity.** Human acknowledge/resolve is deferred
  (D-15), and notification delivery is a follow-up slice (D-17) (§0).
- **No billed month-end forecast (rev. 27).** Only `M` is forecast.
  Billed `B` needs its own billed-usage model, because committed usage
  can be billed at 0 while its effective cost is amortised. It is a
  follow-up slice. Billed actuals stay in `costs/daily` (§3.1).
- **The pointer guard trigger** protects against bugs, not against a
  compromised analytics login (Appendix D.1).

### Owner actions (not decisions)

| Id | Action | Unblocks |
|---|---|---|
| OA-1 | An environment for the `full` profile with **≥ 150 GB free disk** (reference: 8 vCPU, 32 GB RAM, NVMe): **the owner's own machine, or explicitly approved spend.** BOUNDARY v2 still applies (local, ephemeral, synthetic). | FT-8, per-series interval quantiles, `new_region` at scale, FT-10 and AT-8 at ≈ 107 k leaves, D-09 data at ≈ 6 M rows per month |

## 9. Tracked items (side findings)

| Id | Item | Owner | Status / next step |
|---|---|---|---|
| T1 | **SeaweedFS capacity.** The local compose runs `-volume.max=64 -master.volumeSizeLimitMB=64`, ≈ 4 GiB (assumption: volumes × size limit). `fleet15k` needs ≈ 0.3 GB in the two buckets and should fit; `full` needs ≈ 11 GB. | Slice 3 implementer (PR 3-4) | measure on `fleet15k`; override (restricted, `deployment`) only if needed; required for `full` |
| T2 | **R4 conflict.** Fleet spend has no value attribution, so "every cost paired with value" cannot be met literally. Handling: the D-16 label. | Slice 5 implementer (PR 5-6); any change to the rule itself: orchestrator, with the owner | label implemented and tested in 5-6; rule text in `.obvious/obvious.md` unchanged |
| T3 | **Slice 0/1 test edits for migration 0002**: exact old set → exact new set, never weakened (D-07); forced edits listed in §6.2. | Slice 4 implementer (PR 4-1); the challenger reviews each edit | the PR lists every edited assertion with before/after |
| T4 | **Wrong CLAUDE.md in this session's context.** The harness loaded `/home/user/adaptcloud/CLAUDE.md` (an unrelated "Agnus Dei / Sage" homeschool project) as project instructions for this repository. It was ignored. | orchestrator (session and environment configuration) | report it to whoever configures the sessions |
| T5 | **F1, the `daysInMonthOf` time-zone bug** (February 2026 = 27 days under `TZ=Asia/Tokyo`). | PR 4-0 implementer | first PR of the plan |
| T6 | **F4, D-09's trigger** at ≈ 6 M rows per month in `full`. | orchestrator (D-06) | `fleet15k` load time measured in 3-4; `full` after OA-1 |
| T7 | **#62 dependency** (D-21). Slice 3 output uses `Synthetic*` provider names that only #62's opt-in accepts once the provider check exists. | #62 implementer; orchestrator for sequencing | Slice 3 PRs open after #62 merges |
| T8 | **Governance wording reverted.** Revisions 1 and 2 of this design were worded to keep the governance classifier at `low`. That was wrong and is reverted (EVIDENCE.md §2). | orchestrator | this PR goes through the restricted exception path |

## 10. Rollback

- **Design PR:** revert the documents.
- **Generator and local run (Slice 3):** revert the PRs; nothing in the
  shipped schema changes; local stacks are removed with `down -v`.
- **Migrations 0002–0004:** expand-only; the previous release keeps working
  on the newer schema. Down migrations stay refused in production by design;
  in dev/test `migrate --down N` removes the analytics objects (the new
  roles are cluster-global and kept, as 0001's roles are).
- **Analytics job:** stop scheduling it; API endpoints answer from the last
  committed run (pointer) or 503 `not_configured` when unset; the
  `ALTER ROLE … NOLOGIN` kill switch works for the analytics login as for
  the reader (per-start check refuses it).
- **Retention of derived data:** revoke EXECUTE on the two retention
  functions from `ratio_analytics` (a reviewed migration) to stop all
  removal; derived rows then simply accumulate. Removed derived rows are
  recomputable from the kept facts by a fresh rollup or forecast run;
  anomalies and events are never removed. Backtest output is removed only
  for unpinned runs older than the 2 latest succeeded, keeping their
  manifest, and can be recomputed by a fresh backtest run. Pinned
  evidence is never removed, so nothing irrecoverable is lost (rev. 26).
- **Synthetic-provider opt-in:** it exists only in `local:synthetic`'s
  worker environment; removing that line, or reverting #62's opt-in, makes
  every synthetic row quarantine again (fail closed).
- **API:** the new routes are independent of `costs/published`; reverting
  them leaves Slice 2 unchanged.
