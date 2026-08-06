# Obvious Repo Guide

Version: autobuild-setup-worker v1.2.0

## Codebase Map

See `.obvious/codebase-map.md`.

## Repo Guidance

- This repo is `realjkg/finops-ratio` (originally `token-sensei`), a Next.js/React app for Ratio, an AI-native FinOps platform.
- Use npm, not pnpm/yarn/bun, because `package-lock.json` is present and `npm install` was verified.
- Do not run the full `typecheck` script in this sandbox; it exists as `npm run typecheck` (`tsc --noEmit`) and CI can run it.
- No backend, auth, database, Docker service, or required secret is needed for local development.
- `NEXT_PUBLIC_ANTHROPIC_API_KEY` is optional. Without it, the app uses the data-grounded mock agent and remains fully runnable.
- Keep app code changes scoped under `src/` unless build tooling or docs need updates. Do not commit generated `dist/` or `.obvious-install/` evidence files.
- the design specs are point-in-time, session-based documents and should be kept as ephemeral artifacts in obvious.

## Design Guidance — Rules

Durable, enforceable product rules for Ratio (codename `token-sensei`), promoted from the v1 design spec. The full narrative spec is an ephemeral Obvious artifact (`art_nWIhJYfZ`), **not** checked into the repo — see `doc-authoring` under `## Routine Skills`; the UI Direction north star is similarly promoted from ephemeral snapshot `art_lpwOxiaC`. Operating procedures (forecast math, agent prompt, reporting, observability) live as skills, not here.

### Design Principles (non-negotiable requirements)

- **R1 — Unit economics moves to AI output.** Measure cost per inference / resolved query / active user, tied to business value. Cost per VM is the wrong abstraction.
- **R2 — Demand shaping is first-class.** Visibility alone is insufficient; the platform must let users influence when, how, and whether AI workloads run based on the value they deliver.
- **R3 — Governance precedes scale.** No workload reaches production volume without passing governance gates.
- **R4 — Value is the denominator.** Every cost shown in the platform MUST be paired with its value context. Cost without value is just spend; the metric is business outcome ÷ inference dollar.

### Data-Model Invariants

- The **Workload** is the core entity. Field groups: identity (`id`, `name`, `model`, `model_provider` ∈ {openai, anthropic, google, aws_bedrock, azure_openai, custom}, `team`, `environment` ∈ {prod, staging, dev, sandbox}, `priority` ∈ {critical, high, medium, low}); `costs`; `outputs`; derived `unit_costs`; `value`; `governance`; `demand_shape`.
- **Value-ratio invariant:** `value.value_ratio = value.total_value / costs.monthly_spend`, where `total_value = revenue_protected + cost_avoided`.
- **Unit costs are derived, never the stored source of truth:** e.g. `cost_per_call = daily_spend / daily_inferences`, `cost_per_resolved = daily_spend / resolved_queries`, `cost_per_user = monthly_spend / active_users_monthly`.
- **Model registry pricing tiers** (derived from input $/1M tokens): `economy` <$1, `standard` $1–$5, `premium` $5–$20, `ultra` >$20. Each model entry carries input/output (and optional cached/batch) pricing per 1M tokens plus capability metadata (context window, max output, vision/tools/streaming).
- **Budget profile** per workload: a `budget_amount` over a period (daily/weekly/monthly), three threshold fractions (soft/hard/kill), a daily allocation profile (weekday/weekend spend, peak-hour window + multiplier), and a forecast block.
- **Alert types:** `budget_soft`, `budget_hard`, `budget_kill`, `anomaly_spike`, `value_ratio_drop`, `trend_warning`, `governance_missing`, `forecast_breach`, `model_cost_change`. Severity ∈ {info, warning, critical}.

### Alert & Threshold Rules

- **Budget thresholds apply to BOTH daily and monthly budgets:**
  - Soft **70%** → Slack + email to the workload owner.
  - Hard **90%** → escalate to PO + flag the workload in the UI.
  - Kill **100%** → auto-throttle to the configured level (50% / 75% / 90%) **or** pause.
- **Anomaly detection:** today's projected spend >**15%** over yesterday's actual → anomaly alert; current-hour token consumption >**25%** over the same hour yesterday → intra-day alert; a switch to a more expensive model → immediate alert.
- **Value-ratio alerts:** ratio drops below **3×** → value-review alert; below **2×** → value-critical alert (recommend demand shaping or sunset).
- **Forecast alerts:** projected month-end > monthly budget → forecast-breach alert (with overshoot amount + days until breach); a daily forecast projecting the kill threshold before end of business → immediate.

### Governance Gates

- Gates are **sequential**: **Policy → Ethics → Cost → Scale.** Gate N+1 cannot pass without Gate N.
  - **Gate 1 Policy:** model on the approved list, deployment region allowed, resource limits within policy.
  - **Gate 2 Ethics:** bias audit complete, PII handling documented, output safety review passed.
  - **Gate 3 Cost:** monthly budget set, value ratio ≥ minimum (configurable, default **3×**), ROI projection documented.
  - **Gate 4 Scale:** all prior gates passed, scale authorization granted by PO/approver, demand shape ≠ `unmanaged`.
- **Enforcement:** a >**3× inference-volume increase** without Gate 4 auto-throttles to the previous level and alerts; the `always_on` demand shape is **blocked unless all 4 gates pass**; gate status is re-checked on every (hourly) budget evaluation.

### Multi-Model Methodology Guardrails

- Before deploying or switching a model, the developer MUST see: input/output pricing per 1M tokens, estimated daily & monthly cost at the workload's current volume, a comparison against **≥3** alternative models at the same volume, and the value-ratio impact of switching (cheaper model at equal value ⇒ higher ratio).
- If a selected model would push daily spend over the daily budget, show a projected-overshoot warning.
- Selecting an `ultra`-tier model (>$20/1M input) requires the Cost gate (Gate 3) to be passed.
- Switching models mid-month recalculates the forecast immediately on the new model's pricing.
- Track `cost_per_1k_tokens_in` / `cost_per_1k_tokens_out` per workload daily; if a provider's registry pricing diverges from stored rates, raise a `model_cost_change` alert with the monthly-forecast impact.

### Design Tokens (durable, exact — keep verbatim)

```
Color — Background:
  void:    #05070b    // Deepest background
  deep:    #090c12    // Panel backgrounds
  slab:    #0d1119    // Card backgrounds
  raised:  #141a26    // Hover states, selected items
  edge:    #1a2235    // Borders

Color — Text:
  txt:     #d0d8ea    // Primary text
  sub:     #8895ad    // Secondary text
  dim:     #4d5a72    // Muted text, labels

Color — Semantic:
  value:   #00e09e    // Value, positive, return ratios
  cost:    #ff5c72    // Cost, negative, overspend
  shape:   #ffc44d    // Demand shaping, warnings, amber alerts
  gate:    #7c8dff    // Governance, policy, gates
  unit:    #00ccee    // Unit economics, informational
  purple:  #b490ff    // Agent, AI, special

Color — Cloud providers:
  aws:     #ff9900
  azure:   #0078d4
  gcp:     #4285f4

Typography:
  Mono:  "JetBrains Mono"     — data, numbers, code, agent responses, labels
  Body:  "Instrument Sans"    — prose, descriptions, user messages

Value-ratio color scale:
  Excellent (≥10×): #00e09e   (value green)
  Good (5–9.9×):    #00ccee   (unit cyan)
  Marginal (2–4.9×):#ffc44d   (shape amber)
  Poor (<2×):       #ff5c72   (cost red)

Budget-bar color scale:
  0–70%:   #00e09e → green (healthy)
  70–90%:  #ffc44d → amber (caution)
  90–100%: #ff5c72 → red (danger)
  >100%:   #ff5c72 at 40% opacity (overshoot projection)
```

### API-First Design Principles

- All endpoints return JSON; cost data accepts FOCUS-formatted input for multi-vendor normalization.
- Authentication via Bearer token (one API key per tenant). Versioned under a `/v1/` prefix; breaking changes get a new version.
- Rate limits: 1,000 req/min (standard), 10,000 (scale), unlimited (enterprise).
- Webhook outputs for event-driven integrations.
- **The UI is a reference implementation; the product is the math.** Any dashboard (Grafana, cloud-native, custom) can call the engine endpoints to get value ratios, forecasts, governance status, and demand-shaping recommendations.

### FOCUS Ingest Mapping

Cost data enters through `POST /ingest/focus` (FOCUS-compliant rows) and through source adapters (the attribution-source door). Ratio's canonical internal cost schema is **FOCUS v1.4**, with **per-environment, version-aware backwards compatibility across v1.0–v1.4**: a source/environment may export any FOCUS version in that range, and the seam upgrades it UP to the v1.4 canonical model while preserving backwards compatibility for environments pinned to an older version, per FOCUS's version & conformance rules. Cross-version deltas are additive (column additions, no breaking changes). The engine maps FOCUS columns onto the internal model:

| FOCUS column | Internal mapping |
|---|---|
| `BillingAccountId` | `tenant` |
| `SubAccountId` | `workload.cloud_account` |
| `ServiceName` | `workload.model_provider` |
| `ResourceId` | `workload.resource` |
| `BilledCost` | `workload.costs` |
| `EffectiveCost` | `workload.costs` (discount-adjusted) |
| `UsageQuantity` | `workload.tokens` |
| `PricingUnit` | `workload.unit_costs` derivation |

Any org exporting FOCUS-formatted billing — any cloud, any AI service, any normalizer, at any FOCUS version v1.0–v1.4 — can feed Ratio without custom integration work; only the source adapter (auth, fetch, identity resolution) is source-specific, and the version-negotiation shim normalizes every export to the v1.4 canonical model.

### Positioning & Integration Tenets

- **Complement, don't replace (attribution tools).** Ratio does NOT do kernel-level / eBPF / packet capture (the high-resolution *numerator*). It consumes attribution output as a cost source and attaches the value *denominator*, governance gates, forecast, and demand shaping. Never try to replace attribution taggers.
- **Publish, don't aggregate (anti-"7 dashboards").** Reject a consolidation single-pane; that is just a larger competing dashboard. Ratio is an embeddable engine — value/governance/forecast outputs surface inside the tools each persona already uses (Grafana `/metrics`, Slack `/agent/query`, `@ratio/react` SDK, webhooks). No one opens a 7th dashboard.
- **One source of truth, persona-projected.** The same engine numbers, different lenses per persona (data analyst, FOCUS billing specialist, procurement/business, finance/leadership). No persona gets a divergent copy of the truth.
- **Two ingest doors, one internal model.** `/ingest/focus` and a thin attribution-source adapter both normalize into one internal cost model (ideally FOCUS). Only the adapter (auth, fetch, identity resolution) is source-specific; the engine, forecasts, ratios, and UI stay provider- and source-agnostic.

### UI Direction

Target product direction promoted from the *UI Design Direction* snapshot (ephemeral Obvious artifact `art_lpwOxiaC`, June 2026). These are durable rules; the strategic narrative (Wiz thesis, competitor analysis, honest-risk) stays in the artifact, not the repo — see `doc-authoring`. **Status: Wave 4 target north star** — the current shipped executive surface predates this and is reconciled inline below.

- **North-star metric (reinforces R4).** The headline is **value returned per inference dollar**, never savings. Every cost shown is paired with its value denominator.
- **Findings-first IA.** The product surface collapses to **six objects: Overview, Findings, Workloads, Connectors, Frameworks, Reports.** **Findings is the home screen** — users land on a ranked list of value-ratio findings, **worst ratio first**, before any chart. Charts are evidence *inside* a finding, never the front door.
  - *Reconciliation:* the shipped executive Initiative Dashboard becomes the **Overview** object; **Findings** becomes the new front door in Wave 4. Direction, not a retroactive change to shipped surfaces.
- **Findings → recommendation flow.** Ranked findings left, recommendation right. Each finding carries exactly: (1) the value-ratio problem, (2) two evidence values — current ratio and current spend, (3) one recommended action, (4) projected monthly impact as the hero figure. The only verbs are **Select / Apply / Dismiss**. Applying adds to a quiet **"captured" tally** — no badges, confetti, streaks, or other gamified reward mechanics.
- **Two signature components.** Build and reuse exactly two: the **value-ratio meter** (a single bar showing distance below the 1.0× value line — quiet in the list, enlarged in detail) and the **spend-to-value graph** (where cost flows and where value fails to return). Originality is one signature done well; do not add competing novel components.
- **Visual register.** Calm, not loud — the Wiz / PointFive register, not a trading terminal. One type family with a monospace companion for data (per the existing Typography tokens). Generous whitespace, hairline borders. **Spend visual boldness only on the value-ratio meter and the projected-impact number;** everything else stays quiet.
  - **Reserved accent.** Reserve a **single warm accent** for two roles only — the recommended-action CTA and the controlled-egress / air-gap paths. This is an emphasis role, distinct from the **semantic data palette** (`value`/`cost`/`shape`/`gate`/`unit`), which continues to encode data meaning. Do not introduce a second accent or spend the accent elsewhere. Exact accent token finalized at Wave 4 implementation (candidate: `shape` #ffc44d).
- **Trust model, made visible.** Brokered egress is the default; an **air-gap SKU** serves regulated (FIS-class) buyers. Controlled-egress paths are surfaced in the UI and carry the reserved accent.
- **Open-core & the 90-day hook.** The client is open source and free forever. Any time limit lives **only on the hosted connector** (cloud cost-API auth + agent inference through the broker) and is **enforced server-side with short-TTL credentials — never a local clock or a timer in open-source code.** The UI states the limit honestly in a single chip.
- **Honest-risk guardrail.** The ranked findings queue rests on the **value-attribution methodology** — the unsolved hard problem and the first thing a skeptical CFO attacks. **The UI must never outrun the rigor of the attribution beneath it.** A polished ranked list built on attribution that does not hold up is worse than a plain one that does. Invest in the methodology as the real product; the UI earns trust, it does not substitute for it.

## Routine Skills

`.obvious/skills/` holds Ratio's durable operating procedures. The rules above (obvious.md) are the entry point; load a skill for its step-by-step routine. Skills reference these rules rather than duplicating them.

| Skill | Purpose | Path |
|---|---|---|
| `local-dev` | Start and validate the local Ratio Next.js frontend. | `.obvious/skills/local-dev/SKILL.md` |
| `forecast-engine` | Daily (peak-aware) & monthly (weighted-7d) spend forecast, 80% confidence interval, days-until-breach. | `.obvious/skills/forecast-engine/SKILL.md` |
| `agent-prompt` | Ratio Agent system-prompt structure, 5 non-negotiable principles, dynamic-injection blocks, capabilities. | `.obvious/skills/agent-prompt/SKILL.md` |
| `cost-reporting` | Automated daily (08:00 UTC) & weekly (Mon 08:00 UTC) + on-demand cost report contents and cadence. | `.obvious/skills/cost-reporting/SKILL.md` |
| `observability-deploy` | Prometheus/Grafana zero-trust observability topology, metric schema, rules, SSO/mTLS, K8s + Docker deployment. | `.obvious/skills/observability-deploy/SKILL.md` |
| `doc-authoring` | Standing workflow: design specs are ephemeral artifacts; promote durable rules→obvious.md, procedures→skills. | `.obvious/skills/doc-authoring/SKILL.md` |


## Local Verification

<!-- local-verification-summary:v1 -->
- **Typecheck command:** `npm run typecheck` (`tsc --noEmit`) — verified clean; also enforced in CI
- **Lint command:** `npm run lint`
- **Test command:** `npm test` (`vitest run`) — vitest is configured in `vitest.config.ts` with the `@/` alias mirrored from tsconfig
- **Scoped typecheck:** not_supported
- **Scoped lint:** `npx eslint <path>`
- **Scoped test:** `npx vitest run <path>`
- **Full-repo check safe:** yes
- **Scoped alternatives discovered:** yes
<!-- /local-verification-summary -->

### Standard Workflow

1. Install dependencies with `npm install`.
2. Start the dev server with `npm run dev` — it serves on `http://localhost:3000/` (Next.js default port).
3. Run `npm run lint`, `npm run typecheck`, and `npm test` before committing.
4. Run `npm run build` when validating bundling or production readiness.

### Scoped Workflow

1. For linting one file or directory, run `npx eslint <path>`.

## Network Resilience Profile

This is a client-side Next.js/React app. All core computation runs locally over bundled seed data.

| Surface | Network required? | Chaos monkey behaviour |
|---|---|---|
| Workload list, all detail tabs, forecast, KPI cards | No | Fully offline — pure local computation over seed data. |
| Agent panel — **mock mode** (no `NEXT_PUBLIC_ANTHROPIC_API_KEY`) | No | Fully offline — `MockAgentClient` uses only in-memory calculations. |
| Agent panel — **live mode** (`NEXT_PUBLIC_ANTHROPIC_API_KEY` set) | Yes (Anthropic API) | `sendMessage` in `useStore` wraps the call in `try/catch`. A network failure causes `fetch()` to throw; the catch block appends an inline `system` chat message (`Agent error: Failed to fetch`). No stack trace is exposed; the rest of the UI remains interactive. There is no automatic fallback to mock mode on live-mode failure — that is a known Phase 1 gap. |

**Short answer:** mock mode (the default) is fully offline and safe under any network disruption. Live mode degrades gracefully to a chat error message, not a stack trace. The Phase 1 enhancement path is to auto-fallback to `MockAgentClient` when a `LiveAgentClient` call fails.

## Sandbox Snapshot

- **Snapshot ID:** `icprr1z3f69clbt3lrls:default`
- **Captured:** 2026-06-25T18:25:27.651Z
- **Dev stack health at capture:** `dev_stack_healthy: true`
- **Primary URL verified:** `http://localhost:3000/`

## Bibliography

> **Status:** bibliography_scanned — 7 nodes upserted for `realjkg/token-sensei`.
>
> **Slugs touched:** `ratio-agent-client`, `ratio-agent-panel`, `ratio-detail-panel`, `ratio-finops-platform`, `ratio-forecast-engine`, `ratio-workload-list`, `ratio-zustand-store`.

## Security Scan

> **Note:** security_scan_not_triggered — the `trigger_security_onboarding` tool was not available in this worker toolset. Trigger manually using the target commit SHA `4e836816236ba784c76e39df2c116efe8685a867` if needed.
