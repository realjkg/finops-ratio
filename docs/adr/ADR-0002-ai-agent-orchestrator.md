# ADR-0002: AI Agent Orchestrator (deterministic sub-agents, skills and connectors over FOCUS data)

| | |
|---|---|
| Status | **Proposed** (design only). Landing this document records the design; it does not approve D1–D12. Each decision in §14 stays with the owner, and every default below may be overridden. |
| Date | 2026-11-13 |
| Release line | Within the ADR-0001 program ([roadmap](../roadmap/platform-program.md)). Phase F1 (Frank conversation layer) ships with this document in PR #190. The read-only orchestrator (O1) aligns with **1.3** ("read-only A2A over the same authorized services", roadmap 1.3). Proposals that change state (O3) are **2.0**. Nothing here is evidence for the **1.0** release candidate. |
| Code | None in this document. It lands with phase F1 (Frank conversational layer, PR #190), the only phase implemented so far. |
| Status wording | At most **"implemented and pre-release validated; live verification scheduled"** until live evidence exists (ADR-0001 §16). |

**Naming.** In this repository, "orchestrator" has so far meant the development process: the agent that merges PRs under the owner's charter. In this ADR, **Agent Orchestrator** always means the **product** component. "Skill" means a product skill (§4.2), not `.obvious/skills/*` and not the gateway's `skill:<id>` tool identity.

## 1. Context

### 1.1 The owner's direction (2026-11-13)

> "AI Agent Orchestrator handles sub agents which have skills and connectors that submit ACCURATE data to the Agent workflows page based on FOCUS and ingested cloud billing data and looked at and presented in reports into a FOCUS dataset report."

> "Frank needs to be self-deterministic. But he needs to be more intelligent and more conversational."

### 1.2 What exists on main today

| Area | Today | Gap against the direction |
|---|---|---|
| **Agent workflows** (`pages/agent-workflows.tsx`, `src/agent-workflows/`) | One kind of agent, `AgentJob`, run by `engine.ts` (`deterministic-simulation-v1`). Commands queue, claim, process, fail, retry and review. Each review is bound to an evidence snapshot (`basis` = sha256 of the outcome, ledger and governance), and the job fails with "Evidence changed during processing" if that basis moves. Four-eyes review, a 10–1000 character rationale, stale proposals refused, an append-only ledger and an audit row per command. Limits are in `AGENT_POLICY`. | Data comes **only** from the simulation seed (`seedWorkspace()` over `src/data/*`). Agent workflows never read ingested FOCUS data. |
| **Frank** (`src/ai/mock/`, `src/agent-workflows/frank.ts`) | Two embodiments. Chat Frank is a pure, deterministic router (`respond.ts`) with first-match keyword intents. Workflow Frank (`frankGuide`) produces four-step review guidance. Both read demo or simulation data (`World` for chat Frank, `Workspace` for workflow Frank). | Rigid conversation: unrecognized phrasing is refused. No multi-step plans. No access to ingested data. |
| **FOCUS ingestion** (`src/ingest/`, `src/costsource/`) | FOCUS 1.0–1.4 (1.4 canonical; 1.5 is a draft). Required columns are validated. Batches can be staged, published, superseded or quarantined. Reconciliation against control totals (`reconciled` / `unverified` / `variance`), and a DB CHECK blocks publishing a variance batch. `cost_facts_published` is a security-barrier view and the only reader path. A `ratio.evidence` record is written per worker command. Cloud connectors never substitute seed data and refuse partial listings. | Not connected to agents or Frank. |
| **Connector contract** (`connector-declaration/1`) | Ladder: Configured → Authorized → Retrieved → Validated → Reconciled, never collapsed into "Connected". Verification is `not_verified` / `pre_release_validated` / `live_verified`, with limitations required until live. | No agent consumes it yet. |
| **Reports** | `ratio.report-facts/1` (reads only `cost_facts_published`; `Fact<T>` is available or `not_available{reason}`; never summed across currencies or sources; carries a scope label). `ratio.engagement-report/1` (xlsx, pdf and json). Reconciliation identities I1 and I2 in `src/finops/semantic/reconcile.ts`. | No report is called a **FOCUS dataset report**. Report-facts plus the engagement report come closest. |
| **MCP** (`docs/design/frank-mcp/`) | Design only. A read-only tool catalog (e.g. `ratio_published_cost_facts`) with `data_origin` (`synthetic_seed` / `synthetic_fleet` / `tenant_published`). | No tool calling exists in any adapter. |

## 2. Principles

1. **Deterministic end to end.** Orchestrator, sub-agents, skills and Frank are pure functions of their inputs and the conversation state: no randomness, no clock reads inside a computation, no generative model in any decision or figure. The same inputs always give the same outputs, and every output can be replayed from its evidence.
2. **Accuracy over coverage.** A figure is shown only with its provenance. Missing data is `N/A` with a reason, never 0, never substituted from seed data, and never summed across currencies or sources (ADR-0001 D11, report-facts rules).
3. **Agents propose; people decide.** Sub-agents and Frank only read and propose. Existing domain commands keep exclusive write authority; acceptance records a human review (`engine.ts` today). Four-eyes and stale-proposal rules are unchanged.
4. **One evidence spine.** Every agent output carries the common envelope (identity, scope, observed and produced times, source references, method and configuration version, completeness and certainty), and references the published batch it came from.
5. **Honest labels.** Data origin is always stated: `synthetic_seed`, `synthetic_fleet` or `tenant_published`. Evidence status is `measured` / `projected` / `assumed` (the weakest input wins). Wording follows `src/lib/vocabulary.ts`.

## 3. Decisions

| ID | Decision |
|---|---|
| D1 | **The Agent Orchestrator is a deterministic planner and runner** inside Ratio. It turns a workflow request (from the Agent workflows page, a schedule, or Frank) into a plan of sub-agent steps. It runs the steps against one immutable **input snapshot**, validates every output, and submits the result to the Agent workflows page as a reviewable proposal. |
| D2 | **Sub-agents are declared, versioned units.** Each has an `AgentSpec`: id, version, purpose, skills, connectors, input contracts, output contracts and permissions (§4.1). There is no free-form agent. |
| D3 | **Skills are pure functions with contracts.** Typed input and output, a method id and version, a configuration hash, and their own tests. Skills never read anything except their declared inputs (§4.2). |
| D4 | **Connectors are `connector-declaration/1`.** A sub-agent may produce `measured` output only from a connector at **Reconciled** and a batch that is `published` with reconciliation `reconciled`. Lower rungs produce labeled, non-measured output or an explicit gap, never a silent fallback (§4.3). |
| D5 | **The only data path for ingested billing is `cost_facts_published`** (and, once authorized, the enriched view and batch metadata), read with the requesting tenant's reader-side access. Agents never use worker credentials and never read staging tables, raw artifacts or quarantined batches. Of the cost data, the reader role sees only `cost_facts_published` (it is also granted the outcome views of migration 0004): batch status, reconciliation and control totals are not readable (`src/server/costs/reportFactsRead.ts`), and `cost_facts_published_enriched` is granted only to `ratio_worker` (migration 0002). Authorized, tenant-scoped reads of both are **O1 prerequisites** (§8). |
| D6 | **Snapshot binding.** A run records the publication ids and the batch and artifact digests it read (the snapshot basis). If a period publication changes before review, the proposal is stale and cannot be accepted. This extends today's `basis` rule from simulation evidence to ingested data. |
| D7 | **Validation gate before submission.** Contract shape, the common envelope, reconciliation identities I1 and I2, currency separation, no N/A-to-0, and vocabulary checks. A failing output is submitted as a **gap** with reasons, never dropped and never "fixed". |
| D8 | **Agent workflows page integration.** A run appears as an `AgentJob` (existing status machine, leases, attempts, limits), plus a typed result per sub-agent and the snapshot basis. Review stays four-eyes with a rationale. Accepting a proposal never writes cost data. Today's agent workflows are simulation-only: simulation identities and persona-based permissions (`src/simulation/server/http.ts`, `workflow.ts`). Customer workflows need an **engagement-authenticated adapter** (an O1 prerequisite) that authorizes the request, the queued execution and each human review separately. No simulation identity, persona permission or review privilege carries over to customer workflows. |
| D9 | **FOCUS dataset report.** A new report artifact, built only from validated orchestrator outputs and `report-facts`: the FOCUS version and columns present, the per-batch reconciliation state, coverage (allocation, reconciliation and usage telemetry, reported separately), and every figure with its provenance. Output as json, xlsx and pdf, like the engagement report (§6). |
| D10 | **Frank becomes the conversational front end of the orchestrator**, through a deterministic conversation engine (§5). Phase F1, the conversation layer, is implemented in PR #190. |
| D11 | **No generative model in the decision path.** An optional, flag-gated translator may later map free text to the conversation engine's structured request, which is validated before any skill runs. It is out of scope here and needs a separate owner decision (§14). |
| D12 | **Permissions.** A run executes with the requesting user's engagement `authorize()` decision (ADR-0001 §10.3). That has no workflow permission or resource mapping yet; adding one is part of the D8 adapter. A sub-agent's declared permissions can only narrow that decision, never widen it. Reads are tenant-scoped (cross-tenant reads are impossible by construction). |

## 4. Building blocks

### 4.1 Sub-agent (`AgentSpec`)

```
AgentSpec {
  id: "focus-coverage", version: 1,
  purpose: "Report FOCUS column coverage and reconciliation state for a period",
  skills: ["focus.coverage@1", "focus.reconciliation-state@1"],
  connectors: [connector-declaration/1 ids, category "cloud_billing"],
  inputs:  ["cost_facts_published (tenant, period)", "period_publications", "ingest_batches (status, reconciliation)"],
  outputs: ["ratio.focus-coverage/0-draft"],
  permissions: ["read:published-costs"]
}
```

Initial sub-agents (all read-only):

| Sub-agent | Produces | Built from |
|---|---|---|
| `focus-coverage` | FOCUS version; columns present in the original file, reported separately from populated-value coverage; required-column validity; `x_Ratio*` extension presence | retained, artifact-bound header evidence through an authorized metadata read (§8); published facts for populated-value coverage only |
| `reconciliation` | Per-batch state (`reconciled` / `unverified` / `variance`) against control totals; I1 and I2 identities | `ingest_batches`, `reconcile.ts` |
| `cost-attribution` | Effective and billed cost by provider, service, sub-account and workload, with unallocated cost explicit | published facts, allocation rules |
| `value-evidence` | Value / cost per outcome unit, using the durable outcome rules (null with blockers, never guessed) | `src/outcomes/durable.ts` |
| `anomaly-and-savings` | Findings with the evidence status of each input | published facts, existing findings logic |

### 4.2 Skill

A skill is `(input contract) -> (output record + envelope)`: pure, deterministic and versioned (`<name>@<version>`). It has golden tests and a configuration hash. Skills compose only through the orchestrator's plan, never by calling each other, so each step's evidence stays visible.

### 4.3 Connector rules for agents

| Connector rung | What a sub-agent may produce |
|---|---|
| Reconciled (and batch `reconciled`) | `measured` figures |
| Validated / Retrieved | Figures with the batch reconciliation state (`unverified`) shown as its own field, separate from evidence status. Such a figure never supports `measured`: an evidence status computed from it is `assumed` (the weakest supported status). The orchestrator sets this explicitly, because `weakestStatus()` skips unmarked inputs. The reconciliation gap is shown |
| Authorized / Configured | No figures; a gap stating which rung is missing |
| Degraded / failed / simulated | No ingested figures; a gap. Simulated data is never presented as ingested |

### 4.4 Orchestrator run

1. **Request.** Workflow type, tenant, period and requester.
2. **Plan.** A fixed DAG for the workflow type (e.g. coverage → reconciliation → attribution → value-evidence). Plans are data, versioned like skills.
3. **Snapshot.** Read the publication ids, batch ids and artifact digests, and compute the basis.
4. **Execute.** Run each sub-agent in plan order with bounded resources (the existing `AGENT_POLICY` limits, leases and attempts).
5. **Validate.** Apply D7.
6. **Submit.** Create an `AgentJob` proposal containing the per-sub-agent results, gaps and the basis.
7. **Review.** Four-eyes acceptance with a rationale, or dismissal. A stale basis blocks acceptance.
8. **Report.** Accepted runs feed the FOCUS dataset report (D9). Unaccepted runs are visible as proposals only.

## 5. Frank as the conversational front end (deterministic)

| Layer | Design |
|---|---|
| **F1 Conversation layer** (implemented in PR #190) | Turns that are entirely conversational (greetings, thanks, "who are you", "where do I start", acknowledgments, goodbyes) get deterministic, friendly replies that point at answerable questions. A greeting in front of a question still routes the question. "Who are you?" says who Frank is, what he does, what he can't do and how he works (a deterministic assistant, not a generative model). In these replies, every spend figure carries its Value / cost and evidence status. Replies render as readable prose (heading, paragraphs, lists, source footnote) for an executive audience. |
| **F2 Understanding** | The first-match keyword list is replaced by a scored intent parser plus slot extraction (entity, metric, comparison, period, data origin). Entity matching is typo- and synonym-tolerant over known names. Below a confidence threshold, Frank **asks** instead of refusing. Same input and state always give the same parse. |
| **F3 State and planning** | A typed dialogue state (subject, metric, pending clarification, comparison). Compound questions become orchestrator plans: "Which team is worst and what could we save there?" becomes a ranking, then a savings answer, combined. "Why?" and "explain" show the calculation and its provenance. |
| **F4 Orchestrator access** | Frank invokes read-only skills (the frank-mcp catalog, e.g. `ratio_published_cost_facts`) and can start a workflow request, which still needs four-eyes review. Frank never accepts proposals. |
| **F5 Evaluation** | A golden multi-turn conversation corpus, the honesty properties (no figure without a source), an "unanswered rate" KPI, and pinned regression for existing answers. |

The ADR-0001 §10.3 boundaries still apply: no invented usage, no self-approval, no verification without test evidence, and permissions inherited from `authorize()`.

## 6. FOCUS dataset report (D9)

| Section | Content | Rule |
|---|---|---|
| Scope | Tenant, period, sources, FOCUS versions, publication ids | The report-facts scope label is carried over verbatim |
| Coverage | Required and optional FOCUS columns present per source; extension columns | A column is "present" only with retained, artifact-bound header evidence. The published facts cannot tell an absent column from one whose cells are all empty (`src/ingest/focus/validate.ts`), so without that evidence the column claim is N/A. Populated-value coverage is reported separately. Missing is shown as missing |
| Reconciliation | Per-batch state against control totals; I1 and I2 identities | Variance batches are never published (existing DB rule) |
| Cost | Billed and effective, by provider, service, sub-account and workload; unallocated explicit | No cross-currency sums; the cost basis is named |
| Value | Value / cost per outcome unit, with blockers when null | Durable outcome rules; the 3× target is a configured policy target |
| Agent provenance | Each figure: sub-agent, skill@version, configuration hash, snapshot basis, reviewer | Unreviewed runs are excluded or marked "proposal" |

Formats: json (a new contract, `ratio.focus-dataset-report/1`, only after owner approval), xlsx and pdf, following the engagement report's N/A-and-Note pattern.

## 7. Threats and controls (summary)

| Threat | Control |
|---|---|
| Seed or simulated data shown as ingested | `data_origin` is mandatory. Simulated connectors map to no ladder rung. Tests assert there is no fallback (the `CloudConnectorAdapter` rule). |
| Stale or partially published data | Reads come only from published views. Snapshot basis, with stale proposals blocked. |
| An agent widening access | Declared permissions only narrow `authorize()`. Tenant-scoped reads. |
| Self-approval | Four-eyes is enforced by the engine. Frank never accepts. |
| Silent errors | The validation gate turns failures into visible gaps. Evidence records per run. |
| Content leakage | No prompt or response bodies are stored. Allowlisted fields only (as in the telemetry discovery kit, branch `discovery/telemetry-kit`, not yet merged). |

## 8. Data and migrations

Persisting runs, sub-agent results and report snapshots needs new tables. Under the ADR-0001 §12 ledger rule, **no 0020+ migration** may be merged until the 0005–0019 reservations are decided. Phases F1–F3 need no migration.

O1 does not need run persistence, but it still has migration dependencies. Avoiding persistence does not remove them:

- an authorized, tenant-scoped reader path to batch status, reconciliation state and control totals (the batch-status view reserved as migration 0005);
- a reader-side grant or view for `cost_facts_published_enriched` (today granted only to `ratio_worker`);
- for either read, an update to the reviewed reader privilege models, `READER_GRANTS` in `src/ingest/db/migrationFiles.ts` (which refuses any other reader grant) and `src/ingest/db/privilegeModel.ts`;
- retained, artifact-bound header evidence for original-column claims (D9 Coverage).

So O1, not only persistent runs, waits for the ledger decision.

## 9. Phases and release placement

| Phase | Scope | Release |
|---|---|---|
| F1 | Frank conversation layer: small talk, identity (who he is, what he does and can't do), readable replies | PR #190 (with this ADR) |
| F2–F3 | Frank understanding, state and planning over current data | Standalone PRs |
| O1 | Read-only orchestrator: `focus-coverage`, `reconciliation`, `cost-attribution` over `cost_facts_published`, submitted as proposals; FOCUS dataset report (json). Prerequisites: the authorized metadata and enriched reads (§8) and the engagement-authenticated workflow adapter (D8, D12) | 1.3 (read-only) |
| O2 | `value-evidence`, `anomaly-and-savings`; xlsx and pdf report; Frank F4 | 1.3 |
| O3 | Proposals that trigger domain commands after four-eyes review | 2.0 |

## 10. Evidence plan

- **Skills:** golden tests per skill version and property tests (no N/A-to-0, currency separation, envelope validity).
- **Orchestrator:** fixtures for every connector rung and batch state; a stale-basis test; tests that failures become gaps.
- **End to end:** an Agent workflows run over ingested fixture data (the FOCUS 1.0 sample-data acceptance), four-eyes acceptance, then a report export. Asserted in browser acceptance.
- **Frank:** the conversation corpus, an unanswered-rate KPI and honesty properties. Each PR is merged only with CI and acceptance green on its exact commit and an owner preview check.

## 11. Consequences

- Agent workflows move from simulation-only to evidence-bound work over ingested FOCUS data. The simulation remains for demos and is clearly labeled.
- Determinism costs some conversational breadth compared with a generative model. F2 and F3 recover most of it without giving up reproducibility.
- New contracts (`ratio.focus-dataset-report/1`, sub-agent output schemas) need the same review and schema pinning as ADR-0001 contracts.

## 12. Not claimed until live verification

No claim that agents "verify" or "reconcile" a customer's invoice until live evidence exists. Reports carry the report-facts scope label: "supplied file(s) and periods; not a complete provider invoice; reconciled only against the control totals shown".

## 13. Relationship to other documents

ADR-0001 (contracts, connector ladder, §10.3 Frank boundaries, §12 migrations), `docs/design/frank-mcp/` (tool catalog and data origins), and `docs/roadmap/platform-program.md`. The telemetry discovery kit's common envelope (branch `discovery/telemetry-kit`, not yet merged) is the model for agent output envelopes.

## 14. Decisions that need the owner

1. Approve D1–D12, or amend them.
2. Release placement of O1 and O2 (proposed: 1.3) and O3 (proposed: 2.0).
3. The name and contract for the FOCUS dataset report (`ratio.focus-dataset-report/1`).
4. The initial sub-agent list (§4.1).
5. The migration ledger decision (0005–0019), which blocks O1's metadata and enriched reads as well as persistent runs.
6. Whether a flag-gated free-text translator (D11) is ever allowed. The default is no.
