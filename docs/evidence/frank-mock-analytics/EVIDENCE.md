# Evidence: Frank mock analytics

Base: `origin/main` at 62bd8ed. Branch: `feat/frank-mock-roi-analytics`.

## 1. RED (tests committed failing, before any implementation)

Command (from the repo root):

```
npx vitest run src/ai
```

Result at the RED commit: `Test Files 6 failed | 4 passed (10)`, `Tests 94 failed | 52 passed (146)`.

| File | Passed | Failed | Notes |
| --- | ---: | ---: | --- |
| `src/ai/buildAIContext.test.ts` (existing) | 3 | 0 | unchanged |
| `src/ai/chatRoute.test.ts` (existing) | 18 | 0 | unchanged |
| `src/ai/mockAIClient.test.ts` (existing) | 6 | 0 | unchanged |
| `src/ai/providers.test.ts` (existing) | 7 | 0 | unchanged |
| `src/ai/mock/proofMatrix.test.ts` (new) | 1 | 45 | 40 oracle-backed questions + ladder checks |
| `src/ai/mock/ebitda.test.ts` (new) | 0 | 14 | with and without a user baseline |
| `src/ai/mock/migration.test.ts` (new) | 1 | 13 | defaults and overrides, hand arithmetic in comments |
| `src/ai/mock/honesty.test.ts` (new) | 2 | 10 | |
| `src/ai/mock/regression.test.ts` (new) | 8 | 3 | the 8 passes are the characterization of the five existing intents (must stay green); the 3 failures are the screenshot cases |
| `src/ai/mock/robustness.test.ts` (new) | 6 | 9 | the 6 passes are "does not hang or throw" checks that the current mock satisfies trivially |

New tests: 112 (18 pass because they characterize current behavior or trivially hold, 94 fail).
Existing tests: 34, all passing.

Why red is meaningful: the test files import only the existing public API (`MockAIClient`,
`buildAIContext`) and the seed. They fail on assertions about the new behavior, not on missing
modules. One exception by design: `migration.test.ts` reads
`src/ai/mock/assumptions.ts` to check the assumption constant's doc comment, which fails until
that file exists.

Type check at the RED commit: `npx tsc --noEmit` is clean.

The oracle (`src/ai/mock/__testkit__/oracle.ts`) computes every expected number straight from
`WORKLOADS`, `ALERTS` and `MODEL_REGISTRY` and imports nothing from the code under test.

## 2. GREEN (after the implementation commit)

```
npx vitest run src/ai
```

Result: all `src/ai` suites pass, including the 112 new tests, the 3 new route tests
(`src/ai/mock/route.test.ts`) and the 34 existing tests, unchanged.

One test-authoring fix between RED and GREEN, recorded for honesty: case "08 Legal team ROI" in
`proofMatrix.test.ts` had two hand-coded expectations ("Strongest: Contract Redliner",
"Weakest: Document Summarizer") that were wrong (the seed makes Document Summarizer the stronger
workload). They were removed from that case; the oracle-driven test `08b` already asserts
strongest and weakest from the seed.

Quality gates on the final tree:

| Command | Result |
| --- | --- |
| `npm run lint` | clean (no output) |
| `npm run typecheck` | clean |
| `npx vitest run` (full) | 158 files, 3079 tests, all passed |
| `npx vitest run src/ai/chatRoute.test.ts src/ai/mock/route.test.ts` | pass (18 existing + 3 new) |
| `npm run build` | compiled successfully (about 27 s) |

Browser check: the app was started locally in mock mode (`next dev`, port 3123) and the six
screenshot-style questions were asked in the real drawer with Playwright's pre-installed Chromium
(screenshots kept outside the repo). The drawer showed the team answer, the drill-down on the
follow-up, the EBITDA answer for "that team", the migration answer, the override follow-up, and the
capability ladder.

## 3. Mutation check

Command: `node docs/evidence/frank-mock-analytics/mutate.mjs` (copies the tree, applies one
mutation at a time to the copy, runs `src/ai/mock` against it, restores the file). Baseline on the
unmutated copy: 121 tests, 0 failing.

Result: **25 of 25 mutants killed, 0 survived.**

| Mutant | What it models | Failing tests | First killer |
| --- | --- | ---: | --- |
| `roi-swap-cost-value` | ROI ratio uses cost / value | 13 | migration.test.ts > pairs the cost with the value ratio and evidence status (R4) |
| `roi-pct-sign` | ROI percent sign flipped | 1 | proofMatrix.test.ts > 11 Risk & Trust ROI is negative and hon… |
| `mean-of-ratios` | group ratio as a mean of ratios | 9 | proofMatrix.test.ts > 01 portfolio ROI |
| `skip-team-grouping` | team scope returns every workload | 16 | ebitda.test.ts > percent reductions are taken against current seeded spend (hand: 20% x 4,270 = 854/mo = 10,24 |
| `rank-grouping` | team ranking rows not grouped | 5 | proofMatrix.test.ts > 03 best-ROI team |
| `team-rank-routing-off` | team questions fall through to workload answers | 14 | honesty.test.ts > states basis (seeded demo data, deterministic mock, no LLM) on every new answer |
| `ignore-history` | memory ignores the message history | 15 | proofMatrix.test.ts > 27 screenshot follow-up: team then its … |
| `unbounded-memory` | memory window unbounded | 1 | robustness.test.ts > forgets a subject beyond the bounded window (12 prior messages) and asks instead of guess |
| `assumed-as-measured` | every evidence status read as measured | 18 | ebitda.test.ts > without a baseline: identity only, labelled assumption, names the missing input |
| `weakest-link-first-member` | group evidence = first member, not the weakest | 2 | honesty.test.ts > a group takes the WEAKEST status of its members (one measured + one assumed -> assumed) |
| `evidence-suffix-dropped` | evidence status removed from answers | 20 | ebitda.test.ts > without a baseline: identity only, labelled assumption, names the missing input |
| `ignore-overrides` | migration ignores user overrides | 7 | migration.test.ts > 8 GPUs at $2.50 per GPU hour, migration costs $40k (hand: 8x2.50x730=14,600 +25% = 18,250; |
| `payback-division-dropped` | payback is not divided by the saving | 2 | migration.test.ts > prints current vs projected monthly cost, saving, break-even, payback |
| `break-even-inverted` | break-even volume formula inverted | 2 | migration.test.ts > prints current vs projected monthly cost, saving, break-even, payback |
| `ops-overhead-dropped` | ops overhead ignored | 5 | migration.test.ts > prints current vs projected monthly cost, saving, break-even, payback |
| `gpu-min-floor-dropped` | availability floor on GPUs removed | 1 | migration.test.ts > a workload that is already cheaper on API shows NO saving, honestly (Marketing Content Gen |
| `cached-tokens-ignored` | cached tokens left out of the volume | 3 | migration.test.ts > prints current vs projected monthly cost, saving, break-even, payback |
| `registry-in-out-swapped` | input tokens priced at the output rate | 5 | migration.test.ts > prints current vs projected monthly cost, saving, break-even, payback |
| `realized-savings-nonzero` | realized savings claimed without evidence | 5 | honesty.test.ts > even when value evidence is measured, migration savings are projected and realized stays $0 |
| `ebitda-not-annualized` | monthly reduction not annualized | 6 | ebitda.test.ts > with a user EBITDA baseline: computes the % uplift (hand: 24,000 / 4,200,000 = 0.571%) |
| `ebitda-fabricated-baseline` | an EBITDA baseline invented when none is given | 5 | ebitda.test.ts > without a baseline: identity only, labelled assumption, names the missing input |
| `ebitda-negative-pct` | percent computed on a negative baseline | 1 | ebitda.test.ts > negative baseline: absolute improvement only |
| `gpu-count-validation-dropped` | zero or negative GPUs accepted | 2 | migration.test.ts > invalid overrides are ignored and said so: zero, negative, 1e999, NaN-ish |
| `money-range-dropped` | non-finite money accepted | 1 | ebitda.test.ts > absurd numbers are rejected, not computed (1e999) |
| `legacy-reordered` | legacy cost-driver answer changed | 4 | mockAIClient.test.ts > cites cost paired with value ratio (R4) |

## 4. Governance classification

Command: `node scripts/governance/classify-risk.mjs --git origin/main...HEAD`

Result: `risk: restricted`, classes `["unclassified"]`, 24 reasons, all `fail-closed-default`.
That is expected and not a finding against the change: the classifier only treats docs
markdown, `src/components/**` and `*.test.*` files as low, so every non-test file under
`src/ai/**` (21 files) and the two helper files (`__testkit__/*.ts`, `mutate.mjs`) are
unclassified and therefore restricted. No rule for secrets, network egress, migrations,
dependencies, financial semantics paths, routes or deployment matches. (An earlier draft tripped
two path/content heuristics by accident, a file named `focus.ts` and a dynamic `import(` in a
test; both were removed rather than argued with.) The PR needs the restricted review path.

## 5. Rollback

`git diff origin/main HEAD` reverse-applied onto HEAD's tree in a scratch index yields exactly
`origin/main^{tree}` (checked with a scratch `GIT_INDEX_FILE`, `git apply -R --cached`,
`git write-tree`). The change is additive except for four small edits: three optional wire
fields in `AIClient.ts`, their population in `buildAIContext.ts`, the re-export in `index.ts`,
and `MockAIClient.ts` delegating to `src/ai/mock`. Reverting the merge restores the previous
mock. No data, environment, flag, dependency or route change is involved.

## 6. Challenger round (PR #99): RED then GREEN

The challenger requested changes (0 High, 5 Medium, 6 Low). Tests were written first in
`src/ai/mock/hardening.test.ts` and committed failing.

Command: `npx vitest run src/ai/mock/hardening.test.ts`

RED (before the fixes): 25 failed of 49 tests. The 24 that pass are the surviving-mutant tests (M4
a to f, which pin existing behavior the earlier suite did not) and the pinned fallback (L3), so the
failures are the crashes, missing warnings, silent substitutions, forged lines and unbounded
output. The five route tests time out because the handler returns 500 for prototype-key wire strings.
