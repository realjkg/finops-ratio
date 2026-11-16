# Value-model PR set: conditional freeze readiness

Evidence snapshot: **November 16, 2026, 9:01 p.m. UTC**. This is a review handoff for PRs #202, #203, #205, and #206, not a release note, merge approval, or freeze declaration.

## Readiness decision

**Freeze readiness: not ready. Production readiness: not ready. No freeze is declared.**

The current proposal stack has no merge conflicts in the isolated integration described below, and its local unit, lint, typecheck, build, and synthetic browser checks pass. That is not enough to pass the freeze gate: #202 still needs an independent review and human disposition of its exact-head review; #203 and #205 have no reviews or full CI at their current heads; #203 is based on an older #202 commit; and Customer/Frank acceptance is not evidenced by the automated synthetic workflow. A high-severity production dependency advisory also remains open for assessment.

The Project Value Tracker and Value Planning Workshop remain **Proposed and unimplemented**. The design documents and pure calculation/readiness helpers do not provide a tracker or workshop UI, durable storage, authorization, imports, publication, or live acceptance.

## Instructions and source of truth

Reviewed repository instructions and design/governance references:

- [`AGENTS.md`](../../AGENTS.md) and [`.github/copilot-instructions.md](../../.github/copilot-instructions.md): U.S. English convention and compatibility guidance.
- [ADR-0001](../adr/ADR-0001-ai-usage-and-gateway-platform.md), its [tool identity follow-up](../adr/ADR-0001-follow-up-tool-identities.md), and [ADR-0002](../adr/ADR-0002-ai-agent-orchestrator.md): proposal status, evidence-before-claims, live-verification limits, and migration/permission constraints.
- [Migration ledger](../migrations/ledger.json): 0005–0019 remain reserved. ADR-0001 §12 and `src/ingest/db/migrationLedger.test.ts` require resolving every lower reservation before a higher-numbered migration can be added. No migration or ledger change is included here.
- [Value derivation](../design/value-derivation/VALUE-DERIVATION.md) and [platform roadmap](../roadmap/platform-program.md): the former is a proposal alongside the live methodology page; the latter’s 1.1–2.0 work is planned and is not evidence for the 1.0 release candidate.
- Existing proposed artifacts are on [#202](https://github.com/realjkg/finops-ratio/pull/202), [#203](https://github.com/realjkg/finops-ratio/pull/203), and [#205](https://github.com/realjkg/finops-ratio/pull/205). They were reviewed in place; no other PR branch was changed.

## Live PR state and next actions

Heads, bases, checks, and review state below were read from GitHub, not inferred from PR descriptions. A green check or text in a PR body is not itself merge permission or customer acceptance.

| PR | Live state and exact head | Exact-head evidence | Decision and specific next action |
|---|---|---|---|
| [#202 — KPI/value-model prototype](https://github.com/realjkg/finops-ratio/pull/202) | Open, non-draft; `cf7df6825be984d728fd2f734338cd3ae21f8afa`; base `main` (PR base SHA `c2e5a273684ffe4dead57d427c2c3a4968d34359`). | [Exact-head CI](https://github.com/realjkg/finops-ratio/actions/runs/43951070673) passed Lint/Typecheck/Test/Build, DB tests (job-scoped PostgreSQL 16 and SeaweedFS), migration smoke, local stack, pinned FOCUS-sample acceptance, and bundle check. [Automated acceptance](https://github.com/realjkg/finops-ratio/actions/runs/43951070624), CodeQL, governance risk/eligibility, and Copilot review also completed successfully on this head. The GitHub review threads are resolved/outdated. The latest exact-head Copilot review nevertheless says human assessment is needed for previously unpublished critical concerns; there is no independent review recorded on `cf7df68`. Older independent confirmation referenced by the PR is on `4cc3dfc`, not this head. | **Blocked.** Obtain a fresh independent review on `cf7df68` and record a human disposition of the latest review. Keep the prototype explicitly proposed; do not describe the pure engine as an approved or persisted product. |
| [#203 — workshop proposal and readiness helper](https://github.com/realjkg/finops-ratio/pull/203) | Open, draft; `00ddd800538acf443244c350103fc0c8cb68613a`; base branch #202 at `96a6068597fb4d6d35a83267f9c12b320a3c5d4a`, which is behind current #202 head `cf7df68`. | Listed exact-head checks are Vercel and CodeQL analysis jobs; no full Lint/Typecheck/Test/Build or acceptance workflow and no PR review are recorded. | **Blocked** as a PR; workshop product scope remains **deferred/unimplemented**. After #202’s review disposition, update this branch against the current #202 head without discarding its work, refresh exact-head CI/review, and correct the stale engine-status paragraph noted below. |
| [#205 — tracker proposal and how-tos](https://github.com/realjkg/finops-ratio/pull/205) | Open, draft; `14991a773a9f70bdad5f8c702479ebee67dc173d`; targets #203 at `00ddd800538acf443244c350103fc0c8cb68613a`. | Listed exact-head checks are Vercel and CodeQL analysis jobs; no full Lint/Typecheck/Test/Build or acceptance workflow and no PR review are recorded. | **Blocked** pending the updated #203 base, exact-head checks, and review. Preserve its tracker design, setup/how-tos, example CSV, sequence, and status distinctions; do not duplicate or relaunch that work. Update its current-PR audit row and validation claims as listed below. |
| [#206 — methodology/source explanation](https://github.com/realjkg/finops-ratio/pull/206) | **Merged** into `main` at `f2896bf8cc28c62d5fe9409e0b090cf510b09b86` on November 16, 2026, 8:37 p.m. UTC. The current #207 base is `5a1311eb1eafed6faf130e64f7df1a5691253a32`. | Its exact-head CI, including DB tests, migration smoke, local stack, and pinned FOCUS-sample acceptance, plus CodeQL and governance checks completed successfully. The exact-head Copilot review reports no active issues. | **Already integrated; no further PR action.** The current-main checks below include its methodology route. This is not live-provider or production acceptance. |
| #200 and #201 — chat follow-ups | Both are closed as merged to `main`: #200 head `5e91baa173564666643a6a718b88b9b45a57fb2a`; #201 head `ff0fdc070519aa67434015b37497170bff16148a`. | Included in the current-main baseline; AI/chat tests were run locally below. | **Already integrated.** Preserve as regression baseline; no cleanup proposed. |

### Dependency-safe order and stale-doc handoff

The safe proposed order is **#202 → #203 → #205**. #206, #200, and #201 are already merged to main. #203 must first be reconciled with #202’s current `cf7df68` head; #205 must continue to target the resulting #203 head. No merge, rebase, or push of those branches was performed here.

The following exact branch-local documentation corrections remain for their owners; they are not duplicated on another branch:

1. In #203 `docs/design/value-model/VALUE-PLANNING-WORKSHOP.md`, the “Inputs, upload and mapping” section says the current engine trusts a nested `kpi_result`’s supplied status. At #202 `cf7df68`, `kpi_result` inputs/terms are treated as assumed until resolved against the result ledger; the supplied status is not used. Update this present-tense statement after rebasing, while retaining the starting-checkout SHA as historical provenance.
2. In #205 `docs/design/value-model/PROJECT-VALUE-TRACKER.md`, the open-PR audit labels #202’s `96a606...` as its head. That is the #203 base, not current #202; record `cf7df6825be984d728fd2f734338cd3ae21f8afa` as the checked live head and identify any `96a606...` reference as historical. The `9d9d...` task-start SHA should likewise remain explicitly historical rather than current #205 head; current head is `14991a...`.
3. #205’s validation and review claims must be rechecked against current head `14991a...`; evidence from an earlier task SHA does not establish exact-head checks or approval.

All #202 review threads visible at snapshot were resolved/outdated, but this does not remove the exact-head human assessment or independent-review requirement. Do not infer merge authorization from any PR body.

## Combined-state validation

Fetched the three open PR heads and created a disposable worktree at the #202 common base `c2e5a273684ffe4dead57d427c2c3a4968d34359`—without changing or pushing any PR branch. Merged the exact heads in dependency order:

| Component | Exact head | Local integration merge commit |
|---|---|---|
| #202 | `cf7df6825be984d728fd2f734338cd3ae21f8afa` | `9b5762a7cc116d94b231d0dc033eebb860366ec9` |
| #203 | `00ddd800538acf443244c350103fc0c8cb68613a` | `896791883af7d9f4cf118334f79e4271f56e9e1d` |
| #205 | `14991a773a9f70bdad5f8c702479ebee67dc173d` | `f23afcf5389ac3158bbc4e3e89414242c8711a16` |

The stack merged with **no conflicts**. `f23afcf` is a local disposable integration commit, not a PR head or release artifact. This validates the proposed stack against its common base; it does not combine it with later main commits, including merged #206. The current-main checks below validate that baseline separately. A final updated-stack-on-current-main integration remains for the PR owners after #203 is rebased.

## Validation evidence and limits

Environment: Node `v24.22.1`, npm `11.19.1`; `npm ci` installed 533 packages from the existing lockfile. No source, dependency, lockfile, migration, or permission changes were made by the install. It reported deprecated transitive packages and an unapproved `esbuild` install script.

| Command/check | Result |
|---|---|
| Focused combined-stack tests: `npm test -- src/valuemodel src/rbac src/ingest/db/migrationLedger.test.ts` | Pass: 9 files, 104 tests. |
| Combined-stack full suite: `npm test` | Pass: 342 files, 5,967 tests. |
| Combined-stack `npm run lint` and `npm run typecheck` | Pass. |
| Combined-stack `npm run build` | Pass on Next.js 16.4.6; includes the #202/#203 proposed code. React 18 deprecation and missing build-cache warnings remain. |
| Combined-stack `npm run simulation:acceptance` | Pass: 9 files, 130 tests. |
| Combined-stack `npm run simulation:test` | Pass: 70 browser tests after installing the repository’s Playwright Chromium. This uses synthetic simulation data/personas. |
| Combined-stack `npm run engagement:test` | Pass: 7 browser tests. The configured database endpoint is deliberately unavailable (`127.0.0.1:1`); the tests exercise the explicit unavailable/error behavior, not a live database. |
| Current-main `npm test` | Pass: 340 files, 5,948 tests; includes merged #200/#201/#206 code. |
| Current-main `npm test -- src/ai pages/api/v1/ai/chatTrustBoundary.test.ts` | Pass: 22 files, 622 tests. The server-derived chat context and validated optional focus boundary are covered. |
| Current-main `npm run build` | Pass; output includes `/methodology`. Same Next.js deprecation/cache warnings. |
| Current-main `npm run engagement:test` | Pass: 7 synthetic browser tests; database remains deliberately unavailable. |
| Current-main `npm run simulation:test` | Pass: 70 browser tests, including the supported simulation, source-link/methodology route inventory, access boundaries, and desktop/mobile UI checks. |
| `npm run governance:test` | Pass. Reports the governance suite itself passed, while live identity/data and other gates remain unverified/simulated. |
| `npm run readiness:check` | Completes with `pilotEntryReady=false` and `productionReady=false`; external real-auth, live-data, agent-runtime, infrastructure, and customer-release tasks remain unresolved. |
| Exact-head #202 GitHub CI | Pass: in addition to lint/typecheck/unit tests/build, the workflow ran `npm run test:db` against job-scoped PostgreSQL 16 and SeaweedFS, a migration up/down/up smoke test, `npm run local:test`, `npm run local:acceptance` against the pinned public FOCUS 1.0 sample, and the bundle check. This validates the tested CI fixture paths, not a live provider or production database. |
| Handoff relative-link check | Pass: all 23 Markdown links resolve to existing relative files or external URLs. |
| `npm audit` | 10 findings: 9 moderate and 1 high; no audit fix or dependency update was applied. Production-only audit still reports one high Zod finding, installed `zod@4.4.3`, advisory range `<4.6.6` (GHSA-mrhx-c7xc-m3w5). Zod is transitive/optional-peer reachable through the provider SDKs; no direct Zod imports were found in `src`, `pages`, or `scripts`. `fixAvailable` is true, but exploitability and compatible remediation need a separate dependency review—do not blindly upgrade. |
| CodeQL and alert access | GitHub CodeQL checks passed on #202 and #206 exact heads. The code-scanning-alert listing API returned 403, so alert inventory was unavailable. |

The repository’s `Customer and Frank acceptance` workflow runs Playwright simulation and engagement tests with **synthetic** users/sessions. A green workflow is not real customer or Frank acceptance. Exact-head #202 CI also used job-scoped PostgreSQL 16 and SeaweedFS and ran DB, migration, local-stack, and pinned public FOCUS-sample acceptance checks; those are reproducible fixture tests, not live-provider, production-database, or customer evidence. No live provider credentials, external identity provider/accounts, deployment target, or signed customer acceptance evidence was available or tested. Locally, `npm run test:db` and `npm run local:acceptance` were not run. There is no migration or implemented tracker workflow in this scope. No operational rollback was exercised. The proposed PRs are code/documentation changes without tracker persistence or migration; the revert path is a code revert, while any future data-bearing slice needs its own tested recovery/rollback evidence.

## Setup, limitations, recovery, release notes, and deferred roadmap

- **User/admin setup:** [README quick start](../../README.md#quick-start) and [engagement setup/configuration](../../README.md#engagement-mode). These cover existing application modes, not a tracker setup flow.
- **Proposed user workflows and troubleshooting:** [#205 tracker proposal](https://github.com/realjkg/finops-ratio/pull/205), especially “Role-based how-tos” and “Troubleshooting and recovery.” Planned steps are not executable screens or commands.
- **Workshop limits and proposed recovery:** [#203 workshop proposal](https://github.com/realjkg/finops-ratio/pull/203), especially its implementation-status, migration, rollback, and follow-up sections. The review-readiness helper is not authorization, durable approval, or publication.
- **Current methodology and calculation/source details:** [Value derivation](../design/value-derivation/VALUE-DERIVATION.md) and the existing `/methodology` page introduced by merged #206.
- **Deferred roadmap:** the tracker and workshop documents explicitly defer their unimplemented storage, authorization, imports, mappings, approvals/publication and UI; the broader [platform roadmap](../roadmap/platform-program.md) remains planned. Do not present deferred work as a functioning product.
- **Release-note status:** no release note is prepared or linked because this is a conditional scope-freeze handoff, not a feature release. The roadmap is a proposed plan, not a release announcement.

No live rollback/recovery result is claimed. Existing and proposed design links document limitations and procedures; they do not prove execution.
