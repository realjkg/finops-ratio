# Sprint plan: mock-demo environment, MCP-connected access, and role-based access

Status: proposal for owner review. Docs only. Base: `origin/main` at `62bd8ed`.
Companion files: [TASKS.md](./TASKS.md) (sprint backlog and agent runbook) and
[EVIDENCE.md](./EVIDENCE.md) (how every fact below was verified).

Boundary (v2): everything in this plan runs local and ephemeral. No production
infrastructure, no real data, no real credentials, no spend. Anything that
needs a real Jira, ServiceNow, identity provider, or MCP server is listed in
section 8 as an owner decision and is not planned for this sprint.

A note on placement. `.obvious/skills/doc-authoring/SKILL.md` says design specs
are ephemeral and are not checked in. The owner asked for these three files at
this path, so they are checked in as a point-in-time sprint plan. The durable
rules that come out of the sprint (the permission matrix, the MCP allowlist
rules) should be promoted to `.obvious/obvious.md` by the cards that implement
them, and this directory should then be removed, following the promotion
routine in that skill.

## 1. Answers to the owner's four questions

1. **Scope.** Build only the cheaper mock-demo environment (mock Jira, mock
   ServiceNow ITSM, mock identity provider, mock MCP server, three per-provider
   sandbox sources). No live model and no spend. Every mock sits behind the same
   seam the real thing will use, so going deeper later means swapping a
   configuration value, not rewriting code (sections 4 and 7).
2. **MCP for any environment and any team under RBAC.** Not built today. The
   only MCP code is a PointFive-specific client scaffold (F12). The plan adds a
   generic, allowlisted, read-only-first MCP client with a per-role tool
   allowlist, per-environment scoping (dev, test, prod) and per-team
   credentials. The Frank MCP proposal on branch `docs/frank-mcp-proposal` is
   written separately; this plan references it and does not duplicate it.
3. **Do authentication and roles exist for the views and for change management
   through ServiceNow and Jira, with automated ticketing?** Partly, and not in
   the form the question needs.
   - Authentication exists as one shared bearer token. It carries no user
     identity and no role (F1, F2).
   - Roles exist only inside the dev/test customer simulation, as three
     fixture personas with server-side checks (F5, F6).
   - The page views have no server-side access control at all. Persona is a
     browser setting (F4). Seven API routes serve seeded data anonymously (F3).
   - Outbound ticketing exists: create, attach and status lookup for Jira and
     ServiceNow behind `POST /api/v1/cm/change` (F7). It is not automated: a
     caller must invoke it, nothing links a ticket to an approval or an apply,
     and nothing listens for ticket changes (F9, F10).
4. **Agents run these capabilities through sprint tasks, iteratively and in
   parallel.** TASKS.md defines self-contained cards. Sprint A contains cards
   with disjoint file sets that can all run at once; each card has named red
   tests and a governance class. The runbook there tells an implementer agent
   how to take a card without conflicting with the others.

How hard is it to build with security-enabled APIs? Moderate overall, and hard
in three specific places. See section 6: roughly 66 to 105 person-days for the
whole mock-environment scope (the sum of the table there), of which the
identity-and-roles retrofit across existing routes, webhook trust and the
two-way ticket status sync carry most of the risk.

## 2. Current-state facts (verified on main)

Every row was checked against `origin/main` at `62bd8ed`. EVIDENCE.md lists the
command behind each. A lead from the owner's brief that turned out to be wrong
or incomplete is marked "corrected".

| # | Fact | Where |
|---|---|---|
| F1 | One shared bearer token. `resolveGatewayAuth` turns enforcement on when `RATIO_API_TOKEN` is set, or when a live AI provider or a live change-management provider (`jira`, `servicenow`) is selected. With no token and the mock provider, enforcement is off and every caller is `anonymous`. | `src/server/gateway/auth.ts:36-43`, `:88` |
| F2 | The tenant is a non-reversible hash of the token (djb2 to base36), used for rate limiting and logs. There is no user identity and no role. Token comparison is constant time (`tokensMatch`). | `src/server/gateway/auth.ts:55-61`, `:69` |
| F3 | Seven API routes have no authentication check and serve seeded data: `attribution`, `tokenomics`, `prediction/predict`, `prediction/accuracy`, `report/snapshot`, `costsource/ingest` and `hello`. They use only `withInternalErrorGuard`. Two more (`a2a/handshake`, `finio/export`) re-export their `v1` gateway-wrapped versions. | `pages/api/attribution.ts`, `pages/api/tokenomics.ts`, `pages/api/prediction/*.ts`, `pages/api/report/snapshot.ts`, `pages/api/costsource/ingest.ts`, `pages/api/hello.ts` |
| F4 | The persona (`executive`, `technical`, `procurement`) is a client-side value stored in the browser (`ratio_persona`). It is a lens, not an authorization boundary. No `getServerSideProps` or `getStaticProps` exists in any page, and there is no `middleware.ts`. | `src/lib/persona.ts:10`, `:18` |
| F5 | Fixture identities exist only for the simulation: six users (acme and northstar, each with executive, technical and procurement), cookie session, CSRF check, 404 unless `RATIO_SIMULATION=1` and `RATIO_ENV` is `development` or `test`. | `src/simulation/server/http.ts:9-16`, `:17`, `:34`; `src/simulation/server/enabled.ts:5-7` |
| F6 | The simulation has a per-action role table, an ordered governance gate check, and a three-state change record (`requested`, `approved`, `applied`). Request and apply are technical; approve is executive or procurement; the first two gates are technical, the rest are not. Every command is audited. | `src/simulation/server/workflow.ts:87-112`, `:163`, `:228`; `src/simulation/types.ts:7-9` |
| F7 | Change management (corrected: 514 lines, as briefed). `POST /api/v1/cm/change` takes `{operation: create / attach / status}`. `JiraAdapter` and `ServiceNowAdapter` are classes exported from the route file. Provider comes from `CM_PROVIDER`; the default is the mock. Only POST is allowed. | `pages/api/v1/cm/change.ts:60`, `:172`, `:306-339`, `:508` |
| F8 | Adapter details that matter for mocks. Jira takes `baseUrl` from `JIRA_BASE_URL` and sends `Authorization: Bearer <token>`. ServiceNow hardcodes `https://<instance>/api/now`, so a local plain-HTTP stub cannot be reached without a code seam. ServiceNow uses Basic auth. No timeout, retry, or idempotency key on any outbound call. | `pages/api/v1/cm/change.ts:70`, `:183`, `:206` |
| F9 | Ticket reference grammars and defenses are in place: Jira key `^[A-Z][A-Z0-9_]{0,254}-[1-9][0-9]{0,9}$`, ServiceNow number `^[A-Z]{1,16}[0-9]{1,32}$`, checked before any URL is built and again inside the adapter, with fixed non-echoing error messages. `attach` ignores the caller's `provider` field. Upstream error bodies go to a redacted log, not to the caller. | `src/cm/ticketRef.ts:13`, `:20`, `:34-45`; `pages/api/v1/cm/change.ts:119`, `:450-457`, `:488` |
| F10 | Not present anywhere in `src` or `pages`: inbound webhooks, signature or replay verification, OIDC or SAML, JWT libraries (`package.json` has none), per-user roles on the gateway, ticket status sync or polling, and any link between a ticket and a change record. The word "webhook" appears only as an alert-channel type and a note that webhook push is out of scope for the FinOps export. | `src/types/index.ts:210`; `src/finio/FinioOverviewPage.tsx:250` |
| F11 | `LiveCMClient` posts to the route with no `Authorization` header, so a deployment that sets a token cannot use the in-browser client as written. `MockCMClient` is idempotent under test. | `src/cm/LiveCMClient.ts:34-40`; `src/cm/MockCMClient.ts:4` |
| F12 | MCP: one client scaffold for PointFive only. `SsePointFiveMcpClient` posts JSON-RPC `tools/call` with an OAuth bearer token; there is no `initialize` handshake, no `tools/list`, no allowlist, and its own comment says the wire framing is unvalidated. Tool names are three constants. No Frank MCP client exists. | `src/costsource/PointFiveMcpTransport.ts:73-77`, `:86-146` |
| F13 | `ServiceNowAdapter` under `src/costsource` is a synthetic cost source (CMDB and ITBM allocation rows), not an ITSM client. Its own header says so. Do not confuse it with the class of the same name in the change route. | `src/costsource/ServiceNowAdapter.ts:1-14` |
| F14 | Live-data gate: sandbox source ids are served anonymously; every other id needs a strong `RATIO_API_TOKEN` (32 or more characters, 10 or more distinct). Failed attempts are counted per client IP. Today three sandbox ids exist: `pointfive-sandbox`, `focus-file-sandbox`, `servicenow-sandbox`. | `src/costsource/sandboxSources.ts:5-9`; `src/server/gateway/liveDataAuth.ts:60`, `:123` |
| F15 | A second tenant concept exists. The published-costs route binds a token to a tenant UUID through `RATIO_API_TENANT_ID`; the gateway derives its own hash tenant. They are not connected. | `src/server/costs/config.ts:5`, `:19` |
| F16 | Workloads carry `team` and `environment` fields (`prod`, `staging`, `dev`, `sandbox`), which are the natural scoping keys. The seeded set has 11 workloads, 7 teams, and environments dev 1, staging 2, prod 8. | `src/types/index.ts:13`, `:128-129`; `src/data/workloads.ts` |
| F17 | Governance classifier: path-based. `src/server/gateway/**` and any `src/` or `pages/api/` path matching `auth\|tenant\|rls\|role` are `auth_tenancy`; `src/costsource/**` and focus, normalize, reconcile names are `financial_semantics`; `pages/**` is `routes`; a path in no rule is `unclassified` and restricted (fail closed). Docs under `docs/**` with `.md` are low. | `scripts/governance/risk-rules.json` |
| F18 | Migration numbering is unresolved: `0001`, `0002`, `0004` exist; `0003` and `0005` are reserved by comments elsewhere; issue #94 tracks it (see EVIDENCE.md for what could and could not be verified). Cards in this plan add no migrations. | `src/ingest/db/migrations/`; `docs/design/slice-3-5/DESIGN.md:561` |
| F19 | Demo defects confirmed. (a) `formatUSD(-5)` returns `$-5.00` and `formatUSD(-1500)` returns `$-1,500`. (b) No favicon: no `public/` directory and no icon link in the document head. (c) The "Customer sign-in simulation" link renders whenever no simulation session exists, even when the simulation is disabled and the route would return 404. (d) The findings card is titled "(PointFive DeepWaste shape)" for every source, including ServiceNow. (e) Two of the three `/demo` prompts fall through to the mock Frank help reply. | `src/lib/format.ts:4-12`; `pages/_document.tsx:8`; `src/simulation/SimulationBar.tsx:22`; `src/costsource/CostSourcePage.tsx:603`; `pages/demo.tsx:9-13` with `src/ai/MockAIClient.ts:18-25` |
| F20 | Existing building blocks to reuse: bounded backoff with jitter and a transient-error classifier (ingest worker), a sliding-window rate limiter, a redacting error logger, and Playwright simulation specs. | `src/ingest/retry.ts:8-9`; `src/server/gateway/rateLimit.ts:20`; `tests/simulation/*.spec.ts` |

Answer to the "is there a persona or role model" question in one line: three
fixture personas exist in the simulation (F5, F6); none exists for the real
gateway or the page views (F1, F4).

## 3. Design principles for this sprint

1. **Seams first, mocks behind them.** Each capability gets an interface
   (token verifier, ITSM provider, MCP transport, cost source). The mock and
   the real implementation are interchangeable by configuration. This is how
   the plan satisfies "ensure the code capabilities exist to go deeper".
2. **Deny by default.** A request with no verified principal gets 401. A
   principal with no matching grant gets 403. Missing configuration never
   widens access.
3. **One decision function.** All route checks call a single pure
   `authorize(principal, action, resource)` function, so the permission matrix
   is data that tests can enumerate.
4. **Server decides, client reflects.** Hiding a nav item is a courtesy; the
   route check is the control. The persona switcher in the browser stops being
   an authority.
5. **Wrap before replace.** The shared `RATIO_API_TOKEN` keeps working as a
   legacy principal until the owner retires it (section 8, decision D9).

## 4. Authentication and authorization workstream (owner priority)

Goal: the CTO and the FinOps lead each get their own view, accurate and equally
well tested, from the same underlying data. This is a first-class workstream
and is placed in Sprint A wherever it can run without dependencies.

### 4.1 Personas and scope

| Persona | Role id | Scope (teams, environments) | Closest simulation persona (F5) |
|---|---|---|---|
| CTO | `cto` | All teams; dev, test, prod | executive |
| FinOps lead | `finops_lead` | All teams; dev, test, prod | none (new) |
| Finance | `finance` | All teams; cost and budget data only | none (new) |
| Engineering or platform lead | `eng_lead` | Own teams only (from the token); the environments listed in the token | technical |
| Procurement | `procurement` | All teams; vendor and commitment data | procurement |
| Read-only auditor | `auditor` | All teams; every environment; no write of any kind | none (new) |

Scope has two parts. The role fixes what kinds of things a principal may touch.
The token's `teams` and `envs` claims fix which teams and environments. Both
must allow the request.

### 4.2 The contract between cards

Every Sprint A card builds against this literal contract so the cards stay
independent. The contract is owned by card A1 (`src/identity/types.ts`).

```ts
export type Role = 'cto' | 'finops_lead' | 'finance' | 'eng_lead' | 'procurement' | 'auditor';
export type DeployEnv = 'dev' | 'test' | 'prod';

export interface Principal {
  sub: string;                 // stable subject id, never an email in logs
  role: Role;
  teams: string[] | '*';       // '*' = all teams
  envs: DeployEnv[];           // environments this token may act in
  tenant: string;              // tenant id; replaces the djb2 token hash (F2)
  tokenId: string;             // the JWT jti, used for replay and revocation
  expiresAt: number;           // epoch seconds
  authMethod: 'mock-idp' | 'oidc' | 'legacy-shared-token';
}

export type Verdict =
  | { allow: true }
  | { allow: false; status: 401 | 403; reason: string };   // reason is fixed text, never echoes input

export interface TokenVerifier {
  verify(bearer: string, ctx: { now: number; deployEnv: DeployEnv }): Promise<Principal>;  // throws on any failure
}
```

Mock-IdP token claims (card A2): `iss`, `aud` (the deployment environment),
`sub`, `iat`, `exp`, `jti`, plus `role`, `teams`, `envs`, `tenant`. A real OIDC
provider would supply the same claims through its own mapping; that swap is
owner decision D1 and is not done here.

### 4.3 Where today's shared token must be replaced or wrapped

| Today | Change | Card |
|---|---|---|
| `checkAuth` returns `{ok, tenant}` for one shared token (`auth.ts:84-112`) | Wrap: a new `authenticate()` tries the `TokenVerifier` first, then falls back to the legacy token and yields a `legacy-shared-token` principal with a fixed, narrow role grant | B1 |
| `withGateway` step 3 calls `checkAuth` and passes only `{tenant}` to handlers (`withGateway.ts:163-170`, `:194`) | Replace the context with `{principal}` and keep `tenant` as a derived field so existing handlers compile | B1 |
| `evaluateLiveDataAuth` and `gateSourceAccess` compare against `RATIO_API_TOKEN` (`liveDataAuth.ts:141-162`) | Wrap: accept a verified principal with a data-read grant; the failed-attempt accounting stays | B2 |
| Seven unauthenticated routes (F3): six get authentication and a scope filter; `hello` stays an explicit public liveness route. Sandbox data stays reachable only where F14 says so | B3 |
| Persona in `localStorage` (F4) | Derive the active persona from the verified principal on the server; the switcher becomes a lens over what the role already allows | C2 |
| Two tenant concepts (F15) | Use `Principal.tenant` for both | B1 |

### 4.4 Permission matrix: persona by view

Codes: **O** organization roll-up (totals by team, initiative, provider; no
line items or per-user rows); **D** drill-down to workload and line level, all
teams; **T** drill-down limited to the principal's own teams; **S** status only
(never credentials); **R** read reference content; **-** no access (403 from
the API, link hidden in navigation). The matrix is proposed and needs owner
ratification (D2). Environment rule for all rows: a principal sees only
environments present in its `envs` claim, and a token minted for one
deployment environment is rejected by another (the `aud` claim).

| View (page, then API routes) | CTO | FinOps lead | Finance | Eng lead | Procurement | Auditor |
|---|---|---|---|---|---|---|
| Findings `/` | O | D | O | T | O | D |
| Overview `/overview` | O | D | O | T | O | D |
| Workloads `/workloads` | O | D | D | T | O | D |
| Connectors `/connectors`; `/api/v1/connectors` | S | D (configure) | S | S | S | S |
| Cost sources `/costsource`; `/api/costsource/{sources,rows,findings,health,ingest}` | - | D | D | T | - | D |
| Attribution `/attribution`; `/api/attribution` (team dimension) | O | D | D | T | - | D |
| Attribution, user dimension (personal data) | - | D | - | - | - | D |
| Prediction `/prediction`; `/api/prediction/*` | O | D | - | T | - | D |
| Tokenomics `/tokenomics`; `/api/tokenomics` | O | D | D | T | O | D |
| Frameworks `/frameworks` | R | R | R | R | R | R |
| Reports `/reports`; `/api/report/snapshot` (export carries the caller's scope) | O | D | D | T | O | D |
| FinOps export `/finio`; `/api/v1/finio/export` | - | D | D | - | - | D |
| Outcomes and executive dashboard `/outcomes`, `/mission` | O | D | O | T | O | D |
| Frank `/agent-workflows`; `/api/v1/ai/chat` (context is built from the caller's scope only) | O | D | O | T | O | D |
| Change management `/api/v1/cm/change` | see 4.5 | see 4.5 | see 4.5 | see 4.5 | see 4.5 | see 4.5 |
| Audit log (new) | O | D | - | T | - | D |
| Customer simulation `/simulation`, `/workspace`, `/api/v1/simulation/*` | dev and test only | dev and test only | dev and test only | dev and test only | dev and test only | dev and test only |

Reconciliation rule (tested in 4.7): for any single underlying dataset, the
CTO roll-up total equals the FinOps lead drill-down total, equals the sum of
every Eng lead's team-scoped total across all teams, and equals the Finance
total. Rounding is to the cent, applied once at the leaf (see the existing
`formatUSD` fix in card A7 for display only).

### 4.5 Permission matrix: persona by action, per environment

Cell format: `dev / test / prod`. Y = allowed, n = denied, Y* = allowed only
for the principal's own teams, A = allowed only after the bound ticket is in an
approved state and the approver is a different principal from the requester.
Proposed; owner ratifies (D2).

| Action | CTO | FinOps lead | Finance | Eng lead | Procurement | Auditor |
|---|---|---|---|---|---|---|
| Request a change | n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n |
| Approve a change | Y / Y / Y | Y / Y / n (prod: needs CTO or Finance) | Y / Y / Y (cost impact only) | n / n / n | Y / Y / Y (commitment impact only) | n / n / n |
| Apply a change | n / n / n | n / n / n | n / n / n | Y* / Y* / A | n / n / n | n / n / n |
| Create a ticket (outbound) | n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n |
| Attach a pre-approved ticket | n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n |
| Read ticket status | Y / Y / Y | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y | Y / Y / Y |
| MCP read-only tool call (allowlisted) | Y / Y / Y (summary tools) | Y / Y / Y | Y / Y / Y (cost tools) | Y* / Y* / Y* | Y / Y / Y (commitment tools) | Y / Y / Y |
| MCP tool that writes | n / n / n | n / n / n | n / n / n | n / n / n | n / n / n | n / n / n |
| Edit budgets and thresholds | n / n / n | Y / Y / n | Y / Y / Y | n / n / n | Y / Y / Y | n / n / n |
| Manage connectors and sources | n / n / n | Y / Y / Y | n / n / n | n / n / n | n / n / n | n / n / n |
| Read the audit log | Y / Y / Y | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | Y / Y / Y |

Rules that hold across the table:

- Separation of duties: the approver of a change is never its requester.
- Prod apply requires a bound ticket (card C3). A ticket that is not in an
  approved state blocks apply with 409.
- The existing simulation table (F6) is a subset: request and apply map to
  `eng_lead`; approve maps to `cto`, `finance` and `procurement`. Card A1
  includes a test that the new matrix never grants a simulation persona an
  action the simulation currently denies, unless the matrix change is listed in
  the card.
- MCP tools that write are denied for every role in every environment until
  the owner decides otherwise (D6).

### 4.6 The enforcement layer, built so real OIDC can replace the mock

```
request -> authenticate(bearer)
             |-- TokenVerifier (mock-idp now; oidc later)  -> Principal
             |-- legacy shared token                       -> Principal (narrow, flagged)
          -> authorize(principal, action, resource)        -> Verdict  (pure, table-driven)
          -> scope filter (teams, envs) on the data layer  -> rows the caller may see
          -> handler -> audit record (who, what, which environment, verdict)
```

Only the `TokenVerifier` implementation is mock-specific (`MockIdpVerifier`, card B1). The issuer and verifier in card A2 sign and
verify test JWTs and return raw claims; card B1 maps them onto `Principal`. They use a generated local key (EdDSA or ES256 through
`node:crypto`; no new dependency is needed for the mock). A real OIDC verifier
would fetch the provider's signing keys, validate `iss`, `aud`, `exp` and `nbf`,
and map provider claims onto `Principal`. That one verifier file is the only code that changes
(D1).

### 4.7 Persona-accuracy and negative tests

All tests run offline against one fixture dataset (card A3) and mock-issued
tokens (card A2). Named red tests are listed per card in TASKS.md; the classes
are:

1. **Same data, right numbers per persona.** CTO roll-up, FinOps lead
   drill-down, Finance and each Eng lead are computed from one dataset; each
   persona's figures match a committed oracle (hand-checked constants, not
   recomputed by the code under test).
2. **Reconciliation.** CTO total equals FinOps lead total equals the sum of Eng
   lead totals equals Finance total, to the cent.
3. **No stale or partial figures.** A change to the dataset appears in every
   persona's view after one refresh; a persona never sees a figure from an older
   revision than another persona sees.
4. **No cross-team leakage.** An Eng lead for team X receives no row, count or
   total that includes team Y; aggregates are computed after the scope filter,
   not before.
5. **Negative path.** Missing token gives 401; wrong role gives 403 with a
   fixed message; direct API calls cannot do what the UI hides; a role claim
   edited in a token fails signature verification; an expired token fails; a
   token for `test` is rejected by a `prod` deployment; a replayed one-time
   token (same `jti`) fails where single use is required.
6. **Role change takes effect.** After the mock IdP re-issues a token with a
   new role or team set, the next request reflects it, and the old token is
   rejected after revocation.
7. **Route-level matrix test.** One generated test enumerates every API route
   by every persona by every environment and asserts the table in 4.4 and 4.5.
   It fails when a route is added without a matrix row (card B3).
8. **Browser matrix.** A Playwright spec signs in as each persona and checks
   navigation, page content and totals (card C1).

## 5. Gap analysis

### 5.1 Role-based access control

| Need | State today | What to build | Card |
|---|---|---|---|
| Identity source | Shared token (F1); fixtures in simulation (F5) | `TokenVerifier` seam, mock IdP with signed JWTs, `Principal` | A1, A2, B1 |
| Roles | Three fixture personas (F5) | Six roles, table-driven | A1 |
| Permission matrix per view | None server-side (F4) | Data table plus `authorize()` | A1, B3 |
| Permission matrix per action | Simulation only (F6) | Same table for real actions | A1, C3 |
| Per-environment scoping | `RATIO_ENV` gates the simulation only (F5) | `envs` claim, `aud` check | A2, B1 |
| Per-team scoping | `team` field exists on data (F16) | `teams` claim, scope filter before aggregation | A3, B3 |
| Audit | Simulation audit entries (F6); gateway request log with hashed tenant (F2) | Audit record for every decision, no secrets | C5 |

### 5.2 MCP-connected access

The Frank MCP proposal (branch `docs/frank-mcp-proposal`, being written by
another agent) owns the Frank-specific design. This plan covers the
platform pieces every MCP use needs and defers to that proposal for Frank.

| Need | State today | What to build | Card |
|---|---|---|---|
| Generic client | PointFive-only scaffold (F12) | MCP client with `initialize`, `tools/list`, `tools/call` over one transport interface | A5 (mock server), B5 (client) |
| Read-only first | No allowlist | Allowlist of tool names with a `readOnly` declaration; unknown tools denied | B5 |
| Environment scoping | None | One endpoint registry keyed by environment; a dev token cannot reach a prod endpoint | B5 |
| Per-role tool allowlist | None | Role to tool mapping, enforced by `authorize()` before any call | B5 |
| Per-team credentials | None | Credential reference per team and environment, resolved server-side, never returned | B5 |
| No secrets in logs | Redacting logger exists (F20) | Reuse it; add a test that scans logs for a planted secret | B5 |
| Fixture server for tests | None | Mock MCP server with fixture tools | A5 |

### 5.3 ITSM change management (Jira and ServiceNow)

| Need | State today | What to build | Card |
|---|---|---|---|
| Outbound create, attach, status | Done (F7) | Keep; add a base-URL seam for ServiceNow (F8) | B4 |
| Outbound update (comment, transition) | Missing | Add `update` operation | C3 |
| Inbound webhook | Missing (F10) | Route that verifies an HMAC signature over the raw body with a timestamp window, and rejects replays by event id | C4 |
| Idempotency keys | Missing (F8) | Caller key stored with the result; a retry returns the first ticket | C3 |
| Status sync | Missing (F10) | Poll fallback plus webhook; one state machine mapping provider statuses to `requested`, `approved`, `applied`, `rejected` | C4 |
| Approval gating before apply | Simulation only (F6) | Apply checks the bound ticket state | C3 |
| Ticket-to-change binding | Missing | Store `ticketRef` on the change; reject apply without it in prod | C3 |
| Least-privilege service accounts | Single credentials per provider | One account per environment with create and read only; documented in the stub contract | B4, owner D3 |
| OAuth2 client credentials or mTLS | Basic and bearer only (F8) | Token client behind an interface; the mock ITSM issues test tokens | C6 |
| Secret handling | Env variables; redacted logs (F9) | Keep; add a no-secret-in-log test on the new paths | C3 |
| Retries, backoff, timeouts | None on outbound calls (F8) | Reuse backoff helper (F20); timeout on every call; retry only safe operations | B4 |
| Rate limits | 1,000 per minute per tenant (F20) | Add a per-provider outbound limit | C3 |
| Audit trail | Not for tickets | Record request, ticket, approval and apply linkage | C5 |
| SSRF and injection defense | Done for refs (F9) | Keep. Add: ServiceNow instance host must be on an allowlist, and outbound URLs may not target private ranges unless the mock flag is set | B4 |

## 6. Difficulty assessment

Effort is for one experienced engineer working with agents, in person-days,
and is an estimate, not a measurement. S is 1 to 3 days, M is 4 to 8, L is 9
to 15. The total at the end is the sum of the ranges.

| Component | Size | Days | Main risk | Easy or hard |
|---|---|---|---|---|
| Permission matrix and `authorize()` as data | S | 2-3 | Getting owner agreement on the matrix | Easy once D2 is decided |
| Mock IdP and token verifier (signed JWTs) | S | 2-3 | Subtle claim-validation gaps (`aud`, `exp`, algorithm confusion) | Easy to write, easy to get slightly wrong |
| Shared dataset and persona-accuracy tests | M | 4-6 | Oracle design so tests do not recompute the code under test | Moderate |
| Gateway retrofit: principal in context, legacy wrapper | M | 4-7 | Touches every gated route and the existing gateway tests; regressions | Hard part 1: retrofit across routes |
| Scope filtering on seven open routes and the page data | L | 9-14 | Aggregates computed before filtering leak totals; client store holds all data today | Hard part 1 continued |
| Route-level matrix test and Playwright persona spec | M | 4-7 | Playwright runs against a production build and is slow (see `playwright.simulation.config.ts`) | Moderate |
| Mock Jira and mock ServiceNow stubs | M | 4-6 | Wire contract drift from the real products; keep to the subset the adapters use | Moderate |
| ServiceNow base-URL seam and outbound hardening (timeout, retry, host allowlist) | S | 2-4 | Retrying non-idempotent create causes duplicate tickets | Easy if idempotency lands first |
| Idempotency, approval gating, ticket binding | M | 4-7 | State machine edge cases (apply before approve, double approve) | Moderate |
| Inbound webhook with HMAC, timestamp window, replay store | M | 4-6 | Raw-body handling in Next.js, constant-time compare, clock skew; replay store is in memory in the mock | Hard part 2: webhook trust |
| Two-way status sync (poll plus webhook) | L | 8-12 | Out-of-order events, provider status vocabularies, loops when Ratio's own update triggers an event | Hard part 3 |
| Generic MCP client, allowlist, env and team scoping | M | 5-8 | Transport framing is unvalidated against a real server (F12); tool schemas drift | Moderate |
| Mock MCP server with fixture tools | S | 2-3 | Fixture realism | Easy |
| OAuth2 client credentials / mTLS client behind an interface | M | 4-6 | Only provable against a real tenant; mock proves the shape only | Moderate, partly deferred |
| Three synthetic cloud sandbox sources | M | 4-6 | Ingestion and financial-semantics review; must not disturb the existing three | Moderate |
| Demo fixes (five items) | S | 2-3 | Low | Easy |
| Audit records across decisions | S | 2-4 | Volume and secret leakage | Easy |

Sum of the ranges in the table: 66 to 105 person-days (17 rows; low ends sum
to 66, high ends to 105). Parallel agents shorten calendar time because Sprint A
cards run side by side, but the person-day total is what review capacity must
absorb.

What is hard and why:

- **Identity and roles retrofit.** The gateway hands every handler a tenant
  string only (`withGateway.ts:22-25`). Seven routes have no check (F3), and the
  UI loads all workloads into one client store, so scoping must also change the
  data that reaches the page, not just the API. Every route, its tests, and the
  persona switcher change.
- **Webhook trust.** An inbound endpoint is an open door by design. It needs
  signature verification over the exact bytes received, a freshness window, a
  replay store, and a fail-closed default. In production the replay store must
  be shared across instances (owner decision D8).
- **Two-way status sync.** Two systems each believe they own the state. Without
  one explicit state machine and idempotent handlers, events loop or arrive out
  of order.

What is easy: the permission table and decision function, the mock IdP, fixture
MCP tools, the demo fixes, the ServiceNow base-URL seam, and reusing the
existing ref grammars and redaction.

Everything past the mock environment needs credentials or infrastructure and is
an owner decision (section 8). None of it is planned or started here.

## 7. Mock-demo environment scope

All mocks are local, deterministic, and need no network beyond the loopback
interface. They live in new directories so their cards stay file-disjoint.

| Mock | What it implements | Used to prove |
|---|---|---|
| Mock Jira | `POST /rest/api/2/issue`, `GET /rest/api/2/issue/{key}` with `fields.status.name` and `fields.updated`; bearer check; issue keys that satisfy `JIRA_ISSUE_KEY`; a controllable status transition; failure injection (401, 429, 500, slow) | Real `JiraAdapter` create, attach and status end to end |
| Mock ServiceNow ITSM | `POST /api/now/table/change_request` returning `{result:{number}}`; `GET` with `sysparm_query=number=...`, `sysparm_fields`, `sysparm_limit`; Basic auth check; numbers that satisfy `SERVICENOW_NUMBER`; state transitions; failure injection | Real `ServiceNowAdapter` end to end, after the base-URL seam (F8) |
| Mock identity provider | Issues signed test JWTs with `role`, `teams`, `envs`, `tenant`, `aud`, `jti`, `exp`; revocation list; key rotation for a test | RBAC enforcement, negative paths, role change |
| Mock MCP server | JSON-RPC `initialize`, `tools/list`, `tools/call`; fixture tools (portfolio summary, cost by team, ticket status, a deliberately write-capable tool to prove it is blocked) | MCP client, allowlist, environment and team scoping |
| Three synthetic cloud sandbox sources | `aws-sandbox`, `azure-sandbox`, `gcp-sandbox` (owner-approved; card A6) | The per-provider story in the demo, with the existing three untouched |

Demo fixes in scope (F19), each its own small change in cards A7 and A8:
`formatUSD` negative sign, favicon, hide the dead simulation link when the
simulation is disabled, a source-correct findings header (including
ServiceNow), and `/demo` prompts that the mock Frank actually answers.

Not in scope: any live model call, any real Jira or ServiceNow tenant, any
real identity provider, any production deployment, and any migration.

## 8. Owner decisions (listed, not made, not started)

| # | Decision | Why it cannot be done in the mock |
|---|---|---|
| D1 | Choose the real identity provider and protocol (OIDC or SAML); register an app; supply issuer, audience and key-set location | Needs a tenant and real credentials |
| D2 | Ratify the permission matrices in 4.4 and 4.5, including who approves in prod | Policy, not code |
| D3 | Provision real Jira and ServiceNow service accounts with least privilege, per environment | Needs real tenants and credentials |
| D4 | Choose the ITSM integration mode: OAuth2 client credentials, mTLS, or both; supply client ids and certificates | Needs real credentials |
| D5 | Stand up a public HTTPS endpoint for inbound webhooks and share the signing secret with Jira and ServiceNow | Needs production-like infrastructure |
| D6 | Decide whether any MCP tool that writes is ever allowed, and for which role and environment | Risk acceptance |
| D7 | Choose the real MCP servers and the credentials per team and environment; settle the Frank MCP proposal | Needs credentials and the separate proposal |
| D8 | Choose a shared store for rate limits, the webhook replay set, token revocation and audit records in production | Needs infrastructure; migrations are also blocked by issue #94 |
| D9 | Set the retirement date for the shared `RATIO_API_TOKEN` | Operational timing |
| D10 | Decide the real tenant model (one tenant UUID versus the token hash, F15) | Data model |
| D11 | Decide whether the real environments are named dev, test and prod, and how they map to workload environments `prod`, `staging`, `dev`, `sandbox` (F16) | Naming and mapping policy |
| D12 | Approve spend, if any, for a hosted sandbox tenant of any of the above | Spend |

## 9. Risks and open questions

- **Matrix churn.** If D2 changes after cards land, the table-driven design
  confines the change to one data file and its generated tests.
- **Gateway retrofit conflicts.** B1, B2 and B3 all touch gateway-adjacent
  files. They are ordered, not parallel (TASKS.md).
- **Governance load.** Most auth, ingestion and route cards are restricted
  classes and need the full reviewer path; none is eligible for auto-merge.
- **Mock fidelity.** A mock proves the adapter against the subset of the wire
  contract we encode. It does not prove the real product behaves the same. The
  first real-tenant run (D3) is where drift shows up.
- **Issue #94.** Anything needing storage beyond memory (replay set,
  revocation, audit) is in memory in the mock and flagged for D8.
