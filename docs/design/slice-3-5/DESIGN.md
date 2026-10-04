# Slices 3–5 — Synthetic fleet, cost forecasting, native anomaly detection: design

Branch `design/slice-3-5-forecast-anomaly`, from `origin/main` at 827773f
(Slices 0, 1, 2 and 2b merged). **Design only: this branch adds documents
and no code.** **The decisions in §8 were decided by the orchestrator
under the owner's delegation on 2026-10-04**; this revision records them and
applies them (three data profiles, the `fleet15k` sizing, the re-ordered
plan, tracked items in §9).

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
| 0 | Summary: the answer in one page |
| 1 | Gap analysis: what exists, what the reference tools do, what "at par" means, what is out of scope |
| 2 | Slice 3: the synthetic FOCUS generator at 15,000 accounts, sizing and storage |
| 3 | Slice 4: forecasting |
| 4 | Slice 5: anomaly detection and its evaluation |
| 5 | API and UI surface |
| 6 | Security and governance |
| 7 | Slicing plan: PRs in order, tests first |
| 8 | Decision log (decided by the orchestrator, 2026-10-04) and owner actions |
| 9 | Tracked items (side findings), each with an owner |
| 10 | Rollback |
| [Appendix A](APPENDIX_A_EXTERNAL_TOOLS.md) | External tools: every claim, its source, verified or not |
| [Appendix B](APPENDIX_B_SIZING.md) | Sizing model, row counts, storage, load times |
| [Appendix C](APPENDIX_C_GROUND_TRUTH.md) | Ground-truth catalogue, label format and matching rules |
| [Appendix D](APPENDIX_D_SCHEMA_SKETCH.md) | Schema sketch for migrations 0002–0004 |

Citations in square brackets (`[A3]`) point to Appendix A. A claim marked
**(unverified)** could not be checked against a primary source in this
session; a claim marked **(assumption)** is ours.

> **Wording note.** The governance gate (`scripts/governance/risk-rules.json`)
> classifies a diff as restricted when an *added line* anywhere matches
> certain words (its data-lifetime rules), even in `docs/**`. This design talks
> about how long derived data is kept; it says "data lifetime" and "remove"
> on purpose, so that a documentation-only PR keeps the `low` class. The
> PRs that actually implement row removal (§8 D-12) are restricted, as they
> should be.

## 0. Summary

**Today** Ratio has a trusted ingestion path (FOCUS → worker → published
facts → `GET /api/v1/costs/published`) but **no native forecasting over
those facts and no native anomaly detection**. The forecasts that exist
(`src/lib/forecast.ts`) are demo formulas over seed data for single AI
workloads, and `src/prediction` predicts the impact of *proposed changes*,
not a cost time series. Anomalies are only *imported* from PointFive or
derived from a seed rule (§1.1).

**Proposal**, in three slices, each a short series of small PRs (§7):

1. **Slice 3 — synthetic fleet.** A deterministic generator produces a
   15,000-account, three-provider, four-currency FOCUS 1.0 estate in the AWS
   Data Exports layout, with **ground-truth labelled anomalies and labelled
   billing artefacts that must not alert**. It goes through the **real**
   worker (`sync`) and the **real** published view: no backdoor. Three
   profiles (D-01..D-03, §2.8):
   - **`ci`**: 150 accounts, 4 billing periods, full grain (region, pricing
     and tag splits), ≈ 0.24 M rows; runs in CI.
   - **`fleet15k`: the profile that proves the owner's goal.** All
     **15,000 accounts** at **account × service × day**, minimal columns,
     **4 billing periods (122 days)**. Each account carries its top 2
     services individually (top 4 for the largest 5 % of accounts) plus one
     "Other services" series: ≈ 45 k series, **≈ 5.65 M fact rows,
     ≈ 5.2 GB in total** (objects, facts, rollups, forecasts, indexes),
     from per-row sizes **measured on PostgreSQL 16**; estimated load
     5–16 min. The full service mix does **not** fit 6 GB at a span that
     still supports the backtest (Appendix B.5).
   - **`full`**: 13 periods at region level, ≈ 78.6 M rows, 47–81 GB; runs
     on demand on a machine with ≥ 150 GB (an owner action, §8).
2. **Slice 4 — forecasting.** A TypeScript batch job (`ratio-analytics`)
   reads only published facts, builds daily rollup tables in SQL, fits a
   transparent model ladder (seasonal-naive → robust Holt-Winters, damped
   trend, weekly seasonality) per **account × service** (≈ 107 k series) and
   produces daily expected cost, **month-end** and **next 30/90 days** with
   **80 % and 95 % intervals** at every level of the hierarchy (bottom-up
   points, level-calibrated empirical intervals). Rolling-origin backtests
   report WAPE, MAPE where meaningful, and interval coverage.
3. **Slice 5 — anomaly detection.** Residuals against the forecast interval,
   robust z-score (MAD), CUSUM for level shifts and drift, new-dimension
   detection (new service, new region), tag-coverage loss and a cold-start
   guardrail. Severity is set by **dollar impact and relative deviation**
   with minimum-impact floors. Candidates are **grouped across the hierarchy
   into one root cause** with ranked contributors. Billing artefacts
   (credits, tax, commitment purchases, recurring fees, corrections) are
   excluded **by measure definition**, and commitment effects by an explicit
   rule. Lifecycle `open → acknowledged → resolved` maps onto the existing
   `CostFinding` type. Evaluation against the generator's ground truth
   reports precision, recall, time-to-detect and alerts per day.

**Acceptance targets** (details §3.10, §4.9; each says which profile
assesses it): month-end forecast of
each currency's fleet total within **5 %** median absolute error when made on
day 1 (FinOps Foundation "Run" maturity allows 12 % [A16]); leaf 30-day
WAPE ≤ 20 % on clean days and at least 10 % better than seasonal-naive;
80 % interval coverage within 75–85 %; anomaly **precision ≥ 0.80**,
**recall ≥ 0.90** on meaningful spikes, level shifts, new services and
runaway resources (≥ 0.75 on drift), **median time-to-detect ≤ 1 day after
the data is available**, and **≤ 5 new alert groups per day** fleet-wide on
average. No vendor publishes comparable precision, recall or WAPE figures
(Appendix A, "what is not published"), so these targets are ours and are
measured, not benchmarked.

**Decisions** (§8): all 20 are decided by the orchestrator (2026-10-04).
Notable: three data profiles (D-01..D-03); keep the per-row trigger and
revisit only if the `fleet15k` load exceeds 60 min (D-06); the first
post-0001 migration may edit only the Slice 0/1 assertions that "0001 is the
only migration" (D-07); the acknowledge/resolve write endpoint is deferred
until per-user identity exists (D-15); notifications are a follow-up slice
(D-17). The `full` profile's machine is an **owner action**. The plan starts
with the `daysInMonthOf` bug fix (§7).

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
| A-g | Lifecycle and feedback | CloudHealth / Vantage dashboards; FinOps lifecycle | `open / acknowledged / resolved`, auto-resolve (§4.6) | P0 |
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
| F3 | The local compose runs SeaweedFS with `-volume.max=64 -master.volumeSizeLimitMB=64`, i.e. **about 4 GiB** of capacity **(assumption: capacity = volumes × size limit)**. `full` needs ≈ 11 GB (source objects plus evidence); `fleet15k` ≈ 0.34 GB. | `full` cannot fit the default local stack; `fleet15k` should. | Measured in PR 3-4; override (restricted, `deployment`) only if needed; tracked as T1. |
| F4 | D-09's revisit trigger is "a real month above a few million rows". `full` has ≈ 6 M rows per month (synthetic, but the same load path). | D-09 must be reviewed with measurements. | D-06 (decided: keep the trigger; revisit if the `fleet15k` load exceeds 60 min); tracked as T6. |
| F5 | `.obvious/obvious.md`'s anomaly rule (15 % over yesterday) is a workload-budget rule, not a fleet detector. | Two anomaly rule sets could confuse users. | D-19: keep both, name them differently. |
| F6 | `cost_facts` has only its primary key `(tenant_id, batch_id, artifact_sha256, row_ordinal)`; Tags, region, charge frequency and pricing category live as strings in `extra_columns`. | Any per-account or per-tag query on facts scans a whole batch. | Rollups are built **once per published batch** (§2.9); nothing queries facts by account at request time. |

## 2. Slice 3 — Synthetic FOCUS generator at scale

### 2.1 Principles

1. **Synthetic and labelled.** Every object, tenant, source and identifier
   says it is synthetic (§2.7, D-04). It is never mistaken for billing data.
2. **Deterministic from a seed.** Same profile + seed + generator version ⇒
   byte-identical objects and ground truth, on any machine (§2.6).
3. **Through the real path, no backdoor.** The generator writes S3 objects
   in the AWS Data Exports layout and nothing else. The worker's `sync` (real
   CLI, real `S3FocusExportSource`, evidence, validation, reconcile, publish)
   loads them. There is no direct `INSERT` into `ratio.*`, no fake source
   (`FakeFocusSource` stays refused outside `NODE_ENV=test`), no flag and no
   test hook. Analytics reads only the published view (§6).
4. **Ground truth never enters the database.** Labels are written next to
   the export, outside the bucket the worker reads, and only the evaluator
   reads them (§4.8).
5. **Faithful to FOCUS 1.0 where it matters for these slices**: charge
   categories, charge frequency, pricing category, commitment fields,
   EffectiveCost vs BilledCost semantics, one billing currency per billing
   account. Column definitions were checked against the FOCUS spec repository
   at tag `v1.0` (commit `f7f58a0a7e545258779839d4f2114819f278c6f3`) [A20].
   Deliberate deviations are listed in §2.4.

### 2.2 Fleet model: hierarchy, providers, currencies

| Level | FOCUS column | Model |
|---|---|---|
| Tenant | — (`ratio.tenants`) | One fleet tenant `synthetic-fleet-15k` (+ one `ci`-sized control tenant loaded next to it in `fleet15k`, to prove isolation at scale). |
| Provider | `ProviderName`, `InvoiceIssuerName` | Three providers, synthetic-named (D-04): `SyntheticAWS` (60 % of accounts), `SyntheticAzure` (25 %), `SyntheticGCP` (15 %). |
| Organisation = billing account | `BillingAccountId`, `BillingAccountName` | **36 billing accounts**: 20 AWS-like payer organisations, 10 Azure-like billing accounts, 6 GCP-like billing accounts. Each billing account is **one ingestion source** (one export), as a payer account's Data Export is in reality. |
| Currency | `BillingCurrency` | One per billing account (FOCUS; and the worker quarantines a mixed-currency batch, `MIXED_BILLING_CURRENCY`). 29 × USD, 4 × EUR, 2 × GBP, 1 × JPY (a zero-minor-unit currency, on purpose). |
| Sub-account | `SubAccountId`, `SubAccountName` | **15,000** sub-accounts (AWS accounts / Azure subscriptions / GCP projects), assigned to billing accounts with a heavy-tailed share (the largest billing account holds ≈ 15 % of rows). Ids are drawn from a reserved synthetic range (D-04). |
| Business unit | `Tags` key `business-unit` | 12 business units spanning providers. An account has one business unit; the **analytics** layer derives it as the account's modal `business-unit` tag over the trailing 28 days of tagged spend, so tagging loss does not move an account between units. |
| Other tags | `Tags` keys `cost-center` (≈ 400 values), `env` (`prod`, `staging`, `dev`, `sandbox`), `app` | `env` drives weekly seasonality (§2.3); it is not emitted in `fleet15k`, where only `business-unit` and `cost-center` are. `cost-center` is the governed key used for tag-coverage detection. |
| Service | `ServiceName`, `ServiceCategory` | A catalogue of ≈ 60 synthetic service names per provider across FOCUS service categories (Compute, Storage, Databases, Networking, AI and Machine Learning, Analytics, Management and Governance, Security…). |
| Region | `RegionId`, `RegionName` | 70 % of services are regional; a regional account-service spends in 1 region with probability 0.65, more with a geometric tail capped at 6. |

**Account size** is heavy-tailed: monthly spend is log-normal with median
$800 and σ = 1.8 (log scale). In the sizing run (Appendix B) this gives a
fleet of ≈ $59 M per month, p99 account ≈ $50 k, largest ≈ $0.8 M; the top
1 % of accounts carry ≈ 29 % of spend and the top 10 % ≈ 69 %. Services per
account grow with size (`3 + 4·log10(1 + spend/100)` + noise): mean 7,
p99 15. Non-USD amounts use the same distribution in their own currency
(no FX model, D-10). **In `fleet15k`** the same accounts keep their top 2
services as individual series (top 4 for the largest 5 % of accounts by
spend) and sum the rest into one `Other services` series per account (≈ 3
series per account, ≈ 45 k in total); injected anomalies and new services
are always placed on individual series (§2.4).

### 2.3 Series model

Each leaf series (account × service × region) is generated as

`y(d) = L · g(d) · w(dow(d)) · m(d) · ε(d) + (injected effects)`

| Component | Model |
|---|---|
| Level `L` | From the account's size and the service's share of it (Dirichlet-like split, dominant service ≈ 40–60 %). |
| Trend `g(d)` | Compound monthly growth drawn per account, mean +2 %, sd 3 % (some accounts shrink). |
| Weekly seasonality `w` | By `env`: `prod` flat (weekend factor 0.95–1.0); `dev`/`sandbox` weekday-heavy (weekend 0.4–0.7); 5 % of accounts are weekend-batch (weekend 1.3–1.8). |
| Month-end batch `m(d)` | 5 % of accounts run month-end jobs (last two business days × 1.3). **Not an anomaly**; a weekly-only model will be challenged by it, and that cohort is reported separately (§4.9). |
| Noise `ε` | Multiplicative log-normal, σ from 3 % (large accounts) to 15 % (small). |
| Lifecycle | ≈ 600 accounts **onboard** during the span (S-curve ramp over 10–40 days) and ≈ 300 **offboard** (decay to zero over 7–30 days). Onboarding and offboarding are **expected**, not anomalies. |
| Commitments | ≈ 12 % of accounts (most large ones) hold commitments: a purchase row (`ChargeCategory=Purchase`, `ChargeFrequency=One-Time` or `Recurring`, `EffectiveCost=0` per FOCUS when it covers future charges), and covered usage rows with `PricingCategory=Committed`, `CommitmentDiscountId`, `CommitmentDiscountStatus=Used`, `BilledCost=0`, `EffectiveCost` = amortised rate; plus `Unused` rows. A new commitment lowers effective cost from its start day (a *commitment effect*, §4.2). |
| Spot / dynamic | ≈ 8 % of compute series split a `PricingCategory=Dynamic` row. |
| Credits | `ChargeCategory=Credit`, negative, `EffectiveCost = BilledCost` (FOCUS), mostly on the last or first day of a month (≈ 15 % of accounts per month). |
| Tax | `ChargeCategory=Tax`, `PricingCategory` null (FOCUS), once per account per month. |
| Recurring fees | Support-plan style `Purchase`/`Recurring` rows on day 1 of each month. |
| Corrections | `ChargeClass=Correction` rows restating an earlier period, in a later period (≈ 100 over the span). |
| Untagged remainder | 30 % of account-services carry an untagged remainder row (`cost-center` missing), so tag coverage is realistic, not 100 %. |

### 2.4 FOCUS rows and the grain

**Grain (decided, D-01), per profile.** FOCUS rows are already aggregated
to the day and to the series, with `ChargePeriodStart/End` = the UTC day.
Non-usage rows (purchase, tax, credit, recurring fee, correction) are added
at their natural frequency.

| Profile | Usage-row grain | Columns |
|---|---|---|
| `ci`, `full` | account × service × region × (pricing / tag split) × day | the existing fixture's `COLUMNS` set |
| `fleet15k` | **account × service × day**: no region, pricing or tag split; a series switches wholly (e.g. to `Committed`, or loses its tag) rather than splitting | **minimal**: the worker's five required columns (`BilledCost`, `BillingCurrency`, `ChargePeriodStart`, `ChargePeriodEnd`, `BillingPeriodStart`) plus what detection needs: `EffectiveCost`, `ProviderName`, `BillingAccountId`, `SubAccountId`, `ServiceName`, `ServiceCategory`, `ChargeCategory`, `ChargeClass` (corrections only), `ChargeFrequency`, `PricingCategory` (committed rows only), `ResourceId` (injected runaway resources only), `Tags` (`business-unit`, `cost-center` only). Measured `extra_columns`: ≈ 100 B per row (Appendix B.5). |

In `fleet15k` an injected runaway resource is the one exception to "no
split": it is emitted as its own row with `ResourceId` for its window
(≈ 100 labels × ≤ 20 days: negligible rows).

Why not charge level: at a realistic 25 resources per series, resource ×
hourly rows over 13 months would be **≈ 35 billion rows**, and resource ×
daily **≈ 1.45 billion** (Appendix B). Neither fits a local Postgres 16, and
neither is needed: the reference tools evaluate daily series too (AWS daily
spend per monitor value; Azure daily per subscription; Vantage daily per
report series [A4, A10, A17]).

**Deliberate deviations from a real export** (written into the generator's
README and the dataset manifest):

- **Resource ids.** `ResourceId` is set only for a few *named* resources per
  account (and for every injected runaway resource); the remaining series
  cost is one row with `ResourceId` empty. A real export has one row per
  resource.
- **Provider fidelity.** Rows are FOCUS-shaped for three provider *styles*;
  they are not copies of any provider's real export (service names,
  SKU ids and usage types are invented).
- **Lean extra columns.** Only the FOCUS columns these slices use are
  populated (the existing fixture's `COLUMNS` set); others are empty, so
  `extra_columns` stays small (target ≤ 0.6 KB per stored row, vs 1.03 KB
  measured on the public sample in Slice 2b).
- **Commitment amortisation** follows the FOCUS 1.0 column rules above; the
  generator's exact unused-commitment representation is checked against the
  spec's commitment examples in PR 3-1 (**unverified until then**).

### 2.5 Ground truth: injected anomalies and billing artefacts

Injected deterministically from the seed, in every profile, with the same
rates per account-month. Counts below are for `full` (15,000 accounts, 13
periods); `fleet15k` has the same rates over 4 periods, i.e. ≈ 4/13 of each
count (≈ 90 spikes, ≈ 45 level shifts …), **without `new_region`** (it has
no region dimension) and with whole-series `tagging_loss` and
`commitment_effect` (no tag or pricing split). At natural rates the
`fleet15k` evaluation window (days 57–122) would hold only ≈ 12–25
meaningful labels per main kind, too few for a recall target; so
`fleet15k` **enriches** the evaluation window to **≥ 60 meaningful labels
per main kind** (spike, level shift, drift, new service, runaway resource,
shared cause), and its alert-volume target is stated on false-positive
groups (§4.9). The full catalogue, label format and matching rules are in
Appendix C.

| Kind | Label | What is injected | ≈ count |
|---|---|---|---|
| `spike` | alert | 1–3 days × (1.5–6) on one leaf series | 300 |
| `level_shift` | alert | permanent step +20 % … +200 % from day d | 150 |
| `gradual_drift` | alert | extra linear slope reaching +30 % … +150 % over 14–45 days | 100 |
| `new_service` | alert | a service never used by the account starts with meaningful spend | 150 |
| `new_region` | alert | an existing account-service starts spending in a new region | 100 |
| `runaway_resource` | alert | one named resource grows daily (linear or ×1.1–1.4/day) for 5–20 days, then is "fixed" | 100 |
| `tagging_loss` | alert (governance) | ≥ 50 % of an account's spend loses `cost-center` from day d; **total spend unchanged** | 80 |
| `spend_drop` | alert (info by default, D-14) | −40 % … −90 % unexpected drop | 60 |
| `shared_cause` | alert (**one** group) | the same spike or shift in one service across 5–20 accounts of a billing account on one day | 40 |
| `new_account_runaway` | alert | a newly onboarded account spends far above its cohort in its first 14 days | 20 |
| `month_end_credit` | **no alert** | Credit rows at month end | ≈ 2,250 per month |
| `commitment_purchase` | **no alert** | Purchase rows (one-time / recurring), EffectiveCost 0 | ≈ 150 |
| `commitment_effect` | **no alert** | covered usage moves to Committed pricing; effective cost **drops** | ≈ 150 |
| `tax`, `recurring_fee` | **no alert** | monthly rows | every account-month |
| `correction` | **no alert** | `ChargeClass=Correction` in a later period | ≈ 100 |
| `onboarding`, `offboarding` | **no alert** | ramps up / decays | ≈ 600 / 300 |
| `month_end_batch` | **no alert** (hard cohort) | regular month-end jobs | 5 % of accounts |

Impacts are drawn so that ≈ 50 % of `alert` events are clearly meaningful
(≥ 2 × the minimum impact of §4.4), ≈ 25 % near the threshold (0.5–2 ×) and
≈ 25 % below it. Recall is scored only on meaningful events (§4.8).

The generator also writes each series' **true parameters** (level, trend,
weekly factors, noise σ, lifecycle), so the evaluator can compute the
**oracle** expected value and report forecast skill against the irreducible
noise (§3.9).

### 2.6 Determinism

- **PRNG:** a counter-based integer generator keyed by `(seed, entity id,
  stream name)` (e.g. SplitMix-style, integer arithmetic only), so adding a
  new stream or a new account never shifts the draws of existing ones. The
  existing fixture's xorshift32 is reused only for the CI fixture
  compatibility check.
- **Arithmetic:** shapes use float64 with **only** `+ − × ÷` and `sqrt`
  (IEEE-754 correctly rounded, therefore identical everywhere). `exp`/`log`
  are not used at generation time: log-normal draws come from fixed
  integer-indexed tables generated once and committed with their SHA-256.
  **Money is integer** (BigInt units of 1e-10, as in
  `src/ingest/fixtures/syntheticFocus.ts`), quantised once per row, and
  printed with exactly 10 decimals. Control totals are BigInt sums.
- **Bytes:** gzip with header mtime 0 and a fixed level; file splits by row
  count; sorted object keys.
- **Golden digest:** the `ci` profile's manifest SHA-256 (over every object
  and the ground truth) is pinned in a test; any change to the generator's
  output is a reviewed change.

### 2.7 Output and delivery through the real path

```
generator --profile ci|fleet15k|full --seed <n> --out <dir>
  <dir>/export/<billing-account>/focus/<exportName>/data/BILLING_PERIOD=YYYY-MM/<runId>/part-00001.csv.gz …
  <dir>/export/<billing-account>/focus/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/<exportName>-Manifest.json
  <dir>/ground-truth/labels.jsonl, series-params.jsonl
  <dir>/dataset.json        (profile, seed, generator version, SHA-256 of every object, row counts, control totals)
local:synthetic …           (scripts/local, its own project and ports, like local:acceptance)
  up → migrate → PUT export/** into the source bucket
     → provision the tenant and 36 sources as the owner login (ingestion-ops SKILL §2), display names "SYNTHETIC …"
     → worker sync per source, N in parallel (separate processes; the per-source lease already makes this safe)
     → assert every period published + reconciled, totals == dataset.json, re-sync skipped_unchanged
```

- Manifests carry `x-ratio-control` (row count and billed total), so every
  batch must be `reconciled`, not `unverified`: the strongest check the
  worker has, at scale.
- Every period's rows have `BillingPeriodStart` equal to the folder's period
  (`PERIOD_MISMATCH` otherwise) and one currency.
- Files are split at ≤ 500 k rows; the largest batch is ≈ 0.9 M rows per
  month, under `RATIO_MAX_ROWS_PER_BATCH` (20 M) and the byte caps.
- An independent check for the `ci` and `fleet15k` profiles: the Python
  control calculator pattern of Slice 2b (stdlib only) recomputes
  per-period totals from the gzip objects, not from the generator's own
  sums.
- **Daily-delivery replay** (`ci` profile, one source, one month): the
  current month is delivered as 30 successive month-to-date exports (new
  execution id each day), so the worker's supersede-and-republish path and
  the analytics job's restatement handling (§4.7) run as they would on a
  live export. At `full` scale this replay would ingest ≈ 93 M extra rows
  for one month (≈ 21 M at `fleet15k` scale), so the large profiles
  simulate data availability in the analytics job instead (`--as-of`,
  §4.8).

### 2.8 Profiles, time span and sizing (decided: D-01, D-02, D-03)

Full model, measurements and arithmetic: Appendix B (B.5 for `fleet15k`).

| Profile | Accounts | Grain | Span | Series | Fact rows | Total disk (objects + facts + rollups + forecasts + indexes) | Single-worker load (20 k / 6 k rows/s) | Where it runs |
|---|---|---|---|---|---|---|---|---|
| `ci` | 150 | full (region, pricing and tag splits) | 4 periods (≈ 120 d) | ≈ 1.5 k | ≈ 0.24 M | < 0.3 GB | ≤ 1 min | CI, every PR |
| **`fleet15k`** | **15,000** | account × service × day; top 2 services per account individually (top 4 for the largest 5 %) + `Other services` | **4 periods (122 d)** | **≈ 45 k** | **≈ 5.65 M** | **≈ 5.2 GB** (≈ 5.0 GB once the generator's local copy is removed after a verified upload) | **5 / 16 min** | this container class (≈ 10 GB free, 4 CPU, 15 GB RAM) and on demand |
| `full` | 15,000 | full | 13 periods (395 d) | ≈ 147 k | ≈ 78.6 M | 60–95 GB | 65–218 min | **owner action**: a machine with ≥ 150 GB free (§8) |

**`fleet15k` per-row sizes are measured**, not assumed: on an ephemeral
PostgreSQL 16 container, 400 k rows of the `fleet15k` shape in a table with
`cost_facts`' exact columns and primary key take **554 B per row** in total
(heap 410 B, of which `extra_columns` 100 B, plus the primary-key index);
the narrow usage rollup takes **217 B per row** with its primary key
(Appendix B.5). The gzip size per row (≈ 20 B measured on a synthetic CSV,
**30 B assumed**) is an estimate; objects are counted three times
(generator output, source bucket, evidence bucket).

**The full service mix does not fit 6 GB.** With all ≈ 107 k account ×
service series, the same per-row costs give 11.4 GB for 4 periods, 8.5 GB
for 3 and 5.7 GB for 2; and 2 periods (61 days) leave no fully held-out
month after the 56 days that weekly seasonality needs. So `fleet15k` keeps
**all 15,000 accounts** and reduces the **service axis**: each account's
long tail of services is summed into one `Other services` series. This is
stated in the dataset manifest and the generator's README, together with
the other simplifications decided in D-01 (no region, pricing or tag
splits; Appendix B.5.5 lists everything `fleet15k` gives up). No account is
dropped.

**Why 4 periods for `fleet15k` (D-02).** With periods of 31, 30, 31 and 30
days (122 days):
- **weekly seasonality**: on the first day of period 3, the model has
  61 days of history (≥ 56, eight weeks);
- **month-end on day 1 and day 15 against fully held-out months**: periods
  3 **and** 4 (4 month-end origins);
- **rolling-origin backtest**: weekly origins from day 57; 6 origins for
  horizons up to 30 days, 9 for horizons up to 7 days;
- 3 periods (91 days) would meet the letter (one held-out month) but leave
  one or two origins at the 30-day horizon, too few to report a WAPE; 5
  periods would add one 90-day origin at ≈ 6.4 GB, over budget.

**Why 13 periods for `full`.** A training window of ≈ 6 months plus an
evaluation window of ≈ 6 months with weekly origins at the 30-day horizon,
≥ 3 origins at the 90-day horizon and ≥ 6 month-ends.

**What each profile can assess:**

| Capability or target | `ci` | `fleet15k` | `full` |
|---|---|---|---|
| All 15,000 accounts analysed, forecast and monitored (the owner's goal) | no (150) | **yes** | yes |
| Forecast FT-1, FT-2 (tenant month-end, day 1 / 15) | smoke only | yes (2 held-out months × 4 currencies: small n, reported with it) | yes (≥ 6 months) |
| FT-3 (billing-account month-end), FT-4, FT-5, FT-6, FT-7 (pooled coverage) | smoke only | yes | yes |
| FT-7 with per-series own quantiles (≥ 26 errors per bucket) | no | **no** (too few origins; cohort-pooled only) | yes |
| FT-8 (90-day horizon) | no | **no** (needs ≥ 146 days) | yes |
| FT-10 runtime at ≈ 107 k leaf series | no | **no** (≈ 45 k leaves; measured and scaled, not gated) | yes |
| Detection: spike, level shift, drift, new service, runaway resource, drop, shared cause, new-account runaway, billing-artefact suppression, month-end batch cohort | every kind ≥ 2 labels (smoke) | **yes**, with labels enriched in the evaluation window (≥ 60 meaningful per main kind; recall reported with Wilson intervals) | yes |
| **New region** (D4 at region level), region rows in root causes | **yes** | **no** (no region dimension) | yes |
| Tagging loss, commitment effect | yes (partial splits) | yes, coarser (whole-series switches) | yes |
| Alert volume per day (AT-4), time-to-detect (AT-3) | no | yes (66-day evaluation window) | yes (≈ 180 days) |
| Load time and D-06's 60-minute trigger | no | **yes** | yes |
| Storage at 78.6 M rows, D-09 at ≈ 6 M rows per month | no | no | yes |

**This container class** (measured by the orchestrator: ≈ 10 GB free disk,
4 CPUs, 15 GB RAM) runs `ci` and `fleet15k`; `full` needs the owner's
environment action. GitHub-hosted runners (assumption: ≈ 14 GB of free
SSD) run `ci` only.

### 2.9 Storage strategy

Three options were considered for making the facts (5.65 M in `fleet15k`, 78.6 M in `full`) queryable:

| Option | Verdict | Reason |
|---|---|---|
| **Materialised views** | **Rejected** | On PostgreSQL 16, `REFRESH MATERIALIZED VIEW` needs **ownership** (the grantable `MAINTAIN` privilege only arrived in PostgreSQL 17 [A21]); the job would have to be a `ratio_owner` member, which Slices 0–2 refuse. A materialised view also cannot be tenant-filtered by RLS, and cannot be refreshed incrementally. D-08 pins PG16. |
| **Partitioning `cost_facts`** | **Not now** | It would rewrite Slice 0's table (a contract-phase change touching triggers, FKs, the view and the foundation manifest). Facts are only read **once per published batch** by the rollup job, through the primary-key prefix `(tenant_id, batch_id)`, so partition pruning buys little. Revisit trigger: a real tenant whose monthly batches exceed tens of millions of rows. |
| **Daily rollup tables, written by a least-privilege job** | **Recommended (D-05)** | Plain tables in schema `ratio`, FORCE RLS, composite tenant FKs, `numeric` only (Slice 0 invariants), filled by `INSERT … SELECT … FROM ratio.cost_facts_published WHERE batch_id = $1 GROUP BY …` once per newly published batch. |

Rollup design (schema sketch in Appendix D):

- `cost_series`: one row per (currency, provider, billing account,
  sub-account, service, region) with first/last day seen; ≈ 45 k rows in
  `fleet15k` (region empty), ≈ 147 k in `full`.
- `cost_daily` (**narrow**, usage only): one row per (series, UTC charge
  day, **publishing batch**) with five measures (usage-based effective cost,
  billed total, effective total, committed effective, untagged usage
  effective) and a row count; primary key `(tenant_id, series_id,
  usage_date, batch_id)` and no other btree. **Measured: 217 B per row**
  including the key (a wider 13-measure variant with a second btree and a
  BRIN measured 317 B; Appendix B.5). ≈ 5.5 M rows / ≈ 1.2 GB in
  `fleet15k`; ≈ 58 M rows / ≈ 12.6 GB in `full`.
- `billing_daily` (**sparse**): non-usage amounts (recurring, one-time,
  credit, tax, adjustment, correction) per (account, day, category), only
  where non-zero: ≈ 38 k rows per month for 15,000 accounts. Keeping these
  out of `cost_daily` is what lets the usage rollup stay narrow.
- `cost_resource_daily`: resource-level rows only above a floor
  ($25/day equivalent), for root cause.
- `cost_daily_scope`: precomputed daily totals for the API's aggregate
  scopes (tenant, billing account, business unit, provider, service; per
  currency): ≈ 2–5 k scopes × the span's days (≤ 0.15 GB in `fleet15k`).
- **Rollups are versioned by batch**, so they are append-only like facts:
  the read side joins the current publication (§6.2), a restated period
  gets new rollup rows, and the superseded batch's rollup rows become
  unreachable. Removing those unreachable rows is D-12.
- **No partitioning of the rollups initially:** the primary key serves the
  job's per-series scans and the API's narrow reads; a BRIN on
  `usage_date` (rows arrive roughly in date order per batch) is added only
  if a measured query needs it. Runtime partition creation would need
  DDL rights or a reviewed `SECURITY DEFINER` function, which the privilege
  model deliberately does not have. Revisit if the §5.3 latency SLOs are
  missed.
- **Charge day:** the UTC date of `ChargePeriodStart` (the worker reads
  timestamps as UTC). A row spanning more than one day (monthly fees) is
  attributed to its start day; such rows are outside the monitored measure
  anyway (§4.1).

### 2.10 Slice 3 performance targets

| Target | `ci` | `fleet15k` (this container class) | `full` (owner's machine) |
|---|---|---|---|
| Generation (single process, streaming, bounded memory) | ≤ 10 s | ≤ 5 min, peak RSS ≤ 1 GB | ≤ 30 min, peak RSS ≤ 1 GB |
| Upload to local S3 | ≤ 10 s | ≤ 3 min | ≤ 20 min |
| Worker load, all sources | ≤ 60 s | **measured**; estimate 5–16 min single worker; **> 60 min triggers the D-06 review** | measured; ≤ 90 min wall with 4 parallel sources |
| Re-sync (all `skipped_unchanged`) | ≤ 15 s | ≤ 1 min | ≤ 2 min |
| Stored bytes per fact row | ≤ 0.6 KB | ≤ 0.56 KB (554 B measured) | ≤ 0.6 KB |
| Total disk (objects + facts + rollups + forecasts + indexes) | < 0.3 GB | **≤ 5.5 GB** (≈ 5.2 GB estimated; hard ceiling 6 GB) | ≤ 100 GB |
| End-to-end CI step (stack, load, rollup, forecast, detect, evaluate) | ≤ 120 s | n/a | n/a |

### 2.11 Local stack implications

- `local:synthetic` follows `local:acceptance`: its own project and ports,
  the preflight that refuses existing state, every step under a hard
  deadline, `down -v` always, pass/fail in one place.
- **SeaweedFS capacity** (F3, tracked in §9): the default local settings
  give ≈ 4 GiB (assumption: volumes × size limit). `fleet15k` needs
  ≈ 0.34 GB in the two buckets, so it should fit; PR 3-4 measures it and
  adds a compose override only if needed. `full` needs ≈ 11 GB and does
  need the override (`deployment` class, restricted).
- **WAL inside the 6 GB budget:** the `fleet15k` stack runs Postgres with a
  bounded `max_wal_size` (e.g. 256 MB) so that write-ahead log does not eat
  the headroom; same override PR.
- The worker's default `RATIO_MAX_RUN_SECONDS` (6 h) already covers the
  largest source in every profile.
- CI gains one step (the `ci` profile) after `local:acceptance`; the job's
  10-minute timeout keeps headroom (measured job time on main ≈ 275 s before
  Slice 2b's step).

## 3. Slice 4 — Forecasting

### 3.1 What is forecast

**Measures** (per currency; never summed across currencies, D-10):

- **Monitored cost** `M` = Σ `EffectiveCost` over rows with
  `ChargeFrequency = 'Usage-Based'` and `ChargeClass` null: amortised,
  usage-driven spend. It excludes purchases, recurring fees, credits, tax,
  adjustments and corrections **by definition** (D-09). This is what the
  daily forecast and the anomaly detector use.
- **Billed month-end** `B` = month-to-date `BilledCost` (all categories) +
  forecast usage-based *billed* cost for the remaining days + the last
  month's recurring fees on their day + tax at the last closed month's
  tax-to-pre-tax ratio. Credits and one-time purchases are **not**
  forecast (they are unknowable from history); the API states that.

**Scopes.** Leaf = **account × service** (≈ 107 k series; regions are summed,
region-level novelty is a detector, §4.2). Roll-ups: sub-account, business
unit, billing account, provider, service (fleet-wide), tenant; each per
currency.

**Outputs per scope:** expected daily `M` for the next 90 days with 80 % and
95 % intervals; expected `M` and `B` for the current month (month-end) and
the next 30 and 90 days, with intervals; method, history length and the
cold-start flag.

### 3.2 Method ladder

Simple and explainable first. Each leaf series is fitted with every eligible
model on its own history; the model with the lowest backtest WAPE on that
series' last 8 weekly origins is selected (the `selectSource` rule of
`src/prediction`, applied to models), ties going to the simpler model.

| Model | When eligible | Why |
|---|---|---|
| **M0 seasonal-naive mean**: the mean of the same weekday over the last 4 weeks | ≥ 14 days | The baseline every other model must beat; robust, obvious to explain. |
| **M1 Holt-Winters, additive weekly seasonality, damped additive trend** (ETS(A,Ad,A) family) | ≥ 56 days | Captures level, growth that flattens, and day-of-week pattern; the damped trend keeps 90-day forecasts from running away. Parameters (α, β, γ, φ) by grid search over a small fixed grid (e.g. 6 × 4 × 4 × 3) minimising one-step SSE on outlier-cleaned data: deterministic, no optimiser dependency. |
| **M1-log**: M1 on `log1p(y)` (multiplicative seasonality) | ≥ 56 days, no zero days in the last 28 | For series whose weekend dip scales with level; back-transformed with the variance correction; points still summed bottom-up. |

Explicitly not in this slice: ARIMA, Prophet-style regressors,
gradient-boosted or neural models, annual seasonality. The fpp3 textbook
[A22] treats seasonal-naive and ETS as the reference simple methods; the
ladder can grow later behind the same backtest gate.

### 3.3 Robustness to outliers

Anomalies in the training data must not teach the model that spikes are
normal:

1. **Hampel cleaning before fitting:** a day is replaced by its
   weekday-adjusted rolling median when it lies more than 4 scaled MADs
   (MAD × 1.4826) from it, over a 28-day window.
2. **Open anomalies are masked:** days inside an open, non-resolved anomaly
   (§4.6) are replaced the same way, so a level shift is learnt only once it
   is confirmed as the new normal (the anomaly resolves as `new_baseline`
   after 14 days, §4.6).
3. **Grid search on cleaned data, residual quantiles on raw data:** the
   intervals stay honest about real volatility.

### 3.4 Prediction intervals

Empirical, per horizon, calibrated by backtest (the same idea as
`src/prediction`'s band from historical error, and as the conformal-style
approach in [A22]):

- For each leaf series and horizon bucket h ∈ {1, 2–7, 8–14, 15–30, 31–60,
  61–90}, collect the h-step backtest errors scaled by the series level.
- Series with ≥ 26 errors in a bucket use their own quantiles; others use the
  **pooled** quantiles of their cohort (provider × service category × size
  decile × `env`).
- 80 % and 95 % intervals = point + level × (q₀.₁, q₀.₉) and (q₀.₀₂₅,
  q₀.₉₇₅); lower bounds are floored at 0 for `M` (spend cannot be negative;
  credits are outside `M`).
- Monthly and 30/90-day totals: intervals come from backtest errors **of the
  totals themselves**, not from summing daily bounds (daily errors are
  correlated).

### 3.5 Cold start

| History of the series | Point | Interval | Flag |
|---|---|---|---|
| 0 days | none (no forecast, like AWS) | — | `no_history` |
| 1–13 days | mean of the available days, with the account's weekday profile if the account is older | cohort pooled quantiles × 1.5 | `estimated` |
| 14–55 days | M0 | cohort pooled | `estimated` |
| ≥ 56 days | ladder (§3.2) | own or pooled | `fitted` |

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
- The current month is usually **provisional** in a real export (the
  worker's `is_provisional`); the forecast reports the provisional state of
  the batches it used.

### 3.8 Backtesting protocol (rolling origin)

- **Origins:** every 7 days through the evaluation window (the last ≈ 6
  months of the span) for horizons 1–30; the first day of each month whose
  next 90 days are inside the data for the 90-day horizon (≥ 3 origins); day
  1 and day 15 of each evaluation month for month-end (≥ 12 origins).
- **No leakage:** at an origin `t`, fitting, cleaning, model selection and
  interval quantiles use data with charge day < `t` only; the generator's
  labels and true parameters are never visible to the job.
- **Two scorings:** *all days*, and *clean days* (excluding ground-truth
  anomaly windows, for forecast accuracy as such).
- **Baselines scored on the same origins:** M0, and the existing
  `projectMonthlySpend` weighted-7-day method for month-end.
- **Two implementations of every metric:** the TypeScript backtest computes
  them; an independent Python (stdlib only) evaluator recomputes them from
  the API's forecast output and the published actuals, and the two must
  agree exactly on the inputs and within 1e-9 on the metrics (Slice 2b's
  "different language, different code path" rule).

### 3.9 Metrics

| Metric | Definition | Where used |
|---|---|---|
| **WAPE** | Σ\|y − ŷ\| / Σ\|y\| over series and days in a slice | primary, at every level; spend-weighted by construction |
| **MAPE** | mean \|y − ŷ\| / \|y\| | only for series with no zero day and ≥ $10/day (otherwise undefined or dominated by tiny series) |
| **APE of totals** | \|Y − Ŷ\| / \|Y\| for month-end and 30/90-day totals | per scope and origin; reported as median and max |
| **Interval coverage** | share of actuals inside the 80 % / 95 % interval | per level and horizon bucket |
| **Interval width** | mean (hi − lo) / ŷ | so coverage is not bought with useless width |
| **Skill vs baseline** | 1 − WAPE(model) / WAPE(M0) | per level |
| **Skill vs oracle** | WAPE(model) − WAPE(oracle), oracle = the generator's true expectation | synthetic only; shows how close the model is to irreducible noise |

### 3.10 Acceptance targets (evaluation window, clean days unless noted)

The gating profile is **`fleet15k`** (all 15,000 accounts) wherever it can
assess the target; `full` gates what `fleet15k` cannot (§2.8), when the
owner's environment exists. In `fleet15k`, `Other services` leaves are
scored with the others and also reported separately.

| # | Target | Assessed on | Reference point |
|---|---|---|---|
| FT-1 | Month-end forecast of each currency's tenant total, made on **day 1**: median APE ≤ **5 %**, max ≤ 12 % | `fleet15k` (8 points: 2 held-out months × 4 currencies, reported with n), `full` | FinOps Foundation variance guidance: ≤ 12 % at Run [A16]. Synthetic data is cleaner than real data, hence the stricter median. |
| FT-2 | Same, made on **day 15**: median APE ≤ 3 % | `fleet15k`, `full` | — |
| FT-3 | Billing-account month-end (day 1): median APE ≤ 10 % | `fleet15k` (72 points), `full` | FinOps Run 12 % |
| FT-4 | Leaf (account × service) daily WAPE, horizons 1–30: ≤ **20 %** for series with ≥ 56 days of history | `fleet15k` (6 origins), `full` | no vendor publishes one (Appendix A) |
| FT-5 | Leaf skill vs M0 ≥ **10 %** (WAPE at least 10 % lower) | `fleet15k`, `full` | our baseline |
| FT-6 | Month-end WAPE not worse than the existing weighted-7-day method at any level, and ≥ 20 % better at tenant level | `fleet15k`, `full` | `src/lib/forecast.ts` |
| FT-7 | 80 % interval coverage in **[75 %, 85 %]**, 95 % coverage in [92 %, 97.5 %], pooled per level and horizon bucket | `fleet15k` (cohort-pooled quantiles); `full` (also per-series quantiles) | AWS publishes an 80 % interval, not its coverage [A1] |
| FT-8 | 90-day total at billing-account level: median APE ≤ 15 % | **`full` only** | — |
| FT-9 | All days (anomalies included): reported, not gated | all | shows contamination effect |
| FT-10 | Fit + forecast for all scopes ≤ **15 min** wall, ≤ 4 GB RSS; backtest ≤ 60 min | `fleet15k` (≈ 45 k leaves, this container class: 4 CPU, 15 GB); `full` (≈ 107 k leaves, owner's machine) | — |

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

**Floats stay inside the model.** Inputs are read as decimal strings and
converted to float64 only inside `src/analytics/model/**`; outputs are
rounded to 6 decimal places and written as `numeric` text. Anomaly impact
`actual − expected` is computed in SQL on the stored `numeric` expected
value. A lint/import-boundary test keeps float-producing modules out of the
rollup and API paths. Slice 0's catalogue scan (no float columns) keeps
holding: forecast tables are `numeric`.

**Privilege model.** The job runs as a login that is a member of a new
NOLOGIN role `ratio_analytics` only, and checks its own login at start-up
like the worker and the reader do (§6.1). It reads the published view and
the published-batch catalogue view; it writes only analytics tables.

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

The detector watches `M` (§3.1): usage-based, amortised, corrections
excluded. As a result, **by construction**:

| Artefact | Why it cannot alert on `M` |
|---|---|
| Month-end credits | `ChargeCategory=Credit` is not usage-based |
| Commitment purchase (one-time or recurring) | `Purchase` rows are not usage-based; FOCUS sets their `EffectiveCost` to 0 when they cover future charges |
| Tax | `Tax` rows are not usage-based |
| Recurring fees on day 1 | `ChargeFrequency=Recurring` |
| Corrections of earlier periods | `ChargeClass=Correction` |

What **can** still move `M` without being an anomaly, and how it is handled:

- **Commitment effect** (covered usage gets cheaper): a *drop* whose start
  day coincides with a rise of ≥ 20 percentage points in the series'
  committed share of effective cost is classified `commitment_effect`,
  severity `info`, and suppressed from notifications.
- **Onboarding / offboarding:** a new account's ramp is in warm-up (§4.2
  D6); an account whose usage decays to zero over ≥ 7 days produces `drop`
  candidates that stay `info` by default (D-14).
- **Month-end batch cohort:** not suppressed; measured as a known-hard cohort
  (§4.9). A day-of-month regressor is the recorded improvement.

Billing artefacts on `B` (credits, purchases, tax) are visible in the
month-end forecast and in the daily cost API; they are never anomalies.

### 4.2 Detectors

Each runs daily for as-of day `D` on every leaf series (account × service),
using data with charge day ≤ `D − 1` (the last published day).

| Id | Detector | Fires when | Targets |
|---|---|---|---|
| D1 | **Residual vs interval** | `y > hi₉₉` (one-sided 99 % empirical quantile for h = 1) or `y < lo₉₉` | spikes, drops, runaway onset |
| D2 | **Robust z (MAD)** | `z = (y − median₂₈ʷ) / (1.4826 · MAD₂₈ʷ)`, weekday-adjusted, `\|z\| ≥ 4` | spikes when the model is mis-fit; independent of the model |
| D3 | **CUSUM** on standardised one-step residuals | `S⁺ₜ = max(0, S⁺ₜ₋₁ + zₜ − k)` exceeds `h` (two-sided; k = 0.5, h = 5 as a starting point, tuned on the `fleet15k` tuning seed) | level shifts, gradual drift, runaway growth |
| D4 | **New dimension** | a (account, service) or (account, service, region) first seen with `M ≥` minimum impact on its first or any of its first 3 days, in an account older than 30 days | new service, new region |
| D5 | **Tag coverage** | the account's untagged share of `M` (governed key `cost-center`) rises ≥ 20 pp vs its trailing 28-day median and the untagged amount ≥ minimum impact | tagging loss (category `tagging`, not a spend anomaly) |
| D6 | **Cold-start guardrail** | in an account's first 14 days, daily `M` above the 99th percentile of its cohort's day-k spend **and** ≥ 10 × minimum impact | runaway in a new account (AWS needs 10 days, Vantage > 12 days [A6, A17]) |

**Combination:** a leaf-day is a candidate if (D1 **and** D2), or D3, or D4,
or D5, or D6. Requiring D1 and D2 together for one-day deviations trades a
little recall for a large cut in false positives; it is tuned on `fleet15k`
generated with a **tuning seed** and frozen before the evaluation, which
uses a **different seed** (and `full` when available). Aggregate scopes (billing account,
business unit, provider, tenant) run D1–D3 on their own bottom-up forecast
too (§4.5).

### 4.3 Daily state

Holt-Winters updates are O(1) per series per day, so the as-of replay over
the evaluation window (≈ 66 days × ≈ 45 k series in `fleet15k`; ≈ 180
days × ≈ 107 k series in `full`) is at most a few tens of millions of
updates: seconds to minutes in TypeScript. Parameters are refit
weekly; states and CUSUM sums are carried daily.

### 4.4 Impact and severity

- **Impact** of an anomaly = Σ over its days of `(actual − expected)` in the
  billing currency (positive for increases), computed in SQL; **relative
  deviation** = impact / Σ expected over the same days.
- **Minimum impact** per currency (D-13 defaults): USD 100, EUR 100, GBP 100,
  JPY 15,000 per day, configurable per tenant and per billing account.
  (AWS's getting-started default summary is above $100 and 40 %; Vantage
  floors at $5 and 0.5 % of the report total [A7, A17].)

| Severity | Rule (per day, unless "cumulative") | Notified (once D-17 exists) |
|---|---|---|
| `critical` | impact ≥ 10 × min **and** relative ≥ 50 %, or cumulative ≥ 50 × min | yes |
| `warning` | impact ≥ min **and** relative ≥ 20 % | yes |
| `info` | flagged but below `warning`; all `drop` and `commitment_effect` by default | no; visible with `severity=info` |

Severity is re-evaluated each day the anomaly persists and only goes **up**
automatically.

### 4.5 Grouping, deduplication and root cause

Goal: **one root cause, one alert group.**

1. **Persistence:** a candidate on the same leaf and category within 3 days
   of an open anomaly's last day extends it (new day appended, no new
   alert).
2. **Fan-in across accounts (shared cause):** candidates of the same service
   (and category) in ≥ 5 accounts of one billing account, or covering ≥ 50 %
   of that service's spend there, starting within ±1 day, form **one** group
   at scope (billing account, service). Example: a platform-wide price or
   usage change.
3. **Fan-in across services (one account):** ≥ 3 services of one account
   starting within ±1 day form one group at scope (account).
4. **Aggregate-only anomalies:** an aggregate-scope candidate (§4.2) whose
   excess is ≥ 80 % explained by leaf candidates already grouped is
   suppressed; otherwise it becomes its own group (many small movements
   adding up), with its top contributors as root causes.
5. **Root causes:** up to **10** contributors ranked by excess $ over the
   group's days, from leaf `M`, region rows (`cost_daily`) and resource rows
   (`cost_resource_daily`), each with its amount and share (AWS ranks up to
   10 root causes over service × account × region × usage type [A8]).
6. **Dedup key:** (tenant, scope kind, scope key, category, first day). A
   group that resolved more than 7 days ago is not reopened; a new group is
   created.

### 4.6 Lifecycle and the `CostFinding` mapping

**States:** `open → acknowledged → resolved` (the existing `FindingStatus`),
with a reason on every transition, recorded in an append-only events table:

| Transition | By | Reason codes |
|---|---|---|
| → `open` | job | `detected` |
| `open`/`acknowledged` → `resolved` | job | `auto_recovered` (3 consecutive days back inside the 80 % interval), `new_baseline` (a level shift persisting 14 days is accepted as the new normal), `restated` (§4.7) |
| `open` → `acknowledged`, → `resolved` | a person, through the API | **Deferred (D-15, decided):** no write endpoint until per-user identity exists. Reason codes reserved for then: `acknowledged`, `expected`, `fixed`, `not_an_anomaly`. Until then, detection opens findings automatically and the job resolves them when the anomaly ends (rows above). |

**Mapping onto `CostFinding`** (`src/costsource/CostSourceClient.ts`), via a
new `ratio-native` source behind the CostSource seam:

| `CostFinding` field | Native anomaly |
|---|---|
| `id` | `ratio-native:anomaly:<uuid>` |
| `sourceId` | `ratio-native` |
| `type` | `'anomaly'` |
| `category` | `spend_spike`, `level_shift`, `gradual_drift`, `new_service`, `new_region`, `runaway_resource`, `tagging_loss`, `spend_drop`, `commitment_effect` (`spend_spike` is the seed's existing value) |
| `title` | generated, e.g. "SyntheticAWS · acct 9990… · Object Storage: +$2,140/day (+180 %) since 2026-05-12" |
| `resourceId` | top root-cause resource id if any, else the scope key (`account:<id>/service:<name>`) |
| `workloadId` | `null` (fleet accounts are not Ratio workloads) |
| `estimatedMonthlySavings` | `0` |
| `observedSpendDelta` | cumulative impact, rounded to 2 decimals (a display number; the decimal string stays in the native API) |
| `severity`, `status` | same vocabulary (`info / warning / critical`, `open / acknowledged / resolved`) |
| `detectedAt` | first detection time (ISO 8601) |

**Gap in the type:** `CostFinding` has no currency, no decimal amount and no
scope. D-18 recommends **additive optional fields** (`currency?`,
`impact?` as a decimal string, `scope?`, `firstDay?`, `lastDay?`,
`expected?`, `actual?`) so the PointFive mapping is unchanged.

### 4.7 Restatements

Each anomaly records the batch ids its evidence came from
(`basis_batch_ids`). When a period is republished, the rollups of the new
batch replace the old ones on the read side, and the next detection run
re-evaluates the affected days: an anomaly whose excess no longer holds is
resolved with reason `restated`; one that still holds is updated and keeps
its id. The daily-delivery replay (§2.7) exercises this.

### 4.8 Evaluation against ground truth

The evaluator (Python, stdlib) reads `labels.jsonl` and the anomalies the
**API** returns for an as-of replay over the evaluation window
(`ratio-analytics detect --replay --from … --to …`, each day using only data
with charge day ≤ D − 1).

- **Match:** an alert group matches a label when the tenant and currency
  agree, the label's entity is the group's scope **or** one of its listed
  root causes (so a correct fan-in group matches every label it explains),
  and the group's first detection day is within
  `[label.start, label.end + 3 days]`.
- **Precision** = matched groups ÷ all groups at severity ≥ `warning`. A group
  matching a sub-threshold label counts as correct (the event was real).
  A group matching a `no_alert` label counts as **false**.
- **Recall** = meaningful `alert` labels matched by a group of severity
  ≥ `warning` ÷ meaningful `alert` labels, per kind. (`spend_drop` is scored
  at ≥ `info`, D-14.)
- **Time-to-detect** = first detection day − label start day, in days, with
  data available one day after the charge day. Drift is also scored as
  "days after cumulative impact crossed the minimum impact".
- **Alert volume** = new groups per day at ≥ `warning` (mean, p95, max), and
  per 1,000 accounts.
- **Suppression check:** every `no_alert` label kind must have 0 matching
  groups at ≥ `warning`.

### 4.9 Acceptance targets (evaluation window)

`fleet15k` gates every target it can assess (§2.8); `new_region` and the
natural-rate alert volume are gated on `ci` (smoke) and `full`. Because
`fleet15k` enriches its evaluation window with labels (§2.5), its precision
is **re-weighted to natural label rates** before it is compared with AT-1
(true groups scaled by natural ÷ enriched rate per kind; false groups
unchanged), and its alert-volume target is stated on false-positive groups,
which enrichment does not change.

| # | Target | Assessed on |
|---|---|---|
| AT-1 | Precision ≥ **0.80** overall at ≥ `warning` (re-weighted on `fleet15k`), reported per kind | `fleet15k`, `full` |
| AT-2 | Recall ≥ **0.90** on meaningful `spike`, `level_shift`, `new_service`, `runaway_resource` (and `new_region` on `full`); ≥ **0.75** on `gradual_drift`, `tagging_loss`, `new_account_runaway`; Wilson 95 % interval reported with each | `fleet15k`; `new_region` on `ci` (smoke) and `full` |
| AT-3 | Median time-to-detect ≤ **1 day** after data availability for spikes, level shifts, new service/region, runaway; p90 ≤ 3 days; drift: median ≤ 7 days after crossing the minimum impact | `fleet15k`, `full` |
| AT-4 | Natural rates: mean ≤ **5** new groups per day fleet-wide at ≥ `warning` (≈ 0.33 per 1,000 accounts), p95 day ≤ 15. Equivalent on `fleet15k`: mean ≤ **1.0** false-positive group per day (5 × (1 − 0.80)), p95 day ≤ 3 | `full`; `fleet15k` (false-positive form) |
| AT-5 | **Zero** `warning`+ groups on credit, purchase, tax, recurring-fee, correction, onboarding and commitment-effect labels | `fleet15k`, `full` |
| AT-6 | One group per shared-cause event: fan-in labels (Appendix C) produce exactly 1 group, not N | `fleet15k`, `full` |
| AT-7 | Month-end-batch cohort: false positives reported, not gated (known limitation of a weekly-only model) | all |
| AT-8 | Daily detection run ≤ **5 min**; as-of replay of the evaluation window ≤ 60 min | `fleet15k` (this container class), `full` |

For comparison: none of the reference vendors publishes precision, recall or
alert-volume figures (Appendix A). AWS's 24-hour data latency and Azure's
36-hour run delay [A5, A10] put AT-3 in the same range as their
detection latency on a daily source.

## 5. API and UI surface

### 5.1 Endpoints (all GET unless noted; all under `/api/v1/`)

| Endpoint | Returns | Reads (definer views, §6.2) |
|---|---|---|
| `costs/daily?scope=…&groupBy=…&from=&to=&currency=&cursor=&limit=` | daily `M`, billed and effective totals per group; `groupBy` ∈ billingAccount, subAccount, businessUnit, provider, service, region, chargeCategory | `cost_daily_published`, `cost_daily_scope_published` |
| `forecasts?scope=&key=&currency=` | daily expected + 80/95 % intervals (90 days), month-end, next 30/90 days, method, cold-start flag, as-of and last published day | `forecasts_current` |
| `forecasts/accuracy?level=&horizon=` | the latest backtest report (§3.9) | `forecast_backtests_current` |
| `anomalies?status=&severity=&category=&scope=&from=&to=&cursor=&limit=` | anomaly groups (decimal strings), keyset by `(first_day desc, id)` | `anomalies_current` |
| `anomalies/{id}` | group + daily expected / actual / interval + root causes + transitions | same |
| `freshness` | per source and period: published batch, published at, provisional flag, reconciliation | `publications_published` |
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
| `ratio_owner` (existing) | owns everything | — (migration only) |
| `ratio_worker` (existing) | unchanged | read or write analytics tables |
| `ratio_reader` (existing, **widened** by SELECT on the new definer views only, D-08) | read published facts and published analytics views | any base table, any write |
| **`ratio_analytics`** (new) | SELECT on `cost_facts_published` and `publications_published`; SELECT/INSERT on analytics tables; column-level UPDATE on lifecycle columns, run status and pointers; removal of rollup rows of superseded batches and of forecast state older than the last 2 runs (D-12, decided; restricted) | any ingestion base table (`cost_facts`, batches, artifacts, …), any reader view write, DDL, role membership |
| `ratio_triage` (**deferred** with the write endpoint, D-15) | — not created in Slices 3–5 | — |

Every login is checked at start-up / per request, reusing Slice 1's
`inspectRole` + `roleProblems` and Slice 0's `REFUSED_PREDEFINED_ROLES`:
refused if it is superuser or BYPASSRLS, can reach a privileged or refused
predefined role, is a member of `ratio_owner`, or can reach another ratio
role it should not (analytics ↛ worker, reader, owner; reader ↛ worker,
analytics, triage). The tenant is set with `withTenantTransaction`
(transaction-local, bound parameter). One analytics run = one tenant
(`--tenant <uuid>`).

### 6.2 Migrations and their effect on Slice 0

The first migrations after 0001, each `expand`, each with its generated
foundation manifest and catalogue check:

| Migration | Adds |
|---|---|
| **0002** | role `ratio_analytics` (DO block marked `ratio:allow-do`, same RT010-style guard as 0001); definer view `publications_published` (published batches' metadata only: source, period, batch, published at, row count, loaded billed total, reconciliation, provisional); `analytics_runs`, `cost_series`, `cost_daily`, `cost_resource_daily`, `cost_daily_scope`, `account_dim`; reader views over them joined to the current publication |
| **0003** | `forecast_runs_current` pointer, `forecast_state` (leaf), `forecast_points` (aggregate scopes), `forecast_totals` (month-end, 30/90), `forecast_backtests`; reader views |
| **0004** | `anomalies`, `anomaly_days`, `anomaly_root_causes`, `anomaly_events` (append-only), optional `ratio_triage`; reader views |

Consequences that need approval (D-07):

- `privilegeModel.ts`: `RATIO_ROLES`, `CheckedRole` and
  `REVIEWED_PRIVILEGES` gain the new roles; the reader's reviewed set widens
  by the new views. `REVIEWED_TRIGGERS` unchanged (no new triggers planned).
- `scripts/local/bootstrap.mjs` pre-creates the new NOLOGIN role(s) and a
  `ratio_local_analytics` login (D-04 model: the migrator stays NOCREATEROLE);
  `verifyBootstrap`'s managed set grows accordingly.
- **Slice 0 tests that assume 0001 is the only migration must change.**
  Slice 1's design already noted five such tests. Under D-07 (decided),
  these are the **only** Slice 0 or Slice 1 test edits allowed: assertions
  that 0001 is the only migration, or equivalent migration counts. Each is
  listed in the PR with before/after, gets challenger scrutiny, and no
  assertion is weakened (tracked as T3). Any other Slice 0/1 test that would
  need to change stops the PR for escalation.
- Every new table follows the Slice 0 invariants, which the existing
  catalogue tests enforce generically: `tenant_id uuid NOT NULL`, composite
  tenant FKs, RLS enabled **and** forced with the exact tenant policy shape,
  `numeric` money (no float), `timestamptz`, `jsonb` objects checked for
  secret-like keys and values.

### 6.3 Threat model (new surface)

| Threat | Control | Test |
|---|---|---|
| Analytics reads staged, quarantined or superseded data | only the published view and the published-batch view are granted; rollups key on the published batch | DB: tenants seeded with every batch state; rollup totals = published totals exactly |
| Analytics job writes facts or publishes | no grant on ingestion tables; startup login check | DB: `INSERT INTO ratio.cost_facts` as the analytics login ⇒ 42501; mutation: add the grant ⇒ the catalogue check fails |
| Tenant A's forecasts or anomalies visible to tenant B | FORCE RLS on every new table, definer views with the tenant predicate, API binding unchanged | DB matrix per new table and view (two tenants; the `ci`-sized control tenant next to `fleet15k` at scale) |
| Derived data outlives a restatement | batch-keyed rollups; reader views join the current publication; `restated` resolution | DB: republish ⇒ API totals and anomalies follow the new batch |
| A float leaks into money | numeric columns (catalogue scan), SQL-side impact, import boundary for model code | catalogue test; unit: model module not importable from rollup/API code |
| Ground truth leaks into the detector (overstated accuracy) | labels outside the DB and outside the source bucket; the job has no file input for them | static test: the analytics CLI has no labels path; evaluator-only module |
| Synthetic data mistaken for billing data | synthetic provider names and id ranges, tenant slug and display names, dataset manifest marker (D-04) | generator unit tests; local run asserts display names |
| Resource exhaustion through new endpoints | precomputed scopes, keyset, `limit` ≤ 500, existing timeouts and rate limit | route tests at limits; load run (§5.3) |
| Status write abuse | no write surface in Slices 3–5 (D-15 deferred); status changes only by the job, recorded in the append-only events table | static test: no non-GET handler under the anomaly routes |
| Analytics job login drifts to a privileged role | per-start login check (Slice 1 logic) + catalogue check after migrations | serial DB suite per edge kind, as for the reader |

### 6.4 Restricted classes touched (governance gate)

| Paths | Class | PRs |
|---|---|---|
| `src/ingest/db/migrations/**`, `*.sql`, `privilegeModel.ts`, foundation manifests | `migrations`, `financial_semantics` | 4-1, 4-3, 5-1 |
| `src/ingest/fixtures/**` (generator), `src/lib/forecast*` (F1) | `financial_semantics` | 3-1, 3-2, 4-0 |
| `src/analytics/**`, `src/server/analytics/**` | unclassified ⇒ restricted (fail closed) | 4-2 … 5-6 |
| `src/costsource/**` (`ratio-native`, `CostFinding` fields) | `financial_semantics` | 5-5 |
| `pages/api/v1/**` | `routes` | 4-5, 5-5 |
| `scripts/local/**`, `docker-compose*`, `.github/workflows/**` | `deployment` (compose, CI) | 3-3, 3-4 |
| file names containing `role`, `tenant`, `auth` under `src/` | `auth_tenancy` | 4-1 |
| `package.json` (scripts only; **no new dependency**) | `dependencies` | 3-2, 4-2 |
| removal of derived rows (D-12, decided) | the gate's data-lifetime class (added-line rule) | 4-2, 4-4 |

Only this design PR is expected to classify `low`.

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
`test:db` (×3, no skips), the governance gate's class, the challenger
review, and the Copilot review resolved. Mutation targets are code changes
that must make at least one test fail; each PR records them in its
evidence.

**Order (decided):** PR **4-0 comes first**, as an independent bug fix: the
`daysInMonthOf` defect exists in shipped code today. Then 3-1 onwards. PR
ids keep their slice numbers so references stay stable.

| Order | PR | Scope | Tests-first acceptance criteria | Mutation targets |
|---|---|---|---|---|
| 0 | **3-0** | This design and its decision log | review only | — |
| 1 | **4-0** | **Bug fix, independent:** F1 (`daysInMonthOf` and `remainingWeekdaysInMonth` under a non-UTC process time zone; `budgetStatus.ts` inherits it) | red tests under `TZ=Asia/Tokyo` and `TZ=America/Los_Angeles` (February 2026 = 28 days; a leap February = 29; weekday counts at month ends); existing forecast and budget tests unchanged and green | local-time `Date` constructor restored; off-by-one in the weekday loop |
| 2 | **3-1** | Generator core (pure, no I/O): fleet model, series model, PRNG, BigInt money, ground-truth injection, **profiles `ci` / `fleet15k` / `full`**; `src/ingest/fixtures/fleet/**` | deterministic: same seed ⇒ same digest, different seed ⇒ different; adding an account leaves others' draws unchanged; heavy tail (top-1 % share within ±3 pp of target at 15,000 accounts); **every row passes the worker's own validator** (`src/ingest/focus/validate.ts`); one currency per billing account; `BillingPeriodStart` = period; FOCUS rules (Purchase ⇒ not Usage-Based; Committed ⇔ commitment id; Tax ⇒ no pricing category); `fleet15k`: exactly 15,000 accounts, ≤ 5 usage series per account, only the minimal column set, `Other services` = the sum of the account's remaining services; each label's effect present in the rows and absent outside its window; the `fleet15k` evaluation window holds ≥ 60 meaningful labels per main kind; no-alert artefacts at their rates | PRNG stream shared across entities; off-by-one in an injection window; credit sign flipped; mixed currency in a billing account; float in the money path; label written without its effect; an account dropped from `fleet15k` |
| 3 | **3-2** | Writer: AWS Data Exports layout, gzip, manifests with `x-ratio-control`, file splits, `dataset.json`, labels; `npm run synthetic:generate` | output accepted by `src/ingest/sources/s3/layout.ts`; bounded memory on a 1 M-row run; byte-identical re-run; pinned `ci` golden digest; control totals = BigInt sums = Python recomputation | manifest lists a file twice; control total off by 1e-10; split drops the last row; gzip mtime not zeroed |
| 4 | **3-3** | `local:synthetic` (own project and ports; provisions 36 sources + the control tenant; parallel sync; asserts) + CI step for `ci` | every period `published` and `reconciled`; totals = `dataset.json`; re-sync all `skipped_unchanged`; no fake source, no hook (static test like 2b's A9); cleanup always | skip one source; assert only row counts; run with the fake source |
| 5 | **3-4** | **`fleet15k` run in this container class** + evidence: load time (D-06 trigger), bytes per row, total disk vs the 6 GB ceiling, SeaweedFS fit (T1), bounded WAL; compose or settings override only if measured necessary | §2.10 `fleet15k` targets measured and recorded; a missed target is reported and escalated (D-20), never hidden | — (measurement PR) |
| 6 | **4-1** | Migration 0002 + privilege model + bootstrap + the permitted Slice 0/1 test edits (D-07, T3) | catalogue check passes with the new reviewed sets; analytics login refused for each unsafe shape (serial suite); reader cannot see base analytics tables; tenant matrix on each new table; foundation manifest regenerated and drift-tested; **every edited Slice 0/1 test listed with before/after and shown not weakened** | grant analytics SELECT on `cost_facts`; remove FORCE RLS from one new table; widen reader to a base table; float column |
| 7 | **4-2** | `ratio-analytics rollup` (incremental by published batch); narrow `cost_daily` + sparse `billing_daily` | rollup totals per (source, period, currency) = published totals **exactly**; restatement switches the read side; idempotent re-run; tag parsing failure counted, never crashes (`pg_input_is_valid` on PG16 [A21]); EXPLAIN shows the PK-prefix path through the security-barrier view **(to verify)**; removal of superseded-batch rollup rows (D-12, restricted) | group by the wrong day; include a superseded batch; skip the untagged measure; remove a row of a current batch |
| 8 | **4-3** | Migration 0003 (forecast tables, pointer, views) | as 4-1, for the new objects | as 4-1 |
| 9 | **4-4** | Model library (`src/analytics/model/**`, pure): M0, M1, M1-log, Hampel, grid search, empirical intervals, cold-start ladder, bottom-up; forecast job; backtest command | known-answer tests on hand-computed series; independent Python reference for small cases; invariants: bottom-up coherence, intervals ordered, lower ≥ 0; no leakage (an origin cannot see later data: test with a poisoned future); FT-4/5/7 on the `fleet15k` tuning seed | seasonal index off by one weekday; trend undamped; leakage of day t; interval from in-sample residuals |
| 10 | **4-5** | API: `costs/daily`, `forecasts`, `forecasts/accuracy`, `freshness` | Slice 2 route test set (auth, 400s, keyset, tenant, unsafe login, no-store, decimal strings); latency check on `fleet15k` | read tenant from the query; OFFSET pagination; number instead of string |
| 11 | **4-6** | Forecast acceptance on `fleet15k` (evaluation seed) + Python evaluator | FT-1…FT-7, FT-9, FT-10 recorded with the profile and n; evaluator and job agree; FT-8 marked "`full` only, pending OA-1" | — |
| 12 | **5-1** | Migration 0004 (anomaly tables, events, views; **no** `ratio_triage`, D-15) | as 4-1 | as 4-1 |
| 13 | **5-2** | Detectors D1–D6, severity, grouping, root cause (pure) | unit cases per detector and per grouping rule; commitment-effect rule; fan-in produces one group | CUSUM reset missing; MAD constant wrong; fan-in threshold off by one; severity downgrade allowed |
| 14 | **5-3** | `ratio-analytics detect` (daily + as-of replay), automatic open and resolve, restatement | replay on the `fleet15k` tuning seed; `restated` path via the `ci` daily-delivery replay; `new_region` on `ci` | detect on day D using day D data (leakage); auto-resolve after 1 day |
| 15 | **5-4** | Evaluation harness (Python) + `fleet15k` acceptance (evaluation seed) | AT-1…AT-8 recorded per kind and profile, precision re-weighted to natural rates, Wilson intervals on recall; `new_region` at scale and natural-rate AT-4 marked "`full` only, pending OA-1" | matcher accepts any day; no-alert labels ignored; re-weighting skipped |
| 16 | **5-5** | API `anomalies`, `anomalies/{id}` (GET only); `ratio-native` CostSource adapter; `CostFinding` optional fields (D-18) | route test set; PointFive mapping unchanged (existing tests untouched); decimal string ↔ number display rounding; no non-GET handler | wrong status vocabulary; impact sign flipped |
| 17 | **5-6** | UI: forecast panel, native anomalies in Findings with the R4 label (D-16, T2); latency run (§5.3) on `fleet15k` | component tests; SLOs measured | — |
| — | *5-7 (deferred, D-15)* | status write endpoint + `ratio_triage` | not built until per-user identity exists | — |
| — | *`full` runs* | 4-6 and 5-4 repeated on `full` | after owner action OA-1 (§8) | — |
| — | *follow-up slice* | notification delivery (D-17) | own design and egress review | — |

## 8. Decision log (decided by orchestrator, 2026-10-04)

Every decision below was **decided by the orchestrator under the owner's
delegation on 2026-10-04**. "As recommended" means the default proposed in
the first revision of this design was adopted unchanged.

| Id | Decision | Decided | Revisit when |
|---|---|---|---|
| D-01 | Fact grain | **Three profiles.** `ci` and `full`: account × service × region × pricing/tag split × day, resource rows only for named and runaway resources. **`fleet15k`: account × service × day, minimal columns** (§2.4), all 15,000 accounts; top 2 services per account individually (top 4 for the largest 5 %) + `Other services` (§2.8, Appendix B.5). | `fleet15k` measurements exceed the 6 GB ceiling (then: escalate with the options of B.5, never fewer accounts) |
| D-02 | Span | `ci`: 4 periods. **`fleet15k`: 4 periods (122 days)**, the shortest span that gives ≥ 56 days of training, two fully held-out months for day-1 and day-15 month-end forecasts, and ≥ 6 rolling origins at the 30-day horizon. `full`: 13 periods. | a target needs more origins than `fleet15k` provides |
| D-03 | Where each profile runs | `ci` in CI on every PR; `fleet15k` in this container class (≈ 10 GB free, 4 CPU, 15 GB RAM) and on demand; `full` on demand on a machine with ≥ 150 GB free — **an owner action (OA-1), not a decision** | OA-1 is done |
| D-04 | Synthetic identity | as recommended: `SyntheticAWS/Azure/GCP`, invented service names, ids from a reserved prefix, tenant `synthetic-fleet-15k`, display names "SYNTHETIC", manifest marker | — |
| D-05 | Storage | as recommended: batch-keyed rollup tables written by `ratio_analytics`; no materialised views; no partitioning initially. Refined by the measurement: narrow `cost_daily` (PK only) + sparse `billing_daily` | §5.3 SLOs missed |
| D-06 | Per-row staged-only trigger (brief D-09) | **keep it.** Load time is measured on `fleet15k` (PR 3-4). **Trigger: if the `fleet15k` load exceeds 60 minutes, revisit with that evidence.** | the trigger fires |
| D-07 | First post-0001 migration | accepted: 0002–0004 as expand migrations with the new role. **The only edits allowed to Slice 0 and Slice 1 tests are those that assert "0001 is the only migration" (or an equivalent migration count).** Each such edit is listed in the PR with before/after, gets challenger scrutiny, and **no assertion is weakened** (T3, §9). | any other Slice 0/1 test would need to change: stop and escalate |
| D-08 | Read access | as recommended: widen `ratio_reader` by SELECT on the new definer views only | — |
| D-09 | Monitored measure | as recommended: `EffectiveCost` of usage-based, non-correction rows; billed month-end separately | — |
| D-10 | Currency | as recommended: per billing currency; no FX in Slices 3–5 | a reporting currency is required |
| D-11 | Compute stack | as recommended: SQL rollups + TypeScript job; Python stdlib only as the independent evaluator | — |
| D-12 | Lifetime of derived data | accepted **as a restricted change**: anomalies, events and backtests kept; `ratio_analytics` may remove rollup rows of superseded batches and forecast state older than the last 2 runs | — |
| D-13 | Default thresholds | as recommended: min impact USD/EUR/GBP 100, JPY 15,000 per day; `warning` ≥ min and ≥ 20 %; `critical` ≥ 10 × min and ≥ 50 %, or ≥ 50 × min cumulative | measured precision or recall disagree (escalate, D-20) |
| D-14 | Spend drops | as recommended: detected, `info` by default | — |
| D-15 | Manual acknowledge / resolve | **deferred** until per-user identity exists. Detection opens findings automatically, and the job marks a finding resolved when the anomaly ends (`auto_recovered`, `new_baseline`, `restated`). No write endpoint and no `ratio_triage` role in Slices 3–5 | per-user identity exists (brief D-10 / D-06 revisited) |
| D-16 | R4 for fleet spend | as recommended: "value context: not attributed" shown next to every fleet cost, forecast and anomaly (tracked as T2) | value attribution exists for fleet accounts |
| D-17 | Notifications | **a follow-up slice** with its own egress review | — |
| D-18 | `CostFinding` shape | as recommended: additive optional fields | — |
| D-19 | Relation to existing rules | as recommended: keep obvious.md's workload rule; fleet rules named separately | — |
| D-20 | Missed acceptance targets | **recorded and escalated, never relaxed** | — |

### Owner actions (not decisions)

| Id | Action | Unblocks |
|---|---|---|
| OA-1 | Provide an environment with **≥ 150 GB free disk** (reference: 8 vCPU, 32 GB RAM, NVMe) for the `full` profile. This is environment provisioning, not production hosting; BOUNDARY v2 still applies (local, ephemeral, synthetic). | FT-8, per-series interval quantiles, `new_region` at scale, natural-rate AT-4, FT-10 at ≈ 107 k leaves, D-09 data at ≈ 6 M rows per month |

## 9. Tracked items (side findings)

| Id | Item | Owner | Status / next step |
|---|---|---|---|
| T1 | **SeaweedFS capacity.** The local compose runs `-volume.max=64 -master.volumeSizeLimitMB=64`, ≈ 4 GiB (assumption: volumes × size limit). `fleet15k` needs ≈ 0.34 GB in the two buckets and should fit; `full` needs ≈ 11 GB. | Slice 3 implementer (PR 3-4) | measure on `fleet15k`; add a compose or settings override (restricted, `deployment`) only if measured necessary; required for `full` |
| T2 | **R4 conflict.** Fleet spend has no value attribution, so "every cost paired with value" cannot be met literally. Decided handling: the D-16 label. | Slice 5 implementer (PR 5-6); any change to the rule itself: orchestrator, with the owner | label implemented and tested in 5-6; rule text in `.obvious/obvious.md` unchanged |
| T3 | **Slice 0/1 test edits for migration 0002.** Only assertions that 0001 is the only migration (or equivalent counts) may change (D-07). Slice 1's design already noted five such tests. | Slice 4 implementer (PR 4-1); the challenger reviews each edit | the PR lists every edited assertion with before/after and why it is not weakened |
| T4 | **Wrong CLAUDE.md in this session's context.** The harness loaded `/home/user/adaptcloud/CLAUDE.md` (an unrelated "Agnus Dei / Sage" homeschool project) as project instructions for this repository. It was ignored; nothing in this design depends on it. | orchestrator (session and environment configuration) | report it to whoever configures the sessions, so future agents on this repository do not receive another project's instructions |
| T5 | **F1, the `daysInMonthOf` time-zone bug** (verified: February 2026 = 27 days under `TZ=Asia/Tokyo`). | PR 4-0 implementer | first PR of the plan |
| T6 | **F4, D-09's trigger** at ≈ 6 M rows per month in `full`. | orchestrator (D-06) | `fleet15k` load time measured in 3-4; `full` after OA-1 |

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
- **API:** the new routes are independent of `costs/published`; reverting
  them leaves Slice 2 unchanged.
