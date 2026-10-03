# Slice 0 — Postgres foundation: design note

Branch: `slice/00-postgres-foundation` (from `origin/slice/00a-ci-deps` @ ec68902).
Concern: durable schema + migration path. Nothing reads or writes cost data yet;
no worker logic, no sources, no HTTP surface.

Ephemeral per repo rule (`.obvious/obvious.md`: design specs are point-in-time
artifacts) — not committed.

## 1. Components and placement

All new code is server-only and lives under `src/ingest/**`:

| Path | Purpose |
|---|---|
| `src/ingest/db/migrations/0001_ratio_schema.up.sql` / `.down.sql` | schema `ratio`, roles, RLS, view |
| `src/ingest/db/migrationFiles.ts` | discover/validate migration files, sha256 checksums, reject transaction-control statements. No `pg` import. |
| `src/ingest/db/migrate.ts` | runner (`pg` only): advisory lock, `schema_migrations`, checksum/order checks, one txn per migration, `down N` |
| `src/ingest/db/tenant.ts` | `withTenantTransaction(pool, tenantId, fn)` — the only sanctioned way app code sets tenant (`set_config('ratio.tenant_id', $1, true)`, bound parameter, uuid-validated) |
| `src/ingest/db/testing/*` | DB test harness (per-file database), synthetic fixtures, `requireTestDatabaseUrl` guard. Excluded from the worker build. |
| `src/ingest/cli.ts` | worker CLI entry; Slice 0 only has `migrate up|down N|status` |
| `tsconfig.worker.json` → `dist-worker/` | CommonJS production build of `src/ingest` (gitignored). Migrations SQL copied next to the compiled runner. |
| `vitest.db.config.ts` | runs only `*.db.test.ts`; throws at config load if `RATIO_TEST_DATABASE_URL` unset ⇒ `npm run test:db` exits non-zero (fails, never skips) |

npm scripts: `test:db`, `worker:build`, `worker` (node dist-worker/ingest/cli.js),
`db:migrate` (builds, then `cli.js migrate …`). `npm test` unchanged except
`vitest.config.ts` now excludes `**/*.db.test.ts` and `dist-worker/**`.

Dependencies: `pg` (runtime), `@types/pg` (dev). `csv-parse` / `tsx` are NOT
added in this slice (not needed). No other dependency.

## 2. Migration runner

- Bookkeeping table `public.schema_migrations(version text pk, name text, checksum
  text (sha256 hex of the .up.sql bytes), applied_at timestamptz default now())`.
  Lives outside schema `ratio` so dropping `ratio` (down) never loses the
  migration ledger.
- Session-level `pg_advisory_lock(<constant bigint>)` taken BEFORE the ledger is
  created/read, released in `finally` (and implicitly when the session dies).
  A second runner blocks, then re-reads the ledger and finds nothing pending.
  Advisory locks are per-database, so runners on different databases do not
  serialize (relevant for parallel test DBs and for role creation, see §4).
- Integrity checks before applying anything (refuse ⇒ throw `MigrationError`
  with a code, nothing applied):
  - `CHECKSUM_MISMATCH` — an applied migration's file bytes changed;
  - `MISSING_FILE` — an applied version has no file on disk;
  - `OUT_OF_ORDER` — a pending version is lower than the highest applied;
  - file-level: bad filename, duplicate version, `.down.sql` without `.up.sql`,
    transaction-control statements (`BEGIN`/`COMMIT`/`ROLLBACK`/`START
    TRANSACTION`/`SAVEPOINT`/`RELEASE`/`END`/`ABORT`/`PREPARE TRANSACTION`) at
    statement level outside dollar-quoted bodies, comments and string literals
    (`TRANSACTION_CONTROL`) — these would break the one-txn-per-migration rule.
- Each migration: `BEGIN; <up sql>; RESET ROLE; INSERT schema_migrations; COMMIT`.
  Any error ⇒ `ROLLBACK`, no ledger row, no partial objects, runner stops.
  (`RESET ROLE` because 0001 does `SET LOCAL ROLE ratio_owner`.)
- `down N`: newest-first, each `BEGIN; <down sql>; RESET ROLE; DELETE ledger row;
  COMMIT`, same lock. Refused (`DOWN_NOT_ALLOWED`) unless
  `RATIO_ALLOW_DOWN_MIGRATIONS=1` AND `NODE_ENV !== 'production'`. Refused
  (`NO_DOWN`) if a target has no `.down.sql`. Checksum checks also run first.
- Checksums are over raw bytes; `.gitattributes` pins `*.sql` to LF so a
  Windows checkout cannot silently change a checksum.

## 3. Schema v1 (`ratio`)

Money: unconstrained `numeric` everywhere (no float/real/double anywhere in the
schema — tested by catalog scan). Timestamps: `timestamptz` only (tested).
Every tenant-owned table: `tenant_id uuid not null`; every FK is composite and
includes `tenant_id` (tested generically by catalog scan of `pg_constraint`).

| Table | Key points |
|---|---|
| `tenants(id uuid pk, slug text unique not null check ^[a-z0-9][a-z0-9-]{0,62}$, created_at)` | tenant registry; RLS on `id` |
| `sources` | pk(tenant_id,id); unique(tenant_id,source_key); kind ∈ {focus_file,fake}; coverage ∈ {public_cloud,private_cloud,on_prem}; `declared_focus_version` null or `1.0`–`1.4`; `config jsonb not null default '{}'` CHECK object AND NOT `ratio.jsonb_has_secret_like_key(config)`; NO secrets column; FK(tenant_id)→tenants |
| `sync_runs` | pk(tenant_id,id); unique(tenant_id,source_id,id); FK(tenant_id,source_id)→sources; run_kind ∈ {scheduled,backfill,replay}; `period_from/period_to date` (first-of-month, both-or-neither, from ≤ to) — chosen over `daterange[]` for simpler constraints; status ∈ {running,succeeded,failed,abandoned}; running ⇒ lease_token+lease_expires_at not null and finished_at null; terminal ⇒ finished_at not null; `attempt int ≥ 1`; `error_detail` ≤ 4000 chars (redaction is the writer's job, Slice 1); partial unique index: one `running` run per (tenant, source) |
| `ingest_batches` | pk(tenant_id,id); unique(tenant_id,source_id,id), unique(tenant_id,source_id,billing_period,id) (FK targets); FK(tenant_id,source_id,run_id)→sync_runs(tenant_id,source_id,id) so a batch's run is the same source's run; billing_period day = 1; fingerprint `^[0-9a-f]{64}$`; status ∈ {staged,published,superseded,rejected}; reconciliation ∈ {reconciled,unverified,variance} not null default unverified; counts ≥ 0; published ⇒ published_at; superseded ⇒ superseded_at; rejected ⇒ rejection_reason; published/superseded ⇒ reconciliation ≠ variance; unique(tenant_id,source_id,billing_period,artifact_set_fingerprint); partial unique: ≤1 `published` batch per (tenant,source,period) |
| `ingest_artifacts` | pk(tenant_id,batch_id,artifact_name); unique(tenant_id,batch_id,fingerprint) (two byte-identical files in one set are refused — Slice 1 must reject such a set with a reason); FK(tenant_id,batch_id)→ingest_batches; byte_size/row_count ≥ 0 |
| `cost_facts` | pk(tenant_id,batch_id,artifact_fingerprint,row_ordinal) (row identity = artifact+ordinal, never content hash); FK(tenant_id,source_id,billing_period,batch_id)→ingest_batches(…) so a fact's source/period always equal its batch's; FK(tenant_id,batch_id,artifact_fingerprint)→ingest_artifacts(tenant_id,batch_id,fingerprint); `billed_cost numeric not null`; `billing_currency ~ ^[A-Z]{3}$`; charge_period_start/end timestamptz not null, end ≥ start; row_ordinal ≥ 0; `extra_columns jsonb` object |
| `period_publications` | pk(tenant_id,source_id,billing_period) — THE pointer; FK(tenant_id,source_id,billing_period,batch_id)→ingest_batches(…) so the pointer can only name a batch of the same source+period; FK(tenant_id,source_id,published_by_run_id)→sync_runs; unique(tenant_id,batch_id) |
| `source_checkpoints` | pk(tenant_id,source_id); FK→sources; FK(tenant_id,source_id,last_run_id)→sync_runs; `periods jsonb` object |
| view `cost_facts_published` | `WITH (security_invoker = true, security_barrier = true)`; cost_facts ⋈ period_publications on (tenant, source, period, batch) |

Helper functions (schema `ratio`, `SET search_path = pg_catalog, pg_temp`):
- `ratio.current_tenant_id()` STABLE: `NULLIF(current_setting('ratio.tenant_id', true), '')::uuid`.
  The `NULLIF` matters: after any transaction that used `set_config(..., true)`
  the placeholder GUC remains defined with value `''` for the rest of the
  session; `''::uuid` would raise. With `NULLIF` an unset/reset tenant is
  `NULL` ⇒ policy false ⇒ zero rows, writes rejected. A malformed value raises
  `invalid input syntax for type uuid` (fails closed; returns no rows).
- `ratio.jsonb_has_secret_like_key(jsonb)` IMMUTABLE: recursive walk over all
  nested objects/arrays; true if any key matches (case-insensitive substring)
  `token|secret|key|password|passwd|pwd|sas|sig|credential|auth|private`.
  Deliberately fail-closed: false positives (e.g. `partition_key`, `design`)
  are rejected too. Only keys are inspected, not values (gap, §7).

## 4. Roles and tenancy

- `ratio_owner`, `ratio_worker`, `ratio_reader`, created idempotently in a DO
  block (`IF NOT EXISTS … CREATE ROLE … NOLOGIN`, with `duplicate_object` /
  `unique_violation` caught so concurrent migrations of different databases in
  one cluster cannot race). Then a guard: if any of the three has `rolsuper` or
  `rolbypassrls`, the migration RAISEs (fails closed rather than ALTERing roles).
  Roles are cluster-global; LOGIN/password are granted by deployment
  (`ALTER ROLE ratio_worker LOGIN PASSWORD …` or a login role `GRANT ratio_worker
  TO app_login`), not by migrations.
- Ownership: `CREATE SCHEMA ratio AUTHORIZATION ratio_owner`, then
  `SET LOCAL ROLE ratio_owner` so every object (tables, view, functions,
  policies) is owned by the non-superuser, non-BYPASSRLS owner. The migrating
  login must therefore be a superuser or a member of `ratio_owner` (and have
  CREATEROLE the first time if roles do not yet exist). `REVOKE ALL ON SCHEMA
  ratio FROM PUBLIC`.
- RLS ENABLED + FORCED on every table in `ratio` (incl. `tenants`), policy
  `tenant_isolation FOR ALL USING (tenant_id = ratio.current_tenant_id()) WITH
  CHECK (same)` (tenants: `id = …`). Applies to PUBLIC, so also to the owner.
  Superusers still bypass RLS (Postgres semantics) — the worker must never
  connect as one (Slice 1 enforces at startup).
- Grants (least privilege):
  - `ratio_worker`: USAGE on schema; SELECT on tenants, sources; SELECT/INSERT/
    UPDATE on sync_runs, source_checkpoints, period_publications;
    SELECT/INSERT/UPDATE/DELETE on ingest_batches; SELECT/INSERT/DELETE on
    ingest_artifacts, cost_facts (facts are immutable — no UPDATE); SELECT on
    the view. No DDL, not owner (cannot disable RLS).
  - `ratio_reader`: USAGE; SELECT on `cost_facts_published`, `ingest_batches`,
    `sync_runs`, `sources`. **Deviation:** because the view is
    `security_invoker`, Postgres checks the invoker's privileges on the base
    tables, so the reader ALSO needs SELECT on `cost_facts` and
    `period_publications`. To keep "readers see only published facts" true
    regardless, `cost_facts` gets an additional RESTRICTIVE SELECT policy
    `TO ratio_reader` requiring the row's batch to be the currently published
    one (EXISTS on period_publications). So a reader querying raw
    `cost_facts` sees exactly what the view shows (own tenant, published
    only) — tested. No INSERT/UPDATE/DELETE anywhere — tested for every table.
- App code: `withTenantTransaction` does `BEGIN; SELECT set_config('ratio.tenant_id',
  $1, true)`, uuid validated client-side first, never session-level, never
  interpolated.

## 5. API effects

None. No file under `pages/` changes; no `/api` route changes; no UI change.
`src/ingest` is not imported by `pages/` or any other `src/` module, nor is
`pg` — enforced by `src/ingest/importBoundary.test.ts` (uses the TypeScript
pre-processor to extract static, dynamic and `require` imports; includes a
self-test proving the detector flags violations). The Next build therefore
does not bundle `pg`. `tsc --noEmit` (root tsconfig) type-checks `src/ingest`.

## 6. Threat model (Slice 0 scope)

| Threat | Control | Test |
|---|---|---|
| Tenant A reads/writes tenant B rows | RLS forced on every table, setting-based policy; worker/reader not super/BYPASSRLS | per-table SELECT/UPDATE/DELETE/INSERT matrix |
| Forgotten tenant setting leaks all rows | NULL ⇒ policy false (zero rows), insert rejected; transaction-local only | no-tenant + "after previous txn" tests |
| Cross-tenant reference via FK | all FKs composite incl. tenant_id; catalog scan proves it | A-batch → B-source rejected even as superuser |
| Mismatched source/period pointer (double count) | FKs carry (source, period); ≤1 published batch per period; one pointer per period | constraint tests |
| View bypassing RLS (definer rights) | `security_invoker=true`, owner non-super | view isolation test |
| Reader sees staged/superseded rows via base table | restrictive reader policy on cost_facts | raw cost_facts as reader test |
| Reader/worker escalation (DDL, disable RLS) | not owner, no CREATE on schema | DDL refused test |
| Secrets persisted in config | no secrets column; CHECK rejects secret-like keys recursively | key matrix |
| Float money corruption | numeric only; `pg` returns numeric as string | precision round-trip + catalog scan |
| Concurrent migrators corrupt schema | advisory lock + per-migration txn | concurrent runner test |
| Edited migration silently diverges | sha256 checksum ledger | tamper test |
| Migration leaking connection string | CLI never logs URLs; logs structured JSON with error message/code only | n/a (reviewed) |
| SQL injection via tenant id | bound parameter + uuid validation | unit test |

Out of scope here: worker startup role check (Slice 1), error redaction
(Slice 1), any network surface (none exists).

## 7. Failure cases

- DB unreachable: runner throws; CLI exits 1 with JSON error; nothing applied.
- Migration SQL error: that migration rolled back, ledger unchanged, earlier
  migrations stay applied, runner exits non-zero.
- Process killed mid-migration: txn aborted by server; advisory lock released
  with the session; re-run applies from the same point.
- Lock holder hangs: other runners wait indefinitely (no lock timeout in v1 —
  gap; operator can `pg_terminate_backend`).
- Checksum/missing/out-of-order: refuse before touching anything.
- Role pre-exists with SUPERUSER/BYPASSRLS: migration 0001 raises, rolled back.
- Migrating login lacks membership in ratio_owner: `SET ROLE` fails, rolled back.
- `test:db` without `RATIO_TEST_DATABASE_URL`: config throws ⇒ non-zero exit.

Known gaps carried forward: secret check inspects keys only (not values such as
URLs with `sig=`); `period_publications` does not itself enforce the pointed
batch has `status='published'` (Slice 1 publish txn does both atomically; a
deferred constraint trigger could be added later); no `lock_timeout` on the
migration lock; dynamic `import()` with non-literal specifiers is not detectable
by the boundary test.

## 8. Rollback plan

- Code: branch is unmerged; revert = do not merge / `git revert` the commits.
  App behaviour does not depend on any of it.
- Database (non-prod): `RATIO_ALLOW_DOWN_MIGRATIONS=1 RATIO_MIGRATE_DATABASE_URL=… npm run db:migrate -- down 1`
  ⇒ `DROP SCHEMA ratio CASCADE` + ledger row removed. Roles are left in place
  (cluster-global, may be shared by other databases); to remove them on a
  dedicated cluster: `DROP ROLE ratio_reader, ratio_worker, ratio_owner` after
  checking no other database references them.
- Production: down is refused by design (NODE_ENV=production). Production
  rollback of 0001 drops all ingested data and is a data-retention decision for
  the owner (flagged in EVIDENCE.md).

## 9. Deployment-pipeline constraints (owner, received mid-slice; applied)

1. **Expand/contract.** Every `.up.sql` must declare its phase in its leading
   comment block: `-- ratio:phase expand` or `-- ratio:phase contract`
   (exactly one; part of the checksummed bytes). Missing/invalid/duplicate
   header ⇒ `MISSING_PHASE` at load time ⇒ nothing runs. A pending `contract`
   migration is refused (`CONTRACT_NOT_ALLOWED`, nothing applied — checked
   before the first migration of the run) unless `allowContract: true` /
   CLI `--allow-contract`. Fail-closed hardening (delegated decision): an
   `expand` migration whose code (outside comments/strings/dollar bodies)
   contains `DROP …`, `TRUNCATE`, `DELETE FROM`, `… RENAME …` or
   `ALTER COLUMN … TYPE` is rejected at load (`EXPAND_NOT_ADDITIVE`). This is a
   lexical heuristic, not a proof of backward compatibility (gap: e.g.
   `CREATE OR REPLACE FUNCTION` changing semantics, `SET NOT NULL`). 0001 is
   `expand` (creates only new objects). Down files carry no phase.
2. **Down is dev/test only.** Refused (`DOWN_NOT_ALLOWED`) when
   `RATIO_ENV=production` OR `NODE_ENV=production`, and also unless
   `RATIO_ALLOW_DOWN_MIGRATIONS=1` (explicit opt-in even in dev). Auto-rollback
   in the pipeline never touches the DB; with expand-only migrations the
   previous release keeps working on the newer schema.
3. **Machine-readable status.** `npm run db:migrate -- --status --json`
   (CLI: `migrate --status --json`) prints exactly one JSON document on stdout:
   `{ expectedVersion, currentVersion, matches, applied:[{version,name,checksum,
   appliedAt,fileChecksum,checksumMatches}], pending:[{version,name,phase,checksum}],
   unknownApplied:[versions in DB but not in code], problems:[codes] }`.
   Read-only (no lock, does not create the ledger). Exit 0 iff matches (every
   code migration applied, all checksums equal, no unknown applied versions);
   exit 3 on mismatch; exit 1 on error (connection etc.). Without `--json` the
   same object is logged as one structured line.

CLI surface therefore becomes flag-based: `migrate` (apply pending),
`migrate --allow-contract`, `migrate --down N`, `migrate --status [--json]`.

## 10. BOUNDARY v2 changes (orchestrator decisions D4–D6; applied before the test commit)

These OVERRIDE §3/§4 where they conflict.

- **D4 view/reader.** `cost_facts_published` is a plain definer-rights view
  (`security_barrier = true`, NOT `security_invoker`), owned by `ratio_owner`.
  Because every base table has FORCE RLS with a setting-based policy that
  applies TO PUBLIC, the owner is still filtered by
  `ratio.current_tenant_id()` when the view runs. `ratio_reader` has
  USAGE on schema `ratio` and SELECT on the view ONLY — no grant on any base
  table (cost_facts, ingest_batches, sync_runs, sources, ingest_artifacts,
  ingest_validation_errors, period_publications, …). The §4 "restrictive
  reader policy" and the reader grants on ingest_batches/sync_runs/sources are
  dropped (D4 says "view ONLY"; narrowing, fail-closed). Safety rests on the
  owner being non-superuser/non-BYPASSRLS (migration guard + test) and FORCE
  RLS (test).
- **D5 quarantine.** `ingest_batches.status ∈ {staged, published, superseded,
  quarantined}` (`rejected` removed); `rejection_reason` → `quarantine_reason`
  (required when quarantined); new `validation_error_count bigint not null
  default 0 ≥ 0` = total errors found (may exceed stored rows). New table
  `ingest_validation_errors(tenant_id, batch_id, error_ordinal int 1..1000,
  artifact_sha256, row_ordinal bigint null, column_name text null, code text
  ^[A-Z][A-Z0-9_]{0,63}$, message text ≤ 1000 chars, created_at)`,
  pk(tenant_id, batch_id, error_ordinal) — the 1..1000 CHECK makes the
  per-batch cap a DB invariant. FK (tenant_id, batch_id, artifact_sha256) →
  ingest_artifacts(tenant_id, batch_id, sha256). `artifact_sha256` is NOT NULL
  (the D5 column list marks only row_ordinal/column_name as nullable); batch-level
  problems with no artifact (e.g. empty artifact set) go in
  `quarantine_reason`. RLS forced; worker SELECT/INSERT/DELETE; reader none.
- **D6 evidence.** `ingest_artifacts` columns: tenant_id, source_id, batch_id,
  artifact_name, `sha256` (replaces `fingerprint`; `^[0-9a-f]{64}$`),
  `byte_size bigint ≥ 0`, row_count, `evidence_key text not null` with CHECK
  `evidence_key = 'evidence/' || tenant_id || '/' || source_id || '/' || sha256`
  — the key is fully determined (content-addressed), so no bucket names, URLs,
  query strings or signatures can be stored there. `artifact_name` CHECK
  rejects `?`/`#` (no presigned-URL fragments) and caps length at 1024.
  `source_id` was added so the key can be checked; FK (tenant_id, source_id,
  batch_id) → ingest_batches(tenant_id, source_id, id).
  `cost_facts.artifact_fingerprint` is renamed `artifact_sha256` for one name
  per concept (FK → ingest_artifacts(tenant_id, batch_id, sha256)).
- D1–D3, D7 and Slice 2 items are Slice 1/2 work; nothing for them here.
