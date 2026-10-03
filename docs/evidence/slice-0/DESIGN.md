# Slice 0 — Postgres foundation: design note

Branch: `slice/00-postgres-foundation` (from `origin/slice/00a-ci-deps` @ ec68902).
Concern: durable schema + migration path. Nothing reads or writes cost data yet;
no worker logic, no sources, no HTTP surface.

Committed under `docs/evidence/slice-0/` as the slice's design evidence. Sections
§1–§8 describe the CURRENT state of the branch (updated in round 6); §9–§15
record each review round's decisions as they were made — where a later round
changed something, the earlier text says so.

## 1. Components and placement

All new code is server-only and lives under `src/ingest/**`:

| Path | Purpose |
|---|---|
| `src/ingest/db/migrations/0001_ratio_schema.up.sql` / `.down.sql` | schema `ratio`, roles, RLS, view |
| `src/ingest/db/migrationFiles.ts` | discover/validate migration files, sha256 checksums (up and down), phase header, transaction-control refusal, the lexical expand allow-list / always-forbidden classifier and its reasoned markers. No `pg` import. |
| `src/ingest/db/migrate.ts` | runner (`pg` only): advisory lock, `schema_migrations`, checksum/order checks, one txn per migration, `down N`, read-only status |
| `src/ingest/db/privilegeModel.ts` | the reviewed privilege/hook/role model and the catalog check the runner runs as the last statement of every migration transaction (and status runs read-only) |
| `src/ingest/db/tenant.ts` | `withTenantTransaction(pool, tenantId, fn)` — the only sanctioned way app code sets tenant (`set_config('ratio.tenant_id', $1, true)`, bound parameter, uuid-validated) |
| `src/ingest/db/testing/*` | DB test harness (per-file database), synthetic fixtures, `requireTestDatabaseUrl` guard. Excluded from the worker build. |
| `src/ingest/cli.ts` | worker CLI entry; Slice 0 only has `migrate [--allow-contract \| --down N \| --status [--json]]`; every output line goes through `jsonLineRedactor` (redaction before serialization, §15) |
| `tsconfig.worker.json` → `dist-worker/` | CommonJS production build of `src/ingest` (gitignored). Migrations SQL copied next to the compiled runner. |
| `vitest.db.config.ts` | runs only `*.db.test.ts`; throws at config load if `RATIO_TEST_DATABASE_URL` unset ⇒ `npm run test:db` exits non-zero (fails, never skips) |

npm scripts: `test:db`, `worker:build`, `worker` (node dist-worker/ingest/cli.js),
`db:migrate` (builds, then `cli.js migrate …`). `npm test` unchanged except
`vitest.config.ts` now excludes `**/*.db.test.ts` and `dist-worker/**`.

Dependencies: `pg` (runtime), `@types/pg` (dev). `csv-parse` / `tsx` are NOT
added in this slice (not needed). No other dependency.

## 2. Migration runner

- Bookkeeping table `public.schema_migrations(version text pk, name text, checksum
  text (sha256 hex of the .up.sql bytes), down_checksum text null (sha256 of the
  .down.sql bytes), applied_at timestamptz default now())`.
  Lives outside schema `ratio` so dropping `ratio` (down) never loses the
  migration ledger.
- Session-level `pg_advisory_lock(<constant bigint>)` taken BEFORE the ledger is
  created/read, released in `finally` (and implicitly when the session dies).
  A second runner blocks, then re-reads the ledger and finds nothing pending.
  Advisory locks are per-database, so runners on different databases do not
  serialize (relevant for parallel test DBs and for role creation, see §4).
- Integrity checks before applying anything (refuse ⇒ throw `MigrationError`
  with a code, nothing applied):
  - `CHECKSUM_MISMATCH` — an applied migration's up file bytes changed, or its
    down file changed, appeared or disappeared;
  - `MISSING_FILE` — an applied version has no file on disk;
  - `OUT_OF_ORDER` — a pending version is lower than the highest applied;
  - file-level: bad filename, duplicate version, `.down.sql` without `.up.sql`,
    transaction-control statements (`BEGIN`/`COMMIT`/`ROLLBACK`/`START
    TRANSACTION`/`SAVEPOINT`/`RELEASE`/`END`/`ABORT`/`PREPARE TRANSACTION`) at
    statement level outside dollar-quoted bodies, comments and string literals
    (`TRANSACTION_CONTROL`) — these would break the one-txn-per-migration rule.
- Session state (round 7): before the advisory lock and after every migration
  transaction (committed or failed) the runner resets the session — `RESET
  ROLE; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; SET search_path =
  pg_catalog, pg_temp` — so a plain `SET` a migration ran (search_path,
  row_security, role, session authorization, …) cannot outlive its COMMIT into
  the next migration or the caller. Migrations therefore run with
  `search_path = pg_catalog, pg_temp` and must schema-qualify every name.
- Each migration (current, round 5): `BEGIN; <up sql>; RESET ROLE; SET LOCAL
  search_path = pg_catalog, pg_temp; SET CONSTRAINTS ALL IMMEDIATE; INSERT
  schema_migrations; <catalog privilege check>; COMMIT`. Any error or check
  violation ⇒ `ROLLBACK`, no ledger row, no partial objects, runner stops.
  (`RESET ROLE` because 0001 does `SET LOCAL ROLE ratio_owner`; the catalog
  check is the last statement so nothing the migration installed can run after
  it — see §13/§14.)
- `down N`: newest-first, each `BEGIN; <down sql>; RESET ROLE; SET LOCAL
  search_path …; SET CONSTRAINTS ALL IMMEDIATE; DELETE ledger row; <catalog
  check>; COMMIT`, same lock. Refused (`DOWN_NOT_ALLOWED`) when `NODE_ENV` or
  `RATIO_ENV` is production, unless `RATIO_ENV` (trimmed, lower-cased) is
  development/test/ci, and unless `RATIO_ALLOW_DOWN_MIGRATIONS=1`. Refused
  (`NO_DOWN`) if a target has no `.down.sql`. Checksum checks also run first.
  What down drops and keeps: §8.
- Checksums are over raw bytes; `.gitattributes` pins `*.sql` to LF so a
  Windows checkout cannot silently change a checksum.

## 3. Schema v1 (`ratio`)

Money: unconstrained `numeric` everywhere (no float/real/double anywhere in the
schema — tested by catalog scan). Timestamps: `timestamptz` only (tested).
Every tenant-owned table: `tenant_id uuid not null`; every FK is composite and
includes `tenant_id` (tested generically by catalog scan of `pg_constraint`).

| Table | Key points (current 0001) |
|---|---|
| `tenants(id uuid pk, slug text unique not null check ^[a-z0-9][a-z0-9-]{0,62}$, created_at)` | tenant registry; RLS on `id` |
| `sources` | pk(tenant_id,id); unique(tenant_id,source_key); `source_key ~ ^[a-z0-9][a-z0-9_-]{0,62}$`; kind ∈ {focus_file,fake}; display_name 1–200 chars; coverage ∈ {public_cloud,private_cloud,on_prem}; `declared_focus_version` null or `1.0`–`1.4`; `config jsonb not null default '{}'` CHECK object AND NOT `ratio.jsonb_has_secret_like_key(config)` AND NOT `ratio.jsonb_has_secret_like_value(config)`; NO secrets column; FK(tenant_id)→tenants |
| `sync_runs` | pk(tenant_id,id); unique(tenant_id,source_id,id); FK(tenant_id,source_id)→sources; run_kind ∈ {scheduled,backfill,replay}; `period_from/period_to date` (first-of-month, both-or-neither, from ≤ to) — chosen over `daterange[]` for simpler constraints; status ∈ {running,succeeded,failed,abandoned}; running ⇒ lease_token+lease_expires_at not null and finished_at null; terminal ⇒ finished_at not null; `attempt int ≥ 1`; `error_code ~ ^[A-Z][A-Z0-9_]{0,63}$`; `error_detail` ≤ 4000 chars AND NOT `text_looks_secret` (the writer must redact; Slice 1); `stats jsonb` object with no secret-like keys or values; partial unique index: one `running` run per (tenant, source) |
| `ingest_batches` | pk(tenant_id,id); unique(tenant_id,source_id,id), unique(tenant_id,source_id,billing_period,id) (FK targets); FK(tenant_id,source_id,run_id)→sync_runs(tenant_id,source_id,id); billing_period day = 1; `artifact_set_fingerprint ~ ^[0-9a-f]{64}$`; status ∈ {staged,published,superseded,quarantined}; `row_count`/`control_row_count`/`validation_error_count` ≥ 0; `control_billed_total` and `loaded_billed_total` finite (`abs(x) < 'Infinity'`, rejects NaN/±Infinity); reconciliation ∈ {reconciled,unverified,variance} default unverified; published ⇒ published_at; superseded ⇒ superseded_at; quarantined ⇒ `quarantine_reason` (≤ 2000 chars AND NOT `text_looks_secret`); published/superseded ⇒ reconciliation ≠ variance; reconciled ⇒ ≥1 control and every present control equals the loaded value; variance ⇒ a control exists; published/superseded ⇒ (`unverified` ⇔ no control); unique(tenant_id,source_id,billing_period,artifact_set_fingerprint); partial unique: ≤1 `published` batch per (tenant,source,period); lifecycle + immutability triggers (§11) |
| `ingest_artifacts` | pk(tenant_id,batch_id,artifact_name); unique(tenant_id,batch_id,sha256) (two byte-identical files in one set are refused); FK(tenant_id,source_id,batch_id)→ingest_batches(tenant_id,source_id,id); `artifact_name` 1–1024 chars, no `?`/`#`, NOT `text_looks_secret`; `sha256 ~ ^[0-9a-f]{64}$`; byte_size/row_count ≥ 0; `evidence_key = 'evidence/' ‖ tenant_id ‖ '/' ‖ source_id ‖ '/' ‖ sha256` (CHECK) |
| `ingest_validation_errors` | pk(tenant_id,batch_id,error_ordinal); `error_ordinal` 1..1000 (DB-enforced per-batch cap; the total is `ingest_batches.validation_error_count`); FK(tenant_id,batch_id,artifact_sha256)→ingest_artifacts(tenant_id,batch_id,sha256); row_ordinal ≥ 0 or null; column_name ≤ 256; `code ~ ^[A-Z][A-Z0-9_]{0,63}$`; `message` ≤ 1000 chars AND NOT `text_looks_secret` |
| `cost_facts` | pk(tenant_id,batch_id,artifact_sha256,row_ordinal) (row identity = artifact+ordinal, never content hash); FK(tenant_id,source_id,billing_period,batch_id)→ingest_batches(…) so a fact's source/period always equal its batch's; FK(tenant_id,batch_id,artifact_sha256)→ingest_artifacts(tenant_id,batch_id,sha256); `billed_cost numeric not null`; billed/effective/list/contracted cost and usage/pricing quantity finite (`abs(x) < 'Infinity'`); `billing_currency ~ ^[A-Z]{3}$`; charge_period_start/end timestamptz not null, end ≥ start; `row_ordinal bigint ≥ 0`; `extra_columns jsonb` object (not secret-checked: provider columns) |
| `period_publications` | pk(tenant_id,source_id,billing_period) — THE pointer; FK(tenant_id,source_id,billing_period,batch_id)→ingest_batches(…) so the pointer can only name a batch of the same source+period; FK(tenant_id,source_id,published_by_run_id)→sync_runs; unique(tenant_id,batch_id); the deferred `publication_consistency` trigger (RT003) makes the pointer name exactly the one `published` batch at every COMMIT |
| `source_checkpoints` | pk(tenant_id,source_id); FK→sources; FK(tenant_id,source_id,last_run_id)→sync_runs; `periods jsonb` object |
| view `cost_facts_published` | **Corrected (round 2):** definer-rights view `WITH (security_barrier = true)` — NOT `security_invoker` (BOUNDARY v2 D4, §10) — owned by `ratio_owner`; cost_facts ⋈ period_publications on (tenant, source, period, batch) ⋈ ingest_batches `status = 'published'`, plus `WHERE tenant_id = ratio.current_tenant_id()` |

Helper functions (schema `ratio`; all except `current_tenant_id` carry `SET search_path = pg_catalog, pg_temp`):
- `ratio.current_tenant_id()` STABLE, **SQL-standard body (round 2, M5)**:
  `RETURN NULLIF(pg_catalog.current_setting('ratio.tenant_id', true), '')::pg_catalog.uuid`.
  The body is parsed and bound at CREATE time, so the caller's `search_path`
  or a temp table named `uuid` cannot change it (the earlier `$$ … ::uuid $$`
  body could be broken by `CREATE TEMP TABLE uuid` — 42P13, a self-DoS, not a
  leak). No SET clause, so it is still inlined (EXPLAIN shows it as an index
  condition).
  The `NULLIF` matters: after any transaction that used `set_config(..., true)`
  the placeholder GUC remains defined with value `''` for the rest of the
  session; `''::uuid` would raise. With `NULLIF` an unset/reset tenant is
  `NULL` ⇒ policy false ⇒ zero rows, writes rejected. A malformed value raises
  `invalid input syntax for type uuid` (fails closed; returns no rows).
- `ratio.jsonb_has_secret_like_key(jsonb)` IMMUTABLE: recursive walk over all
  nested objects/arrays; true if any key matches (case-insensitive substring)
  `token|secret|key|pass|pw|sas|sig|credential|auth|private|bearer|cert|dsn|conn`
  (widened in round 2, L3). Deliberately fail-closed: false positives (e.g.
  `partition_key`, `design`, `connection_timeout`) are rejected too.
  Homoglyph keys (e.g. Cyrillic `tоken`) are NOT detected — documented limitation.
- Round 2 (L3): `ratio.text_looks_secret(text)` (URL userinfo `://…@`, `sig=`,
  `signature=`, `AKIA…`/`ASIA…` key ids, `Bearer `; case-insensitive) and
  `ratio.jsonb_has_secret_like_value(jsonb)` (every string value at any depth).
  Applied to `sources.config` (keys + values), `sync_runs.stats` (keys +
  values), `sync_runs.error_detail`, `ingest_batches.quarantine_reason`,
  `ingest_validation_errors.message`, `ingest_artifacts.artifact_name`.

## 4. Roles and tenancy

- `ratio_owner`, `ratio_worker`, `ratio_reader`, created idempotently in a DO
  block (`IF NOT EXISTS … CREATE ROLE … NOLOGIN`, with `duplicate_object` /
  `unique_violation` caught so concurrent migrations of different databases in
  one cluster cannot race). Then a guard (RT010): if any of the three is
  SUPERUSER, BYPASSRLS, REPLICATION or LOGIN (LOGIN since round 7), if worker/reader have CREATEROLE or
  CREATEDB, or if any of them is a member of any role, the migration RAISEs
  (fails closed rather than ALTERing roles). Since round 5 the runner's catalog
  check re-verifies these invariants (and pins role identity) after every
  migration.
  Roles are cluster-global and stay NOLOGIN. Deployment creates separate LOGIN
  roles that are members of them (`CREATE ROLE app_worker LOGIN … IN ROLE
  ratio_worker`); `ALTER ROLE ratio_worker LOGIN` is refused by 0001's guard
  (RT010) and reported as drift by the catalog check (round 7).
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
    ingest_artifacts, ingest_validation_errors, cost_facts (facts are immutable
    — no UPDATE); SELECT on the view. No DDL, not owner (cannot disable RLS).
    The exact effective set is `REVIEWED_PRIVILEGES.ratio_worker` in
    `privilegeModel.ts` (tested equal to what 0001 grants).
  - `ratio_reader`: **SUPERSEDED by §10 (D4)** — USAGE on the schema and
    SELECT on `cost_facts_published` ONLY; no base-table grant, no
    restrictive reader policy (the security_invoker design described in the
    first draft was never committed). Function EXECUTE: `current_tenant_id()` only (L4).
  - Round 2: worker additionally gets `UPDATE (row_count)` on
    `ingest_artifacts` (column-level only, orchestrator request for Slice 1) and
    EXECUTE on the guard helpers; `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA
    ratio FROM PUBLIC`.
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
| View bypassing RLS (definer rights) | owner `ratio_owner` is non-super/non-BYPASSRLS and bound by FORCE RLS; explicit tenant predicate in the view (round 2: corrected — the view is NOT security_invoker) | view isolation + real-login tests; mutation M1 |
| Reader sees staged/superseded/quarantined rows | reader has no base-table grant (42501); view joins `status = 'published'` and the pointer | reader matrix; mutations M3, M8 |
| Reader/worker escalation (DDL, disable RLS) | not owner, no CREATE on schema | DDL refused test |
| Secrets persisted in config / free text | no secrets column; CHECKs reject secret-like keys AND values recursively (config, stats) and secret-looking free text (error_detail, quarantine_reason, validation messages, artifact names) | key/value matrices |
| Float money corruption | numeric only; `pg` returns numeric as string | precision round-trip + catalog scan |
| Concurrent migrators corrupt schema | advisory lock + per-migration txn | concurrent runner test |
| Edited migration silently diverges | sha256 checksum ledger | tamper test |
| Migration leaking connection string | CLI redacts every string BEFORE JSON serialization (raw, URL-decoded, URL-encoded and JSON-escaped forms of the URL, user and password), then a backstop pass over the serialized line (round 6) | `cli.test.ts`, `cli.db.test.ts` (real pg error carrying the password); mutations H1–H5 |
| A migration widens a role's privileges, adds a SECURITY DEFINER function, or installs a hook that runs after the check (rounds 4–5) | runner catalog check as the last statement before COMMIT (privilegeModel.ts): reviewed privilege allow-list for reader/worker, SECURITY DEFINER allow-list, no PUBLIC EXECUTE in ratio/public, reviewed triggers only, no rules/event triggers, no ledger policies, pinned role identity | `privileges.db.test.ts`; mutation tables R4/R5 |
| A migration plants per-database / per-role setting defaults (`ALTER DATABASE … SET session_replication_role = replica`, `ALTER ROLE ratio_worker [IN DATABASE …] SET …`) that every new session inherits (round 8) | catalog check reads `pg_db_role_setting` rows that apply to this database: any setting on a ratio role, and security-relevant keys for any role here / all roles / ratio members, are refused; `--status` reports them | `privileges.db.test.ts`, `cli.db.test.ts` round 8; mutations S1–S7 |
| A migration (or drift) REMOVES or weakens the reviewed foundation: drops/disables a guard trigger, un-forces RLS, drops or opens a policy, replaces a guard function, drops/invalidates an FK, revokes the reader's view grant, drops schema `ratio` (round 10) | while the ledger records 0001, every entry of the generated manifest `FOUNDATION_0001` must be present in the catalog (per-migration check and `--status`) | `foundation.db.test.ts`, `cli.db.test.ts` round 10; mutations F0–F13 |
| SQL injection via tenant id | bound parameter + uuid validation | unit test |
| **Credential holder selects another tenant** (round 2, M5) | NONE at the DB layer: the tenant is a user-settable GUC; any holder of a worker/reader credential can `set_config('ratio.tenant_id', <any uuid>, true)`. RLS/tenant isolation defends against application bugs (missing/wrong tenant), NOT against credential holders. The alternative — per-tenant DB roles/credentials — is an owner decision | characterization test `documented trust boundary…` |
| Published data rewritten after publication (round 2, H2) | staged-only child trigger (RT001), TRUNCATE refused, batch lifecycle trigger (RT002), deferred pointer consistency (RT003), reconciliation CHECKs | `immutability.db.test.ts`; mutations M8–M11, M16–M18, M21 |
| Pre-existing dangerous roles (round 2, M1/M2) | 0001 guard RT010: SUPER/BYPASSRLS/REPLICATION, CREATEROLE/CREATEDB on worker/reader, any membership | `roles.db.test.ts`; M13, M19 |
| Migration smuggles a destructive or isolation-disabling statement (round 2, M3; round 3, M1) | **Text-based linter, defence in depth — code review of every migration is the primary control.** What is enforced: an expand allow-list; reasoned markers for ratio views (`ratio:allow-view`), functions/triggers (`ratio:allow-function`) and DO blocks (`ratio:allow-do`); an always-forbidden list (RLS disable/no-force, DISABLE TRIGGER, DROP/ALTER POLICY, permissive policies not using exactly the tenant predicate, any grant to ratio_reader beyond its three reviewed grants, grants to PUBLIC, role membership for ratio roles, role escalation, replacing current_tenant_id, session_replication_role), also applied to statements and string literals inside dollar-quoted bodies. Not enforced: semantics (e.g. a marked function that deletes rows, dynamic SQL built from non-literal pieces, a policy predicate that is exact but on the wrong column) | `migrationFiles.test.ts` |
| NaN/Infinity money (round 2, M4) | `abs(x) < 'Infinity'` on every money/quantity/total | NaN/±Infinity test; M12 |
| Tenant switched before COMMIT to blind the deferred check (round 3, H1) | the COMMIT-time check raises RT003 when RLS is active and `ratio.tenant_id` ≠ the row's tenant | `immutability.db.test.ts` H1 tests; mutation R3a |
| `ratio_owner` holds CREATEROLE (round 3, L3) | Allowed by the role guard (worker/reader may not) because a deployment may run first-time role creation as the owner. Risk: an owner login could create a new role and grant it ratio_worker/ratio_reader, or create login roles. Mitigation: owner credentials are migration-only (not used by the app/worker); deployment should grant CREATEROLE only for the first migration and revoke it after (owner decision) | documented |
| Triggers bypassed | only by the table owner (`ALTER TABLE … DISABLE TRIGGER`, refused by the migration linter) or a superuser (`session_replication_role = replica`, also linter-refused); worker/reader cannot | deny tests |

Out of scope here: worker startup role check (Slice 1), redaction of
`error_detail` by the worker before it is written (Slice 1; the DB CHECK only
refuses secret-looking text), any network surface (none exists).

## 7. Failure cases

- DB unreachable: runner throws; CLI exits 1 with JSON error; nothing applied.
- Migration SQL error: that migration rolled back, ledger unchanged, earlier
  migrations stay applied, runner exits non-zero.
- Process killed mid-migration: txn aborted by server; advisory lock released
  with the session; re-run applies from the same point.
- Lock holder hangs: other runners wait indefinitely (no lock timeout in v1 —
  gap; operator can `pg_terminate_backend`).
- Checksum/missing/out-of-order: refuse before touching anything.
- Role pre-exists with SUPERUSER/BYPASSRLS/REPLICATION, worker/reader with CREATEROLE/CREATEDB, or any ratio role is a member of any role: 0001 raises RT010, rolled back. (The catalog check re-verifies these after every later migration.)
- A migration's catalog effect deviates from the reviewed model: `PRIVILEGE_MODEL_VIOLATION`, that migration rolled back; `migrate --status` reports drift made outside the runner (exit 3).
- Migrating login lacks membership in ratio_owner: `SET ROLE` fails, rolled back.
- `test:db` without `RATIO_TEST_DATABASE_URL`: config throws ⇒ non-zero exit.

Known gaps carried forward: no `lock_timeout` on the migration lock; dynamic
`import()` with non-literal specifiers is not detectable by the boundary test.
(Value secret checks and the RT003 pointer/published consistency trigger exist
since round 2.)

## 8. Rollback plan

- Code: branch is unmerged; revert = do not merge / `git revert` the commits.
  App behaviour does not depend on any of it.
- Database (non-prod): `RATIO_ENV=test RATIO_ALLOW_DOWN_MIGRATIONS=1 RATIO_MIGRATE_DATABASE_URL=… npm run db:migrate -- --down 1`.
  Exactly what 0001's down does:
  - **Drops** (`DROP SCHEMA ratio CASCADE`): schema `ratio` and everything in
    it — all nine tables and their rows (all ingested data, evidence metadata,
    validation errors, runs, checkpoints), the view, the helper and trigger
    functions, triggers, RLS policies, indexes and constraints, and every
    privilege granted on those objects (grants die with their objects).
  - **Removes** (runner, same transaction): the `0001` row of
    `public.schema_migrations`.
  - **Keeps, deliberately:** the roles `ratio_owner`, `ratio_worker`,
    `ratio_reader` — with their attributes, their memberships and any LOGIN
    roles / passwords the deployment attached. Roles are cluster-global: other
    databases in the same cluster may use them, and `DROP ROLE` would fail (or
    break those databases) while anything there references them. A later `up`
    reuses them and its role guard re-checks them (RT010).
  - **Keeps:** the ledger table `public.schema_migrations` itself (it lives
    outside `ratio` precisely so it survives a down), and anything the
    deployment created outside schema `ratio`.
  To remove the roles on a dedicated cluster, after confirming no database
  references them: `DROP ROLE ratio_reader, ratio_worker, ratio_owner` (and
  drop or reassign the deployment's LOGIN members first).
- Production: down is refused by design (NODE_ENV/RATIO_ENV=production; since round 2 also any RATIO_ENV other than development/test/ci). Production
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
   `expand` migration is checked lexically at load (`EXPAND_NOT_ADDITIVE`).
   *As first written* this was a deny-list (`DROP`, `TRUNCATE`, `DELETE FROM`,
   `RENAME`, `ALTER COLUMN … TYPE`); since round 2 it is an allow-list of
   additive forms plus reasoned markers (§11, §12, §13), and since round 4 the
   runner's catalog check backs it. Still lexical, not a proof of backward
   compatibility. 0001 is `expand` (creates only new objects). Down files carry
   no phase.
2. **Down is dev/test only.** Refused (`DOWN_NOT_ALLOWED`) when
   `RATIO_ENV=production` OR `NODE_ENV=production`, and also unless
   `RATIO_ALLOW_DOWN_MIGRATIONS=1` (explicit opt-in even in dev). Auto-rollback
   in the pipeline never touches the DB; with expand-only migrations the
   previous release keeps working on the newer schema.
3. **Machine-readable status.** `npm run db:migrate -- --status --json`
   (CLI: `migrate --status --json`) prints exactly one JSON document on stdout:
   `{ expectedVersion, currentVersion, matches, applied:[{version,name,checksum,
   downChecksum,appliedAt,fileChecksum,fileDownChecksum,checksumMatches}],
   pending:[{version,name,phase,checksum}], unknownApplied:[versions in DB but
   not in code], privilegeProblems:[catalog-check lines], problems:[codes] }`
   (`downChecksum`/`fileDownChecksum` since round 2, `privilegeProblems` and the
   `PRIVILEGE_MODEL_VIOLATION` problem since round 5). Read-only (no lock, does
   not create the ledger; runs in a READ ONLY transaction). Exit 0 iff matches
   (every code migration applied, all checksums equal, no unknown applied
   versions, no privilege-model violation); exit 3 on mismatch; exit 1 on error
   (connection etc.). Without `--json` the same object is logged as one
   structured line.

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

## 11. Round 2 — challenger REQUEST CHANGES (applied; 0001 amended in place)

0001 has never been merged or applied outside dev/test, so it was amended in
place instead of adding 0002 (orchestrator decision). Any local dev database
migrated with the earlier 0001 will now fail `CHECKSUM_MISMATCH` and must be
recreated (that is the intended behaviour of the checksum ledger).

- **H1 harness.** Pool and per-client `'error'` listeners for the whole client
  life; `close()` bounds `pool.end()` (5 s; it never resolves with a leaked
  client), waits (≤10 s) for `pg_stat_activity` to show no backend on the DB,
  then `DROP DATABASE … WITH (FORCE)`.
- **H2 immutability (DB-enforced, applies to every role incl. superuser).**
  - `child_of_staged_batch` BEFORE INSERT/UPDATE/DELETE on `cost_facts`,
    `ingest_artifacts`, `ingest_validation_errors`: `SELECT status … FOR SHARE`
    of the parent batch; writes allowed only when `staged` (RT001). Decision:
    DELETE of a quarantined batch's rows is NOT allowed (D7: evidence and error
    detail of a quarantined revision are retained; no deletion code this cycle).
    Not-found parent ⇒ the trigger lets the composite FK / RLS reject the row
    with its own error. *(Superseded in round 3: a not-found parent is RT001.)*
  - `refuse_truncate` BEFORE TRUNCATE on facts, artifacts, validation errors,
    batches, publications (RT001).
  - `batch_lifecycle` BEFORE INSERT/UPDATE/DELETE on `ingest_batches` (RT002):
    INSERT must be `staged`; DELETE only `staged`; identity columns (tenant, id,
    source, period, artifact-set fingerprint, created_at) never change; a
    staged batch may change data and go to `published` or `quarantined`; for a
    non-staged batch every column except status/published_at/superseded_at is
    frozen and the only edges are published→superseded and
    superseded→published; exact no-op updates are allowed. Quarantined is terminal.
  - `publication_consistency` DEFERRABLE INITIALLY DEFERRED constraint trigger
    on `period_publications` and `ingest_batches`: at COMMIT, for every touched
    (tenant, source, period), a pointer exists iff a published batch exists and
    it names that batch (RT003). Deferred so Slice 1's publish order
    (supersede prior → publish new → upsert pointer) and replay order
    (supersede current → re-publish target → repoint) work in one transaction
    (tested as ratio_worker).
  - CHECKs: reconciled ⇒ ≥1 control and each present control equals the loaded
    value; variance ⇒ a control exists; published/superseded ⇒ (`unverified` ⇔
    no control). Combined with the frozen-columns rule this blocks the
    variance→unverified→published laundering path.
  - The view's `status = 'published'` join is kept as defence in depth. It is
    observable only inside an uncommitted transaction (a pointer temporarily
    naming a staged batch shows zero rows), which is what the mutation test M8
    relies on; at COMMIT the deferred trigger makes it redundant.
- **M1/M2 role guard (RT010)** — see §7. Tested inside rolled-back
  transactions (`BEGIN; ALTER/GRANT …; <0001>; ROLLBACK`, `lock_timeout` 10 s),
  so concurrent test databases never observe the dangerous state.
- **M3 classifier** — `expand` is an allow-list; FORBIDDEN list applies in every
  phase. DO blocks need `-- ratio:allow-do <reason>` on the line directly above
  (0001's role DO block carries one; since round 4 anywhere in the comment block
  directly above). The body of a marked DO block is not
  inspected — the marker is a reviewed escape hatch. *(Superseded in round 3:
  DO and function bodies, and the string literals in them, are scanned for
  forbidden statements.)* `REVOKE … FROM PUBLIC` is
  expand because releases never rely on PUBLIC privileges (GRANT TO PUBLIC is
  forbidden). Lexical: the classifier does not parse SQL fully.
- **M4** `abs(x) < 'Infinity'` (false for NaN in Postgres numeric ordering).
- **M5** see §3 + threat-model row "credential holder selects another tenant".
- **L1** ledger column `down_checksum`; drift/add/remove of a down file ⇒
  CHECKSUM_MISMATCH. **L2** down only for RATIO_ENV ∈ {development,test,ci}
  (trimmed, case-insensitive) and NODE_ENV ≠ production and the flag.
  **L3** §3. **L4** §4. **L5** CLI redacts the URL, userinfo, and any
  `password=` value (URL query, keyword DSN, quoted). *(Round 6: redaction now
  happens before serialization, §15.)* **L6** fast test forbids
  session-level tenant settings under `src/ingest`.
- **Orchestrator additions:** `GRANT UPDATE (row_count) ON ratio.ingest_artifacts
  TO ratio_worker` (column-level; trigger still staged-only); no purge/delete
  path added.
- Cost note: the child trigger does one indexed lookup + `FOR SHARE` per row;
  Slice 1's 200k-row load should measure it (a statement-level trigger with
  transition tables is the fallback).

## 12. Round 3 — challenger round 2 (applied; 0001 amended in place again)

- **H1** The deferred publication check runs under the session's tenant at
  COMMIT. A worker could change `ratio.tenant_id` (to '' or another tenant)
  after an inconsistent change; RLS then hid the rows and the check passed.
  Now: if `row_security_active` for `period_publications`/`ingest_batches`
  and `ratio.current_tenant_id()` ≠ the row's tenant ⇒ RT003. Superusers
  (RLS inactive) still get the full check. The staged-only child trigger now
  raises RT001 when the parent batch is not found/visible (no reliance on the
  FK/RLS running later); consequently tenant-B child inserts under tenant A
  fail RT001 instead of 42501.
- **L2** The check lives inside the trigger function; the separate
  `assert_publication_consistent` was removed, so the worker has no EXECUTE on
  any publication function. Verified: trigger functions need no EXECUTE at fire time.
- **M1** classifier rules — see the threat-model row (text-based, defence in
  depth). Decision: ratio_reader may receive only USAGE ON SCHEMA ratio,
  SELECT ON ratio.cost_facts_published and EXECUTE ON ratio.current_tenant_id()
  — in any schema (stricter than the request). Permissive policies must use
  exactly `(tenant_id = ratio.current_tenant_id())` or `(id = …)` in USING and
  WITH CHECK (stricter than "references"; blocks `… OR true`).
- **M2/M3** tests only (two-connection race; data columns riding along with a
  legal transition) — they kill mutations N1 and N14.
- **L1** accepted as documented.

## 13. Round 4 — challenger round 3 (M1, M2; 0001 NOT changed)

- **M1 — catalog check in the runner (the robust layer).** An unmarked expand
  migration could create a `SECURITY DEFINER` function (or a view) outside
  schema `ratio`; new functions are EXECUTE-able by PUBLIC, so every login
  read every tenant's rows (staged/quarantined included). The classifier only
  looked at `ratio` objects and at GRANT text. Now `migrateUp` / `migrateDown`
  call `assertReviewedPrivileges` (`src/ingest/db/privilegeModel.ts`) inside
  each migration's transaction, after `RESET ROLE` and before the ledger
  write. It reads the catalog and throws `PRIVILEGE_MODEL_VIOLATION` (the
  transaction rolls back, the run stops) when:
  1. `ratio_reader` / `ratio_worker` *effectively* hold (directly, via PUBLIC
     or via membership; `has_*_privilege`) any schema privilege
     (USAGE/CREATE), relation privilege (table-level, sequence, or
     column-level not covered by a table-level grant) or function EXECUTE
     beyond `REVIEWED_PRIVILEGES` — the ONE explicit allow-list, equal to
     0001's grants (+ `schema:public:USAGE`, PostgreSQL 15+'s PUBLIC default).
     Relations/functions count only in schemas the role can use; USAGE itself
     is checked; pg_catalog/information_schema are excluded;
  2. any `SECURITY DEFINER` function outside pg_catalog/information_schema is
     not both owned by `ratio_owner` and on `REVIEWED_SECURITY_DEFINER_FUNCTIONS`
     (empty — 0001 defines none);
  3. PUBLIC holds EXECUTE on any function in schemas `ratio` or `public`.
  A later migration that legitimately widens a role's privileges must update
  the allow-list in the same change (visible in review). Slice 1's worker
  grants are exactly 0001's and pass unchanged (Slice 1 branch merged with this
  fix in a scratch worktree: test:db 224/224, fast 419/419).
- **M1 — classifier (lexical, defence in depth).** `CREATE FUNCTION|PROCEDURE`
  and `CREATE [RECURSIVE|MATERIALIZED] VIEW` in ANY schema (qualified or not)
  are expand only with a reasoned `ratio:allow-function` / `ratio:allow-view`
  marker; `CREATE OR REPLACE` and TEMP views are never expand. `SECURITY
  DEFINER` in any statement (CREATE, ALTER FUNCTION/ROUTINE/PROCEDURE), in any
  phase, needs its own `-- ratio:allow-security-definer <reason>` marker, and
  is always refused inside DO/function bodies and their string literals.
  Markers are now read from the whole comment block directly above a statement
  (so a SECURITY DEFINER function carries both markers). A marked SECURITY
  DEFINER still fails at the runner unless reviewed into the allow-list.
- **Not done: `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC` in
  0001.** Default ACLs are per creating role; the repro function was created by
  the migrating superuser, which 0001 cannot name portably, and `FOR ROLE
  ratio_owner` would leave `pg_default_acl` entries that block `DROP ROLE` in
  the shared cluster and that the down file would have to undo. The runner
  check (3) catches the PUBLIC default regardless of who created the function,
  so 0001 (and its checksums) stays unchanged.
- **Operational consequence (fail closed):** a database where extensions were
  installed into `public` (functions EXECUTE-able by PUBLIC) refuses every
  migration until those functions are revoked from PUBLIC or the extension is
  moved to its own schema the ratio roles cannot use. Flagged for the owner.
- **M2** test only: the delete twin (and artifact-UPDATE twin) of the
  insert-path race test, which kills "remove the OLD-path FOR SHARE".

## 14. Round 5 — challenger round 4 (M1, L1–L4; 0001 NOT changed)

- **M1 — nothing a migration installs runs after the check.** Transaction
  order, up and down: migration SQL → `RESET ROLE`, `SET LOCAL search_path =
  pg_catalog, pg_temp`, `SET CONSTRAINTS ALL IMMEDIATE` (queued deferred
  constraint triggers fire now) → ledger INSERT/DELETE (any ledger trigger
  fires now) → `assertReviewedPrivileges` as the LAST statement → COMMIT. The
  check also refuses: any user trigger (including constraint triggers) that is
  not on `REVIEWED_TRIGGERS` (0001's 11) or whose function is not a
  `ratio_owner` function in schema `ratio`; any rule other than view `_RETURN`
  rules outside the system schemas; any event trigger; RLS or any policy on
  `public.schema_migrations`. A later migration that adds a trigger updates
  `REVIEWED_TRIGGERS` in the same change.
- **Status:** `migrate --status` runs the check in a READ ONLY transaction:
  `privilegeProblems` in the JSON, problem `PRIVILEGE_MODEL_VIOLATION`, exit 3.
- **L1:** the check pins `search_path = pg_catalog, pg_temp` itself
  (transaction-local, via `pg_catalog.set_config`) before its queries, in
  addition to the runner's `SET LOCAL`; status runs inside a transaction for
  that reason.
- **L2 (robust option, not a lexical rename ban):** role identity is checked in
  the catalog. While schema `ratio` exists the three ratio roles must exist.
  They must keep their safe attributes and be members of no role. Members of a
  ratio role must be LOGIN roles. Every other role (not superuser, not
  predefined `pg_*`, not a member of `ratio_owner`) may hold on schema `ratio`
  and its objects only what its `ratio_reader`/`ratio_worker` memberships are
  reviewed for. That check is what catches a renamed role that keeps its
  grants and members, and LOGIN members with extra grants. Roles are checked by
  OID, so test logins dropped concurrently cannot make the check error.
  Consequence (fails closed): a cluster role in `pg_read_all_data` (or any role
  with privileges on ratio objects) refuses migrations.
- **L4:** database CREATE/TEMPORARY/CONNECT are now checked; CONNECT and
  TEMPORARY are the reviewed PUBLIC defaults. Also checked: `GRANT … ON
  PARAMETER` (`pg_parameter_acl`, cluster-global), FDW and foreign-server
  USAGE, and large-object ACLs and ownership. Types and languages are not
  enumerated: every type has PUBLIC USAGE by default and that is harmless.
  Language USAGE only matters with CREATE on a schema, which is checked, and
  untrusted languages cannot be granted. `lo_compat_privileges` is not checked.
- Remaining by design: code a migration runs *during* its own SQL (e.g. COPY
  TO PROGRAM as superuser, dblink) can have effects outside the transaction;
  migrations are reviewed and contract needs `--allow-contract`. Trigger
  function bodies of the reviewed triggers are pinned by name and owner, not
  by body hash. *(Superseded in round 10: function definitions are pinned by
  hash in the required-foundation manifest, §19.)*

## 15. Round 6 — Copilot review of 453377e (High + 3 doc Lows)

- **High — redaction after `JSON.stringify`.** The CLI serialized each line
  and only then redacted it, so JSON escaping could hide a secret: a password
  `ab"cd` (or `ab%22cd` in the URL) inside a pg error left as `ab\"cd`
  (reproduced end-to-end: the password doubles as the missing database name, so
  the server's `database "<pw>" does not exist` carries it). Now:
  - `secretForms()` derives, for every configured secret (URL, user ≥ 3 chars,
    password, `pass*` query/keyword values), the raw, URL-decoded and
    URL-encoded forms and the JSON-escaped form of each;
  - `redactDeep()` deep-copies the value to be printed, redacting every string
    and object key, walking arrays, Errors (message, code, cause) and `toJSON`
    results; cycles become `[circular]`;
  - `jsonLineRedactor()` = `redactDeep` → `JSON.stringify` → the string
    redactor again over the serialized line (backstop; catches e.g. a numeric
    value equal to a secret). It is the only way the CLI produces output:
    every log/error line and `status --json`. (Evidence records belong to
    Slice 1's CLI, which is not on this branch.)
- **Doc Lows:** §3 schema table now matches 0001 (`quarantined` /
  `quarantine_reason`, `sha256` / `artifact_sha256`, finite-value and
  secret-value CHECKs, `ingest_validation_errors`); the stale "pointer not
  enforced" gap is removed from EVIDENCE (RT003 exists and is tested); §8 and
  EVIDENCE §7 state exactly what down drops and keeps, and why.

## 16. Round 7 — Copilot review of 19fdbed (3 High, 1 Medium, + Low 1)

- **High A — session-scoped settings outlived COMMIT.** The pinned
  `SET LOCAL search_path` only masked, until COMMIT, a session-level
  `SET search_path = attacker, pg_catalog` that a contract migration ran; the
  next migration of the run then resolved `current_setting` and `=` through
  schema `attacker` (reproduced). Fix: `resetSession()` (see §2) before the
  lock and after every migration transaction. Chosen over a fresh connection
  per migration: the advisory lock belongs to this session, and a new
  connection would inherit `ALTER ROLE/DATABASE … SET` defaults a migration
  could also plant, which the explicit session-level SET overrides. The
  advisory lock calls are `pg_catalog`-qualified. `RESET ROLE` is redundant
  with `SET SESSION AUTHORIZATION DEFAULT` (which also resets the current
  user) and kept as belt and braces.
- **High B — 0001 accepted a pre-existing LOGIN `ratio_*` role.** The RT010
  guard now also rejects `rolcanlogin`. 0001 is edited in place: it has never
  been applied outside dev/test (no deployed database), so any dev database
  migrated with the previous bytes reports `CHECKSUM_MISMATCH` and must be
  recreated; the down file is unchanged.
- **High C — LOGIN invisible to the drift check.** The catalog check reports
  `role <ratio role> must not have LOGIN …`; `--status` and the per-migration
  backstop therefore see `ALTER ROLE ratio_owner LOGIN`.
- **Medium — backstop could emit invalid JSON.** `redactDeep` redacts a
  number/boolean/bigint whose text matches a secret to the string
  `"[redacted]"` (bigints always become strings). The backstop pass is
  JSON-aware: if its edit leaves text that no longer parses, the CLI prints
  `{"error":"output redacted"}` instead.
- **Low 1.** The pg `Client` is constructed inside `main`'s try (its
  constructor throws on e.g. an invalid port or unreadable `sslcert`), and
  `installProcessHandlers()` prints one redacted JSON line on
  `uncaughtException` / `unhandledRejection` and exits 1.

## 17. Round 8 — challenger approval of 7c5b6e2, Lows folded in

- **L1 — setting defaults (`pg_db_role_setting`).** `ALTER DATABASE … SET` and
  `ALTER ROLE … [IN DATABASE …] SET` apply to every NEW session, so a contract
  migration could make every later worker session run with
  `session_replication_role = replica` (no RT001–RT003, no FK checks). The
  catalog check (every migration, and `--status`) now refuses, among rows that
  apply to THIS database (`setdatabase` = this database or 0 = all):
  - any setting on a ratio role itself (they are NOLOGIN and configured only by
    migrations);
  - a security-relevant key — `session_replication_role`, `row_security`,
    `search_path`, `default_transaction_read_only`,
    `default_transaction_isolation`, `role`, `session_authorization` — for any
    role in this database (`ALTER DATABASE`, `ALTER ROLE x IN DATABASE this`),
    for all roles (`ALTER ROLE ALL`), or for a member of a ratio role.
  Decision: targeted rather than "refuse every row", so a deployment's benign
  per-database defaults (e.g. `statement_timeout`) stay allowed. Rows scoped to
  another database are not counted: they cannot affect sessions here, and
  counting them made one database's drift fail every other database's
  migrations in a shared cluster (observed in testing; see EVIDENCE R8).
- **L2.** Tests now pin two previously untested pieces: the try/catch around
  building the process-handler line (a `toJSON` that throws with the DSN
  yields the fixed line and exit 1) and the session reset before the lock (a
  caller client with a hostile session `search_path` / `row_security`).
- **L3.** `redactDeep` prints Buffers, typed arrays and ArrayBuffers as
  `"[binary]"`.

## 18. Round 9 — challenger approval of 325b059, Low 1/2 folded in

- **L1 — default tenant through setting defaults.** A contract migration could
  run `ALTER DATABASE <db> SET ratio.tenant_id = '…'` (built with `format()`
  in a DO block); every new session — e.g. a reader that never calls
  `set_config` — then had a tenant and saw that tenant's published rows
  instead of zero (reproduced in `privileges.db.test.ts`). The same held for
  `ALTER ROLE <member login> SET ratio.tenant_id`. Fix:
  `isSecurityRelevantSetting()` treats ANY `ratio.*` custom setting
  (case-insensitive) as security-relevant, so the round-8 scope rules refuse
  it for this database (any role), for ALL roles, and for members of ratio
  roles; anything on a ratio role itself was already refused. Applies in
  every migration's check and in `--status`.
- **L2.** `lo_compat_privileges`, `session_preload_libraries` and
  `local_preload_libraries` join the security-relevant keys.

## 19. Round 10 — Copilot on 17f07d7: the reviewed foundation must be PRESENT

The catalog check refused extras but never required the reviewed objects:
`DROP TRIGGER child_of_staged_batch ON ratio.cost_facts` in a contract
migration produced no extra catalog row and committed, and `DROP SCHEMA ratio
CASCADE` after apply left `--status` at `matches: true`.

- **Manifest.** `foundationSnapshot()` (privilegeModel.ts) renders every 0001
  object as one normalized line: the schema owner; each table (owner, RLS
  enabled AND forced); each column (type, NOT NULL, md5 of the default);
  each policy (table, name, command, permissive, roles, md5 of USING / WITH
  CHECK); each trigger (table, function, `tgenabled = 'O'`, `tgtype` =
  timing/events/level, deferrable, initially deferred — so RT003 stays
  DEFERRABLE INITIALLY DEFERRED); each function in `ratio` (owner, SECURITY
  DEFINER flag, md5 of `pg_get_functiondef` — body, `proconfig`, volatility;
  this pins the trigger and tenant function bodies); the view (owner,
  reloptions incl. `security_barrier` / `security_invoker`, md5 of the view
  definition); each constraint (type, `convalidated`, md5 of the definition);
  each index (md5 of the definition); and the reader/worker ratio-scope
  grants (e.g. the reader's SELECT on the view). Definitions are hashed from
  PostgreSQL's own deparse with `search_path = pg_catalog, pg_temp`.
- **Generated, not hand-written.** `FOUNDATION_0001` (foundationManifest.ts,
  306 entries) is produced by `scripts/ingest/generate-foundation-manifest.mjs`
  from a fresh apply of 0001 (run after `npm run worker:build`; the script
  applies 0001 directly in a scratch database and drops it). A DB test asserts
  that a fresh apply equals the stored constant, so they cannot drift
  silently. The hashes are PostgreSQL-16 deparse output (CI and local are 16);
  a major-version upgrade regenerates the manifest.
- **Rule.** When (and only when) the ledger records `0001`, every manifest
  entry must be present; each missing or altered one is reported as
  `required 0001 object missing or altered: <entry>`, most significant first
  (schema, table, trigger, policy, function, view, privilege, constraint,
  index, column), by every migration's check and by `migrate --status`
  (exit 3). Before 0001 is applied, and after it is reverted, absence is fine.
  Extra objects added by later migrations are not foundation violations (the
  privilege/hook/setting rules govern them); a later migration that
  intentionally changes a 0001 object must regenerate the manifest in the same
  reviewed change.
- `convalidated` is pinned explicitly although `pg_get_constraintdef` already
  prints `NOT VALID` for an unvalidated constraint (so the definition hash
  catches it too; see the mutation table).

## 20. Round 11 — challenger M1 + Lows on 0b041c5

- **M1 — extra policies.** Policies were the only object kind where extras
  still passed (the linter matched literal text only; `'CREATE ' || 'POLICY
  open_all ON ratio.cost_facts USING (true)'` in a DO block was applied, and
  because permissive policies are ORed, a worker with tenant B then saw
  tenant A's rows). Now any policy on a table in schema `ratio` must be either
  a `FOUNDATION_0001` entry or of a reviewed SHAPE (`REVIEWED_POLICY_SHAPES`:
  the 0001 `tenant_isolation` policies without the table name — command,
  permissive, roles, USING / WITH CHECK hashes), so a later migration's new
  ratio table may use the reviewed tenant policy and nothing else. The rule
  applies whether or not 0001 is in the ledger (if the schema exists), in
  every migration's check and in `--status`. **Decision: RESTRICTIVE policies
  are refused too** — their expressions run for every candidate row and may
  call functions (a leak channel), and they can deny service; none is
  reviewed. A new policy shape is a reviewed code change to
  `REVIEWED_POLICY_SHAPES`.
- **L1 — dump stability.** `pg_dump` → restore rewrote
  `length(artifact_name) BETWEEN 1 AND 1024` (combined with further ANDs), so
  the definition hash failed closed after a restore. 0001 (never deployed;
  edited in place, dev databases report CHECKSUM_MISMATCH by design, down file
  unchanged) now writes `length(…) >= 1 AND length(…) <= 1024`. A DB test
  dumps a migrated database with `pg_dump` and restores it with `psql` into a
  fresh database: the manifest still matches and the check passes. That test
  showed no other 0001 construct changes on a round trip (the remaining
  single-BETWEEN CHECKs survive it). It needs PostgreSQL 16 client tools
  (`pg_dump`/`psql`, or `RATIO_PG_DUMP` / `RATIO_PSQL`) and is never skipped;
  CI's ubuntu-latest image ships them.
- **L2.** A policy role change (`ALTER POLICY … TO ratio_owner`, split
  keyword) is refused (roles are part of the policy entry).
- **L3.** Table entries pin `relpersistence` and `relreplident` (`REPLICA
  IDENTITY FULL` is refused; UNLOGGED cannot be set on any 0001 table because
  of their FKs, so persistence is pinned for completeness). Column defaults
  of columns added later are NOT inspected — decision: a default is evaluated
  in the inserting session under that session's own tenant, and the RLS
  WITH CHECK still decides what may be written; a default cannot read another
  tenant's rows through RLS.

## 21. Round 12 — challenger on 8079351 (1 High: flaky test; Lows)

- **H1 — test race, not a product defect.** The round-8 leak checks counted
  the whole cluster-wide `pg_db_role_setting`, while other test files commit
  (and later drop) rows scoped to their own disposable databases in parallel
  (1 failure in 25 runs). `settingRows()` now counts only rows this test
  could leak: all-databases rows (`setdatabase = 0`) and rows of the test's
  own database. The other tests that snapshot cluster-global catalogs were
  reviewed: `roles.db.test.ts` only reads ratio-role attributes and
  memberships OF the ratio roles, which no test commits (all such probes are
  rolled back); nothing snapshots `pg_parameter_acl`, role counts or
  `pg_database`.
- **L1 — per-table rule.** Every table in schema `ratio` (0001's and any later
  one) must have RLS enabled AND forced, be permanent (not UNLOGGED), and
  carry at least one reviewed policy. No relation may inherit from, or be a
  partition of, a `ratio` table (or the reverse), because inheritance or
  partitioning would route rows around the parent's policies. This applies
  whether or not 0001 is in the ledger, in every migration's check and in
  `--status`. Probe tables in the tests moved to schema `public`.
- **L2.** Tests now kill the surviving policy-shape mutants:
  - G3: `tenant_isolation` with `USING (true)` on a new table;
  - G2: the reviewed name and predicate `TO ratio_reader` only;
  - G4: the reviewed predicate under another name;
  - G5: `ALTER TABLE … SET UNLOGGED` on a new ratio table, refused by the
    permanent-table rule. 0001 tables cannot be made UNLOGGED because of their
    FKs.
- **L3 — CI.** The DB step uses pinned PostgreSQL 16 client tools for the
  `pg_dump` round-trip test. They are installed as `postgresql-client-16`
  when the runner image lacks them, and passed as `RATIO_PG_DUMP` /
  `RATIO_PSQL`. The test still fails (never skips) when they are missing.
  This is a restricted CI change.
- **L4 — "exact predicate, wrong column".** Decision (simple): the tenants
  table's `id = ratio.current_tenant_id()` policy is not a reusable shape. It
  is allowed only as its exact 0001 entry on `ratio.tenants`. The remaining
  reusable shape is `tenant_id = ratio.current_tenant_id()`, which cannot be
  created on a table without a uuid-comparable `tenant_id` column. A table
  whose `tenant_id` column is not actually the tenant is a semantic error that
  review must catch (residual, documented).
