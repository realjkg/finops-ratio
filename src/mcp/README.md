# src/mcp: allowlisted, read-only MCP core

Checklist item 5.4. Pure, transport-independent TypeScript. There is no HTTP or
stdio transport, no MCP SDK, and no new dependency. Design sources:
`docs/design/frank-mcp/DESIGN.md` (a proposal, not an accepted design) and
`docs/design/sprint-mock-demo-mcp-rbac/PLAN.md`.

## Public API

`handleMcpMessage(message, ctx)` returns one JSON-RPC response, or `null` for a
notification. It never throws. `message` is raw JSON text (preferred) or a parsed value.
`ctx` (`McpContext`) carries the already-authenticated `Principal`, `deployEnv`,
`tenant`, an injected `clock`, an injected `provider` (`McpDataProvider`), an audit
`sink`, a `rateLimiter`, and optional `limits` and `policy`. Everything is exported
from `index.ts`. `testkit.ts` is for tests only.

Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Anything else returns
method-not-found with fixed text. Notifications are never answered.

## Tools (closed, frozen, defined in `tools.ts`)

`get_spend_summary`, `list_findings`, `get_forecast`, `get_allocation_summary`,
`get_budget_status`, `get_commitment_coverage`. The registry has no register
function. `registry.ts` checks every definition at module load (read-only access,
no write verb in the name, provider method is a get or list read, bounded and
non-free-text arguments, no tenant, account or user argument) and refuses to load
otherwise. The provider receives a scope built from the context (tenant, env,
subject, teams), never from arguments.

## Order of checks on tools/call

Size, depth and node caps with prototype-safe parsing; strict envelope; principal
expiry and principal tenant equal to context tenant; per-principal rate limit
(denied and invalid calls count); registry lookup; `authorize(principal, 'mcp.read',
{kind:'mcp_tool', id, env})` plus the role's tool class; strict argument schema;
`team` argument authorized again; provider under a time budget; output schema;
redaction; size cap; audit written before the result is returned. A failed or
slow audit write turns an allowed call into an internal error. Denials stay denials.

## Caps (defaults; each can be lowered or raised only up to a hard ceiling)

Message 8 KB, depth 8, 512 values, 2 KB per string, 64 B per key; arguments 2 KB;
result 32 KB; tool time 5 s; audit time 2 s; provider output 256 KB; rate limiter
sized by the deployment (the test default is 1,000 per minute). Schemas: strings at
most 2,048 characters, arrays at most 100, objects at most 32 properties.

## Assumptions the owner must confirm

1. Tool classes per role (`access.ts`): CTO summary tools; Finance cost tools;
   Procurement commitment tools; FinOps lead, eng lead (own teams) and auditor all;
   `legacy_service` none. Taken from PLAN 4.5 cell notes. The matrix is itself
   proposed until D2.
2. Team scoping (review fix): a principal whose `teams` is not `'*'` (the eng lead) must
   pass an explicit `team` it covers on every tool that has a team argument, and gets
   no tool without one: `get_commitment_coverage` is org-wide only and is hidden from
   `tools/list` for them. Provider rows are checked again: findings and budgets need a
   covered `team`, and team-keyed spend and allocation rows must be covered, else the
   whole result is refused. Consequence: allocation's untagged bucket cannot be shown
   to a team-scoped caller. Confirm this is the intended rule.
2a. `mcp.write` is denied for every role and environment (D6). No write tool exists.
3. Per-role scoping uses the existing `authorize()` matrix and role classes in code,
   not the allowlist file's `roles[]` fields (DESIGN 3.8, T-7), because no allowlist
   file or parser is built.
4. The provider is the only data path and is trusted to be read-only. DESIGN 3.5
   requires read-only by capability (a reader database login); this core cannot
   enforce that, so the provider implementation must.
5. Placeholder caps (OD-8): 2 KB arguments, 32 KB results, 5 s time budget, and the
   message and output caps above. No measurement backs them.
6. Oversize results are truncated with an explicit marker by default; DESIGN 3.6
   recommends rejecting. `policy.oversize: 'reject'` gives the design behavior.
7. Emails in results are masked by default (`policy.email`: mask, allow, reject).
8. Secret handling per tool (`onSecret`): reject for money tools; redact only for
   `list_findings`, whose titles are free text (DESIGN T7 on_secret).
9. Sensitive tools (allocation, budget, commitment) omit the argument hash from the
   audit record. Others record a SHA-256 of the canonical arguments.
10. Protocol versions 2025-06-18 and 2025-11-25 (handshake era). An unsupported
    requested version gets the latest supported one. The current revision,
    2026-07-28 (stateless, `server/discover`, per-request `_meta` version), is not
    implemented. The design could not read the spec; this build read it on
    2026-10-11.
11. Batches are refused (MCP 2025-06-18 removed batching; the design allows none).
12. The tenant is the context tenant; a principal whose `tenant` differs is refused.
    One token maps to one tenant today, so audit names the token subject.
13. Deploy env is the mapped `DeployEnv` (`dev`, `test`, `prod`), not the raw
    `RATIO_ENV` vocabulary; the transport maps it with `src/identity/envMap.ts`.

## Known gaps (not built)

No transport, allowlist file or parser, server or tool hash pinning, `roles[]`,
`teams[]` or `environments[]` fields, MCP client, stdio, kill switch (`FRANK_TOOLS`),
start-and-reload evaluation, A20 cases, model-vendor adapters (A21), golden-question
or certification harnesses, per-tenant model-token budgets, or a durable audit store.
The rate limiter is in-process and fixed-window (up to twice the limit across a
window boundary; a multi-instance deployment needs a shared store). Redaction is
pattern-based and incomplete: a novel secret format, or one split across fields,
passes. Money fields are checked for format only; reconciliation is the provider's
job. The core has been tested only against in-memory fakes, never a real provider.

## Tests

`npx vitest run src/mcp`. All offline and deterministic (fake clock, memory audit
sink, recording provider).
