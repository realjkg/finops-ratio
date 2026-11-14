# Value derivation: how Ratio's value metric is derived today, and how to derive it independently

| | |
|---|---|
| Status | **Proposed** (design only, no code). Owner decisions in §8. |
| Date | 2026-11-13 |
| Owner request | "We need to clearly map how the value metric is independently derived in the most objective way possible." |
| Related | ADR-0002 (D4 measured only from reconciled data; the `value-evidence` sub-agent), `docs/evidence/outcome-accountability.md`, `src/outcomes/durable.ts`, migration 0004 |
| Status wording | Nothing here is "measured" or "verified" until the evidence in §5 exists. |

## 1. The rule we are aiming for

A value figure is **independent** when a person who does not own the workload can recompute it from records the workload team does not control, using a method that was fixed before the results were known, and get the same number.

Every value figure must state its formula inputs, their sources, the period, the currency, the method and the evidence status. A figure that cannot do that is shown as `assumed` (or N/A), never as `measured`.

## 2. What the value metric is today

### 2.1 The formulas

| Figure | Formula | Where |
|---|---|---|
| Workload value (per month) | `(revenue_protected + cost_avoided) × quality_floor_pass_rate − harm_from_misses` | `src/lib/valueMath.ts:31-56` |
| Value / cost | workload value ÷ monthly cost; N/A when cost ≤ 0 | `src/lib/valueRatio.ts:14-19` |
| Group or portfolio Value / cost | Σ value ÷ Σ cost (never a mean of ratios) | `src/lib/derive.ts:135-160`, `src/ai/mock/calc.ts:13-23` |
| ROI | (value − cost) ÷ cost | `src/ai/mock/format.ts:47-51`, `src/outcomes/model.ts:284`, `src/outcomes/durable.ts:297` |
| Measured Value / cost (simulation outcomes) | Σ verified measured benefit ÷ full cost for the observation window; null until every cost is measured and verified | `src/outcomes/model.ts:171-293` |
| Value / cost (durable outcomes) | Σ verified `measured_financial` claims, after attribution (`evaluateBenefit`, `monetaryBenefit`) ÷ full cost. Null while any blocker applies: the registration is not approved, the model-cost ledger does not cover every day of the observation period, a measured claim is unverified, an unvalidated claim exists, no verified financial claim exists, the baseline and observation periods differ in length, or full cost is not positive. On the cost side it blocks only a missing category or a measured but unverified one, so a projected or assumed supplemental cost passes | `src/outcomes/durable.ts:192-212`, `:284-298` |
| Benefit of one measure | amount × attribution % (× contribution margin % for revenue) | `src/outcomes/model.ts:57-67` |
| Full cost | model-usage ledger for the window + infrastructure, implementation, oversight and labor | `src/outcomes/model.ts:194-204`, `durable.ts:236-257` |
| 3× target | a fixed policy target (`VALUE_MINIMUM = 3.0`, critical 2.0), not a financial standard | `src/findings/recommendationMath.ts:27-30`, `src/lib/vocabulary.ts:96-104` |

### 2.2 Where each value input comes from

| Path | Who supplies the number | Evidence status | Independent? |
|---|---|---|---|
| **Demo headline** (`src/data/workloads.ts`) | Constants. `total_value = valueRatio × monthlySpend` (l.84), then split by a fixed `revenueSplit`; pass rate and harm are constants | Hard-coded `assumed` (l.148-153); a test pins "never measured" | **No.** The seed ratio produces the value, so the displayed Value / cost is derived from the input ratio (after the pass-rate gate and harm, l.94-102) |
| **Simulation outcome measures** (`src/outcomes/commands.ts`) | A signed-in person types amount, attribution %, margin % (both default 100), reference and method | The person picks the status, `measured` included (needs only non-empty reference and method text, l.233-237) | **Partly.** Only measures that are `measured` **and** verified by a different person count (`model.ts:203-214`), but the number, the attribution and the reference are one person's entry |
| **Simulation outcome plan** | A person types the metric, baseline and observation | Verified by a different person (`commands.ts:184-198`) | **Partly.** A before/after on one performance metric; it is not converted into money |
| **Durable outcome ledger** (migration 0004, `durable.ts`) | Designed for system-of-record outcome events and benefit claims | Database-enforced four-eyes on registrations and claims; `successfulOutcomeCount` counts only quality-passed successful events, but the view's `validated_benefit_total` sums the benefit of every `measured_financial` event, whatever its outcome status or quality | **Best design so far**, but there is **no writer and no route** for it yet. The reader is granted only the published outcome views (`outcome_events_published`, `outcome_period_counts`), not registrations, benefit evidence or supplemental costs |
| **Ingested cost rows** (`src/costsource/normalize.ts:72-113`) | Value is borrowed from the demo workload by ID; an unmatched row gets value 0 (l.89-100) | **Unmarked.** The value extensions (`RatioFocusExtensions`, `src/costsource/focusRows.ts:114-124`) carry no evidence status, so the seed's `assumed` is lost. The values are shown with no status at all (`CostSourcePage.tsx`, `FinioPage.tsx`), so nothing can mark them weaker: the same effect as gap 8 | **No** |
| **Frank chat** (`/api/v1/ai/chat`, `pages/api/v1/ai/chat.ts`) | The browser sends `monthlyValue`, `valueRatio` and `valueEvidenceStatus` | Taken as sent. The route's `isValidBody` (l.352-372) checks only the context containers. On the mock path, `src/ai/mock/world.ts:118-150` range-checks the fields; on a live provider, `buildSystemPrompt` (l.282, called at l.416) writes `valueRatio` (any number) and `valueEvidenceStatus` (any string, verbatim) into the prompt with no range or value check | **No.** A client can send any value and claim `measured`, and a live provider sees it without even the mock's range checks. The verbatim status string is also a channel for injecting text into the prompt |
| **Engagement report** (`src/reports/*`) | Cost only | — | Value is not reported at all |

### 2.3 Why it is not yet objective

1. **Circular headline.** The demo value is the seed ratio multiplied back by the cost (then gated by the quality pass rate and reduced by harm), so the displayed ratio is derived from the input ratio and cannot be checked against anything.
2. **Self-reported money.** Benefit amounts, attribution % and margin % are typed by one person and default to 100%.
3. **Self-labeled evidence.** The recorder chooses `measured`; a reference is free text that nothing checks.
4. **No counterfactual.** There is a before/after on one metric, but no control group, holdout or volume normalization, and the metric movement is never turned into money.
5. **Period and currency gaps.** A simulation measure has no period yet is divided by an observation-window cost; durable benefit sums are not filtered by period or currency.
6. **Two rule sets.** The simulation applies contribution margin and requires every cost measured and verified; the durable functions do neither.
7. **Audit gaps.** The simulation audit stores who and what, not the values. Saving a measure with the same id replaces it (clearing its verification), and `remove-value-measure` deletes it (`commands.ts:247`), with no review. The earlier values are not lost: the command log keeps the full workspace state after every command (`src/simulation/server/database.ts:96-97`, kept for idempotent retries). But nothing records an explicit before/after entry or requires a reviewed supersession.
8. **Silent unmarked inputs.** `weakestStatus` skips an input with no status (`valueEvidence.ts:24-35`), so an unmarked value cannot pull a group's status down.
9. **Client-supplied value** on the chat route (above).
10. **Fixed policy constants** (3×, 2×, full-cost rates 20/10/15%, savings at 20% of cost in seeded findings) with no owner or configuration.

## 3. Proposed derivation (the objective method)

For one initiative, one period and one currency:

```
Value  V = [ (N_observed − N_counterfactual) × U  +  N_observed × (K_counterfactual − K_observed) ] × A  −  H
Cost   C = reconciled model usage + infrastructure + implementation + oversight + labor   (same period, same currency)
Value / cost = V ÷ C          ROI = (V − C) ÷ C
```

| Term | Definition | Objective source | Who may set it |
|---|---|---|---|
| `N_observed` | Count of successful outcomes in the period that meet the **pre-approved quality condition** | Outcome events from the system of record (ticketing, CRM, claims, CI), joined to traces and billing by ID, through a connector at **Reconciled** (ADR-0002 D4); `successfulOutcomeCount` in `durable.ts` already applies the quality gate | No one types it; it is computed |
| `N_counterfactual` | Outcomes that would have happened without the AI | In order of strength: (1) a **holdout or control group** run in the same period; (2) a **pre-registered baseline** from an equal-length prior period, normalized for volume; (3) none, which makes the figure at best `projected` | Method fixed in the outcome registration **before** the observation period starts |
| `U` | Money value of one incremental outcome | A **unit-value register** owned by finance: amount, currency, effective dates, source document, and whether it is revenue (then × contribution margin) or cost avoided | Finance owner; approved by someone other than the workload team |
| `K_counterfactual`, `K_observed` | Cost per outcome of the work **other than the AI's own full cost `C`**: the replaced process without the AI, and the remaining process with it (for example, staff handling time per ticket × a loaded labor rate) | Measured unit costs from the system of record (time tracking, ticket handling time, vendor invoices) priced with rates from the finance register; `K_counterfactual` from the same holdout or pre-registered baseline as `N_counterfactual` | Method fixed in the registration; rates owned by finance |
| `A` | Share of the improvement credited to the AI | 100% only with a holdout (the difference is the attribution); otherwise a stated, justified share, never a silent default | Set in the registration; changed only through a new, reviewed registration |
| `H` | Incremental cost of failed or harmful outcomes | (quality-failed events observed − quality-failed events in the counterfactual) × a harm unit value from the same register, so harm is incremental like the benefit term | Computed |
| `C` | Full cost | `cost_facts_published` (reconciled batches only, which needs each batch's reconciliation state; the reader cannot see it until the batch-status view of migration 0005 exists) + supplemental costs, each with its own evidence status | Computed; supplemental costs verified by a second person |

The two benefit terms are separate on purpose. The first counts **more output** (incremental outcomes × their value). The second counts **cheaper output** (cost avoided on the outcomes that happened). If the AI replaces existing work without changing the volume, the first term is zero and all the value comes from the second. Example: 100 outcomes either way, $10 of manual cost per outcome before, $0 after, AI full cost `C` = $200. Then V = 100 × $10 = $1,000, Value / cost = 5.0× and ROI = 400% (a net $800 saved). The AI's own cost is never in `K`; it is only in `C`, so it is not counted twice.

Report a **range**, not only a point: low and high values from the uncertainty in `N_counterfactual` (holdout confidence interval or baseline variance), in `U` and in `K`. Proposed: the Value / cost, ROI and evidence status use the **low end** (the conservative point), and the range is shown beside it.

**Relation to today's money paths.** Proposed: the two benefit terms of `V` replace both the per-event `outcome_events.validated_benefit` and the benefit-claim sums that `durable.valueToCostRatio` divides by cost. They stay only as inputs to reconcile against during a migration (decision 8 in §8).

## 4. Evidence status, decided by rule, not by choice

The status is computed from the inputs; nobody selects it.

| Status | Required for every input |
|---|---|
| `measured` | `N_observed` from system-of-record events via a Reconciled connector; `N_counterfactual` from a holdout or a pre-registered, volume-normalized baseline; `U` and the rates in `K` from the approved register; `K_observed` and `K_counterfactual` from measured unit costs and the same counterfactual method; `A` from the registration; cost reconciled and supplemental costs verified; all in the same period and currency; verified by a person who is neither the recorder nor the workload owner |
| `projected` | Any input is a forecast or model output (an extrapolated baseline, an estimated unit value, a partial period) |
| `assumed` | Any input was typed without a source, or has no status |

- The **weakest input wins**, and an input with **no status counts as `assumed`**, not as "does not vote".
- A group takes the weakest status of its members (unchanged).

## 5. Independence controls

1. **Separation of duties.** The recorder, the verifier and the workload owner are three different people; finance owns unit values.
2. **Pre-registration.** Metric, quality condition, counterfactual method, attribution, unit value and the unit-cost method (`K`) are fixed and approved before the observation period starts. Changing any of them starts a new registration and clears verification (the simulation already clears verification on period changes).
3. **Recompute from source.** Value is derived on the server from stored records. A client never supplies a value or a status.
4. **Immutable audit trail.** Every change stores the before and after values, the actor and the reason. Verified claims cannot be overwritten or deleted, only superseded with review (the durable schema already blocks deleting verified claims; edits are allowed there and clear verification).
5. **Period and currency alignment.** Value and cost share one period and one currency; no cross-currency sums.
6. **Show the inputs.** Every value figure in the UI, reports and Frank links to its counts, counterfactual, unit value, attribution, period and status.

## 6. What already exists, and what is missing

| Building block | Exists | Missing |
|---|---|---|
| Quality-gated outcome counts | `durable.ts:104-120`, view `outcome_period_counts` | A writer that ingests system-of-record events; the view applies the quality threshold neither to its counts nor to its benefit sum |
| Four-eyes on claims and registrations | Migration 0004 checks and triggers | Binding the ledger and its four-eyes checks to the real engagement identities (directory users with password or OIDC sessions, `src/engagement/auth/`); the outcome commands use simulated ones |
| Weakest-status rule | `valueEvidence.ts` | Unmarked must count as `assumed` |
| Measured-only-from-reconciled rule | ADR-0002 D4 (design) | Implementation |
| Unit-value register | — | Table, ownership and approval flow |
| Counterfactual | Before/after on one metric | Holdout support, volume normalization, conversion to money |
| Reader access | `ratio_reader` SELECT on the published outcome views `outcome_events_published` and `outcome_period_counts` (migration 0004, `READER_GRANTS`) | Reader access to registrations, benefit evidence and supplemental costs, and the batch-status view, blocked by the 0005–0019 migration-ledger decision (ADR-0001 §12) |

## 7. Honesty fixes that need no new data

These make today's figures accurate about what they are, without waiting for the full method:

1. **Chat route:** derive value on the server, or mark any browser-supplied value `assumed`, on both the mock path and the live-provider prompt (`buildSystemPrompt` forwards the client's status today).
2. **Unmarked counts as `assumed`** in `weakestStatus` and is shown as such.
3. **Show the evidence status** next to the portfolio Value / cost on the Mission page and wherever `derivePortfolioRatio` is shown.
4. **Unmatched ingested cost rows:** value N/A with a reason, not 0.
5. **Simulation:** store before and after values in the audit; block overwriting or deleting a verified measure without review; give each measure a period.
6. **Demo headline:** label it "illustrative (demo data)", since it is derived from a ratio constant.

## 8. Decisions for the owner

1. Adopt the formula in §3 and the rule-based status in §4 as the definition of value.
2. Who owns unit values (proposed: finance), and who approves them.
3. The minimum evidence for `measured`: holdout only, or also a pre-registered, volume-normalized baseline.
4. The attribution rule when there is no holdout (proposed: an explicit share with justification; never a 100% default).
5. Whether the 3× target and the full-cost rates stay fixed policy constants or become configurable, owned settings.
6. Whether to do the §7 honesty fixes now as small, separate PRs.
7. Whether this note becomes an ADR (it would add contracts: the unit-value register and value derivation records).
8. Whether the two benefit terms of `V` (more output, cheaper output) replace today's per-event `validated_benefit` and the durable benefit claims, and how the two are reconciled during the change.
