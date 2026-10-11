# Evidence: how the plan's facts were verified

Verified on 2026-10-11 in a fresh clone at `/home/user/plan-sprint`, branch
`docs/sprint-plan-mock-demo-mcp-rbac`, based on `origin/main` at `62bd8ed`
(`git rev-parse origin/main` after `git fetch origin` against
`https://github.com/realjkg/finops-ratio`). Nothing was run against a network
service other than that fetch. Line numbers are from that commit.

A correction first. The local source clone used to seed the fresh clone had a
stale `main` (`827773f`, slice 2b). The branch was reset to the fetched
`origin/main` (`62bd8ed`) before any fact was read, and `git rev-parse HEAD`
returned `62bd8ed5cffc3f5b502403f355412cc7aa96db9a`.

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
| F19e demo prompts | `sed -n 9,13p pages/demo.tsx`; `sed -n 18,25p src/ai/MockAIClient.ts`; `node -e` copy of `classify` | "Why is my spend spiking?" gives `cost_driver`; "Which workload has the worst value ratio?" and "Which model should I switch to?" give `help` |
| F20 reusable pieces | `sed -n 8,9p src/ingest/retry.ts`; `sed -n 20p src/server/gateway/rateLimit.ts`; `ls tests/simulation` | `backoffDelay`, `STANDARD_TIER_LIMIT = 1000`, four Playwright specs |
| Sandbox test already present | `ls src/costsource/sourcesForEnvPurity.test.ts` | exists; card A6 extends it |
| Simulation sources in the workspace | `sed -n 22p src/simulation/types.ts` | `SIM_SOURCES = ['aws','azure','gcp']` are simulation connectors, separate from the cost-source sandboxes A6 adds |
| Vitest scope | `sed -n 1,30p vitest.config.ts` | `tests/simulation/**` excluded; unit tests under `src` run by `npm test`. Persona browser specs therefore need their own folder and config (card C1) |

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
- Effort figures in PLAN section 6 were summed from the table: 17 rows, low
  ends 66, high ends 105.

## Limits of this verification

- Issue #94 and the branch `docs/frank-mcp-proposal` could not be read: the
  GitHub GraphQL interface is blocked in this session, and the branch is not on
  `origin` yet (`git ls-remote origin 'refs/heads/docs/*'` lists three other
  branches). The migration-numbering fact rests on the repository text in F18.
- No test suite was run. The plan changes no code, and `node_modules` is not
  installed in the fresh clone.
- Effort sizes are estimates, not measurements.
- Nothing here was checked against real Jira, ServiceNow, an identity provider,
  or an MCP server. The wire contracts in the mocks come from what the adapters
  send and read, not from vendor documentation.
