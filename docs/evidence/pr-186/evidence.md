# Merge evidence: PR #186

Attests code SHA `c2f2b02bf4ab8adc39dcec8b710cdd7c92e7c9c1` (tree `265b5aacba3633201572591fa272106852ff4553`) against merge-base `e6eee947ba95d9ddf6f93ed64f081b461384d0a9` (tree `857af4cbbcf7afe8e81b9ae71c00fb366898796b`); requested base `origin/main` = `e6eee947ba95d9ddf6f93ed64f081b461384d0a9`.
Generated 2026-11-05T16:27:15.729Z by `node scripts/evidence/collect-pr-evidence.mjs --base origin/main --head c2f2b02bf4ab8adc39dcec8b710cdd7c92e7c9c1 --pr 186`. Node v22.23.4, npm 10.9.9, Linux 6.18.44-fc-v236 x64.
Collector: commit `c2f2b02bf4ab8adc39dcec8b710cdd7c92e7c9c1`, script sha256 `d925c4888420c49b…`, lib sha256 `d08282c31df04568…`, platform lib sha256 `35351ec54cf4657f…`.

This file attests code SHA `c2f2b02bf4ab8adc39dcec8b710cdd7c92e7c9c1`. A commit that adds it must change only `docs/evidence/pr-186/`.

## Charter

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | All gates green on the head SHA (lint, typecheck, unit + integration tests, migrations up/down where defined, build) | **NOT RUN** | 9 PASS, 1 N/A, 1 NOT RUN (see Known gaps) |
| 2 | Challenger re-review passed with zero open High findings | **PENDING (orchestrator)** | Review link: <to be added by the orchestrator> |
| 3 | Operational evidence complete (exact commands, results, fixture provenance, known gaps) | **PASS** | Commands, exit codes, durations and log hashes below; 0 changed fixture file(s) recomputed with BigInt, determinism N/A; 2 known gap(s) listed |
| 4 | Rollback verified in test (procedure + result) | **PASS** | See "Rollback in test" |
| 5 | Merge decision logged with reasoning in the PR body | **PENDING (orchestrator)** | Decision: <to be written by the orchestrator in the PR body> |

## Gates

| Gate | Command | Status | Exit | Duration | Result | Log sha256 |
|---|---|---|---|---|---|---|
| npm ci | `npm ci` | **PASS** | 0 | 32s | exit 0 | `516eb635bc1fe57d…` |
| lint | `npm run lint` | **PASS** | 0 | 22s | exit 0 | `c4f0db4f3945e89b…` |
| typecheck (app) | `npx tsc --noEmit` | **PASS** | 0 | 6.9s | exit 0 | `c80636726de2a497…` |
| typecheck (worker) | `npx tsc -p tsconfig.worker.json --noEmit` | **PASS** | 0 | 4.3s | exit 0 | `cd91f5f661f697ea…` |
| unit tests (vitest) | `npx vitest run --cache=false` | **PASS** | 0 | 161s | 318/318 files, 5376 passed, 0 failed, 0 skipped | `6eb6d9d651069ba5…` |
| integration tests (Postgres) | `npm run test:db` | **NOT RUN** | — | — | NOT RUN: no database in this environment (RATIO_EVIDENCE_TEST_DATABASE_URL unset) | — |
| migrations up/down/up (changed) | `(none)` | **N/A** | — | — | N/A: no migrations changed | — |
| build | `npm run build` | **PASS** | 0 | 41.3s | exit 0 | `59bf9379239f423b…` |
| bundle check | `npm run check:bundle` | **PASS** | 0 | 0.3s | exit 0 | `d47070c1fe6c18be…` |
| Playwright simulation suite | `npx playwright test --config playwright.simulation.config.ts` | **PASS** | 0 | 346.5s | 62 passed, 0 failed, 0 skipped, 0 flaky | `bba97f7bde29315b…` |
| Playwright engagement report spec | `npx playwright test --config playwright.engagement.config.ts` | **PASS** | 0 | 11s | 7 passed, 0 failed, 0 skipped, 0 flaky | `de17a13837059f8f…` |

### Informational (not a charter gate)

| Check | Command | Status | Exit | Duration | Result | Log sha256 |
|---|---|---|---|---|---|---|
| Chromium launch preflight | `node -e const { chromium } = require('playwright-core'); const p = process.env.RATIO_CHROMIUM_PATH; chromium.launch({ headless: true, ...(p ? { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) }).then((b) => b.close()).then(() => process.exit(0), (e) => { console.error('launch failed: ' + String(e.message).split('\\n')[0]); process.exit(1); });` | **PASS** | 0 | 0.7s | exit 0 | `cd969a6d1e343b38…` |
| migrations smoke, full set (informational) | `(opt-in: --migration-smoke)` | **N/A** | — | — | N/A: not requested (--migration-smoke) | — |
| platform capability tests (informational) | `npx vitest run --cache=false --reporter=json --outputFile=/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/docs/evidence/pr-186/logs/platform-vitest.json /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/adoption.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/economics.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/policy.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/schemaPin.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/validate.test.ts` | **PASS** | 0 | 2.5s | exit 0 | `3a145d8628675ae4…` |

## Fixture provenance

No fixture files changed.

## Rollback in test

Test: a temporary worktree at c2f2b02bf4ab8adc39dcec8b710cdd7c92e7c9c1 under the OS temp directory (outside the checkout); `git diff --no-color --no-ext-diff --no-textconv --binary --src-prefix=a/ --dst-prefix=b/ e6eee947ba95d9ddf6f93ed64f081b461384d0a9 c2f2b02bf4ab8adc39dcec8b710cdd7c92e7c9c1 > pr.diff`; in the worktree `git apply -R --binary pr.diff && git add -A && git write-tree` (git -c color.ui=never -c core.autocrlf=false); compare with the merge-base tree; then lint, typecheck (app and worker) and the full vitest suite there; the worktree is removed by exact path (also on INT/TERM).

Result: **PASS**. Reverse-applied tree 857af4cbbcf7afe8e81b9ae71c00fb366898796b equals the merge-base tree 857af4cbbcf7afe8e81b9ae71c00fb366898796b. On the rolled-back tree: dependencies PASS (exit 0); lint PASS (exit 0); typecheck PASS (exit 0); unit tests PASS (318/318 files, 5376 passed, 0 failed, 0 skipped).

Production rollback: after merge, `git revert -m 1 <merge sha>` (merge commit) or `git revert <squash sha>` (squash), or reverse-apply `git diff e6eee947ba95d9ddf6f93ed64f081b461384d0a9 c2f2b02bf4ab8adc39dcec8b710cdd7c92e7c9c1` with `git apply -R`; no data, schema or config migration needs undoing.

## Platform capability evidence (non-gating)

Informational only: it never changes a gate, the charter or the exit code. Highest status: "implemented and pre-release validated; live verification scheduled". Live verification needs the owner's environment and a signed evidence record.

Manifest: `docs/evidence/platform/manifest.json`. Test results: the vitest JSON report of the informational check "platform capability tests".

| # | Capability | Release | Owner's evidence required | Status | Detail | Live verification |
|---|---|---|---|---|---|---|
| 1 | Track model spending | 1.1 | Approved-source imports reconcile; unmatched charges and allocation gaps remain visible | **PLANNED** | 1 of 4 evidence items implemented and passing; 3 planned; live verification scheduled (not run by this collector) | One approved billing source reconciles in the pilot (scheduled) |
| 2 | Measure adoption | 1.2 | Numerator and denominator reproducible; identities and exclusions tested | **NOT STARTED** | 1 of 3 evidence items implemented and passing; 2 planned; live verification scheduled (not run by this collector) | Pilot identity source snapshot (scheduled) |
| 3 | Report user utilization | 1.2 | Authorized user-level drill-down, service-account separation, retention and privacy controls | **NOT STARTED** | 1 of 4 evidence items implemented and passing; 3 planned; live verification scheduled (not run by this collector) | Pilot retention run (scheduled) |
| 4 | Track token costs | 1.1 | Cache/batch semantics verified per provider; missing usage and rate gaps do not become zero | **PLANNED** | 2 of 4 evidence items implemented and passing; 2 planned; live verification scheduled (not run by this collector) | Each provider profile verified against live usage (scheduled) |
| 5 | Inspect prompts before execution | 1.3/2.0 | Requests blocked before dispatch in supported scenarios; bypass paths assessed | **NOT STARTED** | 0 of 2 evidence items implemented and passing; 2 planned; live verification scheduled (not run by this collector) | Pilot gateway path blocks a seeded request (scheduled) |
| 6 | Enforce input/output policies | 1.3/2.0 | Allow, block, timeout, streaming and partial-failure behavior tested | **NOT STARTED** | 1 of 3 evidence items implemented and passing; 2 planned; live verification scheduled (not run by this collector) | Pilot gateway conformance run (scheduled) |
| 7 | Block sensitive data transfers | 1.3/2.0 | Seeded sensitive-data tests demonstrate prevention before prohibited transmission | **NOT STARTED** | 0 of 1 evidence items implemented and passing; 1 planned; live verification scheduled (not run by this collector) | Pilot DLP run with seeded data (scheduled) |
| 8 | Control model access | 1.3/2.0 | Disallowed models/providers rejected; credentials and network paths prevent documented bypasses | **NOT STARTED** | 0 of 3 evidence items implemented and passing; 3 planned; live verification scheduled (not run by this collector) | Pilot network and key-inventory checks (scheduled) |

Implemented evidence tests:

- Cap 1 `cap1-w0-allocation-contract` (W0): PASSED — src/platform/contracts/economics.test.ts › FinancialRecord, RateCard, Allocation › allocation: exact sum, same sign, unique targets, pseudonymous users: PASSED
- Cap 2 `cap2-w0-adoption-definition` (W0): PASSED — src/platform/contracts/adoption.test.ts › AdoptionDefinition (cap 2) › names the actor and denominator rules: PASSED
- Cap 3 `cap3-w0-actor-types` (W0): PASSED — src/platform/contracts/validate.test.ts › identifiers, people and content › a human ref is a keyed HMAC under a named key, never an email or a bare hash: PASSED; src/platform/contracts/adoption.test.ts › ActivityEvent and EligiblePopulationSnapshot (cap 2, 3) › missing licensed seats stay absent; services never carry seats: PASSED
- Cap 4 `cap4-w0-absent-usage` (W0): PASSED — src/platform/contracts/economics.test.ts › AIUsageEvent (cap 1, 4) › absent usage stays absent: nothing is filled with 0: PASSED; src/platform/contracts/economics.test.ts › AIUsageEvent (cap 1, 4) › token counts are canonical whole-token strings: PASSED
- Cap 4 `cap4-w0-rate-card-rows` (W0): PASSED — src/platform/contracts/schemaPin.test.ts › schema version pins and the golden corpus › rate-card/1: every corpus case is accepted or rejected exactly as reviewed, at the reviewed paths: PASSED
- Cap 6 `cap6-w0-policy-fail-closed` (W0): PASSED — src/platform/contracts/policy.test.ts › Entitlement and Policy (cap 5-8) › an enforcing policy that can block fails closed; an enforcing output policy buffers: PASSED

## Known gaps

- integration tests (Postgres): NOT RUN: no database in this environment (RATIO_EVIDENCE_TEST_DATABASE_URL unset)
- next-env.d.ts was rewritten by the Playwright build (its distDir) and restored from HEAD after the run.

## Gate log tails

<details><summary>npm ci (last 40 lines)</summary>

```
$ npm ci
npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it. Check out lru-cache if you want a good and tested way to coalesce async requests by a key value, which is much more comprehensive and powerful.
npm warn deprecated rimraf@2.7.1: Rimraf versions prior to v4 are no longer supported
npm warn deprecated lodash.isequal@4.5.0: This package is deprecated. Use require('node:util').isDeepStrictEqual instead.
npm warn deprecated glob@7.2.3: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me
npm warn deprecated fstream@1.0.12: This package is no longer supported.

added 536 packages, and audited 537 packages in 31s

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
$ npm run lint

> ratio@1.0.0 lint
> eslint .
```

</details>

<details><summary>typecheck (app) (last 40 lines)</summary>

```
$ npx tsc --noEmit
```

</details>

<details><summary>typecheck (worker) (last 40 lines)</summary>

```
$ npx tsc -p tsconfig.worker.json --noEmit
```

</details>

<details><summary>unit tests (vitest) (last 40 lines)</summary>

```
    at InitiativeDashboard (/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/executive/InitiativeDashboard.tsx:37:54)
    at PersonaProvider (/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/components/PersonaProvider.tsx:20:28)

 ✓ src/executive/spendSummaryBar.honesty.test.tsx (2 tests) 42ms
stderr | src/executive/InitiativeCard.na.test.tsx > InitiativeCard budget used > shows N/A with the reason when the approved budget is invalid
Warning: useLayoutEffect does nothing on the server, because its effect cannot be encoded into the server renderer's output format. This will lead to a mismatch between the initial, non-hydrated UI and the intended UI. To avoid this, useLayoutEffect should only be used in components that render exclusively on the client. See https://reactjs.org/link/uselayouteffect-ssr for common fixes.
    at EvidenceMark (/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/components/EvidenceMark.tsx:31:25)
    at p
    at article
    at InitiativeCard (/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/executive/InitiativeCard.tsx:21:27)

stderr | src/executive/InitiativeCard.na.test.tsx > InitiativeCard budget used > caps only the bar width for an over-budget workload, not the printed percent
Warning: useLayoutEffect does nothing on the server, because its effect cannot be encoded into the server renderer's output format. This will lead to a mismatch between the initial, non-hydrated UI and the intended UI. To avoid this, useLayoutEffect should only be used in components that render exclusively on the client. See https://reactjs.org/link/uselayouteffect-ssr for common fixes.
    at EvidenceMark (/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/components/EvidenceMark.tsx:31:25)
    at p
    at article
    at InitiativeCard (/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/executive/InitiativeCard.tsx:21:27)

 ✓ src/executive/InitiativeCard.na.test.tsx (2 tests) 54ms
 ✓ scripts/completion/core.test.mjs (3 tests) 7ms
(node:28831) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ src/ingest/usersDispatch.test.ts (1 test) 60ms
 ✓ src/ai/demoPrompts.test.ts (1 test) 94ms
 ✓ src/lib/basePath.test.ts (3 tests) 5ms
 ✓ src/connectors/managed/registry.test.ts (2 tests) 8ms
 ✓ src/data/alertPresentation.test.ts (3 tests) 5ms
 ✓ src/ingest/db/testing/requireTestDatabaseUrl.test.ts (3 tests) 5ms
 ✓ src/finio/utcValidation.test.ts (1 test) 14ms
 ✓ src/costsource/transports/listingCompleteness.test.ts (1 test) 6ms
 ✓ src/attribution/liveAccrualHonesty.test.tsx (1 test) 261ms

 Test Files  318 passed (318)
      Tests  5376 passed (5376)
   Start at  16:28:22
   Duration  160.01s (tests 83%, import 10%, transform 4%, environment 3%)

    Isolate  318 workers spawned · ~192ms startup each (spawn + environment, per file)
             at least ~20.15s faster with isolate: false — reuses workers across files instead of one per file
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
$ npm run check:bundle

> ratio@1.0.0 check:bundle
> node scripts/check-next-bundle.mjs

{"type":"ratio.bundle-check","pass":true,"stats":{"clientFiles":147,"serverFiles":171},"problems":[]}
```

</details>

<details><summary>Playwright simulation suite (last 40 lines)</summary>

```
  ✓  25 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 320px (finding card and KPI card) (1.5s)
  ✓  26 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 360px (finding card and KPI card) (1.6s)
  ✓  27 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 390px (finding card and KPI card) (1.7s)
  ✓  28 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 768px (finding card and KPI card) (1.7s)
  ✓  29 tests/simulation/phone-ui.spec.ts:19:7 › Estimated value popup stays inside the viewport at 1440px (finding card and KPI card) (2.0s)
  ✓  30 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 320px, 100% text (2.8s)
  ✓  31 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 360px, 100% text (2.8s)
  ✓  32 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 390px, 100% text (2.8s)
  ✓  33 tests/simulation/phone-ui.spec.ts:41:7 › current nav item is fully visible on direct load at 320px, 130% text (3.1s)
  ✓  34 tests/simulation/phone-ui.spec.ts:59:5 › the strip is reachable by keyboard: tabbing to the last item brings it fully into view (1.4s)
  ✓  35 tests/simulation/phone-ui.spec.ts:75:7 › primary controls have 44px touch targets at 320px (1.3s)
  ✓  36 tests/simulation/phone-ui.spec.ts:75:7 › primary controls have 44px touch targets at 360px (1.3s)
  ✓  37 tests/simulation/phone-ui.spec.ts:75:7 › primary controls have 44px touch targets at 390px (1.4s)
  ✓  38 tests/simulation/phone-ui.spec.ts:103:7 › top bar: logo, Demo badge, Display, Text and Ask Frank share one row at 320px, with 44px targets (3.0s)
  ✓  39 tests/simulation/phone-ui.spec.ts:103:7 › top bar: logo, Demo badge, Display, Text and Ask Frank share one row at 360px, with 44px targets (2.9s)
  ✓  40 tests/simulation/phone-ui.spec.ts:103:7 › top bar: logo, Demo badge, Display, Text and Ask Frank share one row at 390px, with 44px targets (3.1s)
  ✓  41 tests/simulation/phone-ui.spec.ts:134:5 › Estimated value: opening it describes the button and announces the text; Escape inside the Frank panel leaves it open (1.6s)
  ✓  42 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 390px (2.0s)
  ✓  43 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 768px (2.1s)
  ✓  44 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 1024px (2.2s)
  ✓  45 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 1280px (2.2s)
  ✓  46 tests/simulation/synthetic-connections.spec.ts:6:7 › synthetic API connections import and reconcile client-side at 1440px (2.1s)
  ✓  47 tests/simulation/theme-dismissal.spec.ts:3:7 › theme editor saves and dismisses without losing the selected theme at 390px (2.2s)
  ✓  48 tests/simulation/theme-dismissal.spec.ts:3:7 › theme editor saves and dismisses without losing the selected theme at 1440px (2.1s)
  ✓  49 tests/simulation/theme-mobile.spec.ts:7:7 › theme switcher fits the top bar at 320px (3.0s)
  ✓  50 tests/simulation/theme-mobile.spec.ts:7:7 › theme switcher fits the top bar at 390px (2.9s)
  ✓  51 tests/simulation/theme-mobile.spec.ts:7:7 › theme switcher fits the top bar at 430px (2.5s)
  ✓  52 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 1440px (5.7s)
  ✓  53 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 390px (5.7s)
  ✓  54 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (system-mono) has no overflow, clipping or overlap at 1440px (5.7s)
  ✓  55 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (system-mono) has no overflow, clipping or overlap at 390px (5.8s)
  ✓  56 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 320px (5.4s)
  ✓  57 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 360px (5.6s)
  ✓  58 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 768px (5.6s)
  ✓  59 tests/simulation/typography-layout.spec.ts:73:7 › 130% text (default) has no overflow, clipping or overlap at 1024px (6.0s)
  ✓  60 tests/simulation/typography-layout.spec.ts:97:5 › both top-bar panels stay inside the viewport at 130% and 115% (10.0s)
  ✓  61 tests/simulation/z-agent-workflows.spec.ts:13:5 › embedded reviews recover interruptions and require independent human review (4.2s)
  ✓  62 tests/simulation/zz-frank.spec.ts:15:5 › Frank guides an accountable review, retains evidence boundaries and hands approval to another persona (3.0s)

  62 passed (5.8m)
```

</details>

<details><summary>Playwright engagement report spec (last 40 lines)</summary>

```
$ npx playwright test --config playwright.engagement.config.ts
[WebServer] (node:32106) ExperimentalWarning: SQLite is an experimental feature and might change at any time
[WebServer] (Use `node --trace-warnings ...` to show where the warning was created)
[WebServer] (node:32125) ExperimentalWarning: SQLite is an experimental feature and might change at any time
[WebServer] (Use `node --trace-warnings ...` to show where the warning was created)

Running 7 tests using 1 worker

  ✓  1 tests/engagement/report-page.spec.ts:14:5 › anonymous: 401, no-store, Vary: Cookie, CSP enforced with no violation, only a sign-in link per enabled connection (1.4s)
[WebServer] {"tag":"gateway","event":"unhandled_error","requestId":"2ca04eb8-7313-46d7-801f-1efd1b8764c9","method":"GET","path":"/api/v1/reports/engagement","status":500,"error":"connect ECONNREFUSED 127.0.0.1:1"}
  ✓  2 tests/engagement/report-page.spec.ts:27:5 › analyst: report table and both exports; the real route is reached with the session (DB absent: fixed unavailable message) (900ms)
  ✓  3 tests/engagement/report-page.spec.ts:42:5 › viewer: no export links; the export route itself refuses the viewer (403) (738ms)
  ✓  4 tests/engagement/report-page.spec.ts:52:7 › WCAG AA text contrast on the signed-in page (light) (874ms)
  ✓  5 tests/engagement/report-page.spec.ts:52:7 › WCAG AA text contrast on the signed-in page (dark) (838ms)
  ✓  6 tests/engagement/report-page.spec.ts:52:7 › WCAG AA text contrast on the signed-in page (high-contrast) (922ms)
[WebServer] {"tag":"gateway","event":"unhandled_error","requestId":"90b1c28a-19c9-440d-8c9a-1e99b614c95b","method":"GET","path":"/api/v1/reports/engagement","status":500,"error":"connect ECONNREFUSED 127.0.0.1:1"}
  ✓  7 tests/engagement/report-page.spec.ts:80:5 › engagement mode never shows the Demo badge (anonymous and signed in), and demo routes stay 404 (1.4s)

  7 passed (9.8s)
```

</details>

<details><summary>Chromium launch preflight (last 40 lines)</summary>

```
$ node -e const { chromium } = require('playwright-core'); const p = process.env.RATIO_CHROMIUM_PATH; chromium.launch({ headless: true, ...(p ? { executablePath: p, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) }).then((b) => b.close()).then(() => process.exit(0), (e) => { console.error('launch failed: ' + String(e.message).split('\n')[0]); process.exit(1); });
```

</details>

<details><summary>platform capability tests (informational) (last 40 lines)</summary>

```
$ npx vitest run --cache=false --reporter=json --outputFile=/tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/docs/evidence/pr-186/logs/platform-vitest.json /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/adoption.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/economics.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/policy.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/schemaPin.test.ts /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/src/platform/contracts/validate.test.ts
JSON report written to /tmp/claude-0/-home-user/025c913e-fc00-5509-afd3-eda9750ade16/scratchpad/sc6d14/docs/evidence/pr-186/logs/platform-vitest.json
```

</details>
