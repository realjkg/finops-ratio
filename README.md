# Ratio platform

**AI-native FinOps for AI workloads.** Ratio governs *value ratios* — the return
on every inference dollar — not just raw cost. It pairs every cost with its value
context, forecasts daily and monthly spend, compares model costs, enforces
governance gates before scale, and answers cost questions through a data-grounded
agent.

This repository is **Phase 1**: a runnable, demo-ready app — a **React front-end +
Node.js back-end, unified in Next.js 14 (Pages Router)** — driven by seed data,
implementing the core acceptance criteria of the Ratio design spec. The front-end is
React pages and components; the back-end is Node.js API routes (`pages/api/*`) running
in the same Next.js process.

## Quick start

```bash
npm install
npm run dev      # serves the 3-panel Ratio UI on http://localhost:3000
```

```bash
npm run build    # production build (Next.js)
npm run lint     # ESLint
npm run typecheck # tsc --noEmit (also enforced in CI)
```

No external services, API keys, or auth are required to run the app — the Node.js
back-end runs in-process as Next.js API routes.

## Stack

**React front-end + Node.js back-end, unified in Next.js 14 (Pages Router).** The
front-end is React 18 pages and components (`pages/`, `src/`); the back-end is Node.js
API routes (`pages/api/*`) running in the same Next.js process — no separate server to
deploy.

- **React 18 + TypeScript** — front-end UI (pages + components)
- **Node.js API routes** (`pages/api/*`) — back-end (e.g. `pages/api/hello.ts`)
- **Next.js 14 (Pages Router)** — unifies front-end rendering and back-end routes
- **Tailwind CSS** — design tokens from the spec (§10) wired as theme colors + CSS vars
- **Zustand** — lightweight state (workloads, budgets, alerts, chat)
- **JetBrains Mono** (data/numbers) + **Instrument Sans** (prose) via `@fontsource`
- Deterministic **JSON seed data** — 7 workloads, a 7-model registry, budgets, alerts

## What's implemented (Phase 1)

The eight core acceptance criteria (spec §13) all work against seed data:

1. **Value paired with cost (R4)** — every workload, KPI, and agent answer shows the value ratio next to spend.
2. **Daily budget + live forecast** — today's budget bar with 70/90/100% thresholds, projected close, and monthly forecast with an 80% confidence interval and days-to-breach.
3. **Multi-model comparison** — what the same workload would cost on every registry model at current volume, cheaper in green / pricier in red.
4. **Thresholds** — editable soft/hard/kill percentages that drive the budget status.
5. **Governance gates (R3)** — sequential 4-gate enforcement; a gate can't pass until the prior one does, and Always-On is blocked until all four pass.
6. **Demand shaping (R2)** — six shapes, each with a projected monthly cost.
7. **Agent querying** — ask "why is my spend spiking?", "which model should I switch to?", "what's my riskiest workload?", "show today's budget status" and get specific, data-grounded answers.
8. **Unit economics (R1)** — cost per call / resolved query / active user / deflection, not cost per VM.

### Architecture

**Front-end (React) and back-end (Node.js) live in one Next.js app.** File-based
routing under `pages/` serves the React front-end; `pages/api/*` are the Node.js
back-end routes.

```
pages/
  index.tsx     Front-end: renders the 3-panel Ratio app (src/App.tsx)
  hello.tsx     Front-end: /hello reference slice (src/hello/HelloPage)
  api/
    hello.ts    Back-end: Node.js API route returning a HelloMessage (source: 'live')
src/
  types/        Data model (§2): Workload, ModelEntry, BudgetProfile, Alert, AgentQuery
  data/         Seed data: workloads, models, budgets, alerts
  lib/          Pure logic: forecast math (§6), derive, scales, budgetStatus,
                modelCompare, demandShape, format helpers
  store/        Zustand store — selection, gate sequencing, shape + threshold edits, chat
  agent/        AgentClient seam — MockAgentClient (default) + LiveAgentClient (Claude)
  components/
    layout/     Header (portfolio health) + Footer (alert ticker)
    workload/   Left panel: list, card, value-ratio bar, gate dots, filters
    detail/     Center tabs: Budget, Multi-Model, Governance, Demand, Unit, Alerts + KPI cards
    agent/      Right panel: chat + quick prompts
```

### The /hello reference flow

`/hello` is the reference front-end → back-end path. The React page `pages/hello.tsx`
renders `src/hello/HelloPage`, which talks to a typed `HelloClient` seam. The live
client fetches the Node.js back-end route `pages/api/hello.ts` (`source: 'live'`); the
mock client returns an in-memory greeting with no network. Same contract, swappable
implementation — mirroring the agent seam below.

### The agent seam

The agent is behind a clean `AgentClient` interface (`src/agent/`). With no key
set, a **data-grounded `MockAgentClient`** computes real answers from the seed
data — every cost cited with its value ratio (spec §7.1). Setting
`NEXT_PUBLIC_ANTHROPIC_API_KEY` swaps in `LiveAgentClient`, which calls Claude with a
system prompt rebuilt from current workload state. **The app runs fully without a
key.**

### FinIO — the agent-to-agent (A2A) interchange

FinIO is the agent-to-agent FinOps interchange layer: a way for the Ratio agent
to exchange cost-and-value data with another company's agent over plain HTTP/REST.
It is **not a new protocol** — it is FOCUS-shaped JSON moved through a small
handshake, behind the same typed client seam as `/hello` and the agent.

Two front-end routes: **`/finio`** is the public overview (what it is, what
crosses the wire, what v1 deliberately is not), and **`/finio/demo`** is the live
exchange — mock/live toggle, FOCUS version picker, and the returned rows. The
overview is served from the app rather than a marketing site on purpose: FinIO
needs server-side routes, which static site builders cannot run on any plan, so
hosting the explainer here keeps `/finio/demo` a real route instead of an iframe
and keeps the design tokens shared.

The exchange is two synchronous steps:

| Step | Route | Purpose |
|---|---|---|
| 1 | `POST /api/v1/a2a/handshake` | Authenticate the peer, negotiate a FOCUS version, mint a short-lived session. |
| 2 | `GET /api/v1/finio/export` | Return FOCUS rows shaped to the version that session agreed to. |

Both routes are composed with `withGateway` (method guard, payload limit,
per-tenant rate limit, structured logging, `{error:{code,message}}` envelope) and
sit under the `/v1/` prefix the API-First rule requires. The unversioned
`/api/a2a/handshake` and `/api/finio/export` paths remain as deprecated aliases.

**One schema, two transports.** FinIO does not define its own FOCUS types. Rows
are built by the same code as the cost-ingest doors (`src/costsource/`), so a row
that arrives over A2A is structurally identical to one that arrives through
`/ingest/focus` — full FOCUS v1.0 core columns, additive columns up to the
negotiated version, and the `x_Ratio*` value extensions that carry the
denominator FOCUS does not model (R4).

**Version negotiation is real, not decorative.** The responder honours any
version in the canonical v1.0–v1.4 range and emits rows shaped to whichever one
was agreed — the negotiated version is signed into the session token, so the
export cannot quietly ignore it. A version outside that range returns `409`
naming both sides.

**Trust boundary.** `FINIO_PEER_TOKEN` gates the handshake; when it is unset the
handshake does not enforce a peer token, so the offline demo runs with zero
config. A successful handshake returns a session id signed with
`FINIO_SESSION_SECRET` (random per process when unset) that carries its own
expiry — no server-side session map, so it works across instances. Sessions
travel in `X-FinIO-Session`, peer tokens in `X-FinIO-Peer-Token`; `Authorization`
is left to the gateway's per-tenant credential so two differently-scoped secrets
never collide on one header.

**Mock and live differ only in transport.** `MockFinioClient` runs the same
exchange rules as the route — same negotiation, same session expiry, same 400 /
401 / 409 messages — and both build rows from the same function. A test asserts
the two row sets are deep-equal.

**Out of scope for v1:** real auth infrastructure (OAuth, mTLS, key rotation),
persistence, multi-party fan-out, async/webhook push, full FOCUS column coverage,
and a genuinely external counterpart — live mode calls this app's own routes,
proving the transport path rather than a partner integration.

### Hosting FinIO alongside a static marketing site

FinIO needs server-side routes, so a static site builder (Webflow, Framer,
Squarespace) cannot run it on **any** plan tier — static hosting has nowhere to
execute `/api/v1/a2a/handshake`. The standard split is to keep the marketing site
where it is and put this app on a subdomain:

| Host | Serves |
|---|---|
| Marketing site (apex + `www`) | Static pages, unchanged |
| This app (e.g. `demo.<domain>`) | `/finio`, `/finio/demo`, and the API routes |

The subdomain is a DNS record pointing away from the marketing host, so it needs
no plan change there — the marketing site links out to it like any other URL.

**Required env for a serverless deploy:**

```bash
FINIO_SESSION_SECRET=<a long random string>   # see below — not optional here
```

`FINIO_SESSION_SECRET` is the one variable a serverless deployment genuinely
needs. Without it each instance signs sessions with its own per-process key, so a
handshake served by one instance mints a session the export rejects on another —
an intermittent `401` that reads like a broken exchange rather than a missing
config value. The app logs a warning on first use when it is unset in production.

Everything else stays optional. Leave `FINIO_PEER_TOKEN` unset for a public demo
so visitors can complete the handshake without a credential; set it to gate the
exchange to known peers.

One caveat for a public demo: the gateway's rate limit is per tenant, and
unauthenticated callers all share the `anonymous` bucket. That is fine for a demo
and wrong for anything load-bearing — real peers should carry their own API key
so they get their own bucket.

## Deferred to later waves

These need live services or secrets and are out of Phase 1 scope:

- Live Claude wiring is built but inactive until `NEXT_PUBLIC_ANTHROPIC_API_KEY` is set
- The standalone REST API engine + webhooks (spec §14, acceptance items 9–10)
- Slack/email report delivery (§9)
- Auth + team scoping (§11 Sprint 3+)

## Cloud cost connectors (ship dark)

Native cost-source connectors for the public clouds and private infrastructure
are wired into the cost-ingest seam (`src/costsource/`) and **ship dark**: each
is config-gated behind a feature flag and is registered as `configured: false`
(no network calls) until its flag and credentials are set. Like the PointFive
live adapter, only the adapter (auth/fetch) is source-specific — every connector
reuses the existing FOCUS v1.0–v1.4 → v1.4 normalization shim.

| Connector | Source id | Coverage | Feature flag | Required env |
|---|---|---|---|---|
| Azure Cost Management | `azure-cost-management` | public_cloud | `COSTSOURCE_AZURE_LIVE` | `AZURE_FOCUS_EXPORT_URL`, `AZURE_FOCUS_SAS` |
| AWS Data Exports | `aws-data-exports` | public_cloud | `COSTSOURCE_AWS_LIVE` | `AWS_FOCUS_EXPORT_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| GCP BigQuery FOCUS export | `gcp-bigquery-focus` | public_cloud | `COSTSOURCE_GCP_LIVE` | `GCP_FOCUS_BQ_DATASET`, `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` |
| Kubernetes (OpenCost / Kubecost) | `kubernetes` | private_cloud | `COSTSOURCE_KUBERNETES_LIVE` | `KUBERNETES_FOCUS_ENDPOINT` (+ optional `KUBERNETES_FOCUS_TOKEN`) |
| Nutanix Cloud Manager | `nutanix` | on_prem | `COSTSOURCE_NUTANIX_LIVE` | `NUTANIX_ENDPOINT`, `NUTANIX_API_KEY` |

The live FOCUS-export transport is a thin, clearly-marked seam: until a concrete
transport is injected, a configured connector reports an honest "not wired" state
rather than fabricating data.

Durable design rules live in `.obvious/obvious.md` (Design Guidance) and the
routine skills under `.obvious/skills/`. The full v1 design specification is
preserved as an ephemeral Obvious artifact (point-in-time snapshot), not checked
into the repo — see the `doc-authoring` skill for this workflow.

