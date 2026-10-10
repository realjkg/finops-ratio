# Customer workflow simulation acceptance — 2026-10-05

Branch: `feat/customer-workflow-simulation`, based on main `732f59f`.

## Implemented

- Local durable SQLite tenant workspaces, automatic integer-cent ledger fixtures,
  replay-safe imports, revision checks and transactional audit records.
- Mock identity selector for Executive, Technical and Procurement in two tenants;
  server-held expiring opaque sessions, revocation, origin/CSRF checks and
  server-side permissions independent of the presentation lens.
- Saved source reconciliation, budgets, thresholds, governance, demand shaping,
  model switches, alert acknowledgement, finding dismissal and restoration.
- Request → separate-persona approval → simulated application; historical billed
  costs remain unchanged when applying projected optimizations.
- Reports screen, saved-snapshot PDF/XLSX exports, mock AI using saved data,
  simulated delivery history and shared navigation with mobile workload tabs.
- S3 truncated-listing failure when the continuation token is missing (#57);
  UTC interpretation of zoneless FinIO timestamps across DST hosts (#64).

## Validation

Node 24.19.0; Chromium 153; Next 16.3.6.

- Lint and type checking: pass.
- Optimized production build: pass. Bundle guard: pass.
- Focused persistence, boundary, report, FinIO and transport suite: 23 files /
  472 tests pass. Full suite: 116 files / 2,623 tests pass; four process-group
  cleanup tests in `scripts/local/local.test.mjs` fail in this sandbox. These
  tests and their implementation were not changed. Do not treat the suite as green.
- Built-app browser acceptance: 3 tests pass, 8.6 seconds. All personas import,
  investigate, switch a model, request/approve/apply a change, reload saved data,
  fund a budget, export PDF/XLSX, preview delivery and revoke sessions. Mobile
  visits 13 routes and checks overflow and keyboard chat dismissal. HTTP checks
  reject forged permissions, foreign workloads, CSRF and stale revisions; live
  endpoints reject simulation credentials.
- Session deadline regression: 3 simulation files / 8 tests pass, including
  expiry of a valid opaque session at the one-hour deadline.
- Direct development-server PDF check: HTTP 200, 5,931 bytes.
- Development-server browser runs timed out during the report-download journey
  in this execution environment. The default acceptance suite runs against a
  freshly built app; repeat dev-server browser acceptance locally before real
  account testing.

## Remaining release gates

This is development simulation acceptance, not production readiness. Real OIDC
identity/tenant/role mapping, personal-account ingestion and independent billing
reconciliation, production PostgreSQL integration, live authorization/rollback,
actual delivery and recovery still need dev-mode acceptance. SQLite here stores
only mock customer workflow state; the mock identity selector must stay disabled
on customer deployments. Standalone FinIO, Tokenomics, Prediction and CostSource
experiments remain fixture sandboxes. Fleet-scale forecasting/anomaly capabilities
from the separate 15,000-account design remain outside this implemented workflow.

Run instructions are in the README. No deployment or release was performed.
