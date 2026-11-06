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

- `python3 -I ratio_telemetry_check.py self-test`: `self-test: OK (38 checks)`
- All 8 scenarios met their exact expectations.
- `npx vitest run tools/telemetry-discovery/contract-conformance.test.ts`: 7 passed.
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
