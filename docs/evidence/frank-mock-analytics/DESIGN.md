# Frank mock: ROI, EBITDA and migration analytics (design note)

Status: design for review. The model stays on the mock. No network, no LLM, no new
dependency, no environment or flag change.

## What

Frank's offline mock (`src/ai/MockAIClient.ts`) classifies only the last user message with
five keyword regexes. Two failures were verified on the hosted demo:

1. "Who or which team is driving up the highest cost?" answers with a workload (the mock has no
   notion of team).
2. "What about its workload activities and ROI?" falls through to the help text (no keyword, and
   "its" is meaningless because the mock has no memory).

The owner wants Frank to prove out ROI analysis on the mock data, from simple to drill-down
questions, per team: ROI, EBITDA effect after spend goes down, and cost to realized savings
after moving from a public API model to a private open model.

This change makes the mock a small deterministic analytics engine over the seeded data:

- conversation memory (a typed focus: portfolio, team, workload or model) derived from the
  message history that the chat route already passes;
- new intents: ROI, team ranking, drill-down ladder, EBITDA impact, public-API to private-model
  migration, team- and workload-aware savings, a capability ladder, and an honest
  unsupported/clarify answer;
- honesty on every new answer: it says it is computed from seeded demo data by a deterministic
  mock, lists its assumptions, and shows the evidence status of every value ratio it cites.

## Why a mock first

The mock is the only AI path the hosted demo runs. A demo that cannot answer the owner's
questions cannot prove the product's thesis (cost is always paired with value, and a claim
carries its evidence status). Doing it deterministically lets every number be checked by an
independent oracle in tests.

## What the seed holds

From `src/data/workloads.ts`, `models.ts`, `alerts.ts`, `budgets.ts`, `src/costsource/seed.ts`
and `src/outcomes/model.ts`:

| Fact | Where | Reaches the mock today? |
| --- | --- | --- |
| Workload id, name, model, monthly spend, value ratio, evidence status, demand shape, gates passed, MoM cost trend, cache hit rate | `AIWorkloadSnapshot` | yes |
| Initiative status, budget consumed %, savings opportunity | `AIInitiativeSnapshot` | yes |
| Team (7 teams, 11 workloads) | `Workload.team` | NO, added to the wire |
| Provider | `Workload.model_provider` | NO, added |
| Monthly value in dollars (defensible numerator) | `Workload.value.total_value` | NO, added (ratio x spend loses rounding) |
| Daily calls, input/output/cached tokens today | `Workload.costs`, `outputs` | NO, added |
| Monthly budget | `Workload.costs.monthly_budget` | NO, added |
| Per-workload alerts | `ALERTS` | NO, added (compact) |
| Per-1M-token list prices (in, out, cached) | `MODEL_REGISTRY` | read directly (static registry) |
| Model quality hint | `MODEL_QUALITY_NOTE` | read directly |

The wire additions are optional fields on `AIWorkloadSnapshot`. If a client omits them the mock
falls back to the bundled seed by workload id, and if the id is unknown the dependent answer
says the field is missing rather than guessing. The live system prompt is not changed.

## What the seed does NOT hold (the mock must say so, never invent)

- No revenue, EBITDA, margin or any financial baseline for a team or the company.
- No hosting, GPU, or self-hosted model cost, and no open model in the registry.
- No quality, latency or accuracy evidence for any open model.
- No measured value anywhere: every value component is `assumed`, so every headline ratio is
  `assumed`. Outcome records are simulated fixtures (`seedOutcome`), their value measures are
  `assumed`. Therefore realized savings are 0 everywhere.
- No prior-month spend actuals. The only history is `cost_trend_pct` (labelled MoM in the cost
  source findings), from which a prior spend can be implied.
- No per-user or per-project attribution below workload; no forecast in the mock.

## Assumption constants (illustrative, not data)

One exported object `SELF_HOST_ASSUMPTIONS` in `src/ai/mock/assumptions.ts`, echoed in every
migration answer and overridable from the question text:

| Key | Default | Meaning |
| --- | --- | --- |
| `gpuHourlyUsd` | 2.50 | price of one GPU-hour |
| `gpuCount` | auto (min 2) | GPUs sized to cover the volume, floor 2 for availability |
| `utilisation` | 0.50 | share of peak throughput that is sustained |
| `tokensPerSecondPerGpu` | 1000 | blended input+output tokens/s at 100% utilisation |
| `hoursPerMonth` | 730 | always-on |
| `opsOverheadPct` | 0.25 | ops and monitoring on top of GPU cost |
| `migrationOneTimeUsd` | 25000 | one-time migration cost |

Hand check (default, Customer Support Agent): tokens/month = (48.0M in + 13.6M out + 9.5M cached)
x 30 = 2.133B. Capacity per GPU = 1000 x 0.5 x 3600 x 730 = 1.314B, so 2 GPUs. Self-host =
2 x 2.50 x 730 = 3,650 + 25% = 4,562.50. List-price API cost = 4,320 + 6,120 + 85.50 = 10,525.50.
Saving 5,963.00 per month; payback 25,000 / 5,963 = 4.2 months.

## Rules that keep answers honest

- Value ratio, value dollars and cost always appear together with the evidence status
  (R4 plus audit C1/C2). A group's status is the weakest status of its members.
- EBITDA: a recurring operating-cost reduction raises EBITDA one-for-one, pre-tax. That is an
  accounting identity under the assumption the spend is operating expense; it is marked
  "(assumption)". Percentages and margin points are computed only from a baseline the user
  typed in the question; otherwise the answer names the missing input. A baseline is never
  assumed.
- Migration: the saving is "projected" (it rests on assumptions). Realized savings are $0
  until measured outcome evidence exists, which the seed does not hold. The answer carries a
  quality and latency caveat and says the seed holds no quality evidence for the open model.
- Unsupported questions get a plain "cannot answer from this data" plus the closest supported
  questions. No fabrication.

## Memory

`deriveFocus` (in `memory.ts`) scans at most the last 12 prior messages, newest first. User messages are scanned
for entity mentions (first 500 chars); assistant messages only in their first line (every answer
puts exactly one subject in its header line). Pronouns (it, its, they, them, this/that/the same
team, there) and elliptical openers ("and ...", "what about ...") resolve to that focus. An
explicit entity in the current question always wins. A pronoun with no focus gets a clarifying
answer, never a guess. No client state beyond the messages already sent is trusted.

## Structure

`src/ai/mock/` pure modules, all under about 400 lines: `world` (context to typed facts), `memory` (typed focus from history),
`entities`, `intents`, `parse` (numbers, money, overrides), `assumptions`, `calc`
(rollups, ROI, EBITDA, migration), `format`, `answers*`, `legacy` (the five existing answers,
verbatim), `respond` (router). `MockAIClient` keeps its public API.

## Deliberately NOT done

- No LLM, no network, no new dependency, no env or flag change, no live-path change.
- No forecasting, no multi-entity comparison tables beyond rankings, no what-if on model swaps
  to a named registry model (the existing comparison view owns that).
- No UI change. Answers are plain text with the same light markdown the drawer already shows.
- The five legacy intents keep byte-identical output for their current example questions; they
  are not given the new provenance footer (see open decisions).

## Decision log

1. Team and the other fields travel on the wire as optional snapshot fields, with a seed
   fallback by id. Alternative (mock imports the seed only) rejected: it would break for any
   context that is not the bundled seed.
2. Rollups are value-dollar weighted (sum value / sum spend), never a mean of ratios.
3. Percentages in "spend went down 20%" are taken against the group's current seeded monthly
   spend. Stated in the answer as an assumption.
4. Team and portfolio migration is one pooled cluster with one migration cost, not a sum of
   per-workload clusters.
5. A baseline typed in the question is assumed annual unless the user says monthly.
6. Monthly token volume = today's tokens x 30 (the 30-day convention used by `modelCompare` and
   the budget profile). The seeded `monthly_spend` is an independent run-rate and differs from
   list-price volume cost; the migration answer shows both and does the comparison on list
   prices so the two sides use the same basis.

## Owner decisions OPEN

1. Should the five legacy answers also carry the provenance footer? (Kept byte-identical now.)
2. Are the illustrative GPU defaults acceptable for the demo, or should the owner supply house
   numbers?
3. Is `cost_trend_pct` an acceptable stand-in for "spending went down" when the user states no
   amount?
4. Should a stated percentage be against prior spend rather than current spend?
5. Should the bare greeting keep the legacy help text? (Kept.)
