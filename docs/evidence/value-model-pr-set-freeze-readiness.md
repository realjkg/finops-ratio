# Value-model PR set: conditional freeze readiness

Evidence snapshot: **November 16, 2026, 11:41 p.m. UTC**. This updates the earlier handoff using live PR state and current-main integration evidence. It is not a release note, merge approval, or freeze declaration.

## Readiness decision

**Freeze readiness: not ready. Production readiness: not ready. No freeze is declared.**

The current proposal stack has no merge conflicts in the isolated integration described below. Full local validation passed on the stack integrated with current main, except that one database RSS-budget test exceeded its limit under Node 24; that test and the complete database suites passed with the CI-pinned Node 22 runtime. The production Zod advisory is fixed on this PR and production-only audit is clear; nine moderate development-tool findings remain for security-owner disposition.

The freeze gate is still blocked: #202's latest exact-head review requests human assessment and has no independent review on its current head; #203 and #205 have no review or full functional CI at their current heads; #203 is based on an older #202 commit; this PR's configured CI runs require action and start zero jobs; and no real identity-provider, live AWS, infrastructure, or Customer/Frank acceptance is evidenced. Passing local fixture tests, CodeQL, governance checks, or preview deployment does not satisfy those gates.

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
| [#202 — KPI/value-model prototype](https://github.com/realjkg/finops-ratio/pull/202) | Open, non-draft; `cf7df6825be984d728fd2f734338cd3ae21f8afa`; PR base SHA `c2e5a273684ffe4dead57d427c2c3a4968d34359`, behind current `main` at `5a1311eb1eafed6faf130e64f7df1a5691253a32`. | [Exact-head CI](https://github.com/realjkg/finops-ratio/actions/runs/43951070673) passed Lint/Typecheck/Test/Build, DB tests (job-scoped PostgreSQL 16 and SeaweedFS), migration smoke, local stack, pinned FOCUS-sample acceptance, and bundle check. [Automated acceptance](https://github.com/realjkg/finops-ratio/actions/runs/43951070624), CodeQL, governance risk/eligibility, and Copilot review also completed on this head. Latest exact-head Copilot review says human assessment is needed for unpublished critical concerns; no independent review is recorded on `cf7df68`. Older independent confirmation cited by the PR is on `4cc3dfc`, not this head. | **Blocked.** Reconcile with current main, obtain independent review on the resulting exact head, and record a human disposition of the latest review. Keep the prototype explicitly proposed; do not describe the pure engine as an approved or persisted product. |
| [#203 — workshop proposal and readiness helper](https://github.com/realjkg/finops-ratio/pull/203) | Open, draft; `00ddd800538acf443244c350103fc0c8cb68613a`; base branch #202 at `96a6068597fb4d6d35a83267f9c12b320a3c5d4a`, behind current #202 head `cf7df68`. | Exact-head [CodeQL/Analyze](https://github.com/realjkg/finops-ratio/actions/runs/43921964320) and Vercel checks pass; no full Lint/Typecheck/Test/Build or acceptance workflow and no PR review are recorded. | **Blocked** as a PR; workshop product scope remains **deferred/unimplemented**. After #202 is reconciled, update this branch against its current head without discarding work, run exact-head functional CI, obtain independent review, and correct the stale engine-status paragraph below. |
| [#205 — tracker proposal and how-tos](https://github.com/realjkg/finops-ratio/pull/205) | Open, draft; `14991a773a9f70bdad5f8c702479ebee67dc173d`; targets #203 at `00ddd800538acf443244c350103fc0c8cb68613a`. | Exact-head [CodeQL/Analyze](https://github.com/realjkg/finops-ratio/actions/runs/43925950238) and Vercel checks pass; no full Lint/Typecheck/Test/Build or acceptance workflow and no PR review are recorded. | **Blocked** pending the updated #203 base, exact-head functional CI, and independent review. Preserve its tracker design, setup/how-tos, example CSV, sequence, and status distinctions; do not duplicate or relaunch that work. Correct its live-head audit claims as listed below. |
| [#206 — methodology/source explanation](https://github.com/realjkg/finops-ratio/pull/206) | **Merged** into `main` at `f2896bf8cc28c62d5fe9409e0b090cf510b09b86` on November 16, 2026, 8:37 p.m. UTC. The current #207 base is `5a1311eb1eafed6faf130e64f7df1a5691253a32`. | Its exact-head CI, including DB tests, migration smoke, local stack, and pinned FOCUS-sample acceptance, plus CodeQL and governance checks completed successfully. The exact-head Copilot review reports no active issues. | **Already integrated; no further PR action.** The current-main checks below include its methodology route. This is not live-provider or production acceptance. |
| #200 and #201 — chat follow-ups | Both are closed as merged to `main`: #200 head `5e91baa173564666643a6a718b88b9b45a57fb2a`; #201 head `ff0fdc070519aa67434015b37497170bff16148a`. | Included in the current-main baseline; AI/chat tests were run locally below. | **Already integrated.** Preserve as regression baseline; no cleanup proposed. |
| This PR #207 — freeze evidence and Zod advisory fix | Open, draft; exact head at this check `b3c17b2c0b94e83156c96e73df45665a5a7bdaea`, based on current main above. | Vercel, CodeQL, and CodeQL language analysis passed on `b3c17b2`. CI runs [43977417797](https://github.com/realjkg/finops-ratio/actions/runs/43977417797) and [43978009515](https://github.com/realjkg/finops-ratio/actions/runs/43978009515) both ended `action_required` with zero jobs. No independent review is recorded. | **Blocked.** A repository owner must resolve the action-required CI gate and obtain an independent review through GitHub. Do not treat local runs as exact-head CI or infer approval from the PR body. |

### Dependency-safe order and stale-doc handoff

The safe proposed order is **#202 → #203 → #205**. #206, #200, and #201 are already merged to main. #203 must first be reconciled with #202’s current `cf7df68` head; #205 must continue to target the resulting #203 head. No merge, rebase, or push of those branches was performed here.

The following exact branch-local documentation corrections remain for their owners; they are not duplicated on another branch:

1. In #203 `docs/design/value-model/VALUE-PLANNING-WORKSHOP.md`, replace the “Inputs, upload and mapping” claim that the engine trusts a nested `kpi_result`’s supplied status. At #202 `cf7df68`, such inputs/terms remain assumed until resolved against the result ledger; the supplied status is not used. Update the present-tense claim after rebasing, while retaining the starting-checkout SHA as historical provenance. This correction is **not** made on #203 here.
2. In #205 `docs/design/value-model/PROJECT-VALUE-TRACKER.md`, correct the open-PR audit: #202 current head is `cf7df6825be984d728fd2f734338cd3ae21f8afa`; `96a606...` is the historical #203 base, not current #202. #205 current head is `14991a773a9f70bdad5f8c702479ebee67dc173d`; keep `9d9d...` only where clearly labeled as the task-start SHA. Preserve both older hashes as history, not current-state claims. This correction is **not** made on #205 here.
3. #205’s validation and review claims must be rechecked against current head `14991a...`; evidence from an earlier task SHA does not establish exact-head checks or approval.
4. The stale statement in the current-main [AWS connector runbook](../connectors/aws.md) has been corrected on #207: `aws-data-exports` is in the current build allow-list, but this is not live-provider verification.

All #202 review threads visible at snapshot were resolved/outdated, but this does not remove the exact-head human assessment or independent-review requirement. Do not infer merge authorization from any PR body.

## Combined-state validation

Used a disposable worktree based on **current main** `5a1311eb1eafed6faf130e64f7df1a5691253a32`, including merged methodology (#206) and chat (#200/#201) changes. Merged the current exact proposal heads in dependency order and included this PR's dependency fix:

| Component | Exact component head | Local integration merge commit |
|---|---|---|
| Current `main` baseline | `5a1311eb1eafed6faf130e64f7df1a5691253a32` | integration parent |
| #207 dependency and guard changes | `b3c17b2c0b94e83156c96e73df45665a5a7bdaea` | `ecdf0a91f661b3de9bde1da359bc900941739788` (final integration SHA) |
| #202 | `cf7df6825be984d728fd2f734338cd3ae21f8afa` | `c8cd9dd` |
| #203 | `00ddd800538acf443244c350103fc0c8cb68613a` | `20ee3d5` |
| #205 | `14991a773a9f70bdad5f8c702479ebee67dc173d` | `c15022c` |

The stack merged in **#202 → #203 → #205** order with no conflicts. `ecdf0a91` is a detached local integration commit, not a PR head or release artifact. The component SHAs are the exact GitHub heads used. Subsequent changes on #207 after `b3c17b2` are limited to this handoff, the AWS runbook correction, and the advisory-test compatibility assertion; they do not change production code or dependencies. The post-integration docs/test edits were validated separately below. No other PR branch was modified, and no merge or push to main was performed.

## Validation evidence and limits

Environment: Node `v24.22.1`, npm `11.19.1`; `npm ci` installed 533 packages from the existing lockfile. CI-pinned database verification used Node `v22.13.1`, PostgreSQL 16, and the pinned SeaweedFS service image. Playwright Chromium was installed for browser tests.

| Command/check | Result |
|---|---|
| Integrated full unit suite: `npm test` | Pass: 347 files, 6,022 tests. |
| `npm run lint`, `npm run typecheck`, `npm run build` | Pass on the integrated current-main stack. Existing Next.js/React deprecation and build-cache warnings remain. |
| `npm run simulation:acceptance` | Pass: 9 files, 130 tests. |
| `npm run simulation:test` | Pass: 70 browser tests using synthetic simulation data/personas. |
| `npm run engagement:test` | Pass: 7 browser tests. Tests use the deliberately unavailable database endpoint `127.0.0.1:1` and verify unavailable/error behavior, not a live database. |
| `npm test -- src/ai pages/api/v1/ai/chatTrustBoundary.test.ts` | Pass: 22 files, 622 AI/chat tests, including server-derived context and the validated optional-focus boundary. |
| `npm run local:test`, `npm run local:acceptance` | Pass against disposable PostgreSQL/S3 fixtures. The pinned public FOCUS sample accepted 942 rows, excluded foreign-provider rows, and quarantined the all-foreign period. This is fixture evidence, not live AWS/customer acceptance. |
| `npm run test:db` with Node `v22.13.1` | Pass: 46 files/733 tests and 6 serial files/173 tests. The scratch migration up/down/up smoke returned to migration `0004`. |
| Node 24 database RSS-budget test | One import-worker test failed twice at 418,062,336 and 407,257,088 bytes against a 402,653,184-byte cap. Its isolated rerun and the complete database suites passed under Node `v22.13.1`. Preserve this runtime-specific failure; do not report the Node 24 database run as fully green. |
| `npm run check:bundle` | Pass: client and server bundle limits. |
| `npm run governance:test`, `npm run readiness:check` | Governance checks pass; readiness reports `pilotEntryReady=false` and `productionReady=false`. |
| Zod advisory guard: `npm test -- scripts/governance/zod-advisory.test.mjs` | Pass with locked Zod `4.6.6`; the guard rejects Zod `4.4.3` in the isolated rollback test. |
| `npm audit --omit=dev` | No production findings after fixing GHSA-mrhx-c7xc-m3w5 by pinning Zod to patched `4.6.6`, compatible with the installed provider SDK peer ranges. |
| Full `npm audit` | Nine moderate findings remain in the development-only ESLint/TypeScript-ESLint toolchain, including transitive `minimatch` versions covered by GHSA-g3hv-75wg-m249 (`>=7.0.0 <11.0.1`). `npm audit --omit=dev` reports zero findings, so the current findings do not affect the production dependency graph. `npm audit` offers updates, but a broader dry-run changes unrelated toolchain dependencies; no blind upgrade or audit suppression was applied. Security-owner disposition remains required. |
| Exact-head #202 GitHub CI | Pass: Lint/Typecheck/Test/Build, DB tests with job-scoped PostgreSQL 16 and SeaweedFS, migration smoke, local stack, pinned FOCUS-sample acceptance, bundle check, governance, and automated synthetic acceptance. Fixture results are not live-provider or production-database proof. |
| Current #207 GitHub CI | Runs `43977417797` (head `3a31cc8`) and `43978009515` (head `b3c17b2`) are `action_required` with zero jobs. This workflow is configured but does not provide exact-head functional verification until the repository gate is satisfied. |
| Current #207 checks | On `b3c17b2`, Vercel, CodeQL, and CodeQL language analysis passed; these are not substitutes for the blocked functional workflow or independent review. The code-scanning-alert listing API previously returned 403; do not treat that as evidence of zero alerts. |
| Documentation/CSV checks | Pass: 22 relative Markdown targets exist across the two edited documents and the #203/#205 proposals; the #205 synthetic example header matches the 11 proposed columns and all 3 example rows have 11 fields. |
| Rollback/reapply exercise | In a disposable worktree, reverted the Zod manifest/lock change and observed the advisory guard reject `4.4.3`, then reapplied the fix and observed locked `4.6.6` and a passing guard. AI/chat tests and two supported browser flows passed both before and after the dependency change. No migration or product data was involved. |

No live provider credentials, external identity provider/accounts, production deployment target, or signed Customer/Frank acceptance evidence was available or tested. The repository's synthetic acceptance workflow is not real customer acceptance. Fixture DB/S3, public-sample, simulation, unavailable-path, CodeQL, and governance results must not be presented as live evidence. No migration or implemented tracker workflow is in this scope.

## Required external evidence before freeze or production claims

Only variable and secret **names** are listed below; never put values in this document, PR, logs, or test output. The accountable parties are roles, not inferred individuals. A fixture or mock may verify a path but cannot satisfy these live gates.

| Gate and accountable role | Required configuration names | Steps and pass criteria | Current status |
|---|---|---|---|
| Real identity-provider integration — identity/security owner and deployment operator | `RATIO_ENGAGEMENT_CONFIG` or `RATIO_ENGAGEMENT_CONFIG_FILE`; `RATIO_ENGAGEMENT_USERS_DIR`; `RATIO_ENGAGEMENT_ORIGIN`; `RATIO_OIDC_CLIENT_SECRET_PRIMARY` or the secret variable named by each connection's `clientSecretRef`; where applicable, `RATIO_TRUSTED_PROXY_HOPS` | Configure the approved issuer/client and exact HTTPS callback for the deployed origin; create named test users with approved roles; verify sign-in, scope and role, denial for unbound/unauthorized users, role or binding changes on the next request, and suspension/session revocation using the documented users CLI. Pass only with evidence from the real IdP and deployed app, including negative cases. | Not tested; IdP, account, and secrets unavailable. |
| Live AWS Data Exports — customer AWS administrator, data owner, and platform operator | `RATIO_ENGAGEMENT_CONFIG` or `RATIO_ENGAGEMENT_CONFIG_FILE`; `RATIO_SECRETS_DIR` with the source secret at `$RATIO_SECRETS_DIR/aws/focus` (`roleArn`, `externalId`, `accessKeyId`, `secretAccessKey` fields); source bucket/prefix/export/table/region in config. The connector deliberately does not use `AWS_*` environment credentials. | Obtain written read-only authorization; configure the customer-issued ExternalId and scoped role; run a real worker fetch for owner-selected periods; verify manifest and object selection, stable delivery IDs, row-level/source evidence, provider filtering, quarantine/refusal behavior, and independently reconciled period totals. Pass only when the customer data owner accepts the reconciliation and limitations, including that manifest control totals are not persisted and periods can be `unverified`. | Not tested against a real AWS account; current code allow-list and synthetic S3/public FOCUS fixtures are not live proof. |
| Database, evidence storage, and deployment — infrastructure/platform operator and security owner | `RATIO_DATABASE_URL`, `RATIO_READER_DATABASE_URL`, `RATIO_MIGRATE_DATABASE_URL`; `RATIO_EVIDENCE_S3_ENDPOINT`, `RATIO_EVIDENCE_S3_REGION`, `RATIO_EVIDENCE_S3_BUCKET`, `RATIO_EVIDENCE_S3_PREFIX`, `RATIO_EVIDENCE_S3_ACCESS_KEY_ID`, `RATIO_EVIDENCE_S3_SECRET_ACCESS_KEY`, `RATIO_EVIDENCE_S3_SESSION_TOKEN`, `RATIO_EVIDENCE_S3_FORCE_PATH_STYLE`; for the engagement local stack: `RATIO_ENGAGEMENT_PG_SUPERUSER_PASSWORD`, `RATIO_ENGAGEMENT_MIGRATOR_PASSWORD`, `RATIO_ENGAGEMENT_WORKER_PASSWORD`, `RATIO_ENGAGEMENT_READER_PASSWORD`, `RATIO_ENGAGEMENT_S3_ACCESS_KEY_ID`, `RATIO_ENGAGEMENT_S3_SECRET_ACCESS_KEY` | Deploy to an isolated staging environment using approved secret storage and least-privilege roles; verify migration status, app/worker/reader access boundaries, evidence-object access, backup and restore, logs/alerts, and recovery from a failed deploy. Pass only with successful recovery and security-owner sign-off on the actual deployment configuration. | Disposable local DB/S3 tests pass; no deployed environment, production access, or restore evidence. |
| Live AI provider and metering (if included in the proposed baseline) — AI platform owner and security owner | `AI_PROVIDER`; for Anthropic, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`; for OpenAI, `OPENAI_API_KEY` and `OPENAI_MODEL`; where gateway auth is enabled, `RATIO_API_TOKEN`; `NEXT_PUBLIC_AI_MODE` is configuration, not a secret. | Enable only the approved provider in a controlled environment; run a real authorized request and denial cases; confirm provider secrets stay server-side, usage/cost limits and metering behave as configured, and no prompt/data crosses the intended tenant boundary. Pass with provider-side evidence and owner sign-off. | AI/chat regression tests pass locally; no live provider call, billing evidence, or deployment verification. |
| Customer and Frank acceptance — designated customer acceptance owner, Frank, and release owner | No secret variable; acceptance evidence must identify the tested build SHA and environment without exposing secret values. | Run the agreed end-to-end supported workflow on the candidate build with real authorized users and data. Record expected vs. actual calculations/source links, access and unavailable/error behavior, known limitations, and explicit written acceptance or remaining issues. Pass only with both required acceptances recorded against the tested SHA. | No real customer run or Frank sign-off is available. |

## Setup, limitations, recovery, release notes, and deferred roadmap

- **User/admin setup:** [README quick start](../../README.md#quick-start) and [engagement setup/configuration](../../README.md#engagement-mode). These cover existing application modes, not a tracker setup flow.
- **Provider setup and operational limits:** [AWS connector runbook](../connectors/aws.md) covers configuration, read-only access request, refusal states, live verification, and the explicit fixture-only status. Managed AWS config is supported in this build but has not been live-verified.
- **Proposed user workflows and troubleshooting:** [#205 tracker proposal](https://github.com/realjkg/finops-ratio/pull/205), especially “Role-based how-tos” and “Troubleshooting and recovery.” Planned steps are not executable screens or commands; do not present them as user/admin instructions for a released tracker.
- **Workshop limits and proposed recovery:** [#203 workshop proposal](https://github.com/realjkg/finops-ratio/pull/203), especially its implementation-status, migration, rollback, and follow-up sections. The review-readiness helper is not authorization, durable approval, or publication.
- **Current methodology and calculation/source details:** [Value derivation](../design/value-derivation/VALUE-DERIVATION.md) and the existing `/methodology` page introduced by merged #206.
- **Deferred roadmap:** the tracker and workshop documents explicitly defer their unimplemented storage, authorization, imports, mappings, approvals/publication and UI; the broader [platform roadmap](../roadmap/platform-program.md) remains planned. Do not present deferred work as a functioning product.
- **Release-note status:** no release note is prepared or linked because this is a conditional scope-freeze handoff, not a feature release. The roadmap is a proposed plan, not a release announcement.

**Rollback/reapply evidence and limit:** the Zod fix was reverted and reapplied only in a disposable worktree; the guard failed on vulnerable `4.4.3`, then passed with `4.6.6`, and the tested AI/chat plus browser flows passed both states. This proves the local code/lockfile reapply path, not production deployment rollback, database restore, or live-provider recovery. Do not roll back to the vulnerable Zod version. This PR adds no migration or durable tracker data; any future data-bearing change requires a separately tested backup, restore, and rollback plan.

## Completed versus blocked

| State | Scope |
|---|---|
| **Completed on #207** | Production Zod advisory fix and lockfile regression guard; corrected the AWS runbook's stale allow-list statement; current-main isolated proposal-stack integration; local unit/build/browser/fixture/governance/security/readiness verification and isolated dependency rollback/reapply exercise. |
| **Blocked; owner action required** | Independent review and human disposition on #202; #202 reconciliation to current main; #203/#205 rebasing, exact-head functional CI/reviews, and their listed branch-local docs corrections; action-required functional CI and independent review for #207; real IdP, AWS, infrastructure/restore, live AI (if in scope), and Customer/Frank evidence; security-owner disposition of nine moderate development-only audit findings. |
| **Deferred; not implemented** | Tracker/workshop UI, persistence, authorization, import/mapping, publication, and any associated migrations. #205's design/how-tos/example CSV/sequence remain on its branch; they are not duplicated here. |

**Freeze scope that can be supported by this evidence:** retain the current main behavior and merged methodology/chat work as the validated baseline; treat the value-model PR stack as proposed and blocked, not as release scope. A bounded code/scope freeze may explicitly defer tracker/workshop features, but no freeze is declared here and no required review, CI, security, live-acceptance, or customer gate is waived. Production readiness remains **not ready**.
