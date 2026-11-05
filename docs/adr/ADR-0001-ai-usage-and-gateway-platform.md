# ADR-0001: AI usage, adoption and policy platform (integrated with established gateways)

| | |
|---|---|
| Status | **Proposed** (wave 0: design and shared contracts only). Merge decision: orchestrator. Every default below may be overridden by the owner (§17). |
| Date | 2026-11-05 |
| Release line | A new versioned line, **1.1 → 1.2 → 1.3 → 2.0** ([roadmap](../roadmap/platform-program.md)), separate from the pending **1.0** release candidate. Nothing in this program is evidence for a 1.0 gate. |
| Code in this PR | `src/platform/contracts/` (types and pure validators, no behavior beyond validation), a `check:bundle` client marker, worker typecheck coverage. No migration, no route, no UI, no dependency. |
| Status wording | A capability is described, at most, as **"implemented and pre-release validated; live verification scheduled"** until its live evidence exists. Never "enterprise supported", "protected" or "connected" before then (§16). |

This is the first ADR in the repository; `docs/adr/` starts here and numbers are sequential (`ADR-0002`, …).

## 1. Context

### 1.1 The owner's directive

The owner asked to "upgrade all 8 capabilities", each with the evidence required before Ratio may claim enterprise
support:

| # | Capability | Build next | Evidence required before claiming enterprise support |
|---|---|---|---|
| 1 | Track model spending | Provider and cloud billing ingestion, model/SKU mapping, workload allocation, currency-safe reconciliation | Approved-source imports reconcile; unmatched charges and allocation gaps remain visible |
| 2 | Measure adoption | Eligible-population snapshots, qualifying activity events, period-specific adoption definitions | Numerator and denominator reproducible; identities and exclusions tested |
| 3 | Report user utilization | Pseudonymous user attribution, workload/session activity, licensed-seat comparison where available | Authorized user-level drill-down, service-account separation, retention and privacy controls |
| 4 | Track token costs | Actual token-category ingestion, versioned rate cards, estimates linked to billing reconciliation | Cache/batch semantics verified per provider; missing usage and rate gaps do not become zero |
| 5 | Inspect prompts before execution | A mandatory gateway path with bounded input inspection | Requests blocked before dispatch in supported scenarios; bypass paths assessed |
| 6 | Enforce input/output policies | Versioned policies enforced before request and before response release | Allow, block, timeout, streaming and partial-failure behavior tested |
| 7 | Block sensitive data transfers | Gateway-integrated classification/DLP with destination and data-category rules | Seeded sensitive-data tests demonstrate prevention before prohibited transmission |
| 8 | Control model access | Tenant/user/workload entitlements checked at invocation | Disallowed models/providers rejected; credentials and network paths prevent documented bypasses |

The owner then set the architecture principle this ADR follows:

> Build a shared identity, telemetry, policy, and evidence foundation, then connect it to established gateways and
> enterprise systems. Do not turn the existing application into a monolithic identity provider, observability
> backend, and security gateway at once.

### 1.2 What exists on `main` (1056be0) and constrains this design

- **1.0 release candidate, engagement mode** (README "Engagement mode" cites rows R1–R4 and R11; R6, R7 and R9 are
  named in `src/finops/semantic/views.ts`; R12 packaging evidence is `docs/evidence/r12-packaging`): one engagement per instance,
  file-drop billing import, named users with OIDC bindings (`src/engagement/auth/directory.ts`), a deny-by-default
  authorization service with six permissions (`src/engagement/auth/authz.ts`: `reports:read`, `reports:export`,
  `connectors:read`, `connectors:manage`, `members:manage`, `identity:manage`) and a reserved, always-denied `agent`
  principal kind.
- **Managed connector framework** (M0a/M0b/M0c, `src/connectors/managed/`): a retriever registry, four staged health
  probes (auth, scope, data, contract), honest connector states (`ConnectorState` in `health.ts`), connector evidence
  records and a source-role/overlap policy. Worker-only.
- **Unified FinOps view core** (`src/finops/semantic/`): pure view definitions and reconciliation identities, an exact
  decimal helper (`decimal.ts`, BigInt, never float) and reason codes such as `ALLOCATION_MISSING`,
  `UNALLOCATED_MISSING` and `CURRENCY_NOT_PUBLISHED` ("never treated as 0", "never summed across currencies"). Its
  `ai_usage` view waits on "E2 enrichment (migration 0006)" and "M6b AI usage connectors".
- **`src/server/gateway/`** is an HTTP route wrapper for Ratio's own API (auth, rate limit, fail-closed errors). It is
  **not** an AI gateway. This ADR says "AI gateway" or "model gateway" for the enforcement point to avoid the clash.
- **Migrations** (`src/ingest/db/migrations`): 0001, 0002 and 0004 exist; 0003 is dead on any database at 0004
  because the runner refuses a pending version older than the newest applied one (`OUT_OF_ORDER`,
  `src/ingest/db/migrate.ts`); 0005 (R4 trust views) and 0006 (E2 enrichment) are referenced by code. This rule
  shapes the reservation plan in §12.
- **Evidence tooling**: `scripts/evidence/collect-pr-evidence.mjs` runs the gates, fixture control totals, the
  migration smoke and the rollback check, and writes `evidence.md`/`evidence.json`.
- **Size budget** (docs/design/sprint-mock-demo-mcp-rbac/TASKS.md rule 6): production lines at most 400 per PR, tests
  at most 1.5 times that, `red.txt`/`green.txt` at most 150 lines each, squash merge, mutation check, regression
  analysis and rollback check in every PR body.

## 2. Principles

1. **Separation.** Ratio is the system of record for usage, money, eligibility, policy definitions and evidence. It
   is not the identity provider (it consumes OIDC and directory sources), not the observability backend (it
   consumes OpenTelemetry), and not the production AI gateway (it supplies policy to one).
2. **Contracts first.** Three streams build in parallel on the versioned contracts in this PR. No vendor adapter is
   built twice before a shared contract is proven with one.
3. **Unknown is not zero.** Missing usage, rates, identities, denominators and allocations are shown as missing,
   with a reason, everywhere: contracts, storage, reports and UI.
4. **No content by default.** Prompt, response, tool and attachment bodies are never persisted by default.
5. **Fail closed where it protects; be honest where it does not.** Hard controls deny on failure; optional analytics
   may continue only under an explicit policy with a durable, visible gap.
6. **Evidence before claims.** Each capability's status follows its evidence (§14, §16).

## 3. Decisions

| ID | Decision (default; owner may override, §17) |
|---|---|
| D1 | **Separate versioned line.** 1.1 Platform Foundation + Economics; 1.2 Adoption and utilization; 1.3 Policy monitor-only + read-only A2A; 2.0 Enforcement + Operations. Rationale and exit gates in the roadmap. Minor versions are additive (new tables, flags off, no change to 1.0 contracts or APIs); 2.0 is a major because blocking customer traffic and a mandatory gateway path change runtime behavior and deployment topology. |
| D2 | **Ratio is not the production gateway.** Ratio defines a versioned policy contract (`policy/1`, `policy-bundle/1`, `entitlement/1`, `policy-decision/1`), distributes signed bundles to an approved, established gateway, and ships (a) a pure, side-effect-free policy evaluation library and bundle format that a gateway or a thin plugin runs **locally** (deterministic, no LLM, no call to Ratio's UI server per decision) and (b) a **mock gateway for tests and conformance only**. Final gateway pick is deferred to the pilot environment (§3.1). Monitor-only first (1.3), blocking later (2.0). |
| D3 | **Fail closed by default** on policy-engine error, timeout, invalid or expired policy, unavailable entitlement, required DLP or hard budget reservation; configurable only toward "continue with a visible gap" for monitor-only or log-only policies (enforced by the `policy/1` validator; failure table in §3.3). |
| D4 | **DLP: deterministic in-house detectors first, no ML**: card numbers with Luhn, US SSN with validity rules, IBAN with mod-97, cloud and API key patterns, private key blocks, email, phone, custom regex and dictionaries; normalization against encoding tricks (Unicode NFKC, zero-width removal, bounded base64/hex/URL decoding of candidates) (slice C4). A prompt-injection classifier, if added, is one `signal` condition, never a guarantee. |
| D5 | **No real provider calls or credentials in tests.** Mock providers and the mock gateway only; live verification later with owner-provided credentials in an owner-run environment. |
| D6 | **No new runtime dependency** without its name, version and license in the PR; prefer none. This PR adds none. |
| D7 | **Feature-flagged off in engagement mode** until the owner enables it, **per instance**: an opt-in `platform` block in the engagement config (`{ "enabled": false, "economics": false, "adoption": false, "policyMonitor": false, "enforcement": false }`; absent means all off; a sub-flag needs `enabled`). `SUPPORTED_IN_THIS_BUILD` (`src/engagement/config.ts`) only says what a build can accept; it never turns a capability on. Implemented in slice A1, so a 1.0 instance is unchanged. |
| D8 | **Contracts in `src/platform/contracts/`**, server and worker only, every record carrying `schemaVersion: '<name>/<major>'`, pinned by `schemaPin.test.ts`. |
| D9 | **Connectors extend M0a/M0b/M0c**, not a second framework: one declaration contract and one status ladder (§6). |
| D10 | **Privacy model** of §8: keyed per-tenant pseudonyms with rotation, no content by default, configurable retention with deletion jobs, a separate drill-down permission, services separate from humans. |
| D11 | **Currency and rounding** of §9: exact decimal strings, no cross-currency sums, N/A is not 0. |
| D12 | **Frank and AI boundaries** of §10.3. |

### 3.1 Gateway candidates (desk research; final pick deferred to the pilot)

Selection criteria: (1) a pre-dispatch hook that can block before the request leaves; (2) response and stream
release control (buffer, then release); (3) local, deterministic policy evaluation without a per-decision call to an
external SaaS; (4) OpenTelemetry export; (5) license terms for the features needed; (6) self-hosting.

| Candidate | Pre-dispatch hook | Response/stream release control | Local evaluation of a Ratio bundle | OTel | License (as found) | Self-host |
|---|---|---|---|---|---|---|
| LiteLLM proxy | `pre_call` custom guardrail (`async_pre_call_hook`); `during_call` runs in parallel and must not be used for masking | `post_call` on a stream runs after delivery (audit only); `async_post_call_streaming_iterator_hook` processes chunks | Yes, as a Python custom guardrail that loads the bundle | To verify | Some guardrail integrations require an Enterprise license; core terms to verify | Yes |
| Envoy AI Gateway (reported renamed "Agent Router", 2026; to verify) | Envoy `ext_proc` external processor | `ext_proc` sees response bodies; buffering is Envoy configuration | Yes, as an `ext_proc` service or filter running the library | Envoy has OTel tracing | Apache-2.0 reported; full guardrails reported as a separate enterprise product | Yes |
| Kong AI Gateway | AI Prompt Guard / custom plugins | AI Semantic Response Guard (AI Gateway Enterprise) | Via a custom plugin | To verify | Prompt and response guard plugins reported as Enterprise/"AI License Required" | Yes |
| Portkey gateway | Guardrail checks in the open-source gateway | To verify | To verify | Not confirmed in the open-source README | MIT reported; ownership change reported in 2026 (to verify) | Yes (Node, Docker) |
| Cloudflare AI Gateway | Guardrails and DLP evaluate prompts (Flag/Ignore/Block) | Guardrails and DLP evaluate responses; streaming behavior to verify | No: managed policy, not a Ratio bundle; integration would be configuration sync | Not confirmed | Managed service | No (managed edge) |
| Cloud-native (e.g. cloud provider AI gateways and model guardrail services) | Provider-specific | Provider-specific | Usually no (managed policy) | Provider-specific | Commercial | No |

Default for the pilot shortlist: **Envoy AI Gateway (ext_proc) and LiteLLM (custom pre_call guardrail)**, because both
can run the Ratio library locally before dispatch and both self-host. The choice is the owner's, made against the
pilot environment (§17 item 1). Sources and their verification status are in §18; every row above is to be verified
against the vendor's current documentation before Stream C's integration slice.

### 3.2 Policy pipeline order (gateway side)

1. Authenticate the caller and resolve the workload (gateway credentials, never a header the client sets freely).
2. **Entitlement** check (tenant, team, user, workload, service × provider, model).
3. **Input and destination policy**, including DLP on the normalized input, tool arguments and tool results.
4. **Budget reservation** for hard limits (2.0): reserve the estimated maximum before dispatch, settle after,
   record outstanding reservations and overruns.
5. **Dispatch** to the provider.
6. **Output policy** (pre-response, or per stream window).
7. **Release** to the client.
8. Emit `policy-decision/1`, `gateway-request/1`, `ai-usage-event/1` (basis `estimated`) and the settlement record.

A2A messages and tool results pass through the same steps (location `a2a_message`, `tool_result`).

### 3.3 Failure policy

| Failure | Behavior | Contract enforcement |
|---|---|---|
| Authentication or entitlement service unavailable | Deny | `policy-decision/1` (rule `failure-table@1`): in enforce mode `entitlement_unavailable` is `denied` with outcome `block`; `continued_with_gap` is refused |
| Required DLP unavailable | Deny | same rule for `dlp_unavailable` |
| Hard budget reservation unavailable | Deny | same rule for `budget_unavailable` |
| Policy engine error or timeout | Deny for any enforcing policy that can block, redact or require approval | `policy/1` refuses `continue_with_gap` on such a policy; `policy-decision/1` refuses `continued_with_gap` when `controlClass` is `hard` in enforce mode |
| Optional analytics or telemetry unavailable | Continue only under an explicit policy, with durable delivery (local spool) and a visible gap | `continued_with_gap` (outcome `allow`) only in monitor mode or for a `log_only` control |
| Invalid or expired policy bundle | Deny, unless an explicitly approved last-known-good bundle is still within its own validity | `policy_invalid`/`policy_expired` are `denied`, or `last_known_good` with `lastKnownGood: { contentSha256, reason }` recorded; no other failure may use a last-known-good; `policy-bundle/1` `notAfter` after `issuedAt`, `lastKnownGoodApproved` |
| Output policy on a stream | Released content cannot be withdrawn: a hard output policy needs `buffer_full` or `buffer_window` | `policy/1` refuses `pass_through` for enforcing output policies |

`enforced` is true exactly in enforce mode, so a monitor decision can never read as enforced and an enforce decision
never as advisory.

## 4. Data model (the contracts in this PR)

All contracts are in `src/platform/contracts/`; each validator is strict (an unknown key is a problem), pure, and
reports `"<path>: <rule>"` without ever echoing a value. Shared value rules: token counts are canonical integer
strings (whole tokens; no `+`, leading zeros or `-0`); money and quantities are canonical decimal strings (§9);
currencies come from an embedded ISO 4217 list (`iso4217.ts`, with its source and date); generic identifiers never
contain `@`, so no email address can be an id; model ids may carry one `@` revision (`model@20260901`) but never an
email shape; a human is only ever a `ps1:` pseudonym, a service a `svc:` id, an agent an `agt:` id.

### 4.1 Economics (Stream A)

| Contract | Purpose | Key rules |
|---|---|---|
| `ai-usage-event/1` (`AIUsageEvent`) | One invocation attempt as observed by one source (the owner's envelope) | `tenantId` from trusted ingress; dedup by `sourceConnectionId` + source-stable `dedupKey`; append-only, corrections via `supersedes`; `usageBasis` reported vs estimated never mixed; `modelRequested` vs `modelServed`; `attempt` (retries are separate, possibly billed attempts); `receivedAt` not before `occurredAt`; token categories as whole-token strings with a required `accountingProfile`; `tokenUsage` absent = usage unknown (e.g. a failed call), never 0; `status` succeeded/failed/cancelled/unknown; `evidenceRef` |
| `ai-financial-record/1` (`FinancialRecord`) | One money record with provenance | Kinds `billed`, `effective`, `estimated_invocation`, `credit`, `adjustment`, never summed together; an estimate is priced at a contract or public list rate and names its `rateCardRef` version; a credit is negative or 0; `configSha256`; unique links to usage events (link, not copy) |
| `rate-card/1` (`RateCard`) | Versioned, effective-dated prices per provider, model, SKU, token category and service tier | Prices are non-negative decimal strings; cache and batch are explicit rows (category `cachedInput`/`cacheWrite`, tier `batch`), **never multipliers**; provenance fits the basis (public list from a public price page or owner entry; contract from a contract, invoice or owner entry) |
| `allocation/1` (`Allocation`) | Rule-based allocation of one amount in one currency and basis | Shares + explicit `unallocated` equal the source amount **exactly**; shares and remainder share the source's sign; one share per target; user targets are pseudonyms, service targets `svc:` ids; a non-zero remainder carries reason codes; methodology id and version recorded |

**Accounting profiles** say how a provider's token categories relate. The profile id is required whenever usage is
present; no total is computed without it. Per public documentation, **to be verified live** (Stream A, slice A2):

| Profile (draft) | input | cachedInput | cacheWrite | output | reasoning |
|---|---|---|---|---|---|
| `openai-chat/1` (Chat Completions / Responses style) | includes cached tokens | subset of input | n/a | includes reasoning tokens | subset of output |
| `anthropic-messages/1` (Messages style) | excludes cache reads and writes | additive | additive | — | — |

**OpenTelemetry GenAI mapping** (map, do not rename the envelope; the attributes are at Development status, so the
mapping pins a semantic-conventions version in Stream A):

| Envelope | OTel GenAI attribute |
|---|---|
| `provider` | `gen_ai.provider.name` |
| `modelRequested` / `modelServed` | `gen_ai.request.model` / `gen_ai.response.model` |
| `providerRequestId` | `gen_ai.response.id` |
| `tokenUsage.input` / `output` | `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` |
| `tokenUsage.cachedInput` / `cacheWrite` | `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_creation.input_tokens` (Development; a secondary source reports `input_tokens` includes cached tokens, which is why the accounting profile is mandatory) |
| content (`gen_ai.input.messages`, `gen_ai.output.messages`) | **not captured**: content capture is opt-in in OTel and off in Ratio |

**Attribution chain**: provider account/project → application/workload → team/cost center → user or service identity
(only when available and authorized). **Allocation coverage** (share of cost attributed to a workload) and
**reconciliation coverage** (share of estimated cost matched to billed cost) are reported independently; neither
implies the other.

**Estimates versus bills.** A gateway or usage-report estimate (`estimated_invocation`) and the provider's bill
(`billed`) are separate records linked by usage event ids and period. Reports show billed cost as the cost and the
estimate as a cross-check, with the variance and its explanation (rate card version, unmatched usage, credits,
rounding, timing). They are never added together.

### 4.2 Adoption and utilization (Stream B)

| Contract | Purpose | Key rules |
|---|---|---|
| `activity-event/1` | One qualifying-activity observation | Same actor rules as usage events; `activityKind` is a source-defined id |
| `eligibility-snapshot/1` | Who was eligible on an effective date, from one identity source | Human and service populations separate; counts plus a sha256 of the sorted pseudonymous member refs (no member list in the record); exclusions with reason codes and counts; `licensedSeats` absent = unavailable, and only on a human population |
| `adoption-definition/1` | Versioned, effective-dated metric definition | Metrics: adoption rate, seat utilization, activity frequency, workload utilization, service activity (always separate); human metrics count humans only; service activity counts services and agents only (never `unknown`); actor types and activity kinds are unique; each metric's allowed denominator is fixed; a missing denominator is reported as "denominator unavailable" |

Reports are aggregate by default; user-level drill-down is a separate permission (§8). Activity is never presented as
productivity or value.

### 4.3 Policy and access (Stream C)

| Contract | Purpose | Key rules |
|---|---|---|
| `entitlement/1` | Tenant/team/user/workload/service × provider × models, effective-dated | `*` stands alone; models unique; a user subject is a `ps1:` pseudonym, a service subject a `svc:` id; deny entitlements win and the gateway checks the requested **and** the served model (evaluation rules for Stream C) |
| `policy/1` | Versioned policy for one phase (`pre_request`, `pre_response`, `stream_chunk`) | Closed set of deterministic conditions; actions allow/block/redact/require-approval/log-only; mode monitor/enforce; per-policy timeout and failure handling, fail-closed for enforcing policies; output policies must buffer |
| `policy-bundle/1` | What Ratio distributes to a gateway | Single tenant; `notAfter` after `issuedAt`; `contentSha256`; **required** ed25519 signature (88 base64 characters; verified from slice C2); unique policy and entitlement id/version; last-known-good approval flag |
| `policy-decision/1` | One evaluation | Outcome, `enforced` (true exactly in enforce mode), `controlClass` (`hard`/`log_only`), rule ids, reason codes, failure and its handling per §3.3 (incl. `last_known_good` with the bundle digest and reason), offsets-only findings, latency in microseconds; **no content** |
| `DlpFinding` | One detector hit | Category, detector id and version, confidence, location, start/end offsets in the normalized text, normalization steps; **never the matched text** |
| `gateway-request/1` | One request seen by a gateway | Sizes and **keyed** digests (`hm1:`) only; an output digest needs its size; a request not dispatched has no output, served model, usage event or release; link to its usage event |

`budget-reservation/1` (2.0) is specified in Stream C's enforcement slice, not here.

### 4.4 Connections (all streams)

`connector-declaration/1`, with the ladder in §6.

### 4.5 Versioning rules

- `schemaVersion` is `<name>/<major>`. Any change to what a validator accepts (a key, its optionality, an enum or a
  rule) is a new major.
- **Pin** (`schemaPin.test.ts`): sha256 of each validator's canonical description: the structure, enums and the id
  and version of every predicate and cross-field rule (`currency@2`, `failure-table@1`). Problem labels are NOT part
  of it, so rewording a label needs no new major. Changing a predicate's behavior means bumping its rule version,
  which changes the pin.
- **Golden corpus** (`src/platform/contracts/corpus/<name>.<major>.json`, 210 hand-reviewed SYNTHETIC cases): each
  case records whether it is accepted and at which problem paths it is rejected. A behavior change that keeps the
  rule id (e.g. widening the currency rule) fails here even when the pin does not move. Corpus edits are reviewed as
  contract changes.
- **Supported versions**: `SCHEMA_VERSIONS` lists what readers accept. The test requires a pin and a corpus (with
  accepted and rejected cases) for every listed version and nothing else, so an old version keeps its pin and
  corpus until the PR that removes its reader. A new major ships with a reader for the old one and a migration test
  that converts or rejects every old corpus case explicitly.
- Limit: the pin cannot see a predicate's code; the corpus is the behavioral check, so its coverage matters (each
  rule has at least one accepted and one rejected case).
- Stored rows carry the schema version they were written with (a column in every new table, §12).

## 5. Module boundaries

```
src/platform/contracts/      shared types + pure validators (this PR). Imports only finops/semantic/decimal.
src/platform/economics/      Stream A: usage/cost file parsers, rate-card pricing, reconciliation, allocation (pure)
src/platform/adoption/       Stream B: pseudonymization, eligibility, metrics, drill-down authorization (pure + server)
src/platform/policy/         Stream C: the local evaluation library and DLP detectors (pure, no I/O, no clock)
src/platform/conformance/    Stream C: mock providers, mock gateway, conformance suite (tests only)
src/ingest/platform/         Stream A/B: worker commands that persist events (the worker owns all writes)
src/connectors/managed/      existing M0a registry; new retrievers register here (one line each)
pages/api/v1/platform/**     read APIs, behind the existing route wrapper and authorize()
```

Rules: contracts and the policy library are pure and importable from app, worker and a gateway plugin; nothing under
`src/platform/` reaches client code. The authority is `check:bundle` rule 7 on a production build: all 13 schema
version strings and the `ratio-platform-contracts` origin marker that every validator check carries are
client-forbidden, so any bundled contract module fails the build check. Before a build, `schemaPin.test.ts` scans
the source import graph transitively (re-exports included) and refuses a path from a client-side module (pages
outside `pages/api`, any `.tsx`, `src/components`, `src/store`); that scan is a heuristic, not the guarantee; the policy library
never imports a server, database or network module (boundary test, as `src/finops/semantic/boundary.test.ts` does);
writes happen only in the worker; the gateway integration is a separate process or container and never runs in the
UI server or the browser.

## 6. Connector contract and sequence

Every connector declares (`connector-declaration/1`): supported operations and the schema versions they emit,
required credentials and permissions, scope and granularity, pagination and completeness method, refresh cadence and
freshness target, dedup and correction strategy, rate limits and retries, privacy classification, and verification
status with limitations.

**Status ladder**: Configured → Authorized → Retrieved → Validated → Reconciled, never collapsed into "Connected".
It maps the existing M0a `ConnectorState` (`LADDER_FROM_MANAGED_STATE`, compile-time exhaustive):
`configured-not-verified` → Configured; `auth-verified` and `source-access-verified` → Authorized;
`extraction-completed` → Retrieved; `mapping-validated` → Validated; `reconciliation-passed` and `live-verified` →
Reconciled (live verification is a separate status); `not-configured`, `degraded`, `failed`, `simulated` are shown as
themselves.

**Sequence**: (1) direct model-provider usage/cost, (2) existing cloud billing (the 1.0 FOCUS path), (3) OTel and
application events, (4) identity/eligibility source, (5) gateway enforcement integration, (6) license/utilization on
demand, (7) A2A over the same authorized capability services. Concrete vendors are chosen from the pilot
environment; no second vendor adapter of a kind is built before the first proves the shared contract.

## 7. Threat model for the gateway integration (STRIDE)

Scope: client → AI gateway (with the Ratio policy library) → provider; Ratio → gateway (bundles); gateway → Ratio
(decision, request and usage events).

| STRIDE | Threat | Mitigation (owner of the test) |
|---|---|---|
| Spoofing | Client claims another tenant, workload or user in a header | Gateway resolves identity from its own credentials (virtual keys, mTLS, OIDC); `tenantId` set by trusted ingress; claimed ids ignored (C3 conformance) |
| Spoofing | External A2A agent claims an identity | A2A peers authenticate as `agent` principals with their own grants; a claimed identity is never trusted (1.3 A2A slice) |
| Tampering | Modified or replayed policy bundle | `contentSha256`, ed25519 signature, monotonic `version`, `notAfter`; gateway refuses lower versions and expired bundles (C2) |
| Tampering | Streaming smuggling: content split across chunks to evade per-chunk checks | Windowed buffering with overlap of at least the longest detector span; hard output policies require `buffer_full`/`buffer_window` (C4) |
| Repudiation | A decision cannot be tied to a policy | Every decision records bundle id and version, rule ids, reason codes and timing; append-only storage (A1/C5) |
| Information disclosure | Prompts or responses stored in logs or events | No content fields in any contract (strict validators); keyed digests only; OTel content capture off; log redaction tests (all streams) |
| Information disclosure | Pseudonym reversal | Keyed HMAC per tenant; the key never leaves the secret store; rotation by key id (B2) |
| Denial of service | Oversized inputs exhaust the inspector | `input_bytes_over` condition; bounded inspection (max bytes, max decoded candidates, max decode depth); over-limit input is blocked when an enforcing policy requires inspection (C3) |
| Denial of service | Policy evaluation latency | Per-policy `evaluationTimeoutMs`; fail closed for enforcing policies; latency recorded per decision (C3) |
| Elevation of privilege | Entitlement change by conversation (Frank) | Entitlements change only through the reviewed config path with approval; Frank has no write tool for them (§10.3) |

**Bypass paths** (each gets a documented assessment and, where the gateway can prove it, a test; the bypass
assessment document is a Stream C deliverable):

| Bypass | Control | Evidence |
|---|---|---|
| Direct provider calls with keys held outside the gateway | Provider keys exist only in the gateway's secret store; workloads get gateway credentials; provider-side key inventory reviewed; usage seen in provider reports but not at the gateway is reported as **unrouted traffic** (Stream A reconciliation) | Reconciliation fixture with unrouted usage; key-inventory checklist (live) |
| Egress not restricted | Network policy allows provider endpoints only from the gateway; documented per deployment | Owner-run network test (live only) |
| Alternate endpoints (regional, batch, files, realtime, embeddings, assistants) | Destination allowlist per surface; unknown surface → deny in enforce mode | Conformance cases per surface (C3) |
| Tool and function-call payloads | Tool arguments and tool results inspected as `tool_arguments`/`tool_result` | DLP cases in tool payloads (C4) |
| Encoding tricks against DLP | NFKC, zero-width removal, bounded base64/hex/URL decoding of candidates | Seeded encoded fixtures (C4) |
| Oversized inputs | Size limits before inspection; fail closed | Conformance case (C3) |
| Timeouts | Fail closed for enforcing policies; fail-open only for monitor/log-only with a visible gap | `policy/1` validator (this PR) and conformance (C3) |
| Streaming smuggling | Windowed buffering; release control | Conformance (C4) |
| Prompt injection | Treated as a `signal` input, never a guarantee; least-privilege tools | Documented limitation |
| Gateway itself down or misconfigured | Fail closed; coverage panel shows "gateway coverage unknown", never "100% protected" | UI slice |
| Provider-side model fallback (the served model differs from the requested one) | Entitlement is checked on `modelServed` as well as `modelRequested`; a disallowed served model blocks release (enforce) or is recorded as a violation (monitor) | Conformance case with a mock fallback (C3) |
| Gateway response caches | A cached response is released only through the same output policy as a fresh one; a cache hit records its own decision | Conformance case with a cache hit (C3/C6) |

## 8. Privacy model

- **Pseudonymous user ids**: `ps1:<keyId>:<hex>` = HMAC-SHA256 under a per-tenant key over the length-prefixed
  tuple (tenant id, IdP issuer `iss`, IdP subject `sub`) from the OIDC binding: `sub` is unique only per issuer, and
  an email is never an input. Rotation creates a new key id; old refs stay valid for their retention window and are
  never re-keyed silently. The key lives in the secret store (`secretRef`, as in engagement config), never in the
  database. No contract field that names a person accepts anything but a `ps1:` ref, and generic ids refuse `@`.
- **Content digests** (`hm1:<keyId>:<hex>`): HMAC-SHA256 under a separate per-tenant **digest key**, never the
  pseudonym key. The gateway gets it from its own secret store (provisioned by the operator, scoped to one tenant and
  one gateway deployment, rotated by key id); it is never in a policy bundle and Ratio needs it only to compare
  digests, not to compute them. Digests are comparable only within one key id.
- **No raw content by default**: only sizes, keyed digests (`hm1:`), categories, detector and rule ids, offsets and
  decisions are stored. Opt-in content capture is out of scope for this program and would need its own ADR.
- **Retention**: configurable windows per record class (usage events, decisions, activity, snapshots, request
  records), with deletion jobs that write an auditable run record and are tested for throughput (§10.1).
- **Authorized drill-down**: a new permission (proposed `usage:drilldown`), separate from `reports:read`, never
  granted by a team (role-only, like the admin permissions in `authz.ts`), audited per access. Aggregates have a
  minimum group size (proposed k = 5) below which cells are suppressed.
- **Differencing** (known limitation): two allowed aggregates whose groups differ by fewer than k people can reveal
  those people. Rule for Stream B's read API: a query is refused when its group differs by fewer than k members from a
  group the same principal queried in the same period (tracked in the drill-down access log), and totals are not
  offered for both a group and a sub-group that differ by fewer than k. Noise addition is out of scope until needed.
- **Service accounts and agents are separate from humans** everywhere: actor type, refs (`svc:`/`agt:`), populations,
  metrics and reports.

## 9. Currency and rounding

- Amounts and quantities are exact decimal strings end to end (BigInt arithmetic, `src/finops/semantic/decimal.ts`);
  no float, no `toFixed`, no rounding before display.
- Canonical form: no `+`, no leading zeros (`0.5`, not `00.5`), no exponent or grouping, never `-0`; trailing zeros
  are kept because they carry the source's scale (`9.9000`), so equality and dedup compare values exactly (BigInt),
  never strings. Token counts are canonical integer strings.
- Currencies are validated against the embedded ISO 4217 list (active codes as of 2026-01 plus codes withdrawn since
  2023 that still appear on historical invoices); adding a code is a contract change.
- Never sum across currencies or across financial kinds; each total is per currency and per basis.
- N/A is not 0: a missing amount, rate, usage, denominator or allocation is shown as N/A with a reason code.
- Display rounding happens once, at render, half-even, to the currency's minor unit, with the exact value available
  in exports.
- A conversion between currencies, if ever added, is a separately labeled derived figure with its rate source and date.

## 10. Operations, AI boundaries and coverage

### 10.1 Capacity

Modular app plus bounded workers with durable job state; object storage for evidence; incremental aggregation; the
gateway deployed independently of the UI; per-tenant quotas. Scale-out steps are taken only when measured:

| Trigger (measured) | Step |
|---|---|
| Sustained event ingest lag above target | A collector or event stream in front of the worker |
| Report latency above target on the operational store | An analytical store for aggregates |
| Evidence volume growth | Object-storage lifecycle rules |
| One tenant starving others | Per-tenant queues |
| Data residency requirement | A regional boundary |

Workload test plan (no RPS is claimed before it runs): sustained and burst event rates, maximum tenants and
connections, ingestion lag, report latency, policy-decision latency (p50/p99 in the library and at the gateway), queue
recovery after a worker kill, RPO/RTO from backup and restore, retention/deletion throughput. Targets are the
customer-approved capacity and recovery objectives (2.0 Operations).

### 10.2 UI coverage panel (spec for a later slice)

| Row | States |
|---|---|
| Billing sources | retrieved / reconciled / stale |
| Workload attribution | attributed / unknown |
| Identity coverage | human / service / unresolved |
| Usage telemetry | reporting / delayed / missing |
| Gateway coverage | routed traffic / scope unknown |
| Policy enforcement | enforced / monitor-only / unavailable |

Every percentage has a known denominator; "100% protected" is never shown when only routed traffic is observed;
sample data is visibly separate; "View evidence" opens the observation and the test behind each number.

### 10.3 Frank and AI boundaries

Frank may explain, suggest mappings, draft configurations, compare scenarios, summarize evidence and propose changes
with references. Frank must not invent usage or eligibility, approve its own mappings or policies, change
entitlements by conversation, trust an external agent's claimed identity, or mark anything verified without test
evidence. "Ask Frank" inherits the current user's resource permissions (the same `authorize()` decision).

## 11. North-star acceptance test (first enterprise milestone)

One approved identity source, one AI application, one model provider, one billing source and one enforced gateway
path, end to end: **who used it, what was consumed, what it cost, which policy applied, and the evidence behind every
claim.** Pre-release, the same test runs with synthetic fixtures and the mock gateway (`northStar.acceptance` suite,
assembled in 2.0); live, it runs in the owner's pilot environment.

## 12. Migration plan and reserved numbers

No migration in this PR. The runner refuses a pending migration older than the newest applied one (`OUT_OF_ORDER`,
`src/ingest/db/migrate.ts`), so once a database applies 0020 it can never apply 0005–0019. Decision (option a,
ordered bands): **every 1.0-line number (0005 R4 trust views, 0006 E2 enrichment, 0007–0019 for the 1.0 line and
the slice 3-5 forecasts) is merged or released before any 0020+ migration merges**, and inside the platform band
numbers merge in ledger order (a slice can merge its pure code earlier and its migration later).

The ledger is `docs/migrations/ledger.json` (number or range, name, release line, status `merged`, `reserved`,
`released` or `retired`). `src/ingest/db/migrationLedger.test.ts` is the guard, in the normal test suite: it fails
when a migration file has no `merged` ledger entry with the same name, when a `merged` entry has no file, when lines
are out of order, and when **any** lower number is still `reserved`. So the PR that adds `0020_*` fails until the
orchestrator has merged or released 0005–0019. Today 0003 is `retired` (unusable once 0004 is applied).

Consequence for 1.0.x after the band opens: a database upgraded to 1.1 (0020+ applied) cannot take a lower number,
and a 1.0.x database that took a higher hotfix number would later refuse 0020+. So 1.0.x patch releases after the
first platform migration merges are **code-only**; a schema fix ships as the next free number above the highest
merged one, in a 1.1.x (or later) release that carries every lower migration.

| Number | Stream / slice | Release | Tables (all tenant-scoped with RLS, append-only where noted, `schema_version` column) |
|---|---|---|---|
| 0020 | A1 | 1.1 | `platform_connections` (declaration, ladder step, verification), `platform_evidence_refs` |
| 0021 | A2 | 1.1 | `ai_usage_events` (append-only; unique `(tenant_id, source_connection_id, dedup_key, revision)`; `supersedes`) |
| 0022 | A3 | 1.1 | `rate_cards`, `rate_card_entries` (versioned, effective-dated) |
| 0023 | A4 | 1.1 | `ai_financial_records`, `usage_financial_links`, `reconciliation_variances` |
| 0024 | A5 | 1.1 | `allocation_runs`, `allocation_shares` (unallocated explicit) |
| 0025 | B1 | 1.2 | `pseudonym_keys` (key ids and status only; material in the secret store), `service_identities` |
| 0026 | B2 | 1.2 | `eligibility_snapshots`, `eligibility_members` (pseudonymous refs) |
| 0027 | B3 | 1.2 | `activity_events` (append-only), `adoption_definitions`, `licensed_seat_inputs` |
| 0028 | B4 | 1.2 | `retention_policies`, `deletion_runs`, `drilldown_access_log` |
| 0029 | C2 | 1.3 | `policy_bundles`, `policies`, `entitlements` (versioned) |
| 0030 | C5 | 1.3 | `policy_decisions`, `gateway_request_records`, `dlp_findings` (offsets only) |
| 0031 | C6 | 2.0 | `budget_reservations`, `budget_settlements` |
| 0032–0039 | spare | — | released by the orchestrator in order |

Every migration is expand-only (the runner's `EXPAND_NOT_ADDITIVE` rule), ships its manifest and a `.db.test.ts`, and
pins its schema version in a migration test.

## 13. Slice plan (three parallel streams)

Size budget per slice PR: production ≤ 400 lines, tests ≤ 600, evidence ≤ 150 lines per file; tests first; mutation
check; full gates; feature flag off. Each slice lists its acceptance tests; fixtures are SYNTHETIC.

**Dependencies.** All streams depend on this PR (contracts). A1 (connections and evidence refs) precedes migrations
in B and C. B1 (pseudonymization) precedes any stored human `actorRef` in A or C. C1 (library) needs nothing but the
contracts. C5 (decision storage) needs A1. C7 (A2A) needs C1 and B1. The north-star test needs A2–A4, B1–B3 and C1–C5.

### Stream A: foundation and economics (caps 1, 4) — release 1.1

| Slice | Scope | Acceptance tests |
|---|---|---|
| A0 | Evidence manifest: `docs/evidence/platform/manifest.json` mapping each capability's evidence cell to test names; collector section that reports per-capability status from the vitest JSON (non-gating) | Manifest test names exist; a missing or failing test yields "not validated"; status never exceeds "pre-release validated" |
| A1 | Connections registry (declaration + ladder from M0a), evidence refs, the per-instance `platform` opt-in flags (D7); migration 0020 (after 0005–0019 are merged or released, §12) | Ladder never shows "Connected"; tenant isolation (RLS) tests |
| A2 | Provider usage FILE import, OpenAI-style and Anthropic-style usage reports modeled from public documentation (field mappings marked "per public docs, to be verified live"); accounting profiles; dedup, corrections via `supersedes`, late arrivals; migration 0021 | Re-import is idempotent; a correction appends; overlapping vs additive categories never double-count; absent tokens stay N/A |
| A3 | Versioned rate cards and pure pricing (`estimated_invocation`), cache and batch rows; migration 0022 | A missing rate is a visible gap, not 0; rate version recorded on every estimate |
| A4 | Cost FILE import (provider cost reports), link to existing cloud billing (FOCUS, `ai_billed_cost` view); estimate-vs-billed reconciliation with explained variances and unrouted/unmatched charges; migration 0023 | Approved-source fixture reconciles to control totals; unmatched charges listed; no cross-currency sum |
| A5 | Workload allocation with explicit unallocated; allocation coverage and reconciliation coverage reported separately; migration 0024 | `allocation/1` exactness; coverage denominators known |

### Stream B: adoption and utilization (caps 2, 3) — release 1.2

| Slice | Scope | Acceptance tests |
|---|---|---|
| B1 | Pseudonymization: per-tenant HMAC keys by `secretRef`, rotation by key id, `svc:`/`agt:` registry; migration 0025 | Same tenant, issuer and subject + key → same ref; same subject under another issuer or tenant → different ref; rotation does not rewrite history; email never accepted as a subject |
| B2 | Eligibility snapshots from the engagement directory and OIDC bindings (active memberships; suspended excluded with a reason); migration 0026 | Numerator and denominator reproducible from fixtures; `memberSetSha256` stable; exclusions tested |
| B3 | One activity source (a file or OTel event import), adoption definitions and metric computation; licensed-seat input; migration 0027 | Human metrics exclude services; "denominator unavailable" when missing; versioned definitions give identical numbers on re-run |
| B4 | `usage:drilldown` permission (role-only, audited), minimum group size, retention policies and deletion jobs; migration 0028 | `reports:read` alone cannot drill down; deletion removes rows and writes a run record; suppression below the threshold |

### Stream C: policy contract, local evaluation and conformance (caps 5–8) — releases 1.3 (monitor) and 2.0 (enforce)

| Slice | Scope | Acceptance tests |
|---|---|---|
| C1 | Pure policy evaluation library: entitlement check, condition evaluation, decision assembly; no I/O, no clock injected except as an argument | Allow, block, redact, require-approval, log-only per rule; deny entitlements win; deterministic for the same inputs |
| C2 | Bundle build, canonical digest, ed25519 signing and verification (Node `crypto`, no new dependency); last-known-good; migration 0029 | Tampered, replayed, expired bundles refused; approved last-known-good honored only within validity |
| C3 | Mock providers (OpenAI-compatible and Anthropic-compatible request shapes) and the mock gateway; conformance suite for pre-dispatch blocking, timeouts, oversized inputs, alternate surfaces | A blocked request is never dispatched (mock provider receives zero calls); fail-closed on timeout and engine error |
| C4 | DLP detectors (card numbers with Luhn, US SSN validity rules, IBAN mod-97, cloud/API key patterns, private key blocks, email, phone, custom regex/dictionaries) with normalization; streaming windows; tool payloads | Seeded sensitive-data fixtures are blocked before the mock provider sees them; encoded variants caught; findings carry offsets only |
| C5 | Decision and request record ingestion from a gateway (monitor-only), coverage figures; migration 0030 | Monitor decisions never enforced; gaps visible when telemetry is missing |
| C6 | Gateway integration design for the pilot pick (ext_proc or custom guardrail plugin), bypass assessment document; 2.0: blocking for one workload, budget reservations (migration 0031), partial-failure handling | Bypass table assessed; outage, streaming and partial-failure tests at the conformance level; live tests in the pilot |
| C7 | Read-only A2A (1.3) over the same authorized capability services: the reserved `agent` principal of `authz.ts` becomes a provisioned, tenant-bound principal with its own grants; messages and tool results pass the same policies | External-client authorization tests (claimed identity ignored); artifact isolation between tenants and engagements |

## 14. Evidence plan per capability

The evidence manifest (A0) lists these tests; `scripts/evidence/collect-pr-evidence.mjs` reports them under a
"Platform capability evidence" section. Pre-release status comes from synthetic fixtures and the mock gateway;
live status needs the owner's environment and a signed evidence record (M0b pattern).

| Cap | Owner's evidence cell | Pre-release tests and fixtures | Report artifact | Live verification |
|---|---|---|---|---|
| 1 | Approved-source imports reconcile; unmatched charges and allocation gaps visible | A4 control-total fixtures per currency; unmatched-charge fixture; A5 allocation exactness and unallocated reasons | Reconciliation table with variance reasons; allocation coverage | One approved billing source reconciles in the pilot |
| 2 | Numerator and denominator reproducible; identities and exclusions tested | B2/B3 re-run determinism; exclusion and suspended-user fixtures; `adoption-definition/1` rules (this PR) | Adoption metric with definition version and snapshot id | Pilot identity source snapshot |
| 3 | Authorized drill-down, service-account separation, retention and privacy | B4 permission tests; actor-type rules (this PR); deletion job tests; log redaction tests | Drill-down audit log; retention run records | Pilot retention run |
| 4 | Cache/batch semantics verified per provider; missing usage and rate gaps do not become zero | A2 accounting-profile fixtures; A3 missing-rate gap tests; `rate-card/1` explicit rows (this PR) | Token cost by category with rate card version | Each provider profile verified against live usage |
| 5 | Requests blocked before dispatch; bypass paths assessed | C3 zero-dispatch assertions; bypass assessment document | Decision log with rule ids | Pilot gateway path blocks a seeded request |
| 6 | Allow, block, timeout, streaming, partial failure tested | C1/C3/C4 conformance; `policy/1` fail-closed and buffering rules (this PR) | Conformance report | Pilot gateway conformance run |
| 7 | Seeded sensitive data prevented before prohibited transmission | C4 seeded fixtures incl. encoded and tool-payload variants | DLP findings (offsets only) | Pilot DLP run with seeded data |
| 8 | Disallowed models/providers rejected; credentials and network paths prevent bypass | C1 entitlement tests; C3 surface allowlist; bypass assessment | Entitlement decision log | Pilot network and key-inventory checks |

## 15. Consequences

- Positive: parallel streams share one versioned vocabulary; no monolith; the 1.0 line is untouched; claims follow
  evidence.
- Negative: a gateway integration still has to be built for the pilot pick; monitor-only comes before any blocking;
  migration order couples the streams (§12).
- Follow-ups: ADR-0002 for the pilot gateway choice; ADR-0003 if content capture is ever requested.

## 16. Not claimed until live verification

No capability is "enterprise supported". Specifically not claimed: any provider field mapping (all "per public docs,
to be verified live"); any accounting profile; any gateway's hook behavior; DLP recall on real traffic; latency or
throughput figures; bypass prevention outside the owner's network; OTel attribute stability. The highest status this
program can reach without the owner's environment is "implemented and pre-release validated; live verification
scheduled".

## 17. Defaults that need an owner decision

1. Gateway: Ratio is not the production gateway; a local evaluation library + bundles + mock gateway for conformance;
   pilot shortlist Envoy AI Gateway (ext_proc) and LiteLLM (custom pre_call guardrail); final pick per pilot.
2. Fail closed by default; continue-with-gap only for monitor-only or log-only policies.
3. DLP: deterministic detectors with normalization, no ML; prompt-injection classifier only as a signal.
4. No real provider calls or credentials in tests; live verification with owner-provided credentials later.
5. No new runtime dependency (ed25519 and HMAC via Node `crypto`).
6. Feature flags off in engagement mode until the owner enables each capability.
7. Release numbering 1.1 / 1.2 / 1.3 / 2.0 as in the roadmap.
8. Migration band 0020–0039 for the platform in ledger order; 0005–0019 must be merged or released before 0020 merges
   (option a, guarded by the ledger test); 1.0.x patch releases are code-only after that.
9. `ai_usage_events` (0021) becomes the owner source of the `ai_usage` view instead of "E2 enrichment (migration
   0006)" for AI usage; E2 keeps inventory mapping.
10. New permission `usage:drilldown`, role-only (proposed for `tenant_admin` only), minimum group size 5.
11. Pseudonym input is (tenant, IdP issuer, IdP subject) from the OIDC binding, never an email; a separate digest key
    for `hm1:` content digests, held by the gateway.
12. The usage `status` value is spelled `cancelled`, as in the owner's envelope (and in several provider APIs). The
    repository's U.S. English convention would give `canceled`; the serialized value is the owner's call, and a later
    change is a new `ai-usage-event` major.
13. Policy bundles are always signed (`policy-bundle/1` requires an ed25519 signature now; C2 verifies it).
14. Currencies from an embedded ISO 4217 list, including codes withdrawn since 2023 for historical invoices.
15. Per-instance opt-in `platform` block in the engagement config (D7), all flags default off.

## 18. Sources and verification status

Fetching was not possible from the authoring environment (the hosts `opentelemetry.io` and `focus.finops.org` were
outside its allowed network); the owner-provided references are cited as provided, and gateway facts come from web
search results on 2026-11-05. Each is to be re-verified before the slice that depends on it.

Owner-provided references:
- FOCUS for AI: https://focus.finops.org/technology-categories/focus-for-ai/
- OpenTelemetry GenAI attribute registry: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
- OpenTelemetry blog, GenAI observability (2026): https://opentelemetry.io/blog/2026/genai-observability/
- OWASP Cheat Sheet Series: LLM Prompt Injection Prevention; AI Agent Security
- FinOps Foundation: token economics and GenAI cost tracker guides

Desk research (search results; secondary sources flagged):
- LiteLLM custom guardrail modes and streaming hooks: https://docs.litellm.ai/docs/proxy/guardrails/custom_guardrail
- LiteLLM Enterprise-gated guardrail integration example: https://docs.litellm.ai/docs/proxy/guardrails/aporia_api
- Envoy AI Gateway ext_proc architecture and license (package listings): https://pkg.go.dev/github.com/envoyproxy/ai-gateway@v0.1.5 ; rename and guardrail status (secondary): https://www.truefoundry.com/blog/envoy-ai-gateway-review
- Kong AI Prompt Guard and AI Semantic Response Guard: https://developer.konghq.com/how-to/use-ai-prompt-guard-plugin/ ; https://developer.konghq.com/plugins/ai-semantic-response-guard/
- Portkey gateway license and self-hosting (secondary): https://geekflare.com/open-source/portkey-gateway/
- Cloudflare AI Gateway guardrails and DLP: https://developers.cloudflare.com/ai-gateway/features/guardrails/set-up-guardrail/ ; https://developers.cloudflare.com/ai-gateway/features/dlp/set-up-dlp/
- OTel GenAI cache-read attribute and stability (spec page and secondary): https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/ ; https://dev.to/mr_manushukla/opentelemetry-genai-conventions-zero-stable-genai-attributes-in-2026-and-what-to-ship-anyway-1l5h
