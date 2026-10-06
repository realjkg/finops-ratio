# Outcome accountability acceptance — 2026-10-05

## Implemented foundation

| Requirement | Saved record and workflow |
| --- | --- |
| Owner and baseline | Owner, role, primary metric/unit, target/direction, pre-AI and observation periods, values and evidence references |
| Value measure | Revenue contribution, realized spending reductions, quality and risk; assumed/projected/measured status; attribution, margin, references and method; independent review |
| Full cost | Model-usage ledger plus infrastructure, implementation allocation, oversight and ongoing labor for the same period; explicit unknown or evidenced zero |
| Decision threshold | Stop/change/continue/expand bands on benefit/full cost, performance target, governance checks, rationale and decision history |

Pure calculations and command validation live in `src/outcomes`. The same projection
powers the Outcomes UI, saved report JSON, PDF appendix and XLSX sheets. The local
simulation persists records per tenant with revision/CSRF checks and atomic audit
entries. Workspace migration preserves previous costs and import history.

## Calculation and review rules

Revenue benefit uses contribution margin and AI attribution, not gross revenue.
Quality and risk do not enter cash benefit totals. A measured ratio requires
independently reviewed financial value, complete measured supplemental costs,
ledger coverage for every observation date and comparable period lengths. Net ROI
and the benefit/cost multiple are separate metrics.

A different Executive/Procurement identity reviews measured claims. Changing a
claim or its performance basis removes review; changing period dates resets its
supplemental costs. Decisions retain a snapshot of evidence, costs and governance;
changes flag renewed review. Continue/expand enforce return and performance targets;
expand enforces all governance gates. Decisions record business authorization and
leave implementation to the separate change workflow.

Evidence references and methods are user-entered metadata, not automated verification
of external documents. Overlapping benefits require reviewer reconciliation. Baseline
fixtures and claims remain simulated; original operating metrics keep their seeded
value assumptions. Initial RBAC is intentionally small and can be refined.

## Validation

- Outcome, persistence, migration and report regression: 10 files, 47 tests pass, including a forced concurrent upgrade/write.
- Browser acceptance: 5 tests pass, covering original customer workflows plus
  Technical entry → Procurement evidence verification → Executive decision,
  persisted reloads, saved report values, stale decisions and mobile risk evidence.
- Type checking, lint, optimized build and bundle isolation check pass.
  Final browser run: 5 tests / 30.3 seconds.
- Last full regression run: 2,633 tests pass, four existing process-group cleanup tests fail
  in this execution environment. The suite is not reported as fully green.
- Snapshot exports retain existing report columns and add outcome appendices.

Run instructions and calculation definitions are in README. No live accounts,
provider changes, actual messages, GitHub publication or deployment were performed.
Real identity, source reconciliation and production persistence acceptance remain
separate release gates from this simulated outcome foundation.
