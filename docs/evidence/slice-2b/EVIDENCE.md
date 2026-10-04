# Slice 2b — evidence: acceptance run on the public FOCUS 1.0 Sample Data

Branch `slice/02b-sample-acceptance`, from `origin/main` 91a0721. Local and
ephemeral only. Not pushed; no PR. Design: `DESIGN.md` (this directory).

**How to read this file.** It is a log:
- §1–§9 record the first round, at HEAD 78cfe11;
- §10 records the coordinator's decisions;
- §11 records the challenger round;
- §12 records the Copilot review of PR #63.

Each section is accurate as of its own commits.
- **§11** has the last full gate set and the data-mutation runs; the files in
  `runs/` are §11's runs, at 6e518fc.
- **§12** has the gates after the exit-code fix (ad0e82d). Its files in
  `runs/` are `acc1k-copilot-exit-code.json` and
  `code-mutations-exit-code.txt`.

**Isolation.** Other agents share this host and its Docker daemon, so every run
used its own names and ports, and everything was removed afterwards:
- `local:acceptance`: project `ratio-s2b-acc` on 127.0.0.1:55810 (PG),
  55811 (S3), 55812 (app).
- `local:test`: project `ratio-s2b-test` on 55820/55821/55822.
- `test:db`: a private PG16 cluster (`initdb` as `postgres` via `setpriv`,
  `/dev/shm/s2bpg`, 127.0.0.1:55830, `fsync=off`), stopped and deleted at the
  end. S3 tests used the shared SeaweedFS 127.0.0.1:18333 with the suite's
  per-run prefix.
- The shared 55432 was never used.

## 1. Data, attribution and pins

> **"FOCUS 1.0 Sample Data"** by the **FinOps Foundation (FOCUS project)**,
> https://github.com/FinOps-Open-Cost-and-Usage-Spec/focus-sample-data, licensed
> **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). The control
> totals and run results below are derived from it. Changes: the run's staged
> copy maps the unquoted `NULL` token to an empty field, splits rows by billing
> period and gzips them into an AWS Data Exports layout (DESIGN §2.1). The
> committed file is unmodified. Not endorsed by the FinOps Foundation.

| | 1k | 10k |
|---|---|---|
| Upstream path @ `adbdd17a132984d6e8583c149c236d2199c3f5bc` | `FOCUS-1.0/focus_sample.csv` | `FOCUS-1.0/focus_sample_10000.csv` |
| Bytes | 755,423 | 7,529,214 |
| SHA-256 | `e91e5ac7edf01ed2c9d926f37ef7dc1ae2aae97956fea8da6c9ee488b1c2839e` | `0bf58b73123294c4476b648e647cad842935036f67dc4e9a2cc4a6d7497cc2e3` |
| git blob | `8d7568d2c024926d086b4d232010f9a0580657d2` | `3315d4806a37642f4cff86e7977302adf089e486` |
| Data rows | 1,000 | 10,000 |
| Where | committed verbatim: `fixtures/focus-1.0-sample/focus_sample.csv` (`-text` in `.gitattributes`) | fetched on demand into `.ratio-sample-data/<commit>/` (gitignored) |

**How the pins were checked.**
- `sha256sum` and `git ls-tree` on the local clone at that commit.
- `curl` of the pinned raw URL: same SHA-256.
- `git hash-object` of the committed file equals the upstream blob.
- Test A8 recomputes the git blob id in Node.
- The fetch path was exercised live:
  - `npm run sample:fetch` ⇒ `fetched` (0.8 s), and again ⇒ `already-present`;
  - `npm run sample:fetch -- --from-clone /home/user/finops-open-cost-and-usage-spec/focus-sample-data`
    ⇒ `copied`.

## 2. Control totals (independent; exact)

Computed by `scripts/acceptance/focus_control_totals.py` (Python, stdlib only,
integer arithmetic) from the **upstream** files. Pinned in
`fixtures/focus-1.0-sample/control-totals.json`.

| File | Billing period | Currency | Rows | BilledCost | EffectiveCost | EffectiveCost nulls |
|---|---|---|---|---|---|---|
| 1k | 2024-09-01 | USD | 999 | `20.28022672899` | `14.97651418586` | 0 |
| 1k | 2024-10-01 | USD | 1 | `0.24000000000` | `0.00000000000` | 0 |
| 10k | 2024-09-01 | USD | 9,998 | `151.41648035487` | `101.36188970754` | 0 |
| 10k | 2024-10-01 | USD | 2 | `0.01361088710` | `0.00000000000` | 0 |

Row digests (SHA-256 of the sorted `Id\tBilledCost\tEffectiveCost` lines):

| File | Period | Row digest |
|---|---|---|
| 1k | 2024-09 | `704b8c4919c9c46e393173834c3878e8972cff1207af7b9b8833a42b77a52ee1` |
| 1k | 2024-10 | `3ac9ffea540e79689c84e48af59b652872318ec2ebfe343745853f2f9ca634f3` |
| 10k | 2024-09 | `06ddfbb50803cbe1832a48c22d764989732b184ab5c7b5cbf0458e41212a0885` |
| 10k | 2024-10 | `5b5de31694ca8f7d38f581bdf33b3714f9440d8905a630390cde7878d916a6b1` |

**Third-method cross-check (before pinning).** A separate scratch script
(not committed; Python `csv.DictReader` + `decimal.Decimal` at precision 200,
with `Inexact` trapped) produced the identical JSON for both files, digests
included. The calculator reproduces it exactly (P2 for 1k; checked by hand
for 10k: `EQUAL`).

So each total is computed **four** ways, and all agree, as exact strings:
1. Python integer arithmetic (the control);
2. Python `Decimal` (the cross-check);
3. Postgres `sum(numeric)` (the worker's reconcile and the API totals);
4. JavaScript BigInt over the API rows.

## 3. Commits

| # | SHA | Commit | Kind |
|---|---|---|---|
| 1 | 89709c5 | design note | docs |
| 2 | 0aa7c9c | 1k file verbatim, `NOTICE.md`, `dataset.json`, `.gitattributes` | data |
| 3 | 56f0cff | A1–A8, P1, P2, pinned `control-totals.json` | **red** |
| 4 | ff89244 | Python control-total calculator | green |
| 5 | c350fb6 | `scripts/local/acceptance.mjs` (converter, comparisons, mutations, pinned fetch) | green |
| 6 | 862e2be | `local:acceptance` in `local.mjs`, `sample:fetch`, npm scripts, `.gitignore`, A9 | green |
| 7 | 2c6eafb | CI step | ci |
| 8 | 9749335 | quarantine reasons recorded when the first sync fails | green |
| 9 | 78cfe11 | test: a quoted `"NULL"` is kept (kills code mutation CM1) | test |
| 10 | 68229da | EVIDENCE, run summaries | docs |

## 4. Red evidence (`red/`)

| File | At | Result |
|---|---|---|
| `red-fast.txt` | 56f0cff | `acceptance.test.mjs` cannot import `./acceptance.mjs`. In `controlTotals.test.mjs`, all 3 fail: P1 `ModuleNotFoundError: focus_control_totals`; the pinned-totals test cannot open the script; the SHA-mismatch test fails on its stderr assertion |
| `red-python.txt` | 56f0cff | `python3 -m unittest`: `ImportError` (no calculator) |

**Test defects corrected after red** (no assertion weakened):
- The SHA-mismatch test first passed at red **by accident**: python3 exits 2
  when a script is missing too. Before the red commit it gained
  `stderr ~ /SHA-256 mismatch/`, and the recorded red run shows it failing.
- P1 asserted `'sha256' in err.lower()`, but the agreed message is
  `SHA-256 mismatch` (which P2 asserts). P1 now asserts that exact text
  (ff89244, stated in the commit).
- Lint-only: the `.mjs` tests import `Buffer`/`process`/`Response` explicitly,
  as the repo's eslint config requires (c350fb6).
- L20 (`scripts/local/local.test.mjs`, a Slice 2 test, not Slice 0/1) pinned
  the exact text `if (COMMAND === 'test') {`. It now requires
  `if (COMMAND === 'test' || COMMAND === 'acceptance') {`. That is stricter:
  the new command must take the same abort-then-cleanup path.
- The A9 static test was updated with the diagnostic change (9749335). It
  still requires every comparison to fail the run.

## 5. Why a converter, shown on the live stack

Staging the sample **without** a converter step, through the real worker
(mutation runs, §7):

| Converter step skipped | Worker result (catalog `quarantine_reason`) |
|---|---|
| null token → empty (`skip-null-conversion`) | 2024-09 `VALIDATION_FAILED: 7 validation error(s) (UNPARSEABLE_NUMBER x7)`; 2024-10 `… (UNPARSEABLE_NUMBER x1)` |
| split by period (`skip-period-split`) | 2024-09 `VALIDATION_FAILED: 1 validation error(s) (PERIOD_MISMATCH x1)`; 2024-10 never listed |

The same two outcomes are proven in the unit tests with the worker's own
`validateRow` (A3). Both batches are quarantined, and nothing is published.

**Converted staging, 1k.**

| Object | Bytes | SHA-256 |
|---|---|---|
| `focus-sample/focus-1-0-sample/data/BILLING_PERIOD=2024-09/sample-e91e5ac7edf0/focus-1-0-sample-00001.csv.gz` | 91,715 | `85301b485bd57b041eda6379261a6efd5d2dde1ef815ae1414a5ba025cba4590` |
| `…/data/BILLING_PERIOD=2024-10/sample-e91e5ac7edf0/focus-1-0-sample-00001.csv.gz` | 684 | `2f3c58f1d5d5123cdc7e80e6ab7f262f055e0e9d4f6121d7cc7cbbbb3a6863fd` |

The two manifests are 344 bytes each. The 1k file has 8,973 null tokens
replaced over 19 columns, e.g. `ChargeClass` 1000, `ContractedCost` 7,
`ConsumedQuantity` 1.

**Converted staging, 10k.**

| Object | Bytes | SHA-256 |
|---|---|---|
| 2024-09 data | 898,732 | `7505544a70dcedba5509f5cc626182d543121b2c2efdd3479f18ca9a7b5b0b8f` |
| 2024-10 data | 938 | `8239f139a595d22cee26a53cd4b9b9db609cb6edb21d3d996442416e5f116dd5` |

The 10k file has 90,466 null tokens replaced over 24 columns (e.g. `ContractedCost`
68, `ListCost` 1, `PricingQuantity` 4).

The staging is deterministic: the same object SHA-256s on every run. The
lossless round trip to upstream passes on every run, and the run refuses
otherwise.

## 6. Acceptance runs (HEAD 78cfe11)

**Commands:**
```
npm run build
RATIO_LOCAL_ACCEPTANCE_PROJECT=ratio-s2b-acc RATIO_LOCAL_ACCEPTANCE_PG_PORT=55810 \
RATIO_LOCAL_ACCEPTANCE_S3_PORT=55811 RATIO_LOCAL_ACCEPTANCE_APP_PORT=55812 \
  npm run local:acceptance                       # 1k (CI default), run twice
  npm run local:acceptance -- --dataset 10k      # after npm run sample:fetch
```

The full JSON summaries are in `runs/acc1k-1.json`, `runs/acc1k-2.json` and
`runs/acc10k.json`.

| | 1k run 1 | 1k run 2 | 10k |
|---|---|---|---|
| exit / pass | 0 / true | 0 / true | 0 / true |
| first `sync` | 2024-09 `published` 999 / `20.28022672899`; 2024-10 `published` 1 / `0.24000000000`; both `unverified` | identical | 2024-09 `published` 9998 / `151.41648035487`; 2024-10 `published` 2 / `0.01361088710`; both `unverified` |
| second `sync` | both `skipped_unchanged` | both `skipped_unchanged` | both `skipped_unchanged` |
| anonymous read | 401 | 401 | 401 |
| API page-1 totals | equal to the control (exact strings) | equal | equal |
| API rows / pages (limit 500) | 1000 / 2, all distinct | 1000 / 2 | 10000 / 20 |
| row sums, null counts, digests (JS BigInt) | equal to the control | equal | equal |
| `artifactSha256` set | equals the staged data objects | equal | equal |
| evidence re-hash | 2/2 objects re-hash to their key | 2/2 | 2/2 |
| catalog | exactly 2 batches, `published`, `unverified`, `is_provisional=false`, counts/totals = control; no other batch | same | same |
| stored fact size (D-09, informational) | avg 1033.5 B/row, of which `extra_columns` 670.9 B | same | avg 1031.2 B/row, `extra_columns` 668.2 B |
| `appReady` / `appStop` / `down` | `pid-verified` / `stopped` / `ok (-v)` | same | same |
| total wall time | **22.1 s** | **22.2 s** | **26.9 s** |

**Step times (ms):**

| Step | 1k run 1 | 10k |
|---|---|---|
| control totals (python3) | 136 | 1132 |
| stage (incl. lossless check) | 118 | 769 |
| up | 4228 | 4276 |
| migrate | 4254 | 4258 |
| seed | 592 | 599 |
| sync (worker `durationMs`) | 624 (435) | 1875 (1619) |
| sync again | 354 | 350 |
| next start | 586 | 636 |
| API read | 149 | 1716 |
| evidence re-hash | 14 | 20 |
| catalog | 16 | 29 |

The excluded remainder is docker `down -v`, the preflight and process start.

**D-09 note.** The worker ingested 10,000 real-shaped rows in 1.6 s end to end
(evidence capture, parse, validate, chunked insert with the staged-only
trigger, reconcile, publish). That is consistent with the brief's 10–18 µs/row
trigger cost being negligible at this size. It is not a measurement of a
multi-million-row month.

## 7. Mutation checks (HEAD 78cfe11; each must FAIL)

### 7.1 Data mutations: the full live run, 1k

`npm run local:acceptance -- --mutation <kind>`, same isolation settings.
Summaries are in `runs/<kind>.json`.

| Kind | Exit | First check that failed (verbatim, abridged) |
|---|---|---|
| `corrupt-billed` | 1 | first sync: `billedTotal "20.28022672900" != control "20.28022672899"` |
| `corrupt-effective` | 1 | API rows: `effectiveCost 14.97651418587 != control 14.97651418586`; `rowDigest a458b9d5… != control 704b8c49…` |
| `drop-row` | 1 | first sync: `rowCount "998" != control "999"`; `billedTotal "20.28025272899" != …` |
| `double-ingest` | 1 | first sync: `rowCount "1998" != control "999"`; `billedTotal "40.56045345798" != …` (the worker loaded both files: different bytes, so not a duplicate) |
| `shift-period` | 1 | first sync: `rowCount "1000" != control "999"`; `billedTotal "20.52022672899" != …`; `control period 2024-10-01 was not synced` |
| `swap-billed` | 1 | API rows: `rowDigest 16d4a557… != control 704b8c49…` (every sum and count still equal) |
| `skip-null-conversion` | 1 | first sync: both periods `quarantined VALIDATION_FAILED` (`UNPARSEABLE_NUMBER x7` / `x1`) |
| `skip-period-split` | 1 | first sync: 2024-09 `quarantined VALIDATION_FAILED` (`PERIOD_MISMATCH x1`); 2024-10 not synced |

Every mutated run still ended with `down: ok (-v)`, and nothing was left
behind.

**Findings from the mutation runs.**
- The worker **published** `corrupt-billed`, `drop-row`, `double-ingest` and
  `shift-period` (catalog: `published`). That is expected: with no control
  in the manifest it can only say `unverified`. These are exactly the errors
  that only an independent control catches.
- The run fails them at its **first** check: the worker's reported
  count/total against the control. They do not reach the API comparison.
- The API comparison's power against those same deltas is proven by A5:
  wrong count, value, scale, missing or extra period, missing or duplicated
  row. `corrupt-effective` and `swap-billed` are invisible to the worker's
  totals and are caught only by the API row sums and the digest.

### 7.2 Code mutations of the tooling

Scratch `code_mutations.py`. Each mutation was applied, the tests run, and
the file restored. Afterwards `git status` was clean apart from the then
uncommitted CM1 test. Output: `runs/code-mutations.txt`.

| Id | Mutation | Killed by |
|---|---|---|
| CM1 | converter treats a quoted `"NULL"` as a null | A3 "only the UNQUOTED token is a null". This test was added in 78cfe11 **after** this mutation survived the first draft: the 1k file has no quoted `"NULL"` |
| CM2 | the lossless check ignores a changed record | A3 lossless |
| CM3 | `sumDecimals` at the first value's scale | A4 |
| CM4 | row digest not compared | A5 (swapped values) |
| CM5 | sync `reconciliation` not checked | A5 (first sync) |
| CM6 | fetch writes without verifying | A7 |
| CM7 | catalog `is_provisional` not checked | A5 (catalog) |
| CM8 | double-ingest copy byte-identical | A6 |
| CM9 | Python: quoted `"NULL"` is a null | P1 (via P2) |
| CM10 | Python: sum at the smallest scale | P1 (via P2) |

10/10 were killed.

## 8. Gates (HEAD 78cfe11)

| Gate | Result |
|---|---|
| `npm run lint` | 0 |
| `rm -rf .next && npx tsc --noEmit` | 0 |
| `npm test` | **105 files / 2481 tests passed**, 46.5 s. New: `scripts/local/acceptance.test.mjs` (50) and `scripts/acceptance/controlTotals.test.mjs` (3, running the 16 Python P1 tests) |
| `npm run test:db` ×2 (private PG16 55830 + SeaweedFS 18333) | **597 + 173 passed** ×2 (135 s, 113 s). No `src/` change; the parallel role-DDL guard (`src/server/costs/parallelRoleDdl.test.ts`) passes in `npm test`; no DB test added |
| `next build` | 0 (`tsconfig.json`/`next-env.d.ts` rewritten by Next, restored with `git checkout`) |
| `npm run check:bundle` | pass: 116 client / 91 server files, no problem |
| `npm run local:test` (`ratio-s2b-test`) | pass in 26 s: totals `"55"`/`30.8272954899`, `"40"`/`21.0978157665`; 95 distinct rows; `pid-verified`, `stopped`, `ok (-v)` (`runs/localtest.json`). This is unchanged after the helper refactor in `local.mjs` |
| `npm run local:acceptance` ×2 (1k) | pass, 22.1 s and 22.2 s (§6) |
| `npm run local:acceptance -- --dataset 10k` | pass, 26.9 s (§6) |
| `npm run sample:fetch` (network) / `--from-clone` | `fetched` / `already-present` / `copied`, SHA-256 verified |
| leftovers | no `ratio-s2b*` containers, volumes or networks; no `.ratio-local/`; private cluster stopped and `/dev/shm/s2bpg` deleted; no `next`, worker, vitest or `local.mjs` process. (Pre-existing, not ours: the shared `ratio-s3` container, the 55432 cluster and another agent's cluster on 29650.) |

**Not run here:** GitHub CI (nothing is pushed).
- The CI step is added and expected to cost about 25 s; the job measured
  275 s on main (run 37194601870) against `timeout-minutes: 10`.
- The step and P2 depend on `python3`, and P2 fails, never skips, without it.
  CI pins Python 3.12 with `actions/setup-python` (§10, decision 1). This
  sentence originally said "preinstalled on `ubuntu-latest`"; that was
  corrected in §11 (L3).

## 9. Scope, gaps and items for the orchestrator

**Production code:** none changed. Nothing under `src/` or `pages/` changed,
and no migration or Slice 0/1 test changed.

**Slice 2 files changed:**
- `scripts/local/local.mjs`: the `acceptance` command; `seed`, the
  preflight, the app start and the paging extracted into shared helpers;
  `local:test`'s behaviour is unchanged, re-verified above;
- `scripts/local/local.test.mjs`: L20 made stricter;
- `.github/workflows/ci.yml`: one step appended;
- `package.json`: two scripts, no dependency;
- `.gitignore`, `.gitattributes`: one entry each.

**Known gaps (unchanged by this slice; the brief's D-02 already records them):**
- The manifest is the worker's documented contract, not a real AWS
  manifest. Real-manifest semantics stay unverified until real billing data
  is connected (an optional owner action).
- Real exports' null encoding is unconfirmed. The `NULL` token is a property
  of this SQL-dump sample.
- Google data is absent from these files.

**Finding (backlog, not changed):** the worker does not check `ProviderName`
against the source type. An "AWS Data Exports" source carrying Microsoft and
Oracle rows is accepted (DESIGN §9). Tracked in **realjkg/finops-ratio#62**.

## 10. Coordinator decisions on §9 (local, not pushed)

| Decision | What changed | Commit |
|---|---|---|
| 1. Python in CI accepted | CI sets up Python 3.12 with `actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065` (v5.6.0, SHA-pinned like the governance workflow's actions; `ci.yml`'s other actions use tags). This comes before `npm ci`, because `npm test` runs P2. A separate step asserts `>= 3.10`. Documented in `README.md` (Quick start) and DESIGN §7. Fail-not-skip is kept. A8 guards the pin and the step order statically | 654b829 |
| 2. Deployment brief updated (evidence update under delegation) | `docs/evidence/slice-2/DEPLOYMENT_BRIEF.md`: governance line 3, the status row and D-02 (Decision log and §1) now say **PERFORMED on public sample data**. They link this file and give the dataset commit and both files' control totals. D-02 restates the limits, unchanged: a real AWS manifest, real-export null encoding, Google data, real billing data. The §8 check is ticked, worded "on public sample data". The production go-live gate, the owner actions (§7) and the D-09 check are **not** touched | 68229da |
| 3. `ProviderName` vs source type | the pointer to #62 above | 68229da |

Gates after decision 1:
- `npx vitest run scripts/governance scripts/local scripts/acceptance`:
  608 passed, then 51/51 in `acceptance.test.mjs` with the new CI guard;
- the CI YAML parses, and its step order is checked;
- the assertion command exits 0 locally (Python 3.11.15).

GitHub CI was not run (nothing is pushed).

## 11. Challenger review of 91a0721..68229da (REQUEST CHANGES: 1 Medium, 4 Low); local, not pushed

### Commits

| SHA | Commit | Kind |
|---|---|---|
| 6908555 | A10 full-row tests, P1 expected-row tests, A5 exact messages and new cases, 2 new mutations, `__pycache__/` gitignore test, the pinned column classification | **red** (`red/red-challenger-fast.txt`: 15 failed / 64; `red/red-challenger-python.txt`: 4 errors / 20) |
| 13763f5 | full-row comparison (`--rows`, `rowProblems`), wired into `local:acceptance`; mutations `corrupt-text-columns`, `corrupt-list-cost` | green (M1) |
| f54b39f | `scripts/acceptance/__pycache__/*.pyc` removed from git; `__pycache__/` ignored | L1 |
| 6e518fc | DESIGN §4/§5/§6/§8, the brief's D-02 "Also checked" wording, the stale texts, and the §8 sign-off wording | docs (M1 wording, L3, L4) |
| (this commit) | this section; `runs/` replaced with the 6e518fc runs | docs |

### M1: the full-row comparison

**The gap.** The run compared only `Id`, `BilledCost`, `EffectiveCost`, the
currency and the period per row. The challenger corrupted `ServiceName`,
`ProviderName`, `ChargeDescription`, `ResourceId`, `ChargeCategory` and
`ListCost` in the staged rows, and the run still passed.

**The fix, in two parts.**
- **The expected side.** `focus_control_totals.py --rows` computes, for each
  **upstream** record, the exact API row (DESIGN §4). It uses the
  independent Python tokenizer, never the staged copy. Every upstream
  column is classified (`columns`):
  - 19 are mapped to named API fields;
  - 25 are returned verbatim in `extraColumns`;
  - `notReturned` is empty: every upstream value comes back.

  The classification is pinned in `control-totals.json` (for 1k and 10k)
  and asserted literally in A10.
- **The comparison.** `rowProblems` (in `local:acceptance`, after the
  totals) requires, per API row matched by `extraColumns.Id`:
  - strict equality on all **21** upstream-derived fields: money and
    quantities as decimal strings with their scale, `billingPeriod` as
    `YYYY-MM-DD`, timestamps as `…T…​.ffffffZ`, every text field,
    `focusVersion`, and `extraColumns` with the same keys and values;
  - an upstream `NULL` must be `null` or absent;
  - exactly the route's 26 fields. A10 reads the `SELECT` aliases from
    `publishedCosts.ts` to catch drift;
  - the shape of the 5 metadata fields, one source, and one API row per
    upstream record.

**Unit evidence.**
- A10: any compared field changed ⇒ exactly one problem, naming the field
  and the Id. Also: null vs value, scale, an extra or a dropped
  `extraColumns` key, a missing, duplicate or unknown Id, the field set,
  the metadata shapes, the report cap.
- P1: the mapping, null/empty handling, offset → UTC, the `Usage*`
  fallback, and the fail-closed cases.
- P2: `--rows` on the 1k file gives 1000 unique Ids, and its first row
  equals upstream data line 1 **mapped by hand**.

**Live evidence.** In every passing run, `rowsCompared` was
`{rows: 1000 | 10000, fieldsPerRow: 21, extraColumns: 25}`, with no
problem. The challenger's two mutations are now built in, and both fail
(below).

### L1–L4

- **L1:** the two `.pyc` files are removed from git, and `.gitignore` has
  `__pycache__/` (A8 asserts it). `git status` stays clean after an
  unguarded `python3 -m unittest`.
- **L2:** A5 now asserts the **exact** problem list of every case (totals,
  rows, sync, re-sync, catalog, artifact set, lossless). New cases, each
  built so that **only** that check can see it:
  - `effectiveCostNulls` alone: the control's null count changed; the sums,
    digest, counts and API totals all agree;
  - the distinct-key check alone: same row count, two rows share
    (batch, artifact, ordinal);
  - a catalog batch for an unexpected period;
  - a changed staged header with untouched records.

  The four code mutations that used to survive are now killed: CM11–CM14
  below.
- **L3:**
  - `ci.yml`'s acceptance comment and §8 no longer say python3 is
    preinstalled: CI pins 3.12 (§10);
  - the brief's Slice 1 status row now says the SYNTHETIC fixture **and the
    public FOCUS sample** were ingested, locally and ephemerally, and that
    no real billing data ever was.
- **L4:** the brief's §8 release check reads "**The acceptance run
  performed on public sample data and signed off by the orchestrator under
  the owner's delegation (Slice 2b PR)**". This is a change to §10
  decision 2, which had dropped "signed off". The check says explicitly
  that this sign-off covers the acceptance run only, **not** production
  go-live, which stays the owner's non-delegable gate (§7, owner action 1).
  The go-live gate and the owner actions are otherwise untouched.

### Code mutations (scratch `code_mutations2.py`; `runs/code-mutations.txt`)

20/20 were killed; the tree was clean after restore.

| Id | Mutation | Killed by |
|---|---|---|
| CM1–CM10 | as §7.2 | as §7.2 (re-run: all killed) |
| CM11 | the lossless check ignores the header | A3 (changed header) |
| CM12 | the catalog ignores an unexpected period | A5 catalog (extra, unexpected period) |
| CM13 | `effectiveCostNulls` not compared | A5 (`effectiveCostNulls` alone) |
| CM14 | the distinct-key check dropped | A5 (distinct-row check alone) |
| CM15 | row compare: `extraColumns` always equal | A10 |
| CM16 | row compare: an unexpected `extraColumns` key allowed | A10 |
| CM17 | row compare: an upstream record without an API row ignored | A10 |
| CM18 | Python rows: the `NULL` token kept as text | P1, P2 (hand-mapped row) |
| CM19 | Python rows: the offset not converted to UTC | P1 |
| CM20 | the `corrupt-list-cost` mutation changes nothing | A6 |

### Gates (HEAD 6e518fc)

| Gate | Result |
|---|---|
| `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 |
| `npm test` | **105 files / 2492 tests passed** (44.8 s) |
| `npm run test:db` ×1 (private PG16 55830, created and deleted again) | **597 + 173 passed** (110 s) |
| `next build` / `check:bundle` | 0 / pass |
| `npm run local:test` (`ratio-s2b-test`) | pass, 26 s (`runs/localtest.json`) |
| `npm run local:acceptance` 1k ×2 | pass, **21.9 s** and **21.9 s**; 1000 rows compared on 21 fields; totals as §2 |
| `npm run local:acceptance -- --dataset 10k` | pass, **29.0 s**; 10000 rows compared on 21 fields; totals as §2 |
| data mutations (1k), 10/10 fail | see below |
| leftovers | no `ratio-s2b*` containers, volumes or networks; no `.ratio-local/`; `.ratio-sample-data/` removed; private cluster deleted; tree clean |

| Mutation | Exit | First failing check (abridged) |
|---|---|---|
| `corrupt-billed` | 1 | first sync: `billedTotal "20.28022672900" != control "20.28022672899"` |
| `corrupt-effective` | 1 | API rows: `effectiveCost 14.97651418587 != control 14.97651418586`; rowDigest |
| `drop-row` | 1 | first sync: `rowCount "998" != control "999"` |
| `double-ingest` | 1 | first sync: `rowCount "1998" != control "999"` |
| `shift-period` | 1 | first sync: `rowCount "1000"`; `control period 2024-10-01 was not synced` |
| `swap-billed` | 1 | API rows: rowDigest only |
| `skip-null-conversion` | 1 | first sync: both periods `quarantined` (`UNPARSEABLE_NUMBER x7` / `x1`) |
| `skip-period-split` | 1 | first sync: 2024-09 `quarantined` (`PERIOD_MISMATCH x1`) |
| **`corrupt-text-columns`** | 1 | full-row: `row Id=11472: providerName "AWS~mutated" != upstream "AWS"`, then `serviceName`, `serviceCategory`, `chargeCategory`, `resourceId`, and `extraColumns` (ChargeDescription) |
| **`corrupt-list-cost`** | 1 | full-row: `row Id=11472: listCost "0.00000080001" != upstream "0.00000080000"` |

Every sum, count, digest and API total still agreed for the last two. Only
the full-row comparison catches them.

## 12. Copilot review of PR #63 at ba8c47a (2 Medium, CI green); local, not pushed

**Findings 4177490229 (`local.mjs:686`) and 4177490261 (`local.mjs:692`).**
Both acceptance syncs ran the worker CLI with `allowFail: true`, and the
verdict read only the evidence record. A sync that printed a valid record
but exited non-zero would therefore have passed. The plain `sync()` path,
which `local:test` uses, already rejected `r.code !== 0`.

### Commits

| SHA | Commit | Kind |
|---|---|---|
| ddf01c0 | A11 (fake runner) and the A9 updates and sweep | **red** (`red/red-copilot-sync-exit.txt`: 8 failed / 66) |
| ad0e82d | `syncTwice`: both syncs judged on exit code + record; `local:acceptance` uses it; `syncRecord`'s `allowFail` documented | green |
| (this commit) | DESIGN §5, this section, runs | docs |

### The fix

`syncTwice` (`acceptance.mjs`) runs both syncs through an injected runner
(`sync(name)` ⇒ `{ code, record }`). Each sync must exit with **exactly 0**,
and its record must pass the existing checks.

**First sync, on failure:**
- the exit code is recorded (`steps.sync.exit`);
- the catalog's quarantine reasons are recorded (`beforeFail`);
- the run fails, listing both the exit code and the record's reasons;
- no second sync runs.

**Second sync:** the exit code must be 0 and every period
`skipped_unchanged`.

A missing record, a `null` code (the process was killed by a signal) or a
non-number code also fail.

### Sweep of every `allowFail` and ignored `.code` in `scripts/local/*.mjs`

| Site | Exit code |
|---|---|
| `migrate --status --json` (`local.mjs`, shared by `local:test`) | judged: `status.code !== 0` ⇒ throw |
| `syncRecord` (the worker `sync`) | judged by every caller: `sync()` (`local:sync`, `local:test`) rejects `r.code !== 0`; `syncTwice` requires 0. A comment now says so |
| the control-total calculator (`python3`) | judged: `calc.code !== 0` ⇒ throw |
| every other `runProcess` / `run` call (`docker`, `npm`, compose `up`/`down`, `worker:build`, `migrate`) | no `allowFail`: `runProcess` rejects any non-zero exit |
| `lib.mjs`, `bootstrap.mjs`, `acceptance.mjs`, `fetch-focus-sample.mjs` | no CLI call with `allowFail` |

A static test (A9 sweep) now requires every `allowFail: true` line in
`scripts/local` to either check `.code !== 0` within the next 3 lines or
carry an "exit code judged by" comment just above.

### Tests and mutations

A11 uses a fake runner:
- a valid, passing first-sync record with **code 1** ⇒ fails; the code and
  the diagnostics are recorded; no second sync;
- the same with a quarantine ⇒ both the exit code and the reasons are
  reported;
- a valid, all-skipped second-sync record with **code 1** ⇒ fails; the code
  is recorded;
- no record, a `null` code, or `"0"` ⇒ fail.

Code mutations (scratch `code_mutations3.py`; `runs/code-mutations-exit-code.txt`).
The `M` lines in that file's status output are the then-uncommitted fix,
committed as ad0e82d. **6/6 were killed:**

| Id | Mutation | Killed by |
|---|---|---|
| CM21 | the exit-code check dropped | A11 (first and second sync) |
| CM22 | only the first sync checks the code | A11 (second sync) |
| CM23 | a non-zero code accepted when the record passes | A11 |
| CM24 | the diagnostics skipped on a failed first sync | A11 |
| CM25 | the acceptance body no longer uses `syncTwice` | A9 |
| CM26 | `syncRecord`'s `allowFail` without saying who judges the code | A9 sweep |

### Gates (HEAD ad0e82d)

| Gate | Result |
|---|---|
| `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 |
| `npm test` | **105 files / 2498 tests passed** |
| `next build` | 0 (`tsconfig.json`/`next-env.d.ts` restored) |
| `npm run local:acceptance` 1k ×1 | **pass, 23.3 s**. `sync` exit 0: 2024-09 published 999 / `20.28022672899`, 2024-10 published 1 / `0.24000000000`, both unverified. `syncAgain` exit 0, both `skipped_unchanged`. 1000 rows compared on 21 fields. `appStop: stopped`, `down: ok (-v)` (`runs/acc1k-copilot-exit-code.json`) |
| leftovers | no `ratio-s2b*` containers or volumes, no `.ratio-local/`, tree clean |

`test:db`, `local:test` and the 10k run were not re-run in this round, as
the coordinator did not ask for them. Nothing they exercise changed:
- `src/` is untouched;
- `local:test` still goes through the unchanged `sync()`; only
  `syncRecord`'s comment changed.
