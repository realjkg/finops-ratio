# Slice 0 — operational evidence

Branch `slice/00-postgres-foundation`, created from `origin/slice/00a-ci-deps`
@ `ec68902`. Sections 1–10 are the round-1 record (point in time); each later
round is appended below it. Since then the orchestrator has pushed the branch,
merged `origin/main` into it (453377e) and opened the PR; implementers commit
locally only. Where a round-1 statement is no longer true it is marked here.

Raw outputs referenced below are files next to this one in
`scratchpad/slice0/` (`red-*.txt`, `v-*.txt`, `mutations.txt`).

## 1. Commit order (audit trail)

| # | Hash | Subject | Kind |
|---|---|---|---|
| 1 | 27fbbfa | chore(deps): add pg and @types/pg for ingestion schema | deps |
| 2 | cd32055 | test(ingest): add failing Slice 0 tests for Postgres foundation | tests (red) |
| 3 | 631034f | test(ingest): correct four test defects and probe SET ROLE from a real login | test fixes (still red: no impl committed) |
| 4 | 35e3577 | test(ingest): assert the exact set of composite foreign keys | test added (still red) |
| 5 | 3b43292 | feat(ingest): Postgres foundation — schema ratio, roles, RLS, migration runner | implementation |
| 6 | 311b92f | ci: run the ingestion DB suite and a migration smoke test on Postgres 16 | CI |

Honest note on order: commits 3 and 4 were written after the implementation
existed in the working tree (uncommitted) — the first run against it exposed 4
defects in the tests themselves (commit 3) and a mutation check exposed a gap
(commit 4). Both are test-only commits placed before the implementation commit;
no assertion was weakened (details in §3).

## 2. Red evidence (tests before implementation, at commit cd32055)

`npx vitest run src/ingest` → exit 1 (`red-fast.txt`):
```
 FAIL  src/ingest/cli.test.ts            Error: Cannot find module './cli'
 FAIL  src/ingest/db/migrate.test.ts     Error: Cannot find module './migrationFiles'
 FAIL  src/ingest/db/migrationFiles.test.ts  Error: Cannot find module './migrationFiles'
 FAIL  src/ingest/db/tenant.test.ts      Error: Cannot find module './tenant'
 Test Files  4 failed | 2 passed (6)
      Tests  6 passed (6)
```
The 2 passing files are expected to pass before the implementation:
`importBoundary.test.ts` is a regression guard over existing code (no
violations exist today; its self-tests prove the detector works), and
`requireTestDatabaseUrl.test.ts` tests the runner guard committed with the tests
as test infrastructure.

`RATIO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:db` → exit 1 (`red-db.txt`):
```
 FAIL  src/ingest/cli.db.test.ts         Error: Cannot find module './db/testing/harness'
 FAIL  src/ingest/db/migrate.db.test.ts  Error: Cannot find module './testing/harness'
 FAIL  src/ingest/db/reader.db.test.ts   (same)
 FAIL  src/ingest/db/schema.db.test.ts   (same)
 FAIL  src/ingest/db/tenancy.db.test.ts  (same)
 FAIL  src/ingest/db/testing/harness.db.test.ts  Error: Cannot find module './harness'
 Test Files  6 failed (6)
```
`npm run test:db` with the variable unset → exit 1 (`red-db-nourl.txt`):
`Error: RATIO_TEST_DATABASE_URL is not set. … refusing to run (tests are never skipped).`

First run with the implementation in the working tree (before commit 3):
`Tests 5 failed | 56 passed (61)` — all five were test defects:
1. migrate.db expected-table list lacked `ingest_validation_errors` (BOUNDARY v2 table).
2. schema.db FK query returned `name[]`, which node-pg returns as a string → cast to `text[]`.
3. tenancy.db tenant-B artifact insert failed with 42P08 (untyped bind params in `||`) before reaching RLS → typed the params; it now fails with 42501 RLS as intended.
4/5. `SET ROLE ratio_owner|ratio_worker` succeeded from the superuser test session because Postgres checks SET ROLE against the *session* user. Not an escalation for real logins. Moved to a new test that connects as a genuine LOGIN member of each role (denied, 42501).

## 3. Mutation checks (do the tests have teeth?)

Each mutation was applied temporarily to `0001_ratio_schema.up.sql`, the DB
suite run, and the file restored byte-identically (`cmp`). Output in `mutations.txt`.

| Mutation | Result |
|---|---|
| M1 view gets `security_invoker = true` | 5 tests fail (reader view tests, definer-rights test, real-login test) |
| M2 `current_tenant_id()` without `NULLIF` | 6 fail (no-tenant, previous-txn, malformed, reader tests) |
| M3 `GRANT SELECT ON ratio.cost_facts TO ratio_reader` | 3 fail |
| M4 secret-key regex without `sig` | 1 fails (secret matrix) |
| M5 drop FORCE RLS on cost_facts only | 1 fails (catalog RLS test; the view's explicit tenant predicate still filters, by design) |
| M6 drop FORCE RLS everywhere + view tenant predicate | 7 fail |
| M7 drop the sync_runs→sources FK | **survived** at first → added `exactly the expected composite foreign keys exist` (commit 35e3577); re-run: 1 fails |

## 4. Verification (clean clone of the branch at 311b92f, `scratchpad/slice0/clone`)

Run in a fresh `git clone` because the main checkout contains another agent's
locked git worktree under `.claude/worktrees/` (branch `sec/pr41-findings`),
which vitest picks up and which has 6 failing tests of its own (also failing on
the untouched base). It is not part of this branch and was not modified.

| Command | Result |
|---|---|
| `npm ci` | exit 0; 369 packages. `npm audit` reports 8 vulnerabilities (brace-expansion, braces, chokidar, fast-glob, micromatch, next, tailwindcss, xlsx) — all pre-existing, none in `pg`/`@types/pg` |
| `npm run lint` | exit 0 |
| `rm -rf .next && npx tsc --noEmit` | exit 0 |
| `npm test` (RATIO_TEST_DATABASE_URL unset) | exit 0 — 28 files / 309 tests passed. Base commit ec68902 in the same clone: 22 files / 275 tests. Delta = 6 new fast files / 34 new tests; all 275 pre-existing tests still pass |
| `RATIO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:db` | exit 0 — 6 files / 63 tests passed, 0 skipped. Repeated 5 more times: 63/63 each run (`v-testdb-repeat.txt`). After the runs: 0 leftover `ratio_test_%` databases, 0 leftover `ratio_test_login_%` roles |
| `npm run test:db` (variable unset) | exit 1, "RATIO_TEST_DATABASE_URL is not set … refusing to run" |
| `grep -rnE '\.(skip\|only\|todo\|fails)\b\|skipIf\|runIf' src/ingest` | no matches |
| migrate up/down/up on scratch DB `ratio_scratch_migrate` via built CLI (`v-migrate.txt`) | status before: exit 3 `PENDING`; `npm run db:migrate`: applied `0001`, exit 0; status: `matches:true`, exit 0; re-run: `applied:[]`; `--down 1` without opt-in: `DOWN_NOT_ALLOWED`, exit 1; with `RATIO_ENV=production`: `DOWN_NOT_ALLOWED`, exit 1; with `RATIO_ALLOW_DOWN_MIGRATIONS=1`: reverted `0001`, schema `ratio` gone, ledger empty; up again: applied `0001`; status `matches:true`, exit 0. Scratch DB dropped |
| same as a NON-superuser login (member of ratio_owner, owner of the DB; roles pre-existing) (`v-migrate-nonsuper.txt`) | up exit 0, status exit 0, down exit 0. Scratch DB and login role dropped |
| `npm run worker:build` | exit 0 → `dist-worker/ingest/{cli.js,db/migrate.js,db/migrationFiles.js,db/tenant.js,db/migrations/*.sql}` (harness/tests excluded) |
| `npm run build` | exit 0 (base build not re-run for comparison; no file under `pages/` changed, see next row); then `git checkout tsconfig.json next-env.d.ts` (both had been rewritten by Next; restored) |
| `git diff --name-only ec68902..HEAD -- pages src \| grep -v ^src/ingest/` | none — no existing page, route or `src/` module changed |
| `grep -rlE 'pg-protocol\|ratio\.tenant_id\|schema_migrations' .next --include=*.js` | none — `pg` and ingestion code are not in the Next bundles |
| CI (`.github/workflows/ci.yml`) | edited, YAML parses; NOT executed (no push). Note: the workflow triggers only on push/PR to `main`, so a PR based on `slice/00a-ci-deps` will not run it until retargeted |

## 5. Complete test list (round-1 snapshot; current totals are in the latest round's verification table)

Fast suite (`npm test`, no DB) — 34 tests:
- `src/ingest/cli.test.ts`: unknown command exits 2; rejects unknown flags; --down requires a positive integer; missing RATIO_MIGRATE_DATABASE_URL exits 1; down is refused before connecting when not allowed; connection errors never echo the database URL or password
- `src/ingest/db/migrationFiles.test.ts`: orders migrations by version and pairs down files; checksum is sha256 of the raw up-file bytes; rejects malformed filenames; rejects duplicate versions; rejects a down file without an up file; rejects a missing migrations directory; rejects an up migration without a ratio:phase header; rejects an invalid or duplicated phase header; rejects an expand migration containing destructive statements; allows destructive statements in a contract migration and ignores them in comments/bodies; rejects migration files containing transaction control; the shipped migrations directory loads cleanly and 0001 is expand; detects transaction-control statements; ignores transaction keywords inside dollar quotes, comments, strings and identifiers
- `src/ingest/db/migrate.test.ts`: refuses without RATIO_ALLOW_DOWN_MIGRATIONS=1; refuses when NODE_ENV=production even with the flag; refuses when RATIO_ENV=production even with the flag; allows down in non-production with the explicit flag; migrateDown rejects non-positive / non-integer steps without touching the database
- `src/ingest/db/tenant.test.ts`: rejects non-uuid tenant ids before touching the database; sets the tenant with a bound, transaction-local set_config and commits; rolls back and releases on error
- `src/ingest/db/testing/requireTestDatabaseUrl.test.ts`: throws when unset; throws when blank; returns the URL when set
- `src/ingest/importBoundary.test.ts`: no file under pages/ or src/ (outside src/ingest) imports src/ingest or pg; detector flags every import form (self-test); detector ignores unrelated imports (self-test)

DB suite (`npm run test:db`) — 63 tests:
- `migrate.db.test.ts` (13): applies every migration to an empty database and records checksums; re-running is a no-op; refuses on checksum change; refuses on missing applied file; refuses out-of-order; failing migration rolled back completely and stops the run; unmarked migration refused, nothing applied; contract refused without allowContract, applied with it; two concurrent runners: exactly one applies, the other waits on the lock (observed in pg_locks) then no-ops; down 1 → pre-migration catalog state, up re-applies; down refused without flag and in production (NODE_ENV and RATIO_ENV); down refused with no down file; down refuses more steps than applied
- `schema.db.test.ts` (22): RLS enabled+forced on every table; tenant_id uuid not null; every FK composite incl. tenant_id; exact expected FK set; money unconstrained numeric, no float types; timestamps timestamptz; view definer-rights (not security_invoker), all objects owned by ratio_owner (non-super, non-BYPASSRLS); sources has no secret-bearing column; roles NOLOGIN/not super/not BYPASSRLS/no CREATEROLE/CREATEDB/no cross-membership; numeric round-trip (0.1+0.2=0.3, 60-digit, negative); secret-looking keys rejected at any depth (16 cases); non-secret config accepted; config must be an object; update adding a secret key rejected; one running run per source; one published batch per period; billing_period first-of-month; ISO-shaped currency; quarantined needs reason and `rejected` no longer valid; validation errors capped at 1000 and FK'd to an artifact; artifacts: hex sha256 + content-addressed evidence_key only (no URLs/signatures); variance batch cannot be published
- `tenancy.db.test.ts` (14): worker A sees none of B's rows in any table; cannot update B rows; cannot delete B rows; cannot insert rows with B's tenant_id (7 tables, 42501 RLS); cannot reassign own row to B; no tenant ⇒ zero rows + insert rejected; tenant from previous txn gone; malformed tenant errors (22P02) not data; composite FK rejects A batch → B source (even as superuser); FKs reject publication/fact whose source/period disagree; view shows only the caller's published batch (never staged/superseded/quarantined); worker cannot write tenants/sources, update facts/validation errors/artifacts, DDL, disable RLS, drop policy, alter view, replace functions; real LOGIN member of worker/reader cannot SET ROLE to owner/other role/postgres and is RLS-bound; withTenantTransaction scopes tenant to one transaction (integration)
- `reader.db.test.ts` (6): reader holds exactly one privilege (SELECT on cost_facts_published); permission denied (42501) on SELECT/INSERT/UPDATE/DELETE/TRUNCATE of every base table incl. `SELECT * FROM ratio.cost_facts`, with and without tenant; cannot write through the view or run DDL (exact SQLSTATEs); sees only own tenant's published rows via the view; staged/superseded/quarantined rows never appear; zero rows with no tenant, error with malformed tenant
- `cli.db.test.ts` (5): --status --json pending ⇒ exit 3, read-only (ledger not created); match ⇒ exit 0; checksum drift / unknown applied version ⇒ exit 3; --json prints exactly one JSON document, plain status one log line; CLI down needs explicit flag and reverts
- `testing/harness.db.test.ts` (3): unique database created and dropped; migrate option leaves DB fully migrated; two test databases isolated

## 6. Test fixture provenance

All fixtures are SYNTHETIC. `src/ingest/db/testing/fixtures.ts`: hand-made
UUIDs (`aaaaaaaa-…`, `bbbbbbbb-…`), invented amounts (10.10, 20.20, 99.99,
1000.01, 5555.55), provider "SyntheticCloud", sha256 values are hashes of fixed
labels (not of real files). Migration tests use synthetic SQL migrations written
to temp dirs. No real provider export, account ID, hostname or credential is
used anywhere. Nothing here demonstrates real-source ingestion.

## 7. Rollback procedure

- Code: nothing merged; drop the branch or `git revert` 3b43292/311b92f. No
  existing app behaviour depends on it.
- DB (dev/test only): `RATIO_MIGRATE_DATABASE_URL=<owner url> RATIO_ALLOW_DOWN_MIGRATIONS=1 npm run db:migrate -- --down 1`
  (plus `RATIO_ENV=development|test|ci`, required since round 2). Refused when
  NODE_ENV or RATIO_ENV is production. Exactly what it does (DESIGN §8):
  - drops schema `ratio` with CASCADE — every table and row in it (all
    ingested data), the view, functions, triggers, policies, indexes, and the
    grants on those objects;
  - deletes the `0001` row from `public.schema_migrations` (same transaction,
    followed by the catalog privilege check);
  - does NOT drop the roles `ratio_owner` / `ratio_worker` / `ratio_reader`
    (nor their memberships, attributes or the deployment's LOGIN roles): roles
    are cluster-global and may be used by other databases in the cluster, so a
    per-database down must not remove them; a later `up` reuses them and
    re-checks them (RT010);
  - does NOT drop the ledger table `public.schema_migrations` (kept outside
    `ratio` so the history survives).
  Remove the roles manually on a dedicated cluster with `DROP ROLE ratio_reader,
  ratio_worker, ratio_owner` after confirming no other database uses them.
- Pipeline: status gate `npm run db:migrate -- --status --json` (exit 0 match,
  3 mismatch). With expand-only migrations the previous release runs on the
  newer schema, so application rollback never requires a DB rollback.

## 8. Deviations from the brief (and why)

1. View/reader (BOUNDARY v2 D4, orchestrator): `cost_facts_published` is
   definer-rights, NOT `security_invoker` (overrides the original brief);
   reader gets SELECT on the view only — the original brief's reader grants on
   `ingest_batches`, `sync_runs`, `sources` were dropped because D4 says "view
   ONLY". View also carries an explicit tenant predicate and joins
   `ingest_batches.status = 'published'` (defence in depth).
2. D5: `rejected` → `quarantined`, `rejection_reason` → `quarantine_reason`,
   `validation_error_count` added, `ingest_validation_errors` table with
   `error_ordinal 1..1000` (DB-enforced cap). `artifact_sha256` NOT NULL.
3. D6: `ingest_artifacts.fingerprint` → `sha256`; added `source_id` and
   `evidence_key` (CHECK = `evidence/<tenant>/<source>/<sha256>`);
   `cost_facts.artifact_fingerprint` → `artifact_sha256` (one name per concept).
4. Owner pipeline constraints: phase header, contract gating, prod down
   refusal, `--status --json` — CLI is flag-based (`migrate --down N`, not a
   positional `down`).
5. `sync_runs` uses `period_from/period_to date` (brief allowed either).
6. `row_ordinal` is `bigint` (brief: int) — superset, avoids a 2^31 ceiling.
7. Ledger lives in `public.schema_migrations` (outside `ratio`, survives down).
8. `csv-parse`/`tsx` not added (not needed in Slice 0).
9. Extra hardening beyond the brief: expand-additivity lint, transaction-control
   lint, one-running-run and one-published-batch partial unique indexes,
   currency/period/fingerprint CHECKs, `artifact_name` rejects `?`/`#`,
   CLI redacts URL/user/password from all output.

## 9. Known gaps

- CI workflow not executed by the implementer (round 1: no push; the PR now
  exists, so see its checks).
- Migration lock has no timeout (a hung holder blocks others; operator uses
  `pg_terminate_backend`).
- Process-kill during a migration is not simulated; relies on Postgres
  aborting the transaction and releasing the session advisory lock.
- ~~The pre-existing-role guard … is not tested~~ — CORRECTED in round 2: that
  claim was wrong. The guard IS testable by making the dangerous change and running
  the 0001 body inside one transaction that is rolled back (other sessions never
  see the change); `roles.db.test.ts` does exactly that (M1/M2).
- Expand-additivity check is lexical (e.g. semantics changes inside a marked
  function are not detected); since round 4 the runner's catalog check backs it
  for privileges, SECURITY DEFINER, hooks and role identity.
- (Round 2) Secret guard now inspects keys AND string values (config, stats)
  and free-text columns; still deliberately broad (false positives such as
  `partition_key`), still blind to homoglyph keys and to secrets that match none
  of the patterns. `cost_facts.extra_columns` is not checked (provider columns).
- Import-boundary test cannot see non-literal dynamic imports.
- `sources.kind` is still `('focus_file','fake')`; BOUNDARY v2 D2's
  `S3FocusExportSource` may need an expand migration in Slice 1.
- Tests use `SET LOCAL ROLE` from a superuser session for most role checks;
  one test uses a genuine LOGIN member to cover SET ROLE escalation.
- No real FOCUS export has been ingested; this slice stores no cost data.

## 10. Needs the human owner (checkpoint before merge)

- New migration 0001 creating schema, three cluster-global roles, RLS policies
  and grants (tenancy/auth model) — production impact.
- Data retention: the down migration drops all ingestion data (dev/test only,
  refused in production); production rollback of 0001 would be a data-deletion
  decision.
- CI change: adds a `postgres:16` service with trust auth inside the job
  container, and the CI trigger scope (main-only) for slice PRs.
- Deployment: who holds CREATEROLE for first role creation; LOGIN grants for
  ratio_worker / ratio_reader; the migrating login must be a member of
  ratio_owner and able to CREATE in the database (verified with a DB-owner login).

---

# Round 2 — challenger REQUEST CHANGES (H1–H2, M1–M5, L1–L6) + orchestrator additions

Base: origin `slice/00-postgres-foundation` @ 2866556. All commits local; not pushed.
**0001 was amended in place** (it has never been merged, released or applied
outside dev/test) instead of adding 0002 — orchestrator decision. Local dev DBs
migrated with the old 0001 now report CHECKSUM_MISMATCH and must be recreated.

## R2.1 Commits (order = audit trail)

| Hash | Subject | Kind |
|---|---|---|
| 02b5dad | test(ingest): failing tests for challenger findings H1-H2, M1-M5, L1-L6 | tests (red) |
| 539aa87 | fix(ingest): make DB test teardown deterministic (H1) | fix |
| 26e368c | fix(ingest): allow-list expand classifier, down checksums, down env allow-list (M3, L1, L2) | fix |
| af87a78 | fix(ingest): amend unreleased 0001 — immutable published data, role guard, hardening (H2, M1, M2, M4, M5, L3, L4) | fix |
| 54c9fc8 | fix(ingest): redact password= values in CLI output; CI down smoke sets RATIO_ENV=ci (L5, L2) | fix |
| 5f3b6a1 | test(ingest): failing test for worker column grant UPDATE (row_count) on ingest_artifacts | test (red) |
| 63e8274 | fix(ingest): 0001 grants ratio_worker UPDATE (row_count) on ingest_artifacts | fix |
| 7cddc07 | test(ingest): Slice 1 publish + replay-rollback order in one worker transaction | compatibility test (green on arrival) |
| (this) | docs(evidence): round 2 | docs |

Honest notes: (1) between 26e368c and af87a78 the shipped 0001 does not load (the
new classifier needs the `ratio:allow-do` marker that af87a78 adds) — an
intermediate state, not a release. (2) The orchestrator asked for the column grant
to be "in the same commits" as the 0001 amendment; those commits already existed,
so it was done tests-first in its own red/green pair (5f3b6a1 → 63e8274) instead
of rewriting history. (3) Two test-side hygiene edits (error listeners on raw
test clients) ride in the H1 fix commit.

## R2.2 Red evidence (at 02b5dad, implementation of round 2 absent)

- `npx vitest run src/ingest` → exit 1: **10 failed / 31 passed** (classifier
  allow-list ×5, down checksum, RATIO_ENV allow-list ×2, CLI down refusal for
  staging, `redactor is not a function`). L6 guard passed (no violation exists — guard).
- `npm run test:db` → exit 1: **38 failed / 58 passed (96)**. Per finding:
  H1 `waitForNoBackends is not a function` + the leaked-client test **timed out
  after 30 s** (old `close()` hangs on `pool.end()`); H2 every immutability test
  (`expected {ok:true} … RT001/RT002/RT003`), reconciled-with-mismatch accepted,
  laundering reached the unique index (23505) instead of a CHECK, NaN accepted;
  M1/M2 old guard raised P0001 (not RT010) for super/bypass/membership and
  ACCEPTED `ALTER ROLE ratio_worker CREATEROLE`; M5 temp `uuid` table broke the
  view (42P13 "return type mismatch … during inlining"); L1 `column
  "down_checksum" does not exist`; L2 down under `RATIO_ENV=staging` reverted;
  L3 secret values/`pass` key/stats keys accepted; L4 PUBLIC had EXECUTE and the
  reader could call `jsonb_has_secret_like_key`.
- Column grant (5f3b6a1): 1 failed / 17 passed — worker `UPDATE row_count` got 42501.
Raw: `scratchpad/slice0/r2/red-fast.txt`, `red-db.txt`, `red-colgrant.txt`.

## R2.3 Green + verification (fresh clone at 7cddc07, `scratchpad/slice0/r2/clone`)

| Command | Result |
|---|---|
| `npm ci` | exit 0 (450 packages after origin/main merge; audit: 5 high, pre-existing, none in pg) |
| `npm run lint` | exit 0 |
| `rm -rf .next && npx tsc --noEmit` | exit 0 |
| `npm test` (no DB URL) | exit 0 — 29 files / 318 tests |
| `npm run test:db` (URL unset) | exit 1 — "RATIO_TEST_DATABASE_URL is not set … refusing to run" |
| `RATIO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:db` ×25 consecutive | **25/25 exit 0, 98/98 passed each, no "Errors" line** (`v-testdb-25-final.txt`). An earlier 25-run at 63e8274 (97 tests) was also 25/25 exit 0 |
| `npm run worker:build` | exit 0 |
| migrate on scratch DB via built CLI | status before: exit 3; `db:migrate` exit 0; status exit 0; re-run no-op exit 0; `--down 1` with `RATIO_ENV=staging`: exit 1 DOWN_NOT_ALLOWED; with `RATIO_ENV=test NODE_ENV=production`: exit 1; with `RATIO_ENV=test` + flag: reverted, schema and ledger empty; up again exit 0; status exit 0 (`v-migrate.txt`) |
| `npm run build` | exit 0; `git checkout tsconfig.json next-env.d.ts` afterwards |
| scope | no file under `pages/` or `src/` outside `src/ingest` changed since 2866556; no `pg`/ingestion code in `.next` |
| `EXPLAIN` as worker | `current_tenant_id()` still inlined (appears as `NULLIF(current_setting(...))::uuid` in the Index Cond) |

Leftover database note: one database `ratio_test_23557_140834c4c4e7` (empty, no
`ratio` schema) exists in the shared cluster. Its directory timestamp falls inside
the first 25-run window, but a 12-run instrumented check of the harness logged
396 creates and 396 drops (no leak), and the final 25-run left nothing new. Other
agents (Slice 1 / challenger) use the same cluster concurrently, so its origin is
not established; it was left untouched rather than dropping a database this run
may not own.

## R2.4 Mutation table (re-run on the amended 0001; each restored byte-identically)

| # | Mutation | Result |
|---|---|---|
| M1 | view gets `security_invoker = true` | 8 tests fail |
| M2 | `current_tenant_id()` without NULLIF | 6 fail |
| M3 | `GRANT SELECT ON ratio.cost_facts TO ratio_reader` | 3 fail |
| M4 | secret-key regex without `sig` | 1 fails |
| M5 | no FORCE RLS on cost_facts | 1 fails |
| M6 | no FORCE RLS anywhere + no view tenant predicate | 13 fail |
| M7 | drop sync_runs→sources FK | 1 fails |
| M8 | **drop the view's `status = 'published'` join** | **1 fails** (`pointer to a staged batch: the view never exposes its rows…`, the in-transaction check) |
| M9 | drop staged-only trigger on cost_facts | 2 fail |
| M10 | drop both deferred `publication_consistency` triggers | 3 fail |
| M11 | neutralise `reconciled_matches` CHECK | 1 fails |
| M12 | drop finite CHECK on billed_cost | 1 fails |
| M13 | role guard ignores memberships | 1 fails |
| M14 | `current_tenant_id()` back to a `$$ … ::uuid $$` body | 1 fails |
| M15 | drop `REVOKE EXECUTE … FROM PUBLIC` | 2 fail |
| M16 | allow quarantined → published | 2 fail |
| M17 | staged-only trigger stops checking INSERT/UPDATE parent | 2 fail |
| M18 | neutralise `published_reconciliation` CHECK | 1 fails |
| M19 | role guard ignores CREATEROLE/CREATEDB | 1 fails |
| M20 | neutralise `sources_config_no_secret_values` | 1 fails |
| M21 | drop staged-only trigger on ingest_artifacts | 2 fail |

No mutation survived. Raw: `scratchpad/slice0/r2/mutations.txt`.

## R2.5 Per-finding status

| Finding | Status | Evidence |
|---|---|---|
| H1 flaky teardown | fixed | red: timeout/`not a function`; green: harness tests + 25/25 ×2 |
| H2 mutable published batches | fixed (triggers + CHECKs in 0001) | immutability.db (19 tests incl. challenger repros), M8–M11, M16–M18, M21 |
| M1 untested role guard | fixed + tested | roles.db; EVIDENCE claim corrected above |
| M2 broader role guard | fixed | roles.db (membership, CREATEROLE/CREATEDB, REPLICATION); M13, M19 |
| M3 deny-list classifier | replaced by allow-list + forbidden list | migrationFiles tests (25 bypass cases, 15 forbidden cases) |
| M4 NaN/Infinity | fixed | NaN/±Infinity test (verified `abs('NaN') < 'Infinity'` is false); M12 |
| M5 helper hardening + docs | fixed; DESIGN §3/§6 corrected; trust-boundary row added | reader M5 test; M14 |
| L1 down checksum | fixed | migrationFiles, migrate.db, cli.db |
| L2 down env allow-list | fixed; CI sets RATIO_ENV=ci | migrate.test, migrate.db, cli.test |
| L3 secret keys/values | fixed (homoglyphs documented as a limitation) | schema.db L3 tests; M4, M20 |
| L4 function EXECUTE | fixed | schema.db L4 tests; M15 |
| L5 password= redaction | fixed | cli.test |
| L6 session-level tenant | guard added (no violation existed) | tenantScope.test |
| Orchestrator: worker UPDATE (row_count) | added, staged-only still enforced | 5f3b6a1 red → 63e8274 green; M21 |
| Orchestrator: Slice 1 publish/replay order | compatible; no immediate check forbids superseding a pointed-to batch (the check is deferred) | 7cddc07 |
| Orchestrator: no purge path | none added | — |

## R2.6 Remaining gaps (round 2)

- CI workflow still not executed here (no push).
- Tenant isolation does not protect against a holder of a worker/reader DB
  credential choosing another tenant (GUC is user-settable) — owner decision on
  per-tenant roles.
- Triggers can be disabled by the table owner or a superuser
  (`DISABLE TRIGGER`, `session_replication_role`); the migration linter refuses
  both in migrations, but a human with those credentials is not constrained.
- The classifier is lexical; the body of a `ratio:allow-do` DO block is not inspected. *(Superseded in round 3: bodies and their string literals are scanned for forbidden statements; round 4 added the catalog check.)*
- Per-row FOR SHARE in the child trigger: throughput at 200k rows unmeasured (Slice 1).
- One leftover empty test database of unknown origin in the shared cluster (R2.3).

## R2.7 Needs the human owner (unchanged list, plus)

- The amended 0001 (schema, roles, RLS, triggers, grants incl. the new column
  grant) — production/tenancy impact; retention: published/quarantined data and
  evidence cannot be deleted or truncated through normal roles (by design, D7).
- The trust boundary above (GUC-selected tenant vs per-tenant credentials).

---

# Round 3 — challenger round 2 (1 High, 3 Medium, Lows)

Base: `slice/00-postgres-foundation` @ 446563e. Local commits only. 0001 amended
in place again (still unreleased). Work done in the main checkout
`/home/user/finops-ratio` as instructed by the orchestrator.

## R3.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 35316bd | test(ingest): failing tests for challenger round 2 (H1, M1-M3, L2) | tests (red) |
| a0996c2 | test(ingest): reader grants are restricted in every schema; DEFAULT-then-NOT NULL is expand | test adjustment |
| 56ef017 | fix(ingest): 0001 — tenant-pinned COMMIT check, not-found parent refused, markers (H1, L2) | fix |
| 0acb539 | fix(ingest): classifier — policy/grant/body/view/function rules (M1) | fix |
| (this) | docs(evidence): round 3 | docs |

## R3.2 Red (at 35316bd)

- Fast: 1 failed / 42 passed — classifier round-3 bypass cases (`create_policy_true: expected null not to be null`).
- DB: 6 failed / 99 passed (105): H1 T1 and T2 COMMITTED (bypass reproduced), not-found
  parent gave 23503 not RT001, tenancy child-table inserts gave 42501 not RT001, L2
  (worker had EXECUTE on assert_publication_consistent), and M3 failed only because
  the T2 bypass had committed and polluted the shared fixture. M2 and M3 pass against
  the pre-fix code by design (they target surviving mutations N1/N14, see R3.4).
Raw: `scratchpad/slice0/r3/red-fast.txt`, `red-db.txt`.

## R3.3 Verification (fresh clone at 0acb539, `scratchpad/slice0/r3/clone`)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `npx tsc --noEmit` | exit 0 / 0 / 0 |
| `npm test` (no DB) | exit 0 — 320/320 |
| `npm run test:db` (URL unset) | exit 1 (refuses to run) |
| `npm run test:db` ×15 consecutive | **15/15 exit 0, 105/105 each, no Errors line** (`v-testdb-15.txt`) |
| `npm run worker:build` | exit 0 |
| migrate up/down/up on scratch DB | status before 3; up 0; status 0; re-run 0; down with RATIO_ENV=staging 1; down with RATIO_ENV=test 0 (schema + ledger empty); up again 0; status 0 |
| `npm run build` | exit 0 (tsconfig/next-env restored) |
| scope | no `pages/` or non-ingest `src/` change since 446563e; no pg in `.next` |

## R3.4 Mutation table (my M-series + challenger N-series + round-3 R3 mutations; each run restores the file)

```
M1 view security_invoker                         exit=1 KILLED  9 failed | 96 passed (105)
M2 no NULLIF                                     exit=1 KILLED  8 failed | 97 passed (105)
M3 reader GRANT cost_facts                       exit=1 KILLED  16 failed | 3 passed | 76 skipped (95)
M4 key regex without sig                         exit=1 KILLED  1 failed | 104 passed (105)
M5 no FORCE RLS cost_facts                       exit=1 KILLED  1 failed | 104 passed (105)
M6 no FORCE anywhere + no view tenant predicate  exit=1 KILLED  15 failed | 90 passed (105)
M7 drop sync_runs->sources FK                    exit=1 KILLED  1 failed | 104 passed (105)
M8 drop view status join                         exit=1 KILLED  1 failed | 104 passed (105)
M9 drop child trigger on cost_facts              exit=1 KILLED  5 failed | 100 passed (105)
M10 drop both deferred triggers                  exit=1 KILLED  7 failed | 98 passed (105)
M11 neutralise reconciled_matches                exit=1 KILLED  1 failed | 104 passed (105)
M12 drop billed_cost finite                      exit=1 KILLED  1 failed | 104 passed (105)
M13 guard ignores memberships                    exit=1 KILLED  1 failed | 104 passed (105)
M14 old $$ ::uuid body                           exit=1 KILLED  1 failed | 104 passed (105)
M15 drop REVOKE FROM PUBLIC                      exit=1 KILLED  2 failed | 103 passed (105)
M18 neutralise published_reconciliation          exit=1 KILLED  1 failed | 104 passed (105)
M20 neutralise config secret values              exit=1 KILLED  1 failed | 104 passed (105)
M21 drop child trigger on artifacts              exit=1 KILLED  3 failed | 102 passed (105)
N1 no FOR SHARE                                  exit=1 KILLED  1 failed | 104 passed (105)
N2 INSERT into published allowed                 exit=1 KILLED  3 failed | 102 passed (105)
N3 no refuse_truncate on cost_facts              exit=1 KILLED  1 failed | 104 passed (105)
N4 quarantined->published allowed                exit=1 KILLED  2 failed | 103 passed (105)
N5 identity check removed                        exit=1 KILLED  1 failed | 104 passed (105)
N6 insert as published allowed                   exit=1 KILLED  1 failed | 104 passed (105)
N7 drop RT003 trigger on batches only            exit=1 KILLED  5 failed | 100 passed (105)
N8 RT003 immediate                               exit=1 KILLED  4 failed | 101 passed (105)
N13 drop error_detail secret check               exit=1 KILLED  2 failed | 103 passed (105)
N14 frozen columns check removed                 exit=1 KILLED  1 failed | 104 passed (105)
N15 pointer w/o matching batch allowed           exit=1 KILLED  5 failed | 100 passed (105)
R3a H1 tenant-at-COMMIT check removed            exit=1 KILLED  4 failed | 101 passed (105)
R3b not-found parent trusted (INSERT path)       exit=1 KILLED  2 failed | 103 passed (105)
restored
N12/M19 guard ignores CREATEROLE/CREATEDB  ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
      Tests  1 failed | 104 passed (105)
```
All 32 killed. Note M3 (`GRANT SELECT ON ratio.cost_facts TO ratio_reader`) is now
killed one layer earlier: the classifier refuses to load the migration
(FORBIDDEN_STATEMENT), so every migrated-DB test fails/skips. Challenger N9/N10/N11/N16
are the same edits as M11/M12/M13/M18.

## R3.5 Per-finding status

| Finding | Status |
|---|---|
| H1 deferred RT003 blinded by tenant switch | fixed (row_security_active + tenant pin, RT003); not-found parent ⇒ RT001; killed by R3a/R3b |
| M1 classifier gaps | fixed (rules in DESIGN §6/§12); DESIGN claim narrowed to "text-based, defence in depth, review is primary" |
| M2 FOR SHARE race untested | two-connection test; kills N1 |
| M3 frozen columns + legal transition | test; kills N14 |
| L1 | accepted as documented |
| L2 EXECUTE on the publication check | function inlined into the trigger and removed; worker has no EXECUTE; trigger verified working for the worker |
| L3 ratio_owner CREATEROLE | documented in the threat model (owner decision to revoke after first migration) |

## R3.6 Remaining gaps

- The classifier stays lexical (marked bodies' semantics, non-literal dynamic SQL).
- A credential holder can still choose any tenant (GUC) — unchanged owner decision.
- CI not executed here (no push).

# Round 4 — challenger round 3 (M1, M2; Lows L1–L4 out of scope)

Base: `slice/00-postgres-foundation` @ d75a152. Local commits only (the
orchestrator pushes after re-review). 0001 is NOT changed in this round.
Raw logs: `scratchpad/r5/` (session scratchpad).

## R4.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| c0ed583 | test(ingest): failing tests for challenger round 3 (M1 catalog check, M2 OLD-path lock) | tests (red) |
| 608d0bf | fix(ingest): runner checks the catalog privilege model before COMMIT; classifier marks functions/views in any schema (M1) | fix |
| (this) | docs(evidence): Slice 0 round 4 | docs |

## R4.2 Red (at c0ed583)

- Fast (`migrationFiles.test.ts`): 2 failed / 20 passed (22) — the repro
  `findForbiddenStatement(...)` returned null; marked procedures/materialized
  views were not yet expand.
- DB (`privileges.db.test.ts` + `immutability.db.test.ts`): 11 failed / 28 passed
  (39). Every runner test failed: marked repro, view variant, implicit PUBLIC
  EXECUTE, worker over-grants were APPLIED (`runner must refuse: expected null
  not to be null`); down-path check absent; `privilegeModel` missing. The two
  M2 twins pass against unchanged 0001 by design (behaviour was already
  correct; they exist to kill the mutation in R4.4).

## R4.3 Verification (main checkout at 608d0bf)

| Command | Result |
|---|---|
| `npm ci` | exit 0 |
| `npm run lint` | exit 0 |
| `rm -rf .next && npx tsc --noEmit` | exit 0 |
| `npx vitest run` (no DB) | exit 0 — 322/322 |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 118/118 each |
| `npm run test:db` (URL unset) | exit 1 ("RATIO_TEST_DATABASE_URL is not set … refusing to run") |
| `npm run worker:build` | exit 0 |
| `npm run build` | exit 0; `tsconfig.json`/`next-env.d.ts` restored; no AGENTS.md/CLAUDE.md |
| `.skip/.only/.todo/it.fails` grep over `src`, `pages` | 0 hits |
| Slice 1 compatibility (scratch worktree: `slice/01-focus-ingestion-worker` 83305f3 + 608d0bf, then removed) | test:db 224/224 (with `RATIO_TEST_S3_ENDPOINT` = local SeaweedFS), fast 419/419 |

## R4.4 Mutation table (each restored with `git checkout`; tree clean after)

```
M2  OLD-path FOR SHARE removed (0001 l.377)            KILLED  1 failed | 2 passed (M2 tests)
    × M2 (round 4): a fact DELETE racing an uncommitted publish … (expected false to be true: never blocked)
    (the UPDATE twin survives by design: the NEW-path FOR SHARE also locks the batch)
M1a runner check removed from migrateUp                KILLED  6 failed | 5 passed (11)
M1b runner check removed from migrateDown              KILLED  1 failed | 10 passed (11)
M1c SECURITY DEFINER catalog rule removed              KILLED  3 failed | 8 passed (11)
M1d PUBLIC EXECUTE catalog rule removed                KILLED  2 failed | 9 passed (11)
M1e reader/worker allow-list rule removed              KILLED  6 failed | 5 passed (11)
M1f column-level privileges not enumerated             KILLED  2 failed | 9 passed (11)
M1g classifier SECURITY DEFINER rule removed           KILLED  1 failed | 21 passed (22)
M1h non-ratio functions expand without marker (old)    KILLED  1 failed | 21 passed (22)
M1i non-ratio views expand without marker (old)        KILLED  1 failed | 21 passed (22)
M1j marker read from last comment line only (old)      KILLED  1 failed | 21 passed (22)
```

## R4.5 Per-finding status

| Finding | Status |
|---|---|
| M1 public SECURITY DEFINER / view / implicit PUBLIC EXECUTE | fixed in two layers: runner catalog check (privilegeModel.ts, up and down) + classifier rules; repro refused by each layer independently; killed by M1a–M1j |
| M2 OLD-path FOR SHARE untested | delete twin + artifact-UPDATE twin; delete twin kills the mutation |

## R4.6 Remaining gaps / owner flags

- Fail closed: a database with extension functions in `public` (PUBLIC EXECUTE)
  refuses migrations until they are revoked or moved (DESIGN §13). Owner flag.
- The allow-list is code: a future migration that grants the worker something
  new must update `REVIEWED_PRIVILEGES` in the same change.
- PostgreSQL 17's `MAINTAIN` table privilege is not enumerated (CI and local
  are 16); add it when upgrading.
- CI not executed here (no push).

# Round 5 — challenger round 4 (M1 + L1–L4)

Base: 6b1e8bf. Local commits only (not pushed). 0001 unchanged. Raw logs:
`scratchpad/r6/`.

## R5.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| c62d794 | test(ingest): failing tests for challenger round 4 (post-check hooks, role identity, search_path, privilege kinds) | tests (red) |
| 1234da0 | fix(ingest): catalog check is the last statement before COMMIT; pins hooks, role identity, search_path and more privilege kinds (round 4 M1, L1-L4) | fix |
| 298142a | test(ingest): kill surviving round-5 mutations (trigger function owner, check-internal search_path pin, ratio-role memberships) | tests |
| (this) | docs(evidence): Slice 0 round 5 | docs |

## R5.2 Red (at c62d794)

`privileges.db.test.ts` + `cli.db.test.ts`: **22 failed / 17 passed (39)**.
Repro (c) and the L1 case were APPLIED (`runner must refuse: expected null
not to be null`). Repros (a)/(b), the hooks, L2 and L4 were not refused, and
status exited 0 on drift. L3 (the sequence branch) already passed, as
expected: it exists to kill mutation P7/P8.

**Incident during red (fixed):** the red L4 parameter test went through a
committing migration. `GRANT SET ON PARAMETER session_replication_role TO
ratio_worker` is stored in `pg_parameter_acl`, which is CLUSTER-GLOBAL, so it
survived the drop of the test database. From the red run (~06:40Z) until it
was found at the first green run, ratio_worker in the shared local cluster
could `SET session_replication_role`. It was revoked by hand (`REVOKE SET ON
PARAMETER session_replication_role FROM ratio_worker`), and `pg_parameter_acl`
is empty again. The test now probes in a rolled-back transaction, so a
mutated check can no longer commit the grant. Local dev cluster only.

## R5.3 Verification (main checkout at 298142a)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 322/322 |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 145/145 each |
| `npm run test:db` (URL unset) | exit 1 ("RATIO_TEST_DATABASE_URL is not set") |
| `npm run worker:build` / `npm run build` | 0 / 0 (tsconfig/next-env restored; no AGENTS.md/CLAUDE.md) |
| skip/only/todo/it.fails grep | 0 |
| Slice 1 compat: scratch worktree `slice/01-focus-ingestion-worker` d5918fa + 298142a (removed) | tsc 0, fast 428/428, test:db 269/269 ×2 |

The first compat attempt was based on 93553b1. There the Slice 1 test
`L-c … MAX_RUN_EXCEEDED` failed, and it also failed on 93553b1 WITHOUT this
merge: it was Slice 1's own red commit. d5918fa (its fix, which landed during
the run) passes with this merge.

## R5.4 Mutation table (each restored with `git checkout`; tree clean after)

```
P1  check before ledger write (old order)            KILLED  (a, isolated)
P2  no SET CONSTRAINTS ALL IMMEDIATE                  KILLED  (c, isolated)
P3  trigger rule removed                              KILLED  (a), (b), unreviewed ratio trigger
P3b trigger rule: owner/schema part removed           KILLED  re-owned reviewed trigger function (added in 298142a)
P4  rule check removed                                KILLED
P5  event trigger check removed                       KILLED
P6  ledger policy/RLS check removed                   KILLED
P7  both search_path pins removed                     KILLED  L1 migration test
P7b only the check-internal pin removed               KILLED  check pins its own search_path (added in 298142a)
P8  sequence branch removed                           KILLED  L3
P9  database branch removed                           KILLED  L4 DO-block + 0001 allow-list equality
P10 parameter branch removed                          KILLED
P11 FDW branch removed                                KILLED
P12 foreign server branch removed                     KILLED
P13 large-object ACL branch removed                   KILLED
P14 other-roles privilege check removed               KILLED  rename+impostor, LOGIN member extra grant, non-ratio role
P15 missing ratio role check removed                  KILLED  rename without impostor
P16 ratio role attribute checks removed               KILLED
P17 ratio-role memberOf check removed                 KILLED  member of a no-privilege role (added in 298142a)
P18 NOLOGIN member check removed                      KILLED
P19 status ignores privilege problems                 KILLED  cli status test
```
Survived by design: removing only the `set_config` inside `migrationStatus`.
The check pins search_path itself, so that line only protects the ledger read.

## R5.5 Per-finding status

| Finding | Status |
|---|---|
| M1 hooks after the check | fixed: order SQL → settle → ledger → check; triggers/rules/event triggers/ledger policies refused; repros (a)–(c) refused, nothing committed |
| L1 operators / search_path | fixed (runner SET LOCAL + check-internal pin) |
| L2 role rename | fixed in the catalog (robust option), see DESIGN §14 |
| L3 sequence branch | tested (kills P8) |
| L4 database / parameter / FDW / server / large objects | fixed + tested; types/languages documented as not enumerated |

---

# Round 6 — Copilot review of 453377e (1 High, 3 doc Lows)

Base: 453377e (orchestrator merge of origin/main). Local commits only (not
pushed). 0001 unchanged. Raw logs: `scratchpad/r7/`.

## R6.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| b020e05 | test(ingest): failing tests — CLI redaction must happen before JSON serialization (Copilot High) | tests (red) |
| 6e8baee | fix(ingest): CLI redacts every string before JSON serialization, all secret forms, backstop pass after (Copilot High) | fix |
| 590d196 | fix(ingest): redactDeep follows toJSON; tests kill the escaped-forms and backstop mutations | fix + tests |
| (this) | docs(evidence): Slice 0 round 6 | docs |

## R6.2 Red (at b020e05)

- `cli.test.ts`: 4 failed / 7 passed (new exports absent).
- `cli.db.test.ts` (round-6 test): **leak reproduced** against the real server:
  `"ab\"cd" as "ab\\\"cd": expected '{"ts":…' not to contain 'ab\"cd'` — the
  JSON-escaped password was printed by `migrate`.

## R6.3 Mutation table (cli.ts; each restored with `git checkout`, tree clean after)

```
H1 revert to post-serialization redaction (old: no deep walk, no escaped forms)  KILLED  fast 4 failed, db 1 failed (real pg error leak)
H2 deep walk removed (post-serialization only, escaped forms kept)               KILLED  fast 2 failed
H3 JSON-escaped forms removed (deep walk kept)                                   KILLED  fast 1 failed (double-escaped nested JSON)
H4 redactDeep leaves strings unredacted                                          KILLED  fast 2 failed
H5 backstop pass removed                                                         KILLED  fast 1 failed (numeric value equal to the secret)
H6 toJSON handling removed                                                       SURVIVED (by design: the backstop redacts the
                                                                                 escaped forms of what toJSON returns)
```
H3 and H5 survived the first table (6e8baee); the tests that kill them were
added in 590d196, together with the `toJSON` handling.

## R6.4 Verification (main checkout at the docs commit)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1089/1089 (includes the suites merged from origin/main in 453377e) |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 146/146 each |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep over `src`, `pages` | 0 |

## R6.5 Docs corrected in this round

- DESIGN §3 schema table matches 0001: `quarantined`/`quarantine_reason`,
  `sha256`/`artifact_sha256`, `ingest_validation_errors`, the finite-value
  (`abs(x) < 'Infinity'`) and secret-value CHECKs.
- DESIGN header, §1, §2 (ledger columns, transaction order, down conditions),
  §4 (role guard, worker grants), §6 (secrets, redaction, catalog check rows),
  §7, §8 (down: drops/keeps/why), §9 (classifier history, status fields), §11
  (superseded notes); new §15.
- EVIDENCE: header (branch now pushed/PR by the orchestrator), §5 marked as a
  round-1 snapshot, §7 down drops/keeps/why, §9 stale "pointer not enforced"
  gap removed (RT003 `publication_consistency` exists and is tested since
  round 2), stale classifier gap marked superseded.
- TEST_PLAN: test names that no longer exist (first-plan names) replaced by the
  real ones; round-6 section.
