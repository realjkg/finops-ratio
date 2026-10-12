# Sprint backlog: mock-demo environment, MCP-connected access, and role-based access

Read [PLAN.md](./PLAN.md) first. This file turns it into independent task
cards. Facts are cited as F1 to F22 (PLAN section 2) and decisions as D1 to D15
(PLAN section 8). Cards that have merged are kept as short status records; the
merged code is the reference for them. The Frank design keeps being revised:
cite its DESIGN sections (3.3 key table, 3.8, 2.6, A18 to A21), never a
revision or commit, and read the current file before starting B5. EVIDENCE.md
lists how the facts and the merged-card records were checked.

## Status and next slices

Checked against `origin/main` at `b6957ac` on 2026-10-12.

| Card or slice | State |
|---|---|
| A1 authorize contract | Merged, #103 (`0e097a2`) |
| A2 mock IdP | Merged, #104 (`de7e5b4`) |
| A3 persona projections and accuracy oracle | Merged, #105 (`039e9b6`) |
| A4 mock Jira and ServiceNow | Open and held, #106 (D15 recommends cutting it to what A1 needs) |
| A5 mock MCP server | Open and held, #107 (same) |
| A6 synthetic cloud sandboxes | Merged, #108 (`6acd2ba`) |
| A7 money sign and favicon | Merged, #109 (`a3c1437`); follow-up #111 (`e184a44`) |
| A8 sign-in link, findings header, `/demo` prompts | Merged, #110 (`8ce4f73`) |
| Outside the cards, merged | Frank mock analytics #99 and its hardening #102 (`a90dda5`); Frank MCP design revisions #101 (`0ace878`); AI-spend-versus-total ratio card #112 (`c95be35`); UI theme slice T1 #113 (`145565f`) |
| Sprint A2, C and D cards | Not started. B1, B6 and B8 have all their dependencies merged; B4 and B5 wait for A4 and A5 (and D15); B7 has A8 merged; the rest wait on earlier waves |

**Pending owner decision D15 (MVP re-scope).** The recommendation is in PLAN
section 8. Nothing below is re-scoped until the owner decides.

**Next slices outside this plan's card IDs.** Two in-flight series use their
own labels; their `C` labels are **not** this plan's cards C1 to C8.

- Connector correctness, C1 to C5. C1 merged as #114 (`6f37afd`): FOCUS
  normalization by the specification's column history, with documented-format
  fixtures in `fixtures/connector-formats/`. C3 merged as #115 (`b6957ac`):
  anonymous `/connectors` visitors get a labeled simulation over those fixtures
  for the live connector ids instead of a 401 banner with Retry (server policy
  unchanged). The live targets for Nutanix, Kubernetes (OpenCost core has no
  FOCUS export) and PointFive remain unverified; their simulated cards use
  illustrative payloads labeled "format not verified".
- Workload attribution from cost-row tags (in this series): a non-simulated
  row whose `Tags` column holds `ratio:workload` equal to the id of a loaded
  workload resolves to it when `ResourceId` carries no workload identity
  (`WORKLOAD_TAG_KEY` in `src/costsource/normalize.ts`; the key is exact and
  case-sensitive, the value is trimmed, duplicate keys in a JSON string resolve
  last-wins). An explicit `arn:ratio:workload/` ResourceId is never replaced by
  a tag, even when it names an unloaded workload. Simulated rows (`synthetic:`
  ResourceId) and unknown or malformed values stay unresolved. Only direct
  ingest keeps `Tags`; the connector path drops it.
- UI themes, T1 to T4: T1 token layer, built-in themes, contrast engine and
  validator (merged, #113); T2 theme switcher and user themes; T3 typography
  settings; T4 inline colors moved onto tokens, with a guard test.

Boundary (v2): local and ephemeral only. No production infrastructure, no real
data or credentials, no spend. No card adds a migration (issue #94) or a
dependency. Mocks bind to the loopback interface only.

## Naming of sprints

The persona and RBAC wiring group (cards B1 to B12) is **Sprint A2**; the IDs are kept. **Sprint B is reserved for the live connectors for ingest**; its cards are drafted with its first code slice, not here. **Sprint C** is the portal UI (cards C1, C2, C5); **Sprint D** is the ITSM change lifecycle (cards C3, C4, C6, C8, with C7 parked last). Because of the dependencies, C5 (Sprint C) depends on C3 (Sprint D), C2 needs C5 and C1 needs C2 and C5, so no Sprint C card can start before C3 merges: **Sprints C and D run as one pool, with C3 first.** "Sprint A2" is a sprint name; card A2 (the mock identity provider) is unrelated.

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
- Mock IdP gate (one function, used everywhere). Card A2 owns
  `mockIdpEnabled(env)` in `src/mock/idp/enabled.ts`: true only when
  `RATIO_MOCK_IDP` is exactly `1` **and** the raw `RATIO_ENV` is exactly
  `development` or `test` (an allow-list, so unset, empty, `staging`,
  `production`, `prod`, `Production` and a value with surrounding spaces all
  give false; no trimming, the same as `simulationEnabled` in
  `src/simulation/server/enabled.ts`). `NODE_ENV` plays no
  part (a production build run with `RATIO_ENV=test` is enabled). The A2
  issuer, B1's `MockIdpVerifier`, B7's login and `mock-control` routes all call it
  (B11's sign-in page does not; it learns from a 404 from login).
  **Login and `mock-control` are additionally local-only, enforced
  independently of the environment variables**: card B7's
  `src/session/loopback.ts` exports `isLoopbackRequest({remoteAddress, host})`
  (merged A2 does not include it), true only for a loopback
  peer (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) **and** a `Host` of
  `127.0.0.1` or `localhost` (with any port); both routes answer 404 otherwise,
  and `X-Forwarded-*` headers are ignored. Residual, stated plainly: behind a
  reverse proxy running on the same machine the peer would be loopback, so the
  mock must never be run behind a proxy; and a user on the machine itself can
  always reach it. Every `pages/api` file ships in the production
  bundle; the mock routes are gated by this runtime check only and are not
  excluded from the bundle. `mock-control` additionally requires the header
  `X-Mock-Control-Secret` to equal `RATIO_MOCK_CONTROL_SECRET` (a random value
  generated by the C1 launcher and never printed by it; both sides are hashed
  with SHA-256 before `timingSafeEqual`, as in `src/server/gateway/auth.ts`,
  because `timingSafeEqual` throws on unequal lengths; the route is 404 when the
  variable is unset), because it has no session and a browser-style CSRF check
  protects nothing there.
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
- Verdict sink. `src/server/gateway/verdictSink.ts` (card B1) keeps one
  registration on `globalThis[Symbol.for('ratio.verdictSink')]`, with
  `registerVerdictSink`, `resetVerdictSinkForTests` and a **default-sink
  factory**. Every gateway and change-lifecycle outcome passes through `decide(principal,
  action, resource)` (card B1) or a `requires` check, which calls the sink. **In enforce mode there
  is always a sink**: the first enforced request lazily registers whatever the
  factory returns, which is a bounded in-memory sink in B1 and the audit sink
  after card C5 changes that one factory line (C5 edits `verdictSink.ts`,
  sequenced after B1). Registration is therefore lazy but deterministic: every
  enforced route passes through the gateway code that calls the factory. The
  root `instrumentation.ts` is **not** touched: an existing test
  (`src/ingest/importBoundary.test.ts`, lines 216-228) pins its import closure
  to exactly three files. If enforce mode finds **no** sink (only after an
  explicit reset), the request is denied with a fixed 503 ("audit sink not
  configured"); if the sink throws, 503 as well (fail closed). With
  `RATIO_RBAC` unset nothing is audited and nothing changes (F1). Routes use
  `requires`; handlers that build a `Resource` late (card C3) call `decide`.
  The `globalThis` guard matters mainly under `next dev`.
- Mock state and run modes. The mock IdP key and revocation set (A2), change
  store (C3, shared with C4 and C8), replay store (C4) and audit store (C5) are
  process state. Each is held behind a `globalThis[Symbol.for('ratio.<name>')]`
  accessor, the same pattern as the verdict sink, and each owning card has a
  test `store_is_shared_across_separately_loaded_module_instances`. They are
  supported in unit tests and in a **production build** (`next build` then
  `next start`), which is how the Playwright launcher runs (card C1), which
  adds an end-to-end test that state written through one route is visible to
  another. `next dev` is not a supported mode; the launcher refuses it. The
  Playwright process cannot touch that state directly, so card B7 provides a
  mock-only control route (below).
- Mock persona catalog. Card A2 owns `src/mock/idp/personas.ts`: for each
  persona the `sub`, `role`, `teams`, `envs` and `tenant`. It includes two
  engineering leads on real seeded team names, `eng-platform` (teams
  `['Platform Eng']`) and `eng-cx` (teams `['CX Engineering']`) (F16), and
  org-wide principals (`teams: '*'`) for the other roles.
- Legacy principal. The shared-token principal has role `legacy_service`, which
  is not one of the six personas; the matrix has a `legacy_service` column whose
  fail-closed grant is the explicit list in PLAN 4.2 (card A1).
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
| A2, wave 1 (cards B1, B4, B5, B6, B8) | B1, B4, B5, B6, B8 | Start when their Sprint A dependencies merge. File-disjoint with each other. |
| A2, wave 2 (cards B2, B3, B7) | B2, B3, B7 | Start when B1 and B8 (where listed) merge. File-disjoint with each other. |
| A2, wave 3 (cards B9, B11) | B9, B11 | B9 needs B2; B11 needs B7 and B8. File-disjoint with each other. |
| A2, wave 4 (cards B10, B12) | B10, B12 | Need B8 and B11. File-disjoint with each other. |
| C and D (cards C1 to C8; Sprint C = C1, C2, C5; Sprint D = C3, C4, C6, C8, C7 last) | C3, C6 first; then C4, C5; then C2; then C1, C8; C7 last | See dependencies. C5 needs C3; C2 needs C5 (the `/audit` link); C1 needs C2 and C5. |

### Dependencies (machine-checked table)

| Card | Depends on |
|---|---|
| A1 to A8 | none |
| B1 | A1, A2 |
| B2 | B1, A1, B8 |
| B3 | B1, A1, B8 |
| B4 | A4 |
| B5 | A1, A5 |
| B6 | A6 |
| B7 | B1, A2, B8, A8 |
| B8 | A1, A3, A2 |
| B9 | B1, A1, B8, B2 |
| B10 | B8, B11 |
| B11 | B7, B8, A1 |
| B12 | B8, B11 |
| C1 | B3, B7, B9, B10, B11, B12, C2, C5, A2, A3, A4, A5 |
| C2 | B11, A1, C5 |
| C3 | B4, B1, A1, B8 |
| C4 | C3, A4 |
| C5 | B1, C3 |
| C6 | B4, A4 |
| C8 | C4, C3 |
| C7 | all |

Files that two cards edit, in sequence (the later card depends on the earlier): `pages/api/v1/cm/webhook.ts` C4 then C8; `src/mission/missionModel.ts` and `src/findings/findingsModel.ts` B8 then B12;
`src/costsource/CostSourcePage.tsx` A8 then B7; `pages/api/v1/cm/change.ts` B4
then C3; `src/rbac/matrix.ts` A1 then C3 (the `cm/change` status flip);
`src/server/gateway/verdictSink.ts` B1 then C5 (the default-sink factory line);
`package.json` and `vitest.config.ts` C1 only; `src/store/useStore.ts` B11
only. Ownership, acyclicity and the effort sum were re-checked by script when
this file was revised (EVIDENCE.md).

## File ownership (machine-checked table, full paths)

| Card | Owns |
|---|---|
| A1 | `src/identity/types.ts`, `src/identity/scope.ts`, `src/identity/envMap.ts`, `src/identity/envMap.test.ts`, `src/rbac/matrix.ts`, `src/rbac/authorize.ts`, `src/rbac/matrix.test.ts`, `src/rbac/authorize.test.ts` |
| A2 | `src/mock/idp/issuer.ts`, `src/mock/idp/verifier.ts`, `src/mock/idp/claims.ts`, `src/mock/idp/personas.ts`, `src/mock/idp/enabled.ts`, `src/mock/idp/index.ts`, `src/mock/idp/idp.test.ts` |
| A3 | `src/mock/personaData/dataset.ts`, `src/mock/personaData/scope.ts`, `src/mock/personaData/projections.ts`, `src/mock/personaData/oracle.fixture.json`, `src/mock/personaData/projections.test.ts` |
| A4 | `src/mock/itsm/jiraStub.ts`, `src/mock/itsm/serviceNowStub.ts`, `src/mock/itsm/state.ts`, `src/mock/itsm/index.ts`, `src/mock/itsm/itsm.test.ts` |
| A5 | `src/mock/mcp/server.ts`, `src/mock/mcp/tools.ts`, `src/mock/mcp/protocol.ts`, `src/mock/mcp/index.ts`, `src/mock/mcp/mcp.test.ts` |
| A6 | `src/costsource/sandboxSources.ts`, `src/costsource/seed.ts`, `src/costsource/CostSourceClient.ts`, `src/costsource/MockCostSourceClient.ts`, `src/costsource/syntheticCloudSeed.ts`, `src/costsource/syntheticCloudMapping.ts`, `src/costsource/sourcesForEnvPurity.test.ts`, `src/costsource/syntheticCloudSandbox.test.ts`, `src/costsource/sandboxAllowlist.test.ts`, `src/connectors/ConnectorCard.tsx`, `src/connectors/ConnectorCard.test.tsx` |
| A7 | `src/lib/format.ts`, `src/lib/format.test.ts`, `src/lib/documentHead.test.ts`, `pages/_document.tsx`, `public/favicon.svg` |
| A8 | `src/simulation/SimulationBar.tsx`, `src/simulation/SimulationBar.test.tsx`, `src/costsource/CostSourcePage.tsx`, `src/costsource/findingsCard.test.tsx`, `pages/demo.tsx`, `src/ai/MockAIClient.ts`, `src/ai/demoPrompts.test.ts` |
| B1 | `src/server/gateway/principal.ts`, `src/server/gateway/auth.ts`, `src/server/gateway/withGateway.ts`, `src/server/gateway/withRbac.ts`, `src/server/gateway/index.ts`, `src/server/gateway/verdictSink.ts`, `src/server/gateway/csrf.ts`, `src/server/gateway/principal.test.ts`, `src/identity/mockIdpVerifier.ts` |
| B2 | `src/server/gateway/liveDataAuth.ts`, `pages/api/costsource/rows.ts`, `pages/api/costsource/findings.ts`, `pages/api/costsource/health.ts`, `pages/api/costsource/sources.ts`, `pages/api/v1/connectors/index.ts`, `src/server/gateway/liveDataPrincipal.test.ts` |
| B3 | `pages/api/attribution.ts`, `pages/api/tokenomics.ts`, `pages/api/prediction/predict.ts`, `pages/api/prediction/accuracy.ts`, `pages/api/report/snapshot.ts`, `pages/api/costsource/ingest.ts`, `src/server/routeMatrix.test.ts`, `src/server/openRoutesEnforced.test.ts` |
| B4 | `pages/api/v1/cm/change.ts`, `src/cm/outbound.ts`, `src/cm/itsmStub.e2e.test.ts` |
| B5 | `src/mcp/client.ts`, `src/mcp/allowlistFile.ts`, `src/mcp/credentials.ts`, `src/mcp/index.ts`, `src/mcp/fixtures/allowlist.dev.json`, `src/mcp/fixtures/allowlist.prod.json`, `src/mcp/fixtures/allowlist.allkeys.json`, `src/mcp/mcp.client.test.ts` |
| B6 | `src/connectors/ingestLanding.ts`, `src/connectors/IngestVerification.tsx`, `src/connectors/syntheticAttribution.test.tsx` |
| B7 | `src/session/loopback.ts`, `pages/api/v1/session/login.ts`, `pages/api/v1/session/logout.ts`, `pages/api/v1/session/principal.ts`, `pages/api/v1/session/mock-control.ts`, `pages/api/v1/workloads.ts`, `src/session/client.ts`, `src/session/session.test.ts`, `src/session/liveClients.test.ts`, `src/attribution/LiveAttributionClient.ts`, `src/prediction/LivePredictionClient.ts`, `src/tokenomics/LiveTokenomicsClient.ts`, `src/finio/LiveFinioClient.ts`, `src/ai/LiveAIClient.ts`, `src/cm/LiveCMClient.ts`, `src/costsource/LiveCostSourceClient.ts`, `src/hello/LiveHelloClient.ts`, `src/executive/SnapshotButton.tsx`, `src/costsource/CostSourcePage.tsx` |
| B8 | `src/data/provider.ts`, `src/data/provider.test.ts`, `src/data/servedOracle.fixture.json`, `src/data/defaultScopeGolden.fixture.json`, `src/data/seedBoundary.test.ts`, `src/lib/rollupRegistry.ts`, `src/lib/rollupRegistry.test.ts`, `src/lib/budgetStatus.ts`, `src/lib/budgetStatus.rollup.test.ts`, `src/attribution/MockAttributionClient.ts`, `src/attribution/accrual.ts`, `src/attribution/aggregations.ts`, `src/prediction/MockPredictionClient.ts`, `src/executive/initiativeModel.ts`, `src/executive/reportModel.ts`, `src/findings/findingsModel.ts`, `src/mission/missionModel.ts`, `src/ai/buildAIContext.ts` |
| B9 | `pages/api/v1/ai/chat.ts`, `pages/api/v1/finio/export.ts`, `pages/api/v1/a2a/handshake.ts`, `pages/api/v1/costs/published.ts`, `src/server/costs/publishedCostsRoute.ts`, `src/server/gatewayRoutesEnforced.test.ts` |
| B10 | `src/attribution/AttributionPage.tsx`, `src/attribution/LiveAccrualBoard.tsx`, `src/prediction/PredictionPage.tsx`, `src/data/userQueries.ts`, `src/attribution/pageReaders.test.tsx`, `src/components/detail/DetailPanel.tsx`, `src/components/detail/DetailPanel.test.tsx` |
| B11 | `pages/_app.tsx`, `pages/sign-in.tsx`, `src/session/SessionProvider.tsx`, `src/session/ViewGuard.tsx`, `src/session/Forbidden.tsx`, `src/session/ui.test.tsx`, `src/store/useStore.ts`, `src/store/hydrate.test.ts`, `src/store/configMismatch.test.tsx` |
| B12 | `src/lib/derive.ts`, `src/lib/valueMath.ts`, `src/lib/valueEvidence.ts`, `src/outcomes/model.ts`, `src/mission/missionModel.ts`, `src/findings/findingsModel.ts`, `src/components/workload/WorkloadCard.tsx`, `src/lib/rollupReaders.test.ts` |
| C1 | `tests/personas/matrix.spec.ts`, `playwright.personas.config.ts`, `scripts/mock/start.mjs`, `package.json`, `vitest.config.ts`, `src/server/vitestConfig.test.ts`, `src/server/mockLauncher.test.ts` |
| C2 | `src/lib/persona.ts`, `src/components/PersonaProvider.tsx`, `src/components/layout/NavBar.tsx`, `src/components/TechnicalViewToggle.tsx`, `src/lib/personaPrincipal.test.ts` |
| C3 | `src/cm/lifecycle.ts`, `src/cm/changeStore.ts`, `pages/api/v1/cm/change.ts`, `src/rbac/matrix.ts`, `src/cm/lifecycle.test.ts` |
| C4 | `pages/api/v1/cm/webhook.ts`, `src/cm/webhookSignature.ts`, `src/cm/replayStore.ts`, `src/cm/statusHandlers.ts`, `src/cm/webhook.test.ts` |
| C5 | `src/audit/sink.ts`, `src/audit/record.ts`, `src/audit/register.ts`, `src/audit/index.ts`, `src/audit/audit.test.ts`, `pages/api/v1/audit/records.ts`, `pages/audit.tsx`, `src/server/gateway/verdictSink.ts` |
| C6 | `src/cm/tokenClient.ts`, `src/cm/tokenClient.test.ts`, `src/mock/tokenService/server.ts` |
| C8 | `src/cm/statusSync.ts`, `src/cm/statusSync.test.ts`, `pages/api/v1/cm/sync.ts`, `pages/api/v1/cm/webhook.ts` |
| C7 | `.obvious/obvious.md` |

A card that needs a file it does not own stops and records the need on the card
(see the runbook). It does not edit the file.

---

## Sprint A (parallel group, no dependencies)

### A1. Contract, permission matrix and the `authorize()` decision function

- **Status. Merged** in #103 (`0e097a2`). Files as in the ownership table;
  evidence in `docs/evidence/A1/`. The merged code (`src/identity/*`,
  `src/rbac/*` and their tests) is the reference for PLAN 4.2, 4.4 and 4.5.
- **Differences from the earlier card text, now recorded in PLAN 4.2:** the
  `Action` union has `ticket.bind` and `ticket.get` (no `change.read`);
  `ChangeImpact` adds `operational`; the `legacy_service` grant is derived
  from today's gateway access and pinned by
  `legacy_service_column_grants_exactly_todays_gateway_access`; `eng_lead` is
  `T` on tokenomics and prediction (open item, see PLAN 4.4 and card B3).
- **Still to do by later cards:** C3 flips `/api/v1/cm/change` from
  `deferred(C3)` to `enforced` (sequenced edit of `src/rbac/matrix.ts`).

### A2. Mock identity provider issuing signed test JWTs

- **Status. Merged** in #104 (`de7e5b4`). Files as in the ownership table;
  evidence in `docs/evidence/A2/`. EdDSA through `node:crypto`, no new
  dependency; `mockIdpEnabled(env)` in `src/mock/idp/enabled.ts`; persona
  catalog in `src/mock/idp/personas.ts` (including `eng-platform` and
  `eng-cx`).
- **Not delivered by A2:** the loopback helper `isLoopbackRequest` that an
  earlier card text placed in `enabled.ts`. It moves to card B7 (new file
  `src/session/loopback.ts`), the owner of the two routes that use it.

### A3. One dataset, persona projections, and the accuracy oracle

- **Status. Merged** in #105 (`039e9b6`). Files as in the ownership table;
  evidence in `docs/evidence/sprint-a-a3/`. The unit-level accuracy oracle
  (`src/mock/personaData/oracle.fixture.json`) is the "A3 accuracy check" that
  the MVP recommendation (PLAN D15) pairs with the first live connector. B8
  asserts that its `Scope` is assignable to the A1 scope.

### A4. Mock Jira and mock ServiceNow ITSM servers

- **Status.** Open and held, #106. Pending D15 (recommended: cut to what A1
  needs).

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

- **Status.** Open and held, #107. Pending D15 (same recommendation as A4).

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

- **Status. Merged** in #108 (`6acd2ba`). Adds `aws-sandbox`, `azure-sandbox`
  and `gcp-sandbox` (kind `synthetic_cloud`), an explicit workload mapping and
  a "synthetic" chip; the existing three sandbox sources are unchanged
  (golden-hash test). Evidence in `docs/evidence/a6/`.
- **Outside the listed files:** `src/costsource/challengerRoutes.test.ts`
  (one assertion widened to skip the three new sandbox ids). B6 builds on the
  mapping.

### A7. Demo fixes: negative dollar sign and favicon

- **Status. Merged** in #109 (`a3c1437`). `formatUSD` puts the minus sign
  before the dollar sign; `public/favicon.svg` is linked from
  `pages/_document.tsx`. A separate follow-up, #111 (`e184a44`), stopped a
  negative spend delta from printing a stray plus sign.

### A8. Demo fixes: dead link, findings header, `/demo` prompts

- **Status. Merged** in #110 (`8ce4f73`). It also carried this plan (folded from the closed
  docs-only #100).
- **Goal.** (a) Hide "Customer sign-in simulation" when the simulation is
  disabled (`access.enabled` is false). (b) Name the actual source in the
  findings card title instead of always "PointFive DeepWaste shape", including
  ServiceNow (for example "Findings — N (ServiceNow, synthetic demo data)"),
  taken from the source captured when the ingest started, not from the picker.
  (c) Make every `/demo` prompt produce a real mock Frank answer
  by replacing the one prompt the current mock cannot answer (its intents live in
  `src/ai/mock/intents.ts`, which this card does not edit). The prompt list is
  exported as `DEMO_PROMPTS` from `src/ai/MockAIClient.ts` and imported by
  `pages/demo.tsx` and the test: a Next.js page module should export only its
  page and data functions, and no other card owns `MockAIClient.ts`.
- **Files.** As listed in the ownership table. Must not touch `seed.ts` or
  `ConnectorCard.tsx` (A6).
- **Dependencies.** None.
- **Red tests.** `SimulationBar.test.tsx`:
  `sign_in_link_shows_only_when_the_simulation_is_enabled`.
  `findingsCard.test.tsx` (existing file, extended):
  `names_the_source_that_ran_the_ingest_even_after_the_picker_changes`.
  `demoPrompts.test.ts`:
  `every_demo_prompt_gets_a_non_help_mock_frank_reply` (not the help text,
  and neither the "cannot answer" nor the clarifying reply).
- **Governance class.** Path-derived: `financial_semantics`
  (`CostSourcePage.tsx` and `findingsCard.test.tsx` are under
  `src/costsource/**`), `routes` (`pages/demo.tsx`), `unclassified` otherwise.
- **Parallel-safe.** Yes. **Size.** S (1 to 3 days).
- **Notes.** The re-check on `7a9da43` found one failing prompt, not two
  (F19e); see `docs/evidence/a8-demo-fixes-nav/README.md`.

---

## Sprint A2 (cards B1 to B12; IDs kept, see "Naming of sprints")

### B1. Gateway principal, route requirements, verdict helper and sink, credential extraction

- **Goal.** `withGateway` authenticates through a `TokenVerifier`
  (`MockIdpVerifier`, mapping A2 claims to the A1 `Principal`) when
  `RATIO_RBAC=enforce`, then falls back to the legacy shared token as a
  `legacy_service` principal with the explicit grant list in PLAN 4.2. New option on `withGateway`:
  `requires: { action: Action; resource?: (req) => Resource }`, evaluated
  through `authorize()` after authentication and before the handler. Also
  provides (see "Shared decisions"):
  - `withRbac(handler, {requires})` in `withRbac.ts`: authentication and
    authorization **only**, with no method guard, rate limit or body-size
    check, and a no-op when not enforced. Routes that keep their own method
    guards and error envelopes (card B3) use it, so the offline default is
    byte-identical;
  - `decide(principal, action, resource)`, the one helper that calls
    `authorize()` and then the verdict sink, so a handler that builds its
    `Resource` late (card C3) is audited the same way as a route that uses
    `requires`;
  - `verdictSink.ts`: the `globalThis` registration, a lazily registered
    bounded in-memory default sink in enforce mode, `registerVerdictSink`,
    `resetVerdictSinkForTests`, and fail-closed behavior (no sink or a throwing
    sink gives a fixed 503);
  - `csrf.ts`, a new same-origin plus double-submit check for
    cookie-authenticated unsafe methods (the simulation's `requireCsrf` is
    bound to its own session and is not reused);
  - credential extraction from a bearer header or the `ratio_session` cookie.
  Handlers receive `{principal, tenant}`. The offline default is unchanged (F1).
- **Files.** As listed in the ownership table.
- **Dependencies.** A1, A2.
- **Red tests (`principal.test.ts`).**
  `valid_mock_jwt_yields_principal_in_handler_context`,
  `legacy_shared_token_passes_as_legacy_service_principal`,
  `legacy_principal_cannot_exceed_its_fixed_grant`,
  `jwt_with_prod_aud_is_rejected_by_a_test_deployment`,
  `mock_verifier_refuses_every_token_when_mock_idp_is_not_enabled`,
  `offline_default_still_unenforced_with_no_token_and_mock_provider`,
  `tenant_in_logs_is_principal_tenant_never_the_token_or_jwt`,
  `rate_limit_is_keyed_by_principal_tenant`,
  `tampered_role_claim_returns_401_with_a_fixed_message`,
  `route_declaring_requires_gets_403_before_the_handler_runs`,
  `requires_resource_builder_receives_the_request_and_feeds_authorize`,
  `with_rbac_leaves_method_guard_rate_limit_and_envelopes_untouched`,
  `with_rbac_is_a_no_op_when_not_enforced`,
  `verdict_sink_is_called_for_allow_and_for_deny`,
  `verdict_sink_receives_no_token_or_secret`,
  `enforce_mode_registers_the_in_memory_default_sink_lazily`,
  `enforce_mode_with_sink_cleared_fails_closed_with_503`,
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
  workload through the B8 provider). Failed-attempt accounting, the weak-token refusal and sandbox
  anonymity stay. The exported signatures and results of
  `evaluateLiveDataAuth` and `gateSourceAccess` stay unchanged (the principal
  path is additive), because `src/server/costs/publishedCostsRoute.ts` (card
  B9) calls them; B9 therefore depends on this card.
- **Files.** `src/server/gateway/liveDataAuth.ts`,
  `pages/api/costsource/{rows,findings,health,sources}.ts`,
  `pages/api/v1/connectors/index.ts`,
  `src/server/gateway/liveDataPrincipal.test.ts` (new).
- **Dependencies.** B1, A1, B8.
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
- **Governance class.** Path-derived: `auth_tenancy` (two paths: `liveDataAuth.ts` and
  `liveDataPrincipal.test.ts`), `routes` (five paths).
- **Parallel-safe.** Yes with B3 and B7 (B9 depends on this card). **Size.** M (4 to 6 days).

### B3. Authenticate and scope the six open routes; route-level matrix test

- **Goal.** Put `attribution`, `tokenomics`, `prediction/predict`,
  `prediction/accuracy`, `report/snapshot` and `costsource/ingest` (F3) behind
  authentication with `requires` (through B1's `withRbac`, **not** `withGateway`,
  so each route keeps its local method guard, its error envelope and no new
  rate limit) and the scope from the B8 provider. Tokenomics and prediction
  accuracy return org-level aggregates with no team dimension, so `eng_lead`
  should get 403 on both until they can be computed from filtered records
  (PLAN 4.4 note). **Before starting:** merged A1 has `T` for `eng_lead` in
  exactly two places, the `tokenomics` group and `/api/prediction/accuracy`
  (which shares the `prediction` group with predict). Settle it with the owner
  first: compute after the scope filter, or edit A1's data, where accuracy needs
  a new group and a repointed route row, so `src/rbac/matrix.ts` and its test
  join this card's files (PLAN 4.4). `hello`
  stays an explicit `public` liveness route in the matrix. Add the generated
  persona-by-route-by-environment test (PLAN 4.7, item 7). The matrix test
  asserts every route has a status and accepts both `deferred(C3)` and
  `enforced` for `cm/change` (card C3 flips it and does not own this test
  file); the simulation routes are `sim_only` (they keep their own session model and
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
  `predict_with_another_teams_workload_id_is_403_for_eng_lead`,
  `offline_default_405_and_success_responses_are_byte_identical_for_the_six_routes`,
  `eng_lead_gets_403_on_tokenomics_and_prediction_accuracy`,
  `cto_finops_lead_finance_procurement_auditor_get_the_org_aggregate_on_the_roles_the_matrix_allows`,
  `query_param_cannot_override_team_or_env_scope`,
  `role_in_query_or_header_is_ignored`,
  `simulation_routes_return_404_when_simulation_disabled`.
- **Governance class.** Path-derived: `routes` (six paths). Content-derived
  expected: confirm on the diff (importing `withRbac` from the gateway folder
  does not change the path-derived class).
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
  classes, so A4's direct-construction test stays valid. Every outbound call
  goes through a `safeFetch` in `outbound.ts` that sets `redirect: 'manual'`
  and treats any 3xx as a fixed 502 (no hop is followed and credentials are
  never sent to a redirect target), so validating the configured host is not
  bypassed by a redirect.
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
  `jira_redirect_to_a_disallowed_host_is_not_followed_and_returns_a_fixed_502`,
  `servicenow_redirect_to_a_disallowed_host_is_not_followed_and_returns_a_fixed_502`,
  `credentials_are_not_sent_to_a_redirect_target_in_either_credential_mode`,
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
  (section 3, including the 3.3 key table and 3.8, on main; see PLAN 5a). Read the table in its section 3.3 and the cases in
  its sections 8.2 and 9.5 once, by section number (not line number), when
  starting; its key names are still proposals.
  - **Model-vendor agnostic.** The same allowlist, client and audit apply
    whichever vendor's model drives the tool loop (Claude, OpenAI, Mistral,
    open-weight or private; Frank design 2.6). Vendor-hosted MCP connectors
    that would call a server directly and bypass the Ratio broker are rejected
    by default (Frank 2.6, threat T13, case A21; allowing specific ones is an
    owner decision there, OD-13). B5 never builds such a connector parameter
    and the loader treats a key asking for one as an unknown key. B5 can
    observe only that; inspecting the request bodies each model adapter sends
    (Frank's per-adapter closed-set assertion, A21) belongs to the Frank M2
    broker, not this card.
  - The allowlist is a **file** named by one environment variable, parsed at
    start, never an editable code module, API or UI. **One file per
    deployment**, and the file declares its own top-level
    `deployment_environment`, which must equal the **raw** `RATIO_ENV`
    (unset, empty or unrecognized refuses to enable tools and records
    `startup_refused`). There is no "endpoint registry keyed by environment".
  - The loader accepts exactly **the Frank 3.3 key table as it stands when the
    card is worked** (required keys, optional keys with their defaults, the
    `transport` key with its conditional stdio and http keys, `output_schema_hash`,
    `credential_ref`, `fallback`, `relist_interval_seconds`, the global and
    per-tool budgets, `enabled`, `on_secret`) and rejects any other key. A missing
    required key rejects the file; a missing optional key takes the stated
    default. The key set is one constant; a committed fixture
    `fixtures/allowlist.allkeys.json` is derived from the table and a test fails
    if the loader rejects any key in it or accepts one that is not in it.
  - Server entries pin `owner`, `purpose` and `data_class` (required); https
    entries need a certificate pin or CA bundle and refuse cross-host
    redirects. Plain `http` to loopback is allowed **only in the mock** and
    cannot be enabled outside `development` or `test`; it waives Frank's
    required `tls_pin` or `ca_bundle` for that case only, so the dev fixture
    is not rejected as a file with a missing required key. stdio entries are parsed
    but not connected in this sprint (OD-1 recommends HTTP only).
  - Each tool entry carries the **bodies** (`description`, `input_schema`,
    `output_schema`) and pins name, `description_hash`, `schema_hash`,
    `output_schema_hash` and a `read_only_via` capability. A missing body, a
    body whose hash does not match its `*_hash` key, or an unknown key in a tool
    entry rejects the whole file; a changed live server description or schema
    denies the tool. The size caps `max_description_bytes` and
    `max_schema_bytes` from the key table bound the bodies. **Read-only comes from the operator
    allowlist, never from the server's own annotation.** The broker offers the
    allowlist's own description and schema, not the server's live text.
  - Reserved fields use Frank's names: `environments[]` (`RATIO_ENV`
    vocabulary), `roles[]` (mapped from `Principal.role`) and `teams[]`
    (mapped from `Principal.teams`). A present field with an unknown caller
    value denies; an empty array or null denies. Do not invent an `envs`
    allowlist field.
  - `initialize` first, `tools/list` compared with pins, `tools/call` only for
    allowlisted tools the principal's role, environment and teams permit
    through A1's `authorize()` (not B1's `decide()`, so B5 needs no gateway
    code); each verdict and each broker event goes to an injected audit
    callback. Per-team credentials are references resolved
    server-side and never returned. The PointFive scaffold is untouched (F12).
  - Audit events (`startup_refused`, `server_denied`, `tool_denied`,
    `secret_in_result`) go to the injected callback; wiring them to the C5 sink
    is a follow-up in Frank M2.
  - The secret scan reuses `applyRedactionRules` in
    `src/costsource/transports/redact.ts` and scans every string value plus the
    serialized JSON of a result (Frank T7); it adds no second rule set.
  - Frank's M1 is a registry only (no file, no parser); the `in_process` file
    shape and the registry-difference check are Frank's M2. B5 parses an
    `in_process` server entry (bodies, hashes, no pins) but does not connect it
    here, because no registry exists in this sprint.
  - Plain `http` to loopback departs from Frank 3.2 ("an https URL"); it is a
    mock-only waiver recorded in PLAN 5a as a follow-up for the Frank design.
  - `on_secret: redact` is **not implemented** in this sprint: the value is
    parsed, and a tool that asks for it is denied and never offered, because
    redaction has known leak cases (a key-only hit must be replaced wholesale,
    map-key hits and non-string hits must reject, a URL `?` tail that breaks
    re-parsing must reject; Frank's A19). Only `reject` is delivered.
  - Deferred to Frank M2 (PLAN 5a): Frank's A20 cases about
    re-evaluation on reload, the `FRANK_TOOLS` flip, the latch, per-request
    fail-only behavior and lock/CAS fail-closed (they need the broker's runtime
    state and kill switch). This card covers the A20 startup subset (entries
    without `environments[]`, raw `RATIO_ENV` unset, empty or unrecognized, and
    `deployment_environment` mismatch or missing).
- **Files.** As listed in the ownership table (the fixtures include
  `src/mcp/fixtures/allowlist.allkeys.json`). Tests run against the A5 mock
  server.
- **Dependencies.** A1, A5.
- **Red tests (`mcp.client.test.ts`).**
  `unknown_tool_denied_before_any_network_call`,
  `read_only_comes_from_operator_allowlist_not_server_annotation`,
  `server_declaring_read_only_hint_for_an_unlisted_tool_is_still_denied`,
  `tool_without_read_only_via_in_allowlist_is_not_loaded`,
  `a_changed_live_description_or_schema_denies_the_tool`,
  `tool_entry_without_its_bodies_rejects_the_whole_file`,
  `body_whose_hash_does_not_match_its_hash_key_rejects_the_whole_file`,
  `unknown_key_in_a_tool_entry_rejects_the_whole_file`,
  `in_process_server_entry_is_parsed_with_bodies_and_hashes_but_never_connected_here`,
  `allowlist_decisions_do_not_read_any_model_vendor_input` (B5's API takes no vendor argument, and its decisions are identical for any caller context),
  `a_key_asking_for_a_vendor_hosted_connector_rejects_the_file_and_b5_exports_no_connector_parameter_builder`,
  `secret_scan_reuses_apply_redaction_rules_over_every_string_value_and_the_serialized_json`,
  `broker_offers_the_allowlist_description_and_schema_not_the_servers_live_text`,
  `allowlist_is_loaded_from_the_file_named_by_env_and_has_no_runtime_edit_path`,
  `all_keys_fixture_derived_from_the_3_3_table_loads_with_no_key_rejected`,
  `any_key_outside_the_table_rejects_the_file`,
  `missing_required_key_rejects_and_missing_optional_key_takes_its_default`,
  `denied_server_entry_is_not_connected_but_a_denied_tool_leaves_its_server_connected`,
  `empty_arrays_and_null_in_reserved_fields_deny`,
  `deployment_environment_matching_raw_RATIO_ENV_loads`,
  `deployment_environment_mismatch_rejects_the_whole_file`,
  `deployment_environment_missing_rejects_the_whole_file`,
  `raw_RATIO_ENV_unset_empty_or_unrecognized_refuses_to_enable_tools_with_startup_refused`,
  `empty_RATIO_ENV_is_not_treated_as_development`,
  `entry_whose_environments_exclude_the_deployment_is_denied`,
  `entry_with_roles_or_teams_denies_when_caller_identity_is_unknown`,
  `on_secret_defaults_to_reject`,
  `on_secret_invalid_value_rejects_the_file`,
  `tool_with_on_secret_redact_is_parsed_but_denied_and_never_offered_in_this_sprint`,
  `reject_mode_rejects_credential_shaped_values_in_string_fields_map_keys_and_non_string_values`,
  `result_string_with_a_credential_shaped_value_is_rejected_before_delivery`,
  `failing_audit_callback_leaves_startup_refused_standing`,
  `tenants_key_limits_which_tenants_get_tools`,
  `output_schema_hash_is_checked_against_the_servers_declared_output_schema`,
  `https_entry_requires_a_pin_or_ca_bundle_and_refuses_cross_host_redirects`,
  `loopback_http_is_allowed_only_in_mock_and_cannot_be_enabled_in_production`,
  `server_entry_without_data_class_owner_or_purpose_is_rejected`,
  `stdio_entries_are_parsed_but_never_connected`,
  `role_allowlist_blocks_a_tool_the_role_is_not_listed_for`,
  `team_credential_resolved_server_side_and_never_returned`,
  `eng_lead_gets_only_own_team_rows_through_an_mcp_tool`,
  `planted_secret_absent_from_logs_errors_and_audit`,
  `initialize_precedes_tools_call`,
  `tools_list_result_is_filtered_to_the_allowlist`,
  `response_size_and_time_limits_are_enforced`,
  `tool_result_text_is_returned_as_data_and_never_executed`,
  `pointfive_mcp_tests_pass_unchanged`.
- **Governance class.** Path-derived: `unclassified`. Content-derived expected:
  `network_egress`, possibly `secrets` (a secret-bearing config shape).
- **Parallel-safe.** Yes within wave 1. **Size.** M (5 to 8 days).
- **Notes.** Delivers the mock path of the Frank design's T-7 (per-role,
  per-team, per-environment allowlists), tracked in the Frank design's
  section 11. The mock IdP and `Principal` supply the
  caller identity that T-7 says is missing. Real identity stays D1.

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
  credential. Every mock route below begins with the shared gate
  `mockIdpEnabled(env)` (merged in A2) and then `isLoopbackRequest` (new in
  this card, `src/session/loopback.ts`; see "Shared decisions"), and is a 404
  when either is false.
  - `POST /api/v1/session/login` (mock IdP only) accepts a persona, or a
    one-time `loginToken` issued by the mock IdP (a second use is 401), and
    sets the HttpOnly `ratio_session` cookie and the readable `ratio_csrf`
    cookie, both with `Path=/` (so they cover every page and API route even
    under a base path); the body never contains the token. Login also requires
    `Origin` equal to `RATIO_APP_ORIGIN`; residual: a malicious page open in the
    developer's own browser can still reach loopback, so the mock is for
    developer machines only. `POST /api/v1/session/logout`
    revokes the `jti`. `GET /api/v1/session/principal` returns `{enforced,
    sub, role, teams, envs, tenant, expiresAt}`, never the token; with `RATIO_RBAC`
    unset it returns `{enforced:false}` and the browser keeps the offline
    seed. A real IdP login flow replaces `login` (D1).
  - `POST /api/v1/session/mock-control` (mock only) lets the Playwright
    process drive the in-process mock IdP state it cannot reach directly. It
    requires the `X-Mock-Control-Secret` header (see "Shared decisions"), not a
    CSRF token. Actions: `issue-login-token {persona}` returns a one-time
    `loginToken`, `expire-session {sub}`, `change-role {sub, persona}`
    (re-issues claims; the old token is revoked) and `revoke {jti}`. It is the
    only way those states are changed from outside the process. It ships in the
    production bundle like every API route and is gated at runtime only.
  - `GET /api/v1/workloads` returns, from the B8 provider and for the caller's
    scope, `{shape, workloads, budgets, alerts, rollupAggregates, asOf}`. The
    **shape** is chosen server-side from the role (PLAN 4.4 note): `rollup` for
    `cto` and `procurement`, `drilldown` for the others; a query parameter
    cannot change it. A roll-up response is the DTO defined in PLAN 4.4 and
    contains none of the line-level field names listed there. The bundled seed
    stays fixture data; the enforcement boundary is the API, and
    `npm run check:bundle` is the guard for any real data that arrives later.
  - Every `Live*Client`, `SnapshotButton` and the ingest panel in
    `CostSourcePage.tsx` send the credential same-origin (with the CSRF header
    on unsafe methods) and surface 401 and 403 (F11; the Frank design's T-2:
    how the browser authenticates).
- **Files.** As listed in the ownership table. `CostSourcePage.tsx` is edited
  after A8.
- **Dependencies.** B1, A2, B8, A8.
- **Red tests.** `src/session/session.test.ts`:
  `is_loopback_request_table` (loopback peers and hosts true; `10.0.0.5`, a
  public address, `evil.example` and a missing host all false),
  `mock_login_sets_httponly_samesite_session_cookie_and_readable_csrf_cookie_and_no_token_in_body`,
  `mock_routes_are_404_unless_mock_idp_is_enabled` (login, mock-control; table
  as in `mockIdpEnabled`, including `RATIO_ENV=staging` and `production`),
  `mock_routes_check_the_gate_before_any_other_work`,
  `login_from_a_non_loopback_peer_is_404`,
  `x_forwarded_for_is_ignored_for_the_loopback_decision`,
  `login_requires_origin_equal_to_ratio_app_origin_and_a_foreign_origin_is_403`,
  `mock_control_from_a_non_loopback_peer_or_host_is_404`,
  `login_with_a_non_loopback_host_header_is_404`,
  `a_remotely_reachable_deployment_cannot_mint_sessions_even_with_the_mock_flag_set`,
  `session_and_csrf_cookies_have_path_slash`,
  `principal_endpoint_returns_enforced_flag_sub_role_teams_envs_tenant_expiry_and_no_token`,
  `principal_endpoint_is_401_without_a_credential_when_enforced`,
  `principal_endpoint_reports_enforced_false_in_the_offline_default`,
  `logout_revokes_the_jti`,
  `post_with_cookie_and_wrong_origin_is_403`,
  `workloads_endpoint_returns_only_in_scope_workloads_budgets_and_alerts`,
  `cto_workloads_response_contains_none_of_the_line_level_field_names_at_any_depth`,
  `procurement_workloads_response_contains_none_of_the_line_level_field_names_at_any_depth`,
  `cto_workloads_response_has_exactly_the_rollup_dto_keys`,
  `procurement_workloads_response_has_exactly_the_rollup_dto_keys`,
  `cto_workloads_response_carries_the_named_aggregates_for_every_workload`,
  `finops_lead_workloads_response_has_the_drilldown_records_including_the_daily_series`,
  `workloads_response_carries_rollup_aggregates_for_every_in_scope_workload`,
  `rollup_and_drilldown_totals_reconcile_to_the_cent`,
  `shape_cannot_be_chosen_by_query_parameter`,
  `one_time_login_token_second_use_is_401`,
  `mock_control_requires_the_secret_header_and_is_404_when_the_secret_is_unset`,
  `mock_control_rejects_a_wrong_secret_in_constant_time`,
  `mock_control_rejects_a_wrong_length_secret_with_401_not_a_500`,
  `mock_control_issue_token_expire_session_change_role_and_revoke_take_effect`,
  `role_change_reissue_updates_the_principal_after_refresh`.
  `src/session/liveClients.test.ts`:
  `live_clients_send_credentials_same_origin_and_surface_401_and_403`,
  `unsafe_methods_send_the_csrf_header`,
  `session_calls_and_the_workloads_fetch_use_with_base_path_under_a_non_empty_base_path`,
  `snapshot_button_and_ingest_panel_send_the_credential`,
  `offline_default_clients_are_unchanged`.
- **Governance class.** Path-derived: `routes` (five: login, logout,
  principal, mock-control, workloads), `financial_semantics` (two
  `src/costsource` paths), `unclassified` (the rest). Content-derived expected:
  `network_egress` (modified `fetch(` lines).
- **Parallel-safe.** Yes with B2, B3, B9. **Size.** M (5 to 8 days).

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
  the A1 scope. The provider returns a typed `ScopedData` (`{shape, workloads, budgets,
  alerts, rollupAggregates}`; the type lives in `provider.ts` and is imported
  by the store). The **shape** is `drilldown` (today's records) or `rollup` (for
  the roles whose maximum is the O code in PLAN 4.4). The roll-up is a
  **separate DTO with the named fields in PLAN 4.4** (`RollupWorkload`,
  `RollupBudget`, `RollupAlert`, one `ForecastSummary` per workload from the
  existing forecast code, and the named aggregates of PLAN 4.4a: minimized
  DTOs of approved values computed from the existing pure functions' outputs,
  never those raw return objects), and `provider.ts` also exports
  `rehydrateRollup()`, the client-side adapter that fills the omitted members
  of the existing `Workload` and `BudgetProfile` types with neutral
  placeholders (an empty `daily_spend_history`, zero counters). Consumers
  that read the series are made roll-up-safe in this card:
  `src/lib/rollupRegistry.ts` (new) holds the module-level registry for the
  forecast summaries and the other named aggregates, and `src/lib/budgetStatus.ts` reads it:
  `registerRollupAggregates(map | null)` (the `ForecastSummary` type is defined
  in `budgetStatus.ts` and imported by `provider.ts` as a type, so there is no
  import cycle), and `computeBudgetStatus` (called
  with its existing three arguments by `BudgetProfileTab`, `initiativeModel`,
  `missionModel`, `normalize` and others, none of which changes) substitutes the
  registered monthly figures (projected month end, confidence interval, days
  until breach, 7-day average, status) for a workload whose series is empty and
  has a registered summary **computed at the same `now`**; each summary carries
  its `now`, the server computes summaries at the `now` the store uses (the
  mock's `DEMO_NOW`, or the simulation's `asOf`), and a summary whose `now`
  differs from the caller's is ignored; with an empty series and no usable
  summary its output is today's. `src/types/index.ts` is
  unchanged. Page components that import the seed directly are
  card B10.
- **Files.** As listed in the ownership table. The default-scope golden
  (`src/data/defaultScopeGolden.fixture.json`) is captured from main in the
  first (red) commit.
- **Dependencies.** A1, A3, A2 (the catalog test imports A2's personas).
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
  `empty_scope_returns_empty_not_everything`,
  `rollup_dto_has_exactly_the_named_fields_and_none_of_the_line_level_names`,
  `rehydrate_rollup_fills_omitted_members_with_neutral_placeholders_only_in_the_browser_adapter`,
  `budget_status_uses_the_registered_summary_when_the_series_is_empty` (in
  `src/lib/budgetStatus.rollup.test.ts`),
  `registered_summary_matches_the_drilldown_figures_at_the_same_now`,
  `registry_cleared_by_null_restores_todays_output`,
  `rollup_dto_carries_each_named_aggregate_computed_by_the_existing_pure_functions`,
  `each_named_aggregate_has_exactly_its_approved_keys`,
  `no_number_in_a_rollup_response_equals_a_token_counter_unit_rate_or_compute_value_of_the_scoped_records`,
  `named_aggregates_equal_what_the_drilldown_records_produce`,
  `rollup_dto_contains_none_of_the_forbidden_names_including_compute_inference_cost_per_call_and_the_alert_members`,
  `procurement_rollup_has_exactly_the_dto_keys`,
  `a_summary_computed_at_a_different_now_is_ignored`,
  `budget_status_with_a_full_series_is_unchanged`,
  `findings_for_an_eng_lead_exclude_other_teams`,
  `rollup_forecast_summary_equals_the_drilldown_forecast`,
  `rollup_and_drilldown_totals_reconcile_to_the_cent_for_every_scope`,
  `catalog_team_names_exist_in_the_seeded_dataset`,
  `build_ai_context_alerts_come_from_the_scoped_provider_not_the_seed`,
  `client_reachable_importers_of_the_seed_are_a_subset_of_the_committed_list` (in
  `src/data/seedBoundary.test.ts`: an import-closure walk from `pages/_app.tsx`
  and each page, excluding `pages/api`; the actual set of modules that import
  the seed data modules must be a **subset** of the committed list, so cards that
  remove seed imports (B10, B12) never fail it and never edit the list; only a
  new importer fails it).
- **Bundle boundary, stated plainly.** The seed (`src/data/workloads.ts` and its
  siblings) is imported by many client modules, so it ships in client assets in
  every mode: a hydration guard cannot stop a user from downloading it. For this
  mock environment that is an accepted residual (the seed is fixture data), and
  the import-closure test above only proves that **no new client path starts
  importing the seed**. Making the seed server-only in enforce mode, and a
  bundle test with a planted data sentinel (which needs edits to
  `scripts/check-next-bundle.mjs` and the seed files, owned by no card), is owner
  decision D14 and must be done before any real data is served.
- **Out of scope, stated.** `src/findings/recommendationMath.ts`,
  `src/costsource/normalize.ts` and `src/lib/calendarTzProbe.ts` also read the
  seed. They compute per-workload outputs or validate rows, none is served to
  the browser unscoped, and the covering models filter by scope after the
  per-workload computation. Any cross-workload aggregate must come from the
  provider; a test covers the findings case.
- **Governance class.** Path-derived: `financial_semantics`
  (`src/lib/budgetStatus.ts` and its test match `src/lib/budgetStatus*`),
  `unclassified` for the rest.
- **Parallel-safe.** Yes within wave 1. **Size.** L (12 to 15 days). Split by
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
  at line 123) **before** the gateway sees the request; without B2's
  principal-aware path a mock cookie or token would be rejected there before
  B9's `requires` runs, so B9 depends on B2.
- **Files.** `pages/api/v1/ai/chat.ts`, `pages/api/v1/finio/export.ts`,
  `pages/api/v1/a2a/handshake.ts`, `pages/api/v1/costs/published.ts`,
  `src/server/costs/publishedCostsRoute.ts`,
  `src/server/gatewayRoutesEnforced.test.ts` (new).
- **Dependencies.** B1, A1, B8, B2.
- **Red tests.**
  `chat_context_is_built_from_the_callers_scope_not_the_client_snapshot`,
  `eng_lead_chat_context_has_no_other_team_data`,
  `finio_export_denied_for_cto_eng_lead_procurement`,
  `finio_export_allowed_for_finops_lead_finance_auditor`,
  `handshake_requires_a_principal_when_enforced`,
  `published_costs_tenant_still_comes_from_server_binding_never_the_request`,
  `published_costs_accepts_a_persona_principal_through_the_principal_aware_live_data_path`,
  `offline_default_behavior_of_these_routes_is_unchanged`.
- **Governance class.** Path-derived: `routes` (four), `unclassified` (one).
  The existing `src/server/costs` tests must pass unchanged.
- **Parallel-safe.** No (after B2); parallel with B3 and B7. **Size.** M (4 to 6 days).

---

### B10. Page components that read the seed directly

- **Goal.** Four files import the seeded dataset directly and so bypass the
  store that card B11 hydrates: `AttributionPage.tsx` (lines 29-30 sum
  `WORKLOADS`), `LiveAccrualBoard.tsx` (lines 15 and 44), `PredictionPage.tsx`
  (lines 24, 84 and 152) and `src/data/userQueries.ts` (lines 59 and 71). They
  switch to the store (workloads) and to a scope-aware reader for user query
  events (`userQueryEventsFor(scope)`, user dimension restricted to the roles
  in PLAN 4.4). `DetailPanel.tsx` (the drill-down surface) shows an explicit
  "Drill-down is not available for your role" state when the store holds the
  `rollup` shape. The mission page also renders `BudgetProfileTab`
  (`MissionDetail.tsx`); under a roll-up it gets the same projection as the
  drill-down through the registry in `budgetStatus.ts` (cards B8 and B11), so
  no further source file changes; this card proves it with tests. In the
  offline default the store holds the seed, so output is unchanged.
- **Files.** As listed in the ownership table.
- **Dependencies.** B8, B11 (the store's `dataShape`, `hydrated` and
  `rollupAggregates` fields).
- **Red tests (`src/attribution/pageReaders.test.tsx`).**
  `attribution_page_totals_come_from_the_store_not_the_seed`,
  `eng_lead_attribution_page_shows_only_own_team_totals`,
  `live_accrual_board_team_burn_rates_use_store_workloads`,
  `live_accrual_board_user_dimension_hidden_for_roles_without_access`,
  `prediction_page_workload_list_and_default_come_from_the_store`,
  `eng_lead_prediction_page_lists_only_in_scope_workloads`,
  `eng_lead_prediction_page_hides_the_accuracy_panel`,
  `cto_prediction_page_uses_the_predict_route_and_matches_the_finops_lead_result`,
  `cto_attribution_page_team_totals_come_from_the_attribution_route_and_equal_the_finops_lead`,
  `user_query_events_are_filtered_by_scope`,
  `budget_profile_tab_on_a_rollup_shows_the_same_projected_month_end_and_interval_as_the_drilldown`,
  `mission_page_budget_tab_on_a_rollup_matches_the_drilldown`,
  `cto_detail_panel_shows_drill_down_not_available` (in `DetailPanel.test.tsx`),
  `finops_lead_detail_panel_renders_all_tabs`,
  `offline_default_output_of_all_four_files_is_unchanged`.
- **Governance class.** Path-derived: `unclassified` (four paths); the two
  `src/components/detail/**` paths match the low-risk UI rule.
- **Parallel-safe.** No (wave 4, after B11). **Size.** M (5 to 7 days).

### B11. Sign-in UI, session provider, store hydration and view guard

- **Goal.** The browser flow that traces a persona from sign-in to scoped
  pages (PLAN 4.8).
  - `pages/sign-in.tsx`: a mock persona picker that calls B7's login; a real
    IdP redirect replaces it later (D1). It imports the persona list from
    `src/mock/idp/personas.ts` **only** (pure data, no imports), never from the
    mock IdP index, so the issuer cannot land in the client bundle. It honors a
    `returnTo` parameter, restricted to same-origin paths. If login answers
    404 it shows "no sign-in method is configured".
  - `src/session/SessionProvider.tsx`, mounted in `pages/_app.tsx`: on mount it
    calls `GET /api/v1/session/principal`. **Public rows of the matrix
    (`/sign-in`, `/demo`, `/hello`, `/finio/demo`) skip the 401 redirect and
    the hydration wait**, so the sign-in page never redirects to itself. If
    `enforced` is false it hydrates nothing, stores `enforced:false` and, when
    the build flag is set, shows a visible configuration notice. If enforced
    and a principal is returned it stores `enforced:true` and calls the store's
    `hydrateScoped()`, which fetches `/api/v1/workloads` and replaces
    **workloads, budgets, alerts, `dataShape`, `rollupAggregates`** together.
    It calls `rehydrateRollup()` (card B8) when the shape is `rollup`, and calls `registerRollupAggregates` (card B8) **before** it sets the store
    (including `hydrated: true`), so no render sees the data without the
    projections. Triggers: on mount, after login, after
    logout, after a role-change re-issue (a refresh action), and on any 401 on
    a non-public page.
  - **Principal change resets everything the previous principal could have
    seen.** `useStore.ts` gains `resetSessionState()`, called on logout, on 401
    and on login: it clears workloads, budgets, alerts, `rollupAggregates`
    (and the registry), sets `selectedId` to the first in-scope workload (or
    empty), and clears `aiMessages`, `aiThinking`, `aiPanelOpen`,
    `connectorSessions`, `ingestRuns`, `connectorBusy`, `filters`,
    `simulation`, `simulationBusy` and `simulationError`. Logout and 401 are
    also a **hard navigation** to `/sign-in`, so no module state survives a
    sign-out.
  - `SessionProvider.tsx` exports `usePrincipal()` (and the store holds a
    `principal` field) carrying `sub`, `role`, `teams`, `envs`, `tenant` and
    `expiresAt` for consumers such as card C2; `resetSessionState()` clears it.
  - `useStore.ts` also gains `enforced` (the runtime value from the principal
    endpoint), `dataShape` (`'rollup' | 'drilldown'`, from the `ScopedData`
    type that B8 defines), `hydrated` (false until the first scoped load
    completes or the server reports unenforced) and `rollupAggregates`.
    **`clearSimulation()` and `loadSimulation()` are enforce-aware using the
    runtime `enforced` value as well as the build flag**: `clearSimulation`
    resets to empty collections, never to the seed, whenever either says
    enforced; `loadSimulation` is a no-op when enforced (simulation entry
    points are disabled).
  - `src/session/ViewGuard.tsx` and `Forbidden.tsx`: when enforced, a page whose
    matrix row denies the principal's role shows a 403 state instead of the
    page. The guard renders a loading state, never data, until the store is
    **hydrated** (`hydrated` is true), **whatever the build flag says**.
  - Build flag: `NEXT_PUBLIC_RATIO_RBAC=enforce` is inlined at build time and
    makes the store start empty; the server flag is `RATIO_RBAC`. They must
    agree. Server enforced and build flag unset: the guard still hides pages
    until hydration completes, and `clearSimulation` uses the runtime value.
    Server unenforced and build flag set: the provider hydrates the bundled
    seed and shows a configuration notice, instead of leaving a blank app.
- **Files.** As listed in the ownership table.
- **Dependencies.** B7, B8, A1.
- **Red tests.** `src/session/ui.test.tsx`:
  `unauthenticated_visit_when_enforced_redirects_to_sign_in_with_return_to`,
  `sign_in_page_does_not_redirect_to_itself`,
  `hard_sign_in_navigations_and_the_principal_and_workloads_fetches_use_with_base_path_under_a_non_empty_base_path`,
  `public_rows_skip_the_401_redirect_and_the_hydration_wait`,
  `use_principal_returns_sub_role_teams_envs_tenant_and_expiry_after_login`,
  `principal_is_cleared_by_reset_session_state`,
  `expired_session_401_clears_the_store_and_hard_navigates`,
  `return_to_rejects_cross_origin_targets`,
  `forbidden_page_state_shown_for_a_role_the_matrix_denies`,
  `loading_state_never_renders_data_until_hydration_completes`,
  `sign_in_page_imports_the_persona_list_without_the_issuer`,
  `offline_default_does_nothing_and_keeps_the_seed`.
  `src/store/hydrate.test.ts`:
  `hydrate_replaces_workloads_budgets_alerts_shape_and_rollup_aggregates_together`,
  `hydrate_registers_the_rollup_aggregates_for_budget_status`,
  `hydrate_calls_rehydrate_rollup_only_for_the_rollup_shape`,
  `summaries_are_registered_before_hydrated_becomes_true`,
  `eng_lead_store_never_holds_another_teams_workloads_budgets_or_alerts`,
  `store_initial_state_is_empty_under_the_enforce_build_flag`,
  `logout_and_401_clear_all_collections_and_the_registry`,
  `role_change_refresh_rehydrates_with_the_new_scope`,
  `login_after_logout_resets_selected_id_to_the_first_in_scope_workload`,
  `chat_messages_do_not_survive_a_principal_change`,
  `connector_sessions_ingest_runs_and_filters_reset_on_principal_change`,
  `logout_performs_a_hard_navigation`.
  `src/store/configMismatch.test.tsx`:
  `build_flag_set_and_server_unenforced_hydrates_the_seed_and_shows_a_configuration_notice`,
  `build_flag_unset_and_server_enforced_never_renders_the_seed_before_hydration`,
  `build_flag_unset_and_server_enforced_clear_simulation_still_never_restores_the_seed`,
  `clear_simulation_in_enforce_mode_never_restores_the_seed`,
  `load_simulation_in_enforce_mode_is_a_no_op`,
  `principal_change_resets_simulation_fields`.
  Vitest note: the flag is read at store initialization, so these tests call
  `vi.resetModules()` and `vi.stubEnv()` before importing the store.
- **Governance class.** Path-derived: `routes` (`_app.tsx`, `sign-in.tsx`),
  `unclassified` (the rest).
- **Parallel-safe.** No (wave 3, after B7). **Size.** M (5 to 8 days).

### B12. Roll-up readers: Mission, Findings, Outcomes, Workloads

- **Goal.** Make the pages that the matrix gives `cto` and `procurement` at the
  O level work from the named aggregates of PLAN 4.4a instead of line-level
  fields. Under the `rollup` shape the readers consult B8's registry first and
  fall back to today's computation, so drill-down and offline output are
  unchanged: the Findings cache reader (hit rate and daily discount from
  `cache_summary`; the token-and-rate evidence line shows "not available for
  your role"),
  `estimateTca` (Outcomes), the gross-value reader in `valueMath.ts` and the
  headline reader in `valueEvidence.ts`, `missionModel.ts` (fuel gauge from
  `fuel_ratio`; the model line shows the provider label), and
  `WorkloadCard.tsx` (provider label instead of `model`). The scope parameters
  that B8 adds to `missionModel.ts` and `findingsModel.ts` are kept (this card
  edits those two files after B8).
- **Files.** As listed in the ownership table.
- **Dependencies.** B8, B11.
- **Red tests (`src/lib/rollupReaders.test.ts`).**
  `for_each_o_page_the_cto_page_figures_equal_the_finops_lead_page_figures_for_the_same_portfolio_level_numbers`,
  `findings_cache_summary_for_a_rollup_equals_the_drilldown_hit_rate_and_discount`,
  `findings_rollup_shows_no_token_counts_or_unit_rates`,
  `mission_fuel_gauge_for_a_rollup_equals_the_drilldown_gauge`,
  `mission_view_for_a_rollup_shows_the_provider_label_and_no_model`,
  `outcomes_tca_for_a_rollup_equals_the_drilldown_tca`,
  `gross_value_and_evidence_headline_for_a_rollup_equal_the_drilldown_values`,
  `workload_card_for_a_rollup_shows_the_provider_label_and_no_model`,
  `readers_fall_back_to_todays_computation_when_no_aggregate_is_registered`,
  `offline_default_output_of_every_changed_reader_is_unchanged`.
- **Governance class.** Path-derived: `unclassified` for the `src/lib`,
  `src/mission`, `src/findings` and `src/outcomes` readers; `WorkloadCard.tsx` matches the low-risk
  UI rule.
- **Parallel-safe.** Yes with B10 (file-disjoint). **Size.** M (5 to 8 days).

## Sprints C and D (cards C1 to C8; Sprint C = C1, C2, C5; Sprint D = C3, C4, C6, C8, C7 last)

### C1. Browser persona matrix and local launcher

- **Goal.** A Playwright spec that signs in as each persona through the B11
  sign-in page and B7 login, using the A2 catalog (`eng-platform` is the
  concrete Eng lead whose own team is `Platform Eng`), and checks navigation,
  page content, totals, the 403 state and the sign-in redirect. A script
  starts a **production build** of the app (the mock state is module state;
  `next dev` is refused) with `next start --hostname 127.0.0.1`, so nothing
  outside the machine can reach the mock routes, with the mock IdP, ITSM stubs
  (A4) and MCP server (A5). It sets `RATIO_RBAC=enforce`,
  `NEXT_PUBLIC_RATIO_RBAC=enforce`, `RATIO_MOCK_IDP=1`, `RATIO_ENV=test`, `RATIO_APP_ORIGIN` set to the exact loopback origin
  (`http://127.0.0.1:<port>`, because the CSRF contract fails closed without
  it) and a
  freshly generated `RATIO_MOCK_CONTROL_SECRET` for the build and the server,
  passes the secret to the Playwright process only and never prints it. This card is
  the only one that edits `package.json` (scripts only, no dependency) and
  `vitest.config.ts` (add `tests/personas/**` to the exclude list, because the
  default include pattern would otherwise run the Playwright spec under
  `npm test`).
- **Files.** As listed in the ownership table.
- **Dependencies.** B3, B7, B9, B10, B11, B12, C2, C5, A2, A3, A4, A5. Not parallel
  with C2.
- **Red tests.** `tests/personas/matrix.spec.ts`:
  `cto_and_finops_lead_see_reconciling_totals_on_overview`,
  `cto_view_is_rollup_and_finops_lead_view_has_the_daily_series`,
  `cto_mission_budget_tab_shows_the_same_projection_as_the_finops_lead`,
  `eng_lead_attribution_and_prediction_pages_show_only_own_team`,
  `each_persona_nav_shows_only_permitted_links`,
  `eng_lead_sees_only_own_team_workloads`,
  `direct_url_to_a_forbidden_page_shows_a_403_state`,
  `unauthenticated_visit_redirects_to_sign_in`,
  `sign_out_returns_to_the_sign_in_page_and_clears_the_session`,
  `audit_link_is_visible_to_audit_roles_and_opens_the_audit_page`,
  `audit_link_is_absent_for_roles_without_audit_access`,
  `expired_token_redirects_to_sign_in` (uses `mock-control` `expire-session`),
  `role_change_reissue_takes_effect_after_reload` (uses `mock-control` `change-role`),
  `replayed_one_time_login_token_fails` (uses `mock-control` `issue-login-token`),
  `mock_state_written_through_one_route_is_visible_to_another_in_the_production_build`.
  Unit tests outside the excluded folder: `src/server/vitestConfig.test.ts`:
  `npm_test_does_not_run_the_playwright_specs` (reads `vitest.config.ts`);
  `src/server/mockLauncher.test.ts`: `launcher_sets_both_rbac_flags_the_mock_flag_and_a_fresh_control_secret`,
  `launcher_binds_127_0_0_1_only`,
  `launcher_sets_the_exact_loopback_app_origin_for_build_and_start`,
  `launcher_never_prints_the_control_secret`,
  `launcher_uses_a_production_build_and_refuses_next_dev`.
- **Governance class.** Path-derived: `dependencies` (`package.json`),
  `unclassified` (the rest).
- **Parallel-safe.** No (after C2). **Size.** M (4 to 8 days).

### C2. Persona, navigation, sign-out and identity come from the verified principal

- **Goal.** The active persona and navigation derive from the principal
  returned by B7's endpoint (through B11's provider), not `localStorage` (F4).
  `PersonaProvider.tsx` (which reads and writes `localStorage` today) takes
  the principal's role-to-lens table (see "Shared decisions"): the switcher
  only offers the lenses the role allows and the default lens is the first
  listed. The lens never changes data scope. `NavBar.tsx` also gets a
  **sign-out control** (calls B7's logout through the session client, then a
  hard navigation to `/sign-in`), a **role and identity chip** (role and a
  short subject taken from B11's `usePrincipal()`, never a token) and an **`/audit` link** shown only to roles
  the matrix allows to read it (CTO, FinOps lead, Eng lead for own scope,
  Auditor), all driven by the matrix.
- **Files.** As listed in the ownership table.
- **Dependencies.** B11, A1, C5 (the `/audit` page must exist before the link ships).
- **Red tests.** `persona_comes_from_verified_principal_not_localstorage`,
  `role_to_lens_table_matches_the_plan` (six roles by three lenses),
  `switcher_only_offers_lenses_the_role_allows`,
  `eng_lead_cannot_select_the_executive_lens`,
  `nav_hides_links_the_role_cannot_open`,
  `nav_has_sign_out_that_calls_logout_and_hard_navigates`,
  `identity_chip_shows_role_and_short_subject_and_no_token`,
  `audit_link_visible_only_to_audit_roles`,
  `chip_and_nav_read_the_principal_from_use_principal`,
  `tampered_localstorage_persona_has_no_effect_on_api_results`,
  `offline_default_keeps_the_executive_default_persona`.
- **Governance class.** Path-derived: `unclassified` (`src/lib/persona.ts`;
  the test is low); `PersonaProvider.tsx`, `NavBar.tsx` and
  `TechnicalViewToggle.tsx` are under `src/components/**` and match the
  low-risk UI rule.
- **Parallel-safe.** No (after C5); parallel with C8 only. **Size.** S (2 to 3 days).

### C3. Change lifecycle: request, approve, apply, update, idempotency, binding

- **Goal.** Authorize **every** operation of `POST /api/v1/cm/change` (still
  POST only) and add the lifecycle operations. The request and response shapes
  of the existing `create`, `attach` and `status` operations stay unchanged;
  what changes is that all of them now call B1's `decide()` with `ticket.create`,
  `ticket.attach` and `ticket.status` (the lifecycle operations use
  `change.request`, `change.approve`, `change.apply`, `ticket.update` for
  `update`, `ticket.get` for `get` and `ticket.bind` for a `request` with
  `existingTicketRef`), so every verdict reaches
  the audit sink. State is in memory behind an interface (D8). The requester is
  always the verified `principal.sub`, never a body field.
  **Team and environment are derived server-side, never taken from the body:**
  for `create` and `request`, from the B8 provider keyed by
  `finding.workloadId` (team and the workload environment mapped by A1's
  `envMap`; any client-supplied `env` is ignored); for `attach` and `status`,
  from the stored change the `ticketRef` is bound to. `create` also records a binding of the new `ticketRef` to the workload's team
  and environment and to the creator, so the creator can later attach and read
  status. A ticket that `create` bound to a team but to no change may be adopted
  by a later `request` carrying it as `existingTicketRef` only when the
  requester's team matches that binding. A `ticketRef` that is not
  bound to a stored change is allowed only to principals with `teams: '*'`; an
  Eng lead gets 403, because ownership cannot be shown.

  | Operation | Request body | Success response | Errors |
  |---|---|---|---|
  | `request` | `{operation, idempotencyKey, finding, action, impact?, existingTicketRef?}` | `200 {changeId, state:'requested', requesterSub, ticket:{provider,ticketRef,url}, env, team, impact, updatedAt}`; without `existingTicketRef` the ticket is created and bound at this step; with it, no upstream create happens and the change is bound to that pre-approved ticket after the adapter confirms it exists | 400 invalid (including an `action` that is not in the impact map, or a body `impact` that disagrees with the one derived from `action`); 403 not permitted; 409 same key with a different payload, or the ticket is already bound to another change |
  | `approve` | `{operation, changeId}` | `200` record with `state:'approved'`, `approverSub` | 403 requester equals approver or role not permitted; 404; 409 wrong state |
  | `apply` | `{operation, changeId}` | `200` record with `state:'applied'` | 403 no bound ticket in prod; 404; 409 ticket not approved or change not approved |
  | `update` | `{operation, changeId, comment?, transition?}` | `200` record | 404; 409 |
  | `get` | `{operation, changeId}` | `200` record | 404 |

  `apply` builds the `Resource` for `authorize()` from the stored change and
  the live ticket status (`requesterSub`, `approverSub`, `ticketState`), so the
  "A" cells of PLAN 4.5 are a pure verdict over those fields (and over the
  stored `impact` for the Finance and Procurement approve cells). `impact` is
  derived on the server from `action` by a fixed `ACTION_IMPACT` map in
  `lifecycle.ts`; the body may omit it, and a body value that disagrees is 400. Idempotency
  uses an **atomic in-flight reservation**: the key is reserved synchronously
  in the change store before any await, a concurrent request with the same key
  waits for and returns the first result (single flight). The key is released only after a **definite pre-send
  failure** (validation, a 403, or any error before the upstream call is sent);
  after a timeout or a 5xx from the upstream the outcome is unknown, so the key
  is kept in an `unknown` state and a retry gets 409 (or 502) until a status
  lookup reconciles it, which prevents a second ticket. Add a
  per-provider outbound rate limit. Then edit `src/rbac/matrix.ts` (sequenced
  after A1) to switch the status of `cm/change` from `deferred(C3)` to
  `enforced`.
  **Change actions are API-only in this sprint.** `LiveCMClient` keeps
  create, attach and status; request, approve and apply have no button or
  client method. Reason: where the controls sit and who sees them depends on
  the owner ratifying the matrix (D2) and on real identity (D1); the demo
  exercises the lifecycle through the API and the Playwright request context.
- **Files.** `src/cm/lifecycle.ts` (new), `src/cm/changeStore.ts` (new),
  `pages/api/v1/cm/change.ts`, `src/rbac/matrix.ts` (sequenced after A1),
  `src/cm/lifecycle.test.ts` (new).
- **Dependencies.** B4, B1, A1, B8.
- **Red tests.**
  `cto_create_ticket_is_403`,
  `cto_attach_ticket_is_403`,
  `cto_status_read_is_allowed`,
  `finops_lead_can_create_attach_and_read_status`,
  `eng_lead_other_team_workload_request_is_403`,
  `eng_lead_other_team_workload_create_ticket_is_403`,
  `eng_lead_attach_to_an_unbound_ticket_is_403`,
  `eng_lead_status_of_another_teams_bound_ticket_is_403`,
  `client_supplied_env_and_team_are_ignored`,
  `ticket_created_through_create_is_bound_to_the_creators_team_and_env`,
  `eng_lead_can_attach_and_read_status_of_a_ticket_they_created`,
  `change_store_is_shared_across_separately_loaded_module_instances`,
  `request_with_same_idempotency_key_returns_first_change_and_creates_one_upstream_ticket`,
  `same_key_with_different_payload_returns_409`,
  `request_requester_is_the_principal_not_a_body_field`,
  `apply_without_a_bound_ticket_is_denied_in_prod`,
  `apply_with_a_ticket_not_approved_returns_409`,
  `requester_cannot_approve_own_change`,
  `approval_by_another_principal_moves_state_to_approved`,
  `double_approve_and_apply_before_approve_are_rejected`,
  `request_with_existing_ticket_ref_binds_without_creating_an_upstream_ticket`,
  `existing_ticket_ref_of_another_teams_ticket_is_403_for_eng_lead`,
  `a_bound_ticket_cannot_be_bound_to_a_second_change`,
  `a_ticket_bound_by_create_can_be_adopted_by_a_same_team_request`,
  `a_ticket_bound_by_create_cannot_be_adopted_by_another_teams_request`,
  `update_operation_transitions_the_ticket_via_the_stub`,
  `outbound_rate_limit_returns_429_with_retry_after`,
  `ticket_ref_grammar_still_enforced_on_all_operations`,
  `every_c3_operation_has_a_role_by_environment_test_for_its_action` (request: `change.request` plus `ticket.create` or, with `existingTicketRef`, `ticket.bind`; approve: `change.approve`; apply: `change.apply`; update: `ticket.update`; get: `ticket.get`; create, attach and status as before),
  `finance_denied_approving_a_commitment_change`,
  `procurement_denied_approving_a_cost_change`,
  `impact_is_derived_from_the_action_stored_at_request_and_an_approver_cannot_alter_it`,
  `client_supplied_impact_that_disagrees_with_the_action_is_400`,
  `an_action_missing_from_the_impact_map_is_400`,
  `a_requester_cannot_mark_a_commitment_action_as_cost`,
  `concurrent_requests_with_the_same_idempotency_key_create_exactly_one_upstream_ticket`,
  `definite_pre_send_failure_releases_the_key_for_a_retry`,
  `ambiguous_upstream_failure_keeps_the_key_and_does_not_create_a_second_ticket`,
  `unknown_key_is_reconciled_by_a_status_lookup_and_then_returns_the_first_result`,
  `existing_create_attach_status_shapes_are_unchanged_in_the_offline_default`,
  `every_change_step_verdict_reaches_the_registered_sink`,
  `cm_change_matrix_status_is_enforced_and_no_deferred_route_remains`.
- **Governance class.** Path-derived: `routes` (`change.ts`), `unclassified`.
- **Parallel-safe.** Yes with C6 (C2 depends on C3 through C5). **Size.** M (5 to 8 days).

### C4. Inbound webhook with signature and replay protection

- **Goal.** A webhook route that verifies an HMAC signature over the raw body,
  a timestamp window and event-id replay protection; fails closed without a
  configured secret. The replay store is in memory behind an interface (D8).
- **Files.** `pages/api/v1/cm/webhook.ts`, `src/cm/webhookSignature.ts`,
  `src/cm/replayStore.ts`, `src/cm/statusHandlers.ts`, `src/cm/webhook.test.ts`
  (all new). After the signature and replay checks pass, the route calls the
  handlers registered through `registerStatusHandler` in `statusHandlers.ts`
  (an injectable seam; with none registered the event is acknowledged and
  dropped).
- **Dependencies.** C3, A4.
- **Red tests.** `valid_signature_within_window_is_accepted`,
  `bad_signature_is_rejected_with_constant_time_compare`,
  `signature_is_computed_over_raw_body_bytes_not_reserialized_json`,
  `timestamp_outside_window_is_rejected`,
  `replayed_event_id_is_rejected_and_state_is_unchanged`,
  `event_for_unknown_ticket_is_ignored_without_creating_state`,
  `webhook_fails_closed_without_a_configured_secret`,
  `webhook_secret_never_logged`,
  `verified_event_is_passed_to_every_registered_status_handler`,
  `event_is_acknowledged_when_no_handler_is_registered`,
  `replay_store_is_shared_across_separately_loaded_module_instances`.
- **Governance class.** Path-derived: `routes`, `unclassified`. Content-derived
  possible: `secrets`.
- **Parallel-safe.** Yes with C5, C6 (after C3). **Size.** M (4 to 6 days).

### C5. Audit sink, read route and page

- **Goal.** Supply the audit sink behind B1's `decide()` and `requires`,
  replacing B1's in-memory default. C5 edits **one factory line** in
  `src/server/gateway/verdictSink.ts` (sequenced after B1) so the default sink
  factory returns the audit sink; registration stays lazy on the first enforced
  request and on B1's `globalThis` registration. The root `instrumentation.ts`
  and its pinned import closure (`src/ingest/importBoundary.test.ts`) are
  **not** touched. Every gateway verdict (routes that use `requires`, and
  `decide()` calls) and every change-lifecycle step writes a
  record (who, action, environment, verdict, ticket linkage) with no secrets,
  tokens or email addresses. In-memory sink behind an interface (D8), held on
  a `globalThis` accessor. A read route and an audit page, scoped by role and
  team (PLAN 4.4 and 4.5). The MCP client's own `authorize()` calls (card B5)
  go to its injected audit callback and are **not** in this guarantee; wiring
  that callback to the sink belongs to the Frank M2 broker.
- **Files.** `src/audit/sink.ts`, `record.ts`, `register.ts`, `index.ts`,
  `audit.test.ts`; `pages/api/v1/audit/records.ts`; `pages/audit.tsx` (all new);
  `src/server/gateway/verdictSink.ts` (one-line edit: its default-sink factory
  imports `createAuditSink` from `register.ts`).
- **Dependencies.** B1, C3.
- **Red tests.** `every_gateway_and_change_lifecycle_decision_writes_an_audit_record`,
  `mcp_client_decisions_are_not_claimed_by_this_sink_and_use_the_injected_callback`,
  `audit_record_has_no_secret_token_or_email`,
  `audit_links_request_ticket_approval_and_apply`,
  `audit_read_is_scoped_by_role_and_team`,
  `audit_read_denied_for_finance_and_procurement`,
  `audit_sink_failure_denies_the_action` (exercises B1's fail-closed path with
  the real sink),
  `default_sink_factory_resolves_to_the_audit_sink_on_first_enforced_request`,
  `instrumentation_ts_is_unchanged_so_its_import_closure_test_still_passes`,
  `audit_store_is_shared_across_separately_loaded_module_instances`.
- **Governance class.** Path-derived: `routes` (two), `auth_tenancy`
  (`verdictSink.ts`), `unclassified`.
- **Parallel-safe.** Yes with C4, C6. **Size.** M (4 to 6 days).

### C6. OAuth2 client-credentials client behind an interface

- **Goal.** A token client (cache until expiry, single refresh on 401, host
  allowlist) and a mock token endpoint, proving the shape only. Wiring it into
  the adapters is owner decision D4 and is not done.
- **Files.** `src/cm/tokenClient.ts`, `tokenClient.test.ts` (new);
  `src/mock/tokenService/server.ts` (new, a directory separate from A4's
  `src/mock/itsm/**`). Does not edit `pages/api/v1/cm/change.ts`.
- **Dependencies.** B4, A4. The token request goes through B4's exported
  `safeFetch` (`redirect: 'manual'`), because it POSTs the client secret.
- **Red tests.**
  `token_endpoint_307_and_308_redirects_are_not_followed_and_the_secret_is_not_resent`,
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
  vocabularies and Ratio's own update echo. The polling entry point:

  | Route | Request body | Success response | Errors |
  |---|---|---|---|
  | `POST /api/v1/cm/sync` (`withGateway`, `enforced`, A1 row `status_sync`) | `{changeId}` only | `200 {changeId, state, ticketState, updatedAt}` after one status lookup of the bound ticket and `applyEvent` | 400 invalid body; 401 no principal; 403 the verdict denies; 404 unknown change or no bound ticket; 502 a fixed message on an upstream failure; 429 from C3's outbound limit |

  The server builds the `Resource` from the stored change only
  (`{kind: 'change', id: changeId, team, env}` with the team and environment
  recorded by C3), never from the body, and calls `decide(principal,
  'ticket.update', resource)`, so an Eng lead can poll only own-team changes
  (`Y*`) and no other role but the FinOps lead can poll at all.
- **Files.** `src/cm/statusSync.ts`, `src/cm/statusSync.test.ts` (new);
  `pages/api/v1/cm/sync.ts` (new: the polling entry point);
  `pages/api/v1/cm/webhook.ts` (sequenced after C4: one line registering
  `applyEvent` through C4's `registerStatusHandler`).
- **Dependencies.** C4, C3.
- **Red tests.** `out_of_order_events_do_not_regress_state`,
  `own_update_echo_does_not_loop`,
  `poll_fallback_reconciles_a_missed_webhook`,
  `provider_status_vocabularies_map_to_the_four_states`,
  `rejected_ticket_blocks_apply`,
  `status_sync_idempotent_under_duplicate_delivery`,
  `sync_never_moves_a_change_to_applied_without_an_apply_call`,
  `a_verified_webhook_event_reaches_apply_event_through_the_registered_handler`,
  `post_to_the_sync_endpoint_polls_the_provider_and_reconciles_a_missed_webhook`,
  `sync_endpoint_requires_the_ticket_update_permission_and_is_403_for_others`,
  `sync_endpoint_is_not_callable_anonymously_when_enforced`,
  `sync_endpoint_takes_team_and_env_from_the_stored_change_not_the_body`,
  `eng_lead_sync_of_another_teams_change_is_403`,
  `sync_of_an_unknown_change_or_unbound_ticket_is_404`.
- **Governance class.** Path-derived: `routes` (`sync.ts`, `webhook.ts`), `unclassified` (the rest).
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
   Branch from current `origin/main` as `feat/sprint-<sprint>-<id>-<slug>`, for
   example `feat/sprint-a-a2-mock-idp`. Re-fetch `origin/main` before you start and before you push.
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
6. **Small PR, squash only.** One card, one PR, within the size budget
   (production lines at most 400, tests at most 1.5 times that, evidence at
   most 150 lines in one `red.txt` and one `green.txt`). No docs-only PRs:
   plan and evidence updates ride with the first code PR they describe, and
   stale text is corrected rather than duplicated. Code revisions merge by
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
     then C3), `src/costsource/CostSourcePage.tsx` (A8 then B7),
     `src/rbac/matrix.ts` (A1 then C3),
     `src/server/gateway/verdictSink.ts` (B1 then C5),
     `pages/api/v1/cm/webhook.ts` (C4 then C8), and the roll-up consumers
     `src/mission/missionModel.ts` and `src/findings/findingsModel.ts` (B8 then
     B12). Do not start the later card before the earlier has merged.
   - `src/costsource/seed.ts`, `sandboxSources.ts`, `CostSourceClient.ts` and
     `MockCostSourceClient.ts` belong to A6 only.
10. **Boundary reminders.** Loopback only, no real credentials, no real data,
    no spend. Keep secrets, tokens and key material out of logs, errors, test
    output and commits. Use U.S. English (en-US) in all prose, comments and
    tests. Do not rename serialized fields or public contracts as part of a card.
11. **Report back.** In the PR, state which red tests you added, which
    mutations you tried, the classifier result, the regression analysis, and
    anything you found that changes PLAN facts or sizes.
