# RFQ readiness build checklist

Status: working checklist. Branch `feat/rfq-readiness-build`. Each item is
checked only when its code, its tests and its hardening items are merged and
`npm run typecheck`, `npm run lint` and `npm test` pass.

Purpose: close the gaps between Ratio and a multicloud FinOps platform
solicitation (consolidated cost visibility, showback and chargeback,
forecasting, budget alerts, allocation governance, savings recommendations,
Kubernetes cost allocation, automated remediation, MCP connectivity, and
security and accessibility documentation), inside one agentic platform.

This checklist states what is built. It does not claim certifications. A SOC 2
report, a VPAT and a HECVAT need an auditor, a tested UI and a signed
attestation; the documentation items below produce the evidence those need,
not the documents themselves.

## Definition of done (applies to every item)

1. Strict TypeScript, no `any`, no new runtime dependency without a written reason.
2. Fail closed. Any malformed, oversized or unauthorized input is refused with fixed error text that never echoes the input.
3. Every collection has a cap (rows, series length, recipients, retries, payload bytes) and a test at the cap and one past it.
4. Time, randomness and network are injected, so every test is offline and deterministic.
5. Every read is tenant-scoped; every effect writes an audit record naming the acting subject.
6. Negative tests exist for each trust boundary (bad signature, wrong audience, replay, cross-tenant, SSRF target, over-cap input).
7. Money is never summed across currencies. Rounding rules are stated and tested.
8. en-US prose, per `AGENTS.md`. No secrets in logs, errors or test snapshots.
9. Nothing here weakens an existing rule (R1 to R4, governance gates, `authorize()` deny-by-default).

## Step 1. Real identity (`src/identity/oidc/`)

- [x] 1.1 OIDC token verifier implementing `TokenVerifier`: algorithm allowlist (RS256, ES256, EdDSA; never `none` or HS*), `iss`, `aud`, `exp`, `nbf`, bounded clock skew, `kid` lookup, strict claims parse.
- [x] 1.2 JWKS cache with bounded size and TTL, forced refresh on unknown `kid` with a cooldown, stale-if-error with a hard ceiling, and no fetch amplification under concurrent misses.
- [x] 1.3 Provider-claim to `Principal` mapping: configurable group-to-role map, deny when no role maps, teams and envs from claims, `authMethod: 'oidc'`, per-user `sub`.
- [x] 1.4 Replay and revocation hooks (jti denylist interface) and a fixed-text error type.
- [x] 1.5 Tests: valid token; every rejection code; algorithm confusion; key rotation; JWKS outage; oversized token; unknown claims.

Owner decision still open: which identity provider and protocol (sprint plan D1). The verifier is provider-neutral and takes issuer, audience and key-set location as configuration.

## Step 2. Fleet forecasting, anomaly detection, alert delivery (`src/detection/`, `src/notify/`)

- [x] 2.1 Daily-series forecasting with an interval, a stated minimum history, and an "estimated" flag when history is short.
- [x] 2.2 Anomaly detection per series with a severity matrix on dollar impact and percent deviation, dimension-novelty detection, and a ranked list of up to 10 root-cause contributors.
- [x] 2.3 Hierarchical grouping so one root cause yields one finding, plus open and resolve lifecycle.
- [x] 2.4 Budget threshold evaluation (70, 90, 100 percent) and forecast-breach evaluation over fleet spend.
- [x] 2.5 Alert delivery: email, Slack and signed webhook channels behind one interface; SSRF guard (https only, no private, loopback or link-local targets, DNS re-check), HMAC signing, retry with backoff and jitter, dedupe key, per-tenant rate limit, payload redaction.
- [x] 2.6 Tests: seasonality and weekday patterns, flat series, single spike, step change, missing days, currency isolation, every SSRF class, retry exhaustion, duplicate suppression.

Owner decision still open: outbound network egress is a restricted class (slice 3-5 D-17). Delivery ships with transports injected and disabled by default.

## Step 3. Allocation, showback, chargeback, tag governance, Kubernetes (`src/allocation/`)

- [x] 3.1 Rule-based allocation (tag, account, service, resource-prefix rules; first match wins; explicit precedence) with an "untagged" bucket that is never dropped.
- [x] 3.2 Shared-cost splitting (proportional, even, fixed-percent, by-usage) that reconciles to the cent: allocated plus unallocated equals ledger total, per currency.
- [x] 3.3 Showback and chargeback reports (by cost center, team, application, month) with a lock-and-adjust flow for closed periods.
- [x] 3.4 Tag-policy governance: required keys, allowed values, case and typo normalization suggestions, compliance percentage, and a violation list.
- [x] 3.5 Kubernetes apportionment: node and cluster cost split to namespace and label by request, usage or the larger of the two, with idle and overhead as explicit lines.
- [x] 3.6 Tests: reconciliation property tests with random inputs, rounding residue assignment, rule precedence, empty and huge rule sets, mixed currencies, period lock.

## Step 4. Native savings recommendations (`src/recommend/`)

- [x] 4.1 Commitment coverage and utilization from FOCUS commitment-discount columns, with on-demand eligible spend, coverage percent and unused-commitment cost.
- [x] 4.2 Normalizer for native recommendation feeds (AWS Compute Optimizer, Azure Advisor, GCP Recommender) into one finding shape, with savings estimate, confidence, effort and risk.
- [x] 4.3 Ranking and de-duplication across sources, and a payback calculation for commitment purchases that states its assumptions.
- [x] 4.4 Tests: partial coverage, expiring commitments, duplicate feeds, malformed feed items, negative or implausible savings rejected.

## Step 5. Governed remediation and MCP (`src/remediation/`, `src/mcp/`)

- [x] 5.1 Action registry with a risk class per action (low, medium, high) and a reversibility flag.
- [x] 5.2 Tiered-autonomy policy engine: low-risk reversible classes may execute under policy; everything else is propose-and-approve with separation of duties; the existing "never auto-applied" rule stays the default and autonomy is opt-in per tenant per class.
- [x] 5.3 Safety rails: dry-run first, blast-radius caps (count and cost), cooldowns, global kill switch, rollback record, and an audit record for every proposal, approval and execution.
- [x] 5.4 Allowlisted read-only MCP server core: tool registry, input schema validation, `authorize()` on every call, redaction, size and rate caps; writes denied for every role until the owner decides.
- [x] 5.5 Tests: autonomy off by default, cap breach, cooldown, kill switch, separation of duties, unauthorized tool, schema abuse, oversized results.

Owner decisions still open: which action classes may ever auto-execute (autonomy tiers), and whether MCP writes are ever enabled (sprint plan D6).

## Documentation (`docs/security/`, `docs/accessibility/`)

- [x] 6.1 Control-to-evidence map: each implemented control, the file that implements it, the test that proves it, and what is still missing for SOC 2 and HECVAT.
- [x] 6.2 WCAG 2.1 AA audit worklist for the existing UI with automated checks identified and manual checks listed. No conformance claim.


## Status as built

Every item in Steps 1 to 5 and the documentation items exist as tested library
modules. None is wired into an API route, the ingest seam, the database or the
UI yet, and each module keeps its state in memory. Exceptions and open gaps are
in each module's README. Cross-cutting facts:

- No real identity provider, cloud account, Slack workspace, SMTP server or
  cloud execution API has been exercised; every transport is an injected interface.
- `CanonicalFocusRow` lacks most commitment-discount columns and PricingCategory,
  so commitment analysis needs the ingest seam extended before it runs on real rows.
- Native recommendation feed field mappings must be validated against live responses.
- Fleet detection thresholds were tuned on synthetic data only.
- The documentation items are an evidence map and an audit worklist, not a SOC 2
  report, HECVAT, VPAT or conformance claim.

## Verification gate

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm run lint` clean.
- [x] 7.3 `npm test` green, with the new suites included.
- [x] 7.4 Independent review of the combined diff by a reviewer who did not write it; findings fixed or recorded.
- [ ] 7.5 Branch pushed; no force push; no change to `main`.

## Explicitly not in this build

Real cloud billing data and credentials, production deployment, a SOC 2 report,
a signed VPAT or HECVAT, cloud-side execution of remediation (adapters are
interfaces with in-memory test doubles only), and a live identity provider.
