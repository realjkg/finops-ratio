# Slice 2b — Acceptance run on the public FOCUS 1.0 Sample Data: design note

Branch `slice/02b-sample-acceptance`, from `origin/main` at 91a0721 (Slice 2,
PR #59, merged). One concern: **prove the trusted ingestion path end to end on
real-shaped public data**:

```
sample FOCUS CSV → staged as an AWS Data Exports layout in the local SeaweedFS
  → worker sync (the real CLI, the real S3 source, unchanged)
  → GET /api/v1/costs/published (the real route under next start)
  == control totals computed independently from the upstream file
```

This is decision D-02 of `docs/evidence/slice-2/DEPLOYMENT_BRIEF.md` and the
first item of its release-readiness checks (§8): "row counts vs the CSV files,
totals per period and currency vs totals computed independently from the CSV,
idempotent re-sync, evidence re-hash, read back through the API, and the
CC BY 4.0 attribution recorded".

Boundary: local and ephemeral only. No production infrastructure. No real
cloud credentials. No network at test time; the only network use is an
optional, pinned, SHA-256-checked fetch of the 10k file (§3). **No production
code changes**: nothing under `src/` or `pages/` changes, and no Slice 0/1
test changes. The only Slice 2 files that change are `scripts/local/local.mjs`
(a new `acceptance` command; `seed` split into helpers with identical
behaviour) and `.github/workflows/ci.yml` (one step appended).

## 1. The dataset (D-02)

| | |
|---|---|
| Source | FinOps Foundation, "FOCUS 1.0 Sample Data", https://github.com/FinOps-Open-Cost-and-Usage-Spec/focus-sample-data |
| Commit | `adbdd17a132984d6e8583c149c236d2199c3f5bc` (2024-12-11) |
| Licence | CC BY 4.0 (`license.md` at that commit). Attribution required; changes must be stated. |
| `FOCUS-1.0/focus_sample.csv` | 755,423 bytes, SHA-256 `e91e5ac7edf01ed2c9d926f37ef7dc1ae2aae97956fea8da6c9ee488b1c2839e`, git blob `8d7568d2c024926d086b4d232010f9a0580657d2`, 1,000 data rows |
| `FOCUS-1.0/focus_sample_10000.csv` | 7,529,214 bytes, SHA-256 `0bf58b73123294c4476b648e647cad842935036f67dc4e9a2cc4a6d7497cc2e3`, git blob `3315d4806a37642f4cff86e7977302adf089e486`, 10,000 data rows |

Both CSVs are plain git blobs (not Git LFS; only the `*.gz` files are LFS), so
`raw.githubusercontent.com/<repo>/<commit>/<path>` serves the exact bytes.

**Measured profile (both files):**
- 44 columns, the same header. FOCUS 1.0 columns plus a non-FOCUS `Id`
  (unique per row) and `Tags` (JSON text).
- ASCII, LF line endings, no BOM, no embedded newlines. Every string is
  double-quoted; numbers are unquoted.
- **SQL NULL is written as the unquoted bare token `NULL`.** This happens in
  19 (1k) / 24 (10k) columns, including the numeric ones: `ContractedCost`
  (7 / 68), `ConsumedQuantity` (1 / 36), `ListCost` (0 / 1) and
  `PricingQuantity` (0 / 4). An empty string is written quoted (`""`).
  There is no unquoted empty field, no quoted `"NULL"`, no `+` sign and no
  negative zero.
- One currency, `USD`. Two billing periods: 2024-09 and 2024-10. 2024-10
  holds Oracle rows only: 1 in the 1k file, 2 in the 10k file.
- Providers: AWS (942 / 9,441 rows), Microsoft (51 / 491), Oracle (7 / 68).
  There is no Google data in these files, so Google is not covered.
- Timestamps are `YYYY-MM-DD HH:MM:SS` without an offset. The worker reads
  them as UTC (Slice 1 D-i).
- `BilledCost` and `EffectiveCost` are never NULL. They have 11 decimal
  places, and some are negative.

**Where the files live (decided):**
- **(b) for the 1k file:** committed verbatim as
  `fixtures/focus-1.0-sample/focus_sample.csv` (≈755 KB), with
  `NOTICE.md` (attribution, licence, the changes the acceptance run makes)
  and `dataset.json` (pins: commit, path, size, SHA-256, rows).
- **(a) for the 10k file:** `npm run sample:fetch` downloads it from the
  pinned commit's raw URL (or copies it from a local clone with
  `--from-clone <dir>`), checks size and SHA-256, and only then writes it to
  `.ratio-sample-data/<commit>/` (gitignored). It is never committed.

**Why both:**
- CI must not depend on the network at test time. The committed 1k file makes
  the CI run hermetic. 755 KB is a one-off cost, in the same range as the
  existing fixtures and lockfile.
- Committing it **verbatim**, byte-identical to upstream, means its
  SHA-256 is upstream's. Anyone can verify it against the pinned commit, and
  the licence's "indicate changes" duty is simple: there are none in the
  repository. The changes happen only in the staged copy (§2), which is never
  committed.
- The 10k file (7.5 MB) is ten times the size and adds no new shape. It is
  for the on-demand larger run, so a pinned fetch with a hash check is enough.
- Every run checks SHA-256 against `dataset.json` before it uses a file, and
  refuses a mismatch.

## 2. Can the worker ingest these files as they are? No — and the minimal path

The worker's only real source is AWS Data Exports (Slice 1 DESIGN §3,
`src/ingest/sources/s3/layout.ts`):
- data files under `<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/<runId>/*.csv[.gz]`;
- exactly one `*Manifest.json` per period under
  `<prefix>/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/`;
- `dataFiles` confined to that period's data folder;
- every row's `BillingPeriodStart` must equal the folder's period
  (`PERIOD_MISMATCH`);
- numeric cells must be finite decimals (`UNPARSEABLE_NUMBER`);
- one currency per batch.

| Sample property | Worker behaviour if staged unchanged | Needed |
|---|---|---|
| A single CSV, no manifest, no partitioning | no period is listed at all | **staging** (layout) |
| Rows of two billing periods in one file | rows of the other period ⇒ `PERIOD_MISMATCH` ⇒ batch quarantined | **staging** (split by `BillingPeriodStart`) |
| Unquoted `NULL` in numeric columns | `UNPARSEABLE_NUMBER` ⇒ batch quarantined | **staging** (null token → empty) |
| Unquoted `NULL` in text columns | stored as the text `"NULL"` (e.g. `ChargeClass: "NULL"`, `Tags: "NULL"`), which is wrong but not refused | **staging** (same rule, every column) |
| AWS, Microsoft and Oracle rows in one "AWS" export | accepted: the worker does not constrain `ProviderName` | nothing (noted, §9) |
| 44 columns incl. non-FOCUS `Id`, `Tags` | the required 5 present; the rest is mapped or kept in `extra_columns` | nothing |
| FOCUS version | the worker takes it from `sources.declared_focus_version` (`1.0`); there is no in-file version | nothing (provisioned as `1.0`) |
| Timestamps without offset | read as UTC (D-i) | nothing |
| One currency per period | single-currency batches | nothing |

The red evidence (`red/`) shows each staging step is needed. The acceptance
run with the converter's steps turned off produces:
- `skip-null-conversion` ⇒ `UNPARSEABLE_NUMBER`;
- `skip-period-split` ⇒ `PERIOD_MISMATCH`.

**Decision: a staging converter in `scripts/`, no worker change.**
- Every gap is in the **delivery format**, not in the worker's FOCUS
  semantics.
- The `NULL` token comes from the dataset being a SQL table dump (its sibling
  `focus_data_table.sql.gz`). A CSV delivered by AWS Data Exports is not
  known to use it, and the worker's contract is "an empty cell is null".
- Teaching the production validator that the text `NULL` means null would
  change financial semantics for every real source. It would also make a
  provider's literal string `NULL` silently disappear. A worker capability
  (e.g. a per-source `nullToken`) would be a production change whose only
  user is this sample. It is not justified, and not built.
- So the converter turns the sample into what the worker's one real source
  type delivers. The worker then runs **unchanged**, through the real CLI,
  the real `S3FocusExportSource`, evidence capture, validation, reconcile
  and publish. There is no test-only bypass: no fake source, no flag, no hook.

### 2.1 The staging converter (`scripts/local/acceptance.mjs`, `stageFocusSample`)

A pure function of the upstream bytes. It has its own strict RFC 4180
tokenizer, which keeps **each field's raw bytes and whether it was quoted**.
It fails closed on: CR, an unterminated quote, bytes after a closing quote,
an inconsistent field count, a duplicate or missing required header, and a
`BillingPeriodStart` that is not the first of a month at midnight.

1. **Null token.** An **unquoted** field whose text is exactly `NULL` becomes
   an empty unquoted field. A quoted `"NULL"` is a string and is kept. Every
   other field keeps its **raw bytes, quotes included**. So the worker
   parses exactly upstream's values, except that nulls are empty.
2. **Split by billing period.** Records are grouped by their
   `BillingPeriodStart` (`YYYY-MM-01 00:00:00` ⇒ `YYYY-MM`), in upstream
   order. Each period's file is the upstream header line plus its records,
   LF-terminated.
3. **gzip.** Each period's file is gzipped with Node's `zlib` (header mtime
   0, so the output is deterministic for a given zlib).
4. **Layout** (bucket `ratio-local-source`, prefix `focus-sample`, export
   name `focus-1-0-sample`):
   ```
   focus-sample/focus-1-0-sample/data/BILLING_PERIOD=YYYY-MM/<executionId>/focus-1-0-sample-00001.csv.gz
   focus-sample/focus-1-0-sample/metadata/BILLING_PERIOD=YYYY-MM/focus-1-0-sample-Manifest.json
   ```
   - `executionId` is `sample-<first 12 hex of the upstream SHA-256>`.
   - The manifest is
     `{"exportName", "executionId", "billingPeriod": {"start", "end"}, "dataFiles": ["s3://ratio-local-source/<key>"]}`.
   - It has **no `x-ratio-control`**: real AWS manifests are not known to
     carry control totals. So the worker's own verdict is
     `reconciliation = 'unverified'`, the path a real export takes. The
     control is the independent check of §4, outside the worker.
   - The manifest's field set follows the worker's documented contract
     (Slice 1 DESIGN §3). It is **not** a verified copy of a real AWS
     manifest. That gap stays open (brief D-02).

**Losslessness is tested.** The sample has no unquoted empty field, so step 1
can be inverted exactly. Test A3 inverts it: it turns each empty unquoted
field back into `NULL`, takes the header once, and merges the periods back
into upstream order. The result must be **byte-identical to the upstream
file**, for the committed 1k file (and, in the acceptance run, for the file
in use). This test kills any converter defect that drops, duplicates,
reorders, re-quotes or rewrites a value.

## 3. Pinned fetch (`npm run sample:fetch [-- --from-clone <dir>]`)

- It reads the URL, size and SHA-256 from `dataset.json`; there are no
  arguments for them.
- It runs `GET https://raw.githubusercontent.com/FinOps-Open-Cost-and-Usage-Spec/focus-sample-data/<commit>/FOCUS-1.0/focus_sample_10000.csv`
  under the scripts' hard deadline (`withDeadline`, 120 s), with a byte cap.
- It writes to a temp file, verifies size and SHA-256, and only then renames
  the temp file to `.ratio-sample-data/<commit>/focus_sample_10000.csv`. A
  mismatch deletes the temp file and exits 1.
- `--from-clone <dir>` copies `<dir>/FOCUS-1.0/focus_sample_10000.csv`
  instead, with the same checks.
- The fetch never runs implicitly. The acceptance run only reads the cache,
  and refuses with the fetch command when the file is missing or its hash
  differs.

## 4. Independent control totals (`scripts/acceptance/focus_control_totals.py`)

**A different language and a different code path.** It is Python 3,
standard library only. It shares nothing with the worker (TypeScript,
csv-parse), the converter (JavaScript), Postgres's `sum`, or the API.
- It reads the **upstream file**, never the staged copy. That way, a
  converter defect is caught as a mismatch instead of being copied into the
  "expected" side.
- It has its own strict CSV tokenizer, which tracks quoting. It needs that
  tokenizer because Python's `csv` module loses the difference between
  `NULL` and `"NULL"`.
- **Exact decimal arithmetic in integers, no float and no `Decimal`
  context.** Each value `-?\d+(\.\d+)?` becomes (unscaled int, scale). A sum
  is the integer sum at the largest scale seen. That is Postgres's rule for
  `sum(numeric)` (result scale = the maximum input scale), so the comparison
  can be an exact string compare.
- It fails closed:
  - `BilledCost` must not be `NULL` or empty; `EffectiveCost` may be `NULL`
    (counted separately, not summed). Any other value that is not a plain
    decimal is an error. The sample has no exponents; refusing them keeps
    the scale rule exact.
  - The currency must be 3 capital letters.
  - The period must be a first-of-month at midnight.
  - The row-id column (`Id`) must be present and not null.
- It also accepts `--expect-sha256`: a mismatch exits 2 before parsing.

Output (one JSON document): the input's SHA-256, size and data-row count;
the unquoted `NULL` count per column; and, per (billing period, currency):
- `rowCount`;
- `billedCost`;
- `effectiveCost`;
- `effectiveCostNulls`;
- `rowDigest`: the SHA-256 of the sorted lines
  `Id \t BilledCost \t EffectiveCost (or \N)`, with values in Postgres
  `numeric::text` form (leading zeros removed, no negative zero).

The digest is what catches a value moved between rows, which no sum can see.

**Expected API rows (`--rows`; challenger M1).** For every upstream record,
the calculator also emits the exact row that `GET /api/v1/costs/published`
must return. That is the contract of `src/server/costs/publishedCosts.ts`,
written down independently in Python (`API_FIELD`); it is not imported from
the worker. The rules:

| API field(s) | From the upstream record |
|---|---|
| `billingPeriod` | `BillingPeriodStart` ⇒ `YYYY-MM-DD` (must be a first-of-month midnight) |
| `chargePeriodStart`, `chargePeriodEnd` | ⇒ UTC, `YYYY-MM-DDTHH:MM:SS.ffffffZ` (no offset = UTC; an offset is converted) |
| `billedCost`, `effectiveCost`, `listCost`, `contractedCost`, `pricingQuantity` | plain decimal ⇒ `numeric::text` form (scale kept, no leading zeros, no negative zero) |
| `usageQuantity`, `usageUnit` | `ConsumedQuantity` / `ConsumedUnit`, else `UsageQuantity` / `UsageUnit` |
| `billingCurrency`, `providerName`, `serviceName`, `serviceCategory`, `chargeCategory`, `resourceId`, `subAccountId`, `billingAccountId`, `pricingUnit` | the text, verbatim |
| `focusVersion` | the source's declared version (`1.0`) |
| `extraColumns` | every other column, verbatim, when neither null nor empty |

- An unquoted `NULL`, an empty field or a missing column ⇒ `null` (or absent
  from `extraColumns`). A quoted `"NULL"` is the text `NULL`.
- The output also carries `columns`, which classifies every upstream column:
  `mapped` (column ⇒ API field), `extra` (in `extraColumns`) and
  `notReturned`.
- For this dataset the pinned classification is 19 mapped, 25 extra, and
  `notReturned` empty: **every upstream value is returned**. The only lossy
  mappings are `BillingPeriodStart`'s time of day (validated as midnight) and
  the `Usage*` fallbacks (absent in this dataset).
- Test A10 asserts the classification literally, so any drift fails.

**Pinned expectations.**
- `fixtures/focus-1.0-sample/control-totals.json` holds the calculator's
  output for both files.
- Before it was pinned, the output was cross-checked by a third method:
  Python's `csv` + `decimal`, written separately during design (EVIDENCE).
- The acceptance run requires: live calculator output == pinned, AND
  API == live calculator. So drift in the calculator fails the run.

## 5. The acceptance run (`npm run local:acceptance [-- --dataset 1k|10k] [--mutation <kind>]`)

It is a new `acceptance` command in `scripts/local/local.mjs`, built from the
same parts as `local:test`. It reuses, unchanged:
- `runLocalTest`: body, then ALWAYS the bounded cleanup; pass/fail decided in
  `finalizeLocalTestSummary`; interrupt handling; spawn guard;
- `runProcess`, with every command in its own process group under a hard
  deadline;
- `withClient` (bounded pg sessions), `withDeadline` and `waitUntil`;
- `portInUse` / `preflightProblems` / `startIfPortFree` / `waitForOwnServer`;
- per-project state in `.ratio-local/<project>/`, and `down -v` at the end;
- `killLiveProcessGroups` as the final sweep.

**Its own project and ports** (`localAcceptanceSettings`):

| Variable | Default |
|---|---|
| `RATIO_LOCAL_ACCEPTANCE_PROJECT` | `ratio-local-acceptance` |
| `RATIO_LOCAL_ACCEPTANCE_PG_PORT` | 54349 |
| `RATIO_LOCAL_ACCEPTANCE_S3_PORT` | 18363 |
| `RATIO_LOCAL_ACCEPTANCE_APP_PORT` | 3120 |

It refuses any project name or port shared with the developer stack or with
`local:test`, as `local:test` does.

**Steps.** Each step is timed (`steps.timingsMs`).

1. **Before anything starts:**
   - a Next.js build must exist;
   - the dataset file's size and SHA-256 must equal `dataset.json`;
   - `python3 focus_control_totals.py --rows --expect-sha256 …` (120 s
     deadline). Its `input`, `columns` and `totals` must equal the pinned
     `control-totals.json` entry; its `rows` feed the full-row comparison;
   - `stageFocusSample` + the lossless round-trip check (§2.1), plus an
     optional mutation (§6);
   - the preflight (no state, containers or busy ports for the project).
2. **Stack:** `up` → `migrate`. `migrate --status` must report no privilege
   problems.
3. **Seed:**
   - buckets (warmed);
   - PUT every staged object;
   - provision, as the owner login (ingestion-ops SKILL §2), tenant
     `local-focus-sample` and source `focus-sample`, with display name
     `FOCUS 1.0 Sample Data (FinOps Foundation, CC BY 4.0) - public sample, not tenant billing data`,
     `declared_focus_version '1.0'` and
     `config {layout: aws-data-exports, bucket, prefix, exportName}`.
4. **`sync`** (the real worker CLI, as `ratio_local_worker`). For every
   control period it must report:
   - `published`;
   - `rowCount` and `billedTotal` equal to the control;
   - `reconciliation: 'unverified'`.

   No other period may appear.
5. **`sync` again:** every period `skipped_unchanged`.

   **Both syncs must also exit 0** (`syncTwice`; Copilot 4177490229 /
   4177490261). The CLI runs with `allowFail` so that a failing sync's
   evidence record, with its quarantine codes, can still be read. A non-zero
   exit fails the run even with a valid record, and the exit code is
   recorded. A failed first sync records the catalog's quarantine reasons
   and then fails, reporting both the exit code and the reasons; no second
   sync runs.
6. **`next start`** (reader login, token, tenant binding). An anonymous read
   must get 401. Then it pages `GET /api/v1/costs/published?limit=500` until
   `nextCursor` is null, with a page cap of ⌈rows/500⌉ + 1.
7. **Assertions, all exact strings:**
   - the page-1 `totals` per (period, currency) equal the control's
     `rowCount` and `billedCost` (summed by Postgres);
   - over all pages:
     - the number of rows and distinct (batch, artifact, ordinal) keys equal
       the control's row count;
     - per (period, currency), the JavaScript BigInt sums of `billedCost`
       and `effectiveCost`, the `effectiveCost` null count and the row
       digest equal the control. This is a third implementation of the
       sum, with the same scale rule;
   - the set of `artifactSha256` in the API equals the SHA-256 set of the
     staged data objects;
   - **full-row comparison** (`rowProblems`; challenger M1). Every API row is
     matched by `extraColumns.Id` to the calculator's expected row for the
     **upstream** record (§4). All 21 upstream-derived fields must be
     strictly equal:
     - strings for text and decimal strings for money and quantities, scale
       included;
     - `null` for upstream nulls;
     - `extraColumns`: the same keys and the same values.
     
     In addition:
     - each row has exactly the route's 26 fields (`API_ROW_FIELDS`; A10
       checks them against the `SELECT` list in `publishedCosts.ts`);
     - `extraColumns` holds only columns classified `extra`;
     - the 5 metadata fields (`sourceId`, `batchId`, `artifactSha256`,
       `rowOrdinal`, `publishedAt`) have their shape, and there is one
       source;
     - every upstream record has exactly one API row, and no API row lacks
       an upstream record.
8. **Evidence re-hash** (brief §8): for each staged data object, the evidence
   object `evidence/<tenant>/<source>/<sha256>` is fetched from the evidence
   bucket and re-hashed. The hash must equal its key and the staged bytes'
   SHA-256.
9. **Catalog check** (local superuser, in a READ ONLY transaction): exactly
   one batch per control period, and each must be:
   - `published` and `unverified`;
   - `is_provisional = false` (2024 periods);
   - `row_count` and `loaded_billed_total` equal to the control.

   No quarantined, staged or superseded batch may exist. The same check
   records the average stored row size (`pg_column_size`) for D-09
   (informational).
10. Cleanup: stop `next start`, `down -v`, always. The run passes only under
    `runLocalTest`'s rule (body completed, app stopped by us, `down -v` ok).

The summary is one JSON line of `type: "ratio.local-acceptance"`. The exit
code is 0 only on pass (130/143 on interrupt).

## 6. Mutation checks (`--mutation <kind>`; each must FAIL the run)

Each mutation is applied to the **staged** objects after conversion. The
expected side always comes from the untouched upstream file.

| Kind | What it changes in the staged data | Expected failure |
|---|---|---|
| `corrupt-billed` | the first record of the largest period: `BilledCost` + 1 in the last decimal place (still valid) | totals + row sums + digest |
| `corrupt-effective` | the same for `EffectiveCost` (not in the API totals) | row sums + digest |
| `drop-row` | the last record of the largest period removed | row counts, totals |
| `double-ingest` | a second data file in the largest period: the same CSV, gzipped at another level (different bytes, so not a byte-identical duplicate), listed in the manifest | row counts, totals (×2) |
| `shift-period` | the latest period's records restated into the earliest period (`BillingPeriodStart`/`BillingPeriodEnd` rewritten, staged there) | per-period totals; a period missing |
| `swap-billed` | `BilledCost` swapped between two records of the largest period whose values differ | digest only (sums unchanged) |
| `skip-null-conversion` | step 1 of the converter skipped | worker quarantines (`UNPARSEABLE_NUMBER`) |
| `skip-period-split` | step 2 skipped: one file, all rows, in the earliest period | worker quarantines (`PERIOD_MISMATCH`) |
| `corrupt-text-columns` (challenger M1) | the first record of the largest period: `ServiceName`, `ProviderName`, `ChargeDescription`, `ResourceId`, `ChargeCategory`, `ServiceCategory` each get `~mutated` appended (still quoted strings) | full-row comparison only (sums, counts and digests unchanged) |
| `corrupt-list-cost` (challenger M1) | the first record of the largest period: `ListCost` + 1 in the last decimal place | full-row comparison only |

These mutations are harness-only. They change what is uploaded, never the
worker or the expected side.
- A mutated run marks itself `mutation: <kind>` in the summary.
- A unit test (A6) proves each mutation changes the staged objects as
  described. The recorded runs (EVIDENCE) prove each fails the live run.

## 7. CI (decided: the 1k run goes into CI)

- **Where:** one step, `npm run local:acceptance` (1k, the default), appended
  after `local:test` in the existing `ci` job. No new job.
- **Why it fits:** the job's measured time on main (run 37194601870, 91a0721)
  is 275 s against `timeout-minutes: 10`, and `local:test` takes 24 s. The
  1k acceptance run is a second stack of the same images (already pulled)
  plus 1,000 rows. It is measured locally in EVIDENCE, and the job stays far
  under 10 minutes.
- **Why CI and not on demand only:** it is the only test that runs real-shaped
  multi-provider FOCUS data through the whole path. A worker or API change
  that breaks real data but not the synthetic fixture would otherwise go
  unseen.
- **Hermetic:** the file is committed, the hash is checked, and there is no
  network.
- **Python is a development dependency (decided by the coordinator):**
  - Python 3.10+ as `python3`, standard library only, needed for `npm test`
    (P2) and `local:acceptance`. Without it those tests fail, never skip.
  - CI pins Python 3.12 with `actions/setup-python` (SHA-pinned, v5.6.0)
    before `npm ci`, then asserts `>= 3.10` in a separate step.
  - It is documented in `README.md` (Quick start).
- **The 10k run stays on demand** (`sample:fetch` then
  `local:acceptance -- --dataset 10k`). In CI it would need a network fetch
  at test time or a 7.5 MB commit, and it adds no new shape.

## 8. Tests (written first; red evidence in `red/`)

| Id | File | What |
|---|---|---|
| A1 | `scripts/local/acceptance.test.mjs` | `localAcceptanceSettings`: defaults, overrides, refuses overlap with the dev and test stacks |
| A2 | 〃 | tokenizer: quotes, `""` escapes, raw bytes kept; refuses CR, an unterminated quote, junk after a quote, a ragged row |
| A3 | 〃 | `stageFocusSample` on the committed 1k file: the layout keys, two periods with 999 / 1 records, the manifest (`dataFiles`, period, no `x-ratio-control`), every unquoted `NULL` gone, quoted values unchanged, and the **byte-exact round trip** to upstream |
| A4 | 〃 | decimals: `sumDecimals` (max-scale rule, negatives, zero, no float), `canonicalDecimal` |
| A5 | 〃 | `aggregateApiRows` + `compareAcceptance`, the sync, re-sync and catalog checks: equal ⇒ none; every case asserts its **exact** problem list (challenger L2), including the cases only one check can see: `effectiveCostNulls` alone, the distinct-key check alone, a catalog batch for an unexpected period, and (A3) a changed header |
| A10 | 〃 (challenger M1) | `rowProblems`: equal ⇒ none; a change in any of the 21 compared fields is reported exactly once with the field and the Id; null vs value, decimal scale, a dropped or unexpected `extraColumns` key; missing, duplicate or unknown Id; the 26-field contract (checked against `publishedCosts.ts`); metadata shapes; one source; the report cap; the pinned column classification asserted literally |
| A6 | 〃 | each mutation changes the staged objects as §6 says; an unknown kind is refused |
| A7 | 〃 | `verifyDatasetFile` / `fetchPinnedFile`: a size or hash mismatch is refused and leaves no file; a matching body is written atomically; a fetch is bounded by a deadline |
| A8 | 〃 | `package.json` wires `local:acceptance` and `sample:fetch`; `.ratio-sample-data/` is gitignored; `NOTICE.md` names the licence, the source, the commit and the changes; the committed file's SHA-256 equals `dataset.json` |
| A9 | 〃 (added with the wiring, 862e2be) | static: `local:acceptance` runs on its own settings, after the preflight, inside `runLocalTest` with the interrupt; the pin and the calculator are checked before any stack exists; the real worker CLI runs twice, with no fake source, test hook or manifest control; every comparison fails the run |
| P1 | `scripts/acceptance/test_focus_control_totals.py` | the Python calculator: tokenizer, decimal sums (exact, max scale), NULL handling per column, the digest, fail-closed cases, `--expect-sha256`; and the expected API rows (`--rows`): the mapping of every field, null/empty handling, timestamp conversion, the `Usage*` fallback, the column classification, a duplicate Id and bad timestamps refused |
| P2 + rows | 〃 (vitest) | also: `--rows` on the committed 1k file gives 1000 rows with unique Ids, and its first row equals upstream data line 1 **mapped by hand** |
| P2 | `scripts/acceptance/controlTotals.test.mjs` (vitest) | runs P1 (exit 0 required; python3 missing ⇒ **fail**, never skip), then runs the calculator on the committed 1k file and requires its output to equal the pinned `control-totals.json` |
| E2E | `npm run local:acceptance` (CI) and `-- --dataset 10k` (on demand) | §5; mutation runs §6 |

## 9. Threat model and failure cases

| Risk | Control |
|---|---|
| The expected side is derived from the thing under test | The calculator reads the upstream file, in another language, with no shared code; the pinned totals were cross-checked by a third method |
| The converter hides a defect (drops, duplicates, rewrites) | Byte-exact inverse round trip (A3) in unit tests and in every run |
| A tampered or truncated dataset | size + SHA-256 pinned in `dataset.json`, checked before use (fetch and run) |
| Network at test time | none; the fetch is explicit and pinned |
| Sample data mistaken for tenant billing data | display name, tenant slug and source key say "sample"; the local stack is destroyed at the end (`down -v`) |
| Licence | `NOTICE.md` with attribution, the licence link and the changes; EVIDENCE repeats it |
| A test-only bypass in the worker | none: real CLI, real S3 source, unchanged `src/` |
| Port / project collision with a developer stack or `local:test` | own settings, overlap refused, preflight refuses existing state |
| A hung step | every step under the existing hard deadlines; the Python step 120 s; the fetch 120 s |

**Noted, not changed (finding for the backlog):**
- The worker does not check that a source's rows match the provider its
  source type implies. An "AWS Data Exports" source carrying Microsoft and
  Oracle rows is accepted. For a real AWS export that cannot happen, but a
  misconfigured bucket could feed foreign rows. Tracked in
  realjkg/finops-ratio#62.
- The `NULL` token is a sample-format artifact; how real exports write a
  null is confirmed only when a real export is connected (brief D-02,
  optional owner action).

## 10. Rollback

- Revert the branch's commits. No migration and no production code are
  involved.
- CI: remove the appended step.
- Local: `npm run local:down` with `RATIO_LOCAL_PROJECT=ratio-local-acceptance`
  and `-- -v`. That is only needed after an interrupted run's forced exit;
  a normal run always ends with `down -v`. Delete `.ratio-sample-data/` to
  drop the fetched 10k file.
