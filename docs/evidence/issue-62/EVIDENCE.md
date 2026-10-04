# Issue #62 — evidence: the worker rejects rows whose `ProviderName` does not match the source type

Branch `fix/62-provider-source-check`, from `origin/main` 827773f. Not pushed;
no PR. Design: `DESIGN.md` (this directory). Restricted class (Slice 1 worker
behaviour): needs a challenger review.

**How to read this file.**
- §1–§7 record the first round, at ae3c142. Superseded there: D1 put
  `SyntheticCloud` on the AWS allowlist.
- §8 records the orchestrator's decisions of 2026-10-04 and the gates after
  them, at d480eec.

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

## 8. Orchestrator decisions (2026-10-04) and the second round

The decisions are recorded in DESIGN §8 ("decided by orchestrator,
2026-10-04"):
- **D1 changed:** the synthetic providers are gated by
  `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1`. A later addition makes this a fixed
  `SYNTHETIC_PROVIDERS` set of four names.
- **D2, D3 and D5 accepted.** D2's revisit trigger is recorded.
- **D4 accepted with a guard test.**

### 8.1 Commits

| SHA | Commit | Kind |
|---|---|---|
| 70a0ae0 | U1 rewritten for the opt-in; `syntheticProviders.test.ts` (S1); `sourceFactory.test.ts` (G1, D4 guard); D9/D10; local opt-in tests | **red** (`red/red-d1-fast.txt`: 12 failed / 105; `red/red-d1-db.txt`: 6 failed / 19. G1 passes at red: it pins existing factory behaviour) |
| ca0378a | the opt-in: `config.ts`, `provider.ts`, pipeline, CLI log, `replay-fixtures` pass-through; harness: vitest DB configs `env`, `testS3Env()`, `local.mjs` / `lib.mjs`; DESIGN §8 | green |
| 8e4abd6 | decision mutation record | docs |
| 402b8e5 | the fixed `SYNTHETIC_PROVIDERS` set: U2 and a D9 case | **red** (`red/red-synthetic-set-fast.txt`: 6 failed / 21; `red/red-synthetic-set-db.txt`: 3 failed / 20) |
| 642b5f3 | `SYNTHETIC_PROVIDERS` = `SyntheticCloud`, `SyntheticAWS`, `SyntheticAzure`, `SyntheticGCP` | green |
| 59367d7 | D10: the startup log names no provider | **red** (`red/red-k1-log.txt`) |
| d480eec | the startup log carries `syntheticProviderCount`, not the names | green |

**Defect found by a Slice 1 test, fixed in code.** The first opt-in log
listed the provider names. `cliWorker.db.test.ts` K1 refuses any
`SyntheticCloud` in CLI output, because logs never carry row values. The
D10 test had asserted the names. It was corrected to assert the opposite
(count only, no names) and committed red. The code then changed. No Slice 1
test was touched.

**How the opt-in reaches the existing tests (no Slice 0/1 test file edited):**
- the library DB tests: `env: { RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' }` in
  `vitest.db.config.ts` and `vitest.db.serial.config.ts`;
- the in-process CLI tests (`cliWorker.db.test.ts`, `demo.db.test.ts`):
  `testS3Env()` in `src/ingest/testing/s3.ts`. That is the harness helper
  they already use to build the worker env, not a test file;
- `local:sync` / `local:test`: `syncRecord(…, { syntheticProviders: true })`
  for the SYNTHETIC fixture source only. `local:acceptance` runs with the
  opt-in off (0 opt-in log lines in its run).

### 8.2 Gates (at d480eec unless noted)

| Gate | Result |
|---|---|
| lint, typecheck | exit 0 |
| `npm test` | **2542 passed** (108 files) |
| `npm run test:db` ×1 | parallel **617 passed** (35 files); serial **173 passed**; exit 0. At 642b5f3 the parallel phase failed K1 (the log defect above); d480eec fixes it |
| `npm run local:test` | exit 0, `pass: true`; 55 / 40 rows as before; the opt-in logged once per worker start (2 syncs ⇒ 2 lines) (`runs/localtest-decisions.json`) |
| `npm run local:acceptance` (1k) | exit 0, `pass: true`, 23.1 s. First sync exit 1: 2024-09 `published` 942 / `18.00663861840`, `excludedRows` 57; 2024-10 `quarantined` `PROVIDER_MISMATCH`. Catalog `{PROVIDER_MISMATCH: 57}` / `{PROVIDER_MISMATCH: 1}` (`runs/acc1k-decisions.json`) |

### 8.3 Mutations (all killed)

`runs/code-mutations-decisions.txt` covers M17–M20 plus re-checks of M1–M4b.
`runs/code-mutations-synthetic-set.txt` covers M17 again, M21 and M22.

| Id | Mutation | Killed by |
|---|---|---|
| M17 | synthetic providers always allowed (opt-in ignored) | U1 (5), D (5: D9 off cases, D10 off) |
| M17b | `SyntheticCloud` back on the AWS base list | U1 (5), D (4) |
| M17c | the CLI ignores its env and always opts in | S1 (4), D10 off |
| M18a | default ON in `DEFAULT_SETTINGS` | S1 |
| M18b | unset env means ON | S1, D9 library default |
| M18c | a loose value (`true`) accepted | S1 |
| M19 | the opt-in accepted in production | S1 |
| M20 | the factory accepts `focus_file` without the AWS layout | G1 |
| M20b | no startup log | D10 on |
| M21 | the opt-in widens real names (`Microsoft` accepted when on) | U2, D9 synthetic set |
| M22 | `SyntheticGCP` dropped from the set | U2, D9 synthetic set |
| M1, M2, M3, M4b | check disabled, NULL accepted, case-insensitive, prefix | U1 and D, as in §5.1 |

### 8.4 Notes for the orchestrator

- `testS3Env()` (a Slice 1 harness helper) carries the opt-in for the
  in-process CLI tests in `cliWorker.db.test.ts` and `demo.db.test.ts`.
  testS3Env() placement confirmed by orchestrator, 2026-10-04: harness
  helper, not a test file; preferred over editing Slice 1 test files.
- `replay-fixtures` was later made **test-only** (§9.1, L3 decision). Its
  `RATIO_ENV=test` runs need `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1`. Production
  refuses the opt-in at config load.
- `SYNTHETIC_PROVIDERS` is a frozen array, so it cannot be changed at
  runtime (a frozen `Set` still accepts `add`). Exact, case-sensitive names.

## 9. Challenger round (REQUEST CHANGES: 1 Medium, Lows), at 62fef2a

| SHA | Commit | Item |
|---|---|---|
| ff3a963 | revert Next's build rewrites of `tsconfig.json` / `next-env.d.ts` to main (a new commit; ed2e3cb not rewritten) | L5 |
| c1e0cdb | tests | **red** (`red/red-challenger-fast.txt` 7 failed / 88; `red/red-challenger-db.txt` 2 failed / 26). L3: S1-L3, the library and CLI cases. L2: `workerEnv` `'0'`, the stderr checks, `captureErr`. L1: D11 passes at red, because it pins existing reconcile behaviour |
| 2108b61 | the opt-in is accepted only with `RATIO_ENV` explicitly `development`/`test` (checked first; exit 2). `workerEnv` sets `'0'` explicitly. The syncs capture stderr; the acceptance fails on the opt-in log. Harness: the DB vitest env adds `RATIO_ENV=test`, `testS3Env()` adds `RATIO_ENV=development` | L3, L2 |
| e80445f | DEPLOYMENT_BRIEF (status row, D-02, the D-02 detail table, the §8 check), the Slice 2b DESIGN backlog note, DESIGN D3 + §2.2 controls table, L3 notes, §8a re-check gap; D12 test; mutation record | M1, L1, L3, L4 |
| 423341d | test: `run()` must forward `captureErr` | **red** (`red/red-challenger-run-captureerr.txt`). The first live `local:acceptance` run failed "stderr was not captured": `run()` dropped the option |
| 62fef2a | `run()` forwards `captureErr` | L2 |

**L4, corrected against the code.** The suggested remedy, `replay`, does not
re-check identical bytes. `replay --period` and `backfill` both find the
published batch by data fingerprint and return `unchanged`. The new D12 test
pins this. New bytes, a re-delivered export, are checked under the current
policy (D12, second case). DESIGN §8a records this as the known Slice 1 gap
and escalates a possible `--revalidate` mode. No production data exists, so
there is no impact today.

**L3, escalated, not widened.** `replay-fixtures` ran in staging, where it
can no longer opt in. The orchestrator then decided to make it test-only
(§9.1). The per-source synthetic marker is tracked for Slice 3 (D-21).

**Gates:**

| Gate | Result |
|---|---|
| lint, tsc | exit 0, after the L5 revert and at 62fef2a |
| `npm test` | **2549 passed** (108 files), at 62fef2a |
| `npm run test:db` ×1 | parallel **625 passed**, serial **173 passed** (at e80445f; later commits change `scripts/local` only, covered by `npm test`) |
| `npm run local:test` | exit 0, `pass: true` (`runs/localtest-challenger.json`); the synthetic fixture sync logs the opt-in (2 lines, 2 syncs) |
| `local:acceptance` 1k | exit 0, `pass: true`, 22.3 s; 0 opt-in log lines (`runs/acc1k-challenger.json`) |
| `local:acceptance` 1k, `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` (and `RATIO_ENV=test`) exported in the parent shell | exit 0, `pass: true`, 22.7 s; 0 opt-in log lines: the worker ran with `'0'` (`runs/acc1k-challenger-parent-optin.json`) |
| the same, with the pre-fix `workerEnv` (opt-in omitted when off), as a live mutation | exit 1: `sync: the worker ran with the synthetic-provider opt-in (config.synthetic_providers_allowed logged); the acceptance run must have it off`; `down` `ok (-v)` (`runs/acc1k-l2-leak-mutation.json`) |

Both acceptance runs give the same results as before: 942 /
`18.00663861840`, `excludedRows` 57, 2024-10 quarantined
`PROVIDER_MISMATCH`, and the catalog codes `{PROVIDER_MISMATCH: 57}` and
`{PROVIDER_MISMATCH: 1}`.

**Mutations (all killed; `runs/code-mutations-challenger.txt`):** M23
staging accepted; M24 unset `RATIO_ENV` accepted; M25 only production
refused; M26 case-insensitive `RATIO_ENV`; M27 `workerEnv` omits the opt-in;
M28 the acceptance ignores the log; M29 stderr not captured; M30
`runProcess` drops stderr.

### 9.1 Orchestrator decisions on L3 and L4 (2026-10-04)

**L3: `replay-fixtures` is test-only.**

| SHA | Commit | Kind |
|---|---|---|
| 61febe3 | `src/ingest/replayFixturesEnv.test.ts` | **red** (`red/red-replay-fixtures-test-only.txt`: 2 failed / 3. The `RATIO_ENV=test` case passes at red, because test was already allowed) |
| 7d6d2cb | the CLI accepts `replay-fixtures` only with `RATIO_ENV=test`, plus the docs | green |

The gate in `workerCli.ts`:
- refuses `RATIO_ENV=staging` (and every value but `test`) **before any I/O**;
- exits 2 with `REPLAY_FIXTURES_NOT_ALLOWED` and the message: "replay-fixtures
  runs only when RATIO_ENV is test: it ingests synthetic providers, which are
  allowed only in development/test (per-source synthetic markers are tracked
  as D-21 for Slice 3)";
- has no in-code opt-in bypass.

Under BOUNDARY v2 there is no staging environment, so there is no impact
today. D-21 is the way to restore staging later (DESIGN §8 D1).

**Docs and scripts that referred to staging (grep):**
- `.obvious/skills/ingestion-ops/SKILL.md` §7: the example now uses
  `RATIO_ENV=test RATIO_ALLOW_SYNTHETIC_PROVIDERS=1`, and the gate text is
  updated;
- `DEPLOYMENT_BRIEF.md`: the operational-settings row and the retention list;
- `replayFixtures.ts` and `workerCli.ts`: header comments.

No script invokes `replay-fixtures` with staging.

The Slice 1 test `cli.worker.test.ts` "replay-fixtures is refused unless
RATIO_ENV is staging or test" still passes. Its cases (unset, development,
production, `STAGING`) are all still refused. Its title now under-states the
rule, and it was not edited (Slice 1 tests are frozen).

**Mutations (`runs/code-mutations-replay-fixtures.txt`; all killed):**
- M31: staging re-allowed. Killed by the staging test.
- M31b: development allowed too. Killed by the every-other-value test and by
  the Slice 1 test.
- M31c: the gate removed. Killed by all three tests.

**L4: kept as documented (DESIGN §8a); follow-up issue draft for the
orchestrator to open:**

> **Title:** Worker: re-check an unchanged, already-published batch under the current ingestion policy (`replay --period --revalidate`)
>
> **Context.** Batches are keyed on their data fingerprint (the artifact
> sha256s). Once a period's artifact set is published, an unchanged listing
> is `skipped_unchanged`. `backfill` and `replay --period` find the same
> batch and return `unchanged` without reading a row (#62 D12 test).
> Batches published before a policy change are therefore never re-checked
> against the new rules. Examples of such changes: #62's `ProviderName`
> allowlist, a later allowlist edit, or the synthetic-provider opt-in being
> turned off. Quarantined batches have the same gap (Slice 1 DESIGN §12).
> No production data exists today.
>
> **Proposal.** Either:
> - an explicit operator mode, `ratio-ingest replay --tenant <t> --source
>   <s> --period YYYY-MM --revalidate`, that re-loads the period's retained
>   evidence (never the source) through the current validation and provider
>   policy into a NEW staged batch; or
> - a documented operator procedure with the same effect.
>
> **Acceptance criteria (tests first):**
> 1. With identical bytes and a tightened policy (a provider removed from
>    the allowlist, or the synthetic opt-in turned off), `--revalidate`
>    produces a new batch that excludes the now-foreign rows
>    (`PROVIDER_MISMATCH`) and publishes the rest. If every row is
>    excluded, or a hard error appears, it quarantines, and the period's
>    current publication is untouched (one transaction, fenced like every
>    publish).
> 2. With identical bytes and an unchanged policy, the result is identical
>    (same rows, same totals). Either the new batch is a no-op re-point, or
>    the mode reports `unchanged-under-current-policy` without publishing.
>    Decide which in the design note.
> 3. Bytes are read only from the evidence store, re-hashed against
>    `ingest_artifacts.sha256`. A mismatch fails `EVIDENCE_INTEGRITY` and
>    publishes nothing.
> 4. The batch-key scheme must allow two batches over the same artifact set
>    (data fingerprint plus a policy or revalidation key, like the
>    controls-key precedent in Slice 1 review M2). Superseded batches stay
>    immutable.
> 5. Every run writes an evidence record naming the mode, the old and new
>    batch ids and the outcome. `doctor` stays green.
> 6. A mutation where `--revalidate` silently returns `unchanged` fails a
>    test. So does one where it reads from the source instead of evidence.
> 7. Restricted class (Slice 1 worker behaviour): challenger review
>    required.

### 9.2 Final gates (code at 7d6d2cb, docs at f96ac60)

| Gate | Result |
|---|---|
| lint, tsc | exit 0 |
| `npm test` | **2552 passed** (109 files) |
| `npm run test:db` ×1 | parallel **625 passed** (35 files); serial **173 passed** (6 files); exit 0. Run after every code commit |
| `local:acceptance` 1k | exit 0, `pass: true`, 23.2 s, 0 opt-in log lines. First sync exit 1: 2024-09 `published` 942 / `18.00663861840`, `excludedRows` 57; 2024-10 `quarantined` `PROVIDER_MISMATCH`. Catalog `{PROVIDER_MISMATCH: 57}` / `{PROVIDER_MISMATCH: 1}` (`runs/acc1k-final.json`) |

**Cleanup:** the private cluster, the `i62-s3` container and its volume,
the compose project and the scratch files were removed after the run.
