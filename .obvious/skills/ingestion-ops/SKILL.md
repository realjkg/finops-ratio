---
name: ingestion-ops
description: Operate Ratio's trusted FOCUS ingestion worker (src/ingest) — migrate, provision a tenant/source, sync, backfill, replay/rollback, inspect runs and quarantine, doctor, replay-fixtures, and the manual real-export acceptance procedure (NOT YET PERFORMED). Local + ephemeral integration only.
version: 1.0.0
triggers:
  - ingestion
  - focus export
  - worker sync
  - backfill
  - replay
  - rollback cost data
  - quarantine
  - worker doctor
  - replay-fixtures
author: slice-1-implementer
created: 2026-10-03
---

# Ingestion ops — FOCUS ingestion worker

The worker moves one source's FOCUS export into `ratio.cost_facts` and
publishes it per billing period. Readers (`ratio_reader`) see only
`ratio.cost_facts_published` — the latest accepted revision per
(source, billing period). Design and guarantees: `docs/evidence/slice-1/DESIGN.md`.

> **Status:** only the committed SYNTHETIC fixture has been ingested. The
> ingestion layer must NOT be called "usable" until the manual real-export
> acceptance procedure below has been performed and signed off.

## 0. Configuration (environment only; names, never values, in code or docs)

| Variable | Used by | Meaning |
|---|---|---|
| `RATIO_DATABASE_URL` | all worker commands | login that is a member of `ratio_worker` only (refused if superuser, BYPASSRLS, member of a superuser/BYPASSRLS role, or of `ratio_owner`) |
| `RATIO_MIGRATE_DATABASE_URL` | `migrate`, `doctor` (ledger check, read-only txn), `replay-fixtures` (creates the fixture tenant and its sources; nothing is deleted) | owner/migrator login |
| `RATIO_ENV` | all | `development` (default) · `test` · `staging` · `production` |
| `RATIO_SOURCE_S3_ENDPOINT` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN` / `_FORCE_PATH_STYLE` | sync/backfill/replay | where the provider export lives. No key pair ⇒ AWS SDK default credential chain. `http://` refused when `RATIO_ENV=production` |
| `RATIO_EVIDENCE_S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_PREFIX` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN` | sync/backfill/replay/replay-fixtures | evidence bucket (raw bytes, content-addressed, never deleted by code) |
| `RATIO_LEASE_TTL_SECONDS` (300) · `RATIO_MAX_ATTEMPTS` (3) · `RATIO_RETRY_BASE_MS` (500) · `RATIO_RETRY_MAX_MS` (30000) | runs | lease and retry budget |
| `RATIO_STALL_TIMEOUT_SECONDS` (120) · `RATIO_MAX_RUN_SECONDS` (21600) | runs | a source/evidence stream idle this long fails `SOURCE_STALLED`/`EVIDENCE_STALLED`; a run without progress this long stops renewing its lease (another worker can then take over); a run older than the max run duration aborts itself with `MAX_RUN_EXCEEDED` |
| `RATIO_DB_LOCK_TIMEOUT_MS` (30000) · `RATIO_DB_IDLE_IN_TX_TIMEOUT_MS` (300000) · `RATIO_DB_STATEMENT_TIMEOUT_MS` (1800000) | worker/doctor DB sessions | a run blocked by another run's lock fails `LOCK_TIMEOUT` (exit 4); no session can hang forever |
| `RATIO_S3_CONNECT_TIMEOUT_MS` (10000) · `RATIO_S3_REQUEST_TIMEOUT_MS` (60000) | S3 calls | connect and time-to-response timeouts (body streaming is covered by the stall watchdog) |
| `RATIO_INSERT_CHUNK_ROWS` (1000) · `RATIO_MAX_ROWS_PER_BATCH` (20M) · `RATIO_MAX_ARTIFACT_BYTES` (5 GiB) · `RATIO_MAX_BATCH_BYTES` (20 GiB) · `RATIO_MAX_ARTIFACTS_PER_SET` (1000) · `RATIO_TMP_DIR` | runs | limits (exceeding ⇒ failed/quarantined, never partial) |
| `RATIO_DOCTOR_MAX_STALENESS_HOURS` (48) | doctor | freshness threshold |
| `RATIO_REPLAY_FIXTURES_BUCKET` | replay-fixtures | bucket for synthetic source objects (source credentials need Put/List/Delete there) |
| `RATIO_GIT_SHA` · `RATIO_ARTIFACT_DIGEST` (`sha256:<hex>`) · `RATIO_EVIDENCE_FILE` | all | evidence record metadata; JSONL copy of each record |

Test-only (refused otherwise, and always refused when `RATIO_ENV` is `staging` or
`production`): `RATIO_ALLOW_FAKE_SOURCE=1` + `NODE_ENV=test`;
`RATIO_TEST_PAUSE_AFTER_ROWS` (only with `NODE_ENV=test`).

Every command prints ONE evidence record on stdout (`{"type":"ratio.evidence", command, gitSha, artifactDigest, startedAt, finishedAt, results, pass, exitCode}`)
and JSON logs on stderr. Exit codes: 0 ok · 1 failure (incl. quarantine) ·
2 usage/config · 3 migrate status mismatch · 4 another run holds the lease (or its lock: `LOCK_TIMEOUT`).

## 1. Migrate

```bash
npm ci && npm run worker:build
RATIO_MIGRATE_DATABASE_URL=<owner url> npm run -s worker -- migrate --status --json   # exit 3 = pending
RATIO_MIGRATE_DATABASE_URL=<owner url> npm run -s worker -- migrate
RATIO_MIGRATE_DATABASE_URL=<owner url> npm run -s worker -- migrate --status --json   # exit 0 = matches
```
Slice 1 adds no migration. LOGIN for the worker/reader logins is granted by
deployment (Slice 0 roles are NOLOGIN), e.g. `CREATE ROLE ratio_worker_login LOGIN PASSWORD … IN ROLE ratio_worker`.

## 2. Provision a tenant and a source (operator, as the owner login)

The worker cannot create tenants or sources. As the owner (RLS applies to the
owner too, so set the tenant in the same transaction):

```sql
BEGIN;
SELECT set_config('ratio.tenant_id', '<tenant-uuid>', true);
INSERT INTO ratio.tenants (id, slug) VALUES ('<tenant-uuid>', '<slug>');
INSERT INTO ratio.sources (tenant_id, id, source_key, kind, display_name, coverage, declared_focus_version, config)
VALUES ('<tenant-uuid>', gen_random_uuid(), 'aws-focus', 'focus_file', 'AWS FOCUS export', 'public_cloud', '1.0',
        '{"layout":"aws-data-exports","bucket":"<bucket>","prefix":"<prefix-or-empty>","exportName":"<export-name>"}');
COMMIT;
```
`sources.config` must stay non-secret (keys like `token`, `key`, `secret`,
`sig`… are rejected by the schema). Credentials live only in env.

Expected bucket layout (AWS Data Exports, FOCUS 1.0, CSV + gzip):
```
<prefix>/<exportName>/data/BILLING_PERIOD=YYYY-MM/<executionId>/*.csv.gz
<prefix>/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/<exportName>-Manifest.json
```
Exactly one `*Manifest.json` per period (more ⇒ `MANIFEST_AMBIGUOUS`); its
`dataFiles` must stay inside that period's data folder of the same bucket.

## 3. Sync, backfill

```bash
export RATIO_DATABASE_URL=<worker url> RATIO_EVIDENCE_S3_BUCKET=<evidence bucket> ...
npm run -s worker -- sync     --tenant <uuid> --source aws-focus
npm run -s worker -- backfill --tenant <uuid> --source aws-focus --from 2026-01 --to 2026-06
```
- `sync` skips a period whose listing (manifest bytes + key/ETag/size) equals
  the checkpoint, and pinned periods. `backfill` re-checks every period in the
  range (still idempotent: identical bytes ⇒ `unchanged`, no new batch).
- Per period outcome (`results.periods[]`): `published`, `republished`,
  `unchanged`, `skipped_unchanged`, `skipped_pinned`, `quarantined`, `failed`.
  Any `quarantined`/`failed` ⇒ run `failed`, exit 1, checkpoint for that
  period NOT advanced, previous revision stays published.
- Exit 4 = another live run on the source. A crashed run blocks the source
  until its lease (`RATIO_LEASE_TTL_SECONDS`) expires; the next run then marks
  it `abandoned` and deletes its staged batch. It is abandoned as
  `LEASE_EXPIRED` if it committed nothing, or `LEASE_EXPIRED_AFTER_COMMIT`
  (`error_detail` counts its batches, publications and checkpoint write) if
  work it committed before losing the lease stands — check those periods
  rather than re-running blindly.
- Periods are bounded to 2000-01..9999-12 (`--from/--to/--period`; else exit 2).
- Listing problems that are never retried: `SOURCE_LISTING_INVALID` (a
  listing page claims more results without a continuation token — the whole
  listing fails; or an artifact has no ETag, so it cannot be read with
  If-Match — that period fails). An artifact name longer than 1024 characters
  as stored (redacted) is `MANIFEST_INVALID`.
- `ARTIFACT_SET_TOO_LARGE` / `ARTIFACT_TOO_LARGE` found only while capturing
  (sizes under-reported by the listing) are remembered for that exact listing
  and limits: the next runs fail the period fast without downloading. Raise
  `RATIO_MAX_BATCH_BYTES` / `RATIO_MAX_ARTIFACT_BYTES` (or wait for a new
  export) to try again.
- `RATIO_MAX_RUN_SECONDS` bounds the whole run, listing and every open
  included: a run past it fails `MAX_RUN_EXCEEDED`.

## 4. Inspect runs, batches, quarantine

```sql
-- as the worker or owner, inside a txn with set_config('ratio.tenant_id', '<uuid>', true)
SELECT id, run_kind, status, attempt, error_code, error_detail, stats->'retries', started_at, finished_at
FROM ratio.sync_runs ORDER BY started_at DESC LIMIT 20;
SELECT id, billing_period, status, reconciliation, row_count, loaded_billed_total,
       control_row_count, control_billed_total, is_provisional, quarantine_reason, validation_error_count
FROM ratio.ingest_batches ORDER BY created_at DESC;
```
```bash
npm run -s worker -- quarantine show --tenant <uuid> --batch <batch-uuid> --json
```
The report lists artifacts (name, sha256, size, row count, `evidence_key`)
and up to 1000 stored errors (artifact sha256, data-record ordinal (1-based),
column, code, message — never the cell value); `validationErrorCount` is the
true total. Raw bytes: evidence bucket, key `<RATIO_EVIDENCE_S3_PREFIX>/<evidence_key>`
(`evidence/<tenant>/<source>/<sha256>`); verify with `sha256sum`.
Quarantined is terminal: fix the data at the provider and let a new export
(new bytes) flow in; identical bytes with a DATA defect are never
re-validated. Exception: a `RECONCILIATION_VARIANCE` quarantine records the
controls it was judged against (`RECONCILIATION_VARIANCE [controls:<key>]: …`);
if the provider corrects only the manifest control totals, the next sync
re-reconciles the same data in a new batch and publishes it (the quarantined
batch stays as it was).
An artifact replaced between listing and read (S3 412 on the ETag-pinned GET,
`SOURCE_CHANGED`) is retried after re-listing the period.

## 5. Replay / rollback

```bash
# Roll the period back to a retained (superseded) batch — fenced, atomic, pins the period:
npm run -s worker -- replay --tenant <uuid> --source aws-focus --batch <superseded-batch-uuid>
# Roll forward again:
npm run -s worker -- replay --tenant <uuid> --source aws-focus --batch <newer-batch-uuid>
# Re-ingest a period from the source (ignores checkpoint), and unpin it:
npm run -s worker -- replay --tenant <uuid> --source aws-focus --period 2026-07
```
Pinned periods are skipped by `sync` and `backfill` (`skipped_pinned`) until a
`replay --period`; `replay --batch` pins even when the batch is already current.
`replay --period` of a period the source does not list fails `PERIOD_NOT_FOUND`.
A replay whose run was taken over before it finished fails `LEASE_LOST` (exit 1).
Quarantined and staged batches cannot be replayed.
Code rollback needs no database action (no schema change in Slice 1).

## 6. Doctor (read-only)

```bash
RATIO_DATABASE_URL=<worker url> RATIO_MIGRATE_DATABASE_URL=<owner url> \
  npm run -s worker -- doctor --json --tenant <uuid> [--tenant <uuid> ...]
```
Checks: `db_connectivity`, `role_safety`, `migration_version` (needs the
owner URL, used in a READ ONLY transaction, or a worker login granted SELECT
on `public.schema_migrations` — owner decision), and per source
`source:<tenant>/<key>` (never succeeded, never published a period
(`NEVER_PUBLISHED` — expected for a brand-new source until its first
publication), last run failed/abandoned, running with expired lease, last
success older than the staleness threshold ⇒ fail; disabled ⇒ skip). Exit 0
only if nothing fails.

## 7. replay-fixtures (staging/test only)

```bash
RATIO_ENV=staging RATIO_DATABASE_URL=<worker url> RATIO_MIGRATE_DATABASE_URL=<owner url> \
RATIO_REPLAY_FIXTURES_BUCKET=<scratch bucket> RATIO_EVIDENCE_S3_BUCKET=<evidence bucket> ... \
  npm run -s worker -- replay-fixtures --json
```
Each invocation creates a FRESH tenant (slug `fixture-<utc-yyyymmddhhmmss>-<8 hex>`,
three sources whose display name says SYNTHETIC), uploads the SYNTHETIC export
under `ratio-replay-fixtures/<tenant>/…` in `RATIO_REPLAY_FIXTURES_BUCKET`, and
runs `clean_load`, `idempotent_rerun`, `restatement_supersession`,
`reconciliation_variance_rejection`, `crash_mid_load_recovery`,
`zombie_fencing`. Exit 0 only if all six pass. Refused unless `RATIO_ENV` is
`staging` or `test`.

**Nothing is deleted** (no purge/delete path in this cycle — deletion is
retention-class and owner-only). The tenant's rows, its evidence objects
(`evidence/<tenant>/…` under the evidence prefix) and the synthetic source
objects stay, and are listed in `results.retained` of the evidence record.
Staging therefore accumulates one fixture tenant per run — measured locally
(2026-10-03): 341 fact rows (~409 kB of row data), 8 batches, 8 sync runs, and
38 objects / ~75 KB (synthetic source files + evidence) per run. Identify them with
`SELECT id, slug FROM ratio.tenants WHERE slug LIKE 'fixture-%'`. Cleanup
awaits an owner-approved retention slice.

## 8. Local end-to-end with the synthetic fixture

Performed for Slice 1 (script and output: `docs/evidence/slice-1/EVIDENCE.md`). Outline:
1. `CREATE DATABASE ratio_s1_e2e_<rand>`; `migrate --status --json` (exit 3) →
   `migrate` → `--status --json` (exit 0).
2. `CREATE ROLE <worker_login> LOGIN IN ROLE ratio_worker` and a reader login
   `IN ROLE ratio_reader`.
3. Create a bucket and upload `fixtures/focus-1.0-synthetic/base/**` at its root.
4. Provision tenant + source (section 2) with `prefix` `ratio-synthetic`,
   `exportName` `focus-export`.
5. `sync` (both periods `published`, `reconciled`), `sync` again (both
   `skipped_unchanged`), reader totals == `control-totals.json` (`base`),
   re-hash every evidence object, `doctor --json` (exit 0),
   `RATIO_ENV=test replay-fixtures --json` (6/6, fixture tenant retained).
6. Clean up the scratch database, logins and bucket (local scratch only).

## 9. Manual real-export acceptance procedure — **NOT YET PERFORMED**

Required before the ingestion layer may be called usable. Owner-run.
1. In AWS Billing and Cost Management → Data Exports, create (or reuse) a
   **FOCUS 1.0** export, CSV, gzip, delivered to an S3 bucket the worker may
   read (read-only credentials, ideally a role assumed via the SDK chain).
2. Wait for a delivery covering at least one CLOSED billing month and the
   current (provisional) month.
3. Provision the tenant/source (section 2) with the export's bucket, prefix
   and export name. Point `RATIO_EVIDENCE_S3_*` at a separate evidence bucket.
4. Run `sync`. Expect exit 0 (or exit 1 with a visible reason). Record the
   evidence record.
5. Check, per period:
   - `reconciliation`: real AWS manifests are expected to carry no control
     totals ⇒ `unverified`. Confirm what the real manifest contains (field
     names, `dataFiles` format, one or several manifests per period) and
     record any mismatch with the assumptions in DESIGN §3 — a mismatch is a
     defect to fix before acceptance, not something to work around.
   - Totals: `SELECT billing_period, billing_currency, sum(billed_cost) FROM ratio.cost_facts_published GROUP BY 1,2`
     (as the reader with the tenant set) vs. the Billing console / Cost
     Explorer for the same months, same currency (tolerance: exact for closed
     months; explain any difference).
   - Row counts vs. the decompressed CSV line counts (minus headers).
   - `is_provisional` true only for the current month.
   - Re-run `sync`: every period `skipped_unchanged`, no new batches.
   - Re-hash two evidence objects and compare with `ingest_artifacts.sha256`.
6. Record results, commands and the export's identifying details (not
   credentials) in the deployment evidence, then sign off.

## 10. Known gaps

- Manifest semantics are from the public layout description; not verified
  against a real AWS export (section 9). Several manifests per period are
  refused (`MANIFEST_AMBIGUOUS`) rather than resolved.
- No control totals from real AWS manifests ⇒ real batches are `unverified`.
- Quarantined batches are terminal; identical bytes are not re-validated
  after a code fix.
- Temp capture files of a SIGKILLed process stay under `RATIO_TMP_DIR`.
- Evidence objects are never deleted (retention is an owner decision); replay-fixtures leaves one fixture tenant (rows, evidence, synthetic source objects) per run.
- A batch must have one billing currency (else quarantined); no cross-period
  checks of ChargePeriodStart.
- Byte-identical data files within one artifact set are quarantined
  (`DUPLICATE_ARTIFACT`) — fail-closed, could reject a legitimate export.
- `doctor` needs owner credentials (or a ledger grant) for the migration check.
- The test kill hook and fake source exist in the shipped build but are
  refused unless `NODE_ENV=test` (and the fake source also needs its flag).
