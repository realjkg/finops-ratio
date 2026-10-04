# Issue #62 — evidence: the worker rejects rows whose `ProviderName` does not match the source type

Branch `fix/62-provider-source-check`, from `origin/main` 827773f; merged with
`origin/main` (#65) at 12a0c97. Pushed; PR pending. Design: `DESIGN.md` (this directory). Restricted class (Slice 1 worker
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

**L4: kept as documented (DESIGN §8a); follow-up issue draft, opened by the
orchestrator as #66:**

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

## 10. Fresh challenger review at 12a0c97 (REQUEST CHANGES: 1 Medium, 4 Low)

### 10.1 Gate record at the merge head 12a0c97 (challenger's run)

The orchestrator merged `origin/main` (#65) into the branch and pushed. The
fresh challenger ran these gates at 12a0c97, on a private PG16 + SeaweedFS:

| Gate | Result |
|---|---|
| lint, tsc | exit 0 |
| `npm test` | 110 files / **2599 passed** |
| `npm run test:db` | parallel 35 files / **625 passed**; serial 6 files / **173 passed**; exit 0 |

### 10.2 M-A: `replay-fixtures` hung forever with the opt-in off

The challenger reproduced it: the process was still running at 240 s.
- With `RATIO_ENV=test` and no `RATIO_ALLOW_SYNTHETIC_PROVIDERS`, every
  period quarantines `PROVIDER_MISMATCH`.
- `zombie_fencing` then awaited `atPublish`, which only `beforePublish`
  resolves, so it never resolved.

| SHA | Commit | Kind |
|---|---|---|
| e0422dc | CLI test, opt-in off ⇒ exit 2 promptly (`replayFixturesEnv.test.ts`); library test: under a policy that quarantines everything, `runReplayFixtures` returns `pass:false` within the 60 s per-test timeout, `zombie_fencing.detail.reachedPublish === false`, and no `ratio-replay-fixtures` connection is left (`replayFixturesQuarantine.db.test.ts`) | **red** (`red/red-ma-cli.txt`: 1 failed / 4; `red/red-ma-library.txt`: **timed out at 60 s**, the hang reproduced) |
| c4c8b90 | CLI startup gate (opt-in required, before any I/O); `zombie_fencing` races `atPublish` against the zombie settling; the admin client connects inside the `try` | green |

**Mutations (`runs/code-mutations-ma.txt`; all killed):**
- M32: the CLI opt-in gate removed. Killed by the CLI test.
- M33: the unbounded `await atPublish`, i.e. the hang. Killed: the library
  test timed out at 60 s.
- M34: the admin client never ended. Killed: the library test sees the
  connection left open.

**SKILL.md §8 fixed.** Step 5 (the sync steps on the SyntheticCloud fixture,
and `replay-fixtures`) now runs with `RATIO_ENV=development|test` plus
`RATIO_ALLOW_SYNTHETIC_PROVIDERS=1`.

### 10.3 Lows

- **L-a:** the stale "refused in production" wording is replaced by "only
  `RATIO_ENV` explicitly development or test" in `config.ts`, `provider.ts`
  and DESIGN §4.
- **L-b:** Slice 2b EVIDENCE §2, the §6 table and the §12 gate row carry a
  dated "superseded by #62" note. It points at the new pins: 942 /
  `18.00663861840` and 9441 / `112.16617543240`. The historical figures are
  not rewritten.
- **L-c:** `ingestion-ops/SKILL.md` updated:
  - §0 gains `RATIO_ALLOW_SYNTHETIC_PROVIDERS` and its `RATIO_ENV` rule;
  - §4 gains `PROVIDER_MISMATCH` and notes that a published batch can carry
    excluded rows with a nonzero `validation_error_count`;
  - §10 gains the D12 gap, citing #66.
- **L-d:**
  - the status lines now read "Pushed; PR pending";
  - DESIGN §8a and EVIDENCE §9.1 cite #66;
  - §8a names the `replay --batch` path, which can re-publish a superseded
    pre-#62 batch;
  - the gate record at 12a0c97 is above (§10.1).

### 10.4 Final gates (code and docs at b396790; this record is docs-only)

Run on a private PG16 cluster (`/dev/shm/i62pg`, 127.0.0.1:55930) and a
private SeaweedFS container `i62-s3` (127.0.0.1:55931). Other agents'
clusters were not touched. `npm ci` was refreshed for the merged
`package-lock.json`. `next build` was re-run for the merged app;
`tsconfig.json` and `next-env.d.ts` were restored after it (not committed,
L5).

| Gate | Result |
|---|---|
| lint, tsc | exit 0 |
| `npm test` | 110 files / **2600 passed** (merge head 2599, plus the new CLI opt-in case) |
| `npm run test:db` ×1 | parallel 36 files / **626 passed** (merge head 625, plus the M-A library test); serial 6 files / **173 passed**; exit 0 |
| `local:acceptance` 1k | exit 0, `pass: true`, 22.8 s, 0 opt-in log lines. First sync exit 1: 2024-09 `published` 942 / `18.00663861840`, `excludedRows` 57; 2024-10 `quarantined` `PROVIDER_MISMATCH`. Second sync exit 1. Catalog `{PROVIDER_MISMATCH: 57}` / `{PROVIDER_MISMATCH: 1}`. `down` `ok (-v)` (`runs/acc1k-final-review2.json`) |

**Cleanup:** the cluster, the container and its volume, the compose
project and the scratch files were removed after the run.

## 11. Challenger APPROVED at fc7ad89 (0 High, 0 Medium); the two Lows landed

| SHA | Commit | Kind |
|---|---|---|
| 2dee8e4 | L-1: a deterministic check. An idle session with `application_name = 'ratio-replay-fixtures'` sits in the `postgres` database (the challenger's reproduction), and `adminConnections()` must still count 0 | **red** (`red/red-l1-connection-scope.txt`: "expected 1 to be +0", because the cluster-wide query counted the other database's session) |
| 5152578 | `adminConnections()` adds `AND datname = current_database()`. L-2: SKILL.md §7 states that `RATIO_ENV=test` without `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` is refused (exit 2 `REPLAY_FIXTURES_NOT_ALLOWED`); the DEPLOYMENT_BRIEF operational row adds the opt-in requirement | green |

**M34 re-run with the scoped query** (`runs/code-mutation-m34-rerun.txt`):
the admin client never ended is still **killed** ("expected 1 to be +0"),
because the admin client connects to the test's own database.

**Known pre-existing gap (informational; not in this PR, logged on #58 by
the orchestrator):** mutation **Y4** survives. Dropping
`z === 'LEASE_LOST'` from the `zombie_fencing` pass condition goes
unnoticed, because K5 (`cliWorker.db.test.ts`) only asserts that all six
scenarios pass. This predates #62.

**Final gates (at 5152578; private PG16 `/dev/shm/i62pg` on 127.0.0.1:55930
and SeaweedFS `i62-s3` on 127.0.0.1:55931; `/tmp/aidg_pg` not touched):**

| Gate | Result |
|---|---|
| lint, tsc | exit 0 |
| `npm test` | 110 files / **2600 passed** |
| `replayFixturesQuarantine.db.test.ts` + `cliWorker.db.test.ts`, run concurrently (vitest file parallelism) against one cluster, ×3 | **9 passed** each time (2 files), exit 0 ×3 |
| `npm run test:db` ×1 | parallel 36 files / **627 passed**; serial 6 files / **173 passed**; exit 0 |

## 12. PR #67 Copilot review: opt-in checked before RATIO_ENV validation

Copilot (review 5407161031, thread r4178443590) found that the order was wrong.
`loadWorkerConfig` validated `RATIO_ENV` membership before calling
`syntheticProvidersOptIn`. So with `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` and an
unknown or differently-cased `RATIO_ENV` (`prod`, `TEST`, `Production`), it
failed with `CONFIG_INVALID` instead of the documented
`SYNTHETIC_PROVIDERS_NOT_ALLOWED`. The direct helper tests did not cover the
`loadWorkerConfig` path. The opt-in was still refused (it failed closed); only
the reported code was wrong.

| SHA | Commit | Kind |
|---|---|---|
| fd487d8 | `syntheticProviders.test.ts`: the opt-in with 9 unknown or wrongly-cased values through `loadWorkerConfig` must give `SYNTHETIC_PROVIDERS_NOT_ALLOWED`; without the opt-in, or with `'0'`, the error stays `CONFIG_INVALID` | **red** (`red/red-copilot-optin-order.txt`: 1 failed / 10, received `CONFIG_INVALID`) |
| (this fix, after fd487d8) | `config.ts`: `syntheticProvidersOptIn(env)` moves above the `RATIO_ENVS` check | green |

The red run doubles as the mutation check: restoring the old order fails the
new test.

**Gates after the fix:**
- the targeted files: 14 passed;
- `npm run lint` and `tsc --noEmit`: exit 0;
- `npm test`: 110 files / **2601 passed**.

No DB test depends on the old order. The only `CONFIG_INVALID` assertion on an
unknown `RATIO_ENV` (`config.test.ts:49`) passes no opt-in.

## 13. PR #67 Copilot review: tenant-scoped catalog correlation

Copilot (review 5407190027, thread r4178465830; it rated the finding High)
pointed at `catalogSnapshot` in `scripts/local/local.mjs`. It runs as the local
superuser, so row-level security does not apply. Its `error_codes` subquery
correlated `ingest_validation_errors` on `batch_id` alone, but batch ids are
unique only within a tenant: the primary key is `(tenant_id, id)`, and the
errors key is `(tenant_id, batch_id, error_ordinal)`. A batch with the same
UUID in another tenant would have had its errors counted.

The practical impact was nil. The script is local acceptance only, the batch
ids are random UUIDs, and the local stack has one tenant. It is fixed anyway.

| Commit | Kind |
|---|---|
| `local.test.mjs` L17 (renamed L18 in §15): every `<x>.batch_id = <y>.id` correlation in `local.mjs`/`acceptance.mjs` must also bind `<x>.tenant_id = <y>.tenant_id` | **red** (`red/red-copilot-tenant-scope.txt`: L17 failed) |
| `local.mjs`: `WHERE v.tenant_id = b.tenant_id AND v.batch_id = b.id` | green |

**Gates after the fix:**
- `scripts/local` unit tests: 238 passed;
- lint and `tsc --noEmit`: exit 0;
- `npm test`: 110 files, all passed;
- `local:acceptance` 1k (project `ratio-orch-acc`, ports 56490–56492): `pass: true`. 2024-09 was published with 942 rows / `18.00663861840`, `validation_error_count` 57 and `error_codes {PROVIDER_MISMATCH: 57}`. 2024-10 was quarantined with `PROVIDER_MISMATCH`. `down -v` removed the stack.

## 14. PR #67 Copilot review: the control validates excluded records too

Copilot (review 5407215437, thread r4178490371) found a mismatch between the
worker and the independent calculator.
- **The worker:** `load.ts` runs `validateRow` on every record **before** the
  provider check. An invalid foreign-provider record is therefore a
  validation error, and the batch quarantines.
- **The calculator:** `--rows --provider AWS` counted such a record as a plain
  exclusion without running `expected_row()`, so it would predict a
  publication.

| Commit | Kind |
|---|---|
| bd1fc1c `test_focus_control_totals.py` `test_rows_validate_excluded_records_like_the_worker` | **red** (`red/red-copilot-excluded-validation.txt`: a Microsoft record with `ChargePeriodStart` = `not-a-timestamp` was not rejected) |
| (this fix, after bd1fc1c) `focus_control_totals.py`: with `--rows`, an excluded record goes through `expected_row()` before it is counted | green |

The test covers two invalid foreign records: a bad timestamp, and a
non-numeric `ListCost`. Each must now be rejected, as the same record from
the allowed provider already was. A valid foreign record is still a plain
exclusion.

Without `--rows`, the calculator validates only the totals columns, for
allowed and excluded records alike. That behaviour is unchanged.

**Gates after the fix:**
- the Python suite: 28 tests OK;
- `controlTotals.test.mjs`: 5 passed (the real 1k sample, `--rows --provider AWS`: 942 / `18.00663861840`, 57 + 1 excluded);
- lint and `tsc`: exit 0;
- `npm test`: all passed;
- `local:acceptance` (project `ratio-orch-acc`, ports 56490–56492):
  - **10k** `pass: true`: 9441 / `112.16617543240` published, `{PROVIDER_MISMATCH: 557}`, 2024-10 quarantined;
  - **1k** `pass: true`: 942 / `18.00663861840`, `{PROVIDER_MISMATCH: 57}`, 2024-10 quarantined.

Every excluded record in both upstream samples passes `expected_row()`.

## 15. Challenger Low on the tenant-scope check: guard the invariant, not the query

The challenger approved c0ff7d0..1df6bdc with 0 High and 0 Medium. Its one Low
was that the §13 static check guarded today's query, not the invariant. Two
mutations survived it:
- a second unscoped subquery next to the fixed one (C);
- reversed operands, `b.id = a.batch_id` (D).

They survived because the tenant binding was searched across the whole file,
and reversed operands were not matched at all.

The check is renamed L18 (the label L17 was already used in `local.test.mjs`).
It now:
- works per SQL template literal;
- matches both operand orders and an unaliased `batch_id`;
- requires the `tenant_id` binding between the same two aliases inside the same literal.

A self-test asserts that the challenger's mutations A–D, and a binding placed
in a different literal, are all flagged, and that scoped forms in either
order pass.

**Mutation:** removing the tenant binding from the fixed `local.mjs` query
fails L18 (1 failed).

**Gates:**
- `scripts/local` unit tests: 239 passed;
- lint: exit 0.

## 16. Corrections to §14 and §15 (challenger Lows at d60ed4a)

The challenger approved c0ff7d0..d60ed4a with 0 High and 0 Medium. Two
Lows made earlier claims more exact.

**§15 overstated.** "Mutations A–D … are all flagged" was **not true** for C
as the challenger wrote it. Its C adds a second subquery that **reuses** the
already-scoped alias `v`:

```sql
(SELECT count(*) FROM ratio.ingest_artifacts v WHERE v.batch_id = b.id)
```

The §15 self-test used alias `a` instead, and the §15 checker accepted the
real C. The existing `v.tenant_id = b.tenant_id` in the same literal
satisfied it. Verified: the §15 checker returns no problems for that text.

The checker is now count-based. Per SQL literal and per alias pair, it
requires at least as many `tenant_id` bindings as `batch_id` correlations.
The self-test now includes C verbatim.

**Mutation on the real file:** C applied to `local.mjs` now fails L18
(1 failed). The §15 checker passed it.

**Known remaining limits of L18.** It is a lint, not a SQL parser. It does not
see:
- `batch_id IN (SELECT …)` or `= ANY(…)`;
- quoted identifiers;
- a schema-qualified parent;
- SQL in single-quoted strings;
- correlations on other tenant-scoped keys, e.g. `source_id`.

Every superuser query in `scripts/local` was reviewed by hand. Each filters
by `tenant_id = $1` or binds the tenant (challenger, round at 1df6bdc).

**§14 overstated.** "Validates excluded records like the worker" means *like
the allowed records*. The calculator's rules are not identical to the
worker's `validateRow`:
- **Stricter on formats.** Decimals must match `-?\d+(\.\d+)?`. Timestamps
  need seconds, at most 6 fraction digits, and offsets as `±HH:MM`. So a
  foreign record that the worker would exclude can make the calculator stop
  with an error. This fails closed, and it was already true for AWS records.
- ~~Does not check `CHARGE_PERIOD_INVERTED` or `INVALID_CHARACTER`.~~
  **Now it does** (§17, Copilot F2, 3a030ac). With `--rows`, `expected_row`
  refuses an end before the start (UTC) and a C0 control other than TAB, LF
  or CR in any value. This applies to foreign and allowed records alike. The
  "stricter on formats" note above still applies.

Neither difference affects the upstream samples: every 1k and 10k record
passes both validators.

**Gates:**
- `scripts/local` unit tests, all passed;
- lint, `tsc` and `npm test`, recorded at the head in the PR.

## 17. Copilot review 5407245119 / 5407265538 (F1–F3) and the L18 blind spots

**#67 was merged at ebbde12 (merge commit ad876ae) with F1–F3 still open.
This branch, `fix/67-copilot-followups` (from the local commits on top of
ebbde12, merged with `origin/main`), carries their fixes.** It does not push
to `fix/62-provider-source-check`.

| Item | Red commit | Fix commit |
|---|---|---|
| **F1** (High, r4178520620): zombie_fencing called `expireLease` before the `try`/`finally` that releases the zombie | e9fc779 (`red/red-f1-expire-lease.txt`: the zombie's run is left `running`) | 95e1be1 |
| **F2** (Medium, r4178520633): with `--rows`, the calculator did not refuse `CHARGE_PERIOD_INVERTED` or `INVALID_CHARACTER` | cfb4258 (`red/red-f2-python.txt`: 11 failures) | 3a030ac |
| **L18 blind spots** (challenger at ebbde12) | 6a7a554 (`red/red-l18-blind-spots.txt`; `red/red-l18-old-checker-probes.txt`: the ebbde12 checker **missed all four probes**) | 446c05b |
| **F3** (High, r4178540607): `runSync({ settings: { allowSyntheticProviders: true } })` skipped the opt-in | d2b985b (`red/red-f3-runsync-optin.txt`: 2 failed / 5; an explicit `true` reached the pool) | 47ed672 |

**F1.**
- Seam: `testHooks.beforeExpireLease`. It is library-only and changes no
  behaviour. It went in with the red test, which fails `expireLease` for
  `fx-zombie` only.
- Fix: `expireLease` moved inside the `try`. The `finally` releases the
  zombie **and awaits `zombieOutcome`**, so nothing is left dangling. The
  `try`/`finally` covers everything from the `reachedPublish` race to
  `release()`: `expireLease` and the winner `sync`.
- The test asserts:
  - the other five scenarios pass;
  - `zombie_fencing` reports the injected fault;
  - no `fx-zombie` run is still `running`;
  - `heartbeat_at` is unchanged 1.5 s later;
  - the admin client is ended.
- **The seam cannot be reached from the CLI.** A static test in
  `replayFixturesEnv.test.ts` checks two things:
  - `replayFixtures.ts` is the only non-test, non-`testing/` file under
    `src/ingest` that mentions `testHooks`;
  - the `runReplayFixtures({ … })` call in `workerCli.ts` passes
    `allowSyntheticProviders` but never `testHooks` or `beforeExpireLease`.

**F2.**
- `expected_row` now refuses:
  - any value with a C0 control other than TAB, LF or CR (every column,
    extra columns included). The message names the column, never the value;
  - `ChargePeriodEnd` before `ChargePeriodStart`, compared in UTC (equal is
    allowed).
- Both apply to foreign and allowed records.
- One Slice 2b test fixture changed. `test_one_row_maps_to_the_api_contract`
  had an inverted period: end `21:00:00.5Z` before start `22:00Z`, a row the
  worker quarantines. Its end is now `23:00:00.5Z`; the mapping assertions
  are otherwise unchanged.
- Both upstream samples still pass (`--rows --provider AWS`, exit 0). §16 is
  updated: the calculator now checks both rules.

**L18.**
- Bindings are counted **once per unordered alias pair**, and
  `x.tenant_id = x.tenant_id` tautologies are ignored.
- They are compared with the total correlations of that unordered pair, in
  both directions.
- Probes added to the self-test:
  - (i) a self-correlation with only a tautological binding, twice;
  - (ii) reversed pairs sharing one binding, both spellings;
  - a good case with two correlations and two bindings.

**F3.**
- An explicit `false` is a pure override and needs no env.
- The default, and an explicit `true`, are decided by **this process's**
  validated opt-in: `syntheticProvidersOptIn(process.env)`, i.e.
  `RATIO_ALLOW_SYNTHETIC_PROVIDERS=1` with `RATIO_ENV` explicitly
  `development` or `test`.
- An explicit `true` without it throws `SYNTHETIC_PROVIDERS_NOT_ALLOWED`
  before any I/O. The test's pool throws on any use.
- There is no injected env, because a caller could assert any env it likes.
- Callers checked:
  - the CLI passes its config value, and its process env is the same env;
  - `replayFixtures` passes the CLI value;
  - the DB tests pass explicit `true`. The DB vitest configs set the opt-in
    and `RATIO_ENV=test`, so they pass;
  - `testS3Env()` sets the opt-in and `RATIO_ENV=development` for the
    in-process CLI;
  - `local:test` spawns the worker with the opt-in in its own env.

  All pass (gates below).

**Mutations (`runs/code-mutations-copilot-followups.txt`; all killed):**
- F1: `expireLease` back outside the `try`.
- F2:
  - the inverted-period check removed;
  - the control-character check removed;
  - the foreign path skips `expected_row`.
- F3: an explicit `true` bypasses the opt-in.
- L18:
  - tautologies count again;
  - ordered pair keys again.

**Gates (at 47ed672, before the merge with `origin/main`):**

Run on a private PG16 (`/dev/shm/i62pg`, 127.0.0.1:56530) and SeaweedFS
`i62-s3` (127.0.0.1:56531). `/tmp/aidg_pg` and other sessions' containers
were not touched.

| Gate | Result |
|---|---|
| lint, tsc | exit 0 |
| `npm test` | 111 files / **2610 passed** |
| Python suite | 29 tests, OK |
| `npm run test:db` ×1 | parallel 36 files / **628 passed**; serial 6 files / **173 passed**; exit 0 |
| `local:acceptance` 1k | exit 0, `pass: true`, 23.1 s. 942 / `18.00663861840`, `excludedRows` 57; 2024-10 `quarantined` `PROVIDER_MISMATCH`; second sync exit 1 as expected. 942 rows compared (`runs/acc1k-copilot-followups.json`). Project `ratio-i62f-acc` on 56610/56611/56612. The first attempt on 56540 hit "address already in use" from another session, and its stack was torn down by the run |
| `local:acceptance` 10k | exit 0, `pass: true`, 28.9 s. 9441 / `112.16617543240`, `excludedRows` 557; 2024-10 quarantined (`runs/acc10k-copilot-followups.json`) |

The lint, tsc and `npm test` re-run after the merge with `origin/main` is
in the commit that follows this record.

**After `git merge origin/main` (af6ad77; ad876ae is main + ebbde12, and the
merge changes no file):** lint exit 0, tsc exit 0, `npm test` 111 files /
**2610 passed**.

## 18. PR #68 merged; post-merge challenger APPROVE; follow-ups (`fix/68-calculator-followups`)

**PR #68** (`fix/67-copilot-followups`) was merged by the owner at
6f84ffa (merge commit 0947091 on main). CI was green, and the post-merge
challenger review **APPROVED** it with 0 High and 0 Medium. Four items
remained:
- one Copilot finding (r4178585902);
- challenger Lows L-1 and L-2;
- one informational item.

All four are fixed on `fix/68-calculator-followups`, cut from `origin/main`
0947091, test-first.

| Item | Red | Fix |
|---|---|---|
| Copilot r4178585902: unpadded years break the inverted-period comparison | b684945 | 5f83926 |
| Challenger L-1: sub-millisecond precision | b684945 | 5f83926 |
| Informational: `OverflowError` near year 9999 | b684945 | 5f83926 |
| Challenger L-2: L18 counts a repeated binding twice | b684945 | 1500718 |

Red output:
- `red/red-pr68-python.txt`: 5 errors. The 0099→0100 case and the
  millisecond case were refused; the overflow cases raised `OverflowError`.
- `red/red-pr68-l18.txt`: 1 failed. The challenger's probe was not flagged.

**Copilot r4178585902.**
- **The bug.** `expected_row` compared `format_timestamp()` strings, and
  `strftime('%Y')` does not pad year 99. So `'99-12-31…' > '100-01-01…'`,
  and a valid 0099-12-31 23:00 → 0100-01-01 00:00 interval was refused.
  `validateRow` orders it correctly (`timestamp.test.ts`).
- **The second bug, confirmed.** The same unpadded year was in the `--rows`
  API values. Postgres `to_char(…, 'YYYY…')`, which the API uses, gives
  `0099-12-31T23:00:00.000000Z`. Checked on a scratch PG16: the calculator
  would have predicted `99-12-31…` and reported a false mismatch.
- **The fix:**
  - `parse_timestamp` returns an aware UTC `datetime`;
  - `format_utc` formats with an explicit `{year:04d}`;
  - the order check compares instants, never text.

**Challenger L-1.** `timestamp.ts` keeps milliseconds, truncated. The order
is now judged on instants truncated to milliseconds (`worker_ms`):
- start `.000500` with end `.000100` is the same instant, so it is accepted,
  as the worker does;
- `.001000` with `.000999` is still refused;
- the published value keeps its microseconds, because the API returns them.

**Informational (year 9999).** The worker's behaviour was checked first.
- `parseFocusTimestamp('9999-12-31T23:00:00-02:00')` accepts the value
  (epochMs 253402304400000 = +010000-01-01T01:00Z).
- Postgres stores it, and `to_char` gives `10000-01-01T01:00:00.000000Z`.
- Likewise, `0001-01-01T00:30:00+01:00` is accepted. It becomes 1 BC,
  which `to_char` prints as `0001-12-31T23:30:00.000000Z` with no BC marker,
  an API quirk noted here only.

Python's `datetime` cannot hold either value. The calculator now raises
`ControlTotalsError` ("not representable in UTC within years 1..9999"): exit
1 with `refused:`, never a traceback. That fails closed, in the same class as
the "stricter on formats" note (§16). A worker/calculator disagreement on
such an input stops the acceptance run instead of passing it.

**Challenger L-2.** In the L18 lint, identical tenant bindings (either
spelling) now count **once per literal**.
- Consequence, documented in the self-test: two batch-id correlations
  between the same alias pair in one literal are always flagged, even if
  each has its own copy of the binding. This is a conservative lint; use
  distinct aliases.
- The earlier "good" probe with two correlations and two copies moved to
  the flagged list.
- `local.mjs` and `acceptance.mjs` still pass.

**Mutations (`runs/code-mutations-pr68-followups.txt`; all 7 killed):**

| Id | Mutation | Killed by |
|---|---|---|
| P1 | compare padded formatted text | the millisecond test |
| P1b | strftime year again (unpadded) | the 0099 test |
| P1c | the original bug: compare unpadded strftime text | both tests |
| P2 | no millisecond truncation | the millisecond test |
| P2b | rounding instead of truncation | the millisecond test |
| P4 | `OverflowError` not caught | the overflow test |
| L2 | repeated bindings counted again | the L-2 probe |

**Gates (at 1500718; no `src/` change, so `test:db` was not required):**

| Gate | Result |
|---|---|
| lint, tsc | exit 0 |
| `npm test` | 111 files / **2611 passed** |
| Python suite | 32 tests, OK |
| `local:acceptance` 1k | exit 0, `pass: true`, 22.9 s. 942 / `18.00663861840`, `excludedRows` 57; 2024-10 quarantined `PROVIDER_MISMATCH`; 942 rows compared (`runs/acc1k-pr68-followups.json`) |
| `local:acceptance` 10k | exit 0, `pass: true`, 28.6 s. 9441 / `112.16617543240`, `excludedRows` 557; 2024-10 quarantined; 9441 rows compared (`runs/acc10k-pr68-followups.json`) |

Both acceptance runs used project `ratio-i62g-acc` on 56650/56651/56652
(checked free first). The scratch PG16 for the Postgres check ran on 56630
and was removed.
