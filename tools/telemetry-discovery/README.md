# Telemetry discovery kit

**Status: synthetic-validated, runtime validation pending.**

This kit tests a proposed mapping from gateway request logs, GPU capacity claims and FOCUS-aligned billing into Ratio's v1 contracts, using synthetic fixtures only. The Collector and Prometheus pieces have not run against real binaries yet. This kit is not part of the release candidate, it is not a product capability, and nothing in it is a capability claim.

## What the kit establishes, and what it does not

| Area | Approach | Boundary |
|---|---|---|
| Usage vs. money | Gateway rows become `ai-usage-event/1`. Rate-card valuations are separate `ai-financial-record/1` rows (`estimated_invocation`) linked by event id. FOCUS rows become `billed` and `effective` records. | Usage events are accounting-relevant operational records, not billed financial records. Provider billing remains the reconciliation source; missing usage is never reconstructed as billing. |
| Numbers | Adapters parse JSON numbers exactly (`Decimal`, never binary float) and accept decimal strings. They convert to canonical decimal strings at the contract boundary. Binary floats are refused only at that boundary. | An upstream API that emits JSON numbers is supported. Non-finite values are refused. |
| Reconciliation | Aggregates by provider account, provider, model, SKU, token category, currency and day, with every difference left visible. | Says "Gateway coverage discrepancy: billed usage exceeds observed gateway usage. Cause not yet established." The cause is never inferred. The matched share covers the fixture's accounts only; it is not a measure of protected traffic. |
| Routing | A versioned route map (alias → primary, declared fallbacks) plus a versioned served-model canonical map. | A mapping gap is not evidence of fallback or unauthorized routing. |
| GPU cost | GPU-seconds are allocated capacity × duration, not utilization: exclusive = 1, MIG = profile share (for example 3/7), time-sliced = 1/replicas. Claims on one GPU can never exceed 1; violations fail the run. Results are written as `allocation/1`, with idle, no-telemetry and missing-label capacity as explicit unallocated reasons. | This is a disclosed allocation model, not measured per-request cost. Stage-2 splits of shared inference capacity by weighted tokens are labeled estimates. "Reserved but inactive" is a diagnostic, not a cost adjustment or a shutdown recommendation. |
| Precision | Each split records its precision (at least 0.000001) and uses largest-remainder rounding with ties broken by ascending key. Both BilledCost and EffectiveCost are preserved; the basis and method version are recorded. | |
| Attempts | `attempt` is set only when the source supplies logical-request grouping; otherwise it is left unknown. | |
| Identity | Humans appear as `ps1:<keyId>:<hmac>` under a tenant-scoped key, and the key never enters telemetry. Services appear by registered `svc:` id. | Pseudonymous, not anonymous. |
| Content | Normalized output is built from allowlisted, typed fields. Canaries are planted in messages, responses, nested metadata, exception text, tags and identity fields; every output file and the run summary is scanned for them. The Collector uses attribute allowlists (`keep_keys`) and clears bodies and status messages. | The Collector half is enforced only once G4 to G7 pass on the pinned binary. |
| Durability | Usage events are never sampled. No batch processor sits in front of their persistent, file-backed queue. Rejections show in the Collector's own counters. | Unsampled does not mean lossless. The queue is finite and protects only what the Collector has acknowledged; anything lost before that is the producer's responsibility (a durable outbox). |
| Sampling | Span metrics come from all spans the Collector receives before tail sampling. | That is not every request: SDK sampling, exporter loss and instrumentation gaps happen earlier. `decision_wait` is a configured window, not a latency guarantee, and multiple Collector instances need trace-ID-consistent routing. |

## Contract position

The kit emits v1 records unchanged (`ai-usage-event/1`, `ai-financial-record/1`, `allocation/1`, `rate-card/1`). `contract-conformance.test.ts` runs the repository's own TypeScript validators over the committed goldens and checks that mutated copies are rejected. Everything outside v1 is a **draft sidecar** (`ratio.*/0-draft`) for a separate reviewed proposal:

| Sidecar | Holds | Rule |
|---|---|---|
| `source-estimate` | The gateway's own cost estimate, with its source representation | Never added to billed, effective or valuation amounts |
| `usage-correlation` | Trace id, logical-request id, workflow, agent run, route class and route-map version | Correlation only; the trace id is not an event id, billing key or credential |
| `reconciliation-link` | A billed aggregate linked to its observed aggregate and the difference | The cause stays `NOT_ESTABLISHED` |
| `allocation-chain` | Stage-2 allocation as a re-allocation of a stage-1 share | Never sum stage-1 and stage-2 shares |
| `agent-run-cost-estimate` | Agent-run split of shared capacity | Estimate; `allocation/1` has no agent-run target |

The draft sidecars are not part of `ai-usage-event/1` and do not extend it.

## Common envelope (kit 0.3)

Every draft record and `report.json` carries six elements, and the `ENVELOPE` check enforces them in every scenario:

| Element | Fields | Rule |
|---|---|---|
| Record identity and schema version | `schemaVersion` (`ratio.*/0-draft`), `recordId` | `recordId` is deterministic and never depends on `producedAt` |
| Tenant and source scope | `tenantId`, `sourceScope.sourceConnectionIds`, plus `provider`, `providerAccount` or `resourceId` where relevant | At least one source connection |
| Observed and produced timestamps | `observed.at` or a half-open `observed.periodStart`/`periodEnd`, and `producedAt` (UTC) | `producedAt` is never before the observed time. Goldens use a fixed clock; runs default to now; `--produced-at` overrides. |
| References to source records | `sourceRefs[]`, each `{kind, id}` or `{kind, ids, count}` | Every v1 reference must resolve to an emitted record, with no duplicate ids |
| Method and configuration version | `method.id`, `method.version`, `method.kitVersion`, `method.configSha256`, `method.configs` (SHA-256 per configuration file), `method.configRefs` | Every configuration input is hashed |
| Completeness or uncertainty status | `status.completeness` (`complete` \| `partial` \| `unknown`), `status.certainty` (`exact` \| `within_tolerance` \| `estimated` \| `unresolved`), `status.reasons[]` | Reason codes are required unless a record is both complete and exact |

Examples:
- A reconciliation link that matches exactly is still `partial` with `USAGE_MISSING_SAME_MODEL` when a same-model attempt reported no usage.
- An unresolved difference is `unresolved` with `CAUSE_NOT_ESTABLISHED`.
- Gateway estimates and token-weighted splits are always `estimated`.

v1 records keep their contract shapes. `envelope-coverage.json` maps how far each v1 contract covers the six elements and where it falls short. Most often, v1 has no produced instant, no completeness status and no configuration hash outside rate-card valuations. One gap is closed without a contract change: `estimated_invocation` records now fill v1's existing optional `configSha256` field. The remaining gaps are inputs to a separate contract proposal, which is an owner decision.

## Value-delivery KPIs (kit 0.4)

The kit inspects value delivery in three tiers. Each KPI value is a `ratio.kpi-observation/0-draft` record that carries the common envelope, so every number shows its source records, method and configuration hashes, and completeness and certainty. `out/kpi_scorecard.md` is the readable view. The catalog (`kpi_catalog.json`, version 1) and the business case (`business_case.json`) are versioned configuration inputs, so their hashes appear in every observation. Both are synthetic stand-ins; targets are "Set in demo configuration".

| Tier | Ties to | KPIs |
|---|---|---|
| Outcome | The business case, per registered outcome unit | Value / cost; cost per successful outcome (against the baseline); outcome success rate; adoption rate (against the eligible population); budget used (effective cost basis) |
| Operational | Service targets | Billed cost matched to observed usage; allocation coverage; usage telemetry completeness; attribution completeness; request success rate; retry rate; declared fallback rate; GPU unclaimed share; ingestion lag (p95) |
| Risk | Risk appetite, with warning and breach thresholds | Billed cost not observed by the gateway (cause not established); unattributed spend share; unpriced usage events; route mapping gaps; content exposure findings; GPU capacity over-claims; source estimate drift; prompts not inspected; sensitive data transfers allowed; unauthorized model access |

Each KPI is mapped to the eight program capabilities in the catalog.

Outcome KPIs follow Ratio's existing outcome rules (`src/outcomes/durable.ts`, `src/lib/vocabulary.ts`):
- **When Value / cost exists:** only with an approved registration (requester and approver differ), verified measured financial benefit, a full cost (allocated model cost plus all four supplemental categories) and equal comparison periods. Otherwise it is `N/A` with the same blockers the product uses, and the recommendation is `review`.
- **Recommendation:** when the ratio exists, the approved stop / change / continue / expand ladder applies.
- **Productivity:** estimated productivity is reported but never converted to cash.
- **Target:** 3× is a policy target configured for this workspace, not a financial standard.
- **One cost basis:** workload cost is effective cost throughout. API cost is allocated to workloads by observed usage (`allocation/1`, `api-cost-by-observed-usage`), and billed usage the gateway never saw stays unallocated (`GATEWAY_UNOBSERVED_USAGE`), never spread across workloads.
- **Mixed currencies:** a cost that spans currencies with no approved conversion policy blocks the ratio.
- **Incomplete ledger:** if any cost path a workload used was not allocated (for example, blocked GPU allocation), the cost ledger is incomplete and cost KPIs are unavailable rather than optimistic.

Indicators without a data source (prompt inspection, DLP outcomes, model entitlement) report `unknown`, not zero, with `SOURCE_NOT_INSTRUMENTED` until gateway policy decisions are ingested (roadmap slice C5).

Every KPI assessment in every scenario is pinned in `expected-results.json`. Two pairs of scenarios show what the indicators reveal:
- **Delay vs. bypass:** both breach "billed cost not observed by the gateway", but only the delay control also misses the ingestion-lag target. That second signal is why the coverage indicator says "cause not established".
- **Over-claim:** it makes allocation coverage collapse, and Value / cost moves to `review` (cost ledger incomplete).

In the bypass fixture:
- Support triage's Value / cost is 3.15× (`continue`), and its adoption is below target at 0.3.
- Code review's Value / cost is `N/A` with three blockers: supplemental costs missing, no verified financial benefit, and mixed currency.
- These are synthetic illustrations, not findings.

## Files

| File | Purpose |
|---|---|
| `ratio_telemetry_check.py` | Generator, normalizer, allocator, reconciler, checks and self-test (Python 3.9+, stdlib only) |
| `expected-results.json` | Exact `[status, code]` for every check in every scenario, plus the pinned self-test check count |
| `expected/bypass/` | Golden records and sidecars (fixed fixture key, seed 42) |
| `contract-conformance.test.ts` | Golden records against the repository's v1 validators (vitest) |
| `otel-collector.yaml` | Collector template for otelcol-contrib 0.114.0 |
| `prometheus-rules.yml`, `prometheus-rules.test.yml` | Recording and alerting rules, with promtool unit tests |
| `runtime_validate.py` | Runtime harness, gates G1 to G10, writes `runtime-evidence.json` |
| `versions.json` | Pinned tool versions and download sources; no container images are used |
| `kpi_scorecard.md` (generated in `out/`) | Readable scorecard of every KPI observation, grouped by tier |
| `envelope-coverage.json` | How the draft envelope and each v1 contract cover the six required elements |
| `MANIFEST.sha256` | Hashes of every kit file; checked by gate G1 |

## Scenarios (exact expected outcomes)

`python3 -I ratio_telemetry_check.py scenarios` lists them. Any outcome other than the one pinned in `expected-results.json` fails, including an unexpected warning.

| Scenario | Expected |
|---|---|
| `bypass` | `RECONCILIATION` WARN `GATEWAY_COVERAGE_DISCREPANCY`. Expected discrepancy detected in the synthetic bypass scenario. |
| `baseline` | All PASS (negative control) |
| `delay`, `delay-resolved` | Discrepancy while late events fall after the as-of time; none once they are inside it |
| `alias-unmapped`, `alias-mapped` | Mapping gap, unpriced usage and a discrepancy without the served-model map; none with it |
| `accounting-mismatch` | `OBSERVED_EXCEEDS_BILLED` plus source-estimate drift from a mis-set profile |
| `overclaim` | `GPU_CAPACITY` FAIL `CAPACITY_OVERCLAIM`; allocation skipped |

## Recorded results (cloud session, no binaries)

- `python3 -I ratio_telemetry_check.py self-test`: `self-test: OK (50 checks)`
- All 8 scenarios met their exact expectations.
- `npx vitest run tools/telemetry-discovery/contract-conformance.test.ts`: 8 passed.
- `python3 -I runtime_validate.py offline`: G1 and G2 PASS.
- G3 to G10 have **not run**. Downloading the pinned binaries was not permitted in that session.

The earlier "18/18 vs 19/19" difference was a miscount in a draft README for v0.1 (the script reported 18). The count is now pinned in `expected-results.json`, and the self-test fails if it drifts.

## Run on the Mac Mini

```bash
cd tools/telemetry-discovery
python3 -I runtime_validate.py offline                      # G1-G2
python3 -I runtime_validate.py fetch-tools --dest ./tools-bin  # pinned, checksum-verified
cp tools-bin/tools-lock.json .
python3 -I runtime_validate.py validate --otelcol ./tools-bin/otelcol-contrib \
  --promtool ./tools-bin/promtool --out ./evidence --disk-full
```

Ports 4317, 4318, 8888, 8889, 9109, 9411 and 13133 must be free. The harness starts the Collector, a local usage sink and a fixture file server, then runs these checks:
- **Ingestion:** it posts usage logs, traces and metrics containing canaries and checks exact outputs.
- **Privacy:** it scans every configured output, both Prometheus endpoints and the Collector log for canaries.
- **Sampling:** it checks that all error and slow traces are kept and that usage is never sampled.
- **Durability:** it runs a dedup test, a destination outage, a restart with a queued backlog, queue pressure (queue size 5) and, with `--disk-full`, a full queue disk on a 4 MB volume.

Unreachable scrape targets (dcgm-exporter :9400, allocation exporter :9401, LiteLLM :4000) only log warnings.

Changing the kit's status after a passing run is an owner decision. The harness records evidence and never changes the status itself.

## Provenance and limits

- All fixtures are synthetic and generated from seed 42. Prices, amounts, accounts and identities are invented. Provider billing in the fixtures is computed by separate code from the kit's normalizer, so a match is not circular.
- Field names marked VERIFY need checking against deployed versions: LiteLLM spend-log fields, dcgm-exporter and pod-resources labels, OTel GenAI attributes (Development status), the FOCUS `ServiceProviderName` column, the OTTL `event.name` location, and Collector internal metric names.
- The FOCUS check covers a required-column subset only; use the FOCUS validator for conformance. Invoice tax (FOCUS 1.4) is not modeled.
- The stage-1 GPU split does not separate node CPU, memory or network cost. The GPU allocation exporter that the Prometheus rules assume is a proposal, not an existing component.
- Span names are kept by the Collector. A buggy instrumentation that puts content in span names would not be caught.
- Regenerate after changes with `python3 -I ratio_telemetry_check.py golden` and then `python3 -I runtime_validate.py manifest`.
