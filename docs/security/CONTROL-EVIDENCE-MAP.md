# Control-to-evidence map (checklist item 6.1)

Date: 2026-10-11. Branch: `feat/rfq-readiness-build`.

This is an evidence map, not an attestation. Ratio holds no SOC 2 report, no HECVAT response, no ISO 27001 certificate and no other certification or third-party attestation, and nothing here should be read to imply one exists. The headings borrow common SOC 2 Trust Services Criteria and HECVAT-style themes for navigation only. A row says what the code does and which test exercises it; it does not say a control is operating effectively over time.

## How to read the tables

Status values: **Implemented and tested** (code exists, a test proves the behavior, and it is reachable in the running app or database), **Implemented, not wired** (code and tests exist, but no API route, ingest path or UI calls it), **Designed only** (an interface, a README or a design document, with no real implementation), **Not present**.

Test counts are the number of `it(`/`test(` declarations found by grep in the named file. They are declaration counts, not a run result. I did not run the test suite. Files ending `.db.test.ts` need a Postgres test database (CI runs them under `npm run test:db`); I did not run them.

Where a row lists several test files, the first is the primary proof.

## 1. Access control and authentication

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 1.1 | Real cost data is refused to anonymous callers; only the two offline sandbox sources are open. A weak or missing `RATIO_API_TOKEN` refuses live data (503/401). | Implemented and tested | `src/server/gateway/liveDataAuth.ts` | `src/costsource/reReview.test.ts` (22), `src/costsource/finalRound.test.ts` (10), `src/costsource/sandboxAllowlist.test.ts` (6) | No test file named for this module; it is covered by tests that import it. One shared static token, not per-user identity. |
| 1.2 | Bearer token is compared in constant time; token must be 32+ characters with 10+ distinct. | Implemented and tested | `src/server/gateway/auth.ts` | `src/server/gateway/withGateway.test.ts` (12) | No dedicated `auth.test.ts`. The tenant id is derived from the token itself (`tenantId`); there is no token issuance, rotation or revocation. |
| 1.3 | Failed authentications are counted per client IP; after 1,000 in a minute further failures get 429. Forwarded-for is ignored unless trusted hops are declared. | Implemented and tested | `src/server/gateway/liveDataAuth.ts` | `src/costsource/reReview.test.ts` (22), `src/costsource/finalRound.test.ts` (10) | Per process (see section 8). |
| 1.4 | Gateway auth is enforced only when a token is configured or a live AI or change-management provider is selected. | Implemented and tested | `src/server/gateway/auth.ts` (`resolveGatewayAuth`) | `src/server/gateway/withGateway.test.ts` (12) | Offline default is unauthenticated by design. A misconfigured production deployment with the mock provider and no token serves the gateway routes openly. |
| 1.5 | OIDC JWT verification: algorithm allowlist (no `none`/HS*), signature, issuer, audience, expiry and lifetime caps, closed error codes, deny by default. | Implemented, not wired | `src/identity/oidc/verifier.ts` | `src/identity/oidc/verifier.test.ts` (95), `src/identity/oidc/jwk.test.ts` (34), `src/identity/oidc/config.test.ts` (32), `src/identity/oidc/errors.test.ts` (7) | Not called by `authenticate()` or `withGateway`. No real identity provider exercised; tests use generated keys and a fake key-set server. |
| 1.6 | Key-set cache: one forced refresh per cooldown, shared in-flight fetch, stale-if-error with a hard ceiling, then fail closed. | Implemented, not wired | `src/identity/oidc/jwks.ts` | `src/identity/oidc/jwks.test.ts` (40) | `fetchJwks` is an injected seam. No production fetcher, no SSRF or egress guard for it (see 6.4). Per-process cache. |
| 1.7 | Revocation hook by token id, fail closed on hook error; bounded in-memory reference denylist. | Implemented, not wired | `src/identity/oidc/denylist.ts` | `src/identity/oidc/denylist.test.ts` (15) | In-memory, single process. No shared store. Replay inside token lifetime allowed by default. |
| 1.8 | Mock identity provider for demo personas (`authMethod: 'mock-idp'`). | Implemented and tested | `src/mock/idp/index.ts` | `src/mock/idp/idp.test.ts` (23) | Demonstration only. Not an authentication control for production. |
| 1.9 | Multi-factor authentication, session management, SSO provisioning and deprovisioning, password policy, account lockout per user. | Not present | none | none | No user directory, sessions or MFA in this repo. Depends on the customer's identity provider and on item 1.5 being wired. |

## 2. Authorization and separation of duties

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 2.1 | One pure, deny-by-default decision (role, team, environment, resource); 401 for no principal, 403 for out of scope, 409 for unapproved prod apply. | Implemented, not wired | `src/rbac/authorize.ts`, `src/rbac/matrix.ts` | `src/rbac/authorize.test.ts` (19), `src/rbac/matrix.test.ts` (8) | Imported only by `src/remediation/human.ts` and `src/mcp/access.ts`. No file under `pages/` calls it. The permission matrix is proposed, not owner-confirmed. |
| 2.2 | Requester and approver of a change must differ; apply requires approval; ordering enforced. | Implemented, not wired | `src/rbac/authorize.ts`; `src/remediation/human.ts` | `src/rbac/authorize.test.ts` (19), `src/remediation/human.test.ts` (29) | `pages/api/v1/cm/change.ts` sits behind `withGateway` but not behind `authorize()`. Separation of duties is not enforced on that route. |
| 2.3 | Autonomous remediation is off by default per tenant and action class; eligibility is structural (low risk, reversible, not a commitment purchase) and rechecked on every decision. | Implemented, not wired | `src/remediation/decide.ts`, `src/remediation/registry.ts`, `src/remediation/policy.ts` | `src/remediation/decide.test.ts` (27), `src/remediation/registry.test.ts` (6), `src/remediation/policy.test.ts` (8) | No real executor (in-memory test double only). Role lists for the kill switch are unconfirmed. |
| 2.4 | MCP core exposes a closed, frozen set of six read-only tools; `mcp.write` denied for every role; tenant comes from context, never from arguments. | Implemented, not wired | `src/mcp/registry.ts`, `src/mcp/access.ts`, `src/mcp/tools.ts` | `src/mcp/registry.test.ts` (12), `src/mcp/authz.test.ts` (17) | No transport. Read-only by capability depends on a provider that does not exist; tested against fakes only. |
| 2.5 | Database tenant isolation: row-level security forced on tenant tables; tenant set transaction-locally only. | Implemented and tested | `src/ingest/db/tenant.ts`; migrations under `src/ingest/db/migrations/` | `src/ingest/db/tenancy.db.test.ts` (14), `src/ingest/tenantScope.test.ts` (2), `src/ingest/db/tenant.test.ts` (4) | DB tests need Postgres. Applies to the ingest schema; the API gateway derives its tenant from a token hash, not from this layer. |
| 2.6 | Database privilege separation: distinct owner, writer and reader roles; reader cannot write. | Implemented and tested | `src/ingest/db/privilegeModel.ts` | `src/ingest/db/privileges.db.test.ts` (68), `src/ingest/db/roles.db.test.ts` (6), `src/ingest/db/reader.db.test.ts` (8) | Role credential management and rotation is deployment work, not in the repo. |
| 2.7 | Library modules refuse cross-tenant input (allocation, detection). | Implemented, not wired | `src/allocation/allocate.ts`; `src/detection/series.ts` | `src/allocation/allocate.test.ts` (48), `src/detection/series.test.ts` (41) | Neither module is imported by the app. Isolation holds only if the future caller passes the right tenant. |
| 2.8 | Periodic access review, privileged access management, break-glass procedure. | Not present | none | none | Process controls; no artifact in the repo. |

## 3. Audit logging

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 3.1 | Hash-chained remediation audit log naming the acting subject and policy version; `verifyChain` detects edit, reorder and deletion. | Implemented, not wired | `src/remediation/audit.ts` | `src/remediation/audit.test.ts` (15) | In-memory, per process. No external anchor, so a truncated tail is undetectable. Denied human attempts are not recorded. |
| 3.2 | MCP calls write an audit record before the result is returned; an audit failure turns an allowed call into an error. | Implemented, not wired | `src/mcp/handler.ts` | `src/mcp/protocol.test.ts` (20), `src/mcp/authz.test.ts` (17), `src/mcp/abuse.test.ts` (13) | Memory sink in tests; no durable audit store. |
| 3.3 | Notification dispatcher writes one audit record per attempt naming the actor; fails closed if the sink is down. | Implemented, not wired | `src/notify/dispatcher.ts` | `src/notify/dispatcher.test.ts` (40) | In-memory sink; dispatcher disabled by default and not connected to detection. |
| 3.4 | Chargeback changes append audit records; closed periods never change. | Implemented, not wired | `src/allocation/chargeback.ts` | `src/allocation/reports.test.ts` (18) | Caller must persist the book; no storage or approval workflow for closing a period. |
| 3.5 | Gateway request log (method, path only, tenant, status, latency); internal errors logged without stack to the client or query strings. | Implemented and tested | `src/server/gateway/withGateway.ts`, `src/server/gateway/internalError.ts` | `src/server/gateway/withGateway.test.ts` (12), `src/server/pathOnly.test.ts` (8), `src/server/logPaths.test.ts` (5), `src/server/unrenderableThrow.test.ts` (3) | Operational log only. Does not record the acting user (identity is a tenant hash) or the authorization decision. |
| 3.6 | Database ledger tables are append-only for the application role. | Implemented and tested | `src/ingest/db/migrations/0004_outcome_ledger.up.sql` | `src/ingest/db/immutability.db.test.ts` (28), `src/ingest/db/outcomeLedger.db.test.ts` (12) | Owner role can still alter. No external log shipping. |
| 3.7 | Centralized, durable, tamper-evident audit trail across the product, with retention and review. | Not present | none | none | Each module has its own in-memory log. Nothing aggregates them or persists them. |

## 4. Input validation

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 4.1 | Gateway enforces method allowlist, body-size limit (default 100 KB) and route validators with a uniform error envelope. | Implemented and tested | `src/server/gateway/withGateway.ts` | `src/server/gateway/withGateway.test.ts` (12) | Applies only to routes wrapped in `withGateway` (`pages/api/v1/ai/chat.ts`, `pages/api/v1/cm/change.ts`, `pages/api/v1/costs/published.ts`). `src/server/nonGatewayRoutes.test.ts` (27) covers the others separately. |
| 4.2 | Upstream errors and internals do not leak to clients. | Implemented and tested | `src/server/gateway/internalError.ts` | `src/server/gateway/upstreamLeakSweep.test.ts` (6), `src/server/unrenderableThrow.test.ts` (3) | Sweep covers known routes, not every future route. |
| 4.3 | MCP messages: size, depth and node caps, prototype-safe parsing, strict envelope and argument schemas, no batches. | Implemented, not wired | `src/mcp/limits.ts`, `src/mcp/schema.ts`, `src/mcp/jsonrpc.ts` | `src/mcp/malformed.test.ts` (29), `src/mcp/caps.test.ts` (23), `src/mcp/schema.test.ts` (9), `src/mcp/limits.test.ts` (5) | Caps are placeholders with no measurement behind them. |
| 4.4 | Alert events: strict validation, control and bidirectional-text stripping, length caps. | Implemented, not wired | `src/notify/alertEvent.ts` | `src/notify/alertEvent.test.ts` (43) | Not fed by any detector. |
| 4.5 | Remediation proposals: strict schema, parameter validation, resource caps. | Implemented, not wired | `src/remediation/schema.ts`, `src/remediation/proposal.ts` | `src/remediation/schema.test.ts` (16) | No route calls it. |
| 4.6 | Allocation, detection and recommendation inputs treated as untrusted: unknown fields refused, hard caps, fixed error messages that never echo input. | Implemented, not wired | `src/allocation/limits.ts`, `src/detection/series.ts`, `src/recommend/validate.ts` | `src/allocation/allocate.test.ts` (48), `src/detection/series.test.ts` (41), `src/recommend/feeds.test.ts` (27) | Libraries only. |
| 4.7 | Slack and email output encoding (escaping, defanged links, narrow address grammar, no Cc/Bcc). | Implemented, not wired | `src/notify/slack.ts`, `src/notify/email.ts` | `src/notify/slack.test.ts` (28), `src/notify/email.test.ts` (24) | No SMTP implementation. |
| 4.8 | Web application security headers, CSRF protection, content security policy. | Not present | none | none | No evidence found in the checked files; not assessed beyond them. |

## 5. Secrets handling

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 5.1 | Text persisted or logged by the ingest worker is redacted for secrets, presigned-URL queries and similar before writing; redaction is linear-time. | Implemented and tested | `src/ingest/redact.ts` | `src/ingest/redact.test.ts` (13), `src/ingest/redactCap.test.ts` (7), `src/ingest/redactLinear.test.ts` (2) | Pattern-based; a novel secret format passes. |
| 5.2 | MCP results are redacted, emails masked by default; money tools reject results containing secrets. | Implemented, not wired | `src/mcp/redact.ts` | `src/mcp/redact.test.ts` (13) | Pattern-based and incomplete; a secret split across fields passes. |
| 5.3 | Notification config holds secret handles only; secrets are resolved per attempt, store errors swallowed, results carry fixed codes and host only. | Implemented, not wired | `src/notify/secrets.ts` | `src/notify/dispatcher.test.ts` (40), `src/notify/httpDelivery.test.ts` (25) | The secret store is an injected interface; no real store behind it. |
| 5.4 | Outbound webhooks signed with HMAC-SHA256 over timestamp and body; receiver check is constant-time, replay window 300 s, up to four secrets for rotation. | Implemented, not wired | `src/notify/webhook.ts` | `src/notify/webhook.test.ts` (18) | Receiver must track delivery ids to stop replay inside the window. |
| 5.5 | Secrets manager or key management service integration, rotation schedule, secret scanning in CI. | Not present | none | none | `RATIO_API_TOKEN` is an environment variable. No rotation procedure documented. |
| 5.6 | Encryption at rest and in transit for stored data. | Not present | none | none | Left to deployment (database, object store, TLS termination). Nothing in the repo asserts or tests it. |

## 6. Network egress and SSRF

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 6.1 | Outbound notification URLs: https only, no userinfo, port 443 unless allowlisted, IP literals refused, every DNS answer re-checked, address pinned, no redirects followed. | Implemented, not wired | `src/notify/ssrf.ts`, `src/notify/ip.ts` | `src/notify/ssrf.test.ts` (39), `src/notify/ip.test.ts` (19) | Guard output must be honored by a transport that does not exist. Special-purpose range list is static. |
| 6.2 | Egress is off by default and re-read before every attempt, so it works as a kill switch. | Implemented, not wired | `src/notify/dispatcher.ts` | `src/notify/dispatcher.test.ts` (40) | Flag source is an injected function. |
| 6.3 | Bounded delivery: request and response size caps, timeouts, attempt caps, per-host circuit breaker. | Implemented, not wired | `src/notify/httpDelivery.ts`, `src/notify/circuitBreaker.ts` | `src/notify/httpDelivery.test.ts` (25), `src/notify/dispatcher.test.ts` (40) | Contract tested only through fakes. |
| 6.4 | Real HTTP transport that connects to the pinned address with correct SNI; guarded production key-set fetcher for OIDC. | Designed only | `src/notify/types.ts` (`HttpTransport`/`PinnedHttpRequest` interface); `src/identity/oidc/README.md` | none | Neither the transport nor the OIDC fetcher exists. |
| 6.5 | Network segmentation, egress firewall rules, WAF. | Not present | none | none | Infrastructure; nothing in the repo. |

## 7. Data integrity and financial accuracy

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 7.1 | Money held as integer minor units (BigInt) per ISO 4217 exponent; never summed across currencies; no floating-point rounding without an explicit mode. | Implemented, not wired | `src/allocation/money.ts`, `src/recommend/money.ts`, `src/remediation/money.ts` | `src/allocation/money.test.ts` (38), `src/recommend/money.test.ts` (7), `src/remediation/money.test.ts` (8) | Canonical FOCUS rows carry `BilledCost` as a JS number, so float noise needs `rounding: 'half-even'`. No FX conversion. Currency table is a snapshot. |
| 7.2 | Allocation conserves money: allocated plus unallocated equals the ledger on every call; first-match-wins rules; unmatched is `UNALLOCATED`. | Implemented, not wired | `src/allocation/allocate.ts` | `src/allocation/allocate.test.ts` (48) | Library only. |
| 7.3 | Closed chargeback periods never change; restatements become adjustments in the next open period. | Implemented, not wired | `src/allocation/chargeback.ts` | `src/allocation/reports.test.ts` (18) | In-memory book; no concurrency control. |
| 7.4 | Remediation executes at most once per proposal id; dry run, post-check and automatic rollback with a token. | Implemented, not wired | `src/remediation/orchestrator.ts` | `src/remediation/orchestrator.test.ts` (30) | In-memory state; no cross-process lock; no real executor. |
| 7.5 | Detection and forecasting are deterministic (no clock, randomness or I/O) with a measured false-alarm bound on synthetic data. | Implemented, not wired | `src/detection/anomaly.ts`, `src/detection/forecast.ts` | `src/detection/anomaly.test.ts` (39), `src/detection/forecast.test.ts` (48), `src/detection/falsealarm.test.ts` (1) | Synthetic data only; no real billing data used to tune thresholds. Simplified model versus the design. |
| 7.6 | Recommendation engine ranks savings and commitments in integer minor units, flags inconsistent input. | Implemented, not wired | `src/recommend/rank.ts`, `src/recommend/commitments.ts`, `src/recommend/purchase.ts` | `src/recommend/commitments.test.ts` (39), `src/recommend/rank.test.ts` (25), `src/recommend/purchase.test.ts` (23) | Cloud-feed field mappings (AWS, Azure, GCP) are written from documentation and unvalidated against live responses. Figures from them must not be trusted yet. |
| 7.7 | Ingest evidence: migrations are checksummed and manifested; ingest persistence is immutable after commit. | Implemented and tested | `src/ingest/db/migrationFiles.ts`, `src/ingest/db/migrate.ts`; `src/ingest/evidenceRecord.ts` | `src/ingest/db/migrationFiles.test.ts` (38), `src/ingest/db/migrate.test.ts` (5), `src/ingest/evidenceRecord.test.ts` (3) | Evidence of what was ingested, not of billing correctness at the cloud provider. |
| 7.8 | Independent verification that claimed savings were realized; reconciliation of ingested data to provider invoices. | Not present | none | none | Savings are checked only against cost at stake. Reconciliation is the data provider's job and is not built. |

## 8. Availability and rate limiting

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 8.1 | Gateway sliding-window rate limit, 1,000 requests per minute per tenant, with Retry-After. | Implemented and tested | `src/server/gateway/rateLimit.ts` | `src/server/gateway/rateLimit.test.ts` (4), `src/server/gateway/withGateway.test.ts` (12) | In memory, per process. Each serverless instance counts separately; a shared store is needed. |
| 8.2 | MCP per-principal rate limit (denied and invalid calls count) and per-call time budgets. | Implemented, not wired | `src/mcp/rateLimit.ts`, `src/mcp/deadline.ts` | `src/mcp/rateLimit.test.ts` (7), `src/mcp/deadline.test.ts` (5) | Fixed window, in process; up to twice the limit across a window boundary. |
| 8.3 | Circuit breakers and kill switches: notifications per host; remediation per action class. | Implemented, not wired | `src/notify/circuitBreaker.ts`; `src/remediation/orchestrator.ts` | `src/notify/dispatcher.test.ts` (40), `src/remediation/orchestrator.test.ts` (30) | In-memory state. |
| 8.4 | Backups, restore testing, disaster recovery, capacity planning, uptime monitoring, status page. | Not present | none | none | Deployment and operations; no artifact in the repo. |
| 8.5 | Shared rate-limit and failed-auth stores for multi-instance deployment. | Designed only | `src/server/gateway/rateLimit.ts` (comment names Redis as the swap) | none | Interface exists; no shared implementation. |

## 9. Change management

| # | Control (plain words) | Status | Implementing file | Proving test (approx. count) | Remaining gap |
|---|---|---|---|---|---|
| 9.1 | CI pipeline runs lint, typecheck, tests, database tests, build, bundle check and end-to-end checks on every run of the workflow. | Implemented and tested | `.github/workflows/ci.yml` | not applicable (the workflow is the control) | Repo contains the workflow; it does not prove branch protection makes the check mandatory. |
| 9.2 | Architectural boundary tests keep dependencies and imports in allowed directions. | Implemented and tested | `src/ingest/importBoundary.test.ts`, `src/ingest/dependencyBoundary.test.ts` | `src/ingest/importBoundary.test.ts` (6), `src/ingest/dependencyBoundary.test.ts` (2) | Covers ingest only. |
| 9.3 | A governance workflow classifies and labels pull requests, decides auto-merge, and records revocation, using scripts checked out from the base branch rather than the PR head. | Designed only | `.github/workflows/governance.yml` | not applicable | Step names read only; I did not verify what the scripts enforce or whether it is a required check. No claim of effectiveness. |
| 9.4 | Production changes require request, different-person approval and ticket binding. | Designed only | `src/rbac/authorize.ts`; `src/remediation/human.ts` | `src/remediation/human.test.ts` (29) | Logic exists but the change route does not enforce it (see 2.2). |
| 9.5 | Enforced code review, protected branches, signed commits, release approvals, separation of development and production access. | Not present | none | none | Hosting-platform settings; cannot be evidenced from the repo. |
| 9.6 | Documented vulnerability management (dependency scanning cadence, patch SLAs, advisory triage). | Not present | none | none | See section 11. |

## 10. Gaps that block any attestation

1. No real identity provider has been exercised. The OIDC verifier is tested with generated keys and a fake key-set server, and it is not called from `authenticate()` or `withGateway`. Production authentication today is one shared bearer token per deployment.
2. Authorization is not enforced on the API. `src/rbac` is called only by the remediation human path and the MCP core. No file under `pages/` imports it, so the role matrix and separation of duties do not protect any route.
3. Modules not wired into API routes or the app: `src/identity/oidc`, `src/notify`, `src/remediation`, `src/mcp`, `src/allocation`, `src/detection`, `src/recommend`. They are libraries with unit tests.
4. State is in memory: audit logs (remediation, MCP, notify, chargeback), the token denylist, the JWKS cache, circuit breakers, dead letters, dedupe windows and the chargeback book. A restart loses them; none is tamper-evident outside the process.
5. Rate limits and failed-auth counters are per process. Multiple instances multiply the effective limit.
6. No real executor, HTTP transport, SMTP transport, MCP transport or secret store exists. Their contracts are tested only through fakes.
7. Recommendation feed mappings are unvalidated against live AWS, Azure and GCP responses. Detection thresholds were tuned on synthetic data only.
8. No penetration test, no third-party security assessment, no SOC 2 audit and no HECVAT submission.
9. No documented vulnerability management process, no incident response runbook, no data retention or deletion policy, no business continuity or disaster recovery plan.
10. Offline default is unauthenticated for the gateway when no token is set and the mock provider is selected. Safe for a demo; it must be impossible to deploy that way in production, and no startup guard is claimed here.
11. Database-level controls (row-level security, role privileges, append-only ledgers) are tested only where a Postgres test database is available. They apply to the ingest schema; the API tenant model (token hash) is separate.

## 11. What an auditor will ask for that this repo cannot produce

An auditor of a SOC 2 or similar engagement would request the following. None can be produced from source code and unit tests.

1. Operating-effectiveness evidence over a period: samples of access reviews, change approvals, terminations, and alert follow-up with dates and approvers.
2. A population of production changes with the pull request, reviewer, approval and deployment record for each, plus branch-protection and repository settings.
3. User and access lists for production systems, cloud accounts and the database, with joiner, mover and leaver records and MFA configuration.
4. Written policies and procedures: information security, acceptable use, incident response (with a tested runbook and a past incident or tabletop record), data classification, retention and disposal, business continuity and disaster recovery, vendor management, secure development, vulnerability and patch management.
5. Evidence of risk assessment and the risk register, with management review.
6. Vendor and subprocessor inventory with their own assurance reports (hosting provider, identity provider, AI model provider, database service).
7. Production configuration evidence: encryption at rest and in transit, TLS settings, backup schedules and restore tests, logging and monitoring configuration, log retention settings.
8. Penetration test report, vulnerability scan results and remediation tracking, dependency scan history.
9. Security awareness training and background check records for personnel.
10. Production audit logs for the period, centrally stored and reviewed, showing the acting user, action and outcome.
11. Customer data handling evidence: data flow diagrams, tenant isolation test results on the production deployment, data deletion on contract end.
12. Any HECVAT-style questionnaire answers must be written from the evidence above. Rows in sections 1 to 9 can support a narrative answer to "how does the software do X" but cannot support an answer that a control operates, is monitored, or has been independently tested.

## 12. Verification notes

Every file path cited above was checked to exist on disk on 2026-10-11 before this map was finalized, except where a row says "none". Test counts come from grepping `it(`/`test(` declarations. Rows 1.1 and 1.3 cite tests that import `liveDataAuth`; I confirmed the import, not that each declared test targets that behavior. Row 9.3 is based on step names in the workflow only. No test was executed in producing this document.
