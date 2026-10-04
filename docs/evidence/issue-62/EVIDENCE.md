# Issue #62 — evidence: the worker rejects rows whose `ProviderName` does not match the source type

Branch `fix/62-provider-source-check`, from `origin/main` 827773f. Not pushed;
no PR. Design: `DESIGN.md` (this directory). Restricted class (Slice 1 worker
behaviour): needs a challenger review.

**Isolation.** Other agents share this host and its Docker daemon. Every run
used its own names and ports, and everything was removed afterwards:
- `test:db`: a private PG16 cluster (`initdb` as `postgres` via `setpriv`,
  `/dev/shm/i62pg`, 127.0.0.1:55930, `fsync=off`), and a private SeaweedFS
  container `i62-s3` on 127.0.0.1:55931. Both were stopped and deleted at the
  end;
- `local:test`: project `ratio-i62-test` on 55940/55941/55942;
- `local:acceptance`: project `ratio-i62-acc` on 55950/55951/55952.

## 1. Commits

| # | SHA | Commit | Kind |
|---|---|---|---|
| 1 | e18c949 | design note | docs |
| 2 | d1e47ed | U1, D1–D8, P1 provider filter, A12, A5/A9/P2 updates; red output | **red** |
| 3 | 4034504 | `focus/provider.ts`, loader / pipeline / publish wiring; calculator `--provider`; re-pinned `control-totals.json`; acceptance checks | green |
| 4 | ed2e3cb | `excludedRows` shown in the acceptance summary; run records | chore |
| 5 | (this file) | EVIDENCE | docs |

**Slice 0/1 tests:** none modified (`git diff 827773f -- 'src/**/*.test.ts'`
lists only the two new files). Slice 2b tests changed:
- `acceptance.test.mjs`: A5's catalog fixture gains
  `validation_error_count: '0', error_codes: {}`. A9 now requires
  `--provider` on the calculator call, and the API artifact-set check on
  `publishedShas`. A12 is new;
- `controlTotals.test.mjs`: the pinned checks run with `--provider AWS`.
  `--rows` now expects 942 rows, all `AWS`. There is a new continuity test:
  without `--provider`, the calculator still gives the all-provider totals
  and digests recorded in Slice 2b EVIDENCE §2;
- `test_focus_control_totals.py`: `ProviderFilterTests` is new.

## 2. Red evidence (`red/`, at d1e47ed)

| File | Result |
|---|---|
| `red-fast.txt` | `provider.test.ts` cannot import `./provider`. 14 failed / 81: P1 (8 new Python tests: errors, plus one failure), P2 pinned and `--rows`, the 9 A12 tests, and the A9 calculator-call and comparison checks |
| `red-python.txt` | `python3 -m unittest`: `FAILED (failures=1, errors=7)` (no `providers` argument, no `--provider`) |
| `red-db.txt` | `providerCheck.db.test.ts`: 11 failed / 13. D1 (×2): published with 7 rows, no `excludedRows`. D2 (×2): published or `EMPTY_BATCH`. D3 (×2): published. D4: published with 6 rows. D5 (×2): error counts. D6: no exclusion error. D7: published 2 rows. The 2 that pass at red describe today's behaviour and must stay: D1 "no foreign rows ⇒ no `excludedRows`", and D8 (unchecked type) |

**Test defect corrected after red** (no assertion weakened): the first
`ProviderFilterTests` case called `compute(..., rows=True)` on a 6-column
header without `ChargePeriodStart`. The calculator correctly refuses that
for `--rows`. The case now checks totals only. The `--rows` behaviour moved
to a new case on the full header, which also asserts that Ids stay unique
across excluded records (4034504).

## 3. Gates

| Gate | Result |
|---|---|
| `npm run lint` | exit 0 (at ed2e3cb) |
| `npm run typecheck` (`tsc --noEmit`) | exit 0 (at ed2e3cb) |
| `npm test` | **2524 passed** (106 files), at 4034504 and again at ed2e3cb. Includes the role-DDL guards, which were also run alone: `parallelRoleDdl.test.ts` + `serialLogins.test.ts` 21 passed. The new DB test uses only `workerTestDb()`, with no role DDL |
| `npm run test:db` run 1 | parallel **610 passed** (35 files); serial **173 passed** (6 files); exit 0 (4034504) |
| `npm run test:db` run 2 | parallel **610 passed**; serial **173 passed**; exit 0 |
| `next build` (`npm run build`) | exit 0 |
| `npm run check:bundle` | `{"pass":true,"stats":{"clientFiles":116,"serverFiles":91},"problems":[]}` |
| `npm run local:test` | exit 0, `pass: true` (`runs/localtest.json`). The synthetic fixture, staged as AWS Data Exports, publishes 55 / 40 rows as before (D1 of DESIGN §8: `SyntheticCloud` allowed) |
| `npm run local:acceptance` (1k) | exit 0, `pass: true`, 22.6 s (`runs/acc1k.json`) |
| `npm run local:acceptance -- --dataset 10k` | exit 0, `pass: true`, 27.7 s (`runs/acc10k.json`) |

Baseline on main (827773f, same cluster) before any change: `test:db`
parallel 597, serial 173. The delta is the 13 new D-tests.

## 4. The acceptance run (DESIGN §5, option (a))

**Control totals, AWS rows only.** They come from the calculator
(`--provider AWS`, integer arithmetic) on the upstream files. They are
pinned in `fixtures/focus-1.0-sample/control-totals.json`.

| File | Period | Rows | BilledCost | EffectiveCost | Row digest | Excluded |
|---|---|---|---|---|---|---|
| 1k | 2024-09 | 942 | `18.00663861840` | `13.00000000000` | `7e46d060bcf2c04a5d904387de53e44cdfc5078e9e0aa985e44b3192ad112bc9` | 57 (Microsoft 51, Oracle 6) |
| 1k | 2024-10 | — | — | — | — | 1 (Oracle 1) |
| 10k | 2024-09 | 9,441 | `112.16617543240` | `55.00000000000` | `ba207803b4a187e765269e4cced14e0c04bf2f56982356a51f867c1a18ed2ee0` | 557 (Microsoft 491, Oracle 66) |
| 10k | 2024-10 | — | — | — | — | 2 (Oracle 2) |

**Third-method cross-check (before pinning).** A separate scratch script
(not committed) reproduced `providerFilter`, `excluded` and `totals` for
both files: `EQUAL` / `EQUAL`. It uses `csv.DictReader` plus
`decimal.Decimal` at precision 200 with `Inexact` trapped, keeps rows whose
`ProviderName == 'AWS'`, and renders money in numeric::text form.

Without `--provider`, the calculator still reproduces Slice 2b's
all-provider totals and digests (999 / `20.28022672899`, 1 /
`0.24000000000`). A P2 test pins that.

**Live runs (the real CLI, the real S3 source, the real route under
`next start`):**

| | 1k | 10k |
|---|---|---|
| staged objects | unchanged from Slice 2b (`85301b48…`, `2f3c58f1…`) | unchanged (`7505544a…`, `8239f139…`) |
| first `sync` | exit **1**. 2024-09 `published` 942 / `18.00663861840`, `unverified`, `excludedRows` **57**. 2024-10 `quarantined` **`PROVIDER_MISMATCH`** | exit 1. 2024-09 `published` 9441 / `112.16617543240`, `excludedRows` **557**. 2024-10 `quarantined` `PROVIDER_MISMATCH` |
| second `sync` | exit 1. 2024-09 `skipped_unchanged`; 2024-10 `failed` `BATCH_QUARANTINED` | same |
| anonymous read | 401 | 401 |
| API totals | 2024-09 only, equal to the control | equal |
| API rows / pages | 942 / 2; full-row comparison of 942 rows × 21 fields + 25 extra columns: no problem | 9441 / 19; no problem |
| catalog | 2024-09 `published`, `validation_error_count` 57, stored codes `{PROVIDER_MISMATCH: 57}`. 2024-10 `quarantined`, row_count 0, `validation_error_count` 1, reason `PROVIDER_MISMATCH: every data row (1) has a ProviderName not allowed for source type aws-data-exports (PROVIDER_MISMATCH x1)` | 557 / 2, same shape |
| evidence re-hash | 2/2, including the quarantined 2024-10 object | 2/2 |
| `appStop` / `down` | `stopped` / `ok (-v)` | same |

**Why this shows that exactly the foreign rows were excluded.**
- The full-row comparison matches every API row by `Id` to an upstream
  **AWS** record, and reports any API row that is not one. So all 942 AWS
  rows are published and no foreign row is.
- The catalog's stored errors are exactly 57 `PROVIDER_MISMATCH`, which is
  the control's count of non-AWS rows in that period.

## 5. Mutations

### 5.1 Code mutations (`runs/code-mutations.txt`; all **killed**)

Each mutation was applied to the source, the listed suites were run, and
the source was restored in a `finally` block. The tree was clean after the
run.

| Id | Mutation | Killed by |
|---|---|---|
| M1 | check disabled: `providerPolicyFor` returns null for every source | U1 (12 failed), D (11 failed) |
| M1b | check disabled in the loader only | D (10 failed) |
| M2 | NULL accepted | U1 "NULL is a hard MISSING_VALUE error"; D3 "empty ProviderName cell" |
| M2b | missing column accepted | U1 header (2); D3 header |
| M3 | case-insensitive match | U1 exact-match; D4 |
| M4a | loose match: trimmed | U1 exact-match; D4 |
| M4b | loose match: prefix (`startsWith`) | U1 exact-match; D4 |
| M4c | loose match: the long name `Amazon Web Services` accepted | U1 exact-match; D4 |
| M5 | all-foreign batch ⇒ `EMPTY_BATCH` | D2 (2) |
| M6 | exclusions not counted in `validation_error_count` | D1 |
| M7 | exclusions not stored on the published batch | D1, D4, D7 |
| M8 | a mismatch quarantines the whole batch | D (7) |
| M9 | excluded rows inserted anyway | D (9) |
| M10 | `Amazon Web Services` added to the allowlist | U1 (4), D (2) |
| M11 | `Microsoft` allowed for AWS | U1 (3), D (4) |
| M12 | calculator filter case-insensitive | P1 |
| M13 | calculator filter ignored | P1, P2 pinned, P2 `--rows` |
| M14 | acceptance: `excludedRows` not checked | A12 first sync |
| M15 | acceptance: a quarantined period accepted as published | A12 first sync |
| M16 | acceptance: stored error codes not checked | A12 catalog |

### 5.2 Data mutations through `local:acceptance` (1k; each exit 1, `down` `ok (-v)`)

| Kind | Failure (first sync) | File |
|---|---|---|
| `corrupt-text-columns` | `rowCount "941" != "942"`, `billedTotal`, `excludedRows "58" != "57"`. The first AWS record's `ProviderName` became `AWS~mutated`, and the worker now excludes it | `runs/mutation-corrupt-text-columns.json` |
| `drop-row` | `excludedRows "56" != "57"`. The dropped last record of 2024-09 is a foreign row, so only the exclusion count can see it. That is one reason the check exists | `runs/mutation-drop-row.json` |
| `corrupt-billed` | `billedTotal "18.00663861841" != "18.00663861840"` | `runs/mutation-corrupt-billed.json` |

The other 2b data mutations were not re-run. Their expected side changed
only by the provider filter.

## 6. Decisions needed from the orchestrator

See DESIGN §8. In short:

1. **D1:** `SyntheticCloud` is on the `aws-data-exports` allowlist, because
   unmodifiable Slice 1 tests, `replay-fixtures` and `local:test` stage the
   synthetic fixture in that layout. The alternative is an explicit
   synthetic marker in the source config, which needs Slice 1 test edits.
2. **D2:** NULL `ProviderName` quarantines the whole batch. AWS documents a
   conformance gap ("ProviderName might be null for certain charges"), so
   real periods could be blocked.
3. **D3:** a mismatch excludes the row and the rest is published, as
   briefed; whole-batch quarantine is a one-line alternative. Manifest
   controls that count the foreign rows quarantine the batch
   `RECONCILIATION_VARIANCE` (D6 test).
4. **D4:** sources without a recognised type (unreachable from the CLI) are
   not checked; failing closed there breaks about a hundred Slice 1 tests.
5. **D5:** `Amazon Web Services` is not allowed. The AWS docs could not be
   read from this environment, so `AWS` is unconfirmed against a real
   export until the owner's manual acceptance run.

## 7. Cleanup

The private cluster (`pg_ctl stop`, `/dev/shm/i62pg` removed), the
`i62-s3` container, the `ratio-i62-test` and `ratio-i62-acc` compose
projects (`down -v`, including their `.ratio-local/<project>/`) and all
scratch files are gone. `.ratio-sample-data/` (the pinned 10k copy,
gitignored) was left in this worktree.
