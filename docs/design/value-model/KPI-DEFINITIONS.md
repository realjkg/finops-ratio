# Project Value Model: user-defined KPI and outcome definitions, and the sponsor's cost-to-value case

Status: **Proposed**. The engine in `src/valuemodel/` is implemented and unit-tested. It is not yet connected to storage, routes, the UI, Frank or connectors. Its schemas are drafts (`*/0-draft`) and are deliberately kept out of the stable platform contracts (`src/platform/contracts/versions.ts`).

This note implements the direction in `docs/design/value-derivation/VALUE-DERIVATION.md` (§3–§5) for the part users configure: **what** a project measures, **how** it is computed, and **how the sponsor's before and after cost-to-value inputs become a ratio without changing any number already issued.**

## 1. The rule

> Users customize inputs. Ratio standardizes the measurement contract. Nothing published is ever overwritten.

| Who | Can | Cannot |
|---|---|---|
| Project sponsor (`project_sponsor`) or KPI author (`kpi_author`) | Create a KPI with their own inputs, units, outcome conditions, project variables, formula and target; edit drafts; start new versions; enter cost-to-value terms before (expected) and after (observed) | Approve their own definition or case; type a ratio, net benefit or evidence status; edit anything approved or published |
| KPI approver (`kpi_approver`) | Approve and publish a definition version | Approve a definition they wrote |
| Finance approver (`finance_approver`) | Approve definitions that read or produce money, and every value case | Approve their own work; give two of the required approvals |

## 2. A KPI and outcome definition (`kpi-definition/0-draft`)

Users supply every part of the definition:

| Part | What the user supplies | Checked by |
|---|---|---|
| Inputs | 1–32 custom inputs: key, label, kind (`count`, `quantity`, `money`, `percent`, `score`, `rate`), unit, bounds, aggregation, allowed source kinds | Kind and unit must agree; a `rate` comes only from `finance_register`; the register supplies only rates; every input must be used by the formula |
| Outcome | The unit of one successful outcome (`invoice`, `case`) and 1–16 quality conditions it must meet, plus an optional quality window | An outcome with no quality condition is refused |
| Project variables | Up to 12 dimensions (`documentComplexity`, `businessUnit`) that segment observations so before and after compare like with like | Distinct keys; optional allowed values |
| Calculation | A bounded formula, its result unit and its rounding scale | Units are inferred and must match the declared result; currencies are never mixed; a zero denominator is always unavailable |
| Target | Value, unit and who set it: a policy reference, a named role, or `demo_configuration` | The setter is required and never invented |

### Formula language

Arithmetic (`+ - * /`), parentheses, `min`, `max` and `if(a <op> b, then, else)`, over declared inputs and plain decimal literals. It is not JavaScript, SQL or a spreadsheet: there is no property access, string, assignment, loop or unknown function. Limits: 1,000 characters, 128 parts, 24 levels of nesting, 32 inputs.

Units are checked when the definition is validated:

```text
hour ÷ invoice              → minute per invoice (converted exactly)
hour × USD/hour             → USD
USD ÷ USD                   → dimensionless ratio
score_csat + USD            → refused
USD + EUR                   → refused (no cross-currency sums)
```

Arithmetic is exact (BigInt rationals) and is rounded once, half-to-even, at the declared scale.

## 3. Lifecycle

```text
Draft → Validated → Approved → Published → Superseded
```

- Validation runs the full check and lists problems by field path, never echoing user values.
- An edit after validation returns the version to Draft and clears approvals.
- Approvals are bound to the definition's sha256 digest, so a reviewer approves exactly what they saw.
- Publishing freezes a version. Publishing a newer version marks the older one Superseded; it stays readable.
- A change to a published definition is a new version (`newVersion`), with `basedOnVersion` recorded.

### Comparability

Before and after results can be compared when they use the same version, or a newer version whose measurement fields (`outcomeUnit`, `direction`, `inputs`, `outcome`, `dimensions`, `calculation`, `periodGrain`) are unchanged. Renaming or retargeting keeps comparability. Any other change breaks it unless a reviewed mapping is referenced.

## 4. Results (`kpi-result/0-draft`)

- An official result needs a Published definition. A draft can be previewed only as a **scenario**, which is never `measured` and is never recorded as official.
- Every input needs one observation for the same period and scope, in a convertible unit, from an allowed source kind, inside its bounds.
- A missing observation, a null value or a zero denominator gives **unavailable** with a reason, never 0.
- Evidence status is computed, never chosen, and the weakest input wins (`src/lib/valueEvidence.ts`):
  - `measured`: from a source of record with an independent verification reference;
  - `projected`: a sourced forecast;
  - `assumed`: a typed assumption (even when labeled a forecast) or an unverified value.
  - Another KPI's result (`kpi_result`) counts as `assumed` until results are resolved against the result ledger; the status a caller supplies with it is never used.
- Evaluation refuses a definition record whose definition no longer matches its recorded digest.
- The result ledger accepts one first result per KPI, period and scope; any later result must be a recalculation that supersedes it. It re-checks each result's digest, so a result changed after it was calculated is refused.
- Every result records the definition version and digest, the formula-engine version, the inputs' sources and verification, and its own digest.
- A recalculation is a **new** result that supersedes the old one and states why. The issued result stays readable exactly as issued, so a report always shows the number it was issued with. A result can be superseded only once.

## 5. The sponsor's cost-to-value case (`value-case/0-draft`)

The sponsor enters **terms** (KPI results, finance-register rates, observations, forecasts or labeled assumptions, each with a source kind and basis) and two formulas: the benefit and the full AI project cost, both in the case currency.

```text
Value / cost = V ÷ C        (break-even 1×)
Net benefit  = V − C
ROI          = (V − C) ÷ C
```

The case refuses any field for a ratio, net benefit or evidence status: they are computed.

| Phase | Purpose | History rule |
|---|---|---|
| `expected` (before) | The investment case and later revised forecasts | The **first approved expected version is the original business case**. It is never edited or superseded. A revised forecast is a new version with a rationale, published beside it. |
| `observed` (after) | What happened in a period | A correction is a new approved version that supersedes the snapshot in force, with a reason. The issued snapshot is unchanged. |

Published ratios are append-only **snapshots** (`value-ratio-snapshot/0-draft`) bound to the case version's digest. A snapshot's evidence status is the weakest term, and no snapshot is `measured` yet: an expected case is a forecast, and an observed case needs a counterfactual method and independent verification (VALUE-DERIVATION §4) that are not modeled. Both are capped at `projected`. The original business case must be published before any revised forecast of the same case. `expectedVsObserved` returns the original business case, the latest approved forecast and the observed result in force, and measures variance against the **original**, so a revised forecast cannot hide a shortfall. Today the original is the first approved expected version of the **case**, not of each period; whether it should be per period is an open decision (§7).

Zero or negative cost makes the ratio unavailable; a missing term makes the value unavailable with a reason.

### Worked example (synthetic)

10,000 qualified resolutions, process cost $8 → $5 per resolution, 80% attributable, full AI project cost $12,000:

```text
V = 10,000 × ($8 − $5) × 80% = $24,000
Value / cost = 2.00×    Net benefit = $12,000    ROI = 100.0%
```

Its status is `assumed`, because cost and attribution are typed assumptions. If the sponsor later lowers the forecast attribution to 50%, a new version shows 1.25× beside the original 2.00×. An observed result of 1.33× reports a variance of −0.67 against the original.

## 6. What is not built yet

| Piece | Status |
|---|---|
| Durable storage with the same transitions and append-only history | Not started; needs a reviewed migration |
| API routes and server-side authorization against R2 identities and existing RBAC | Not started |
| Value model UI (KPI designer, sponsor case editor, "View calculation") | Not started |
| Frank explanations from result and snapshot records | Not started; Frank must read records, never browser values |
| Connector mappings for outcome observations | Not started |
| Finance unit-value register | Not started; `finance_register` is a source kind only |
| Promotion of the draft schemas to stable contracts | Owner decision |
| Resolving `kpi_result` terms against the result ledger | Not started; such terms count as `assumed` |
| Counterfactual method (holdout or pre-registered baseline) and its disclosure | Not started (owner decision 3) |
| Separate, pre-approved attribution shares | Not started; attribution is a sponsor term today (owner decision 4) |
| Range, central estimate and a separately labeled lower-bound policy score | Not started |
| Measurement confidence separate from causal confidence | Not started |
| Overlap or double-counting check across benefit terms | Not started; one `benefitClass` per case |
| Completeness and verification blocker diagnostic | Not started |
| Shadow calculation beside the current headline (never added to it) | Not started (owner decision 8) |

## 7. Decisions for the owner

1. Approve the role split in §1, or name different roles.
2. Whether a sponsor-only KPI (no money) needs one approver or two.
3. Whether an unverified observation should count as `assumed` (current) or get a fourth status.
4. Default rounding: 2 decimals for Value / cost and money, 1 for ROI percent.
5. Whether to promote the four draft schemas to stable platform contracts after the storage and route changes.
6. Whether the original business case is kept per case (current) or per case and period, and whether it is published automatically on approval.
7. Whether an observed case may ever be `measured`, and what evidence that needs (current: capped at `projected`).
8. Whether a `rate` may convert between currencies (a finance-register exchange rate), or multi-currency rate units are refused.
9. Who may publish value snapshots and validate drafts (any actor today), and how a negative value or a zero or negative cost is presented.
