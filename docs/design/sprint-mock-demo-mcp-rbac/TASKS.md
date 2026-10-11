# Sprint backlog: mock-demo environment, MCP-connected access, and role-based access

Read [PLAN.md](./PLAN.md) first. This file turns it into independent task
cards. Facts are cited as F1 to F20 (PLAN section 2) and decisions as D1 to D12
(PLAN section 8). Base: `origin/main` at `62bd8ed`.

Boundary (v2): local and ephemeral only. No production infrastructure, no real
data or credentials, no spend. No card adds a migration (issue #94) or a
dependency. Mocks bind to the loopback interface only.

## How to read a card

- **Files** are the files the card owns. Sprint A cards are file-disjoint:
  no file appears in two cards. New files are marked (new).
- **Red tests** are named; each must fail before the implementation and pass
  after. Names are test or `describe`/`it` titles in the listed test file.
- **Governance class** is what `node scripts/governance/classify-risk.mjs`
  should report for the card's diff, derived from `scripts/governance/risk-rules.json`
  (F17). Observe it on the real diff and report any difference in the PR. The
  classifier has no class called "ingestion"; the closest is
  `financial_semantics`, which every `src/costsource/**` path triggers.
  A path in no rule is `unclassified` and counts as restricted (fail closed).
  Added lines that contain `fetch(`, a URL literal, or a dynamic import trigger
  `network_egress` anywhere under `src/` or `pages/`, including in tests.
- **Parallel-safe** means the card can run at the same time as every other card
  in its group.
- **Size** uses the PLAN section 6 scale: S is 1 to 3 days, M is 4 to 8, L is 9
  to 15.

## Ordering

| Sprint | Cards | Rule |
|---|---|---|
| A | A1, A2, A3, A4, A5, A6, A7, A8 | All start at once. No dependencies. File-disjoint. |
| B, wave 1 | B1, B4, B5, B6 | Start when their Sprint A dependencies merge. File-disjoint with each other. |
| B, wave 2 | B2, B3 | Start when B1 merges. File-disjoint with each other. |
| C | C1, C2, C3, C4, C5, C6, C7 | C2 after B1; C3 and C6 after B4; C4 and C5 after C3; C1 after B3; C7 last. |

Dependency map: B1 needs A1 and A2. B2 needs B1 and A1. B3 needs B1, A1 and A3.
B4 needs A4. B5 needs A1 and A5. B6 needs A6. C1 needs B3, A2 and A3. C2 needs
B1 and A1. C3 needs B4, B1 and A1. C4 needs C3 and A4. C5 needs B1 and C3. C6
needs B4 and A4. C7 needs everything.

## File ownership, Sprint A (proof of disjointness)

| Card | Owns |
|---|---|
| A1 | `src/identity/types.ts`, `src/rbac/matrix.ts`, `src/rbac/authorize.ts`, `src/rbac/matrix.test.ts`, `src/rbac/authorize.test.ts` |
| A2 | `src/mock/idp/**` |
| A3 | `src/mock/personaData/**` |
| A4 | `src/mock/itsm/**` |
| A5 | `src/mock/mcp/**` |
| A6 | `src/costsource/sandboxSources.ts`, `src/costsource/seed.ts`, `src/costsource/syntheticCloudSeed.ts` (new), `src/costsource/syntheticCloudMapping.ts` (new), `src/costsource/sourcesForEnvPurity.test.ts`, `src/costsource/syntheticCloudSandbox.test.ts` (new), `src/costsource/sandboxAllowlist.test.ts` (new), `src/connectors/ConnectorCard.tsx`, `src/connectors/ConnectorCard.test.tsx` |
| A7 | `src/lib/format.ts`, `src/lib/format.test.ts` (new), `pages/_document.tsx`, `public/favicon.svg` (new), `src/lib/documentHead.test.ts` (new) |
| A8 | `src/simulation/SimulationBar.tsx`, `src/simulation/SimulationBar.test.tsx` (new), `src/costsource/CostSourcePage.tsx`, `src/costsource/findingsHeader.test.tsx` (new), `pages/demo.tsx`, `src/ai/MockAIClient.ts`, `src/ai/demoPrompts.test.ts` (new) |

A card that needs a file it does not own stops and records the need on the card
(see the runbook). It does not edit the file.

---

## Sprint A (parallel group, no dependencies)

### A1. Permission matrix, roles and the `authorize()` decision function

- **Goal.** Define the six roles, the `Principal` and `Verdict` types (PLAN 4.2,
  copied literally), the persona-by-view and persona-by-action-by-environment
  matrices (PLAN 4.4 and 4.5) as data, and one pure `authorize(principal,
  action, resource)` function. No route is changed.
- **Files.** As listed in the ownership table.
- **Dependencies.** None.
- **Red tests.**
  - `src/rbac/authorize.test.ts`: `denies_by_default_when_no_principal`,
    `denies_unknown_action_and_unknown_role`,
    `eng_lead_cannot_read_other_team_rows`,
    `eng_lead_prod_apply_requires_approved_ticket`,
    `requester_cannot_approve_own_change`,
    `auditor_has_no_write_action_in_any_env`,
    `mcp_write_tool_denied_for_every_role_and_env`,
    `token_env_not_in_envs_is_denied`,
    `teams_star_grants_all_teams_but_empty_teams_grants_none`.
  - `src/rbac/matrix.test.ts`: `matrix_covers_every_page_and_api_route` (walks
    `pages/` with `fs`; fails when a route has no row and is not marked public),
    `matrix_view_codes_match_plan_section_4_4` (golden table),
    `matrix_action_cells_match_plan_section_4_5` (golden table),
    `matrix_does_not_exceed_simulation_permissions` (compares the matrix with
    the simulation table in F6, restated as constants with the source line).
- **Governance class expected.** `auth_tenancy` for `authorize.ts` (path matches
  the `auth` pattern); `unclassified` for `types.ts` and `matrix.ts`; tests are low.
- **Parallel-safe.** Yes. **Size.** S (2 to 3 days).
- **Notes.** The matrix is a proposal until D2. Keep it in one data file so a
  later change is a one-file edit with regenerated golden tables.

### A2. Mock identity provider issuing signed test JWTs

- **Goal.** A local issuer and verifier for test JWTs with `role`, `teams`,
  `envs`, `tenant`, `aud` (deployment environment), `jti`, `exp`, plus
  revocation and key rotation. It returns raw claims; it does not import A1. The
  mapping to `Principal` is card B1. Write it so that a real OIDC verifier can
  replace it without changing callers (PLAN 4.6).
- **Files.** `src/mock/idp/issuer.ts`, `verifier.ts`, `claims.ts`, `index.ts`,
  `idp.test.ts` (all new). Use `node:crypto` with EdDSA or ES256 and JWK export;
  do not write PEM blocks (a PEM header line triggers the `secrets` class).
- **Dependencies.** None.
- **Red tests (`src/mock/idp/idp.test.ts`).**
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
- **Governance class expected.** `unclassified` for the source files (restricted
  by fail-closed); tests low unless they add `fetch(` or URL literals.
- **Parallel-safe.** Yes. **Size.** S (2 to 3 days).

### A3. One dataset, persona projections, and the accuracy oracle

- **Goal.** A single synthetic dataset (integer cents, 3 teams by 3 environments
  with several line items, including values that expose floating-point error) and
  pure projections for each persona: CTO roll-up, FinOps lead drill-down,
  Finance, Eng lead (one team), Procurement, Auditor. Projections take a scope
  `{teams, envs}` defined locally in this card, so it does not depend on A1. A
  committed oracle file holds hand-checked expected totals for every persona.
- **Files.** `src/mock/personaData/dataset.ts`, `scope.ts`, `projections.ts`,
  `oracle.fixture.json`, `projections.test.ts` (all new). Avoid file names
  containing `reconcil`, `focus` or `normaliz` (they trigger `financial_semantics`).
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
- **Governance class expected.** `unclassified`; tests low.
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).
- **Notes.** The oracle must not be produced by the code under test.

### A4. Mock Jira and mock ServiceNow ITSM servers

- **Goal.** Two tiny loopback HTTP servers implementing the wire subset the
  existing adapters use (PLAN section 7), with controllable status transitions
  and failure injection. The real `JiraAdapter` is exercised end to end
  against the Jira stub in this card (it already accepts a base URL, F8). The
  real `ServiceNowAdapter` cannot reach a plain-HTTP stub until card B4 adds
  the base-URL seam, so this card tests the ServiceNow stub's contract with raw
  requests only.
- **Files.** `src/mock/itsm/jiraStub.ts`, `serviceNowStub.ts`, `state.ts`,
  `index.ts`, `itsm.test.ts` (all new). Import `JiraAdapter` from
  `pages/api/v1/cm/change.ts` read-only; do not edit that file.
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
- **Governance class expected.** `network_egress` (added `fetch(` and URL
  literals), plus `unclassified` paths.
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).

### A5. Mock MCP server with fixture tools

- **Goal.** A loopback JSON-RPC MCP server (`initialize`, `tools/list`,
  `tools/call`) with read-only fixture tools (portfolio summary, cost by team,
  ticket status) and one deliberately write-capable tool, so later cards can
  prove the allowlist blocks it. Per-team credentials return only that team's
  rows. Frank-specific tools belong to the separate proposal on branch
  `docs/frank-mcp-proposal`; do not add them here.
- **Files.** `src/mock/mcp/server.ts`, `tools.ts`, `protocol.ts`, `index.ts`,
  `mcp.test.ts` (all new).
- **Dependencies.** None.
- **Red tests (`mcp.test.ts`).**
  `initialize_returns_protocol_version_and_capabilities`,
  `tools_list_returns_fixture_tools_with_readOnly_annotations`,
  `tools_call_portfolio_summary_returns_structured_content`,
  `tools_call_unknown_tool_returns_jsonrpc_method_not_found`,
  `tools_call_before_initialize_is_rejected`,
  `write_capable_tool_mutates_state_only_when_called`,
  `team_credential_returns_only_that_teams_rows`,
  `wrong_team_credential_gets_401`,
  `secret_never_appears_in_server_log_or_error_body`,
  `server_binds_loopback_only`.
- **Governance class expected.** `network_egress`; paths `unclassified`.
- **Parallel-safe.** Yes. **Size.** S (2 to 3 days).

### A6. Synthetic AWS, Azure and GCP sandbox sources (owner-approved)

- **Status.** Owner-approved (demo audit, Option C).
- **Goal.** Add three offline FOCUS sandbox sources: `aws-sandbox`,
  `azure-sandbox`, `gcp-sandbox`. Each has `ProviderName` set to `SyntheticAWS`,
  `SyntheticAzure` or `SyntheticGCP`, its own `BillingAccountId`,
  `SubAccountId`, region and `ServiceName` catalog, and a visible "synthetic"
  chip on its connector card. Each is gated through `isOfflineSandboxSource`
  and is served only by the anonymous sandbox routes. The per-source workload
  mapping is an explicit table; rows with no mapping carry a `ResourceId`
  outside the `arn:ratio:workload/` prefix, so `resolveWorkloadId` returns null
  and other views either follow the mapping or show "not attributed".
- **Must not break the existing three sandbox sources** (`pointfive-sandbox`,
  `focus-file-sandbox`, `servicenow-sandbox`). Their ids, descriptors, rows,
  health and anonymous access stay byte-for-byte identical. Capture a golden
  hash of their rows on main in the first (red) commit and assert it stays.
- **Files.** As listed in the ownership table. Must not touch
  `src/costsource/CostSourcePage.tsx` (A8), `src/server/gateway/**`, or any
  normalization or version-shim file. Live connector ids (the config-driven
  FOCUS export connectors) must stay out of the allowlist.
- **Dependencies.** None.
- **Red tests.**
  - `src/costsource/sandboxAllowlist.test.ts`:
    `existing_three_sandbox_ids_unchanged_and_still_anonymous`,
    `allowlist_is_exactly_the_six_sandbox_ids`,
    `isOfflineSandboxSource_true_for_aws_azure_gcp_sandbox`,
    `no_live_connector_id_is_in_the_allowlist`,
    `near_miss_ids_denied` (trailing space, case change, path suffix),
    `gateSourceAccess_passes_new_sandbox_ids_without_a_token_and_still_401s_live_ids`.
  - `src/costsource/sourcesForEnvPurity.test.ts` (extend):
    `sourcesForEnv_is_pure_with_six_sandbox_descriptors` (identical with and
    without a populated `process.env`).
  - `src/costsource/syntheticCloudSandbox.test.ts`:
    `rows_use_synthetic_provider_names`,
    `each_source_has_its_own_billing_account_subaccount_region_and_service_names`,
    `no_real_looking_account_ids_or_credentials_in_seed` (scan for access-key
    prefixes, 12-digit account numbers, GUID tenants),
    `row_totals_match_committed_oracle_per_source`,
    `mapping_is_explicit_every_row_maps_or_is_not_attributed`,
    `unmapped_row_resolves_to_null_not_a_default_workload`,
    `anonymousSourceView_leaves_new_sandbox_descriptors_unchanged`,
    `health_for_new_sources_reports_synthetic_and_makes_no_network_call`,
    `existing_three_sources_rows_are_byte_identical_to_main`,
    `sandbox_rows_route_serves_new_sources_anonymously_and_live_ids_still_401`.
  - `src/connectors/ConnectorCard.test.tsx` (extend):
    `connector_card_shows_synthetic_chip_for_new_sources`.
- **Governance class expected.** `financial_semantics` (all `src/costsource/**`
  paths). `src/connectors/ConnectorCard.tsx` is `unclassified`. There is no
  "ingestion" class in the classifier; ask for the reviewer path used for
  ingestion-affecting changes anyway, because rows enter the normalization shim.
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).

### A7. Demo fixes: negative dollar sign and favicon

- **Goal.** `formatUSD` renders negatives as `-$5.00`, `-$1,500`, `-$2.5k`;
  negative zero and values that round to zero render without a sign; positive
  output is unchanged. Add a favicon and link it in the document head.
- **Files.** As listed in the ownership table.
- **Dependencies.** None.
- **Red tests.** `src/lib/format.test.ts`:
  `formatUSD_negative_whole_dollars_puts_minus_before_the_symbol`,
  `formatUSD_negative_cents_renders_minus_dollar_5_00`,
  `formatUSD_negative_compact_renders_minus_dollar_2_5k`,
  `formatUSD_negative_zero_and_tiny_negative_render_as_dollar_0_00`,
  `formatUSD_positive_output_matches_main_for_a_table_of_values`.
  `src/lib/documentHead.test.ts`: `document_head_links_an_icon_that_exists_in_public`.
- **Governance class expected.** `routes` (`pages/_document.tsx`);
  `unclassified` for `format.ts` and `public/favicon.svg`.
- **Parallel-safe.** Yes. **Size.** S (1 day).
- **Notes.** `MockAIClient.ts` has its own local `formatUSD` built on `Intl`
  currency; it is out of scope.

### A8. Demo fixes: dead link, findings header, `/demo` prompts

- **Goal.** (a) Hide "Customer sign-in simulation" when the simulation is
  disabled (`access.enabled` is false). (b) Name the actual source in the
  findings card title instead of always "PointFive DeepWaste shape", including
  ServiceNow. (c) Make every `/demo` prompt produce a non-help mock Frank reply,
  and make the mock Frank help list prompts that classify to their own intent.
- **Files.** As listed in the ownership table. Must not touch
  `src/costsource/seed.ts` or `ConnectorCard.tsx` (A6).
- **Dependencies.** None.
- **Red tests.**
  `src/simulation/SimulationBar.test.tsx`:
  `hides_sign_in_link_when_simulation_disabled`,
  `shows_sign_in_link_when_enabled_and_signed_out`.
  `src/costsource/findingsHeader.test.tsx`:
  `findings_header_names_servicenow_for_the_servicenow_source`,
  `findings_header_keeps_pointfive_deepwaste_for_pointfive`.
  `src/ai/demoPrompts.test.ts`:
  `every_demo_prompt_gets_a_non_help_mock_frank_reply`,
  `help_reply_prompts_each_classify_to_a_distinct_intent`.
- **Governance class expected.** `routes` (`pages/demo.tsx`); others `unclassified`.
- **Parallel-safe.** Yes. **Size.** S (1 to 2 days).
- **Notes.** Today two of the three `/demo` prompts return the help text (F19e).

---

## Sprint B

### B1. Gateway accepts a verified principal (wrap, then replace)

- **Goal.** `withGateway` authenticates through a `TokenVerifier` first
  (`MockIdpVerifier`, mapping A2 claims to the A1 `Principal`), then falls back
  to the legacy shared token as a `legacy-shared-token` principal with a narrow
  fixed grant. Handlers receive `{principal, tenant}`. The offline default
  (no token, mock provider, no enforcement) stays exactly as F1 describes.
- **Files.** `src/server/gateway/principal.ts` (new), `src/server/gateway/auth.ts`,
  `src/server/gateway/withGateway.ts`, `src/server/gateway/index.ts`,
  `src/identity/mockIdpVerifier.ts` (new), `src/server/gateway/principal.test.ts` (new).
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
  `wrong_role_returns_403_before_the_handler_runs`,
  `existing_gateway_tests_pass_unchanged`.
- **Governance class expected.** `auth_tenancy` (restricted).
- **Parallel-safe.** Yes within wave 1. **Size.** M (4 to 7 days).
- **Notes.** This is where the single shared `RATIO_API_TOKEN` is wrapped
  (PLAN 4.3). Retirement is D9.

### B2. Live-data gate accepts a principal

- **Goal.** `evaluateLiveDataAuth` and `gateSourceAccess` accept a principal
  with a data-read grant in place of the shared token. Failed-attempt
  accounting, the weak-token refusal and sandbox anonymity stay.
- **Files.** `src/server/gateway/liveDataAuth.ts`,
  `pages/api/costsource/{rows,findings,health,sources}.ts`,
  `pages/api/v1/connectors/index.ts`, `src/server/gateway/liveDataPrincipal.test.ts` (new).
- **Dependencies.** B1, A1.
- **Red tests.**
  `principal_with_cost_read_grant_passes_live_gate_without_the_shared_token`,
  `principal_without_grant_gets_403_not_401`,
  `sandbox_ids_still_anonymous`,
  `failed_auth_throttle_still_counts_per_ip`,
  `weak_shared_token_still_returns_503`,
  `auditor_cannot_configure_connectors`,
  `finops_lead_can_configure_connectors`,
  `eng_lead_live_rows_filtered_to_own_team`.
- **Governance class expected.** `auth_tenancy`, `routes`, `financial_semantics`.
- **Parallel-safe.** Yes with B3. **Size.** M (4 to 6 days).

### B3. Authenticate and scope the open routes; route-level matrix test

- **Goal.** Put `attribution`, `tokenomics`, `prediction/predict`,
  `prediction/accuracy`, `report/snapshot` and `costsource/ingest` behind
  authentication and the scope filter (F3). `hello` becomes an explicit public
  liveness route in the matrix. Add the generated persona-by-route-by-environment
  test (PLAN 4.7, item 7).
- **Files.** `pages/api/attribution.ts`, `pages/api/tokenomics.ts`,
  `pages/api/prediction/predict.ts`, `pages/api/prediction/accuracy.ts`,
  `pages/api/report/snapshot.ts`, `pages/api/costsource/ingest.ts`,
  `src/attribution/**` (scope filters), `src/server/routeMatrix.test.ts` (new).
- **Dependencies.** B1, A1, A3.
- **Red tests (`routeMatrix.test.ts` and route tests).**
  `every_api_route_is_in_the_permission_matrix_or_explicitly_public`,
  `route_matrix_persona_by_env_by_route_matches_plan_4_4_and_4_5`,
  `anonymous_gets_401_on_attribution_tokenomics_prediction_report_and_ingest`,
  `eng_lead_attribution_has_no_other_team_rows_or_totals`,
  `cto_attribution_rollup_equals_finops_drilldown_total`,
  `user_dimension_attribution_denied_for_cto_finance_eng_procurement`,
  `auditor_post_to_ingest_returns_403`,
  `report_snapshot_export_is_scoped_to_the_caller`,
  `query_param_cannot_override_team_or_env_scope`,
  `role_in_query_or_header_is_ignored`.
- **Governance class expected.** `routes`, `auth_tenancy` (paths and `auth`
  patterns), `financial_semantics` if `src/costsource` is touched.
- **Parallel-safe.** Yes with B2. **Size.** L (9 to 14 days). Split by route if
  review capacity is short.

### B4. ITSM adapter seam and outbound hardening

- **Goal.** Let the ServiceNow adapter take a base URL (honored for a loopback
  stub only when an explicit mock flag is set), require the instance host to
  match an allowlist, add a timeout on every outbound call, retry only safe
  reads with the existing backoff helper (F20), and run both real adapters end
  to end against the A4 stubs.
- **Files.** `pages/api/v1/cm/change.ts`, `src/cm/outbound.ts` (new),
  `src/cm/itsmStub.e2e.test.ts` (new). The existing `ticketRefRoute.test.ts`
  must pass unchanged.
- **Dependencies.** A4.
- **Red tests.**
  `servicenow_adapter_create_attach_status_end_to_end_against_stub`,
  `servicenow_base_url_override_only_honored_with_mock_flag_and_loopback`,
  `servicenow_instance_host_must_match_allowlist`,
  `jira_base_url_in_private_range_refused_without_mock_flag`,
  `outbound_call_times_out_and_returns_a_fixed_502`,
  `get_retries_on_429_and_5xx_with_backoff_then_gives_up`,
  `create_is_never_retried_automatically`,
  `credentials_never_appear_in_logs_or_error_bodies`,
  `ticket_ref_grammar_tests_still_pass_unchanged`.
- **Governance class expected.** `routes`, `network_egress`.
- **Parallel-safe.** Yes within wave 1. **Size.** S (2 to 4 days).
- **Notes.** Avoid added lines that assign to a variable named like a password
  (the `secrets` rule matches that pattern); keep credentials as constructor
  parameters.

### B5. Generic MCP client with allowlist, environment and team scoping

- **Goal.** A transport-agnostic MCP client: `initialize` first, `tools/list`
  filtered to an allowlist, `tools/call` only for allowlisted read-only tools,
  per-role tool allowlist enforced through `authorize()`, an endpoint registry
  keyed by environment, and per-team credential references resolved server-side.
  Read-only first. The PointFive scaffold is untouched (F12).
- **Files.** `src/mcp/client.ts`, `allowlist.ts`, `registry.ts`, `index.ts`,
  `mcp.client.test.ts` (all new). Tests run against the A5 mock server.
- **Dependencies.** A1, A5.
- **Red tests.**
  `unknown_tool_denied_before_any_network_call`,
  `tool_not_marked_read_only_is_denied`,
  `role_allowlist_blocks_a_tool_the_role_is_not_listed_for`,
  `dev_principal_cannot_reach_a_prod_endpoint`,
  `team_credential_resolved_server_side_and_never_returned`,
  `eng_lead_gets_only_own_team_rows_through_an_mcp_tool`,
  `planted_secret_absent_from_logs_errors_and_audit`,
  `initialize_precedes_tools_call`,
  `tools_list_result_is_filtered_to_the_allowlist`,
  `response_size_and_time_limits_are_enforced`,
  `tool_result_text_is_returned_as_data_and_never_executed`,
  `pointfive_mcp_tests_pass_unchanged`.
- **Governance class expected.** `network_egress`; paths `unclassified`.
- **Parallel-safe.** Yes within wave 1. **Size.** M (5 to 8 days).
- **Notes.** Frank-specific tool design: see the separate proposal.

### B6. Other views follow the synthetic mapping

- **Goal.** Wherever the cost-source and connector views show rows from the new
  sandbox sources, they follow the A6 mapping or say "not attributed". No view
  assigns an unmapped row to a default workload.
- **Files.** `src/connectors/IngestVerification.tsx`, `src/connectors/connectorWalk.test.ts`
  additions in a new test file `src/connectors/syntheticAttribution.test.tsx` (new).
- **Dependencies.** A6.
- **Red tests.** `mapped_row_links_to_its_workload`,
  `unmapped_row_shows_not_attributed`,
  `no_view_defaults_an_unmapped_row_to_a_workload`.
- **Governance class expected.** `unclassified`.
- **Parallel-safe.** Yes within wave 1. **Size.** S (1 to 2 days).

---

## Sprint C

### C1. Browser persona matrix and local launcher

- **Goal.** A Playwright spec that signs in as each persona with mock tokens and
  checks navigation, page content and totals; a script to start the app with the
  mock IdP, ITSM stubs and MCP server. This card is the only one that edits
  `package.json` (scripts only, no dependency).
- **Files.** `tests/personas/*.spec.ts` (new), `playwright.personas.config.ts`
  (new), `scripts/mock/start.mjs` (new), `package.json` (scripts).
- **Dependencies.** B3, A2, A3.
- **Red tests.** `cto_and_finops_lead_see_reconciling_totals_on_overview`,
  `each_persona_nav_shows_only_permitted_links`,
  `eng_lead_sees_only_own_team_workloads`,
  `direct_url_to_a_forbidden_page_shows_a_403_state`,
  `role_change_reissue_takes_effect_after_reload`,
  `expired_token_redirects_to_sign_in`,
  `replayed_single_use_token_fails`.
- **Governance class expected.** `dependencies` (package.json), `unclassified`.
- **Parallel-safe.** Yes with C2 to C6. **Size.** M (4 to 6 days).

### C2. Persona comes from the verified principal

- **Goal.** The active persona and navigation derive from the server-verified
  principal, not `localStorage`. The switcher only offers lenses the role
  already allows. `LiveCMClient` sends the session credential and handles 401
  and 403 (F11).
- **Files.** `src/lib/persona.ts`, `src/components/layout/NavBar.tsx`,
  `src/components/TechnicalViewToggle.tsx`, `src/cm/LiveCMClient.ts`,
  `src/lib/personaPrincipal.test.ts` (new).
- **Dependencies.** B1, A1.
- **Red tests.** `persona_comes_from_verified_principal_not_localstorage`,
  `switcher_only_offers_lenses_the_role_allows`,
  `nav_hides_links_the_role_cannot_open`,
  `live_cm_client_sends_credential_and_surfaces_401_and_403`,
  `tampered_localstorage_persona_has_no_effect_on_api_results`.
- **Governance class expected.** `unclassified`.
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).

### C3. Change lifecycle: idempotency, binding, approval gating, update

- **Goal.** Idempotency keys on create, ticket-to-change binding, apply gated on
  an approved bound ticket in prod, requester not equal approver, an `update`
  operation (comment and transition), and a per-provider outbound rate limit.
  State is in memory and sits behind an interface (D8).
- **Files.** `src/cm/lifecycle.ts` (new), `src/cm/changeStore.ts` (new),
  `pages/api/v1/cm/change.ts`, `src/cm/lifecycle.test.ts` (new).
- **Dependencies.** B4, B1, A1.
- **Red tests.**
  `same_idempotency_key_returns_first_ticket_and_creates_one_upstream_ticket`,
  `same_key_with_different_payload_returns_409`,
  `apply_without_a_bound_ticket_is_denied_in_prod`,
  `apply_with_a_ticket_not_approved_returns_409`,
  `requester_cannot_approve_own_change`,
  `approval_by_another_principal_moves_state_to_approved`,
  `double_approve_and_apply_before_approve_are_rejected`,
  `update_operation_transitions_the_ticket_via_the_stub`,
  `outbound_rate_limit_returns_429_with_retry_after`,
  `ticket_ref_grammar_still_enforced_on_all_new_operations`,
  `a_bound_ticket_cannot_be_rebound`.
- **Governance class expected.** `routes`, `auth_tenancy`.
- **Parallel-safe.** Yes with C1, C2, C5 (C5 reads the store interface only), C6.
  **Size.** M (4 to 7 days).

### C4. Inbound webhook and two-way status sync

- **Goal.** A webhook route that verifies an HMAC signature over the raw body, a
  timestamp window and event-id replay protection, plus one state machine that
  maps provider statuses to `requested`, `approved`, `applied`, `rejected`, with
  a polling fallback for missed events.
- **Files.** `pages/api/v1/cm/webhook.ts` (new), `src/cm/webhookSignature.ts`
  (new), `src/cm/replayStore.ts` (new, in memory behind an interface),
  `src/cm/statusSync.ts` (new), `src/cm/webhook.test.ts` (new).
- **Dependencies.** C3, A4.
- **Red tests.** `valid_signature_within_window_is_accepted`,
  `bad_signature_is_rejected_with_constant_time_compare`,
  `signature_is_computed_over_raw_body_bytes_not_reserialized_json`,
  `timestamp_outside_window_is_rejected`,
  `replayed_event_id_is_rejected_and_state_is_unchanged`,
  `event_for_unknown_ticket_is_ignored_without_creating_state`,
  `out_of_order_events_do_not_regress_state`,
  `own_update_echo_does_not_loop`,
  `poll_fallback_reconciles_a_missed_webhook`,
  `provider_status_vocabularies_map_to_the_four_states`,
  `webhook_fails_closed_without_a_configured_secret`,
  `webhook_secret_never_logged`.
- **Governance class expected.** `routes`, `auth_tenancy`, `secrets` if the
  tests contain assignments that match the secret patterns.
- **Parallel-safe.** Yes with C1, C2, C5, C6. **Size.** L (8 to 12 days).

### C5. Audit records for every decision

- **Goal.** Every `authorize()` verdict and every change step writes a record
  (who, action, environment, verdict, ticket linkage) with no secrets, tokens
  or email addresses. In-memory sink behind an interface (D8). Reads are scoped
  by role (PLAN 4.5).
- **Files.** `src/audit/sink.ts`, `record.ts`, `index.ts`, `audit.test.ts` (all new).
- **Dependencies.** B1, C3 (interface only).
- **Red tests.** `every_authorize_decision_writes_an_audit_record`,
  `audit_record_has_no_secret_token_or_email`,
  `audit_links_request_ticket_approval_and_apply`,
  `audit_read_is_scoped_by_role_and_team`,
  `audit_sink_failure_denies_the_action`.
- **Governance class expected.** `unclassified` (paths) plus `auth_tenancy` if
  the file names contain `auth`.
- **Parallel-safe.** Yes. **Size.** S (2 to 4 days).

### C6. OAuth2 client-credentials client behind an interface

- **Goal.** A token client (cache until expiry, single refresh on 401, host
  allowlist) and a mock token endpoint, proving the shape only. Wiring it into
  the adapters is owner decision D4 and is not done.
- **Files.** `src/cm/oauthClient.ts` (new), `src/mock/itsm/oauth.ts` (new),
  `src/cm/oauthClient.test.ts` (new). Does not edit `pages/api/v1/cm/change.ts`.
- **Dependencies.** B4, A4.
- **Red tests.**
  `token_fetched_with_client_credentials_and_cached_until_expiry`,
  `expired_token_is_refetched_once`,
  `a_401_triggers_a_single_refresh_then_fails`,
  `client_secret_never_logged`,
  `token_endpoint_host_must_be_allowlisted`,
  `basic_and_bearer_modes_still_work`.
- **Governance class expected.** `network_egress`, possibly `secrets`.
- **Parallel-safe.** Yes. **Size.** M (4 to 6 days).

### C7. Promote durable rules and remove this directory

- **Goal.** Follow `.obvious/skills/doc-authoring/SKILL.md`: promote the
  permission-matrix rules and the MCP allowlist rules to `.obvious/obvious.md`,
  record the ephemeral artifact id, and delete `docs/design/sprint-mock-demo-mcp-rbac/`.
- **Files.** `.obvious/obvious.md`, this directory (removal).
- **Dependencies.** All other cards.
- **Red tests.** None (docs). Evidence: link check shows no dangling reference.
- **Governance class expected.** `policy`.
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
6. **Small PR.** One card, one PR. Describe: Summary, What changed, Evidence
   (red output, mutation table, gates), the observed governance class, and the
   rollback check (a scratch `GIT_INDEX_FILE` with `read-tree`, `apply -R`,
   `write-tree` must equal the base tree). End the body and commits with the
   attribution lines the session provides.
7. **No merge without review.** Per the standing policy, do not merge your own
   PR. It needs the independent challenger review and the Copilot review, with
   conversations resolved, before anyone merges. Restricted classes are never
   eligible for auto-merge (F17).
8. **Rules to avoid conflicts.**
   - A card owns exactly its listed files. Do not edit any other file. If you
     need one, stop and record the need on the card; the owner reorders.
   - Sprint A cards are file-disjoint by construction. If two cards seem to
     collide, that is a card bug: report it, do not resolve it by editing both.
   - Only C1 edits `package.json`. No card adds a dependency.
   - Migration numbering is unresolved (issue #94; F18). Cards must not add
     migrations. Use in-memory stores behind interfaces and list the durable
     store as D8.
   - `pages/api/v1/cm/change.ts` is owned by B4, then by C3. Do not start C3
     before B4 has merged.
   - `src/costsource/seed.ts` and `sandboxSources.ts` belong to A6 only.
9. **Boundary reminders.** Loopback only, no real credentials, no real data,
   no spend. Keep secrets, tokens and key material out of logs, errors, test
   output and commits. Use U.S. English (en-US) in all prose, comments and tests.
   Do not rename serialized fields or public contracts as part of a card.
10. **Report back.** In the PR, state which red tests you added, which
    mutations you tried, the classifier result, and anything you found that
    changes PLAN facts or sizes.
