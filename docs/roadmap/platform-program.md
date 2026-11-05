# Platform program roadmap (AI usage, adoption and policy)

Status of every row: **planned**. Nothing here is released, and nothing here is evidence for the 1.0 release
candidate, which keeps its own security and deployed-demo gates (README "Engagement mode" cites rows R1–R4 and R11; R12 packaging evidence is `docs/evidence/r12-packaging`). Design:
[ADR-0001](../adr/ADR-0001-ai-usage-and-gateway-platform.md).

## Numbering

`package.json` is at 1.0.0 and the repository has no tags or changelog before this program, so the line starts at
the next minor after the pending 1.0:

- **1.1, 1.2, 1.3 are minor releases**: additive only (new tables in the 0020–0039 migration band, new read APIs,
  feature flags off by default in engagement mode). A 1.0 instance that does not enable them behaves exactly as 1.0.
- **2.0 is a major release**: enforcement blocks customer traffic and makes a gateway path mandatory for the covered
  workload, which changes runtime behavior and deployment topology for anyone who enables it.
- Each shared contract has its own `schemaVersion` (`<name>/<major>`, `src/platform/contracts/versions.ts`), pinned
  by `schemaPin.test.ts`; product versions and contract versions move independently.

## Releases

| Release | Workstreams | Capabilities | Exit gate (all must hold; pre-release unless marked live) |
|---|---|---|---|
| **1.1 Platform Foundation + Economics** | Stream A: versioned event, identity, connection and evidence contracts; one provider's usage linked to financial records; reconciliation with explained variances; attribution coverage | 1, 4 | Tenant isolation, dedup, correction (append-only, `supersedes`) and privacy tests pass; one provider's usage files reconcile to the approved cost source's control totals with every variance explained; unmatched charges, allocation gaps, missing usage and missing rates shown as N/A, never 0; contract schema versions pinned with migration tests |
| **1.2 Adoption and utilization** | Stream B: one activity source + eligibility snapshots (engagement directory and OIDC bindings); pseudonymization; service-account separation; retention; drill-down permission | 2, 3 | Reproducible numerator and denominator from fixtures; identity mappings and exclusions tested; services never in human metrics; `reports:read` alone cannot drill down; deletion jobs tested |
| **1.3 Policy monitor-only + read-only A2A** | Stream C: policy contract, local evaluation library, signed bundles, mock-gateway conformance, one gateway integration in monitor mode; read-only A2A over the same authorized services | 5–8 (monitor) | Correct decisions on the conformance suite; measured operational impact of monitor mode (decision latency, telemetry gaps) at the integration; external-client authorization and artifact isolation tests for A2A |
| **2.0 Enforcement + Operations** | Stream C: controlled blocking for one application/workload, budget reservations; Operations: load, restore, upgrade, rollback | 5–8 (enforce) | Input/output, outage, streaming, partial-failure and bypass tests; **live**: load, restore, upgrade and rollback evidence against customer-approved capacity and recovery objectives |

## North-star acceptance test (first enterprise milestone)

One approved identity source, one AI application, one model provider, one billing source and one enforced gateway
path: who used it, what was consumed, what it cost, which policy applied, and the evidence behind every claim.
Pre-release it runs on synthetic fixtures and the mock gateway; it is met only when it runs live in the owner's pilot.

## Status wording

Until live evidence exists, a capability is at most "implemented and pre-release validated; live verification
scheduled". No release on this page claims enterprise support.

## Changelog (planned)

- **1.1.0 — planned.** Platform contracts (wave 0: types and validators only, ADR-0001); usage and cost file
  import for one provider; versioned rate cards; estimate-versus-billed reconciliation; workload allocation.
- **1.2.0 — planned.** Eligibility snapshots; one activity source; adoption definitions; pseudonymization;
  drill-down permission; retention jobs.
- **1.3.0 — planned.** Policy bundles and local evaluation library; mock-gateway conformance; one monitor-only gateway
  integration; read-only A2A.
- **2.0.0 — planned.** Enforcement for one workload; budget reservations; operations evidence.
