# Sprint backlog: mock-demo environment, MCP-connected access, and role-based access

Read [PLAN.md](./PLAN.md) first. This file turns it into independent task
cards. Facts are cited as F1 to F22 (PLAN section 2) and decisions as D1 to D13
(PLAN section 8). Base: `origin/main` at `8caec87` (revision 3 re-checked against the open Frank design PR #98, branch `docs/frank-mcp-proposal` at `52de3cf`).

Boundary (v2): local and ephemeral only. No production infrastructure, no real
data or credentials, no spend. No card adds a migration (issue #94) or a
dependency. Mocks bind to the loopback interface only.

## How to read a card

- **Files** are the files the card owns. Within a sprint group, cards are
  file-disjoint: no file appears in two cards of the same group. Where two
  cards in different groups edit the same file, the later card depends on the
  earlier one (stated in Dependencies). New files are marked (new).
- **Red tests** are named; each must fail before the implementation and pass
  after. Names are test or `describe`/`it` titles in the listed test file.
- **Governance class** has two parts. *Path-derived* classes were observed by
  running `node scripts/governance/classify-risk.mjs --paths-file` on the
  card's file list. *Content-derived* classes depend on added lines (for
  example `fetch(`, a URL literal, or a dynamic import triggers
  `network_egress` under `src/` and `pages/`, tests included) and are expected,
  to be confirmed on the real diff. Report any difference in the PR. The
  classifier has no class called "ingestion"; the closest is
  `financial_semantics`, which every `src/costsource/**` path triggers. A path
  in no rule is `unclassified` and counts as restricted (fail closed). File
  names containing `auth`, `tenant`, `rls` or `role` under `src/` or
  `pages/api/` trigger `auth_tenancy`; the cards avoid those names unless the
  class is intended.
- **Parallel-safe** means the card can run at the same time as every other card
  in its group.
- **Size** uses the PLAN section 6 scale: S is 1 to 3 days, M is 4 to 8, L is 9
  to 15.

## Shared decisions every card builds on (PLAN 4.2)

- The `Principal`, `Action`, `Resource`, `Verdict` types and the environment
  mapping are defined once in PLAN section 4.2 and implemented by card A1.
- RBAC enforcement switch: `RATIO_RBAC=enforce` turns verification on. Unset,
  the offline default of F1 is unchanged (no token, mock provider, not
  enforced). Every existing test must pass unchanged in the offline default.
- Mock ITSM flag names: `RATIO_MOCK_ITSM=1` (loopback stubs allowed, only with
  `RATIO_ENV` of `development` or `test`) and `CM_ALLOWED_HOSTS` (comma list of
  `host` or `host:port` the ITSM adapters may call; a host allowlist, not a
  private-range ban, so self-hosted on-prem Jira stays possible).
- Browser credential: an HttpOnly, SameSite=Strict cookie named `ratio_session`
  holding the mock-issued JWT, or an `Authorization: Bearer` header; the bearer
  wins when both are present. Cookie-authenticated unsafe methods require a same-origin check
  (`Origin` equals `RATIO_APP_ORIGIN`) and a double-submit CSRF token: login
  also sets a non-HttpOnly `ratio_csrf` cookie and the client echoes it in
  `X-Ratio-CSRF`. This is a **new** check owned by card B1
  (`src/server/gateway/csrf.ts`); the simulation's `requireCsrf` is bound to
  the simulation session (`src/simulation/server/http.ts:34`) and is not
  reused. The same-origin comparison follows the simulation's pattern
  (`http.ts:30-33`).
- Verdict sink: `src/server/gateway/verdictSink.ts` (card B1) keeps one
  registration on `globalThis[Symbol.for('ratio.verdictSink')]`, so separate
  Next.js route bundles share it, with `registerVerdictSink` and
  `resetVerdictSinkForTests`. Every `authorize()` outcome passes through
  `decide(principal, action, resource)` (card B1), which calls the sink;
  **if the sink throws, the request is denied (fail closed, 503, fixed
  message)**. Routes use `requires`; handlers that build a `Resource` late
  (card C3) call `decide`, so every verdict is audited.
- Roles and lenses. The browser has three lenses (`executive`, `technical`,
  `procurement`, F4) and the server six roles. A lens changes presentation
  only; data scope always comes from the principal. Allowed lenses (default
  first): `cto` executive, technical; `finops_lead` executive, technical,
  procurement; `finance` executive, procurement; `eng_lead` technical;
  `procurement` procurement; `auditor` executive, technical, procurement.

## Ordering

| Sprint | Cards | Rule |
|---|---|---|
| A | A1, A2, A3, A4, A5, A6, A7, A8 | All start at once. No dependencies. File-disjoint. |
| B, wave 1 | B1, B4, B5, B6, B8 | Start when their Sprint A dependencies merge. File-disjoint with each other. |
| B, wave 2 | B2, B3, B7, B9, B10 | Start when B1 and B8 (where listed) merge. File-disjoint with each other. |
| B, wave 3 | B11 | Needs B7 and B8. |
| C | C2, C3, C6 first; then C1, C4, C5; then C8; C7 last | See dependencies. C1 and C2 are not parallel. |

### Dependencies (machine-checked table)

| Card | Depends on |
|---|---|
| A1 to A8 | none |
| B1 | A1, A2 |
| B2 | B1, A1 |
| B3 | B1, A1, B8 |
| B4 | A4 |
| B5 | A1, A5 |
| B6 | A6 |
| B7 | B1, A2, B8, A8 |
| B8 | A1, A3 |
| B9 | B1, A1, B8 |
| B10 | B8 |
| B11 | B7, B8, A1 |
| C1 | B3, B7, B9, B10, B11, C2, A2, A3 |
| C2 | B11, A1 |
| C3 | B4, B1, A1 |
| C4 | C3, A4 |
| C5 | B1, C3 |
| C6 | B4, A4 |
| C8 | C4, C3 |
| C7 | all |

Files that two cards edit, in sequence (the later card depends on the earlier):
`src/costsource/CostSourcePage.tsx` A8 then B7; `pages/api/v1/cm/change.ts` B4
then C3; `src/rbac/matrix.ts` A1 then C3 (the `cm/change` status flip);
`src/server/gateway/index.ts` B1 then C5 (one registration import);
`package.json` and `vitest.config.ts` C1 only; `src/store/useStore.ts` B11
only. Ownership, acyclicity and the effort sum were re-checked by script when
this file was revised (EVIDENCE.md).

## File ownership (machine-checked table, full paths)

| Card | Owns |
|---|---|
| A1 | `src/identity/types.ts`, `src/identity/scope.ts`, `src/identity/envMap.ts`, `src/identity/envMap.test.ts`, `src/rbac/matrix.ts`, `src/rbac/authorize.ts`, `src/rbac/matrix.test.ts`, `src/rbac/authorize.test.ts` |
| A2 | `src/mock/idp/issuer.ts`, `src/mock/idp/verifier.ts`, `src/mock/idp/claims.ts`, `src/mock/idp/index.ts`, `src/mock/idp/idp.test.ts` |
| A3 | `src/mock/personaData/dataset.ts`, `src/mock/personaData/scope.ts`, `src/mock/personaData/projections.ts`, `src/mock/personaData/oracle.fixture.json`, `src/mock/personaData/projections.test.ts` |
| A4 | `src/mock/itsm/jiraStub.ts`, `src/mock/itsm/serviceNowStub.ts`, `src/mock/itsm/state.ts`, `src/mock/itsm/index.ts`, `src/mock/itsm/itsm.test.ts` |
| A5 | `src/mock/mcp/server.ts`, `src/mock/mcp/tools.ts`, `src/mock/mcp/protocol.ts`, `src/mock/mcp/index.ts`, `src/mock/mcp/mcp.test.ts` |
| A6 | `src/costsource/sandboxSources.ts`, `src/costsource/seed.ts`, `src/costsource/CostSourceClient.ts`, `src/costsource/MockCostSourceClient.ts`, `src/costsource/syntheticCloudSeed.ts`, `src/costsource/syntheticCloudMapping.ts`, `src/costsource/sourcesForEnvPurity.test.ts`, `src/costsource/syntheticCloudSandbox.test.ts`, `src/costsource/sandboxAllowlist.test.ts`, `src/connectors/ConnectorCard.tsx`, `src/connectors/ConnectorCard.test.tsx` |
| A7 | `src/lib/format.ts`, `src/lib/format.test.ts`, `src/lib/documentHead.test.ts`, `pages/_document.tsx`, `public/favicon.svg` |
| A8 | `src/simulation/SimulationBar.tsx`, `src/simulation/SimulationBar.test.tsx`, `src/costsource/CostSourcePage.tsx`, `src/costsource/findingsHeader.test.tsx`, `pages/demo.tsx`, `src/ai/MockAIClient.ts`, `src/ai/demoPrompts.test.ts` |
| B1 | `src/server/gateway/principal.ts`, `src/server/gateway/auth.ts`, `src/server/gateway/withGateway.ts`, `src/server/gateway/index.ts`, `src/server/gateway/verdictSink.ts`, `src/server/gateway/csrf.ts`, `src/server/gateway/principal.test.ts`, `src/identity/mockIdpVerifier.ts` |
| B2 | `src/server/gateway/liveDataAuth.ts`, `pages/api/costsource/rows.ts`, `pages/api/costsource/findings.ts`, `pages/api/costsource/health.ts`, `pages/api/costsource/sources.ts`, `pages/api/v1/connectors/index.ts`, `src/server/gateway/liveDataPrincipal.test.ts` |
| B3 | `pages/api/attribution.ts`, `pages/api/tokenomics.ts`, `pages/api/prediction/predict.ts`, `pages/api/prediction/accuracy.ts`, `pages/api/report/snapshot.ts`, `pages/api/costsource/ingest.ts`, `src/server/routeMatrix.test.ts`, `src/server/openRoutesEnforced.test.ts` |
| B4 | `pages/api/v1/cm/change.ts`, `src/cm/outbound.ts`, `src/cm/itsmStub.e2e.test.ts` |
| B5 | `src/mcp/client.ts`, `src/mcp/allowlistFile.ts`, `src/mcp/credentials.ts`, `src/mcp/index.ts`, `src/mcp/fixtures/allowlist.dev.json`, `src/mcp/fixtures/allowlist.prod.json`, `src/mcp/mcp.client.test.ts` |
| B6 | `src/connectors/ingestLanding.ts`, `src/connectors/IngestVerification.tsx`, `src/connectors/syntheticAttribution.test.tsx` |
| B7 | `pages/api/v1/session/login.ts`, `pages/api/v1/session/logout.ts`, `pages/api/v1/session/principal.ts`, `pages/api/v1/workloads.ts`, `src/session/client.ts`, `src/session/session.test.ts`, `src/session/liveClients.test.ts`, `src/attribution/LiveAttributionClient.ts`, `src/prediction/LivePredictionClient.ts`, `src/tokenomics/LiveTokenomicsClient.ts`, `src/finio/LiveFinioClient.ts`, `src/ai/LiveAIClient.ts`, `src/cm/LiveCMClient.ts`, `src/costsource/LiveCostSourceClient.ts`, `src/hello/LiveHelloClient.ts`, `src/executive/SnapshotButton.tsx`, `src/costsource/CostSourcePage.tsx` |
| B8 | `src/data/provider.ts`, `src/data/provider.test.ts`, `src/data/servedOracle.fixture.json`, `src/data/defaultScopeGolden.fixture.json`, `src/attribution/MockAttributionClient.ts`, `src/attribution/accrual.ts`, `src/attribution/aggregations.ts`, `src/prediction/MockPredictionClient.ts`, `src/executive/initiativeModel.ts`, `src/executive/reportModel.ts`, `src/findings/findingsModel.ts`, `src/mission/missionModel.ts`, `src/ai/buildAIContext.ts` |
| B9 | `pages/api/v1/ai/chat.ts`, `pages/api/v1/finio/export.ts`, `pages/api/v1/a2a/handshake.ts`, `pages/api/v1/costs/published.ts`, `src/server/costs/publishedCostsRoute.ts`, `src/server/gatewayRoutesEnforced.test.ts` |
| B10 | `src/attribution/AttributionPage.tsx`, `src/attribution/LiveAccrualBoard.tsx`, `src/prediction/PredictionPage.tsx`, `src/data/userQueries.ts`, `src/attribution/pageReaders.test.tsx` |
| B11 | `pages/_app.tsx`, `pages/sign-in.tsx`, `src/session/SessionProvider.tsx`, `src/session/ViewGuard.tsx`, `src/session/Forbidden.tsx`, `src/session/ui.test.tsx`, `src/store/useStore.ts`, `src/store/hydrate.test.ts` |
| C1 | `tests/personas/matrix.spec.ts`, `playwright.personas.config.ts`, `scripts/mock/start.mjs`, `package.json`, `vitest.config.ts`, `src/server/vitestConfig.test.ts` |
| C2 | `src/lib/persona.ts`, `src/components/PersonaProvider.tsx`, `src/components/layout/NavBar.tsx`, `src/components/TechnicalViewToggle.tsx`, `src/lib/personaPrincipal.test.ts` |
| C3 | `src/cm/lifecycle.ts`, `src/cm/changeStore.ts`, `pages/api/v1/cm/change.ts`, `src/rbac/matrix.ts`, `src/cm/lifecycle.test.ts` |
| C4 | `pages/api/v1/cm/webhook.ts`, `src/cm/webhookSignature.ts`, `src/cm/replayStore.ts`, `src/cm/webhook.test.ts` |
| C5 | `src/audit/sink.ts`, `src/audit/record.ts`, `src/audit/register.ts`, `src/audit/index.ts`, `src/audit/audit.test.ts`, `pages/api/v1/audit/records.ts`, `pages/audit.tsx`, `src/server/gateway/index.ts` |
| C6 | `src/cm/tokenClient.ts`, `src/cm/tokenClient.test.ts`, `src/mock/tokenService/server.ts` |
| C8 | `src/cm/statusSync.ts`, `src/cm/statusSync.test.ts` |
| C7 | `.obvious/obvious.md` |

A card that needs a file it does not own stops and records the need on the card
(see the runbook). It does not edit the file.

---

## Sprint A (parallel group, no dependencies)

### A1. Contract, permission matrix and the `authorize()` decision function

- **Goal.** Implement PLAN 4.2 literally: `Role`, `DeployEnv`, `Principal`,
  `Action`, `Resource`, `Verdict` (401, 403 and 409), the shared scope helper
  (`inScope`, `filterByScope`), the environment mapping (`deployEnvFromProcess`,
  `dataEnvToDeployEnv`), the persona-by-view matrix (PLAN 4.4, including each
  route's enforcement status: `enforced`, `public`, `public_mock` (mock
  login), `signed` (webhook: signature instead of a bearer), `sim_only` or
  `deferred(<card>)`), and the action matrix (PLAN 4.5), all as data, plus one
  pure `authorize(principal, action, resource)`. The view matrix is
  **pre-populated for every planned route**, existing or not (session,
  workloads, webhook, audit and sign-in included), each with its intended final
  status; a row for a file that does not exist yet carries
  `plannedBy: '<card>'`. No route is changed.
- **Files.** As listed in the ownership table.
- **Dependencies.** None.
- **Red tests.**
  - `authorize.test.ts`: `denies_by_default_when_no_principal`,
    `denies_unknown_action_and_unknown_role`,
    `eng_lead_cannot_read_other_team_rows`,
    `apply_in_prod_is_409_when_ticket_state_is_not_approved`,
    `apply_in_prod_is_403_when_resource_has_no_bound_ticket`,
    `apply_allowed_only_with_approved_ticket_and_different_approver`,
    `requester_cannot_approve_own_change`,
    `auditor_has_no_write_action_in_any_env`,
    `mcp_write_tool_denied_for_every_role_and_env`,
    `token_env_not_in_envs_is_denied`,
    `teams_star_grants_all_teams_but_empty_teams_grants_none`.
  - `matrix.test.ts`: `matrix_covers_every_page_and_api_route` (walks `pages/`
    with `fs`; every existing route has a row with a status; a row without a
    file must carry `plannedBy`; `/demo`, `/hello`, `/finio/demo` and
    `/sign-in` are `public`),
    `matrix_has_rows_for_every_route_planned_by_this_plan` (session login,
    logout and principal, `/api/v1/workloads`, `/api/v1/cm/webhook`,
    `/api/v1/audit/records`, `/audit`, `/sign-in`), `matrix_view_codes_match_plan_section_4_4`,
    `matrix_action_cells_match_plan_section_4_5` (includes the `view.export`
    and `ingest.write` rows),
    `matrix_does_not_exceed_simulation_permissions` (restates F6 as constants
    with the source line).
  - `envMap.test.ts`: `workload_env_prod_staging_dev_sandbox_map_to_deploy_env`,
    `ratio_env_development_test_production_map_to_dev_test_prod`,
    `unknown_env_value_fails_closed`.
- **Governance class.** Path-derived: `auth_tenancy` for `authorize.ts` and
  `authorize.test.ts`; `unclassified` for the rest.
- **Parallel-safe.** Yes. **Size.** S (2 to 3 days).
- **Notes.** The matrices are proposals until D2; the mapping is interim until
  D11. Keep each in one data file.

### A2. Mock identity provider issuing signed test JWTs

- **Goal.** A local issuer and verifier for test JWTs with `role`, `teams`,
  `envs`, `tenant`, `aud` (the deployment environment, a `DeployEnv`), `jti`,
  `exp`, plus revocation and key rotation. It returns raw claims and does not
  import A1; `MockIdpVerifier` (card B1) maps claims to `Principal`. A real
  OIDC verifier replaces `MockIdpVerifier` later (D1).
- **Files.** `src/mock/idp/issuer.ts`, `verifier.ts`, `claims.ts`, `index.ts`,
  `idp.test.ts` (all new). Use `node:crypto` with EdDSA or ES256 and JWK
  export; do not write PEM blocks (a PEM header line triggers `secrets`).
- **Dependencies.** None.
- **Red tests (`idp.test.ts`).**
  `issues_token_with_role_team_env_tenant_claims`,
  `verify_rejects_tampered_role_claim`, `verify_rejects_expired_token`,
  `verify_rejects_wrong_audience_env`,
  `verify_rejects_alg_none_and_hs256_confusion`,
  `verify_rejects_unknown_kid`, `verify_rejects_revoked_jti`,
  `single_use_token_replay_fails_second_time`,
  `role_change_reissue_reflects_new_claims_and_old_token_is_revoked`,
  `key_rotation_old_kid_rejected_after_retire`,
  `issuer_refuses_to_run_when_RATIO_ENV_is_production`,
  `no_key_or_token_material_in_console_output`.
- **Governance class.** Path-derived: `unclassified`.
- **Parallel-safe.** Yes. **Size.** S (2 to 3 days).

### A3. One dataset, persona projections, and the accuracy oracle

- **Goal.** A single synthetic dataset (integer cents, 3 teams by 3
  environments, several line items, with values that expose floating-point
  error) and pure projections for each persona (CTO roll-up, FinOps lead
  drill-down, Finance, Eng lead, Procurement, Auditor). Projections take a local
  scope `{teams: string[] | '*'; envs: string[]}` that is structurally the same
  as the A1 scope (B8 asserts assignability). A committed oracle holds
  hand-checked totals per persona. This is the unit-level accuracy proof; the
  proof on the data the app actually serves is in B8.
- **Files.** `src/mock/personaData/dataset.ts`, `scope.ts`, `projections.ts`,
  `oracle.fixture.json`, `projections.test.ts` (all new). Avoid names that
  contain `reconcil`, `focus` or `normaliz` (they trigger `financial_semantics`).
- **Dependencies.** None.
- **Red tests (`projections.test.ts`).**
  `cto_rollup_total_equals_finops_drilldown_total`,
  `finops_drilldown_total_equals_sum_of_team_views`,
  `finance_total_equals_cto_total_to_the_cent`,
  `each_persona_matches_committed_oracle`,
  `eng_lead_view_contains_no_other_team_rows_counts_or_totals`,
  `eng_lead_rollup_is_computed_after_the_scope_filter`,
  `dataset_revision_bump_changes_every_persona_view_together`,
  `env_scoped_view_excludes_out_of_scope_environments_and_totals_still_sum`,
  `empty_scope_returns_empty_not_everything`,
  `paged_rows_sum_to_the_total_for_every_persona`.
- **Governance class.** Path-derived: `unclassified`.
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).
- **Notes.** The oracle must not be produced by the code under test.

### A4. Mock Jira and mock ServiceNow ITSM servers

- **Goal.** Two loopback HTTP servers implementing the wire subset the existing
  adapters use (PLAN section 7), with controllable status transitions and
  failure injection. The real `JiraAdapter` is exercised end to end against the
  Jira stub here by constructing it directly with the stub's base URL (the
  constructor takes one, F8; the host allowlist of card B4 lives in provider
  resolution, not in the class, so this test stays valid). The real
  `ServiceNowAdapter` cannot reach a plain-HTTP stub until card B4 adds the
  base-origin seam, so this card tests the ServiceNow stub contract with raw
  requests only.
- **Files.** `src/mock/itsm/jiraStub.ts`, `serviceNowStub.ts`, `state.ts`,
  `index.ts`, `itsm.test.ts` (all new). Import `JiraAdapter` from
  `pages/api/v1/cm/change.ts` read-only.
- **Dependencies.** None.
- **Red tests (`itsm.test.ts`).**
  `jira_adapter_create_attach_status_end_to_end_against_stub`,
  `jira_stub_rejects_missing_or_wrong_bearer_with_401`,
  `jira_stub_issue_keys_match_JIRA_ISSUE_KEY`,
  `servicenow_stub_create_returns_result_number_matching_SERVICENOW_NUMBER`,
  `servicenow_stub_query_filters_by_number_and_honors_sysparm_fields_and_limit`,
  `servicenow_stub_rejects_wrong_basic_auth_with_401`,
  `stub_status_transition_is_visible_to_next_status_call`,
  `stub_failure_injection_401_429_500_and_slow_are_reproducible`,
  `stubs_bind_loopback_only_and_refuse_a_non_loopback_host`,
  `stubs_never_log_the_authorization_header`.
- **Governance class.** Path-derived: `unclassified`. Content-derived expected:
  `network_egress` (`fetch(` and URL literals).
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).

### A5. Mock MCP server with fixture tools

- **Goal.** A loopback JSON-RPC MCP server over HTTP (`initialize`,
  `tools/list`, `tools/call`; HTTP only, matching the open recommendation OD-1
  in `docs/design/frank-mcp/DESIGN.md`). Fixture tools: portfolio summary, cost
  by team, ticket status, and one write-capable tool that **lies**: it declares
  a read-only hint even though it mutates state, so later cards can prove that
  clients ignore server annotations and rely on the operator allowlist (Frank
  design section 3.5). Per-team credentials return only that team's rows.
  Frank-specific tools belong to the Frank design.
- **Files.** `src/mock/mcp/server.ts`, `tools.ts`, `protocol.ts`, `index.ts`,
  `mcp.test.ts` (all new).
- **Dependencies.** None.
- **Red tests (`mcp.test.ts`).**
  `initialize_returns_protocol_version_and_capabilities`,
  `tools_list_returns_fixture_tools_with_descriptions_and_input_schemas`,
  `write_capable_tool_declares_a_read_only_hint_and_still_mutates_state`,
  `tools_call_portfolio_summary_returns_structured_content`,
  `tools_call_unknown_tool_returns_jsonrpc_method_not_found`,
  `tools_call_before_initialize_is_rejected`,
  `team_credential_returns_only_that_teams_rows`,
  `wrong_team_credential_gets_401`,
  `description_can_be_changed_by_a_test_hook_to_simulate_a_rug_pull`,
  `secret_never_appears_in_server_log_or_error_body`,
  `server_binds_loopback_only`.
- **Governance class.** Path-derived: `unclassified`. Content-derived
  expected: `network_egress`.
- **Parallel-safe.** Yes. **Size.** S (2 to 3 days).

### A6. Synthetic AWS, Azure and GCP sandbox sources (owner-approved)

- **Status.** Owner-approved (demo audit, Option C).
- **Goal.** Add three offline FOCUS sandbox sources: `aws-sandbox`,
  `azure-sandbox`, `gcp-sandbox`. Each has `ProviderName` `SyntheticAWS`,
  `SyntheticAzure` or `SyntheticGCP`, its own `BillingAccountId`,
  `SubAccountId`, region and `ServiceName` catalog, and a visible "synthetic"
  chip on its connector card. Each is gated through `isOfflineSandboxSource` and
  served only by the anonymous sandbox routes. Decisions:
  - New `SourceKind` value `synthetic_cloud` (in `CostSourceClient.ts`), so
    chips and dispatch key off the kind and the existing `cloud` kind (the
    config-driven live connectors) is untouched. `src/costsource/index.ts`
    re-exports `SourceKind` by name and needs no change.
  - `MockCostSourceClient.ts` dispatches the three ids to a
    `syntheticCloudSeed` emitter for rows and health, before the generic
    fallthrough that today returns the all-workload rows for any other id
    (`seed.ts` `rawRowsForVersion`). Capabilities are `costRows` only, so
    `fetchFindings` returns an empty list through the existing capability check.
  - The per-source workload mapping is an explicit table. A row with no mapping
    has a `ResourceId` outside the `arn:ratio:workload/` prefix, so
    `resolveWorkloadId` returns null and normalization yields an empty
    `x_RatioWorkloadId` (F21). Other views either follow the mapping or show
    "not attributed" (card B6).
- **Must not break the existing three sandbox sources** (`pointfive-sandbox`,
  `focus-file-sandbox`, `servicenow-sandbox`). Their ids, descriptors, rows,
  health and anonymous access stay byte-for-byte identical. Capture a golden
  hash of their rows on main in the first (red) commit and assert it stays.
- **Files.** As listed in the ownership table. Must not touch
  `src/server/gateway/**`, any normalization or version-shim file, or
  `CostSourcePage.tsx` (A8). Live connector ids must stay out of the allowlist.
- **Dependencies.** None.
- **Red tests.**
  - `sandboxAllowlist.test.ts`:
    `existing_three_sandbox_ids_unchanged_and_still_anonymous`,
    `allowlist_is_exactly_the_six_sandbox_ids`,
    `isOfflineSandboxSource_true_for_aws_azure_gcp_sandbox`,
    `no_live_connector_id_is_in_the_allowlist`,
    `near_miss_ids_denied` (trailing space, case change, path suffix),
    `gateSourceAccess_passes_new_sandbox_ids_without_a_token_and_still_401s_live_ids`.
  - `sourcesForEnvPurity.test.ts` (extend):
    `sourcesForEnv_is_pure_with_six_sandbox_descriptors`.
  - `syntheticCloudSandbox.test.ts`:
    `rows_use_synthetic_provider_names`,
    `each_source_has_its_own_billing_account_subaccount_region_and_service_names`,
    `mock_client_serves_distinct_rows_per_new_source_not_the_all_workload_fallthrough`,
    `no_real_looking_account_ids_or_credentials_in_seed`,
    `row_totals_match_committed_oracle_per_source`,
    `mapping_is_explicit_every_row_maps_or_is_not_attributed`,
    `unmapped_row_resolves_to_null_not_a_default_workload`,
    `anonymousSourceView_leaves_new_sandbox_descriptors_unchanged`,
    `health_for_new_sources_reports_synthetic_and_makes_no_network_call`,
    `new_sources_return_no_findings`,
    `existing_three_sources_rows_are_byte_identical_to_main`,
    `sandbox_rows_route_serves_new_sources_anonymously_and_live_ids_still_401`.
  - `ConnectorCard.test.tsx` (extend):
    `connector_card_shows_synthetic_chip_for_new_sources`.
- **Governance class.** Path-derived: `financial_semantics` (nine
  `src/costsource/**` paths), `unclassified` (`ConnectorCard.tsx`). Ask for the
  reviewer path used for ingestion-affecting changes anyway, because rows enter
  the normalization shim.
- **Parallel-safe.** Yes. **Size.** M (5 to 8 days).

### A7. Demo fixes: negative dollar sign and favicon

- **Goal.** `formatUSD` renders negatives as `-$5.00`, `-$1,500`, `-$2.5k`;
  negative zero and values that round to zero render without a sign; positive
  output is unchanged. Add a favicon and link it in the document head.
- **Files.** As listed in the ownership table.
- **Dependencies.** None.
- **Red tests.** `format.test.ts`:
  `formatUSD_negative_whole_dollars_puts_minus_before_the_symbol`,
  `formatUSD_negative_cents_renders_minus_dollar_5_00`,
  `formatUSD_negative_compact_renders_minus_dollar_2_5k`,
  `formatUSD_negative_zero_and_tiny_negative_render_as_dollar_0_00`,
  `formatUSD_positive_output_matches_main_for_a_table_of_values`.
  `documentHead.test.ts`: `document_head_links_an_icon_that_exists_in_public`.
- **Governance class.** Path-derived: `routes` (`pages/_document.tsx`),
  `unclassified` otherwise.
- **Parallel-safe.** Yes. **Size.** S (1 to 2 days).
- **Notes.** `MockAIClient.ts` has its own local `formatUSD` built on `Intl`
  currency; out of scope.

### A8. Demo fixes: dead link, findings header, `/demo` prompts

- **Goal.** (a) Hide "Customer sign-in simulation" when the simulation is
  disabled (`access.enabled` is false). (b) Name the actual source in the
  findings card title instead of always "PointFive DeepWaste shape", including
  ServiceNow. (c) Make every `/demo` prompt produce a non-help mock Frank reply,
  and make the mock Frank help list prompts that classify to their own intent.
- **Files.** As listed in the ownership table. Must not touch `seed.ts` or
  `ConnectorCard.tsx` (A6).
- **Dependencies.** None.
- **Red tests.** `SimulationBar.test.tsx`:
  `hides_sign_in_link_when_simulation_disabled`,
  `shows_sign_in_link_when_enabled_and_signed_out`.
  `findingsHeader.test.tsx`:
  `findings_header_names_servicenow_for_the_servicenow_source`,
  `findings_header_keeps_pointfive_deepwaste_for_pointfive`.
  `demoPrompts.test.ts`:
  `every_demo_prompt_gets_a_non_help_mock_frank_reply`,
  `help_reply_prompts_each_classify_to_a_distinct_intent`.
- **Governance class.** Path-derived: `financial_semantics`
  (`CostSourcePage.tsx` and `findingsHeader.test.tsx` are under
  `src/costsource/**`), `routes` (`pages/demo.tsx`), `unclassified` otherwise.
- **Parallel-safe.** Yes. **Size.** S (1 to 3 days).
- **Notes.** Today two of the three `/demo` prompts return the help text (F19e).

---

## Sprint B

### B1. Gateway principal, route requirements, verdict helper and sink, credential extraction

- **Goal.** `withGateway` authenticates through a `TokenVerifier`
  (`MockIdpVerifier`, mapping A2 claims to the A1 `Principal`) when
  `RATIO_RBAC=enforce`, then falls back to the legacy shared token as a
  `legacy-shared-token` principal with a narrow fixed grant. New option on
  `withGateway`: `requires: { action: Action; resource?: (req) => Resource }`,
  evaluated through `authorize()` after authentication and before the handler.
  Also provides (see "Shared decisions"):
  - `decide(principal, action, resource)`, the one helper that calls
    `authorize()` and then the registered verdict sink, so a handler that
    builds its `Resource` late (card C3) is audited the same way as a route
    that uses `requires`;
  - `verdictSink.ts`, a single registration on
    `globalThis[Symbol.for('ratio.verdictSink')]` with `registerVerdictSink`
    and `resetVerdictSinkForTests`; **fail closed**: if the sink throws, the
    request is denied with a fixed 503;
  - `csrf.ts`, a new same-origin plus double-submit check for
    cookie-authenticated unsafe methods (the simulation's `requireCsrf` is
    bound to its own session and is not reused);
  - credential extraction from a bearer header or the `ratio_session` cookie.
  Handlers receive `{principal, tenant}`. The offline default is unchanged (F1).
- **Files.** As listed in the ownership table.
- **Dependencies.** A1, A2.
- **Red tests (`principal.test.ts`).**
  `valid_mock_jwt_yields_principal_in_handler_context`,
  `legacy_shared_token_passes_as_flagged_legacy_principal`,
  `legacy_principal_cannot_exceed_its_fixed_grant`,
  `jwt_with_prod_aud_is_rejected_by_a_test_deployment`,
  `offline_default_still_unenforced_with_no_token_and_mock_provider`,
  `tenant_in_logs_is_principal_tenant_never_the_token_or_jwt`,
  `rate_limit_is_keyed_by_principal_tenant`,
  `tampered_role_claim_returns_401_with_a_fixed_message`,
  `route_declaring_requires_gets_403_before_the_handler_runs`,
  `requires_resource_builder_receives_the_request_and_feeds_authorize`,
  `verdict_sink_is_called_for_allow_and_for_deny`,
  `verdict_sink_receives_no_token_or_secret`,
  `sink_throwing_denies_the_request_fail_closed_with_503`,
  `sink_registration_is_shared_across_separately_loaded_module_instances`,
  `reset_helper_clears_the_registered_sink`,
  `decide_helper_calls_authorize_then_the_sink`,
  `cookie_credential_post_requires_same_origin_and_double_submit_csrf`,
  `csrf_token_mismatch_is_403`,
  `bearer_wins_when_bearer_and_cookie_are_both_present`,
  `existing_gateway_tests_pass_unchanged`.
- **Governance class.** Path-derived: `auth_tenancy` (all `src/server/gateway/**`
  paths), `unclassified` (`mockIdpVerifier.ts`).
- **Parallel-safe.** Yes within wave 1. **Size.** M (5 to 8 days).
- **Notes.** This is where the shared `RATIO_API_TOKEN` is wrapped (PLAN 4.3).
  Retirement is D9.

### B2. Live-data gate accepts a principal

- **Goal.** `evaluateLiveDataAuth` and `gateSourceAccess` accept a principal
  with a data-read grant in place of the shared token, and the four costsource
  routes and `v1/connectors` declare `requires`. Rows are filtered with the A1
  scope helper (team from `x_RatioTeam`; environment from the resolved
  workload). Failed-attempt accounting, the weak-token refusal and sandbox
  anonymity stay. The exported signatures and results of
  `evaluateLiveDataAuth` and `gateSourceAccess` stay unchanged (the principal
  path is additive), because `src/server/costs/publishedCostsRoute.ts` (card
  B9) calls them.
- **Files.** `src/server/gateway/liveDataAuth.ts`,
  `pages/api/costsource/{rows,findings,health,sources}.ts`,
  `pages/api/v1/connectors/index.ts`,
  `src/server/gateway/liveDataPrincipal.test.ts` (new).
- **Dependencies.** B1, A1.
- **Red tests.**
  `principal_with_cost_read_grant_passes_live_gate_without_the_shared_token`,
  `principal_without_grant_gets_403_not_401`,
  `sandbox_ids_still_anonymous`,
  `failed_auth_throttle_still_counts_per_ip`,
  `weak_shared_token_still_returns_503`,
  `auditor_cannot_configure_connectors`,
  `finops_lead_can_configure_connectors`,
  `eng_lead_live_rows_filtered_to_own_team_and_env`,
  `evaluateLiveDataAuth_and_gateSourceAccess_signatures_and_results_unchanged_for_existing_callers`,
  `existing_costsource_route_tests_pass_unchanged`.
- **Governance class.** Path-derived: `auth_tenancy` (three paths), `routes`
  (five paths).
- **Parallel-safe.** Yes with B3, B7, B9. **Size.** M (4 to 6 days).

### B3. Authenticate and scope the six open routes; route-level matrix test

- **Goal.** Put `attribution`, `tokenomics`, `prediction/predict`,
  `prediction/accuracy`, `report/snapshot` and `costsource/ingest` (F3) behind
  authentication with `requires` and the scope from the B8 provider. `hello`
  stays an explicit `public` liveness route in the matrix. Add the generated
  persona-by-route-by-environment test (PLAN 4.7, item 7). The matrix test
  asserts every route has a status; `cm/change` is `deferred(C3)` and the
  simulation routes are `sim_only` (they keep their own session model and
  return 404 unless the simulation is enabled).
- **Existing tests.** In the offline default these routes stay anonymous, so
  the existing tests that import them (`src/server/nonGatewayRoutes.test.ts`,
  `src/compat/apiContract.test.ts`, `src/costsource/challengerRoutes.test.ts`,
  `src/costsource/pointFiveHardening.test.ts`,
  `src/executive/snapshotApi.test.ts`,
  `src/executive/snapshotInternalError.test.ts`,
  `src/lib/safeMessagesSync.test.ts`) must pass unchanged. Enforced-mode
  behavior is tested in new files only. If any of those files must change, the
  card lists the edit and the reason in its PR.
- **Files.** `pages/api/attribution.ts`, `pages/api/tokenomics.ts`,
  `pages/api/prediction/predict.ts`, `pages/api/prediction/accuracy.ts`,
  `pages/api/report/snapshot.ts`, `pages/api/costsource/ingest.ts`,
  `src/server/routeMatrix.test.ts` (new), `src/server/openRoutesEnforced.test.ts` (new).
- **Dependencies.** B1, A1, B8.
- **Red tests.**
  `every_api_route_is_in_the_permission_matrix_with_a_status`,
  `route_matrix_persona_by_env_by_route_matches_plan_4_4_and_4_5`,
  `anonymous_gets_401_on_the_six_routes_when_rbac_enforced`,
  `offline_default_keeps_the_six_routes_anonymous`,
  `eng_lead_attribution_has_no_other_team_rows_or_totals`,
  `cto_attribution_rollup_equals_finops_drilldown_total`,
  `user_dimension_attribution_denied_for_cto_finance_eng_procurement`,
  `auditor_post_to_ingest_returns_403`,
  `report_snapshot_export_is_scoped_to_the_caller`,
  `query_param_cannot_override_team_or_env_scope`,
  `role_in_query_or_header_is_ignored`,
  `simulation_routes_return_404_when_simulation_disabled`.
- **Governance class.** Path-derived: `routes` (six paths). Content-derived
  expected: possibly `auth_tenancy` if added lines mention the gateway auth
  words in a path; confirm on the diff.
- **Parallel-safe.** Yes with B2, B7, B9. **Size.** M (5 to 8 days).

### B4. ITSM adapter seam and outbound hardening

- **Goal.** `ServiceNowAdapter` takes an optional base origin (default
  `https://<instance>`), honored for a loopback stub only when
  `RATIO_MOCK_ITSM=1` and `RATIO_ENV` is `development` or `test`. Provider
  resolution requires the Jira host and the ServiceNow instance host to appear
  in `CM_ALLOWED_HOSTS` (or be loopback under the mock flag). Add a timeout to
  every outbound call, retry only safe reads with the existing backoff helper
  (F20), and run both real adapters end to end against the A4 stubs through
  provider resolution. The checks live in resolution, not in the adapter
  classes, so A4's direct-construction test stays valid.
- **Files.** `pages/api/v1/cm/change.ts`, `src/cm/outbound.ts` (new),
  `src/cm/itsmStub.e2e.test.ts` (new). `ticketRefRoute.test.ts` must pass
  unchanged.
- **Dependencies.** A4.
- **Red tests.**
  `servicenow_adapter_create_attach_status_end_to_end_against_stub`,
  `servicenow_base_origin_override_only_honored_with_mock_flag_and_loopback`,
  `host_not_in_CM_ALLOWED_HOSTS_is_refused_with_a_fixed_422`,
  `self_hosted_private_range_host_is_allowed_when_listed_in_CM_ALLOWED_HOSTS`,
  `loopback_host_refused_without_mock_flag`,
  `outbound_call_times_out_and_returns_a_fixed_502`,
  `get_retries_on_429_and_5xx_with_backoff_then_gives_up`,
  `create_is_never_retried_automatically`,
  `credentials_never_appear_in_logs_or_error_bodies`,
  `ticket_ref_grammar_tests_still_pass_unchanged`.
- **Governance class.** Path-derived: `routes`, `unclassified`.
  Content-derived expected: `network_egress`.
- **Parallel-safe.** Yes within wave 1. **Size.** M (4 to 6 days).
- **Notes.** Avoid added lines that assign to a variable named like a password
  (the `secrets` rule matches that pattern); keep credentials as constructor
  parameters.

### B5. Generic MCP client with operator allowlist file, scoping by environment, role and team

- **Goal.** The client half of `docs/design/frank-mcp` (milestone M2 there),
  limited to the A5 mock server. Hand-rolled minimal client (JSON-RPC over
  HTTP); no SDK dependency (D13). It follows that design's allowlist rules
  (section 3, and 3.8 in the open revision, PR #98; see PLAN 5a):
  - The allowlist is a **file** named by one environment variable, parsed at
    start, never an editable code module, API or UI. **One file per
    deployment** (a dev, a test and a production file); no environment reads
    another's file or credentials. There is no "endpoint registry keyed by
    environment".
  - Each server entry pins the URL, `owner`, `purpose` and `data_class`
    (required), and, for https, a certificate pin or named CA bundle and no
    cross-host redirects. Plain `http` to loopback is allowed **only in the
    mock** and cannot be enabled outside `development` or `test`.
  - Each tool entry pins name, `description_hash`, `schema_hash` and a
    `read_only_via` capability. **Read-only comes from the operator
    allowlist, never from the server's own annotation.** The broker offers the
    allowlist's own description and schema, not the server's live text.
  - Reserved fields use Frank's names: `environments[]` (values in the
    `RATIO_ENV` vocabulary, mapped from the deployment's environment),
    `roles[]` (mapped from `Principal.role`) and `teams[]` (mapped from
    `Principal.teams`). A present field with an unknown caller value denies;
    an empty array or null denies; unknown keys are rejected at load. Do not
    invent an `envs` allowlist field.
  - `initialize` first, `tools/list` compared with pins, `tools/call` only for
    allowlisted tools the principal's role, environment and teams permit
    through `authorize()`. Per-team credentials are references resolved
    server-side and never returned. The PointFive scaffold is untouched (F12).
- **Files.** As listed in the ownership table. Tests run against the A5 mock
  server.
- **Dependencies.** A1, A5.
- **Red tests (`mcp.client.test.ts`).**
  `unknown_tool_denied_before_any_network_call`,
  `read_only_comes_from_operator_allowlist_not_server_annotation`,
  `server_declaring_read_only_hint_for_an_unlisted_tool_is_still_denied`,
  `tool_without_read_only_via_in_allowlist_is_not_loaded`,
  `description_hash_change_denies_the_tool`,
  `schema_hash_change_denies_the_tool`,
  `broker_offers_the_allowlist_description_and_schema_not_the_servers_live_text`,
  `allowlist_is_loaded_from_the_file_named_by_env_and_has_no_runtime_edit_path`,
  `deployment_loads_only_its_own_allowlist_file`,
  `unknown_keys_empty_arrays_and_null_in_allowlist_are_rejected_or_deny`,
  `entry_whose_environments_exclude_the_deployment_is_denied`,
  `unset_or_unknown_RATIO_ENV_denies_every_entry`,
  `entry_with_roles_or_teams_denies_when_caller_identity_is_unknown`,
  `https_entry_requires_a_pin_or_ca_bundle_and_refuses_cross_host_redirects`,
  `loopback_http_is_allowed_only_in_mock_and_cannot_be_enabled_in_production`,
  `server_entry_without_data_class_owner_or_purpose_is_rejected`,
  `role_allowlist_blocks_a_tool_the_role_is_not_listed_for`,
  `team_credential_resolved_server_side_and_never_returned`,
  `eng_lead_gets_only_own_team_rows_through_an_mcp_tool`,
  `planted_secret_absent_from_logs_errors_and_audit`,
  `result_string_with_a_credential_shaped_value_is_rejected_before_delivery`,
  `initialize_precedes_tools_call`,
  `tools_list_result_is_filtered_to_the_allowlist`,
  `response_size_and_time_limits_are_enforced`,
  `tool_result_text_is_returned_as_data_and_never_executed`,
  `pointfive_mcp_tests_pass_unchanged`.
- **Governance class.** Path-derived: `unclassified`. Content-derived expected:
  `network_egress`, possibly `secrets` (a secret-bearing config shape).
- **Parallel-safe.** Yes within wave 1. **Size.** M (5 to 8 days).
- **Notes.** Delivers the mock path of the Frank design's T-7 (per-role,
  per-team, per-environment allowlists): the mock IdP and `Principal` supply
  the caller identity that T-7 says is missing. Real identity stays D1.

### B6. Other views follow the synthetic mapping

- **Goal.** Where the connector views show rows from the new sandbox sources,
  they follow the A6 mapping or say "not attributed". The real logic is
  `ingestLanding.ts` (it groups rows by `workloadId`; unresolved rows normalize
  to an empty `x_RatioWorkloadId`, F21), so this card changes grouping to show
  unmapped rows under an explicit "not attributed" group instead of an empty or
  default key.
- **Files.** `src/connectors/ingestLanding.ts`,
  `src/connectors/IngestVerification.tsx`,
  `src/connectors/syntheticAttribution.test.tsx` (new). Existing
  `connectorWalk.test.ts` and `ConnectorCard.test.tsx` are not edited and must
  pass unchanged.
- **Dependencies.** A6.
- **Red tests.** `mapped_row_links_to_its_workload`,
  `unmapped_row_shows_not_attributed`,
  `no_view_defaults_an_unmapped_row_to_a_workload`,
  `existing_sources_landing_output_is_unchanged`.
- **Governance class.** Path-derived: `unclassified`.
- **Parallel-safe.** Yes within wave 1. **Size.** S (1 to 3 days).

### B7. Session API, scoped workloads endpoint and credentials on every client

- **Goal.** Give the browser a server-side way to obtain, hold and send a
  credential.
  - `POST /api/v1/session/login` (mock IdP only; 404 unless the mock IdP is
    enabled in `development` or `test`) accepts a persona and sets the
    HttpOnly `ratio_session` cookie and the readable `ratio_csrf` cookie; the
    body never contains the token. `POST /api/v1/session/logout` revokes the
    `jti`. `GET /api/v1/session/principal` returns `{enforced, role, teams,
    envs, tenant, expiresAt}`, never the token; with `RATIO_RBAC` unset it
    returns `{enforced:false}` and the browser keeps the offline seed. A real
    IdP login flow replaces `login` (D1).
  - `GET /api/v1/workloads` returns, from the B8 provider and for the caller's
    scope, `{workloads, budgets, alerts, asOf}`. The bundled seed stays fixture
    data; the enforcement boundary is the API, and `npm run check:bundle` is the
    guard for any real data that arrives later.
  - Every `Live*Client`, `SnapshotButton` and the ingest panel in
    `CostSourcePage.tsx` send the credential same-origin (with the CSRF header
    on unsafe methods) and surface 401 and 403 (F11; the Frank design's T-2:
    how the browser authenticates).
- **Files.** As listed in the ownership table. `CostSourcePage.tsx` is edited
  after A8.
- **Dependencies.** B1, A2, B8, A8.
- **Red tests.** `src/session/session.test.ts`:
  `mock_login_sets_httponly_samesite_session_cookie_and_readable_csrf_cookie_and_no_token_in_body`,
  `mock_login_is_404_when_mock_idp_disabled_or_in_production`,
  `principal_endpoint_returns_enforced_flag_role_teams_envs_and_no_token`,
  `principal_endpoint_is_401_without_a_credential_when_enforced`,
  `principal_endpoint_reports_enforced_false_in_the_offline_default`,
  `logout_revokes_the_jti`,
  `post_with_cookie_and_wrong_origin_is_403`,
  `workloads_endpoint_returns_only_in_scope_workloads_budgets_and_alerts`,
  `role_change_reissue_updates_the_principal_after_refresh`.
  `src/session/liveClients.test.ts`:
  `live_clients_send_credentials_same_origin_and_surface_401_and_403`,
  `unsafe_methods_send_the_csrf_header`,
  `snapshot_button_and_ingest_panel_send_the_credential`,
  `offline_default_clients_are_unchanged`.
- **Governance class.** Path-derived: `routes` (four), `financial_semantics`
  (two `src/costsource` paths), `unclassified` (the rest). Content-derived
  expected: `network_egress` (modified `fetch(` lines).
- **Parallel-safe.** Yes with B2, B3, B9, B10. **Size.** M (5 to 8 days).

### B8. Data-provider seam, scope-aware models and the served-data oracle

- **Goal.** One seam, `src/data/provider.ts`, returns **workloads, budgets and
  alerts** for a scope (budgets by `workload_id`, alerts by workload) and is the
  only place the models read the seeded `WORKLOADS`, `BUDGET_PROFILES` and
  `ALERTS`. Money is summed in integer cents: each workload's dollar fields are
  converted once at the leaf (`Math.round(dollars * 100)`) and totals are
  formatted from cents, so rounding happens once. The models
  (`MockAttributionClient`, `accrual`, `aggregations`, `MockPredictionClient`,
  `initiativeModel`, `reportModel`, `findingsModel`, `missionModel`,
  `buildAIContext`) take an optional scope (default: all, preserving today's
  output). Add a committed oracle for the **real seeded dataset** (11
  workloads, 7 teams, float dollars, F16), computed by an independent one-off
  script and checked by hand, and assert the A3 scope type is assignable to
  the A1 scope. Page components that import the seed directly are card B10.
- **Files.** As listed in the ownership table. The default-scope golden
  (`src/data/defaultScopeGolden.fixture.json`) is captured from main in the
  first (red) commit.
- **Dependencies.** A1, A3.
- **Red tests (`provider.test.ts`).**
  `cto_rollup_equals_finops_drilldown_to_the_cent_on_the_seeded_dataset`,
  `finops_drilldown_equals_sum_of_every_team_view_on_the_seeded_dataset`,
  `finance_total_equals_cto_total_on_the_seeded_dataset`,
  `each_persona_matches_the_served_data_oracle`,
  `dollars_convert_to_cents_once_at_the_leaf_and_sum_exactly`,
  `eng_lead_models_contain_no_other_team_row_count_or_total`,
  `eng_lead_budgets_and_alerts_contain_only_in_scope_workloads`,
  `aggregates_are_computed_after_the_scope_filter_in_every_model`,
  `default_scope_output_is_identical_to_main_for_every_model` (compares with
  `defaultScopeGolden.fixture.json`),
  `a3_scope_type_is_assignable_to_the_a1_scope`,
  `empty_scope_returns_empty_not_everything`.
- **Governance class.** Path-derived: `unclassified`.
- **Parallel-safe.** Yes within wave 1. **Size.** L (9 to 12 days). Split by
  model family if review capacity is short.

### B9. Remaining gateway routes: chat, FinOps export, handshake, published costs

- **Goal.** Declare `requires` (and the scope) on the routes that already pass
  through the gateway or live-data gate but have no per-role check:
  `v1/ai/chat` (when enforced, the server builds the context from the caller's
  scope with the B8 provider and ignores a browser-supplied snapshot; this is
  the Frank design's T-3 fix for the live path), `v1/finio/export` and its
  legacy re-export, `v1/a2a/handshake` and its re-export, and
  `v1/costs/published` (including `publishedCostsRoute.ts`). `RATIO_API_TENANT_ID`
  binding stays as the tenant source for published costs (F15).
  `publishedCostsRoute.ts` calls `evaluateLiveDataAuth` (import at line 22, call
  at line 123); B2 keeps that function's signature and results unchanged, so
  B9 needs no dependency on B2.
- **Files.** `pages/api/v1/ai/chat.ts`, `pages/api/v1/finio/export.ts`,
  `pages/api/v1/a2a/handshake.ts`, `pages/api/v1/costs/published.ts`,
  `src/server/costs/publishedCostsRoute.ts`,
  `src/server/gatewayRoutesEnforced.test.ts` (new).
- **Dependencies.** B1, A1, B8.
- **Red tests.**
  `chat_context_is_built_from_the_callers_scope_not_the_client_snapshot`,
  `eng_lead_chat_context_has_no_other_team_data`,
  `finio_export_denied_for_cto_eng_lead_procurement`,
  `finio_export_allowed_for_finops_lead_finance_auditor`,
  `handshake_requires_a_principal_when_enforced`,
  `published_costs_tenant_still_comes_from_server_binding_never_the_request`,
  `offline_default_behavior_of_these_routes_is_unchanged`.
- **Governance class.** Path-derived: `routes` (four), `unclassified` (one).
  The existing `src/server/costs` tests must pass unchanged.
- **Parallel-safe.** Yes with B2, B3, B7. **Size.** M (4 to 6 days).

---

### B10. Page components that read the seed directly

- **Goal.** Four files import the seeded dataset directly and so bypass the
  store that card B11 hydrates: `AttributionPage.tsx` (lines 29-30 sum
  `WORKLOADS`), `LiveAccrualBoard.tsx` (lines 15 and 44), `PredictionPage.tsx`
  (lines 24, 84 and 152) and `src/data/userQueries.ts` (lines 59 and 71). They
  switch to the store (workloads) and to a scope-aware reader for user query
  events (`userQueryEventsFor(scope)`, user dimension restricted to the roles
  in PLAN 4.4). In the offline default the store holds the seed, so output is
  unchanged.
- **Files.** As listed in the ownership table.
- **Dependencies.** B8.
- **Red tests (`src/attribution/pageReaders.test.tsx`).**
  `attribution_page_totals_come_from_the_store_not_the_seed`,
  `eng_lead_attribution_page_shows_only_own_team_totals`,
  `live_accrual_board_team_burn_rates_use_store_workloads`,
  `live_accrual_board_user_dimension_hidden_for_roles_without_access`,
  `prediction_page_workload_list_and_default_come_from_the_store`,
  `eng_lead_prediction_page_lists_only_in_scope_workloads`,
  `user_query_events_are_filtered_by_scope`,
  `offline_default_output_of_all_four_files_is_unchanged`.
- **Governance class.** Path-derived: `unclassified`.
- **Parallel-safe.** Yes with B2, B3, B7, B9. **Size.** M (4 to 6 days).

### B11. Sign-in UI, session provider, store hydration and view guard

- **Goal.** The browser flow that traces a persona from sign-in to scoped
  pages (PLAN 4.8).
  - `pages/sign-in.tsx`: a mock persona picker (mock IdP only) that calls
    B7's login; a real IdP redirect replaces it later (D1). It honors a
    `returnTo` parameter, restricted to same-origin paths.
  - `src/session/SessionProvider.tsx`, mounted in `pages/_app.tsx`: on mount it
    calls `GET /api/v1/session/principal`. If `enforced` is false it does
    nothing (offline default). If enforced and a principal is returned it calls
    the store's `hydrateScoped()`, which fetches `/api/v1/workloads` and
    replaces **workloads, budgets and alerts** together. Triggers: on mount,
    after login, after logout (store cleared), after a role-change re-issue
    (a refresh action), and on any 401 (store cleared, redirect to
    `/sign-in?returnTo=...`).
  - `src/session/ViewGuard.tsx` and `Forbidden.tsx`: when enforced, a page whose
    matrix row denies the principal's role shows a 403 state instead of the
    page; until the principal is known a loading state shows, never data.
  - `useStore.ts`: initial `workloads`, `budgets` and `alerts` are empty when
    the build flag `NEXT_PUBLIC_RATIO_RBAC=enforce` is set (so there is no
    first-paint flash of other teams' data) and the bundled seed otherwise;
    `clearSimulation` resets to the same initial values.
- **Files.** As listed in the ownership table.
- **Dependencies.** B7, B8, A1.
- **Red tests.** `src/session/ui.test.tsx`:
  `unauthenticated_visit_when_enforced_redirects_to_sign_in_with_return_to`,
  `expired_session_401_clears_the_store_and_redirects`,
  `return_to_rejects_cross_origin_targets`,
  `forbidden_page_state_shown_for_a_role_the_matrix_denies`,
  `loading_state_never_renders_data_before_the_principal_is_known`,
  `offline_default_does_nothing_and_keeps_the_seed`.
  `src/store/hydrate.test.ts`:
  `hydrate_replaces_workloads_budgets_and_alerts_together`,
  `eng_lead_store_never_holds_another_teams_workloads_budgets_or_alerts`,
  `store_initial_state_is_empty_under_the_enforce_build_flag`,
  `logout_and_401_clear_all_three_collections`,
  `role_change_refresh_rehydrates_with_the_new_scope`.
- **Governance class.** Path-derived: `routes` (`_app.tsx`, `sign-in.tsx`),
  `unclassified` (the rest).
- **Parallel-safe.** No (wave 3, after B7). **Size.** M (5 to 8 days).

## Sprint C

### C1. Browser persona matrix and local launcher

- **Goal.** A Playwright spec that signs in as each persona through the B11
  sign-in page and B7 login, and checks navigation, page content, totals, the
  403 state and the sign-in redirect; a script that starts the app with the
  mock IdP, ITSM stubs and MCP server. This card is the only one that edits
  `package.json` (scripts only, no dependency) and `vitest.config.ts` (add
  `tests/personas/**` to the exclude list, because the default include pattern
  would otherwise run the Playwright spec under `npm test`).
- **Files.** As listed in the ownership table.
- **Dependencies.** B3, B7, B9, B10, B11, C2, A2, A3. Not parallel with C2.
- **Red tests.** `tests/personas/matrix.spec.ts`:
  `cto_and_finops_lead_see_reconciling_totals_on_overview`,
  `eng_lead_attribution_and_prediction_pages_show_only_own_team`,
  `each_persona_nav_shows_only_permitted_links`,
  `eng_lead_sees_only_own_team_workloads`,
  `direct_url_to_a_forbidden_page_shows_a_403_state`,
  `unauthenticated_visit_redirects_to_sign_in`,
  `expired_token_redirects_to_sign_in`,
  `role_change_reissue_takes_effect_after_reload`,
  `replayed_single_use_token_fails`.
  `src/server/vitestConfig.test.ts` (a unit test, outside the excluded
  folder): `npm_test_does_not_run_the_playwright_specs` (reads
  `vitest.config.ts` and asserts `tests/personas/**` is excluded).
- **Governance class.** Path-derived: `dependencies` (`package.json`),
  `unclassified` (the rest).
- **Parallel-safe.** No (after C2). **Size.** M (4 to 8 days).

### C2. Persona and navigation come from the verified principal

- **Goal.** The active persona and navigation derive from the principal
  returned by B7's endpoint (through B11's provider), not `localStorage` (F4).
  `PersonaProvider.tsx` (which reads and writes `localStorage` today) takes
  the principal's role-to-lens table (see "Shared decisions"): the switcher
  only offers the lenses the role allows and the default lens is the first
  listed. The lens never changes data scope.
- **Files.** As listed in the ownership table.
- **Dependencies.** B11, A1.
- **Red tests.** `persona_comes_from_verified_principal_not_localstorage`,
  `role_to_lens_table_matches_the_plan` (six roles by three lenses),
  `switcher_only_offers_lenses_the_role_allows`,
  `eng_lead_cannot_select_the_executive_lens`,
  `nav_hides_links_the_role_cannot_open`,
  `tampered_localstorage_persona_has_no_effect_on_api_results`,
  `offline_default_keeps_the_executive_default_persona`.
- **Governance class.** Path-derived: `unclassified`.
- **Parallel-safe.** Yes with C3 and C6. **Size.** S (2 to 3 days).

### C3. Change lifecycle: request, approve, apply, update, idempotency, binding

- **Goal.** Extend `POST /api/v1/cm/change` (still POST only) with these
  operations; the existing `create`, `attach` and `status` stay unchanged.
  State is in memory behind an interface (D8). The requester is always the
  verified `principal.sub`, never a body field.

  | Operation | Request body | Success response | Errors |
  |---|---|---|---|
  | `request` | `{operation, idempotencyKey, finding, action, env}` | `200 {changeId, state:'requested', requesterSub, ticket:{provider,ticketRef,url}, env, team, updatedAt}`; the ticket is created and bound at this step | 400 invalid; 403 not permitted; 409 same key with a different payload |
  | `bind` | `{operation, changeId, ticketRef}` | `200` change record with the pre-approved ticket bound | 404 unknown change; 409 already bound |
  | `approve` | `{operation, changeId}` | `200` record with `state:'approved'`, `approverSub` | 403 requester equals approver or role not permitted; 404; 409 wrong state |
  | `apply` | `{operation, changeId}` | `200` record with `state:'applied'` | 403 no bound ticket in prod; 404; 409 ticket not approved or change not approved |
  | `update` | `{operation, changeId, comment?, transition?}` | `200` record | 404; 409 |
  | `get` | `{operation, changeId}` | `200` record | 404 |

  `apply` builds the `Resource` for `authorize()` from the stored change and
  the live ticket status (`requesterSub`, `approverSub`, `ticketState`), so the
  "A" cells of PLAN 4.5 are a pure verdict over those fields. Add a
  per-provider outbound rate limit. Handlers build the `Resource` late, so every
  step calls B1's `decide()` helper and its verdict reaches the audit sink.
  Then edit `src/rbac/matrix.ts` (sequenced after A1) to switch the status of
  `cm/change` from `deferred(C3)` to `enforced`.
- **Files.** `src/cm/lifecycle.ts` (new), `changeStore.ts` (new),
  `pages/api/v1/cm/change.ts`, `src/cm/lifecycle.test.ts` (new).
- **Dependencies.** B4, B1, A1.
- **Red tests.**
  `request_with_same_idempotency_key_returns_first_change_and_creates_one_upstream_ticket`,
  `same_key_with_different_payload_returns_409`,
  `request_requester_is_the_principal_not_a_body_field`,
  `apply_without_a_bound_ticket_is_denied_in_prod`,
  `apply_with_a_ticket_not_approved_returns_409`,
  `requester_cannot_approve_own_change`,
  `approval_by_another_principal_moves_state_to_approved`,
  `double_approve_and_apply_before_approve_are_rejected`,
  `a_bound_ticket_cannot_be_rebound`,
  `update_operation_transitions_the_ticket_via_the_stub`,
  `outbound_rate_limit_returns_429_with_retry_after`,
  `ticket_ref_grammar_still_enforced_on_all_new_operations`,
  `every_change_step_verdict_reaches_the_registered_sink`,
  `cm_change_matrix_status_is_enforced_and_no_deferred_route_remains`.
- **Governance class.** Path-derived: `routes` (`change.ts`), `unclassified`.
- **Parallel-safe.** Yes with C2, C6. **Size.** M (5 to 8 days).

### C4. Inbound webhook with signature and replay protection

- **Goal.** A webhook route that verifies an HMAC signature over the raw body,
  a timestamp window and event-id replay protection; fails closed without a
  configured secret. The replay store is in memory behind an interface (D8).
- **Files.** `pages/api/v1/cm/webhook.ts`, `src/cm/webhookSignature.ts`,
  `src/cm/replayStore.ts`, `src/cm/webhook.test.ts` (all new).
- **Dependencies.** C3, A4.
- **Red tests.** `valid_signature_within_window_is_accepted`,
  `bad_signature_is_rejected_with_constant_time_compare`,
  `signature_is_computed_over_raw_body_bytes_not_reserialized_json`,
  `timestamp_outside_window_is_rejected`,
  `replayed_event_id_is_rejected_and_state_is_unchanged`,
  `event_for_unknown_ticket_is_ignored_without_creating_state`,
  `webhook_fails_closed_without_a_configured_secret`,
  `webhook_secret_never_logged`.
- **Governance class.** Path-derived: `routes`, `unclassified`. Content-derived
  possible: `secrets`.
- **Parallel-safe.** Yes with C5, C6 (after C3). **Size.** M (4 to 6 days).

### C5. Audit sink, read route and page

- **Goal.** Register the sink that card B1's `decide()` helper and `requires`
  option call (B1 owns the registration point and makes it fail closed). A
  one-line side-effect import of `src/audit/register.ts` is added to
  `src/server/gateway/index.ts` (sequenced after B1), and registration lives
  on `globalThis` so separate route bundles share it; tests reset it with
  `resetVerdictSinkForTests`. Every
  `authorize()` verdict and every change step writes a record (who, action,
  environment, verdict, ticket linkage) with no secrets, tokens or email
  addresses. In-memory sink behind an interface (D8). A read route and an audit
  page, scoped by role and team (PLAN 4.4 and 4.5).
- **Files.** `src/audit/sink.ts`, `record.ts`, `index.ts`, `audit.test.ts`;
  `pages/api/v1/audit/records.ts`; `pages/audit.tsx` (all new).
- **Dependencies.** B1, C3.
- **Red tests.** `every_authorize_decision_writes_an_audit_record`,
  `audit_record_has_no_secret_token_or_email`,
  `audit_links_request_ticket_approval_and_apply`,
  `audit_read_is_scoped_by_role_and_team`,
  `audit_read_denied_for_finance_and_procurement`,
  `audit_sink_failure_denies_the_action` (exercises B1's fail-closed path with
  the real sink),
  `registration_survives_separately_loaded_route_modules`.
- **Governance class.** Path-derived: `routes` (two), `auth_tenancy` (`src/server/gateway/index.ts`), `unclassified`.
- **Parallel-safe.** Yes with C4, C6. **Size.** M (4 to 6 days).

### C6. OAuth2 client-credentials client behind an interface

- **Goal.** A token client (cache until expiry, single refresh on 401, host
  allowlist) and a mock token endpoint, proving the shape only. Wiring it into
  the adapters is owner decision D4 and is not done.
- **Files.** `src/cm/tokenClient.ts`, `tokenClient.test.ts` (new);
  `src/mock/tokenService/server.ts` (new, a directory separate from A4's
  `src/mock/itsm/**`). Does not edit `pages/api/v1/cm/change.ts`.
- **Dependencies.** B4, A4.
- **Red tests.**
  `token_fetched_with_client_credentials_and_cached_until_expiry`,
  `expired_token_is_refetched_once`,
  `a_401_triggers_a_single_refresh_then_fails`,
  `client_secret_never_logged`,
  `token_endpoint_host_must_be_allowlisted`,
  `basic_and_bearer_modes_still_work`.
- **Governance class.** Path-derived: `unclassified`. Content-derived
  expected: `network_egress`, possibly `secrets`.
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).

### C8. Two-way status sync

- **Goal.** One state machine mapping provider statuses to `requested`,
  `approved`, `applied`, `rejected`, driven by the C4 webhook and a polling
  fallback for missed events. Handles out-of-order events, provider status
  vocabularies and Ratio's own update echo.
- **Files.** `src/cm/statusSync.ts`, `statusSync.test.ts` (new).
- **Dependencies.** C4, C3.
- **Red tests.** `out_of_order_events_do_not_regress_state`,
  `own_update_echo_does_not_loop`,
  `poll_fallback_reconciles_a_missed_webhook`,
  `provider_status_vocabularies_map_to_the_four_states`,
  `rejected_ticket_blocks_apply`,
  `status_sync_idempotent_under_duplicate_delivery`,
  `sync_never_moves_a_change_to_applied_without_an_apply_call`.
- **Governance class.** Path-derived: `unclassified`.
- **Parallel-safe.** Yes after C4. **Size.** L (9 to 12 days).

### C7. Promote durable rules and remove this directory

- **Goal.** Follow `.obvious/skills/doc-authoring/SKILL.md`: promote the
  permission-matrix rules and the MCP allowlist rules to `.obvious/obvious.md`,
  record the ephemeral artifact id, and delete
  `docs/design/sprint-mock-demo-mcp-rbac/`.
- **Files.** `.obvious/obvious.md`, this directory (removal).
- **Dependencies.** All other cards.
- **Red tests.** None (docs). Evidence: a link check shows no dangling
  reference.
- **Governance class.** Path-derived: `policy`.
- **Parallel-safe.** No. **Size.** S (1 day).

---

## Agent runbook

Use this when you are an implementer agent taking a card.

1. **Take one card.** Claim it (comment on the card or its tracking issue) and
   work only on that card. Read PLAN sections 2 to 4 and the card's cited facts.
2. **Own clone and branch.** Make a fresh clone, never a shared working tree.
   Branch from current `origin/main` as `card/<id>-<slug>`, for example
   `card/a2-mock-idp`. Re-fetch `origin/main` before you start and before you push.
3. **Tests first, with committed red evidence.** First commit: the named red
   tests only. Run them against unchanged code and save the failing output (for
   example under `docs/evidence/<card>/red.txt`, or in the PR body). Second
   commit: the implementation. Do not rename or weaken a named test; if a name
   is wrong, change it in the card and say why in the PR.
4. **Mutation check.** After the tests pass, apply at least three deliberate
   mutations to your implementation (for example: skip the signature check,
   widen a scope filter, drop a deny rule) and show each is killed by a named
   test. Restore the source and confirm `git diff` is clean. A surviving mutation
   means a missing test.
5. **Local gates.** `npm run lint`, `npm run typecheck`, `npm test`, and for
   anything touching `pages/` or the bundle, `npm run build` and
   `npm run check:bundle`. Run
   `node scripts/governance/classify-risk.mjs --git origin/main...HEAD` and put
   the result in the PR. Run `git diff --check`.
6. **Small PR, squash only.** One card, one PR. Code revisions merge by
   squash only. The PR body carries a **regression analysis**: the paths and
   behaviors affected, the tests that cover them, what you ran (commands), and
   the result. Also include: Summary, What changed, Evidence (red output,
   mutation table, gates), the observed governance class, and the rollback
   check (a scratch `GIT_INDEX_FILE` with `read-tree`, `apply -R`, `write-tree`
   must equal the base tree). End the body and commits with the attribution
   lines the session provides.
7. **No merge without review.** Per the standing policy, do not merge your own
   PR. It needs the independent challenger review and the Copilot review, with
   conversations resolved, before anyone merges. Restricted classes are never
   eligible for auto-merge (F17).
8. **Security findings go to a security sprint.** If you find a cybersecurity
   problem (yours or pre-existing), do not fix it ad hoc inside a feature PR.
   Record it as a finding with evidence and severity; the owner turns findings
   into cards in a dedicated security sprint. A fix needed to make your own new
   code safe is part of your card; a defect in code you do not own is a finding.
9. **Rules to avoid conflicts.**
   - A card owns exactly its listed files. Do not edit any other file. If you
     need one, stop and record the need on the card; the owner reorders.
   - Cards in one group are file-disjoint by construction. If two seem to
     collide, that is a card bug: report it, do not resolve it by editing both.
   - Only C1 edits `package.json` and `vitest.config.ts`. No card adds a
     dependency.
   - Migration numbering is unresolved (issue #94; F18). Cards must not add
     migrations. Use in-memory stores behind interfaces and list the durable
     store as D8.
   - Files edited by two cards in sequence: `pages/api/v1/cm/change.ts` (B4
     then C3) and `src/costsource/CostSourcePage.tsx` (A8 then B7). Do not start
     the later card before the earlier has merged.
   - `src/costsource/seed.ts`, `sandboxSources.ts`, `CostSourceClient.ts` and
     `MockCostSourceClient.ts` belong to A6 only.
10. **Boundary reminders.** Loopback only, no real credentials, no real data,
    no spend. Keep secrets, tokens and key material out of logs, errors, test
    output and commits. Use U.S. English (en-US) in all prose, comments and
    tests. Do not rename serialized fields or public contracts as part of a card.
11. **Report back.** In the PR, state which red tests you added, which
    mutations you tried, the classifier result, the regression analysis, and
    anything you found that changes PLAN facts or sizes.
