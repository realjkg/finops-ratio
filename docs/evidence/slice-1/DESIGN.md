# Slice 1 — Trusted FOCUS ingestion worker: design note

Branch `slice/01-focus-ingestion-worker`, based on `origin/slice/00-postgres-foundation`
(PR #44, 2866556). One concern: **source → published facts**. Built for local +
ephemeral integration only (BOUNDARY v2). Nothing under `pages/`, no `/api`
route, no UI changes.

Precedence applied: BOUNDARY v2 (D1–D7, 8 owner checks) > "Slice 1 additions
required by the deployment pipeline" > Delegated decision policy / Orchestrator
charter > original Slice 1 text. `LocalFileFocusSource` is DROPPED (D2).

## 1. Components (all server-only, `src/ingest/**`)

| Path | Purpose |
|---|---|
| `config.ts` | One typed config loader for worker commands, validated, fail-closed (`ConfigError` with a code). Also gates the test-only kill hook. |
| `errors.ts` | `IngestError(code, message, {retryable})`; codes are `^[A-Z][A-Z0-9_]*$` (fit `sync_runs.error_code`). |
| `redact.ts` | Redactor for anything persisted in `error_detail` or logged. |
| `log.ts` | Structured JSON-lines logger (stderr for worker commands), redacted, never row contents. |
| `retry.ts` | Bounded exponential backoff + full jitter; transient/permanent classifier. |
| `evidenceRecord.ts` | Machine-readable evidence record for every command. |
| `focus/decimal.ts`, `focus/timestamp.ts`, `focus/columns.ts`, `focus/validate.ts` | Pure FOCUS header/row validation and fact mapping (money stays a string). |
| `sources/types.ts` | `FocusSource`, `PeriodListing`, `PeriodArtifactSet`, `ArtifactRef`. |
| `sources/s3/layout.ts` | Pure AWS Data Exports layout logic: period prefixes, manifest parsing, key confinement. |
| `sources/s3/S3FocusExportSource.ts` | The ONE real source (D2), `@aws-sdk/client-s3`, path-style, endpoint from env. |
| `sources/fake/FakeFocusSource.ts` | Deterministic in-memory source for tests; CLI refuses it unless `RATIO_ALLOW_FAKE_SOURCE=1` AND `NODE_ENV=test`. |
| `evidence/*` | `EvidenceStore` interface; `S3EvidenceStore` (D6); `MemoryEvidenceStore` (tests). |
| `worker/db.ts` | Worker pool + startup role-safety check. |
| `worker/lease.ts` | Run acquisition (advisory xact lock + claim), heartbeat, fencing, finish. |
| `worker/capture.ts` | Raw evidence first: source bytes → temp file (sha256 + size, byte cap) → content-addressed evidence object. |
| `worker/load.ts` | Parse ONLY the evidence copy (re-hash while parsing), gunzip, `csv-parse`, validate, chunked `unnest` inserts into a staged batch. |
| `worker/publish.ts` | Fenced quarantine / reconcile / publish transactions, failure-injection hook points. |
| `worker/pipeline.ts` | `runSync` (sync / backfill / replay --period) orchestration, retries, checkpoint. |
| `worker/replay.ts` | `replay --batch` (re-point a period at a retained batch). |
| `worker/quarantine.ts` | `quarantine show`. |
| `worker/doctor.ts` | Read-only health checks. |
| `worker/replayFixtures.ts` | Deterministic fixture scenarios against an isolated tenant (staging/test only). |
| `fixtures/syntheticFocus.ts` | Deterministic synthetic FOCUS 1.0 export generator (BigInt money, no floats). |
| `cli.ts` | Adds `sync`, `backfill`, `replay`, `quarantine show`, `doctor`, `replay-fixtures` to the existing `migrate`. |

Repo-level: `scripts/generate-focus-fixture.ts` (writes the committed fixture),
`fixtures/focus-1.0-synthetic/**` (committed CSV.gz + manifests + README +
`control-totals.json`). `worker:build` additionally writes
`dist-worker/build-info.json` (git SHA). `.obvious/skills/ingestion-ops/SKILL.md`.

New dependencies (all on the allowed list): `@aws-sdk/client-s3` (runtime),
`csv-parse` (runtime), `tsx` (dev; used only by the SIGKILL test to spawn the
CLI from source). No other dependency.

## 2. Schema deltas

**No Slice 1 migration.** (One grant Slice 1 needs — `UPDATE (row_count)` on
`ingest_artifacts` for `ratio_worker` — was added to the amended 0001 on the
Slice 0 branch at the orchestrator's decision, see §14.) Slice 0's schema already carries D4–D6 (`quarantined`,
`ingest_validation_errors`, `evidence_key`, definer-rights view). No `0002`
migration is added. Consequences:
- Worker code runs against the current (and only) schema version 0001; the
  "previous schema" rule is satisfied trivially and tested by running a sync
  on a database migrated with exactly the shipped files.
- Things I would otherwise have put in columns go in existing jsonb:
  manifest evidence sha256s and retries in `sync_runs.stats`; listing
  fingerprint / pin in `source_checkpoints.periods`.
- `doctor`'s migration-version check needs to read `public.schema_migrations`,
  which `ratio_worker` cannot. Rather than add a GRANT (a role-privilege change,
  which would also force edits to five Slice 0 tests that hard-code `0001` as
  the only migration), doctor uses `RATIO_MIGRATE_DATABASE_URL` for that one
  check inside a `READ ONLY` transaction; if the variable is unset and the
  worker login cannot read the ledger, the check FAILS (never skipped).
  Escalated as an owner decision (grant vs. credential), see §11.

`source_checkpoints.periods` value shape (per billing period key `YYYY-MM-01`):
`{ "fingerprint": <artifact_set sha256>, "listing": <listing sha256|null>,
"batchId": <uuid>, "pinned": <bool> }`. A legacy plain-string value (Slice 0
fixture shape) is read as `{fingerprint: <string>}`.

## 3. Source contract (D2) and AWS Data Exports layout

```ts
interface FocusSource {
  readonly kind: 'focus_file' | 'fake';
  listPeriods(range?: { from: string; to: string }): Promise<PeriodListing[]>;
  openArtifact(ref: ArtifactRef): Promise<Readable>;   // raw bytes
}
type PeriodListing =
  | { ok: true; set: PeriodArtifactSet }
  | { ok: false; billingPeriod: string; code: string; message: string; manifest?: ManifestBytes };
interface PeriodArtifactSet {
  billingPeriod: string;              // 'YYYY-MM-01'
  artifacts: ArtifactRef[];           // { name, key, byteSize, version }
  control?: { rowCount?: number; billedTotal?: string; artifactRowCounts?: Record<string, number> };
  listingFingerprint: string;         // sha256(manifest bytes + sorted key|version|size)
  manifest?: ManifestBytes;           // stored as evidence too
}
```
Deviations from the brief's interface (required by D6 / correctness):
- `openArtifact` returns **raw bytes**, not rows: D6 forbids parsing the
  source; only the evidence copy is parsed.
- `ArtifactRef.fingerprint` (sha256 of bytes) cannot be known from an S3
  listing without downloading. The sha256 is computed during evidence capture;
  the ref carries an opaque `version` (S3 ETag) used only for the cheap
  listing fingerprint that lets incremental sync skip unchanged periods
  without downloading.
- `isProvisional` is decided by the worker from the database clock
  (`billing_period >= date_trunc('month', now() at UTC)`), one source of truth.

S3 layout (config: bucket, prefix, exportName in `sources.config`; endpoint,
region, credentials in env):
- data: `<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/<runId>/*.csv.gz`
- manifest: `<prefix>/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/*Manifest.json`
- periods discovered by listing `metadata/` common prefixes, filtered by range.
- Exactly one `*Manifest.json` per period, else the period fails
  (`MANIFEST_MISSING` / `MANIFEST_AMBIGUOUS`) — fail closed instead of guessing.
- Manifest fields used: `dataFiles` (required; `s3://bucket/key` URIs or
  bucket-relative keys, string or `{key|uri, rowCount?}`), `billingPeriod`
  (optional; if present must match the folder), optional Ratio extension
  `x-ratio-control: { rowCount, billedTotal }` (synthetic fixtures / operator
  supplied). Real AWS manifests carry no control totals as far as the public
  docs show → `reconciliation = 'unverified'`. (Known gap: not yet checked
  against a real export.)
- Confinement: every data file must be in the configured bucket, under
  `<prefix>/<exportName>/data/BILLING_PERIOD=<same period>/`, with no `.`/`..`
  /empty segments, no `?`/`#`, and must exist in the data listing; otherwise
  `MANIFEST_INVALID` (this replaces the dropped local path-traversal tests).
- Formats: `.csv.gz` (gunzip) and `.csv`; anything else (e.g. `.parquet`) is
  captured as evidence and the batch quarantined `UNSUPPORTED_FORMAT`.

## 4. Data flow per period (sync / backfill / replay --period)

1. **Acquire** (one transaction, tenant set): `pg_advisory_xact_lock(hashtextextended('ratio.sync:<tenant>:<source>',0))`;
   look at the `running` run of the source `FOR UPDATE`: live lease ⇒ refuse
   `ALREADY_RUNNING` (exit 4); expired ⇒ mark `abandoned` (`LEASE_EXPIRED`).
   **Then delete every `staged` batch of the source** (facts, validation errors,
   artifact rows, batch). Insert the new `running` run with a random
   `lease_token` and `lease_expires_at = clock_timestamp() + ttl`.
   Decision (rule 7 "choose one"): staged batches of dead runs are **deleted
   at the next acquisition** — deterministic, never published; their raw
   evidence objects remain.
2. **List** the source. Listing failure for a period ⇒ period `failed` with the
   code; manifest bytes (if any) still stored as evidence.
3. **Skip** (incremental `sync` only): checkpoint entry `pinned` ⇒
   `skipped_pinned`; `listing` equal ⇒ `skipped_unchanged` (no download).
   `backfill` respects pins but ignores the listing skip; `replay --period`
   ignores both and clears the pin.
4. **Size gate** from the listing: artifact count, per-artifact bytes, total
   bytes > limits ⇒ period `failed` `ARTIFACT_SET_TOO_LARGE` (nothing
   downloaded, so no fingerprint/batch can exist).
5. **Raw evidence first (D6)**: each artifact streams source → sha256 + byte
   counter (hard cap) → temp file → `PUT evidence/<tenant>/<source>/<sha256>`
   (HEAD first: same size ⇒ already there, idempotent; different size ⇒
   `EVIDENCE_CONFLICT`). Manifest bytes likewise. Temp files removed in
   `finally`.
6. **Fingerprint** = sha256 of the sorted artifact sha256s joined by `\n`.
7. **Existing batch** for (source, period, fingerprint):
   - `published` ⇒ `unchanged` (if the listing carries a control that now
     disagrees with the stored batch ⇒ period `failed` `CONTROL_VARIANCE_ON_UNCHANGED`;
     otherwise checkpoint refreshed, fenced);
   - `superseded` ⇒ provider reverted to an earlier artifact set ⇒ re-point
     (fenced publish of the retained batch) ⇒ `republished`;
   - `quarantined` ⇒ deterministic result ⇒ period `failed` `BATCH_QUARANTINED`
     (checkpoint not advanced);
   - `staged` (only possible from this run's previous attempt) ⇒ discarded, reload.
8. **Stage** (fenced txn): batch `staged` + `ingest_artifacts` rows
   (`evidence_key` per D6), control values, `is_provisional`.
9. **Pre-checks** ⇒ quarantine: empty artifact set (`EMPTY_ARTIFACT_SET`),
   byte-identical duplicate artifacts in one set (`DUPLICATE_ARTIFACT`, fail
   closed — row identity is per artifact), unsupported format.
10. **Load** from the evidence copy only: re-hash while reading (mismatch ⇒
    `EVIDENCE_INTEGRITY`, run fails, batch never published), gunzip,
    `csv-parse` (raw arrays, `bom`, strict column count, record-size cap),
    header check, row validation, inserts of valid rows in chunks (default
    1000) via one `INSERT … SELECT … FROM unnest($n::numeric[], …)` per chunk,
    each chunk its own transaction that first verifies the lease
    (`FOR SHARE`). After the first validation error no more facts are
    inserted, but validation continues to count errors. Row cap ⇒
    `ROW_LIMIT_EXCEEDED` (stop). Heartbeat between chunks when half the TTL
    has elapsed.
11. **Quarantine** (fenced txn) if any error: first ≤1000 errors stored in
    `ingest_validation_errors`, `validation_error_count` = total,
    `quarantine_reason` = summary (codes + counts, no cell values), the
    batch's facts deleted. Evidence and errors retained.
12. **Reconcile** in Postgres: `count(*)`, `sum(billed_cost)`,
    `count(DISTINCT billing_currency)`; loaded count must equal parsed count
    (else `INTERNAL_COUNT_MISMATCH`, run fails). >1 currency ⇒ quarantine
    `MIXED_BILLING_CURRENCY` (a single billed total is meaningless otherwise).
    Control present ⇒ exact compare `sum = $control::numeric` and row counts
    (set and per artifact) ⇒ any disagreement ⇒ quarantine, stored as
    `reconciliation='variance'` when a set-level control exists. Agreement ⇒
    `reconciled` when at least one set-level control (row count or billed
    total) exists — the amended 0001 CHECK (supersedes §13.4) — else
    `unverified`. Per-artifact counts covering every artifact define the
    set-level control row count. Zero rows ⇒
    quarantine `EMPTY_BATCH` (publishing zero would silently erase a period).
13. **Publish** (ONE transaction, each step a hook point for failure
    injection): `lock_run` (fencing: `id`, `lease_token`, `status='running'`,
    `lease_expires_at > clock_timestamp()`, `FOR UPDATE`) → `lock_period`
    (`period_publications` row `FOR UPDATE`) → `supersede_prior` →
    `mark_published` → `upsert_publication` → `advance_checkpoint` → `commit`.
    Any failure ⇒ ROLLBACK ⇒ nothing visible changes.
14. **Finish** run: `succeeded` iff every period ended in
    {published, republished, unchanged, skipped_unchanged, skipped_pinned};
    otherwise `failed` with the first failure's code and a redacted summary.
    Finishing is conditioned on the lease token and `status='running'`, so a
    taken-over zombie cannot overwrite the new run's state.

Retries (rule 8): each period is retried on transient errors only (pg class
08/53/57P0x, 40001, 40P01, socket errors, S3 5xx/throttling/`$retryable`),
backoff `min(cap, base·2^(n-1))` with full jitter, up to
`RATIO_MAX_ATTEMPTS` (default 3). Each retry bumps `sync_runs.attempt` and
appends `{attempt, code, period, at}` to `stats.retries` (fenced). Validation,
lease, config and integrity errors are permanent.

Money: never a JS number. CSV cells are validated by regex and passed as
strings to `numeric[]`; sums and comparisons happen in Postgres; `pg` returns
numeric/bigint as strings. The fixture generator uses BigInt.

## 5. CLI / API effects

No HTTP surface. New CLI commands (`node dist-worker/ingest/cli.js …`):

| Command | Notes |
|---|---|
| `sync --tenant <uuid> --source <key>` | incremental, run_kind `scheduled` |
| `backfill --tenant <uuid> --source <key> --from YYYY-MM --to YYYY-MM` | run_kind `backfill`, period_from/to recorded |
| `replay --tenant <uuid> --source <key> --batch <uuid>` | rollback / roll-forward: re-point the period at a retained `published`/`superseded` batch, fenced + atomic; pins the period |
| `replay --tenant <uuid> --source <key> --period YYYY-MM` | re-ingest from source, ignores checkpoint, clears the pin |
| `quarantine show --tenant <uuid> --batch <uuid> --json` | batch, artifacts (sha256, size, evidence key), stored errors |
| `doctor --json [--tenant <uuid>]…` | read-only; exit 0 all pass, 1 any failure |
| `replay-fixtures --json` | refuses unless `RATIO_ENV` ∈ {staging, test}; fresh retained fixture tenant per run (§14) |

Every new command prints exactly one evidence record (JSON) on stdout and
structured logs on stderr. Evidence record:
`{type:"ratio.evidence", version:1, command, args, gitSha, artifactDigest,
startedAt, finishedAt, durationMs, results, pass, exitCode}`; `gitSha` from
`RATIO_GIT_SHA` → `build-info.json` → `git rev-parse` → null;
`artifactDigest` from `RATIO_ARTIFACT_DIGEST` (`sha256:<64 hex>` or refused).
If `RATIO_EVIDENCE_FILE` is set, the record is also appended there (JSONL) —
for every command including `migrate`, whose stdout/stderr contract from
Slice 0 is kept byte-compatible (its record goes only to the file).

Exit codes: 0 ok · 1 failure (incl. quarantine) · 2 usage/config · 3 migrate
status mismatch (Slice 0) · 4 another run holds the lease.

Configuration (env; names only, no values in code):
`RATIO_DATABASE_URL` (worker login), `RATIO_MIGRATE_DATABASE_URL` (migrate,
doctor ledger check, replay-fixtures tenant setup/teardown), `RATIO_ENV`,
`RATIO_SOURCE_S3_{ENDPOINT,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY,SESSION_TOKEN,FORCE_PATH_STYLE}`,
`RATIO_EVIDENCE_S3_{ENDPOINT,REGION,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY,SESSION_TOKEN,FORCE_PATH_STYLE}`,
`RATIO_LEASE_TTL_SECONDS` (default 300, 5..3600), `RATIO_MAX_ATTEMPTS` (3, 1..10),
`RATIO_RETRY_BASE_MS` (500), `RATIO_RETRY_MAX_MS` (30000),
`RATIO_INSERT_CHUNK_ROWS` (1000, 1..5000), `RATIO_MAX_ROWS_PER_BATCH`
(20,000,000), `RATIO_MAX_ARTIFACT_BYTES` (5 GiB), `RATIO_MAX_BATCH_BYTES`
(20 GiB), `RATIO_MAX_ARTIFACTS_PER_SET` (1000), `RATIO_TMP_DIR`,
`RATIO_DOCTOR_MAX_STALENESS_HOURS` (48), `RATIO_REPLAY_FIXTURES_BUCKET`,
`RATIO_GIT_SHA`, `RATIO_ARTIFACT_DIGEST`, `RATIO_EVIDENCE_FILE`,
`RATIO_ALLOW_FAKE_SOURCE` (+`NODE_ENV=test`), `RATIO_TEST_PAUSE_AFTER_ROWS`
(test only). Missing S3 access key ⇒ SDK default credential chain. Plain
`http://` endpoints are refused when `RATIO_ENV=production`. Endpoints with
userinfo, query or fragment are refused.

`sources.config` for `kind='focus_file'`:
`{"layout":"aws-data-exports","bucket":"…","prefix":"…","exportName":"…"}`
(non-secret; Slice 0 CHECK still rejects secret-looking keys). Tenants and
sources are provisioned by an operator as the owner (SQL in the ops skill);
the worker role cannot create them (Slice 0 grants unchanged).

## 6. Worker authorization (rule 12)

At startup every DB command (except `migrate`) runs, on the worker
connection: refuse (`UNSAFE_DB_ROLE`, exit 1, before any work) if
`current_user` or `session_user` is superuser or BYPASSRLS, if it is a member
of any superuser/BYPASSRLS role, if it is a member of `ratio_owner` (owner can
disable RLS), or if it is NOT a member of `ratio_worker`. Tenant comes from
`--tenant`, is UUID-validated and set per transaction with
`set_config('ratio.tenant_id', $1, true)` (Slice 0 `withTenantTransaction`).

## 7. Threat model

| Threat | Control | Test |
|---|---|---|
| Tenant A worker reads/writes B (source key, batch id, quarantine show, replay) | every query inside a tenant txn; RLS forced; ids looked up under RLS ⇒ `NOT_FOUND`; evidence keys derived from (tenant, source) of RLS-visible rows | tenant-escape tests (CLI + library) |
| Worker started as superuser/BYPASSRLS/owner (RLS bypass) | startup role check | auth tests incl. real LOGIN roles |
| Reader sees staged/quarantined/superseded data | Slice 0 view + grants; publish only via fenced txn | demo check 7 |
| Double counting after restatement | period supersession, one pointer per period, one published batch per period | restatement + duplicate tests |
| Silent undercount from dedupe | row identity (artifact sha256, ordinal); no content hash | duplicate legit rows test |
| Partial publication | single publish txn, hook-injected failure at every step | partial-publication matrix |
| Crash mid-load exposes partial data | staged batch invisible; SIGKILL child test | demo check 5/6 |
| Zombie worker publishes after takeover | lease fencing in publish/quarantine/chunk/heartbeat/finish | zombie tests |
| Manifest points outside the export (other bucket / traversal / other period) | key confinement + must exist in listing | layout unit + S3 tests |
| Tampered/corrupted evidence | content-addressed key, re-hash on parse | evidence integrity test |
| Secrets in DB/logs (URLs, signatures, keys, passwords) | redactor on `error_detail` + logs; no secret config keys; artifact names reject `?#` | redaction tests, CLI leak test |
| Row contents leaking to logs/errors | messages never include cell values; csv-parse messages replaced by code + record number | log/quarantine content test |
| Float money corruption | strings → numeric; Postgres sums; BigInt generator | precision + fixture tests |
| Resource exhaustion (huge file, huge record) | byte caps (listing + streaming), row cap, record-size cap, chunked inserts, streaming parse | oversize + 200k streaming tests |
| Fake data presented as real | fake source refused outside `NODE_ENV=test`+flag; fixture labelled SYNTHETIC | CLI test |
| Test kill hook enabled in prod | hook only honoured with `NODE_ENV=test`; set otherwise ⇒ refuse to start | config test |
| replay-fixtures run against production | refused unless `RATIO_ENV` ∈ {staging,test}, checked before connecting | CLI test |

## 8. Failure cases (D7: checkpoint not advanced; staged never published; evidence + error retained; last accepted revision stays readable; bounded retries; invalid data quarantined)

| Failure | Outcome |
|---|---|
| DB down at start | exit 1, nothing written |
| Another live run | exit 4 `ALREADY_RUNNING`, nothing written |
| Manifest missing/ambiguous/invalid/outside export | period failed, run failed, checkpoint untouched, manifest evidence stored |
| S3 read error (transient) | retried with backoff, attempts visible; exhausted ⇒ period failed |
| Oversize | `ARTIFACT_SET_TOO_LARGE` (listing) / `ARTIFACT_TOO_LARGE` (stream) ⇒ failed; `ROW_LIMIT_EXCEEDED` ⇒ quarantined |
| Bad header/row/number/date/period/currency, CSV syntax, bad gzip, parquet, empty set, zero rows, mixed currency | batch quarantined with inspectable errors, prior publication untouched |
| Control mismatch | quarantined, `reconciliation='variance'`, prior publication untouched |
| Evidence hash mismatch on re-read | run failed `EVIDENCE_INTEGRITY`, batch staged (deleted at next acquire) |
| Error inside publish txn | rollback; view unchanged; run failed |
| Lease lost (takeover/expiry) | `LEASE_LOST`; no publish/quarantine/finish by the zombie |
| Process killed (SIGKILL) | run stays `running` until lease expiry; restart before expiry ⇒ exit 4 (visible, nothing changes); after expiry ⇒ abandoned, staged batch deleted, clean reload ⇒ identical result |

## 9. Rollback / replay plan

- **Data rollback**: `replay --batch <superseded batch>` re-points the period
  (fenced, atomic) and pins it so scheduled syncs don't undo it;
  `replay --batch <newer>` rolls forward; `replay --period YYYY-MM` re-ingests
  from the source and unpins. Superseded batches and all evidence are
  retained (no deletion code in this cycle).
- **Code rollback**: branch unmerged; no schema change, so reverting the code
  needs no DB action. Ingested rows remain in `ratio.*` (dev/test: Slice 0
  `migrate --down 1` drops the schema; production: owner decision).

## 10. Decisions (delegated policy) — see report for the full list

D-a staged batches of dead runs deleted at next acquisition. D-b checkpoint
skip via listing fingerprint, plus pins for rollback. D-c exactly one manifest
per period, else fail. D-d `x-ratio-control` extension for control totals.
D-e facts of quarantined batches deleted (evidence + errors retained).
D-f zero-row batch and mixed currency quarantined. D-g duplicate byte-identical
artifacts in one set quarantined. D-h no schema migration; doctor ledger check
via owner URL in a read-only txn. D-i offset-less timestamps interpreted as UTC
(FOCUS mandates UTC). D-j source location (bucket/prefix/exportName) in
`sources.config`; endpoint/region/credentials in env. D-k CI: the existing
`test:db` step gets a SeaweedFS container (S3 tests fail, not skip, without
`RATIO_TEST_S3_ENDPOINT`). D-l replay-fixtures leaves evidence objects of the
fixture tenant (no evidence deletion code, per D6).

## 11. Escalations / owner decisions

- Doctor's ledger access: owner URL (current) vs. `GRANT SELECT ON
  public.schema_migrations TO ratio_worker` (role change ⇒ owner).
- Evidence retention: content-addressed evidence is kept indefinitely (no
  deletion code) — including replay-fixtures runs in staging. Retention window
  is an owner decision.
- CI workflow edit (SeaweedFS container in the existing job) — high-risk area.
- Real AWS manifest/control semantics unverified — manual acceptance run
  (NOT YET PERFORMED) required before calling the ingestion layer usable.

## 12. Known gaps (initial)

Manifest format not verified against a real AWS export; per-execution
manifests (more than one per period) are refused rather than resolved;
no cross-period checks of ChargePeriodStart; quarantined batches with
identical bytes are not re-validated after a code fix (needs new bytes or an
operator procedure); temp files of a SIGKILLed process are not cleaned
automatically (under `RATIO_TMP_DIR`); evidence objects are never deleted;
`currency` sums across a period are per batch only.

## 13. Slice 0 amendment rules (orchestrator heads-up, received while writing tests)

Migration 0001 is being amended on `slice/00-postgres-foundation`; Slice 1 is
written to these rules so the later merge is clean:
1. facts / artifacts / validation errors are written (and facts deleted) only
   while the batch is `staged`: quarantine = insert errors + delete facts while
   staged, THEN `staged→quarantined` in the same transaction; staged-batch
   cleanup at acquisition deletes children while the batch is still staged.
2. Transitions used: staged→published, staged→quarantined,
   published→superseded, superseded→published (replay/rollback). Quarantined is
   terminal (never re-validated — see gaps).
3. `period_publications` must reference a `published` batch. The publish step
   order is a single exported list (`PUBLISH_STEPS`) so it can follow whatever
   the amended 0001 enforces (currently: supersede prior, mark published,
   re-point; the amended order is mark published → re-point → supersede prior,
   applied at merge time if the amended constraints require it). Tests iterate
   over `PUBLISH_STEPS`, so they follow the order.
4. (Superseded by the amended 0001 as merged, 446563e:) `reconciled` ⇔ at
   least one set-level control present and every present control matches;
   `variance` needs a set-level control; a published batch is `unverified`
   exactly when it had no control.
5. Numbers: NaN/Infinity rejected by the validator before the DB sees them.
6. Every free-text value written (error_detail, quarantine_reason, validation
   messages, stats, artifact names) passes through the redactor first;
   artifact names with credential-like content are refused by the layout
   confinement rules.
7. Tenant only via transaction-local `set_config(..., true)`; tenant comes from
   validated CLI input, never from source data.

## 14. Orchestrator decisions received during implementation

- **row_count grant**: `GRANT UPDATE (row_count) ON ratio.ingest_artifacts TO
  ratio_worker` (column-level) is added to the amended 0001 on the Slice 0
  branch; Slice 1 writes `ingest_artifacts.row_count` while the batch is
  still staged (single streaming pass; the artifact row must exist before the
  first fact chunk because of the immediate FK).
- **replay-fixtures keeps its data**: no purge/delete path this cycle. Each
  invocation creates a fresh tenant `fixture-<utc-timestamp>-<random>` (sources
  labelled SYNTHETIC), leaves its rows, evidence and synthetic source objects
  in place and records them in `results.retained`. Staging accumulates fixture
  tenants until an owner-approved retention slice. `RATIO_MIGRATE_DATABASE_URL`
  is used only to create the tenant and its sources.
- **publish order** (unchanged): fence → lock period → prior published →
  superseded → target staged/superseded → published → re-point
  period_publications → advance checkpoint, one transaction.
- Evidence prefix: `RATIO_EVIDENCE_S3_PREFIX` (optional) places evidence keys
  under a folder of a shared bucket (added because the local SeaweedFS allows
  only ~2 buckets with data; also useful for shared evidence buckets). The DB
  `evidence_key` is unchanged (`evidence/<tenant>/<source>/<sha256>`).
