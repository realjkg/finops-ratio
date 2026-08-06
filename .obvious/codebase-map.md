# Codebase Map

Front-end (React) and back-end (Node.js) live in one Next.js app: `pages/` serves
the React front-end, `pages/api/*` are the back-end routes, and `src/` holds the
application source both sides share.

## Application source

| Directory | Purpose |
|---|---|
| `src` | React 18 + TypeScript application source for the Ratio FinOps platform. |
| `src/types` | Data model definitions for workloads, models, budgets, alerts, and agent queries. |
| `src/data` | Deterministic seed data for workloads, models, budgets, and alerts. |
| `src/lib` | Pure calculation helpers: forecast math, budget status, model comparison, demand shaping, gate derivation, billing period, formatting, scales, persona. |
| `src/store` | Zustand state store for selection, filters, thresholds, gates, demand shaping, and chat. |
| `src/components` | UI components for the 3-panel layout, workload list, detail tabs, agent chat, and top-level nav. |

## Client seams

Every integration point follows one pattern: a typed interface, a mock that works
offline over seed data, a live implementation, and a `create*Client(mode)` factory
that returns the mock by default. Call sites see only the interface.

| Directory | Purpose |
|---|---|
| `src/hello` | `HelloClient` — the reference seam the others copy. |
| `src/agent` | `AgentClient` — data-grounded mock responder plus an optional live Claude client. |
| `src/ai` | `AIClient` — server-proxied chat seam and the context builder behind `/api/v1/ai/chat`. |
| `src/cm` | `CMClient` — change-management seam (JIRA / ServiceNow) behind `/api/v1/cm/change`. |
| `src/costsource` | Cost-ingest seam: FOCUS v1.0–v1.4 schema, version-negotiation shim, value attachment, and the cloud/PointFive source adapters. Canonical FOCUS model for the repo. |
| `src/finio` | FinIO A2A interchange seam: FOCUS-shaped exchange with a peer agent, version negotiation, signed sessions, and FOCUS conformance validation. Reuses the `src/costsource` schema. |
| `src/prediction` | `PredictionClient` — forecast predictors, accuracy ledger, and reporting. |
| `src/tokenomics` | `TokenomicsClient` — token-level cost calculations. |

## Product surfaces

| Directory | Purpose |
|---|---|
| `src/findings` | Findings-first home screen, value-ratio meter, spend-to-value graph, recommendation math. |
| `src/executive` | Overview / initiative dashboard, snapshots, and XLSX + PDF report generation. |
| `src/mission` | Mission board, fleet header, adjustment gate, and accuracy-ledger summary. |
| `src/connectors` | Connector cards for the cost-source adapter registry. |
| `src/frameworks` | Governance-gate rows and the governance model. |

## Back end

| Directory | Purpose |
|---|---|
| `src/server/gateway` | Composable API gateway: method guard, payload-size limit, Bearer auth per tenant, sliding-window rate limiting, validation, error envelope, structured logging. Wrap every `/api` route with it. |
| `pages/api/v1` | Versioned back-end routes (`ai/chat`, `cm/change`, `a2a/handshake`, `finio/export`). New routes belong here. |
| `pages/api` | Unversioned routes: the `/hello` reference route, the costsource/prediction/report/tokenomics routes, and deprecated aliases for the FinIO routes. |

## Conventions

- Tests are `*.test.ts` colocated in `src/`, run by `npm test` (vitest). Route
  tests live under `src/` rather than `pages/` so Next never compiles them into
  deployed routes — see `src/ai/chatRoute.test.ts` and
  `src/finio/finioRoutes.test.ts` for the fake req/res pattern.
- Server-only modules (anything importing `crypto`, reading secrets, or holding a
  provider SDK) must never be re-exported from a slice's `index.ts`, or they end
  up in the client bundle.
