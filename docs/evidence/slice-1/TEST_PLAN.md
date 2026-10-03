# Slice 1 — test plan (written and committed, failing, before the implementation)

Fast suite = `npm test` (no DB, no S3). DB suite = `npm run test:db`
(`*.db.test.ts`, real Postgres 16; tests that touch S3 also need
`RATIO_TEST_S3_ENDPOINT` and FAIL — never skip — without it). No `.skip`,
`.only`, `.todo`, `it.fails`, `skipIf`, `runIf`.

S3 isolation: the local SeaweedFS can hold data in only ~2 buckets at once
and reclaims a deleted bucket's volumes lazily, so the suite uses ONE
long-lived bucket (`ratio-s1-test`, created if missing, never deleted); the
vitest globalSetup gives each run a unique `s1-run-…` key prefix and deletes
everything under it at the end, and each test works under its own unique key
prefix inside that.

Fixtures: deterministic and synthetic only — `FakeFocusSource` (in-memory),
`MemoryEvidenceStore`, the committed synthetic AWS-layout fixture
(`fixtures/focus-1.0-synthetic`) seeded into per-test SeaweedFS buckets
(the long-lived `ratio-s1-test` bucket, a unique `s1-run-…/` prefix per run and `s1-<label>-<hex>` per test, all objects deleted after), per-file Postgres databases (Slice 0 harness), and
per-test LOGIN roles (`ratio_test_login_…`, dropped after).

## A. Fast suite

| ID | File | Test |
|---|---|---|
| F1 | `redact.test.ts` | URL query strings, `Bearer …`, `sig=`/`X-Amz-Signature`/`X-Amz-Credential`/`X-Amz-Security-Token`, AWS access key ids (AKIA/ASIA), secret-key-looking 40-char tokens after key names, `postgres://user:pass@`, `password=`, literal configured secrets are all removed; output capped at 4000 chars; benign text unchanged |
| F2 | `retry.test.ts` | backoff = full jitter within `[0, min(cap, base·2^(n-1))]`; permanent error not retried; transient retried up to maxAttempts then rethrown; onRetry observes each retry; classifier: pg 08xxx/57P01/40001/40P01/53xxx, ECONNRESET/ECONNREFUSED/ETIMEDOUT, S3 5xx/`$retryable` ⇒ transient; validation/23xxx/42501/IngestError(non-retryable) ⇒ permanent |
| F3 | `focus/validate.test.ts` | decimal acceptance/rejection matrix (rejects NaN, Infinity, `1,000`, `0x10`, empty for required, huge exponent); money never converted to number (fact field is the original string); timestamp matrix (Z, offsets, fractional, offset-less ⇒ UTC, invalid calendar dates rejected); required columns missing ⇒ one error per column; duplicate header ⇒ error; BillingPeriodStart ≠ folder period ⇒ `PERIOD_MISMATCH`; ChargePeriodEnd < Start ⇒ error; currency must be `^[A-Z]{3}$`; FOCUS 1.0 `ConsumedQuantity` and 0.5 `UsageQuantity` both map; unmapped non-empty columns go to extra_columns; messages never contain cell values |
| F4 | `sources/s3/layout.test.ts` | period prefix parse (`BILLING_PERIOD=YYYY-MM/`), range filter; manifest parse (strings, objects, s3 URIs, relative keys); refuses other bucket, `..`/`.`/empty segments, `?`/`#`, other period's folder, outside `<prefix>/<exportName>/data/`; not-in-listing ⇒ invalid; `billingPeriod` mismatch ⇒ invalid; `x-ratio-control` validation (non-integer row count, non-decimal total refused); listing fingerprint stable under reordering and changes with ETag/size/manifest bytes; artifact format classification (csv.gz, csv, parquet ⇒ unsupported) |
| F5 | `config.test.ts` | defaults; out-of-range numbers refused; `RATIO_TEST_PAUSE_AFTER_ROWS` refused unless `NODE_ENV=test`; fake source allowed only with flag AND `NODE_ENV=test`; endpoint with credentials/query refused; `http://` endpoint refused when `RATIO_ENV=production`; `RATIO_ARTIFACT_DIGEST` format enforced |
| F6 | `evidenceRecord.test.ts` | record shape (type, version, command, gitSha, artifactDigest, timestamps, pass, exitCode); git SHA precedence (env > build-info > null); record is redacted |
| F7 | `fixtures/syntheticFocus.test.ts` | generator deterministic; money exact (BigInt, no floats); includes duplicate legitimate rows (same file and across files); restatement variant differs only in intended rows; committed fixture files (gunzipped CSV + manifests) equal generator output; `control-totals.json` and README totals equal the generator's totals; every CSV row says SyntheticCloud (not presented as real) |
| F8 | `cli.worker.test.ts` | new commands: usage errors exit 2 (missing --tenant/--source, bad uuid, bad period, --from > --to, both --batch and --period); `replay-fixtures` refused unless RATIO_ENV ∈ {staging,test} before connecting; missing RATIO_DATABASE_URL exits 2; kill hook outside test env refused; DB URL/password never echoed; evidence record emitted on failure too |
| F9 | `importBoundary.test.ts` (existing) | still passes; no page/src module imports src/ingest, pg or @aws-sdk |

## B. DB suite — worker library (FakeFocusSource + MemoryEvidenceStore unless noted)

`src/ingest/worker/*.db.test.ts`

| ID | File | Test | Brief requirement |
|---|---|---|---|
| W1 | `sync.db.test.ts` | clean load ⇒ batch published, view rows = input rows, totals exact, artifacts recorded with sha256/evidence_key, evidence bytes re-hash to sha256, checkpoint has fingerprint | staged→published |
| W2 | 〃 | idempotency: same input twice ⇒ one batch, identical published totals, second run outcome `skipped_unchanged`; backfill of same range ⇒ `unchanged` | idempotency |
| W3 | 〃 | duplicate legitimate rows (same file and across two files) are all stored and summed | dup legit rows |
| W4 | 〃 | restatement: new artifact set for the period ⇒ new batch published, old `superseded`, view shows only new rows (no double count), checkpoint fingerprint updated | supersession |
| W5 | 〃 | provider reverts to earlier artifact set ⇒ superseded batch re-published, no new batch | supersession |
| W6 | 〃 | reconciliation match ⇒ `reconciled` + published | reconciliation |
| W7 | 〃 | control mismatch (rows / billed total / per-artifact rows) ⇒ quarantined `variance`, prior publication untouched, checkpoint not advanced | reconciliation |
| W8 | 〃 | no control ⇒ `unverified` + published; a row-count-only agreeing control ⇒ `reconciled` (amended 0001 rule) | reconciliation |
| W7b* | 〃 | per-artifact count for only some artifacts that disagrees ⇒ quarantined, reconciliation stays `unverified` (no set-level control) | reconciliation |
| W7c* | 〃 | per-artifact counts covering every artifact become `control_row_count` ⇒ `reconciled` | reconciliation |
| W9 | 〃 | bad-input matrix, each ⇒ quarantined, nothing published, prior publication untouched, validation errors inspectable, no facts retained: missing each required column; unparseable BilledCost; NaN; unparseable date; impossible date; BillingPeriodStart of another period; ChargePeriodEnd < Start; bad currency; inconsistent column count (CSV error); invalid gzip; parquet; empty artifact set; zero data rows; mixed currencies; duplicate byte-identical artifacts; row limit | bad input |
| W10 | 〃 | oversize artifact (listing bytes > limit) ⇒ period failed `ARTIFACT_SET_TOO_LARGE`, nothing captured, checkpoint not advanced | bad input |
| W11 | 〃 | validation errors capped at 1000 stored, `validation_error_count` = true total; quarantine show returns them | D5 |
| W12 | 〃 | provisional flag: current month ⇒ true, previous month ⇒ false | rule 11 |
| W13 | 〃 | incremental: unchanged period skipped without opening artifacts; changed period processed; backfill range processes only periods in range | checkpoints/backfill |
| W14 | 〃 | listing failure for a period ⇒ run failed, other periods still processed, checkpoint for the failed period not advanced | D7 |
| W15 | 〃 | control changed but bytes identical ⇒ failed `CONTROL_VARIANCE_ON_UNCHANGED`, publication untouched | reconciliation |
| W16 | 〃 | worker runs against the shipped schema version (migrated with exactly the shipped files) | expand/contract |
| P1 | `publish.db.test.ts` | failure injected at each publish step (lock_run, lock_period, supersede_prior, mark_published, upsert_publication, advance_checkpoint, commit) ⇒ view, batches, publications, checkpoint byte-identical to before; run failed | partial publication |
| P2 | 〃 | failure injected during quarantine txn ⇒ batch stays staged (never published), view unchanged | partial publication |
| P3 | 〃 | zombie: run A loads, pauses before publish; lease expired; run B acquires (A ⇒ abandoned), publishes; A resumes ⇒ `LEASE_LOST`, publication is B's, A cannot finish/overwrite its run row | zombie fencing |
| P4 | 〃 | zombie without takeover: A's lease expires, A tries to publish ⇒ `LEASE_LOST`; heartbeat cannot revive an expired lease | zombie fencing |
| P5 | 〃 | zombie chunk insert after takeover fails (lease checked per chunk) | zombie fencing |
| P6* | 〃 | zombie with an expired lease and NO takeover is stopped at its next chunk (isolates the per-chunk fence; added after mutation M5 survived) | zombie fencing |
| L1 | `lease.db.test.ts` | two workers start simultaneously on the same source ⇒ exactly one runs, the other `ALREADY_RUNNING`; one running row | concurrency |
| L2 | 〃 | two tenants concurrently ⇒ both succeed, each sees only its own facts | concurrency + isolation |
| L3 | 〃 | acquire after expiry marks the old run `abandoned` (`LEASE_EXPIRED`) and deletes its staged batches | crash recovery |
| L5* | 〃 | background heartbeat moves a long-running run's lease forward (polled, no fixed sleep) | leases |
| L6* | 〃 | a simulated-dead run stops heartbeating so its lease expires, then a new run recovers | crash recovery |
| L4 | `publish.db.test.ts` | heartbeat extends a live lease (and refuses a wrong token) | leases |
| C1 | `crash.db.test.ts` | in-process crash after N rows (run left `running`, staged rows exist) ⇒ view unchanged, checkpoint not advanced; restart before expiry ⇒ `ALREADY_RUNNING`; after expiry ⇒ recovery succeeds and final state (publications, totals, fact multiset) identical to a clean run in another tenant | crash/recovery |
| C2 | 〃 | transient source error retried with backoff then succeeds; attempts and retries visible in `sync_runs` | retries |
| C3 | 〃 | transient errors beyond max attempts ⇒ period failed, attempts = max, checkpoint not advanced | retries |
| C4 | 〃 | permanent error (validation) is not retried | retries |
| R1 | `replay.db.test.ts` | rollback: `replay --batch <superseded>` re-points period atomically, pins it; scheduled sync skips pinned period; `replay --batch <newer>` rolls forward | replay |
| R2 | 〃 | `replay --period` re-ingests from source (ignores checkpoint), clears pin | replay |
| R3 | 〃 | replay of a quarantined/staged batch refused; replay of another source's/tenant's batch ⇒ NOT_FOUND | replay + tenant escape |
| R4 | 〃 | replay publish failure injected ⇒ nothing changes | atomic |
| A1 | `auth.db.test.ts` | worker refuses superuser connection; refuses a LOGIN with BYPASSRLS; refuses a member of ratio_owner; refuses ratio_reader login (not a worker); accepts a ratio_worker login | authorization |
| A2 | 〃 | reader login cannot invoke worker writes (permission denied on every worker write path) | authorization |
| T1 | `tenantEscape.db.test.ts` | worker for tenant A: B's source key ⇒ SOURCE_NOT_FOUND; B's batch id via replay/quarantine show ⇒ NOT_FOUND; sync for A never changes any B row (full B snapshot equal before/after); evidence keys all under `evidence/<A>/` | tenant escape |
| T2 | 〃 | no tenant / malformed tenant ⇒ refused before any query | tenant escape |
| S1 | `streaming.db.test.ts` | 200,000-row generated gzip CSV is loaded in chunks (chunk count = ceil(rows/chunk), no chunk > chunk size) and the first chunk is inserted before the evidence stream has been fully read (proves streaming, no whole-file buffering); totals exact | streaming |
| D1 | `doctor.db.test.ts` | healthy ⇒ all checks pass, exit 0; superuser connection ⇒ role_safety fail; schema behind code ⇒ migration_version fail; last run failed / stale / never succeeded ⇒ source check fail; doctor writes nothing (row counts and pg_stat xact unchanged, read-only txn) | doctor |

## C. DB suite — S3 + CLI (real SeaweedFS)

| ID | File | Test |
|---|---|---|
| X1 | `sources/s3/s3Source.db.test.ts` | lists periods from the AWS layout, honours range, reads manifest, refuses manifest pointing to another bucket / traversal / other period / missing file, two manifests ⇒ ambiguous, no manifest ⇒ missing |
| X2 | 〃 | S3EvidenceStore: put is idempotent (second put no-op), size conflict ⇒ `EVIDENCE_CONFLICT`, object re-hashes to its key |
| X3 | 〃 | gzip CSV read end-to-end from S3 source through evidence |
| X4 | 〃 | tampered evidence object (same size, different bytes) ⇒ `EVIDENCE_INTEGRITY`, nothing published |
| X5 | 〃 | parquet artifact in manifest ⇒ evidence captured, batch quarantined `UNSUPPORTED_FORMAT` |
| K1 | `cliWorker.db.test.ts` | `sync` via CLI: evidence record on stdout (one JSON doc, pass true, results with periods), logs on stderr are JSON and contain no row contents/URL credentials; `RATIO_EVIDENCE_FILE` appended (also for `migrate`) |
| K2 | 〃 | `backfill --from --to`, `replay --batch`, `replay --period`, `quarantine show --json` via CLI |
| K3 | 〃 | fake source rejected by CLI outside test env (NODE_ENV≠test or flag missing), accepted with both |
| K4 | 〃 | CLI exit 4 when another live run holds the lease; exit 1 + redacted error_detail on S3 failure with a credential-bearing endpoint |
| K5 | 〃 | `doctor --json` exit 0 healthy, 1 unhealthy; `replay-fixtures --json` in RATIO_ENV=test, run twice: all six scenarios pass each time, each run uses a fresh tenant (slug `fixture-<utc-timestamp>-<random>`, sources labelled SYNTHETIC) whose rows and source objects are retained and reported (orchestrator decision: no deletion path) |

## D. Owner acceptance demonstration — `src/ingest/demo.db.test.ts`

Uses the COMMITTED synthetic fixture seeded into a fresh SeaweedFS bucket,
`S3FocusExportSource`, `S3EvidenceStore`, real LOGIN roles for worker and
reader, and the CLI (in-process, and as a real child process for check 5/6).

| # | Owner check | Test |
|---|---|---|
| 1 | Fixture ingested; original bytes stored with hash | `demo 1`: CLI sync; for every `ingest_artifacts` row, GET the evidence object, sha256 == row sha256 == key suffix, byte size equal, bytes equal the committed fixture file |
| 2 | Parser creates a staged revision | `demo 2`: pause hook after first chunk ⇒ batch `staged` with rows in cost_facts, invisible in the view (worker and reader) |
| 3 | Validation passes, or inspectable quarantine | `demo 3`: base fixture ⇒ reconciled + published; corrupted variant ⇒ quarantined, `quarantine show --json` lists errors with artifact sha256/row/column/code |
| 4 | Reprocessing same artifact ⇒ no duplicate published facts | `demo 4`: sync ×2 + `replay --period` + backfill ⇒ one batch per period, view totals == control totals |
| 5 | SIGKILL mid-run does not expose partial data | `demo 5`: spawn CLI child (tsx, `NODE_ENV=test`, `RATIO_TEST_PAUSE_AFTER_ROWS`), wait for the pause signal, `kill -9`; view (as reader) shows the previous publication exactly (none for a first load; prior revision for a restatement), checkpoint unchanged |
| 6 | Restart completes safely or fails visibly without advancing checkpoint | `demo 6`: restart immediately ⇒ exit 4, checkpoint unchanged; after lease expiry ⇒ exit 0, totals == control totals, crashed run `abandoned`, its staged batch gone |
| 7 | App reads latest accepted revision; staged/quarantined inaccessible to ratio_reader | `demo 7`: reader login with tenant sees exactly the published rows (restatement totals after restatement); reader gets permission denied on cost_facts / ingest_batches / ingest_validation_errors / ingest_artifacts; quarantined and staged rows never appear in the view |
| 8 | Tenant-bound access fails closed | `demo 8`: reader/worker with no tenant ⇒ 0 rows; with tenant B ⇒ none of A's rows; CLI with tenant B and A's source key ⇒ SOURCE_NOT_FOUND; malformed tenant ⇒ refused |

## E. Mapping to the brief's required test list

idempotency W2, demo 4 · duplicate legit rows W3 · restatement W4/W5, demo 7 ·
reconciliation W6–W8, W15 · bad input W9–W11, X5 · partial publication P1/P2/R4 ·
crash C1, demo 5/6 · zombie P3–P5 · concurrency L1/L2 · tenant escape T1/T2,
demo 8 · authorization A1/A2, demo 7 · replay R1–R4, K2 · backfill/incremental
W13 · redaction F1, K1, K4 · traversal/confinement F4, X1 · parquet W9, X5 ·
gzip X3 · streaming S1 · fake source CLI K3 · retries C2–C4, F2 · provisional
W12 · doctor D1, K5 · replay-fixtures K5 · evidence records F6, K1 · worker on
shipped schema W16.

`*` = added after the first red commit (each in its own test commit before
the matching fix, or driven by the amended Slice 0 schema / a mutation check);
see EVIDENCE.md §1.

## F. Challenger round 1 additions (red at cd87483, green after the fixes)

| ID | File | Test |
|---|---|---|
| M1-stream | `worker/stall.db.test.ts` | source stream that never emits ⇒ `SOURCE_STALLED` within 12 s (bounded race), run failed, checkpoint null, next sync succeeds |
| M1-open | 〃 | source open that never resolves ⇒ same |
| M1-evidence | 〃 | evidence read that never emits ⇒ `EVIDENCE_STALLED`, nothing published, next sync succeeds |
| M1-heartbeat | 〃 | a run hung without progress stops renewing; lease expires (bounded poll); another sync takes over; the hung run gets `LEASE_LOST` |
| M1-maxrun | 〃 | renewal stops past the maximum run duration even with a long stall limit |
| S3-timeout | `s3client.test.ts` | config defaults/bounds for S3 timeouts; a server that accepts but never answers ⇒ `SOURCE_LIST_FAILED` in < 4 s |
| CFG-stall / L3 | `config.test.ts` | stall/max-run defaults and bounds; test-only switches refused when `RATIO_ENV` is staging/production even with `NODE_ENV=test` |
| V-year0 / V-ctrl | `focus/validate.test.ts` | year 0000 rejected; NUL/C0 controls rejected in cells and header names, TAB/CR/LF allowed, values not echoed |
| W9 +3 | `worker/sync.db.test.ts` | year-0000 timestamp, NUL in a mapped column, NUL in an extra column ⇒ quarantined; the cell value is absent from error_detail, stats, quarantine reason, validation messages and the run result |
| M2-backstop | 〃 | a Postgres class-22 rejection (test trigger) ⇒ quarantined `DB_REJECTED_VALUE`, code-only message, value never persisted |
| M2-generic | 〃 | any other DB error ⇒ period failed `DB_<state>` with generic text only |
| K6 | `cliWorker.db.test.ts` | year-0000 and a Postgres-rejected value via the CLI: the value and pg text are absent from stdout/stderr, error_detail and stats |
| L1 | `worker/lease.db.test.ts` | acquiring source X keeps source Y's staged facts; Y then publishes |
| L2 | 〃 | an expired zombie cannot record a retry (attempt 1, no retries) |

## G. Challenger round 3 additions

| ID | File | Test |
|---|---|---|
| M3-a | `worker/stall.db.test.ts` | source trickling a chunk every 0.7 s for ~10 s (stall 3 s, TTL 5 s) succeeds; the lease is live in every sample (kills N2, N10) |
| M3-b | 〃 | evidence read trickling the same way succeeds with the lease held (kills N2 on the evidence path) |
| M3-c | 〃 | 1 s inserts (test statement trigger) + 1.6 s hook per chunk with a 2 s stall: no `EVIDENCE_STALLED` (kills N3) |
| L-c | 〃 | run past max duration while streaming aborts with `MAX_RUN_EXCEEDED` in < 5 s, attempt 1, checkpoint null, next sync succeeds |
| L-b | `worker/lease.db.test.ts` | worker sessions show lock 30 s / idle-in-tx 5 min / statement 30 min; takeover blocked by a held row lock fails `LOCK_TIMEOUT` within 10 s (lock timeout 1 s), no new run, then succeeds |
| L-b cfg | `config.test.ts` | DB session timeout defaults and bounds |
| L-e | `focus/validate.test.ts` | C1 controls and U+2028/U+2029 in header names ⇒ `INVALID_CHARACTER`; ordinary non-ASCII names accepted |

Round L-k/L-j additions: `redact.test.ts` — a worker line with a BigInt, a
Buffer and an object whose `toJSON` returns a secret is one valid, redacted
line (BigInt as exact decimal text, Buffer as `[binary]`); a value that
already holds the JSON-escaped secret form is redacted (W2). K7 also sets
`RATIO_EVIDENCE_FILE` and requires the file to equal the redacted stdout
records with no secret form, including a second-order (URL-encoded,
JSON-escaped) form passed as an argument (W4).

Redaction linearity (round after Slice 0 round-14 compat): `redactLinear.test.ts`
runs 14 adversarial inputs at 200 KB and 2 MB through `redact()` and
`jsonLineRedactorFor` in a tsx child under a hard kill (2 s per call, no
secret form survives). `cli.worker.test.ts` spawns a child wired like the
CLI entry and crashes it with a > 2 MB message (uncaughtException and
unhandledRejection): exactly one redacted JSON line, exit 1, within 2 s of
start-up.

Cap and per-string cost (L-p/L-q): `redactCap.test.ts` — cap within
MAX_REDACTED_LENGTH + 512; a 1212-case sweep of every secret form across the
cut (no fragment of >= 2 chars); medians of 9 runs < 25 ms for every
scheme-repeat shape at the cap and at 2 MB.

COMMIT tag: `worker/commitTag.db.test.ts` — a swallowed statement error
inside the publish, checkpoint-refresh and finishRun transactions makes the
run fail (`COMMIT_ROLLED_BACK`); nothing is published, the checkpoint does
not move, the run is never reported finished.

Overlapping secrets: `redact.test.ts` — two (both orders), three-way,
substring-of-another and self-overlapping secrets through redact,
scrubLiterals and jsonLineRedactorFor: no 3-char remainder of any secret.
Quarantine commit tag: `commitTag.db.test.ts`, a caught error after each
state-changing statement of the quarantine transaction — the run fails, the
batch stays staged, nothing recorded or published. Query rule alone:
uncapped 16 KB median < 25 ms (`redactCap.test.ts`) and uncapped 2 MB < 2 s
in a child under a hard kill (`redactLinear.test.ts`).

Serial DB phase: tests that COMMIT a dangerous login live in
`*.serial.db.test.ts` (`worker/auth.serial.db.test.ts`), run alone after the
parallel phase; `serialLogins.test.ts` statically guards the non-serial files.
Literal matching budgets (child process, hard kill): self-similar secrets
through scrubLiterals (2 MB) and jsonLineRedactorFor (1000 x 4.5 KB) < 2 s.
Crash handler: the spawned test measures the handler inside the child and
bounds the line at 16 KB; Slice 0's built-CLI crash test asserts the
capped-but-redacted line plus a > 2 MB writeAllSync pipe flush.

Dangerous logins, runtime backstop: `testing/dangerousLoginBackstop.ts` (setup
file of the parallel DB config) fails any file whose process leaves a
dangerous ratio_test_* login; self-test in `worker/backstop.serial.db.test.ts`.
The static rule (`serialLogins.test.ts`) also covers USER, GRANT-to-login,
concatenated/templated DDL, DO blocks and aliased/member createLogin.
Entry fatal path: the real CLI entry crashed with a preloaded write spy must
write its line synchronously (kills W9).

Backstop (round 24): snapshot diff of all dangerous roles (any name), the
ratio roles' own attributes and memberships, per test in the parallel phase
and per file in the serial phase; wiring guarded by backstopWiring.test.ts.
Spawned test children: tracked and killed in afterAll; cli.spawnCleanup.test.ts
runs a failing fixture in a nested vitest and requires its child gone.

PR #54 findings: `sources/s3/S3FocusExportSource.test.ts` (fake S3 client:
streamed bounded manifest read without ContentLength; IfMatch-pinned GET,
SOURCE_CHANGED), `s3Source.db.test.ts` X6 (SeaweedFS If-Match race through
the pipeline), `worker/reviewFindings.db.test.ts` (re-list on change,
PERIOD_NOT_FOUND, control-quarantine recovery, replay pin of the current
batch, replay LEASE_LOST after a takeover). Spawn cleanup also covers an
interrupted nested run (process group + env-marker reaping).

