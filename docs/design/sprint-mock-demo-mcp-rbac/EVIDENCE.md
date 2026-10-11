# Evidence: how the plan's facts were verified

Facts F1 to F20 were read on 2026-10-11 at `origin/main` `62bd8ed`
(`62bd8ed5cffc3f5b502403f355412cc7aa96db9a`, fetched from
`https://github.com/realjkg/finops-ratio`); F21, F22 and the card file lists at
`8caec87`, which differs from `62bd8ed` only by documentation
(`git diff --stat 62bd8ed 8caec87`). Line numbers below are from those commits.
The merged-card records and the corrections in the section "Re-checked against
merged code" were checked at `origin/main` `c95be35` while folding this plan
into PR #110 (A8).

## How to repeat

Each row gives the claim, the command, and the result.

| Fact | Command | Result |
|---|---|---|
| F1 enforcement rule | `sed -n 33,43p src/server/gateway/auth.ts` | `enforce: Boolean(token) \|\| liveProvider`; live providers include `jira` and `servicenow` (line 33 set, 42 return) |
| F1 anonymous when not enforced | `grep -n "anonymous" src/server/gateway/auth.ts` | `if (!config.enforce) return { ok: true, tenant: 'anonymous' }` at line 88 |
| F2 tenant hash, no identity | `sed -n 53,61p src/server/gateway/auth.ts` | djb2 over the token, `tnt_` plus base36; no user or role field in `AuthOutcome` (lines 21-23) |
| F2 constant-time compare | `grep -n timingSafeEqual src/server/gateway/auth.ts` | lines 11 and 71 |
| F3 open routes | loop over `find pages/api -name "*.ts"` testing for `withGateway\|gateSourceAccess\|evaluateLiveDataAuth\|requireLiveDataAuth\|publishedCostsRoute`, `simulationRoute\|sessionFor`, and the finio secret | no gateway or simulation guard in `attribution`, `tokenomics`, `prediction/predict`, `prediction/accuracy`, `report/snapshot`, `costsource/ingest`, `hello`; `a2a/handshake` and `finio/export` are one-line re-exports of `v1` routes (`head` of each file) |
| F3 those routes use only the error guard | `grep -n "import" pages/api/attribution.ts` (and the others) | only `withInternalErrorGuard` from `@/server/gateway/internalError` |
| F4 persona is client side | `sed -n 10,18p src/lib/persona.ts`; `grep -ln "getServerSideProps\|getStaticProps" pages/*.tsx pages/*/*.tsx`; `ls middleware.* src/middleware.*` | type at line 10, storage key at line 18; grep prints nothing; `ls` reports both missing |
| F5 fixture identities | `sed -n 9,17p src/simulation/server/http.ts`; `cat src/simulation/server/enabled.ts` | six identities; enabled only when `RATIO_SIMULATION === '1'` and `RATIO_ENV` is `development` or `test` |
| F6 simulation roles | `sed -n 87,96p src/simulation/server/workflow.ts`; `sed -n 163p ...` | request-change technical; approve-change executive, procurement; apply-change technical; first two gates technical |
| F7 change route | `wc -l pages/api/v1/cm/change.ts`; `grep -n "methods:" ...` | 514 lines; `methods: ['POST']` at line 508 |
| F8 ServiceNow hardcoded https | `sed -n 182,184p pages/api/v1/cm/change.ts` | returns ``https://${this.instance}/api/now`` |
| F8 no timeout, retry, idempotency | `grep -n "AbortSignal\|timeout\|retry\|Idempot" pages/api/v1/cm/change.ts` | no matches |
| F9 ref grammars | `cat -n src/cm/ticketRef.ts` | regexes at lines 13 and 20; fixed messages lines 34-36; error class lines 39-45 |
| F10 absent capabilities | `grep -rli "webhook" src pages scripts`; `grep -rliE "oidc\|saml\|openid\|jwks\|jsonwebtoken\|\bjose\b" src pages package.json`; `grep -n '"jose"\|jsonwebtoken' package.json` | webhook only in `src/types/index.ts` (alert channel type, line 210) and `src/finio/FinioOverviewPage.tsx` (out-of-scope note, line 250); the identity grep and the package grep print nothing |
| F11 live CM client sends no auth | `sed -n 33,42p src/cm/LiveCMClient.ts` | headers contain only `Content-Type` |
| F12 MCP scaffold | `sed -n 73,146p src/costsource/PointFiveMcpTransport.ts`; `grep -rli mcp src pages` | three tool constants; `callTool` posts `tools/call` only; MCP appears only in costsource files |
| F13 synthetic ServiceNow cost source | `sed -n 1,14p src/costsource/ServiceNowAdapter.ts` | header says "NOT a live ServiceNow integration" |
| F14 sandbox ids and live gate | `cat src/costsource/sandboxSources.ts`; `sed -n 55,62p src/server/gateway/liveDataAuth.ts` | three ids; sandbox returns anonymous |
| F15 second tenant concept | `sed -n 1,22p src/server/costs/config.ts` | `RATIO_API_TENANT_ID` must be a canonical UUID |
| F16 scoping keys and counts | `grep -c "^\s*id: '" src/data/workloads.ts`; `grep -o "team: '[^']*'" src/data/workloads.ts \| sort \| uniq -c`; same for `environment` | 11 ids; 7 teams (CX Engineering 2, IT 1, Legal 2, Marketing 1, Platform Eng 2, Revenue 2, Risk & Trust 1); environments dev 1, prod 8, staging 2 |
| F17 classifier rules | `cat scripts/governance/risk-rules.json` | classes and patterns as quoted in PLAN |
| F18 migrations | `ls src/ingest/db/migrations`; `grep -n "Migration numbers" docs/design/slice-3-5/DESIGN.md` | `0001`, `0002`, `0004` present; design note at line 561 says `0003` and `0005` are reserved. Issue #94 itself could not be read (see limits) |
| F19a formatUSD negative | `node -e` replicating `format.ts` lines 4-12 | `$-5.00`, `$-1,500`, `$-2.5k` |
| F19b favicon | `ls public`; `grep -rn favicon` over source types excluding `node_modules`; `sed -n 1,20p pages/_document.tsx` | no `public/` directory; no matches; head has only a description meta tag |
| F19c dead link | `sed -n 22p src/simulation/SimulationBar.tsx`; `grep -n "enabled" src/simulation/SimulationProvider.tsx` | link rendered in the no-session branch with no `enabled` check; the provider exposes `enabled` (line 8, 14, 88) |
| F19d findings header | `sed -n 603p src/costsource/CostSourcePage.tsx` | title ends "(PointFive DeepWaste shape)" with no source condition |
| F19e demo prompts | `sed -n 9,13p pages/demo.tsx`; at `62bd8ed`, `sed -n 18,25p src/ai/MockAIClient.ts` and a `node -e` copy of `classify` (the mock Frank was rewritten later in PR #99: `src/ai/MockAIClient.ts` now delegates to `src/ai/mock/respond.ts`, so the result below is for `62bd8ed`) | "Why is my spend spiking?" gives `cost_driver`; "Which workload has the worst value ratio?" and "Which model should I switch to?" give `help` |
| F20 reusable pieces | `sed -n 8,9p src/ingest/retry.ts`; `sed -n 20p src/server/gateway/rateLimit.ts`; `ls tests/simulation` | `backoffDelay`, `STANDARD_TIER_LIMIT = 1000`, four Playwright specs |
| Sandbox test already present | `ls src/costsource/sourcesForEnvPurity.test.ts` | exists; card A6 extends it |
| Simulation sources in the workspace | `sed -n 22p src/simulation/types.ts` | `SIM_SOURCES = ['aws','azure','gcp']` are simulation connectors, separate from the cost-source sandboxes A6 adds |
| Vitest scope | `sed -n 1,30p vitest.config.ts` | `tests/simulation/**` excluded; unit tests under `src` run by `npm test`. Persona browser specs therefore need their own folder and config (card C1) |
| F21 unresolved rows | `sed -n 46,58p src/costsource/normalize.ts` | the `!workload` branch sets `x_RatioWorkloadId: workloadId ?? ''`, empty team, value 0 |
| F21 mock client fallthrough | `sed -n 41,83p src/costsource/MockCostSourceClient.ts`; `sed -n 95,120p ...`; `sed -n 189p src/costsource/seed.ts` | special dispatch only for the live PointFive id, connector specs and `servicenow-sandbox`; every other id gets `rawRowsForVersion` (all workloads) |
| F21 source kind | `sed -n 21,28p src/costsource/CostSourceClient.ts` | `SourceKind` has `pointfive`, `focus_file`, `servicenow`, `mock`, `cloud`, `kubernetes`, `nutanix`; no synthetic-cloud member. `src/costsource/index.ts` re-exports the type by name |
| F22 store seeded from bundle | `grep -n "WORKLOADS" src/store/useStore.ts` | lines 23, 155, 270 |
| F22 consumers | `grep -rln "s\.workloads\|state\.workloads\|\.workloads" src pages --include=*.ts --include=*.tsx` (tests excluded) | 6 pages (`agent-workflows`, `demo`, `frameworks`, `outcomes`, `overview`, `reports`) and the components under `src/{agent-workflows,attribution,components,connectors,executive,findings,mission,outcomes,simulation}` |
| Seed consumers (card B8) | `grep -rln "from '@/data/workloads'" src pages` (tests excluded) | `attribution/{LiveAccrualBoard,MockAttributionClient,AttributionPage,accrual}`, `ai/buildAIContext`, `executive/{initiativeModel,reportModel}`, `findings/findingsModel`, `mission/missionModel`, `prediction/{MockPredictionClient,PredictionPage}`, `costsource/{seed,normalize}`, `store/useStore`, and others |
| Tests that import the six open routes (card B3) | `grep -oE "pages/api/[a-z/]+" <file>` over the test files | `nonGatewayRoutes`, `apiContract`, `challengerRoutes`, `pointFiveHardening`, `snapshotApi`, `snapshotInternalError`, `safeMessagesSync` import one or more of them |
| Browser callers of those routes | `grep -rln "api/attribution\|api/tokenomics\|api/prediction\|report/snapshot\|costsource/ingest\|api/hello" src` | `LiveAttributionClient`, `LivePredictionClient`, `LiveTokenomicsClient`, `LiveHelloClient`, `SnapshotButton`, `CostSourcePage.tsx:299` (ingest), `FocusDoorWalk` and mission components |
| `RATIO_ENV` vocabulary | `sed -n 11p src/ingest/config.ts`; `cat src/simulation/server/enabled.ts` | `development`, `test`, `staging`, `production`; the simulation checks `development` and `test` only |
| Vitest picks up new Playwright specs | `sed -n 1,30p vitest.config.ts` | default include pattern applies; only `tests/simulation/**` is excluded |
| Frank design cross-references | `grep -n "^### M\|^| T-[0-9]\|^| T[0-9]" docs/design/frank-mcp/DESIGN.md`; `grep -n "D-15" docs/design/slice-3-5/DESIGN.md` | milestones M0 to M4; tracked items (now T-1 to T-9, section 11); threat rows; D-15 defers per-user identity |
| Frank design cited by section | `grep -n "^### \|^| T-[0-9]" docs/design/frank-mcp/DESIGN.md` on `c95be35` | The design is on main and is still revised by later PRs (for example #101), so PLAN and TASKS cite its sections, never a revision, because section numbers stay stable across edits: 2.6 (vendor-agnostic broker; vendor-side connectors rejected by default, T13, A21, OD-13), 3.1 to 3.8 (3.3 key table with bodies, `*_hash` rules and size caps; 3.8 startup environment check), A18 to A21, and tracked items T-6 (reconcile with this plan), T-7 (per-role, team and environment allowlists) and T-8 (per-tenant model-token budget, outside the broker) in section 11 |
| Mock Frank rewrite (PR #99) | `git diff --stat 8caec87 7a9da43 -- src/ai` | `src/ai/mock/*` added; `MockAIClient.ts` delegates to it; `buildAIContext` also reads alerts from the seed (card B8 covers it). F19e and card A8 were re-checked against it |
| Instrumentation import closure is pinned | `sed -n 216,228p src/ingest/importBoundary.test.ts` | the closure of `instrumentation.ts` must equal exactly `instrumentation.ts`, `src/ingest/db/tenant.ts`, `src/server/costs/config.ts`; so the audit sink is registered through the gateway's `verdictSink.ts` default-sink factory (card C5), not through `instrumentation.ts` |
| Simulation provider resets the store | `grep -n clearSimulation src/simulation/SimulationProvider.tsx src/store/useStore.ts` | provider calls `clearSimulation()` at lines 21, 61, 68, 70, 84; the store re-seeds workloads, budgets and alerts at `useStore.ts:155` |
| Budget code reads the series | `grep -rn "daily_spend_history" src --include=*.ts --include=*.tsx -l`; `ls src/lib/budgetStatus.ts` | `src/types/index.ts:189` requires the field; `budgetStatus.ts` is under the `financial_semantics` glob `src/lib/budgetStatus*` |
| Other seed readers | `grep -rn "WORKLOADS" src/findings/recommendationMath.ts src/costsource/normalize.ts src/lib/calendarTzProbe.ts` | each reads the seed; stated out of scope in card B8 with the reason |
| Store reset surface | `sed -n 266,290p src/store/useStore.ts` | `selectedId: WORKLOADS[0]?.id` (275), `aiMessages`, `filters`, plus `connectorSessions` and `ingestRuns` reset in `clearSimulation` (155) |
| Page components that bypass the store | `grep -n "WORKLOADS" src/attribution/AttributionPage.tsx src/attribution/LiveAccrualBoard.tsx src/prediction/PredictionPage.tsx src/data/userQueries.ts` | AttributionPage 15, 29-30; LiveAccrualBoard 15, 44; PredictionPage 16, 24, 84, 152; userQueries 15, 59, 71 |
| Store budgets and alerts | `grep -n "BUDGET_PROFILES\|ALERTS" src/store/useStore.ts` | seeded at 24-25, reset at 155, initial state 271-272 |
| PersonaProvider reads localStorage | `sed -n 1,30p src/components/PersonaProvider.tsx` | `readStoredPersona(window.localStorage)` after mount; mounted in `pages/_app.tsx` lines 6 and 27 |
| Simulation CSRF is session-bound | `sed -n 30,40p src/simulation/server/http.ts` | `sameOrigin` compares `RATIO_SIMULATION_ORIGIN` (line 30-33); `requireCsrf(req, session)` compares with `session.csrf` (line 34-) |
| Published costs route and live-data auth | `grep -n evaluateLiveDataAuth src/server/costs/publishedCostsRoute.ts` | import line 22, call line 123 |
| Card governance classes | `node scripts/governance/classify-risk.mjs --paths-file <card file list>` per card | path-derived classes quoted in TASKS.md (distinct paths, test files that match the low-risk glob not counted: A1 `auth_tenancy` x2 and `unclassified` x4; A6 `financial_semantics` x9 and `unclassified` x1; B1 `auth_tenancy` x8 and `unclassified` x1; B2 `auth_tenancy` x2 and `routes` x5; B7 `routes` x5, `financial_semantics` x2, `unclassified` x9; B8 `financial_semantics` x2 and `unclassified` x12); content-derived classes (`network_egress`, `secrets`) cannot be derived from paths and are marked "expected" |

## Re-checked against merged code

| Claim | Command | Result |
|---|---|---|
| Sprint A merge commits | `git log --oneline origin/main` | A1 #103 `0e097a2`, A2 #104 `de7e5b4`, A3 #105 `039e9b6`, A6 #108 `6acd2ba`, A7 #109 `a3c1437`; follow-up #111 `e184a44`; #99 `7a9da43`, #102 `a90dda5`, #101 `0ace878`, #112 `c95be35`. A4 #106, A5 #107 and A8 #110 are open |
| Merged A1 contract | `sed -n 20,27p src/identity/types.ts`; `sed -n 115,137p src/rbac/matrix.ts` | `Action` has `ticket.bind` and `ticket.get`, no `change.read`; `ChangeImpact` is `cost`, `commitment`, `operational`; `requiresImpact` finance `cost`, procurement `commitment`; `/api/v1/cm/sync` row `status_sync` with `plannedBy: 'C8'` and action `ticket.update` |
| Legacy grant | `sed -n 44,62p src/rbac/matrix.test.ts` | 11 legacy-readable routes derived from the source; legacy actions exactly `ticket.attach`, `ticket.create`, `ticket.status`, `view.export` (export is checked against the same route rows in `authorize.ts`) |
| `eng_lead` on tokenomics and prediction | `grep -n "tokenomics:\|prediction:" src/rbac/matrix.ts` | `tokenomics: 'O D D T O D'`, `prediction: 'O D - T - D'` (shared by predict and accuracy): `T`, not the `-` PLAN 4.4 asks for; open item for B3 |
| A2 loopback helper | `grep -rn isLoopbackRequest src` | no match: merged A2 has only `mockIdpEnabled` in `enabled.ts`; the helper moves to B7 |
| A6 extra file | `git show --stat 6acd2ba` | `src/costsource/challengerRoutes.test.ts` edited (three ids added to a skip list) besides the listed files |
| Roll-up cache leak (PR #100 review, High) | `sed -n 80,120p src/lib/derive.ts`; `sed -n 109,170p src/outcomes/model.ts` | `deriveCacheEconomics` returns `cachedTokens`, `uncachedInputTokens`, `uncachedRatePer1m`, `cachedRatePer1m`; `estimateTca`'s infrastructure line is `round(compute * 30 * 100)` cents. PLAN 4.4a now names minimized aggregates instead |
| A8 prompts module | `grep -n DEMO_PROMPTS pages/demo.tsx src/ai/MockAIClient.ts src/ai/demoPrompts.test.ts` | exported from `MockAIClient.ts`, imported by the page and the test; no other card lists `MockAIClient.ts`, so it is back in A8's file list |

## Governance classifier

`node scripts/governance/classify-risk.mjs --git origin/main...HEAD` was run on
`origin/main` itself (empty change set) and returned `restricted` with class
`unclassified` and rule `empty-change-set`. The result for this branch is in the
PR body. The classifier's rules also scan added lines of any path for the words
for data deletion and for password assignments, so this plan avoids those
phrases.

## Checks run on the documents

- `package.json` has no doc or prose lint script (scripts: `dev`, `build`,
  `start`, `lint`, `typecheck`, `test`, `test:db`, and others; none for docs).
  `npm run lint` is `eslint .` and does not cover Markdown.
- `git diff --check origin/main...HEAD`: see PR body for the result.
- Plan consistency was checked by script on the final files: the ownership
  and dependency tables in TASKS.md were parsed; the dependency graph is
  acyclic (28 cards); every file has one owner except the seven files edited in
  sequence by a later card that depends on the earlier one
  (`src/rbac/matrix.ts` A1 then C3, `src/costsource/CostSourcePage.tsx` A8 then
  B7, `src/server/gateway/verdictSink.ts` B1 then C5, `pages/api/v1/cm/change.ts`
  B4 then C3, `pages/api/v1/cm/webhook.ts` C4 then C8, and
  `src/mission/missionModel.ts` and `src/findings/findingsModel.ts` B8 then
  B12); the PLAN section 6 rows match the card sets; the sum is 114 to 175
  person-days over 28 rows.

## Limits of this verification

- Issue #94 could not be read: the GitHub GraphQL interface is blocked in this
  session. The migration-numbering fact rests on the repository text in F18.
  `docs/design/frank-mcp` was read from `origin/main` after the revision-2 merge.
- The plan itself changes no code. It rides with A8 (#110), whose tests,
  lint and typecheck results are in that PR.
- Effort sizes are estimates, not measurements.
- Nothing here was checked against real Jira, ServiceNow, an identity provider,
  or an MCP server. The wire contracts in the mocks come from what the adapters
  send and read, not from vendor documentation.
