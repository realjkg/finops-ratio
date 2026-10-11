# Sprint plan: mock-demo environment, MCP-connected access, and role-based access

Status: the current plan, one text (earlier revisions are in git history, not
repeated here). It rides with the first open code PR under it (A8), per the
owner's rule of no docs-only PRs. Sprint A progress and the next slices are in
[TASKS.md, "Status and next slices"](./TASKS.md#status-and-next-slices). The
Frank design (`docs/design/frank-mcp`) keeps being revised, so it is cited by
section, never by revision.
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
rules) are promoted to `.obvious/obvious.md` by card C7, the only card that
owns that file, and this directory is then removed, following the promotion
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
   credentials. The Frank MCP design (`docs/design/frank-mcp`, now on main) is
   referenced, not duplicated; section 5a states how the two fit.
3. **Do authentication and roles exist for the views and for change management
   through ServiceNow and Jira, with automated ticketing?** Partly, and not in
   the form the question needs.
   - Authentication exists as one shared bearer token. It carries no user
     identity and no role (F1, F2).
   - Roles exist only inside the dev/test customer simulation, as three
     fixture personas with server-side checks (F5, F6).
   - The page views have no server-side access control at all. Persona is a
     browser setting (F4). Seven API route files have no authentication check (F3).
   - Outbound ticketing exists: create, attach and status lookup for Jira and
     ServiceNow behind `POST /api/v1/cm/change` (F7). It is not automated: a
     caller must invoke it, nothing links a ticket to an approval or an apply,
     and nothing listens for ticket changes (F9, F10).
4. **Agents run these capabilities through sprint tasks, iteratively and in
   parallel.** TASKS.md defines self-contained cards (sprint names: A; A2 for cards B1 to B12, IDs kept; C for the portal UI, cards C1, C2, C5; D for the ITSM change lifecycle, cards C3, C4, C6, C8, C7 last; Sprint B is reserved for the live connectors for ingest, drafted with its first code slice). Sprint A contains cards
   with disjoint file sets that can all run at once; each card has named red
   tests and a governance class. The runbook there tells an implementer agent
   how to take a card without conflicting with the others.

How hard is it to build with security-enabled APIs? Moderate overall, and hard
in three specific places. See section 6: roughly 114 to 175 person-days for the
whole mock-environment scope (the sum of the table there), of which the
identity-and-roles retrofit across existing routes, webhook trust and the
two-way ticket status sync carry most of the risk.

## 2. Current-state facts (verified on main)

Every row was checked against `origin/main` at `62bd8ed` (F21 and F22 at
`8caec87`, which differs only by documentation). Where merged Sprint A code
has since changed a fact, the row says so. EVIDENCE.md lists the
command behind each. A lead from the owner's brief that turned out to be wrong
or incomplete is marked "corrected".

| # | Fact | Where |
|---|---|---|
| F1 | One shared bearer token. `resolveGatewayAuth` turns enforcement on when `RATIO_API_TOKEN` is set, or when a live AI provider or a live change-management provider (`jira`, `servicenow`) is selected. With no token and the mock provider, enforcement is off and every caller is `anonymous`. | `src/server/gateway/auth.ts:36-43`, `:88` |
| F2 | The tenant is a non-reversible hash of the token (djb2 to base36), used for rate limiting and logs. There is no user identity and no role. Token comparison is constant time (`tokensMatch`). | `src/server/gateway/auth.ts:55-61`, `:69` |
| F3 | Seven API route files have no authentication check: `attribution`, `tokenomics`, `prediction/predict`, `prediction/accuracy`, `report/snapshot`, `costsource/ingest` and `hello`. Five serve seeded data (`attribution`, `tokenomics`, `prediction/predict`, `prediction/accuracy`, `report/snapshot`); `hello` is a liveness route; `costsource/ingest` is a stateless POST that normalizes rows the caller supplies. They use only `withInternalErrorGuard`. Two more (`a2a/handshake`, `finio/export`) re-export their `v1` gateway-wrapped versions. | `pages/api/attribution.ts`, `pages/api/tokenomics.ts`, `pages/api/prediction/*.ts`, `pages/api/report/snapshot.ts`, `pages/api/costsource/ingest.ts`, `pages/api/hello.ts` |
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
| F14 | Live-data gate: sandbox source ids are served anonymously; every other id needs a strong `RATIO_API_TOKEN` (32 or more characters, 10 or more distinct). Failed attempts are counted per client IP. At `62bd8ed` three sandbox ids existed: `pointfive-sandbox`, `focus-file-sandbox`, `servicenow-sandbox`; A6 (#108) added `aws-sandbox`, `azure-sandbox` and `gcp-sandbox`, so six exist now. | `src/costsource/sandboxSources.ts:5-9`; `src/server/gateway/liveDataAuth.ts:60`, `:123` |
| F15 | A second tenant concept exists. The published-costs route binds a token to a tenant UUID through `RATIO_API_TENANT_ID`; the gateway derives its own hash tenant. They are not connected. | `src/server/costs/config.ts:5`, `:19` |
| F16 | Workloads carry `team` and `environment` fields (`prod`, `staging`, `dev`, `sandbox`), which are the natural scoping keys. The seeded set has 11 workloads, 7 teams, and environments dev 1, staging 2, prod 8. | `src/types/index.ts:13`, `:128-129`; `src/data/workloads.ts` |
| F17 | Governance classifier: path-based. `src/server/gateway/**` and any `src/` or `pages/api/` path matching `auth\|tenant\|rls\|role` are `auth_tenancy`; `src/costsource/**` and focus, normalize, reconcile names are `financial_semantics`; `pages/**` is `routes`; a path in no rule is `unclassified` and restricted (fail closed). Docs under `docs/**` with `.md` are low. | `scripts/governance/risk-rules.json` |
| F18 | Migration numbering is unresolved: `0001`, `0002`, `0004` exist; `0003` and `0005` are reserved by comments elsewhere; issue #94 tracks it (see EVIDENCE.md for what could and could not be verified). Cards in this plan add no migrations. | `src/ingest/db/migrations/`; `docs/design/slice-3-5/DESIGN.md:561` |
| F19 | Demo defects confirmed. (a) `formatUSD(-5)` returns `$-5.00` and `formatUSD(-1500)` returns `$-1,500`. (b) No favicon: no `public/` directory and no icon link in the document head. (c) The "Customer sign-in simulation" link renders whenever no simulation session exists, even when the simulation is disabled and the route would return 404. (d) The findings card is titled "(PointFive DeepWaste shape)" for every source, including ServiceNow. (e) At `62bd8ed`, two of the three `/demo` prompts fell through to the mock Frank help reply. PR #99 then rewrote the mock Frank (`src/ai/mock/*`); A8's re-check on `7a9da43` found one failing prompt (the third, which got the "cannot answer" reply, not help). Status: (a) and (b) fixed by A7 (#109, `a3c1437`); (c), (d) and (e) fixed by A8 (#110). | At `62bd8ed`: `src/lib/format.ts:4-12`; `pages/_document.tsx:8`; `src/simulation/SimulationBar.tsx:22`; `src/costsource/CostSourcePage.tsx:603`; `pages/demo.tsx:9-13`; `src/ai/MockAIClient.ts:18-25` (that classifier is now `src/ai/mock/intents.ts`) |
| F20 | Existing building blocks to reuse: bounded backoff with jitter and a transient-error classifier (ingest worker), a sliding-window rate limiter, a redacting error logger, and Playwright simulation specs. | `src/ingest/retry.ts:8-9`; `src/server/gateway/rateLimit.ts:20`; `tests/simulation/*.spec.ts` |
| F21 | A cost row whose `ResourceId` does not start with `arn:ratio:workload/` normalizes with an empty `x_RatioWorkloadId`, an empty team and value 0 ("unknown, not hidden"). `MockCostSourceClient` returns the all-workload rows for any source id it does not dispatch specially, and `SourceKind` had no synthetic-cloud member (A6, #108, added `synthetic_cloud`). | `src/costsource/normalize.ts:46-58`; `src/costsource/MockCostSourceClient.ts:41-83`, `:95-120`; `src/costsource/seed.ts:189`; `src/costsource/CostSourceClient.ts:21` |
| F22 | The browser store is initialized with the whole bundled seed (`workloads: WORKLOADS`) and `clearSimulation` resets to it, and the pages and components listed in EVIDENCE.md read `workloads` from it. So the data reaches every viewer's browser regardless of the API checks; scoping the views requires the store to load from a scoped endpoint when enforcement is on. | `src/store/useStore.ts:23`, `:155`, `:270`; grep of `.workloads` under `src` and `pages` (EVIDENCE.md) |

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

**Roles and lenses.** The browser has three lenses (`executive`, `technical`,
`procurement`, F4) and the server six roles. A lens changes presentation only;
data scope always comes from the principal. Allowed lenses, default first:

| Role | Allowed lenses |
|---|---|
| `cto` | executive, technical |
| `finops_lead` | executive, technical, procurement |
| `finance` | executive, procurement |
| `eng_lead` | technical |
| `procurement` | procurement |
| `auditor` | executive, technical, procurement |

### 4.2 The contract between cards

Every card builds against this contract so the cards stay independent. It is
**merged** as card A1 (#103, `0e097a2`; `src/identity/types.ts`,
`src/rbac/`), and the merged code is the reference. The block below is the
merged `Action`, `ChangeImpact` and `Resource` shape.

```ts
export type Role = 'cto' | 'finops_lead' | 'finance' | 'eng_lead' | 'procurement' | 'auditor'
  | 'legacy_service';          // internal: the shared RATIO_API_TOKEN principal; not a persona
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

export type Action =
  | 'view.read' | 'view.export'
  | 'change.request' | 'change.approve' | 'change.apply'
  | 'ticket.create' | 'ticket.attach' | 'ticket.status' | 'ticket.bind' | 'ticket.update' | 'ticket.get'
  | 'mcp.read' | 'mcp.write'
  | 'budget.edit' | 'connector.manage' | 'ingest.write' | 'audit.read';

export type TicketState = 'none' | 'open' | 'approved' | 'rejected';
export type ChangeImpact = 'cost' | 'commitment' | 'operational';  // set server-side, never from a request body

export interface Resource {
  kind: 'view' | 'route' | 'change' | 'ticket' | 'mcp_tool' | 'audit';
  id: string;                  // view or route id from the matrix, change id, or tool name
  team?: string;               // owning team of the data or change
  env?: DeployEnv;             // already mapped (see the table below)
  requesterSub?: string;       // change only: who requested it
  approverSub?: string;        // change only: who approved it, if anyone
  ticketState?: TicketState;   // change only: the live state of the bound ticket
  impact?: ChangeImpact;       // change only: the impact class stored on the change at request time
}

export type Verdict =
  | { allow: true }
  | { allow: false; status: 401 | 403 | 409; reason: string };  // fixed text, never echoes input

export interface TokenVerifier {
  verify(bearer: string, ctx: { now: number; deployEnv: DeployEnv }): Promise<Principal>;  // throws on any failure
}
```

`ticket.get` is the read of a change record and its ticket (`get` in card
C3); `ticket.bind` decides binding an existing, pre-approved ticket to a
change (`request` with `existingTicketRef` in C3). `Resource.impact` is **never** chosen by the requester or read from the approval
request: card C3 derives it on the server from the requested `action` through a
fixed map (the requester cannot mark a commitment purchase as `cost`), stores
it on the change record, and the approver cannot alter it. `authorize(principal, action, resource)` is pure. It returns 401 for no
principal, 403 for a role, team or environment the grant does not cover, and
409 only for a state conflict on a change (on an "A" cell: no `approverSub`
yet gives 409 "Change is not approved", and a ticket that is not approved gives
409 "Ticket is not approved"). The "A" cells of section 4.5 are therefore a pure verdict over
`Resource.requesterSub`, `approverSub` and `ticketState`; the caller (card C3)
fills those fields from its change store and the live ticket status.

**Environment vocabulary.** Three vocabularies exist today and do not match:
the deployment environment the process runs in (`RATIO_ENV`: `development`,
`test`, `staging`, `production`, in `src/ingest/config.ts:11`; the simulation
only checks `development` and `test`, F5), the data's environment on each
workload (`prod`, `staging`, `dev`, `sandbox`, F16), and the new
`DeployEnv` (`dev`, `test`, `prod`). The interim mapping below is implemented
once, in `src/identity/envMap.ts` (card A1), and is replaced by owner decision
D11 if the owner chooses other names.

| Source value | `DeployEnv` |
|---|---|
| `RATIO_ENV` = `development` | `dev` |
| `RATIO_ENV` = `test` or `staging` | `test` |
| `RATIO_ENV` = `production` | `prod` |
| Workload `environment` = `dev` or `sandbox` | `dev` |
| Workload `environment` = `staging` | `test` |
| Workload `environment` = `prod` | `prod` |
| Anything else or unset | no mapping: fail closed (deny) |

The deployment's own `DeployEnv` (the value a token's `aud` must equal) is
derived from `RATIO_ENV` by that function. The mock IdP refuses to run when
`RATIO_ENV` is `production` (card A2). `RATIO_RBAC=enforce` switches
verification on; unset, the offline default of F1 is unchanged.

Mock-IdP token claims (card A2): `iss`, `aud` (the deployment environment),
`sub`, `iat`, `exp`, `jti`, plus `role`, `teams`, `envs`, `tenant`. A real OIDC
provider would supply the same claims through its own mapping; that swap is
owner decision D1 and is not done here. The `legacy_service` role is **fail-closed**: its grant is exactly
today's shared-token access, nothing more. Merged A1 encodes it as the
`legacyService` column of `ROUTE_MATRIX` and the `legacy_service` cells of
`ACTION_MATRIX`: `view.read` (and `view.export`, which is checked against the
same route rows) on the 11 API routes that call the gateway or the live-data
gate today (`/api/v1/connectors`, `/api/costsource/{sources,rows,findings,health}`,
`/api/v1/ai/chat`, `/api/v1/finio/export` and `/api/finio/export`,
`/api/v1/costs/published`, `/api/v1/a2a/handshake` and `/api/a2a/handshake`),
plus `ticket.create`, `ticket.attach` and `ticket.status` on `/api/v1/cm/change`.
Everything else is denied for it (`change.*`, `ticket.bind`, `ticket.update`,
`ticket.get`, `ingest.write`, `connector.manage`, `budget.edit`, `mcp.*`,
`audit.read`, every page, and the six routes that are anonymous in the offline
default). The test `legacy_service_column_grants_exactly_todays_gateway_access`
derives the route list from the source and pins it. It is flagged
in logs and its retirement is D9. Per-user `Principal.sub` is deferred
for the real system in `docs/design/slice-3-5/DESIGN.md` (D-15); this sprint
introduces it for the mock IdP only, so the shape is proven without a real
identity source.

### 4.3 Where today's shared token must be replaced or wrapped

| Today | Change | Card |
|---|---|---|
| `checkAuth` returns `{ok, tenant}` for one shared token (`auth.ts:84-112`) | Wrap: a new `authenticate()` tries the `TokenVerifier` first, then falls back to the legacy token and yields a `legacy-shared-token` principal with a fixed, narrow role grant | B1 |
| `withGateway` step 3 calls `checkAuth` and passes only `{tenant}` to handlers (`withGateway.ts:163-170`, `:194`) | Replace the context with `{principal}` and keep `tenant` as a derived field so existing handlers compile; add the `requires` option (a route declares its action and resource in one place), `withRbac` (authentication and authorization only, for routes that keep their own method guard and envelope), and the verdict helper `decide()` plus a fail-closed verdict sink with a default in-memory sink in enforce mode | B1 |
| `evaluateLiveDataAuth` and `gateSourceAccess` compare against `RATIO_API_TOKEN` (`liveDataAuth.ts:141-162`) | Wrap: accept a verified principal with a data-read grant; the failed-attempt accounting stays | B2 |
| Seven unauthenticated route files (F3) | Six get authentication, `requires` (through `withRbac`, so their 405 envelopes and absence of rate limiting do not change) and the scope; `hello` stays an explicit public liveness route | B3 |
| `v1/ai/chat`, `v1/finio/export`, `v1/a2a/handshake`, `v1/costs/published` are gateway-wrapped but have no per-role check | Add `requires` and scope; chat builds its context from the caller's scope on the server | B9 |
| `cm/change` has no per-role check | Add the lifecycle operations and `requires` | C3 |
| The browser has no way to obtain or send a credential, and the store holds the whole seed (F11, F22) | Cookie session, principal endpoint, scoped workloads endpoint, credentials on every `Live*Client` | B7 |
| The models read the seeded dataset directly | One data-provider seam that takes a scope | B8 |
| Persona in `localStorage` (F4) | Derive the active persona from the verified principal; the switcher becomes a lens over what the role already allows | C2 |
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
| Prediction `/prediction` and `/api/prediction/predict` (per-workload, scoped) | O | D | - | T | - | D |
| Prediction accuracy `/api/prediction/accuracy` (org-level aggregate, not scopable) | O | D | - | - | - | D |
| Tokenomics `/tokenomics`; `/api/tokenomics` (org-level aggregate, not scopable) | O | D | D | - | O | D |
| Frameworks `/frameworks` | R | R | R | R | R | R |
| Reports `/reports`; `/api/report/snapshot` (export carries the caller's scope) | O | D | D | T | O | D |
| FinOps export `/finio`; `/api/v1/finio/export` | - | D | D | - | - | D |
| Outcomes and executive dashboard `/outcomes`, `/mission` | O | D | O | T | O | D |
| Frank `/agent-workflows`; `/api/v1/ai/chat` (context is built on the server from the caller's scope only) | O | D | O | T | O | D |
| Demo pages `/demo`, `/hello`, `/finio/demo` (fixture data only; marked `public` in the matrix) | R | R | R | R | R | R |
| Published costs `/api/v1/costs/published`; A2A handshake `/api/v1/a2a/handshake` | - | D | D | - | - | D |
| Change management `/api/v1/cm/change` | see 4.5 | see 4.5 | see 4.5 | see 4.5 | see 4.5 | see 4.5 |
| Audit log (new page `/audit`; `/api/v1/audit/records`) | O | D | - | T | - | D |
| Scoped data endpoint (new) `/api/v1/workloads` (workloads, budgets, alerts for the caller's scope) | O | D | D | T | O | D |
| Session endpoints (new) `/api/v1/session/principal`, `/logout`: any authenticated principal; `/login` and `/mock-control`: `public_mock` (mock IdP only, 404 elsewhere); page `/sign-in`: `public` | any | any | any | any | any | any |
| Status sync (new, plannedBy C8) `/api/v1/cm/sync`: status `enforced`, action `ticket.update` per section 4.5 | - | Y | - | Y* | - | - |
| Webhook (new) `/api/v1/cm/webhook`: status `signed` (HMAC signature and replay check instead of a bearer; no role) | - | - | - | - | - | - |
| Customer simulation `/simulation`, `/workspace`, `/api/v1/simulation/*` | dev and test only | dev and test only | dev and test only | dev and test only | dev and test only | dev and test only |

**What O and D mean in data.** The scoped data endpoint serves each role the
most detailed shape that role may see anywhere in section 4.4: `rollup` for
`cto` and `procurement` (their codes never exceed O) and `drilldown` for the
other four. A roll-up is a **separate response DTO**, not a trimmed record. Its
workload entries have exactly these fields (the named aggregates are listed
after them): `id`, `name`, `model_provider`,
`team`, `environment`, `demand_shape`, `priority`, `cost_trend_pct`,
`monthly_spend`, `monthly_budget`, `recorded_mtd`, `total_value`,
`value_ratio` and the four governance gate booleans; its budget entries have
`workload_id`, `period`, `budget_amount` and the three threshold percentages;
its alert entries have `id`, `workload_id`, `type`, `severity` and
`acknowledged`; and it carries one precomputed month-end forecast summary per
workload and the **named aggregates** below, computed on the server by the
existing pure functions over the full scoped records, so no page that the matrix
gives O needs a line-level field. It contains none of these line-level names anywhere in the JSON:
`model`, `daily_spend`, `daily_budget`, `compute`, `inference_cost_per_call`,
every `tokens_*` counter, every unit-cost member (`cost_per_call` and its
siblings), `outputs` and its members, `revenue_protected`, `cost_avoided`,
`harm_from_misses`, `quality_floor_pass_rate`, `evidence`, `approved_by`,
`last_reviewed`, `created_at`, `updated_at`, `daily_spend_history`,
`daily_allocation`, `forecast_method`, the breach-action fields, `budgets[].id`,
and the alert members `message`, `threshold_value`, `actual_value`,
`triggered_at`, `acknowledged_by`, `action_taken` and `channel`. Cost lines and per-user rows are
separate routes that roll-up roles get only aggregated (cards B2 and B3). The
store keeps these figures in the roll-up shape; B11's `hydrateScoped` calls
`rehydrateRollup()` (a client adapter that fills the omitted members of the
existing record types with neutral placeholders so unchanged components still
compile) and registers the named aggregates in a small registry that the
readers consult first. The placeholders are not data and never leave the
browser. The drill-down surfaces show "not available for your role" (card B10). The CTO view is therefore accurate and
distinct from the FinOps lead view by data, not only by lens (card B8 defines
the shape and makes the budget-status code roll-up-safe; B7 serves it; the
shape is chosen from the role, never by a request parameter). For `finops_lead`,
`finance`, `eng_lead` and `auditor` an O cell on a page is presentational: a
summary of data they may see in full. Tokenomics and prediction accuracy return
org-level aggregates with no team dimension, so a team-scoped role cannot be
given a figure that excludes other teams (section 4.7, item 4): the `eng_lead`
cells should be `-` (403) until those aggregates are computed from filtered
records. **Open, before B3 starts:** merged A1 (`src/rbac/matrix.ts`) differs
from this table in exactly two cells, both `T` instead of `-` for `eng_lead`:
the `tokenomics` group (its own group, covering `/tokenomics` and
`/api/tokenomics`) and `/api/prediction/accuracy`, which shares the
`prediction` group with `/prediction` and `/api/prediction/predict`. B3
resolves it with the owner (D2): either compute both aggregates after the scope
filter, or edit A1's data. That edit is a one-cell change for `tokenomics`,
but accuracy needs a **new group** (a new `GROUP_CODES` key, which extends
`ViewGroupId`, and the accuracy route row repointed to it) plus the matrix
test, so `src/rbac/matrix.ts` and `src/rbac/matrix.test.ts` join B3's files,
sequenced after A1 and before C3.

Reconciliation rule (tested in 4.7): for any single underlying dataset, the
CTO roll-up total equals the FinOps lead drill-down total, equals the sum of
every Eng lead's team-scoped total across all teams, and equals the Finance
total. Money is summed in integer cents: each dollar value is converted once at the
leaf (`Math.round(dollars * 100)`) and totals are formatted from cents (card
B8; the display fix in card A7 is separate). The seeded data is in float
dollars (F16), so the oracle for served data is committed in card B8.

### 4.4a Roll-up pages: what each reads and where the figure comes from

The roll-up roles (`cto`, `procurement`) must see the same portfolio-level
numbers as the FinOps lead on every page the matrix gives them. Each named
aggregate is a **minimized DTO of approved presentation values**, never the
raw return object of a pure function (those objects carry the line-level
inputs: `deriveCacheEconomics` in `src/lib/derive.ts` returns the raw
`cachedTokens` and `uncachedInputTokens` counters and both per-1M unit rates,
and `estimateTca` in `src/outcomes/model.ts` returns an infrastructure line
equal to `compute` x 30). Per workload the DTO adds exactly: `fuel_ratio`
(daily spend over daily budget, the ratio only); `cache_summary`
`{hit_rate, cache_discount_daily}`; `tca` `{full_cost_cents,
headline_spend_cents, full_cost_ratio, implementation_cents, oversight_cents,
labor_cents}` (the three estimated categories are fixed rates of monthly spend;
the model-usage versus infrastructure split is omitted because it reveals
`compute`); `gross_value` and `value_evidence_headline` (the readers in
`valueMath.ts` and `valueEvidence.ts`); and `forecast_summary`. At portfolio
level it adds `portfolio_ratio` (`derivePortfolioRatio`), `monthly_spend_total`
and `total_value_total`. Tests (card B8): each aggregate has exactly its listed
keys, and no number in a roll-up response equals a token counter, a unit rate
or a `compute`-derived amount of the scoped records (the fixture is chosen so
no approved value coincides with one).

| O page | Line-level inputs it reads today | Roll-up source | Consumer change (card) |
|---|---|---|---|
| Findings `/` | token counters (cache economics in `src/lib/derive.ts`), value ratio, spend | `cache_summary` (hit rate and daily discount; the token-and-rate evidence line shows "not available for your role"), `portfolio_ratio` | `derive.ts` reader (B12); `findingsModel.ts` scope parameter (B8) |
| Overview `/overview` | monthly spend, value, budget series | whitelist fields and `forecast_summary` | none beyond the B8 registry |
| Workloads `/workloads` | `model` (WorkloadCard), unit costs | `model_provider` label only; detail panel unavailable | `WorkloadCard.tsx` (B12); `DetailPanel.tsx` (B10) |
| Mission `/mission` | daily spend and daily budget (fuel gauge), `model` | `fuel_ratio`, `forecast_summary`, provider label | `missionModel.ts` (B12; scope parameter B8) |
| Outcomes `/outcomes` | `costs.compute`, revenue and cost-avoided inputs, evidence marks | `tca` (headline spend as one row, no model-usage versus infrastructure split), `gross_value`, `value_evidence_headline` | `outcomes/model.ts`, `valueMath.ts`, `valueEvidence.ts` readers (B12) |
| Prediction `/prediction` | model, token counters, daily spend (predictors) | the page calls `/api/prediction/predict`, which computes on the server from the full scoped records | `PredictionPage.tsx` (B10) |
| Attribution `/attribution` (team) | token counters | `/api/attribution` team aggregates from the server | `AttributionPage.tsx`, `LiveAccrualBoard.tsx` (B10) |
| Reports `/reports` | all | `/api/report/snapshot` built on the server for the caller's scope and shape | none (B3) |
| Frank `/agent-workflows` | all | chat context built on the server (B9) | none |

Test, in B12 and again end to end in C1: for each O page the roll-up page
figures equal the FinOps lead's figures for the same portfolio-level numbers.

### 4.5 Permission matrix: persona by action, per environment

Cell format: `dev / test / prod`. Y = allowed, n = denied, Y* = allowed only
for the principal's own teams, A = allowed only after the bound ticket is in an
approved state and the approver is a different principal from the requester.
Proposed; owner ratifies (D2).

| Action | CTO | FinOps lead | Finance | Eng lead | Procurement | Auditor |
|---|---|---|---|---|---|---|
| Request a change | n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n |
| Approve a change | Y / Y / Y | Y / Y / n (prod: needs CTO or Finance) | Y / Y / Y (only when the stored `impact` is `cost`) | n / n / n | Y / Y / Y (only when the stored `impact` is `commitment`) | n / n / n |
| Apply a change | n / n / n | n / n / n | n / n / n | Y* / Y* / A | n / n / n | n / n / n |
| Create a ticket (outbound) | n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n |
| Attach or bind a pre-approved ticket (`ticket.attach`, `ticket.bind`) | n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n |
| Update a ticket (comment, transition; `ticket.update`) | n / n / n | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | n / n / n |
| Read a change record and its ticket (`ticket.get`) | Y / Y / Y | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y | Y / Y / Y |
| Read ticket status | Y / Y / Y | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y | Y / Y / Y |
| MCP read-only tool call (allowlisted) | Y / Y / Y (summary tools) | Y / Y / Y | Y / Y / Y (cost tools) | Y* / Y* / Y* | Y / Y / Y (commitment tools) | Y / Y / Y |
| MCP tool that writes | n / n / n | n / n / n | n / n / n | n / n / n | n / n / n | n / n / n |
| Edit budgets and thresholds (**deferred**: threshold editing is a client-only store mutation, `src/store/useStore.ts:316-318`, with no server surface to enforce; the row documents intent and no card enforces it) | n / n / n | Y / Y / n | Y / Y / Y | n / n / n | Y / Y / Y | n / n / n |
| Manage connectors and sources | n / n / n | Y / Y / Y | n / n / n | n / n / n | n / n / n | n / n / n |
| Export a report snapshot (`view.export`; the export carries the caller's scope) | Y / Y / Y (roll-up) | Y / Y / Y | Y / Y / Y | Y* / Y* / Y* | Y / Y / Y (roll-up) | Y / Y / Y |
| Write ingested cost rows (`ingest.write`) | n / n / n | Y / Y / Y | n / n / n | n / n / n | n / n / n | n / n / n |
| Read the audit log | Y / Y / Y | Y / Y / Y | n / n / n | Y* / Y* / Y* | n / n / n | Y / Y / Y |

Rules that hold across the table:

- The "A" cell is a pure `authorize()` verdict over `Resource.ticketState`,
  `requesterSub` and `approverSub` (section 4.2): 403 when no ticket is bound
  in prod, 409 "Change is not approved" when there is no `approverSub`, 409
  "Ticket is not approved" when the ticket is not approved, and 403 when the
  approver is the requester.

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
request -> authenticate(bearer or ratio_session cookie)
             |-- TokenVerifier (MockIdpVerifier now; oidc later) -> Principal
             |-- legacy shared token                              -> Principal (narrow, flagged)
          -> authorize(principal, action, resource)               -> Verdict (pure, table-driven)
          -> scope filter (teams, envs) in the data-provider seam -> rows the caller may see
          -> handler
          -> decide() / verdict sink (fail closed)                 -> audit record (card C5)
```

Who owns what. Card A2 owns the issuer and a raw-claims verifier. It signs and
verifies test JWTs with a generated local key (EdDSA or ES256 through
`node:crypto`; no new dependency) and does not know about `Principal`. Card B1
owns `MockIdpVerifier`, the thin class that maps those claims onto `Principal`
and implements `TokenVerifier`. A real OIDC verifier would fetch the
provider's signing keys, validate `iss`, `aud`, `exp` and `nbf`, and map
provider claims onto `Principal`; that one class is the only code that changes
(D1).

### 4.7 Persona-accuracy and negative tests

All tests run offline against one fixture dataset (card A3) and mock-issued
tokens (card A2). Named red tests are listed per card in TASKS.md; the classes
are:

1. **Same data, right numbers per persona.** CTO roll-up, FinOps lead
   drill-down, Finance and each Eng lead are computed from one dataset; each
   persona's figures match a committed oracle (hand-checked constants, not
   recomputed by the code under test). Two oracles: the synthetic dataset in
   cards A3 (unit level), and the real seeded dataset the app serves in card B8
   (float dollars converted to cents once at the leaf).
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

### 4.8 Trace of one persona through the stack

1. **Sign in.** The browser opens `/sign-in` (or is redirected there with a
   `returnTo` path when a request returns 401). In the mock, the user picks a
   persona; `POST /api/v1/session/login` sets the HttpOnly session cookie and
   the readable CSRF cookie (card B7; page card B11). A real IdP replaces this
   step (D1).
2. **Principal.** `SessionProvider` (card B11) calls
   `GET /api/v1/session/principal`. With `RATIO_RBAC` unset it returns
   `{enforced:false}` and the offline seed stays (F1).
3. **Hydrate.** When enforced, the provider calls the store's `hydrateScoped()`,
   which fetches `/api/v1/workloads` and replaces workloads, budgets and alerts
   together with the caller's scope. Triggers: mount, login, logout, role-change
   refresh, and any 401 (all session-visible state reset; logout and 401 are a hard navigation). Before this, the store is empty under
   the enforce build flag, and the guard (step 4) waits for the store to be
   **hydrated**, so other teams' data never flashes whatever the build flag says.
   The simulation entry points that also reset the store (`clearSimulation`,
   `loadSimulation`, called from the global simulation provider) are made
   enforce-aware so they cannot restore the seed.
4. **Guard.** `ViewGuard` looks up the page's matrix row; a denied role sees a
   403 state, not the page. The lens defaults and options come from the
   role-to-lens table (section 4.1; card C2).
5. **Pages and exports.** Pages read the store; the four pages that import the
   seed directly are moved onto it (card B10). Export and API routes enforce the
   same matrix through `requires` and scope their data through the B8 provider.
6. **Actions.** Change operations call `decide()` with the stored requester,
   approver and ticket state (card C3); every gateway and change-lifecycle
   verdict reaches the audit sink (card C5) or the request is denied. MCP
   client decisions (card B5) use an injected callback and are outside that
   guarantee until the Frank M2 broker wires them.

## 5. Gap analysis

### 5.1 Role-based access control

| Need | State today | What to build | Card |
|---|---|---|---|
| Identity source | Shared token (F1); fixtures in simulation (F5) | `TokenVerifier` seam, mock IdP with signed JWTs, `Principal` | A1, A2, B1 |
| Roles | Three fixture personas (F5) | Six roles, table-driven | A1 |
| Permission matrix per view | None server-side (F4) | Data table plus `authorize()`; a browser session and a scoped workloads endpoint (F22) | A1, B3, B7, B9 |
| Permission matrix per action | Simulation only (F6) | Same table for real actions | A1, C3 |
| Per-environment scoping | `RATIO_ENV` gates the simulation only (F5) | `envs` claim, `aud` check | A2, B1 |
| Per-team scoping | `team` field exists on data (F16) | `teams` claim, scope filter before aggregation, through one data-provider seam | A3, B8, B3, B7 |
| Audit | Simulation audit entries (F6); gateway request log with hashed tenant (F2) | Audit record for every decision through the verdict sink and `decide()` helper (B1) and the sink implementation, read route and page (C5); no secrets | B1, C5 |

### 5.2 MCP-connected access

The Frank MCP design (`docs/design/frank-mcp`; see section 5a of this plan) owns the
Frank-specific design. This plan covers the platform pieces every MCP use
needs and defers to that design for Frank.

| Need | State today | What to build | Card |
|---|---|---|---|
| Generic client | PointFive-only scaffold (F12) | MCP client with `initialize`, `tools/list`, `tools/call` over HTTP | A5 (mock server), B5 (client) |
| Read-only first | No allowlist | Operator-managed allowlist **file** pinning server, tool name, description hash and schema hash; read-only comes from the allowlist, never from the server's annotation; unknown tools denied | B5 |
| Environment scoping | None | One allowlist file per deployment (dev, test, production), each reviewed separately, plus `environments[]` on entries; a dev deployment cannot read the production file or credentials | B5 |
| Per-role tool allowlist | None | `roles[]` on entries mapped from `Principal.role`, enforced with `authorize()` before any call | B5 |
| Per-team credentials | None | Credential reference per team and environment, resolved server-side, never returned | B5 |
| No secrets in logs | Redacting logger exists (F20) | Reuse it; add a test that scans logs for a planted secret | B5 |
| Fixture server for tests | None | Mock MCP server with fixture tools | A5 |

### 5.3 ITSM change management (Jira and ServiceNow)

| Need | State today | What to build | Card |
|---|---|---|---|
| Outbound create, attach, status | Done (F7) | Keep; add a base-URL seam for ServiceNow (F8) | B4 |
| Outbound update (comment, transition) | Missing | Add `update` operation (request, approve, apply, update and get operations are specified in card C3) | C3 |
| Inbound webhook | Missing (F10) | Route that verifies an HMAC signature over the raw body with a timestamp window, and rejects replays by event id | C4 |
| Idempotency keys | Missing (F8) | Caller key stored with the result; a retry returns the first ticket | C3 |
| Status sync | Missing (F10) | Poll fallback plus webhook; one state machine mapping provider statuses to `requested`, `approved`, `applied`, `rejected` | C8 |
| Approval gating before apply | Simulation only (F6) | Apply checks the bound ticket state | C3 |
| Ticket-to-change binding | Missing | Store `ticketRef` on the change; reject apply without it in prod | C3 |
| Least-privilege service accounts | Single credentials per provider | One account per environment with create and read only; documented in the stub contract | B4, owner D3 |
| OAuth2 client credentials or mTLS | Basic and bearer only (F8) | Token client behind an interface; the mock ITSM issues test tokens | C6 |
| Secret handling | Env variables; redacted logs (F9) | Keep; add a no-secret-in-log test on the new paths | C3 |
| Retries, backoff, timeouts | None on outbound calls (F8) | Reuse backoff helper (F20); timeout on every call; retry only safe operations | B4 |
| Rate limits | 1,000 per minute per tenant (F20) | Add a per-provider outbound limit | C3 |
| Audit trail | Not for tickets | Record request, ticket, approval and apply linkage | C5 |
| SSRF and injection defense | Done for refs (F9) | Keep. Add: outbound hosts must be on a host allowlist (`CM_ALLOWED_HOSTS`), so a self-hosted on-prem Jira stays possible; loopback stubs are allowed only with `RATIO_MOCK_ITSM=1` in development or test | B4 |

## 5a. Relation to docs/design/frank-mcp

`docs/design/frank-mcp/DESIGN.md` is the design for Frank's allowlisted,
read-only MCP. This plan does not restate it; cite it by section and read the
current file before starting B5 (card B5 in TASKS.md lists the exact rules it
implements). What this plan decides about it:

- **B5 is the client half of Frank's M2** (its section 9), limited to the A5
  mock server and HTTP only. Frank's M0, M1 and M3 stay in that design.
- **Allowlist** rules come from its section 3 (3.3 key table, 3.8 startup
  check, cases A18 to A21). B5 uses its reserved field names `environments[]`,
  `roles[]` and `teams[]`, mapped from `RATIO_ENV` (through the 4.2 map) and
  `Principal`; it invents no field.
- **Departures, recorded as follow-ups for that design:** plain `http` to
  loopback in the mock only (its 3.2 requires https); `on_secret: redact` is
  not implemented (a tool asking for it is denied); the A20 runtime cases
  (reload, kill switch, latch, lock) wait for the M2 broker.
- **Tracked items it raises:** T-2 (browser credential) is addressed for the
  mock path by B7, T-3 (server-built chat context) by B9, and T-7 (per-role,
  team and environment allowlists) for the mock path by B5. Real identity
  stays D1; an MCP SDK dependency is D13; vendor-hosted connectors stay
  rejected unless its OD-13 says otherwise.

## 6. Difficulty assessment

Effort is for one experienced engineer working with agents, in person-days,
and is an estimate, not a measurement. S is 1 to 3 days, M is 4 to 8, L is 9
to 15. The total at the end is the sum of the ranges.

| Component | Card | Size | Days | Main risk | Easy or hard |
|---|---|---|---|---|---|
| Permission matrix, environment mapping and `authorize()` as data | A1 | S | 2-3 | Getting owner agreement on the matrix and the interim environment mapping | Easy once D2 and D11 are decided |
| Mock IdP: issuer and raw-claims verifier (signed JWTs) | A2 | S | 2-3 | Subtle claim-validation gaps (`aud`, `exp`, algorithm confusion) | Easy to write, easy to get slightly wrong |
| Shared dataset and persona projections with oracle | A3 | M | 4-6 | Oracle design so tests do not recompute the code under test | Moderate |
| Mock Jira and mock ServiceNow stubs | A4 | M | 4-6 | Wire contract drift from the real products; keep to the subset the adapters use | Moderate |
| Mock MCP server with fixture tools (including a lying read-only hint) | A5 | S | 2-3 | Fixture realism | Easy |
| Three synthetic cloud sandbox sources (client dispatch, kind, mapping, chip) | A6 | M | 5-8 | Financial-semantics review; the mock client falls through to all-workload rows for unknown ids (F21); must not disturb the existing three | Moderate |
| Demo fixes: negative dollar sign and favicon | A7 | S | 1-2 | Low | Easy |
| Demo fixes: dead link, findings header, `/demo` prompts | A8 | S | 1-3 | Low | Easy |
| Gateway retrofit: principal in context, `requires`, verdict hook, cookie credential, legacy wrapper | B1 | M | 5-8 | Touches the gateway every gated route uses and its existing tests; regressions | Hard part 1: retrofit across routes |
| Live-data gate accepts a principal; four costsource routes and connectors | B2 | M | 4-6 | Failed-attempt accounting and the weak-token refusal must not change | Moderate |
| Six open routes: authentication, scope, route-level matrix test | B3 | M | 5-8 | Aggregates computed before filtering leak totals; seven existing test files must stay green | Hard part 1 continued |
| ITSM base-origin seam, host allowlist, timeouts, safe retries | B4 | M | 4-6 | Retrying a non-idempotent create causes duplicate tickets (never retried) | Moderate |
| Generic MCP client with operator allowlist file, env and team scoping | B5 | M | 5-8 | Transport framing is unvalidated against a real server (F12); tool schemas drift | Moderate |
| Other views follow the synthetic mapping | B6 | S | 1-3 | Low | Easy |
| Browser session API, scoped workloads endpoint (workloads, budgets, alerts), credentials on every client | B7 | M | 5-8 | Cookie plus CSRF handling; the cookie must work with the offline default off | Hard part 1 continued |
| Roll-up readers: Mission, Findings, Outcomes, Workloads (named aggregates instead of line-level fields) | B12 | M | 5-8 | Several unowned readers (derive, valueMath, outcomes model, mission, workload card) must keep today's output when no aggregate is registered | Moderate |
| Page components that import the seed directly (four files) and the drill-down panel | B10 | M | 5-7 | Output must stay identical in the offline default; user-level events are personal data | Moderate |
| Sign-in UI, session provider, store hydration, view guard | B11 | M | 5-8 | First-paint flash of other teams' data; 401 and role-change refresh triggers | Hard part 1 continued |
| Data-provider seam (workloads, budgets, alerts; roll-up DTO with named aggregates and drill-down shapes), registry, scope-aware models, served-data oracle | B8 | L | 12-15 | About ten modules read the seed directly; float dollars versus cents; default output must stay identical | Hard part 1 continued |
| Remaining gateway routes: chat, FinOps export, handshake, published costs | B9 | M | 4-6 | Chat context must be built on the server; tenant binding for published costs must not change | Moderate |
| Persona and navigation from the verified principal | C2 | S | 2-3 | Offline default must keep the executive default | Easy |
| Browser persona matrix (Playwright) and local launcher | C1 | M | 4-8 | Playwright runs against a production build and is slow (see `playwright.simulation.config.ts`) | Moderate |
| Change lifecycle: request, approve, apply, update, idempotency | C3 | M | 5-8 | State machine edge cases (apply before approve, double approve) | Moderate |
| Inbound webhook with HMAC, timestamp window, replay store | C4 | M | 4-6 | Raw-body handling in Next.js, constant-time compare, clock skew; replay store is in memory in the mock | Hard part 2: webhook trust |
| Two-way status sync (poll plus webhook) | C8 | L | 9-12 | Out-of-order events, provider status vocabularies, loops when Ratio's own update triggers an event | Hard part 3 |
| Audit sink, read route and page | C5 | M | 4-6 | Volume and secret leakage; role-scoped reads | Moderate |
| OAuth2 client-credentials client behind an interface | C6 | M | 4-6 | Only provable against a real tenant; the mock proves the shape only | Moderate, partly deferred |
| Promote durable rules and remove this directory | C7 | S | 1 | Low | Easy |
Sum of the ranges in the table: 114 to 175 person-days (28 rows, one per card; every row's range sits inside the size scale above, checked by script when this table was edited). Parallel agents shorten calendar time because Sprint A cards run side by side, but the person-day total is what review capacity must absorb.

What is hard and why:

- **Identity and roles retrofit.** The gateway hands every handler a tenant
  string only (`withGateway.ts:22-25`). Seven route files have no check (F3),
  four more gateway routes have no per-role check, and the browser store holds
  the whole seed (F22), so scoping must also change the data that reaches the
  page, not just the API, and the browser needs a session mechanism it does not
  have (F11). Every route, its tests, the store, every client, and the persona
  switcher change.
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
ServiceNow), and `/demo` prompts that the current mock Frank answers with a real reply.

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
| D13 | Adopt an MCP SDK dependency, or keep the hand-rolled minimal client (this sprint takes the minimal client; Frank M2 leaves the question open) | Dependency policy; needs the specification check in Frank T-1 |
| D15 | **Pending.** MVP re-scope. Recommendation on record (not decided): cut A4 and A5 to what A1 needs; defer B-ACT, B-NOTICE, B-DELIVER, Sprint D, C9 and the alert stack; MVP = RBAC for three personas on A1, one live ingest connector with the A3 accuracy check, the AI-spend-versus-total ratio view, and a local deploy | Product scope; until the owner decides, no card in this plan is re-scoped, cut or started on the strength of the recommendation |
| D14 | Make the seed data server-only in enforce mode and add a bundle test with a planted data sentinel (today the seed ships in client assets in every mode; accepted for the mock because it is fixture data; required before any real data) | Needs edits to the bundle check and seed files that no card owns; part of moving off fixture data |

## 9. Risks and open questions

- **Matrix churn.** If D2 changes after cards land, the table-driven design
  confines the change to one data file and its generated tests.
- **Gateway retrofit conflicts.** B1 comes first; B2, B3, B7 and B9 follow it and
  are file-disjoint with each other (TASKS.md).
- **Change actions are API-only.** Request, approve and apply have no button or
  client method this sprint (card C3): their placement depends on D2 and D1.
- **The seed ships in client assets.** Scoping is enforced at the API and in
  rendered views, but the fixture seed is bundled for the browser in every mode,
  so a user can read it; B8's import-closure test only stops new client paths
  from importing it. Making it server-only (with a planted-sentinel bundle test)
  is owner decision D14 and is required before any real data.
- **Cross-sprint dependency.** C5 (Sprint C, portal UI) depends on C3 (Sprint D,
  change lifecycle), and C2 and C1 depend on C5, so Sprints C and D run as one
  pool with C3 first; the labels changed, the dependencies did not.
- **Shared test environments.** `RATIO_ENV=test` is also a plausible value on a
  shared test deployment: `RATIO_MOCK_IDP` must stay unset on any deployment
  that anyone other than the developer can reach.
- **Mock routes ship in the bundle.** Every `pages/api` file is part of a
  production build, so the mock IdP routes (`login`, `mock-control`) are gated
  at runtime only: by `mockIdpEnabled` (merged in A2: `RATIO_MOCK_IDP=1` and a
  raw `RATIO_ENV` of `development` or `test`) **and**, for both routes, by a
  peer-and-Host check (`isLoopbackRequest`, card B7: a loopback peer and a
  `Host` of `127.0.0.1` or `localhost`; `X-Forwarded-*` ignored; 404
  otherwise). `mock-control` also needs a launcher-generated secret header.
  Residual: behind a reverse proxy on the same machine the peer is loopback,
  so the mock must never run behind a proxy, and a user on the machine itself
  can always reach it. The routes are not excluded from the bundle.
- **Mock state and run modes.** The mock IdP key and revocation set, change
  store, replay store and audit store are module state: supported in unit
  tests and in a production build, not under `next dev` (card C1's launcher
  refuses it).
- **Unenforced budget edits.** Threshold editing is a client-only store
  mutation (4.5); no card enforces it.
- **Governance load.** Most auth, ingestion and route cards are restricted
  classes and need the full reviewer path; none is eligible for auto-merge.
- **Mock fidelity.** A mock proves the adapter against the subset of the wire
  contract we encode. It does not prove the real product behaves the same. The
  first real-tenant run (D3) is where drift shows up.
- **Issue #94.** Anything needing storage beyond memory (replay set,
  revocation, audit) is in memory in the mock and flagged for D8.

## 10. Owner direction recorded after the plan merged

These are the owner's product decisions made after the plan first merged. They
are recorded here as direction; the cards named below are drafted with the
first code slice that implements them (no docs-only PRs) and are **not**
drafted in this plan. D15 (pending) may defer several of them.

- **Committee-style approval.** The FinOps leader guides a change, an executive
  decides it, and a quorum rule decides when it is approved. The quorum lives in
  **one data file beside the permission matrix** (the same pattern as the
  matrix: data that tests can enumerate), so a change of quorum is a one-file,
  reviewed edit. It extends the separation-of-duties rule of section 4.5 and
  does not replace it.
- **Decision Packet.** A new card, C9 (Sprint C, portal UI), will produce a
  decision packet for the deciding executive. It is reserved here and drafted
  separately.
- **Sprint B (live connectors for ingest).** Three cards are reserved for it:
  B-ACT, B-NOTICE and B-DELIVER. The D15 recommendation defers them.
- **Recommender.** The product recommender is a generic `Recommender` interface
  with a mock implementation. It is never named after any vendor or model
  (in particular it is not named Fable), so a different recommender can replace
  the mock without renaming anything.
