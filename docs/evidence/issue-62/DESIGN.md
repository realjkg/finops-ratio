# Issue #62 — reject rows whose `ProviderName` does not match the source type: design note

Branch `fix/62-provider-source-check`, from `origin/main` at 827773f (Slices 0,
1, 2 and 2b merged). Restricted class: it changes Slice 1 worker behaviour, so
it needs a challenger review. Not pushed; no PR.

**The gap (found by the Slice 2b acceptance run).** The worker never compares
FOCUS `ProviderName` with the source it is ingesting. An "AWS Data Exports"
source therefore published the public sample's Microsoft and Oracle rows as
AWS spend. With no manifest control totals (`unverified`), nothing else
catches it.

## 1. Where the worker validates rows today

| Stage | Where | What it refuses | Effect |
|---|---|---|---|
| Header | `focus/validate.ts` `indexHeader` | control characters, empty / over-long / duplicate names, the five `REQUIRED_COLUMNS` missing (`MISSING_REQUIRED_COLUMN`) | errors recorded, artifact not read further |
| Row | `focus/validate.ts` `validateRow` | column count, control characters, `BilledCost` / numerics (`MISSING_VALUE`, `UNPARSEABLE_NUMBER`), currency (`INVALID_CURRENCY`), timestamps (`UNPARSEABLE_TIMESTAMP`), period (`PERIOD_MISMATCH`), `CHARGE_PERIOD_INVERTED` | error recorded |
| Load | `worker/load.ts` `loadArtifact` | the row cap (`ROW_LIMIT_EXCEEDED`), CSV syntax, gzip, unsupported formats | error recorded |
| Batch | `worker/pipeline.ts` `processPeriod` | any error above ⇒ `VALIDATION_FAILED` (or `ROW_LIMIT_EXCEEDED` / `UNSUPPORTED_FORMAT`); zero rows ⇒ `EMPTY_BATCH`; more than one currency ⇒ `MIXED_BILLING_CURRENCY`; controls disagree ⇒ `RECONCILIATION_VARIANCE` | **the whole batch** is quarantined (Slice 1 D7, DESIGN §4 step 11): errors stored (first 1000, `validation_error_count` = total), facts deleted, nothing published |

`validateRow` is pure and knows nothing about the source. `ProviderName` is
mapped to `cost_facts.provider_name` (empty ⇒ NULL) and never checked.

**Per-source configuration today.** A source row (`ratio.sources`) has a
`kind` (`focus_file` | `fake`, CHECK-constrained) and a `config` object.
`worker/sourceFactory.ts` is the only production path from a row to a
`FocusSource`:
- `focus_file` ⇒ `S3FocusExportSource`, "the S3 AWS Data Exports source"; it
  requires `config.layout === 'aws-data-exports'` (`validateLocation`,
  else `SOURCE_CONFIG_INVALID`) before anything is listed or read;
- `fake` ⇒ the synthetic fixture, refused unless `NODE_ENV=test` and
  `RATIO_ALLOW_FAKE_SOURCE=1`.

The library entry point `runSync` also accepts an injected `FocusSource`
instance. Only tests and `replay-fixtures` use that; the CLI always uses
the factory.

## 2. The per-source-type allowlist

New pure module `src/ingest/focus/provider.ts`. The **source type** is
resolved from the RLS-visible source row, never from the data:

| Source row | Source type | Allowed `ProviderName` (exact) |
|---|---|---|
| `kind = 'focus_file'`, `config.layout = 'aws-data-exports'` | `aws-data-exports` | `AWS`, `SyntheticCloud` (see D1) |
| `kind = 'fake'` | `fake` | `SyntheticCloud` |
| anything else | none: not checked (see D4) | — |

**Matching is exact**: case-sensitive, no trimming, no normalisation, no
prefix match. `aws`, ` AWS`, `AWS ` and `Amazon Web Services` are all
mismatches.

### 2.1 Why `AWS`, and why only `AWS`

- **FOCUS 1.0 spec** (`specification/columns/provider.md` at the `v1.0` tag
  of FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec, read for this note):
  ProviderName is "the name of the entity that made the resources or
  services available for purchase". It is Mandatory, "MUST NOT contain null
  values", and its value format is "not specified". So the spec does not fix
  the string; the provider does.
- **FOCUS appendix "Origination of cost data"** (same tag): for purchases
  through a cloud marketplace (scenarios 3.1–3.3), the Provider is still the
  **cloud service provider**; only Publisher and Invoice Issuer change. So
  Marketplace rows in an AWS export are expected to carry the AWS provider
  value, not the seller's name.
- **The public FOCUS 1.0 sample** (commit `adbdd17`, both files): every AWS
  row has `ProviderName = "AWS"`. The longer names appear only in the other
  two columns: `InvoiceIssuerName` / `PublisherName` =
  `Amazon Web Services, Inc.`, `Amazon Web Services Canada, Inc.` or
  `Amazon Web Services EMEA SARL`. One Marketplace row has
  `PublisherName = Red Hat Inc.` and `ProviderName = AWS`, which matches the
  appendix.

  | File | AWS | Microsoft | Oracle |
  |---|---|---|---|
  | 1k, 2024-09 | 942 | 51 | 6 |
  | 1k, 2024-10 | 0 | 0 | 1 |
  | 10k, 2024-09 | 9,441 | 491 | 66 |
  | 10k, 2024-10 | 0 | 0 | 2 |

- **AWS documentation.** I could not read it from this environment: the
  egress proxy blocks `docs.aws.amazon.com`. A web search returned the AWS
  "FOCUS 1.0 with AWS columns" pages, including the conformance-gaps page.
  That page records "ProviderName might be null for certain charges" (see
  §3), but the search did not return the value AWS writes when the column
  is populated.

**Decision: allow `AWS` only, not `Amazon Web Services`.** Every piece of
evidence I could check uses `AWS`. Adding a second string that no checked
export uses would loosen the check on a guess. If a real export turns out
to use another spelling, the run fails closed and loudly: the rows are
recorded as `PROVIDER_MISMATCH`, and a period where every row mismatches is
quarantined. The fix is then one line in `SOURCE_TYPE_PROVIDERS`.
**Uncertainty, recorded:** the value is not yet confirmed against a real AWS
Data Exports FOCUS 1.0 file. That confirmation is part of the existing
owner action "manual acceptance run on a real export" (Slice 1 DESIGN §11,
Slice 2 brief D-02).

### 2.2 What a mismatching row does (D3)

A row whose `ProviderName` is present but not allowed is **excluded**:
- it is not inserted;
- it is recorded in `ingest_validation_errors` with code
  **`PROVIDER_MISMATCH`**, column `ProviderName`, its row ordinal and a
  message that names the source type and the allowed set. The message never
  includes the cell value (Slice 1 rule: row contents never reach logs or
  errors);
- `ingest_batches.validation_error_count` counts it.

The rest of the batch carries on through the normal path: other validation,
reconcile, publish. The published batch keeps its exclusion errors.
`quarantine show` works for any status, so they stay inspectable. The
period result gains `excludedRows` (a count; omitted when 0).

**A batch whose rows are all excluded is quarantined** with batch code
`PROVIDER_MISMATCH`, never published. Without this it would reach the
`EMPTY_BATCH` rule with a less precise reason.

**A mismatch together with any other error** quarantines the whole batch,
exactly as today. The batch code comes from the other errors
(`VALIDATION_FAILED`, `ROW_LIMIT_EXCEEDED`, `UNSUPPORTED_FORMAT`). The
quarantine reason's code summary also lists `PROVIDER_MISMATCH xN`.

**With manifest controls**, the controls describe the file, not the AWS
subset. A set-level `rowCount` or `billedTotal` that includes the foreign
rows therefore disagrees with the loaded batch, and the batch is quarantined
`RECONCILIATION_VARIANCE`. That is deliberate: a provider-attested file
that contains another provider's rows is suspicious, so the check fails
closed. Per-artifact row counts still count every record in the file
(unchanged).

**Why exclude rather than quarantine the whole batch.** This is the issue's
proposal ("A row outside that set is quarantined… A batch where every row
is quarantined is never published"), and the orchestrator's brief
("quarantines exactly the foreign rows and publishes the rest"). A foreign
row is not part of this source's spend. Excluding it leaves the published
set exactly the AWS rows: complete for AWS, and with the foreign rows
recorded. This differs from every other row error, where the row's own
data is bad and the batch can no longer be trusted. Whole-batch quarantine
is a one-line change in `load.ts` (treat the mismatch as `addError`) if the
orchestrator prefers it; see §8.

## 3. NULL or missing `ProviderName` (D2): fail closed

| Case | Result |
|---|---|
| The column is absent from the header (checked source types only) | header error `MISSING_REQUIRED_COLUMN` (column `ProviderName`) ⇒ batch quarantined `VALIDATION_FAILED` |
| The cell is empty (the worker's NULL) | row error `MISSING_VALUE` (column `ProviderName`) ⇒ batch quarantined `VALIDATION_FAILED` |

Why **quarantine the whole batch**, and not just exclude the row as for a
mismatch:
- FOCUS 1.0: ProviderName is Mandatory and MUST NOT be null.
- A foreign row is known not to be ours, so excluding it leaves a complete
  AWS set. A NULL row's provenance is unknown: it may be an AWS charge.
  Excluding it would publish AWS spend that is silently incomplete, which
  `unverified` batches could not reveal.
- So it is treated like a missing `BilledCost` (`MISSING_VALUE`), the
  existing rule for a mandatory value.

**Risk, recorded.** AWS documents a conformance gap: "ProviderName might be
null for certain charges". If that happens in real exports, every such
period is quarantined until AWS fills the value. That is loud and safe, but
it could block real ingestion. The alternatives are to allow NULL with a
flag, or to treat NULL as `AWS` for this type. Both are policy changes, so
they are left to the orchestrator or owner (§8).

Unchecked types (D4) keep today's behaviour: no header or NULL rule.

## 4. Implementation (minimal)

- `src/ingest/focus/provider.ts` (new, pure): `PROVIDER_MISMATCH`,
  `SYNTHETIC_PROVIDER_NAME`, the frozen `SOURCE_TYPE_PROVIDERS`,
  `providerPolicyFor(sourceRow)`, `checkProviderHeader(index, policy)` and
  `checkProviderName(value, policy)`.
- `worker/load.ts`: `LoadContext.providerPolicy`; after the header is
  indexed, the header check; after `validateRow` succeeds, the row check.
  NULL ⇒ `addError` (as any row error). Mismatch ⇒ new `addExclusion`:
  `LoadState.excludedCount`, the error is stored (same 1000 cap, same
  table), and the row is skipped without stopping the inserts.
- `worker/pipeline.ts`: passes the policy. All rows excluded ⇒ quarantine
  `PROVIDER_MISMATCH`. `validation_error_count` = errors + exclusions on
  every quarantine. On publish, `finalizeStaged` stores the exclusion
  errors (while still staged, Slice 0 rule 1). `excludedRows` goes in the
  result and the log. The batch-code choice ignores `PROVIDER_MISMATCH`.
- `worker/publish.ts`: `finalizeStaged` takes optional `errors` and
  `errorCount`. The validation-error INSERT becomes one helper, shared with
  `quarantineBatch`.
- `worker/types.ts`: `PeriodResult.excludedRows?`.

No schema change: a published batch may already have
`validation_error_count > 0`, and errors may be written only while the batch
is `staged`, which is when they are written. No change to `validate.ts`,
the API or the reader.

## 5. Acceptance run (Slice 2b): option (a), expect the quarantine counts

**Decision: (a).** The acceptance run stages the sample unchanged (all three
providers). It expects:
- 2024-09 published with the AWS rows only;
- the Microsoft and Oracle rows recorded as `PROVIDER_MISMATCH`;
- 2024-10 (Oracle only) quarantined `PROVIDER_MISMATCH`, never published.

The control totals are recomputed for AWS rows only.

**Why (a), not (b):**
- (a) runs the new check end to end on real-shaped data, through the real
  CLI and the real S3 source: the mixed case, the all-foreign case, and the
  publish of the remainder.
- (b) would make the converter decide which rows the worker sees. The run
  would then prove nothing about the check, and the published set would be
  correct only because the harness filtered it.
- **The independent control stays honest.** The Python calculator still
  reads the upstream file and shares no code with the worker. It gets one
  explicit, exact filter, `--provider AWS`. Rows of any other provider are
  reported per period under `excluded`, never summed. A NULL or empty
  ProviderName is refused (exit 1): the worker quarantines such a batch
  instead of excluding the row, so the control cannot predict the result
  row by row. The sample has none. The worker's
  allowlist and the calculator's filter are written separately: TS
  constant vs a CLI argument passed by `local.mjs`. So a worker that
  accepted `Microsoft`, or matched `aws` loosely, disagrees with the
  control.

**Expected values (1k, upstream file):**

| Period | Control `totals` (AWS) | `excluded` | Worker outcome |
|---|---|---|---|
| 2024-09 | 942 rows | 57 (Microsoft 51, Oracle 6) | `published`, `unverified`, `excludedRows` 57, `validation_error_count` 57, all `PROVIDER_MISMATCH` |
| 2024-10 | none | 1 (Oracle 1) | `quarantined` `PROVIDER_MISMATCH`, `validation_error_count` 1 |

10k: 2024-09 publishes 9,441 rows and excludes 557 (Microsoft 491, Oracle
66). 2024-10 has 2 Oracle rows and is quarantined. The exact money totals
and digests are pinned in `fixtures/focus-1.0-sample/control-totals.json`
and in EVIDENCE.

**What the acceptance checks become:**
- **First sync.** It must exit **1**: a quarantined period fails the run,
  Slice 1 exit codes. The exit code is derived from the control: 0 iff no
  period is all-excluded. The record must not pass. Each period with
  control totals: `published`, the AWS count and total, `unverified`, and
  `excludedRows` equal to the control's excluded count (absent when 0).
  Each all-excluded period: `quarantined`, code `PROVIDER_MISMATCH`.
- **Second sync.** It must exit 1 for the same reason. Published periods:
  `skipped_unchanged`. Quarantined periods: `failed` `BATCH_QUARANTINED`.
  Today's re-sync of a quarantined set does exactly this (Slice 1 §4 step 7).
- **Catalog.** One batch per period:
  - published periods: `published`, `unverified`, AWS count and total,
    `validation_error_count` = excluded;
  - all-excluded periods: `quarantined`, reason starting `PROVIDER_MISMATCH`,
    `validation_error_count` = excluded;
  - per batch, the stored error codes are exactly `{PROVIDER_MISMATCH: n}`.
- **API.** Totals, rows, digests and the full-row comparison against the
  calculator's AWS rows only. The comparison already reports any API row
  that is not an expected upstream record, so a published foreign row
  fails the run. Together with the counts, this shows exactly the foreign
  rows were excluded.
- **Artifact set.** The API rows' artifacts must equal the staged data
  objects of the **published** periods. The all-Oracle 2024-10 object has
  no API row.

**Data mutations** (harness-only) keep failing. `corrupt-text-columns`
appends `~mutated` to the first record's `ProviderName` (an AWS row). That
row is now excluded by the worker, so the run fails earlier, on counts and
excluded counts, as well as on the full-row comparison of the other
columns.

## 6. Tests (written first; red evidence in `red/`)

| Id | File | What |
|---|---|---|
| U1 | `src/ingest/focus/provider.test.ts` | allowlist contents (frozen, exact), type resolution per (kind, layout), unknown kind / layout ⇒ null; `checkProviderName`: allowed ⇒ ok, each foreign provider ⇒ `PROVIDER_MISMATCH` (exclude), case variants / whitespace / `Amazon Web Services` / prefixes ⇒ mismatch, NULL ⇒ `MISSING_VALUE` (not exclude), the message never contains the cell value; `checkProviderHeader` |
| D1 | `src/ingest/worker/providerCheck.db.test.ts` | a mixed file (AWS + Microsoft + Oracle) on an `aws-data-exports` source: published, `excludedRows`, exactly the AWS rows published (multiset), exactly the foreign row ordinals stored as `PROVIDER_MISMATCH`, `validation_error_count` |
| D2 | 〃 | every row foreign ⇒ quarantined `PROVIDER_MISMATCH`, nothing published, the prior publication of the period untouched; re-sync ⇒ `BATCH_QUARANTINED` |
| D3 | 〃 | an empty `ProviderName` ⇒ whole batch quarantined `VALIDATION_FAILED` (`MISSING_VALUE`, column `ProviderName`); the header without `ProviderName` ⇒ `MISSING_REQUIRED_COLUMN` |
| D4 | 〃 | exact match end to end: `aws` ⇒ excluded |
| D5 | 〃 | mismatch + a hard error ⇒ quarantined `VALIDATION_FAILED`, `validation_error_count` = both |
| D6 | 〃 | mixed file + a set-level control counting every row ⇒ `RECONCILIATION_VARIANCE` |
| D7 | 〃 | the `fake` type rejects `AWS` |
| A-tests | `scripts/local/acceptance.test.mjs`, `scripts/acceptance/*` | calculator `--provider` (exact, NULL counted as excluded), the new sync / re-sync / catalog / artifact-set checks with their exact problem lists, A9 static wiring (`--provider AWS` passed) |

Slice 0/1 tests are not modified.

## 7. Mutations (must each fail a test)

| Id | Mutation | Expected killer |
|---|---|---|
| M1 | check disabled (`providerPolicyFor` returns null) | D1, D2, D3, D4 |
| M2 | NULL accepted (`checkProviderName(null)` ⇒ ok) | U1, D3 |
| M3 | case-insensitive match | U1, D4 |
| M4 | loose match (trim / prefix: `startsWith`) | U1 |
| M5 | mismatch excluded but all-foreign batch published as zero rows / `EMPTY_BATCH` | D2 |
| M6 | exclusion not counted in `validation_error_count` | D1 |

## 8. Decisions for the orchestrator

- **D1: `SyntheticCloud` is on the `aws-data-exports` allowlist.** The
  project's synthetic fixture (`syntheticFocus.ts`, `testing/focusCsv.ts`)
  writes `ProviderName = SyntheticCloud`. It is staged in the AWS Data
  Exports layout and ingested through `focus_file` sources in Slice 1 tests
  (`s3Source.db.test.ts`, `cliWorker.db.test.ts`, `demo.db.test.ts`,
  `maxRunListing.db.test.ts`), by `replay-fixtures`, and by `local:test`.
  Excluding it would quarantine all of them, and Slice 0/1 tests must not
  change.
  - Security delta: none for real providers. Every real provider name is
    still rejected. A tamperer could equally write `AWS`, so this check is
    a misrouting control, not an anti-tamper control.
  - The cleaner alternative: an explicit source-config marker for synthetic
    sources (e.g. `"synthetic": true`), with `AWS` alone on the AWS type.
    It needs edits to those Slice 1 tests (and `replayFixtures.ts`,
    `local.mjs`).
- **D2: NULL ⇒ whole-batch quarantine** (§3), despite AWS's documented
  conformance gap. Alternative: allow it with a flag.
- **D3: mismatch ⇒ row exclusion and publish the rest** (§2.2), as briefed.
  Alternative: whole-batch quarantine (one line). Also, this requires that
  manifest controls covering foreign rows quarantine (D6).
- **D4: unrecognised source types are not checked.** `focus_file` without
  `layout: aws-data-exports` cannot reach the data through the CLI (the
  factory refuses it first). It is reachable only by injecting a
  `FocusSource` through the library API, which is what about a hundred
  Slice 1 tests do (`config: {}`). Fail-closed for unrecognised types would
  break them.
- **D5: `Amazon Web Services` not allowed** (§2.1), pending a real export.

## 9. Rollback

Revert the branch. No migration, no data change. Published batches with
exclusion errors stay readable; they are ordinary published batches.
