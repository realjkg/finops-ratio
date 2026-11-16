# Project Value Tracker

Status: **Proposed**. This is a focused first-delivery design and operating guide, not an implemented product or release-readiness claim.

Starting task-head SHA: `9d9d2fb5a5d5af5279eef79155bc2dea4dc03c7f`. Verified PR #205 targets PR #203's head `00ddd800538acf443244c350103fc0c8cb68613a`. No product code, migration, permission, or PR #200–#203 is changed by this proposal.

The [Value Planning Workshop](VALUE-PLANNING-WORKSHOP.md) remains the broader roadmap. Its richer workshop collaboration is not a prerequisite for the simpler tracker described here.

## First-delivery boundary

The tracker records one project’s budget, costs, and planned or observed outcomes. It is not a ledger, accounting system, proof of realized benefit, general spreadsheet engine, or finance register.

The first delivery is limited to:

- Project, existing authorized owner, reporting period, currency, and declared cost scope: `operating_budget` or `full_project_cost`.
- An immutable, versioned original budget and append-only budget revisions.
- One bounded CSV cost-import format; stable source identity, duplicate detection, explicit reconciliation, and direct project mappings.
- A fixed-share, human-approved allocation for shared costs. Direct, centrally funded, and explicitly unallocated amounts remain distinguishable.
- Versioned baseline/outcome KPI inputs and declared rates, calculated on the server using the pure value engine from [#202 / KPI definitions](KPI-DEFINITIONS.md).
- Independent review and separate Finance approval of the exact value revision before publication.
- An immutable original business case and later, separately approved forecast and observed comparisons.
- Initial views limited to budget / recorded cost / forecast, cost breakdown, and expected-versus-observed KPI/value. Every chart has an accessible data table and **View calculation** detail.

The design keeps these distinctions explicit:

| Do not conflate | Required representation |
|---|---|
| Operating-budget scope and full project cost | Each project and budget revision declares one scope; reports never combine them. |
| Recorded actuals and estimates | Every cost row has `cost_basis=actual` or `estimate`; totals and comparisons stay separate. A forecast is a versioned projection, not an actual. |
| Cash savings and capacity value | Separate value terms. Capacity is not cash; monetizing it requires a declared, versioned rate and approval. |
| Unknown and zero | Missing or incompatible evidence is unavailable with a reason. Zero is only an explicitly supplied, valid zero. |
| Currency, period, and basis | Preserve totals per currency, period, cost scope, and basis. Never silently convert or aggregate incompatible values. |
| Assumptions and measured evidence | Preserve the engine’s evidence status and provenance. An approval or calculation never promotes an assumption to measured. |

Defer general Excel formula translation, AI mapping, sophisticated workshop collaboration, live connector onboarding, advanced charts, email/A2A expansion, and the full finance register. The smaller scope does **not** relax authentication, tenant isolation, durable storage, audit, secure imports, concurrency control, reproducibility, or approvals.

## Data and calculation rules

### Project, budget, and revisions

The server binds a project to the authenticated tenant and an existing authorized project owner; request bodies cannot choose a tenant or grant roles. The project declares its currency, reporting period(s), and cost scope. Monetary values are canonical decimal strings, not binary floating-point numbers.

The initial approved budget is the immutable original. Changes create a new budget revision with an effective period, author, reason, and exact decimal amounts. Do not edit the original to match later actuals or forecasts. Keep every total within its currency, period, cost scope, and cost basis. The original, revised forecast, and observed outcomes are shown side by side, not substituted for one another.

### CSV import, identity, and reconciliation

Accept UTF-8 CSV only in the first delivery; do not execute formulas or import workbook behavior. The proposed initial limits are 10 MiB per file, 100,000 data rows, 4,096 characters per field, and a 30-second processing deadline. Enforce limits while parsing, reject malformed or ambiguous rows, and review limits before implementation. Treat every cell as data; sanitize any later CSV export against formula injection.

The repository includes a synthetic example at [`examples/project-value-costs.csv`](examples/project-value-costs.csv); it is not a downloadable product template yet. Its header is the exact proposed format:

| Column | Required format and meaning |
|---|---|
| `source_system` | Nonempty, bounded source label. |
| `source_record_id` | Stable, nonempty ID from the source; never fabricate one. |
| `period_start`, `period_end` | ISO dates, inclusive, matching the project's reporting calendar. |
| `currency` | ISO 4217 code. No implicit FX conversion. |
| `amount` | Signed plain decimal string; no exponent, grouping separators, or currency symbol. A negative amount must be a source-provided credit or reversal. Preserve source precision. |
| `cost_basis` | Exactly `actual` or `estimate`. |
| `cost_scope` | Exactly `operating_budget` or `full_project_cost`, consistent with the project scope. |
| `cost_type` | Exactly `direct` or `shared`. |
| `project_key` | A known project key for a direct row; blank for a shared pool pending allocation. |
| `description` | Bounded source description; data only, never a mapping instruction. |

Within a tenant, `(source_system, source_record_id)` is the source identity. An identical re-import is a replay, not a second cost. The same identity with different content is a conflict requiring a reviewed correction in a new revision; never overwrite the prior imported row. A missing or unstable source identity is an import error, not permission to invent one.

Reconciliation reports received, accepted, replayed, rejected, conflicting, directly mapped, shared-pending-allocation, and unmatched rows. Show accepted-row subtotals per period/currency/scope/basis. If the source provides control totals, reconcile them to accepted rows and explicit exceptions; otherwise say that a source control total was not provided. Never imply an absent source total or bury a difference. Direct rows with unmatched project keys block publication until mapped in a new revision or rejected with a reason. A shared row is intentionally not a direct mapping and remains pending until its allocation is approved.

### Direct and shared costs

Direct source rows map explicitly to one project. Do not infer a mapping from a description, and do not silently change a mapping after import.

The first shared-cost method is a fixed percentage schedule recorded as a versioned allocation revision. A cost allocator enters each destination project and any centrally funded or unallocated shares; an authorized reviewer approves the schedule. Shares must be nonnegative and total exactly 100% for the pool. Preserve exact decimal arithmetic through calculation and reconciliation; presentation rounding must not change stored amounts or the reconciled total. Direct costs are not subject to shared allocation.

`centrally_funded` means the amount is known to be funded centrally rather than charged to a project. An explicit, reviewed `unallocated` share means the amount is intentionally left without a project destination and remains visible as unallocated; an implicit or unreviewed remainder is an unresolved exception. Neither bucket disappears from the report or becomes a project cost by implication. A pool with unresolved or unapproved shares remains unreconciled for publication.

### KPI/value inputs and approvals

Use the #202 value-model engine for compatible, versioned KPI definitions and value-case calculations. The first adapter should accept explicit baseline and outcome inputs, period/unit/scope, evidence reference and status, scenario, and any monetary rate with its source, currency, effective period, and assumption status. It must not infer missing values, attribution, rates, units, or evidence. If a result is unavailable or incompatible, retain that state and its reason rather than substituting zero.

Calculate on the server from the exact stored revision and engine/definition/rate versions. Preserve source decimal strings and use exact decimal/rational arithmetic; round only for display according to a declared rule. Do not mix periods, currencies, scopes, units, or bases. Cash savings and capacity value remain separate; capacity only becomes a monetary equivalent when an explicitly declared rate is supplied and approved.

The author cannot approve their own value revision. Require an independent KPI/reviewer approval and a distinct Finance approval for the exact revision digest; record sponsor acceptance separately where required by the value-case model. A material edit makes results and approvals stale and requires recalculation and new approvals. Publication is an append-only, reproducible snapshot. The first approved case remains immutable; revised forecasts and observed results append with provenance and compare to that original.

## Role-based how-tos

**Availability today:** none of the tracker workflows below is executable in a product screen or API. No tracker UI/API, CSV importer, storage, allocation workflow, or publication command exists. The CSV file in this repository is a synthetic design example, not a live import template. `npm test -- src/valuemodel` exercises the pure engine; it does not operate a project or persist a case. Steps labeled **Planned** describe required future behavior, not existing commands or screens.

### Organizer: set up the project and access

1. **Planned:** Select or create a project within the authenticated tenant; set its existing authorized owner, reporting periods, currency, and either operating-budget or full-project-cost scope.
2. **Planned:** Assign existing tenant members to project-owner, cost-allocator, independent-reviewer, and Finance duties. Verify least privilege, tenant membership, and separation of duties before inviting anyone. No external invite or email flow is proposed.
3. **Planned:** Confirm durable storage, audit, backup/restore, retention, and project-level authorization are approved before accepting financial data.
4. **Planned:** Record who owns each blocker in the PR plan below. Do not treat this proposal or the pure engine as evidence of permission or data readiness.

### Project owner: establish budget and outcomes

1. **Planned:** Enter the original budget by period and currency, choosing one cost scope and preserving the source and effective date.
2. **Planned:** Add baseline KPI values, units, periods, and source evidence. Mark estimates/assumptions as such; leave absent evidence unavailable.
3. **Planned:** Enter outcome targets and expected-value assumptions. Add any cost/value rate as an explicit versioned decimal with source, effective dates, currency, and evidence status. Do not call capacity a cash saving.
4. **Planned:** Review server-calculated results and **View calculation** inputs before requesting approval.

### Cost allocator: import, reconcile, and allocate

1. **Planned:** Obtain the current CSV template from the tracker. Until the UI exists, use the repository's synthetic example only to understand the format; it is not an executable import mechanism.
2. Prepare one UTF-8 CSV with the exact header and row rules above. Keep source IDs and decimal text unchanged. Do not add formula cells, use Excel-specific behavior, or combine currencies, periods, scopes, or bases.
3. **Planned:** Upload the bounded file. Review accepted/replayed/rejected/conflicting/unmatched counts and control totals for each currency, period, scope, and basis. Resolve every discrepancy before proceeding.
4. **Planned:** For duplicate rows, accept only an identical source-identity/content replay. Investigate changed-content conflicts against the source, then record a correction revision with a reason; do not delete or silently replace history.
5. **Planned:** Map unmatched direct rows to a known project in a new mapping revision or reject them with a reason. Do not use fuzzy or AI mapping.
6. **Planned:** Enter a fixed-share schedule for each shared pool. Keep central funding and unknown/unallocated portions in separate explicit buckets. Send the exact schedule revision to an authorized reviewer; do not publish unresolved or unapproved allocations.

### Reviewer: inspect and approve a revision

1. **Planned:** Open the exact project, revision, and calculation digest. Verify source identities, control totals, direct mappings, allocation shares, units, periods, currencies, scope, evidence, and assumption labels.
2. **Planned:** Check that unknown values remain unavailable, zero is supported by an explicit input, and estimates are not described as actuals.
3. **Planned:** Approve or request changes against that exact digest with a rationale. If the revision changes, discard the stale approval and review the new calculation.

### Finance: approve and publish

1. **Planned:** Independently review the declared budget basis, cost scope, amounts by currency/period, rates, cash-versus-capacity treatment, and funding buckets.
2. **Planned:** Approve or reject the exact revision digest. The project author cannot supply this approval; Finance cannot reuse another person's signoff.
3. **Planned:** Publish only when the required independent and Finance approvals, reconciliation, and reproducibility checks all pass. Verify the immutable original and separately labeled revised forecast/observed comparison.

### Troubleshooting and recovery

- **Unavailable value:** Find the missing, invalid, or unverified input and its reason. Supply supported evidence in a new revision; do not replace unavailable with zero.
- **Incompatible value:** Correct the declared unit, period, currency, cost scope, basis, or KPI definition using a new revision. Do not coerce values or convert currencies silently.
- **Duplicate/conflict:** Identical identity and content is an idempotent replay. Changed content under the same identity is a conflict; reconcile it against the source and use the proposed correction/version workflow.
- **Unmatched cost:** Preserve the original imported row. Add an explicit mapping in a new revision or reject it with a reason, then rerun reconciliation.
- **Failed import or allocation:** Retain the source file digest and audit result; correct the source or allocation in a new revision. Do not count partially processed rows as accepted.
- **Restore/recovery:** No tracker restore operation exists today. **Planned:** an operator restores durable snapshots and staged objects through an approved recovery runbook, checks hashes and audit continuity, and verifies that the published original is unchanged before reopening writes. Never restore by overwriting an issued snapshot or inventing a CLI command.

## Existing authorization mapping and unresolved decisions

The tracker must call the existing server-side identity and tenant/engagement authorization seam for every read, write, import, download, calculation, approval, and publication; derive tenant and actor from the authenticated session; recheck current membership per request; and audit the decision without logging financial content. Simulation personas and the shared service token are not customer authorization.

This is a mapping proposal, not a grant. The existing engagement `authorize()` permissions cover reports, connectors, members, and identity; none grants project CRUD, project cost import, project mapping, allocation approval, KPI approval, or publication. The RBAC action `budget.edit` is explicitly deferred and currently denied; `ingest.write` only covers `/api/costsource/ingest`; and `change.approve` is not a tracker approval. The `finance` persona is not itself a project-scoped Finance signoff grant.

| Proposed operation | Existing mapping to evaluate | Status / unresolved mapping |
|---|---|---|
| Read project and revisions | Engagement `reports:read` is report-only; RBAC `view.read` has no tracker resource. | **Unresolved:** project-scoped read permission, resource type, owner scope, and list filtering. |
| Create project / edit owner, period, currency, scope | Engagement membership administration manages membership, not projects. | **Unresolved:** project-admin authority and assignment ownership. |
| Create original/revised budget | RBAC `budget.edit` is deferred and denied. | **Unresolved:** project-owner edit, budget revision, and approval boundaries. |
| Import costs / download source | `ingest.write` is limited to cost-source ingest; there is no tracker import or object-download permission. | **Unresolved:** importer role, file access, and source retention policy. |
| Map direct costs / allocate shared costs | No project mapping or allocation action exists. | **Unresolved:** cost-allocator authority, allocation reviewer, and central/unallocated bucket controls. |
| Enter KPI inputs / calculate | Pure engine has no request authorization or server API. | **Unresolved:** edit/calculate permissions and allowed definition/rate sources. |
| Independent review / Finance approval | `finance` is an existing persona, but has no project-scoped signoff contract; change approval is unrelated. | **Unresolved:** reviewer/Finance distinctness, approver assignment, and exact-digest signoff actions. |
| Publish / revise / restore | No tracker publication or recovery operation exists. | **Unresolved:** publication privilege, immutable retention, correction authority, and operator restore permission. |

Do not implement any of these mappings by broadening current grants or reusing an unrelated permission. The owner/security review must settle the resource model, project membership, permission names, role assignment path, RLS/grants, and audit/recovery policy first.

## Migration-ledger restriction and owner options

ADR-0001 §12 states that the migration runner refuses an older pending migration after a higher one is applied. A migration file may exist only for a matching `merged` ledger entry, and every lower reservation must be merged, released, or retired before a higher migration; **any `reserved` lower number blocks a higher number**. Every approved migration is expand-only, has a manifest and database test, and pins its schema version.

The current `docs/migrations/ledger.json` has `0001`, `0002`, and `0004` merged; `0003` retired; `0005` reserved for R4 trust views; `0006` reserved for E2 enrichment; `0007–0019` reserved for the 1.0 line/slices 3–5; and `0020–0039` reserved for platform work. ADR-0002 §8 independently says no `0020+` migration may merge before `0005–0019` are decided. This proposal assigns no migration number, edits no ledger entry, retires no reservation, changes no privilege, and creates no migration.

Options for owner/orchestrator review:

1. Keep all reservations and defer durable tracker work until the reserved work has been completed in order.
2. Have each reservation owner identify unused numbers for the orchestrator to release in order, while completing any still-needed lower migrations before a higher migration.
3. Decide whether an existing reserved slice legitimately owns part of the tracker schema, then resolve its dependencies and owner before any migration proposal.

The owner/orchestrator must choose and record the path; do not assume a reservation is unused because it is old or appears unrelated. Until that decision and the required permission/RLS review are complete, durable foundation work is **blocked**, not ready.

## Sequenced PR plan

Proposed paths are planning targets, not existing files or commands. Any future migration filename must use a number assigned through the approved ledger process.

| PR | Dependencies | Bounded scope | Proposed files | Acceptance tests | Docs | Rollback | Blocker owner | Readiness |
|---|---|---|---|---|---|---|---|---|
| **0 — design, how-tos, readiness** | Owner review of this proposal; no feature dependency. | Specify tracker data boundaries, role tasks, CSV example, evidence states, security/RBAC gaps, and subsequent gates only. | `docs/design/value-model/PROJECT-VALUE-TRACKER.md`; `docs/design/value-model/examples/project-value-costs.csv`; link in `VALUE-PLANNING-WORKSHOP.md`. | Internal-link and CSV-header/example consistency checks; governance and wording review; no product behavior claimed. | Complete in this draft; update only after owner decisions. | Revert documentation commit; no data or schema impact. | Owner for product scope; Customer/Frank reviewers for acceptance policy. | Documentation proposal submitted for review; not a feature or release-ready. |
| **1 — authorized durable project/budget foundation** | PR 0 review; explicit owner decision on ledger order, project/resource permissions, RLS/grants, retention, and backup/recovery. | Persist tenant-scoped project/owner/period/currency/scope, immutable original budget and append-only revisions, audit, concurrency, and reproducible snapshots. No import or value UI. | Proposed `src/projectvalue/**`, API/data layer under existing server conventions, and owner-approved migration/manifest/test path. | Tenant/object isolation, revoked membership, unauthorized writes, exact decimals, revision/CAS races, audit redaction, restart/recovery, migration order and expand-only checks. | Update tracker setup, permission, budget, security, and recovery guidance with executable behavior only after it exists. | Disable new routes and roll back app code; retain additive schema and issued records. Destructive rollback is not assumed safe. | Owner/orchestrator (ledger); security and data owners (permissions/RLS/retention). | **Blocked** on ledger and authorization decisions; no migration assigned. |
| **2 — CSV import/allocation/reconciliation** | PR 1 durable foundation and authorization; approved import limits and source-identity/correction rules. | One bounded CSV parser; secure private file handling; deduplication/conflict handling; direct mappings; fixed-share allocations; explicit central/unallocated buckets and reconciliation. | Proposed `src/projectvalue/import/**`, `src/projectvalue/allocation/**`, routes/storage adapters, and focused tests. | Size/row/field limits, hostile CSV/formula-like cells, exact replay versus changed identity, unmatched rows, reconciliation totals, currency/period/basis separation, allocation sum and concurrency. | Update template and allocator how-to, error states, and import/recovery runbook. | Disable import; retain raw immutable records and audit; revert code without rewriting accepted history. | Security owner (file processing); project/Finance owners (identity/allocation policy). | **Blocked** on PR 1 and approved policy. |
| **3 — versioned value inputs, server integration, basic visuals** | PR 1; #202 engine/definition dependency and compatibility review; PR 2 cost summaries for comparison. | Version baseline/outcome assumptions/rates; server-only calculation via the existing engine; budget/recorded/forecast, cost breakdown, and expected/observed accessible tables. | Proposed `src/projectvalue/value/**`, server calculation route/service, and tracker UI under the repository's chosen UI structure. | Engine regression; exact decimals; unknown versus zero; provenance/status weakest-input rules; stale calculation; access isolation; accessible tables and **View calculation**. | Update owner/reviewer/rate entry guidance and visual explanations. | Disable new calculation/view paths; keep immutable input/calculation records and original budget. | Value-model owner (#202 dependency); product and accessibility reviewers. | **Blocked** pending PR 1, approved definitions, and import summaries. |
| **4 — approvals, publication, historical comparison** | PRs 1–3; approved role map and Finance duties; #202 exact-revision rules. | Independent review and distinct Finance signoff; digest-bound publication; immutable original; append-only revised forecasts/observed comparisons. | Proposed `src/projectvalue/review/**`, `src/projectvalue/publication/**`, routes, audit and tests. | Self-approval/dual-role denial, stale/replayed digest, changed revision invalidation, concurrent/duplicate publication, immutable original, reproducibility after restart. | Update reviewer/Finance/publication/revision how-tos and audit/retention docs. | Disable publication; preserve all issued snapshots and audit; no destructive rollback of history. | Owner/security/Finance approvers; Customer and Frank acceptance owners. | **Blocked** on all prior slices and approval policy. |
| **5 — end-to-end validation and remaining documentation** | PRs 1–4 and exact-head CI/review. | Validate complete supported journey, recovery, accessible views, and documentation against actual implementation. No deferred-scope expansion. | Focused integration/e2e fixtures, acceptance evidence, and only directly related docs. | Tenant-isolated end-to-end import-to-publication; recovery/reproducibility; abuse cases; supported database/migration tests; exact-head CI; independent review and required Customer/Frank acceptance. | Record commands, evidence SHA, known gaps, supported operations, and skipped checks. | Use the tested operational rollback/recovery path from PRs 1–4; preserve published originals. | Release owner, independent reviewer, Customer and Frank acceptance owners. | **Not ready**; depends on all earlier approved and tested PRs. |

No subsequent PR is created or promised by this plan. No future work runs autonomously.

## Open-PR and design overlap audit

The initial open set was #200–#203; the live audit also confirms this document is being updated on draft PR #205. Branches and heads below were checked against GitHub at task start. Age alone is not a staleness signal.

| PR / path / branch | Duplication or supersession assessment | Replacement and unique content to preserve | Dependency / proposed cleanup |
|---|---|---|---|
| #200 — `src/ai/LiveAIClient.ts`, `src/ai/liveTimeout.test.ts`, `src/components/ai/ChatInput.limit.test.tsx`, `src/components/ai/ChatMessage.test.tsx`, `src/store/chatLengthGuard.test.ts`, `src/store/sessionRaces.test.ts`, `src/store/useStore.ts`; branch `fix/chat-panel-followups` (head `5e91baa173564666643a6a718b88b9b45a57fb2a`). | No overlap with tracker or value-model work; active chat behavior changes. | No replacement. Preserve in-flight question/session handling, timeout/error behavior, and its tests. | No tracker dependency. Preserve; no cleanup proposed. |
| #201 — `docs/design/value-derivation/VALUE-DERIVATION.md`, `pages/api/v1/ai/chat.ts`, `src/ai/chatTrustBoundary.test.ts`; branch `fix/chat-ignored-fields-header` (head `ff0fdc070519aa67434015b37497170bff16148a`). | No overlap with tracker; separate API compatibility/security behavior. | No replacement. Preserve safe ignored-field reporting and request validation. | No tracker dependency. Preserve; no cleanup proposed. |
| #202 — `src/valuemodel/{boundary.test.ts,digest.ts,engine.test.ts,evaluate.ts,fixtures/syntheticValueModel.ts,formula.ts,history.test.ts,index.ts,kpiDefinition.test.ts,kpiDefinition.ts,lifecycle.ts,rational.ts,units.ts,valueCase.ts}`, `docs/design/value-model/KPI-DEFINITIONS.md`, and `docs/design/value-derivation/VALUE-DERIVATION.md`; branch `feat/value-model-kpi-definitions` (head `96a6068597fb4d6d35a83267f9c12b320a3c5d4a`). | Not superseded. Provides the pure exact-rational KPI/value engine and versioned original/forecast/observed model this tracker intends to call. It does not provide tracker persistence, authorization, import, UI, or publication. | No replacement. Preserve the engine, lifecycle, evidence semantics, immutable case behavior, tests, and proposed definition contracts. | Tracker PR 3/4 depend on it. Do not modify or merge it here; no cleanup proposed. |
| #203 — `docs/design/value-model/VALUE-PLANNING-WORKSHOP.md`, `src/valuemodel/index.ts`, `src/valuemodel/workshopApproval.ts`, `src/valuemodel/workshopApproval.test.ts`; branch `copilot/implement-value-planning-workshop` (head `00ddd800538acf443244c350103fc0c8cb68613a`). | Related scope but not stale or wholly superseded: the tracker is a smaller first delivery; the workshop remains a broader roadmap. There is possible documentation overlap in persistence, security, approvals, and future slices. | Link this tracker as the first-delivery scope while preserving the workshop's collaboration roadmap, threat model, API/security considerations, migration dependency, and readiness-only approval check. | Depends on #202; PR #205 targets this branch. Candidate for owner-confirmed documentation consolidation only after both drafts are reviewed. Do not close/delete or label stale. |
| #205 — this tracker documentation draft; branch `copilot/proposed-tracker-design-update` (head `9d9d2fb5a5d5af5279eef79155bc2dea4dc03c7f`). | The requested reviewable draft for this work; not an existing functional PR. | The proposed tracker/how-tos and handoff below. | Depends on the #203 base and preserves all other PRs. Keep draft until accurate review and acceptance; do not open a second PR. |

Relevant design docs are complementary rather than duplicates: `KPI-DEFINITIONS.md` documents the #202 engine/contracts; `VALUE-DERIVATION.md` documents existing value derivation; `VALUE-PLANNING-WORKSHOP.md` is the broader workshop roadmap; this document specifies the focused tracker. The only cleanup candidate is a separately confirmed consolidation of overlapping future-work prose between #203's workshop note and this tracker. **No close, delete, branch removal, or content deletion is recommended or performed.** Preserve and review #200, #201, #202, and #203 independently.

## Requirements-to-code/test/evidence matrix

Status vocabulary: `not-started`, `implemented-unverified`, `verified-at-SHA`, `blocked`, and `deferred`. `verified-at-SHA` applies only to the named code/test evidence at that exact revision; a pure helper does not verify a product workflow. Commands and results for this documentation change are recorded in the PR handoff after checks run.

| Requirement | Existing code / test / evidence | Status |
|---|---|---|
| Exact rational formula evaluation, units, KPI definition lifecycle | `src/valuemodel/{rational,formula,units,kpiDefinition,lifecycle,evaluate}.ts`; `engine.test.ts`, `kpiDefinition.test.ts`, `boundary.test.ts`. Existing pure engine, no tracker adapter. | `verified-at-SHA 9d9d2fb5a5d5af5279eef79155bc2dea4dc03c7f` |
| Value case, immutable original, revised/observed comparison | `src/valuemodel/valueCase.ts`; `history.test.ts`. Engine-level contract only. | `verified-at-SHA 9d9d2fb5a5d5af5279eef79155bc2dea4dc03c7f` |
| Readiness check for revision-bound independent and Finance signoffs | `src/valuemodel/workshopApproval.ts`; `workshopApproval.test.ts`. It does not authenticate, authorize, persist, approve, or publish. | `verified-at-SHA 9d9d2fb5a5d5af5279eef79155bc2dea4dc03c7f` |
| Project/owner/period/currency/scope and durable budget revisions | No tracker schema or service. | `not-started` |
| CSV upload, source identity/deduplication/reconciliation, mappings, shared allocations | No tracker importer or allocation service. Sample CSV is design-only. | `not-started` |
| Tenant-isolated project permissions, secure storage, audit, concurrency, recovery | Existing auth seams are not mapped to tracker resources; no tracker store/routes. | `blocked` |
| Server calculation and versioned tracker value inputs | Pure engine exists; no tracker API/adapter or durable inputs. | `not-started` |
| Accessible initial visuals and calculation detail | No tracker UI. | `not-started` |
| Production independent/Finance approval and immutable publication | Readiness helper only; no trusted approval or publication system. | `not-started` |
| Migration order for durable tracker data | `docs/migrations/ledger.json`; ADR-0001 §12 and ADR-0002 §8; `src/ingest/db/migrationLedger.test.ts`. Reservations remain unresolved and unchanged. | `blocked` |
| General Excel translation, AI mapping, live connector onboarding, advanced charts, email/A2A, full finance register | Explicitly outside first delivery. | `deferred` |
| Complete end-to-end acceptance and release readiness | No tracker workflow exists; exact-head CI, independent review, and Customer/Frank acceptance remain required. | `not-started` |

## Validation and handoff

The working tree changed documentation and a synthetic CSV only; no application, test, dependency, permission, migration, or ledger files changed. The `verified-at-SHA` entries above refer to the unchanged code at the starting task-head SHA, not to an implemented tracker.

| Check | Result |
|---|---|
| `npm ci` | Installed the existing lockfile successfully. npm reported 10 dependency audit findings (9 moderate, 1 high); no dependency was added or changed, and no audit fix was applied. |
| Focused docs check | Passed: relative Markdown targets in the tracker/workshop files exist; example CSV header matches the documented fields and all three synthetic rows have consistent column counts. |
| `git diff --check` | Passed. |
| `npm test -- src/valuemodel src/rbac src/ingest/db/migrationLedger.test.ts` | Passed: 8 test files, 86 tests. |
| `npm run lint` | Passed. |
| `npm run typecheck` | Passed. |
| `npm run governance:test` | Passed governance controls. It still reports broader UI/backend/identity/agent checks unverified or simulated and `pilotEntryReady=false`, `productionReady=false`. |
| `npm run readiness:check` | Completed; reports unresolved external identity, live-data, agent-runtime, infrastructure, and customer-release gates; `pilotEntryReady=false`, `productionReady=false`. |
| Wording/scope review | Manually checked U.S. English, planned-vs-executable language, unavailable-vs-zero and evidence labels, and no claim of feature/release readiness. No dedicated spelling or Markdown-link command exists in package scripts. |

The full test suite, database/container tests, Next build, and browser acceptance were not run: this is a documentation/example-only change and the tracker has no executable workflow. Exact-head CI for the updated draft, independent review, and any required Customer/Frank acceptance remain pending; this handoff is not release approval.
