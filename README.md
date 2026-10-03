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
with the supported range (`supported: ["1.0", …, "1.4"]`); the requested
value is never echoed.

**Trust boundary.** `FINIO_PEER_TOKEN` gates the handshake; when it is unset the
handshake does not enforce a peer token, so the offline demo runs with zero
config. A successful handshake returns a session id signed with
`FINIO_SESSION_SECRET` (random per process when unset) that carries its own
expiry — no server-side session map, so it works across instances. Sessions
travel in `X-FinIO-Session`, peer tokens in `X-FinIO-Peer-Token`; `Authorization`
is left to the gateway's per-tenant credential so two differently-scoped secrets
never collide on one header. The browser never holds the peer token (no
`NEXT_PUBLIC_` copy exists — it would be compiled into the client bundle), so
with `FINIO_PEER_TOKEN` set the `/finio/demo` page's live mode shows "peer
authentication required" and peer agents call the API with `X-FinIO-Peer-Token`.
In a gateway-authenticated deployment — `RATIO_API_TOKEN` set, or a live AI /
CM provider selected — the gateway's own `401` (missing `Authorization:
Bearer`) comes first, so the page shows a generic exchange failure rather than
the peer-auth guidance; call the API with both the Bearer token and
`X-FinIO-Peer-Token`.

**Mock and live differ only in transport.** `MockFinioClient` runs the same
exchange rules as the route — same negotiation, same session expiry, same 400 /
401 / 409 messages — and both build rows from the same function. A test asserts
the two row sets are deep-equal.

**Out of scope for v1:** real auth infrastructure (OAuth, mTLS, key rotation),
persistence, multi-party fan-out, async/webhook push, full FOCUS column coverage,
and a genuinely external counterpart — live mode calls this app's own routes,
proving the transport path rather than a partner integration.

## Deferred to later waves

These need live services or secrets and are out of Phase 1 scope:

- The live LLM path is built but inactive until `AI_PROVIDER` is set (see *AI providers* below)
- The standalone REST API engine + webhooks (spec §14, acceptance items 9–10)
- Slack/email report delivery (§9)
- Auth + team scoping (§11 Sprint 3+)

## Cost connectors — on-prem, private cloud, public cloud

Native cost-source connectors are wired into the cost-ingest seam
(`src/costsource/`) and are **live, credential-driven**: each connector goes live
as soon as its environment variables are set on the server — no feature flag, no
code change. Until then it reads as **available** and makes no network calls. Its
`COSTSOURCE_*_LIVE` flag is a kill-switch: set it to `false` to keep a configured
connector off (`true` makes a missing variable show as *incomplete* rather than
*available*). Only the transport (auth + fetch) is source-specific; every
connector reuses the FOCUS v1.0–v1.4 → v1.4 normalization shim and Ratio's value
denominator.

| Connector | Source id | Coverage | Required env | Optional env |
|---|---|---|---|---|
| Azure Cost Management | `azure-cost-management` | public_cloud | `AZURE_FOCUS_EXPORT_URL`, `AZURE_FOCUS_SAS` | — |
| AWS Data Exports | `aws-data-exports` | public_cloud | `AWS_FOCUS_EXPORT_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `AWS_SESSION_TOKEN`, `AWS_FOCUS_EXPORT_PREFIX`, `AWS_S3_ENDPOINT` |
| GCP BigQuery FOCUS export | `gcp-bigquery-focus` | public_cloud | `GCP_FOCUS_BQ_DATASET`, `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | — |
| Kubernetes (OpenCost / Kubecost) | `kubernetes` | private_cloud | `KUBERNETES_FOCUS_ENDPOINT` | `KUBERNETES_FOCUS_TOKEN` |
| Nutanix Cloud Manager | `nutanix` | on_prem | `NUTANIX_ENDPOINT`, `NUTANIX_API_KEY` | — |

How each one reads its data (`src/costsource/transports/`, web-standard APIs only
— no cloud SDKs, runs on Node 20+ and edge runtimes):

- **Azure** — lists the export container with the SAS (needs `r` + `l`), picks
  the latest run for each requested month and reads ONLY the blobs its
  `manifest.json` lists (no manifest, or a listed blob missing → error).
  `AZURE_FOCUS_EXPORT_URL` must name the container (+ optional path); a
  single-blob URL is rejected because one file cannot be verified as complete.
- **AWS** — `ListObjectsV2` + `GetObject` signed with SigV4 (verified against the
  AWS reference vectors); for each billing period in the window it reads ONLY
  the `dataFiles` of the `metadata/BILLING_PERIOD=YYYY-MM/…-Manifest.json`
  manifest (no manifest, or a listed file missing → error). `AWS_S3_ENDPOINT` points the same reader at an **S3-compatible store
  (MinIO, Ceph RGW, StorageGRID)** for on-prem / private-cloud exports.
- **GCP** — service-account JWT → OAuth token → parameterized BigQuery query over
  the window. `GOOGLE_APPLICATION_CREDENTIALS` may be a file path, inline JSON,
  or base64 JSON (for hosts without a filesystem).
- **Kubernetes / Nutanix** — HTTPS GET of the connector's FOCUS export endpoint.

Exports may be CSV, JSON, or NDJSON, optionally gzip-compressed. Parquet is
rejected with a clear message (configure the export as CSV). The endpoint URLs
may embed `{start}` / `{end}` placeholders for server-side window filtering.

**The location variable is the anchor.** Hosts often inject generic cloud
credentials (AWS keys on Lambda, Google ADC on GKE). A connector is only
*incomplete* once its location (export URL, bucket, dataset, endpoint) is set;
before that it is simply *available*.

**Real billing data is never served anonymously (deny by default).**
`GET /api/costsource/rows`, `/findings` and `/health` serve only the two
offline sandbox sources (`pointfive-sandbox`, `focus-file-sandbox`) without a
token. Every other source id — live connectors, PointFive live, and unknown ids —
requires `Authorization: Bearer <RATIO_API_TOKEN>` (compared in constant time)
and is refused outright when no token is configured; unknown ids answer 404 only
after authentication. The token must be at least 32 characters with at least 10
distinct characters: a weaker configured `RATIO_API_TOKEN` refuses live cost data
with 503 (sandbox sources are unaffected; the AI chat / change-management gateway
still accepts it but logs a one-time warning). Failed authentications — on rows, findings,
health, `/api/costsource/sources` and `/api/v1/connectors` alike — share one
count per client IP; after 1,000 in a minute that client's further failed
attempts get 429, while a request with the valid token always passes. The client
IP is the socket address; `X-Forwarded-For` is ignored unless `RATIO_TRUSTED_PROXY_HOPS=N`
(integer ≥ 1) declares N trusted proxies, in which case the Nth entry from the
right is used (a one-time warning is logged when a multi-hop `X-Forwarded-For`
arrives without it). The limiter is **per process** — each serverless instance counts
separately — so a shared store is a deployment-brief item. `GET
/api/costsource/sources` and `GET /api/v1/connectors` show live connector
status only to authenticated callers; anonymous callers see the neutral
registry. The offline demo is unchanged.

**Fail loudly, never partially.** A connector either returns the complete data
for the window or errors: too many export files, a truncated listing, a missing
billing month in a multi-month window, an exhausted BigQuery page cap, or an
invalid row is an explicit error naming the artifact and row. Rows must carry
`BilledCost`, `ChargePeriodStart` and a known ISO-4217 `BillingCurrency`; dates
are strict ISO-8601 (no offset means UTC); numbers are plain decimals. Each row
keeps its own currency — mixed currencies are never summed. Window bounds must
be `YYYY-MM-DD` (00:00Z) or `YYYY-MM-DDTHH:MM[:SS[.fff]]` with optional `Z` /
`±hh:mm` (none = UTC) and start < end; anything else is a 400. A manifest larger
than 1 MiB or an export object larger than 512 MiB (counted while streaming) is
an `export too large` error. Upstream
error bodies are never returned to API callers — only label + HTTP status; the
body is logged server-side, redacted and truncated.

**Automation.** `GET /api/v1/connectors` returns every connector's
server-resolved state and the env names that connect it; add `?probe=true`
(requires `Authorization: Bearer <RATIO_API_TOKEN>`) to health-check every
configured connector in parallel — suitable for a deploy pipeline or uptime
monitor. The `/connectors` page shows the same state; its **Test connection**
button probes sandbox sources only — the browser never holds an API token, so
live connectors are probed through the authenticated API.

PointFive (live) is the one exception: it routes through PointFive's broker (a
controlled-egress path), so it stays explicitly opt-in behind
`COSTSOURCE_POINTFIVE_LIVE`.

## AI providers — any API, any open-weight model

The agent's LLM is chosen server-side by `AI_PROVIDER`; keys never reach the
browser. Claude and OpenAI use their SDKs; every other provider speaks the
OpenAI-compatible chat-completions format through one adapter, so the agent is
not tied to any vendor.

| `AI_PROVIDER` | Reaches | Env |
|---|---|---|
| `mock` (default) | Offline, data-grounded mock | — |
| `claude` | Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| `openai` | OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` |
| `mistral` | Mistral La Plateforme | `MISTRAL_API_KEY`, optional `MISTRAL_MODEL` (default `mistral-large-latest`), `MISTRAL_BASE_URL` |
| `qwen` | Alibaba Cloud Model Studio (DashScope, compatible mode) | `QWEN_API_KEY` or `DASHSCOPE_API_KEY`, optional `QWEN_MODEL` (default `qwen-plus`), `QWEN_BASE_URL` |
| `openllm` (aliases `ollama`, `vllm`, `tgi`, `lmstudio`, `llama.cpp`, `open-weight`) | Any self-hosted open-weight model — Llama, Mistral/Mixtral, Qwen, DeepSeek, Gemma, Phi… | `OPENLLM_BASE_URL`, `OPENLLM_MODEL`, optional `OPENLLM_API_KEY` |

Any other hosted OpenAI-compatible service works through `openllm` by pointing
`OPENLLM_BASE_URL` at it. Selecting any live provider turns gateway auth on
(`RATIO_API_TOKEN`), so a paid model endpoint is never exposed unauthenticated.

Durable design rules live in `.obvious/obvious.md` (Design Guidance) and the
routine skills under `.obvious/skills/`. The full v1 design specification is
preserved as an ephemeral Obvious artifact (point-in-time snapshot), not checked
into the repo — see the `doc-authoring` skill for this workflow.

