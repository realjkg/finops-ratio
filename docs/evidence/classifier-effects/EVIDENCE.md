# Classifier effects: evidence

Owner-approved 2026-10-25: classify by effect, not only directory. Files that
affect financial calculations, evidence integrity, authorization, allocation or
exports are protected. Red and green runs: `red.txt`, `green.txt`.

## Regression analysis: last 10 merged PRs, before and after

Ran `classify-risk.mjs --git <first-parent>..<merge>` with the base classifier
(origin/main db4a1e2) and with this branch. Risk was restricted in all ten
before and after. Only the class lists differ; every change adds a class.

| PR | Before | After |
|---|---|---|
| #129 (db4a1e2) | [dependencies,deployment] | [dependencies,deployment] |
| #125 (2c357cf) | [financial_semantics,unclassified] | [financial_semantics,unclassified] |
| #124 (4ae9cba) | [dependencies,financial_semantics,routes,unclassified] | [dependencies,exports,financial_semantics,routes,unclassified] |
| #123 (55fb075) | [routes,unclassified] | [routes,unclassified] |
| #128 (bf5dfab) | [unclassified] | [unclassified] |
| #127 (ec2084e) | [unclassified] | [evidence_integrity,exports,unclassified] |
| #122 (409c792) | [deployment,network_egress,routes,unclassified] | [deployment,network_egress,routes,unclassified] |
| #121 (f128be8) | [routes,unclassified] | [evidence_integrity,routes,unclassified] |
| #107 (4a0db6c) | [network_egress,unclassified] | [network_egress,unclassified] |
| #106 (7480ae1) | [network_egress,unclassified] | [network_egress,unclassified] |

Reading the changes: #127 gains `evidence_integrity` and `exports` (it touched
`src/evidence/**`); #124 gains `exports`; #121 gains `evidence_integrity`
(it touched `src/lib/valueEvidence*`). No PR lost a class or became low.

## Whole-tree monotonicity (951 tracked paths, one path per run)

- Loosened (restricted to low, or a named class dropped): 0.
- Same result: 896. Class list changed while still restricted: 42.
- Low to restricted: 13, all test files beside protected code, for example
  `src/rbac/matrix.test.ts`, `src/evidence/evidence.test.ts`,
  `src/lib/derive.test.ts`. This is intended: a tests-only PR that edits the
  checks guarding authorization or evidence is no longer auto-low. It matches
  the existing rule that restricted rules win over the low test allow-list.

## Not changed

Merge-eligibility gate, workflows, required checks, the fail-closed default,
every existing rule and every low allow-list entry (a test pins the low list).

## Known limits

- Matching is by path name. A protected function moved into an unlisted file
  is caught only by the fail-closed default (restricted:unclassified).
- `src/srmd/**` does not exist yet. Its two rules are scoped to that prefix and
  match by name (ingest, evidence, provenance; authority, grant, policy,
  permission, principal, credential). Revisit when the directory lands.
- The `exports` name rule matches `export` or `xlsx` in any `src/**` or
  `pages/**` file name. It can over-match (for example a type named for
  exports); over-matching only costs a review, never a bypass.
- Content-level effects (for example a new money calculation inside an
  unlisted UI file) are not detected by effect rules.
- This classifier is advisory labeling; eligibility re-classifies and the
  human merge flow decides.
