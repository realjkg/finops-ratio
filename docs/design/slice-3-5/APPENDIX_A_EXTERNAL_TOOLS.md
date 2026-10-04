# Appendix A — External tools and references: claims, sources, verification

Part of [DESIGN.md](DESIGN.md). Researched on **2026-10-04**.

**How this was verified.** The session's network proxy blocked direct page
fetches from `docs.aws.amazon.com`, `aws.amazon.com`, `learn.microsoft.com`,
`docs.cloud.google.com`, `docs.vantage.sh` and `focus.finops.org`. Claims
about those products therefore come from **web-search results restricted to
the vendor's own domain**, which quote or summarise the official page named
in the "Source" column. That is weaker than reading the page: each such
claim is marked **search-verified (S)**. A claim checked against the primary
text itself is marked **primary (P)**. A claim that only came from a
third-party page, or that the search summary did not clearly attribute, is
marked **unverified (U)** and is not relied on for any target.

Before a PR quotes any of these numbers in user-facing text, re-read the
page itself (PR 3-0 review action).

| Id | Product / topic | Claim used in the design | Source (official) | Status |
|---|---|---|---|---|
| A1 | AWS Cost Explorer forecast | Forecasts carry an **80 % prediction interval**; its width depends on historical volatility; no forecast when there is not enough data (common with less than one full billing cycle) | https://docs.aws.amazon.com/cost-management/latest/userguide/ce-forecast.html | S |
| A2 | AWS Cost Explorer forecast | Since Nov 2025: up to **18 months** of forecast, up to 38 months of history after opt-in, AI-generated explanations | https://aws.amazon.com/about-aws/whats-new/2025/11/cost-explorer-18-month-forecasting-ai-powered-forecasts/ ; https://aws.amazon.com/blogs/aws-cloud-financial-management/introducing-18-month-forecasting-and-explainable-ai-insights-in-aws-cost-explorer/ | S |
| A3 | AWS `GetCostForecast` | **3 months** of DAILY or **18 months** of MONTHLY forecasts | https://docs.aws.amazon.com/cli/latest/reference/ce/get-cost-forecast.html | S |
| A4 | AWS Cost Anomaly Detection | Runs **approximately three times a day**, on **net unblended cost** (net of applicable discounts) | https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html | S |
| A5 | AWS Cost Anomaly Detection | Uses Cost Explorer data, latency **up to 24 hours**, so detection can take up to 24 h after the usage | https://aws.amazon.com/aws-cost-management/aws-cost-anomaly-detection/faqs/ | S |
| A6 | AWS Cost Anomaly Detection | A monitor needs **at least 10 days** of history; a new service is not evaluated until it has 10 days of spend | same FAQ as A5 | S |
| A7 | AWS Cost Anomaly Detection | Monitor dimensions: AWS services, linked accounts, cost allocation tags, cost categories; thresholds are alerting preferences (the ML model sets the anomaly threshold); getting-started default: daily summary for anomalies **above $100 and above 40 %** of expected spend; alerts individually or as daily/weekly summaries by e-mail or SNS | https://docs.aws.amazon.com/cost-management/latest/userguide/getting-started-ad.html ; FAQ (A5) | S |
| A8 | AWS Cost Anomaly Detection | Enhanced root cause analysis: **up to 10 root causes** per anomaly, ranked by cost impact over combinations of service, account, Region and usage type | https://aws.amazon.com/about-aws/whats-new/2024/11/aws-enhanced-root-cause-insights-cost-anomalies/ ; https://aws.amazon.com/blogs/aws-cloud-financial-management/faster-anomaly-resolution-with-enhanced-root-cause-analysis-in-aws-cost-anomaly-detection/ | S |
| A9 | AWS Cost Anomaly Detection | Nov 2025: **rolling 24-hour windows** compared with the same hours of earlier days; AWS-managed monitors track the **top 5,000 values** of a dimension independently; 2026: AI-powered cost investigations | https://aws.amazon.com/about-aws/whats-new/2025/11/aws-cost-anomaly-detection-accelerates-anomaly/ ; https://aws.amazon.com/about-aws/whats-new/2025/11/aws-cost-anomaly-detection-managed-monitoring/ ; https://aws.amazon.com/about-aws/whats-new/2026/06/aws-ai-powered-cost-investigations/ | S |
| A10 | Azure Cost Management anomalies | Evaluated **daily at subscription scope**, **36 hours after the end of the UTC day**; univariate, unsupervised, reconstruction-based **WaveNet** model trained on **60 days**; anomaly alert rules only at subscription scope; the alert e-mail summarises resource-group changes; based on normalised (not rated) usage | https://learn.microsoft.com/en-us/azure/cost-management-billing/understand/analyze-unexpected-charges | S |
| A11 | Azure Cost Management forecast | "Time series linear regression" model that adjusts for reservation purchases; forecasts up to a year; lookback 28 days for horizons ≤ 28 days, = horizon up to 90, 90 days beyond | search summary over learn.microsoft.com (cost analysis quickstart and Microsoft Q&A pages) | **U** for the lookback figures (may come from a Q&A answer, not the docs); S for "forecast available in cost analysis" |
| A12 | Google Cloud Billing forecast | ML forecast in Billing reports up to **12 months**; pre-processing handles outliers, gaps and shifts; models daily, weekly and monthly cycles; total = actual to date + predicted future days; end-of-month estimate | https://docs.cloud.google.com/billing/docs/how-to/reports/forecasted-costs ; https://docs.cloud.google.com/billing/docs/how-to/reports | S |
| A13 | Google Cloud Cost Anomaly Detection | Per-project expected daily spend from historical and seasonal patterns, actual spend checked **hourly**; root cause by services, regions, SKUs; thresholds on **cost impact** and **% deviation** (standard anomalies); Anomalies dashboard per billing account | https://docs.cloud.google.com/billing/docs/how-to/manage-anomalies | S |
| A14 | Google Cloud Cost Anomaly Detection | GA; dashboard GA **30 Oct 2025**; alerts auto-enabled for all projects; auto-generated thresholds updated daily; claims to handle **cold start** for new accounts and projects | https://cloud.google.com/blog/topics/cost-management/announcing-ga-of-cost-anomaly-detection ; https://docs.cloud.google.com/billing/docs/release-notes | S |
| A15 | Tanzu CloudHealth | Anomaly detection over the past **90 days**, increases and decreases, dashboard with count and total cost impact, root cause through FlexReports; ML forecasting from the past **12 months**, up to **36 months** ahead, growth factors, service exclusions, Perspectives | https://techdocs.broadcom.com/us/en/vmware-tanzu/cloudhealth/tanzu-cloudhealth/saas/tnz-cloudhealth/using-and-managing-tanzu-cloudhealth-anomaly-detection.html ; https://techdocs.broadcom.com/us/en/vmware-tanzu/cloudhealth/tanzu-cloudhealth/saas/tnz-cloudhealth/using-and-managing-tanzu-cloudhealth-forecasting.html | S |
| A16 | FinOps Foundation, Forecasting capability | Acceptable forecast variance: **≤ 20 % (Crawl), 15 % (Walk), 12 % (Run)** | https://www.finops.org/framework/previous-capabilities/forecasting/ ; https://www.finops.org/framework/capabilities/forecasting/ | S (which of the two pages carries the figures was not confirmed) |
| A17 | Vantage | Per cost report, series by provider / service / cost category; ML forecast on up to **6 months** of daily cost; a series needs **> 12 days** of data; a day above the forecast's **upper bound** is a candidate; noise filters: below **$5** on the day, or below **0.5 %** of the report's daily total; alerts by e-mail, Slack, Teams, Jira; resource attribution | https://docs.vantage.sh/cost_anomaly_alerts ; https://www.vantage.sh/blog/resource-anomalies | S |
| A18 | PointFive | ML baseline, actual vs expected, usage-vs-price attribution, resource-level root cause; "real-time" detection claim | https://www.pointfive.co/features ; https://www.pointfive.co/faq | S (marketing pages; capabilities not independently checkable) |
| A19 | FinOps Foundation, Anomaly Management | Lifecycle: record creation, notification, analysis, resolution; KPIs include mean time to detect and mean time to notify | https://www.finops.org/framework/capabilities/anomaly-management/ | S |
| A20 | FOCUS 1.0 | Allowed values and rules for `ChargeCategory` (Usage, Purchase, Tax, Credit, Adjustment), `ChargeClass` (Correction or null), `ChargeFrequency` (One-Time, Recurring, Usage-Based; Purchase ⇒ not Usage-Based), `PricingCategory` (Standard, Dynamic, Committed, Other; Committed when CommitmentDiscountId is not null; null for Tax), `CommitmentDiscountStatus` (Used, Unused), `EffectiveCost` (amortised; 0 for a Purchase covering future charges; = BilledCost for unrelated charges such as Credit), `BilledCost` | FOCUS_Spec repository, tag `v1.0`, commit `f7f58a0a7e545258779839d4f2114819f278c6f3`, `specification/columns/*.md` (cloned and read in this session) | **P** |
| A21 | PostgreSQL | Before PG17, `REFRESH MATERIALIZED VIEW` requires ownership; PG17 adds the grantable `MAINTAIN` privilege. PG16 adds `pg_input_is_valid()` and `pg_input_error_info()` | https://www.postgresql.org/docs/17/sql-refreshmaterializedview.html ; https://www.postgresql.org/docs/release/17.0/ ; https://www.postgresql.org/docs/16/release-16.html | S |
| A22 | Methods literature | Seasonal-naive and ETS / Holt-Winters with damped trend; time-series cross-validation (rolling origin); prediction intervals from empirical / bootstrapped errors; hierarchical bottom-up and MinT reconciliation — Hyndman & Athanasopoulos, *Forecasting: Principles and Practice* (3rd ed., OTexts). CUSUM — Page (1954), *Biometrika* 41. MAD scale constant 1.4826 — Rousseeuw & Croux (1993), *JASA* 88. Hampel filter — Hampel (1974), *JASA* 69. | standard references | not re-read in this session (well-established; cited for method, not for numbers) |

## What is not published

Searched on the official domains above and found **no** published figures
for:

- precision, recall or false-positive rate of any vendor's anomaly
  detector;
- alert volume per account or per day;
- forecast error (WAPE, MAPE, APE) or interval coverage achieved by any
  vendor's forecast. AWS states the interval level (80 %), not its
  empirical coverage.

So "at par" is defined by **capabilities** (DESIGN §1.5), and the numeric
targets in DESIGN §3.10 and §4.9 are Ratio's own, measured on synthetic
ground truth. The only external numeric yardstick for accuracy is the
FinOps Foundation's variance guidance (A16), which is about budget-level
forecasts, not daily series.

## Statements in DESIGN.md that depend on these sources

| DESIGN section | Depends on |
|---|---|
| §1.4 reference table | A1–A19 |
| §1.5 parity checklists | A1, A3, A4–A9, A10, A13, A14, A17 |
| §2.1, §2.3, §2.4, §4.1 (FOCUS semantics) | A20 |
| §2.9 (no materialised views), PR 4-2 (`pg_input_is_valid`) | A21 |
| §3.2–§3.6, §4.2 (methods) | A22 |
| §3.10 FT-1, FT-3 | A16 |
| §4.4 default thresholds comparison | A7, A17 |
| §4.5 root causes | A8 |
| §4.9 AT-3 comparison | A5, A10 |
