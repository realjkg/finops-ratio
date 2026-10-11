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
