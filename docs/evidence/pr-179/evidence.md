# Merge evidence: PR #179

Attests code SHA `cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa` (tree `c0e95652468dd96eac0395cbcb8374193ae4d432`) against base `f7108e3c0a0826706698711cdd417091ff9e3cd6` (tree `c354993e398db5ce7d76f1224faa4ebab0501732`), merge-base `f7108e3c0a0826706698711cdd417091ff9e3cd6`.
Generated 2026-11-05T01:13:08.149Z by `node scripts/evidence/collect-pr-evidence.mjs --base f7108e3 --head cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa --pr 179`. Node v22.23.4, npm 10.9.9, Linux 6.18.44-fc-v236 x64.

This file attests code SHA `cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa`. A commit that adds it must change only `docs/evidence/pr-179/`.

## Charter

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | All gates green on the head SHA (lint, typecheck, unit + integration tests, migrations up/down where defined, build) | **NOT RUN** | 9 PASS, 1 N/A, 1 NOT RUN (see Known gaps) |
| 2 | Challenger re-review passed with zero open High findings | **PENDING (orchestrator)** | Review link: <to be added by the orchestrator> |
| 3 | Operational evidence complete (exact commands, results, fixture provenance, known gaps) | **PASS** | Commands, exit codes, durations and log hashes below; 3 changed fixture file(s) recomputed with BigInt, determinism PASS; 2 known gap(s) listed |
| 4 | Rollback verified in test (procedure + result) | **PASS** | See "Rollback in test" |
| 5 | Merge decision logged with reasoning in the PR body | **PENDING (orchestrator)** | Decision: <to be written by the orchestrator in the PR body> |

## Gates

| Gate | Command | Status | Exit | Duration | Result | Log sha256 |
|---|---|---|---|---|---|---|
| npm ci | `npm ci` | **PASS** | 0 | 35.8s | exit 0 | `f2fe469a83a78152…` |
| lint | `npm run lint` | **PASS** | 0 | 17.1s | exit 0 | `1db562e776713599…` |
| typecheck (app) | `npx tsc --noEmit` | **PASS** | 0 | 5.2s | exit 0 | `e3b0c44298fc1c14…` |
| typecheck (worker) | `npx tsc -p tsconfig.worker.json --noEmit` | **PASS** | 0 | 3.6s | exit 0 | `e3b0c44298fc1c14…` |
| unit tests (vitest) | `npx vitest run --cache=false` | **PASS** | 0 | 142.6s | 299/299 files, 5058 passed, 0 failed, 0 skipped | `ced2c6bb59c0a9fd…` |
| integration tests (Postgres) | `npm run test:db` | **NOT RUN** | — | — | NOT RUN: no database in this environment (RATIO_TEST_DATABASE_URL unset) | — |
| migrations up/down/up (changed) | `(none)` | **N/A** | — | — | N/A: no migrations changed | — |
| build | `npm run build` | **PASS** | 0 | 7.7s | exit 0 | `fc247487c00444a8…` |
| bundle check | `npm run check:bundle` | **PASS** | 0 | 0.3s | exit 0 | `c3d6c7390f522802…` |
| Playwright simulation suite | `npx playwright test --config playwright.simulation.config.ts` | **PASS** | 0 | 261.8s | 62 passed, 0 failed, 0 skipped, 0 flaky | `7599bbf83dc2ab9a…` |
| Playwright engagement report spec | `npx playwright test --config playwright.engagement.config.ts` | **PASS** | 0 | 9.3s | 7 passed, 0 failed, 0 skipped, 0 flaky | `3703bc0a940b4072…` |

### Informational (not a charter gate)

| Check | Command | Status | Result |
|---|---|---|---|
| migrations smoke, full set (informational) | `worker migrate; migrate --down ALL; migrate` | **N/A** | N/A (informational): no scratch database (RATIO_MIGRATE_DATABASE_URL unset) |

## Fixture provenance

| Path | sha256 base | sha256 head | Rows base → head | Recomputed totals (head, BigInt) | Matches stated | Numbers unchanged |
|---|---|---|---|---|---|---|
| `src/demo/apiDatasets/data/syn-on-premise-api.json` | `8e63c6c154be` | `7b3ee824b961` | 106 → 106 | USD: 106 rows, billed 1787.6600000000, effective 2758.5057000000 | yes | yes |
| `src/demo/apiDatasets/data/syn-private-cloud-api.json` | `397f8d8a19cc` | `20b21bd341d3` | 109 → 109 | EUR: 109 rows, billed 2338.9961000000, effective 1738.9961000000 | yes | yes |
| `src/demo/apiDatasets/data/syn-public-cloud-api.json` | `56cd3652d0e4` | `25f3f5b13257` | 108 → 108 | USD: 108 rows, billed 2830.2211680000, effective 2430.2211680000 | yes | yes |

Determinism: `npx tsx scripts/generate-demo-datasets.ts && git diff --exit-code -- src/demo/apiDatasets/data/ && test -z "$(git status --porcelain -- src/demo/apiDatasets/data/)"` then `git diff --exit-code`: **PASS**.

## Rollback in test

Test: `git worktree add --detach ../ui3-evidence-logs/rollback-worktree cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa`; `git diff --binary f7108e3c0a0826706698711cdd417091ff9e3cd6 cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa > pr.diff`; in the worktree `git apply -R --binary pr.diff && git add -A && git write-tree`; compare with the base tree hash; then run lint, typecheck (app and worker) and the full vitest suite there; remove the worktree by its exact path.

Result: **PASS**. Reverse-applied tree c354993e398db5ce7d76f1224faa4ebab0501732 equals the base tree c354993e398db5ce7d76f1224faa4ebab0501732. On the rolled-back tree: dependencies PASS (exit 0); lint PASS (exit 0); typecheck PASS (exit 0); unit tests PASS (293/293 files, 4999 passed, 0 failed, 0 skipped).

Production rollback: after merge, `git revert -m 1 <merge sha>` (merge commit) or `git revert <squash sha>` (squash), or reverse-apply `git diff f7108e3c0a0826706698711cdd417091ff9e3cd6 cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa` with `git apply -R`; no data, schema or config migration needs undoing.

## Known gaps

- integration tests (Postgres): NOT RUN: no database in this environment (RATIO_TEST_DATABASE_URL unset)
- next-env.d.ts was rewritten by the Playwright build (its distDir) and restored from HEAD after the run.

## Gate log tails

<details><summary>npm ci (last 40 lines)</summary>

```
npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.
npm warn deprecated rimraf@2.7.1: Rimraf versions prior to v4 are no longer supported
npm warn deprecated lodash.isequal@4.5.0: This package is deprecated. Use require('node:util').isDeepStrictEqual instead.
npm warn deprecated glob@7.2.3: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me
npm warn deprecated fstream@1.0.12: This package is no longer supported.

added 536 packages, and audited 537 packages in 35s

99 packages are looking for funding
  run `npm fund` for details

17 vulnerabilities (12 moderate, 4 high, 1 critical)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```

</details>

<details><summary>lint (last 40 lines)</summary>

```

> ratio@1.0.0 lint
> eslint .
```

</details>

<details><summary>unit tests (vitest) (last 40 lines)</summary>

```
(Use `node --trace-warnings ...` to show where the warning was created)
(node:2331) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:2755) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3660) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3681) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3694) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3702) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3674) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:3958) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4101) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4370) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4467) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4482) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4496) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4510) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:4644) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  299 passed (299)
      Tests  5058 passed (5058)
   Start at  01:14:10
   Duration  141.73s (tests 83%, import 10%, transform 4%, environment 3%)

    Isolate  299 workers spawned · ~184ms startup each (spawn + environment, per file)
             at least ~18.11s faster with isolate: false — reuses workers across files instead of one per file
```

</details>

<details><summary>build (last 40 lines)</summary>

```
├ ƒ /api/v1/a2a/handshake
├ ƒ /api/v1/ai/chat
├ ƒ /api/v1/cm/change
├ ƒ /api/v1/connectors
├ ƒ /api/v1/costs/published
├ ƒ /api/v1/finio/export
├ ƒ /api/v1/reports/engagement
├ ƒ /api/v1/reports/facts
├ ƒ /api/v1/simulation/chat
├ ƒ /api/v1/simulation/command
├ ƒ /api/v1/simulation/frank
├ ƒ /api/v1/simulation/operations
├ ƒ /api/v1/simulation/report
├ ƒ /api/v1/simulation/session
├ ƒ /api/v1/simulation/state
├ ƒ /api/v1/simulation/status
├ ○ /attribution
├ ○ /connectors
├ ○ /costsource
├ ○ /demo
├ ƒ /engagement
├ ○ /finio
├ ○ /finio/demo
├ ○ /frameworks
├ ○ /hello
├ ○ /mission
├ ○ /outcomes
├ ○ /overview
├ ○ /prediction
├ ○ /reports
├ ○ /simulation
├ ○ /tokenomics
├ ○ /workloads
└ ○ /workspace

ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

</details>

<details><summary>bundle check (last 40 lines)</summary>

```

> ratio@1.0.0 check:bundle
> node scripts/check-next-bundle.mjs

{"type":"ratio.bundle-check","pass":true,"stats":{"clientFiles":147,"serverFiles":171},"problems":[]}
```

</details>

<details><summary>Playwright simulation suite (last 40 lines)</summary>

```
  ✓  25 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 320px (finding card and KPI card) (1.1s)
  ✓  26 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 360px (finding card and KPI card) (1.2s)
  ✓  27 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 390px (finding card and KPI card) (1.2s)
  ✓  28 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 768px (finding card and KPI card) (1.2s)
  ✓  29 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 1440px (finding card and KPI card) (1.2s)
  ✓  30 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 320px, 100% text (2.1s)
  ✓  31 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 360px, 100% text (2.2s)
  ✓  32 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 390px, 100% text (2.1s)
  ✓  33 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 320px, 130% text (2.2s)
  ✓  34 tests/simulation/phone-ui.spec.ts:59:5 › the strip is reachable by keyboard: tabbing to the last item brings it fully into view (842ms)
  ✓  35 tests/simulation/phone-ui.spec.ts:75:7 › primary controls have 44px touch targets at 320px (783ms)
  ✓  36 tests/simulation/phone-ui.spec.ts:75:7 › primary controls have 44px touch targets at 360px (797ms)
  ✓  37 tests/simulation/phone-ui.spec.ts:75:7 › primary controls have 44px touch targets at 390px (821ms)
  ✓  38 tests/simulation/phone-ui.spec.ts:103:7 › top bar: logo, Demo badge, Display, Text and Ask Frank share one row at 320px, with 44px targets (2.0s)
  ✓  39 tests/simulation/phone-ui.spec.ts:103:7 › top bar: logo, Demo badge, Display, Text and Ask Frank share one row at 360px, with 44px targets (2.1s)
  ✓  40 tests/simulation/phone-ui.spec.ts:103:7 › top bar: logo, Demo badge, Display, Text and Ask Frank share one row at 390px, with 44px targets (2.0s)
  ✓  41 tests/simulation/phone-ui.spec.ts:134:5 › Estimated value: opening it describes the button and announces the text; Escape inside the Frank panel leaves it open (1.1s)
  ✓  42 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 390px (1.5s)
  ✓  43 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 768px (1.5s)
  ✓  44 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 1024px (1.6s)
  ✓  45 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 1280px (1.5s)
  ✓  46 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 1440px (1.6s)
  ✓  47 tests/simulation/theme-dismissal.spec.ts:3:7 › theme editor saves and dismisses without losing the selected theme at 390px (1.4s)
  ✓  48 tests/simulation/theme-dismissal.spec.ts:3:7 › theme editor saves and dismisses without losing the selected theme at 1440px (1.6s)
  ✓  49 tests/simulation/theme-mobile.spec.ts:7:7 › theme switcher fits the top bar at 320px (1.7s)
  ✓  50 tests/simulation/theme-mobile.spec.ts:7:7 › theme switcher fits the top bar at 390px (1.9s)
  ✓  51 tests/simulation/theme-mobile.spec.ts:7:7 › theme switcher fits the top bar at 430px (1.9s)
  ✓  52 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 1440px (5.1s)
  ✓  53 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 390px (5.0s)
  ✓  54 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (system-mono) has no overflow, clipping or overlap at 1440px (5.2s)
  ✓  55 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (system-mono) has no overflow, clipping or overlap at 390px (5.2s)
  ✓  56 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 320px (4.9s)
  ✓  57 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 360px (4.9s)
  ✓  58 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 768px (5.0s)
  ✓  59 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 1024px (5.1s)
  ✓  60 tests/simulation/typography-layout.spec.ts:97:5 › both top-bar panels stay inside the viewport at 130% and 115% (7.3s)
  ✓  61 tests/simulation/z-agent-workflows.spec.ts:13:5 › embedded reviews recover interruptions and require independent human review (3.2s)
  ✓  62 tests/simulation/zz-frank.spec.ts:15:5 › Frank guides an accountable review, retains evidence boundaries and hands approval to another persona (2.3s)

  62 passed (4.3m)
```

</details>

<details><summary>Playwright engagement report spec (last 40 lines)</summary>

```
[WebServer] (node:7708) ExperimentalWarning: SQLite is an experimental feature and might change at any time
[WebServer] (Use `node --trace-warnings ...` to show where the warning was created)
[WebServer] (node:7715) ExperimentalWarning: SQLite is an experimental feature and might change at any time
[WebServer] (Use `node --trace-warnings ...` to show where the warning was created)

Running 7 tests using 1 worker

  ✓  1 tests/engagement/report-page.spec.ts:14:5 › anonymous: 401, no-store, Vary: Cookie, CSP enforced with no violation, only a sign-in link per enabled connection (1.2s)
[WebServer] {"tag":"gateway","event":"unhandled_error","requestId":"8dfb4fc8-7deb-4fc9-8961-abb000ecfde0","method":"GET","path":"/api/v1/reports/engagement","status":500,"error":"connect ECONNREFUSED 127.0.0.1:1"}
  ✓  2 tests/engagement/report-page.spec.ts:27:5 › analyst: report table and both exports; the real route is reached with the session (DB absent: fixed unavailable message) (838ms)
  ✓  3 tests/engagement/report-page.spec.ts:42:5 › viewer: no export links; the export route itself refuses the viewer (403) (694ms)
  ✓  4 tests/engagement/report-page.spec.ts:52:7 › WCAG AA text contrast on the signed-in page (light) (700ms)
  ✓  5 tests/engagement/report-page.spec.ts:52:7 › WCAG AA text contrast on the signed-in page (dark) (688ms)
  ✓  6 tests/engagement/report-page.spec.ts:52:7 › WCAG AA text contrast on the signed-in page (high-contrast) (694ms)
[WebServer] {"tag":"gateway","event":"unhandled_error","requestId":"d9a3448b-d7b7-4d47-8424-514998f5c63f","method":"GET","path":"/api/v1/reports/engagement","status":500,"error":"connect ECONNREFUSED 127.0.0.1:1"}
  ✓  7 tests/engagement/report-page.spec.ts:80:5 › engagement mode never shows the Demo badge (anonymous and signed in), and demo routes stay 404 (1.2s)

  7 passed (8.4s)
```

</details>

