# src/recommend: native savings recommendations

Pure, deterministic TypeScript (checklist Step 4, items 4.1 to 4.4). No network, clock, randomness or dependencies. PointFive stays an optional source: `fromCostFinding` lifts its findings into the native shape and `toCostFindings` emits `CostFinding`-compatible output.

## Read this first: feed mappings are unvalidated

The three feed normalizers (`normalizeAwsComputeOptimizer`, `normalizeAzureAdvisor`, `normalizeGcpRecommender`) are written from the documented response shapes. This build could not call those APIs. **The field mappings MUST be validated against live responses before any figure from them is trusted.** Until then treat every number as unverified. The code comments in each file list the exact fields and the engine-chosen defaults (confidence, effort, risk), which the owner should confirm. Azure Advisor recommendation-type GUIDs are intentionally not hard-coded.

## Public API (`index.ts`)

- `analyzeCommitments(rows, window, options?)`: per commitment id, per service family and per currency: used and unused amortized cost, utilization percent, coverage percent, unused-commitment dollars, expiry status, units kept apart, and an eligible-usage series for sizing.
- `recommendCommitmentPurchase(familyCoverage, options)`: conservative suggestion or a fixed-reason refusal. Always returns its assumptions.
- `normalizeAwsComputeOptimizer`, `normalizeAzureAdvisor`, `normalizeGcpRecommender`: strict, never throw, return `{ items, rejected, skipped, rejectedByReason, refused }`.
- `rankRecommendations(items, options?)`: validate, de-duplicate, score, rank, cap.
- `toCostFindings`, `fromCostFinding`: adapters to the existing `CostFinding` seam.
- `toJsonSafe`: results hold `bigint`; use this before `JSON.stringify`.

## Money

Integer minor units (`bigint`) throughout; exponent per currency from the allocation module's ISO 4217 table (JPY 0, USD 2, KWD 3). Unsupported currency codes are refused, never defaulted to 2. Never summed across currencies: every report is keyed by currency. Numbers and strings share one rule: a JSON number is read through its shortest decimal text, then rounded half away from zero, so `1.005` and `"1.005"` both give 101 USD minor units; percentages are floored to two decimals. Only `toCostFindings` converts back to a float (the `CostFinding` field is one), and it skips values beyond 2^53 minor units.

## Commitment analysis: definitions

- Eligible usage: `ChargeCategory` Usage, `ChargeFrequency` Usage-Based or absent, and either covered (`CommitmentDiscountStatus` Used) or on demand (no commitment fields, `PricingCategory` Standard). Dynamic and Other pricing, Unused rows and non-Usage charges are excluded and counted.
- Coverage = covered / (covered + on-demand), valued at `ContractedCost` (or `ListCost` on request) for both sides. An apparent value above 100 is clamped and flagged `over_100_clamped`; by construction it should not occur, so the flag indicates inconsistent input.
- Utilization = used / (used + unused) on `EffectiveCost`. Unused-commitment cost = `EffectiveCost` on Unused rows.
- Spend-based and usage-based commitments are labeled by `CommitmentDiscountCategory`. Quantities are tracked per `CommitmentDiscountUnit` and never added across units; cost figures do not depend on them.
- Row hygiene: contradictory rows (id without status, committed pricing on a non-committed row, and so on) are rejected with a count, not repaired.

## Purchase recommendation

Floor = nearest-rank percentile (default 10) of on-demand eligible usage per hour or day, zero-filled, less a 10 percent safety margin, capped at a coverage target (default 80). The caller supplies the discount rate; no vendor price is built in. Outputs: hourly commitment, term cost, up-front and monthly cash, payback months (rounded up to hundredths), break-even utilization (100 minus discount), in-sample backtested utilization, risk label from a documented point score. Minimum history: 30 observed days and 80 percent of the window. Refuses with a fixed reason otherwise.

## Ranking

`score = savings x confidence x effort x risk` in basis points (see `RANK_FORMULA`). Duplicates (same currency, resource id case-insensitive, category) keep the higher-confidence item; others become corroborating. Ties break by savings, confidence, source, sourceId, resourceId, category.

## Caps

Commitment rows 100,000; terms 10,000; window 400 days; feed items 5,000 per call (one past is refused with a count); rank input 20,000; rank output 100 per currency by default, 1,000 maximum; corroborating listed 10; evidence refs 8.

## Known gaps

- `CanonicalFocusRow` does not carry `CommitmentDiscountId/Category/Type/Quantity/Unit` or `PricingCategory`, and the ingest allowlist drops them. `analyzeCommitments` takes its own `CommitmentFocusRow`; real data needs the ingest seam extended first. Usage rows without `PricingCategory` are rejected, so the gap is visible.
- FOCUS Cost and Usage rows carry no commitment end date. Expiry uses caller-supplied `terms`.
- Fleet cloud spend has no attributed business value, so every recommendation is labeled cost only (R4); no value is invented.
- No growth, seasonality or migration modeling; backtest is in-sample; expiring commitments are not netted from a purchase suggestion.
- Resource ids from different feeds (ARN, Azure id, GCP resource name) are not canonicalized, so cross-source de-duplication only matches identical ids.
- Azure and GCP supply no current spend; AWS current spend is derived from the savings percentage.
- Effort and risk defaults and the confidence thresholds are engine choices, not provider semantics.
