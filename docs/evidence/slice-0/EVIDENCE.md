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
- Deployment: who holds CREATEROLE for first role creation; separate LOGIN
  roles that are members of ratio_worker / ratio_reader (since round 7 the ratio
  roles themselves must stay NOLOGIN); the migrating login must be a member of
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

---

# Round 7 — Copilot review of 19fdbed (3 High, 1 Medium, + Low 1)

Base: 19fdbed. Local commits only (not pushed). **0001 edited in place**
(High B; never applied outside dev/test — dev databases migrated with the old
bytes report CHECKSUM_MISMATCH by design; the down file is unchanged). Raw
logs: `scratchpad/r8/`.

## R7.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 16c9dca | test(ingest): failing tests for Copilot round 7 (session GUC carry-over, LOGIN ratio roles, JSON-safe redaction, process handlers) | tests (red) |
| 8f4b9c1 | fix(ingest): reset session state between migrations; LOGIN ratio roles refused (0001) and reported (check); JSON-safe redaction; process handlers (Copilot round 7) | fix (+ one test defect, recorded in its message) |
| bb169f6 | test(ingest): a URL the pg Client constructor rejects exits 1 with one redacted JSON line (kills the Client-outside-try mutation) | test |
| (this) | docs(evidence): Slice 0 round 7 | docs |

## R7.2 Red (at 16c9dca)

- `cli.test.ts`: 3 failed / 13 passed — numeric secret printed as invalid JSON
  `{"pid":[redacted]…}`, structure-spanning secret printed as broken JSON, no
  `installProcessHandlers`. The malformed-percent URL test passed (guard: pg
  does not throw on it).
- `privileges.db.test.ts` + `roles.db.test.ts`: 7 failed / 43 passed (50).
  High A **reproduced**: the probe migration after the hostile one stored
  `sp: 'attacker', rs: 'attacker', eq: false` (attacker.current_setting and
  attacker.= were used); the down variant stored `sp: 'attacker, pg_catalog'`.
  High B: 0001 succeeded with `ALTER ROLE ratio_* LOGIN` (rolled back). High C:
  no LOGIN problem reported. All LOGIN probes ran in rolled-back transactions;
  after every run `ratio_owner/worker/reader` were verified `rolcanlogin = f`.

## R7.3 Mutation table (each restored with `git checkout`; tree clean after)

```
A1 no session reset after each migration                KILLED  next-migration probe, down probe
A2 reset without the session search_path pin            KILLED  3 tests
A3 reset without RESET ALL                              KILLED  probe (row_security), resetSession
A4 reset without SET SESSION AUTHORIZATION DEFAULT      KILLED  resetSession
A5 reset without RESET ROLE                             SURVIVED — by PostgreSQL semantics: SET SESSION
                                                        AUTHORIZATION DEFAULT also resets the current
                                                        user; RESET ROLE is kept as belt and braces
B1 0001 guard ignores LOGIN                             KILLED  roles.db High B
C1 check ignores LOGIN                                  KILLED  3 (owner/worker/reader)
M1 primitives not redacted in redactDeep                KILLED  numeric/bigint/boolean valid-JSON test
M2 backstop not JSON-aware                              KILLED  structure-spanning secret test
M3 backstop removed entirely                            KILLED  structure-spanning secret test
L1a Client constructed outside the try                  KILLED  (by bb169f6) constructor-rejected URL test
L1b process handlers do not exit                        KILLED
L1c process handlers print the raw reason               KILLED
```

## R7.4 Verification (main checkout at bb169f6 + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1093/1093 |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 154/154 each |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| Slice 1 compat: scratch worktree `slice/01-focus-ingestion-worker` 1f41db1 + bb169f6 (removed) | one conflict in `cli.ts` (the main-module block: Slice 1 installs its own `installProcessGuards`); resolved by keeping Slice 1's block. tsc 0, eslint 0, fast 1204/1204, test:db 279/279 ×2 |

---

# Round 8 — challenger approval of 7c5b6e2 (0 High / 0 Medium), Lows L1–L3 folded in

Base: 7c5b6e2. Local commits only (not pushed). 0001 unchanged. Raw logs:
`scratchpad/r9/`.

## R8.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 0804514 | test(ingest): failing tests for round 8 (pg_db_role_setting defaults, process-handler toJSON, reset before lock, binary values) | tests (red) |
| 45f852a | fix(ingest): catalog check covers pg_db_role_setting defaults; Buffers print as [binary] (round 8 L1, L3) | fix |
| 6a1163f | test(ingest): a security-relevant default for a non-ratio role in this database is refused (kills the 'here' mutation) | test |
| 9f45398 | fix(ingest): setting check counts only pg_db_role_setting rows that apply to this database | fix |
| 933e07f | test(ingest): a pg_db_role_setting row scoped to another database is not counted (kills the scope mutation) | test |
| (this) | docs(evidence): Slice 0 round 8 | docs |

## R8.2 Red (at 0804514)

- `cli.test.ts`: 1 failed / 18 passed (the `[binary]` test). The S11 test passed
  on arrival, as intended: it exists to kill the "no try/catch" mutation.
- `privileges.db.test.ts` + `cli.db.test.ts`: 5 failed / 54 passed. Both
  migrations that planted defaults APPLIED. `--status` exited 0. The
  rolled-back `ALTER ROLE ratio_worker SET` and `ALTER ROLE ALL SET` cases were
  not reported. S5 passed on arrival, as intended.
- `pg_db_role_setting` was identical (empty) before and after the red run, and
  after every later run and mutation run.

**Defect found after the first fix (45f852a), fixed in 9f45398.** The first
version counted setting rows for a ratio role in ANY database. The cli `--status`
test commits `ALTER ROLE ratio_worker IN DATABASE <its own disposable db> SET …`.
That shared-catalog row then failed concurrently running migrations in OTHER
test databases: an intermittent failure of an unrelated `view variant` test (1
in 4 runs). Rows are now counted only when they apply to this database (this
database's OID, or 0 = all databases). Afterwards, 6 consecutive runs of the
privileges and cli DB files were green, and test:db passed ×3.

## R8.3 Mutation table (each restored with `git checkout`; tree clean after)

```
S1  settingViolations not called                         KILLED  6 tests
S2  any-setting-on-ratio-role rule removed               KILLED  ratio_worker IN DATABASE statement_timeout
S3  "any role in this database" rule removed             KILLED  (by 6a1163f)
S4  "ALTER ROLE ALL" rule removed                        KILLED
S5  ratio-member rule removed                            KILLED
S6  key filter removed (every setting refused)           KILLED  benign statement_timeout (check + --status)
S7  database-scope filter removed                        KILLED  (by 933e07f)
S11 no try/catch around the process-handler line         KILLED
S5b no session reset before the lock                     KILLED
L3  binary values not special-cased                      KILLED
```

## R8.4 Verification (main checkout at 933e07f + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1095/1095 |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 164/164 each |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state after all runs | `pg_db_role_setting` rows: 0; `ratio_owner/worker/reader` rolcanlogin = false; no `ratio_probe*` roles |
| Slice 1 compat: scratch worktree `slice/01` 1f41db1 + 933e07f (removed) | same single `cli.ts` main-block conflict as round 7, resolved by keeping Slice 1's block. tsc 0, eslint 0, fast 1206/1206, test:db 289/289 ×2 |

---

# Round 9 — challenger approval of 325b059 (0 High / 0 Medium), Low 1/2 folded in

Base: 325b059. Local commits only (not pushed). 0001 unchanged. Raw logs:
`scratchpad/r10/`.

## R9.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 66cbb31 | test(ingest): failing tests for round 9 (ratio.* setting defaults = default tenant; more security-relevant keys) | tests (red) |
| 76f65be | fix(ingest): ratio.* custom setting defaults and three more keys are security-relevant (round 9 L1, L2) | fix (plus one test defect, recorded in its message) |
| 79afa89 | test(ingest): round-9 attack fixtures pass the setting name as a format() argument | test |
| (this) | docs(evidence): Slice 0 round 9 | docs |

## R9.2 Red (at 66cbb31)

`privileges.db.test.ts` + `cli.db.test.ts`: **6 failed / 61 passed (67)**.

- Both migrations that set `ratio.tenant_id` defaults were APPLIED: the
  database-level one and the member-login `IN DATABASE` one.
- `--status` exited 0 for both.
- `ALTER ROLE ALL SET "RATIO.Tenant_ID"` was not reported.
- The threat test **reproduced the escape**. A fresh `ratio_reader` session
  saw 0 rows before the default and tenant A's published rows after it,
  without ever calling `set_config`. The check then reported nothing.
- The three new keys were not reported.

`pg_db_role_setting` was empty and no `ratio_probe*` role existed after the red
run, and after every later run, including all mutation runs.

## R9.3 Notes

- **Test defect (fixed in 76f65be).** The `*_preload_libraries` case set the
  default before opening the checking connection, so that new session tried to
  load the library and failed. It now connects first.
- **Fast guard collision (79afa89).** `tenantScope.test.ts` ("no file under
  src/ingest sets ratio.tenant_id at session level") flagged the fixtures'
  literal `… SET ratio.tenant_id = …` text. The guard is NOT changed. The
  fixtures now pass the setting name as a `format()` argument, the same form as
  the challenger's repro. Flagged for the reviewer, since it is a
  test-text change made to satisfy a lexical guard.

## R9.4 Mutation table (each restored with `git checkout`; tree clean after)

```
R1  ratio.* rule dropped                                   KILLED  5 tests (both per-migration variants, --status, ALL roles, threat test)
R2  helper match case-sensitive                            SURVIVED: the caller already lower-cases the key
R2b case-insensitivity removed in caller AND helper        KILLED  ALTER ROLE ALL SET "RATIO.Tenant_ID"
R3  lo_compat_privileges removed from the list             KILLED
R4  session_preload_libraries removed                      KILLED
R5  local_preload_libraries removed                        KILLED
```

## R9.5 Verification (main checkout at 79afa89 + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1095/1095 |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 170/170 each |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state | `pg_db_role_setting` rows: 0; `ratio_probe*` roles: 0 |
| Slice 1 compat: scratch worktree `slice/01` 1f41db1 + 79afa89 (removed) | same single `cli.ts` main-block conflict, resolved by keeping Slice 1's block; tsc 0, eslint 0, fast 1206/1206, test:db 295/295 ×2 |

---

# Round 10 — Copilot on 17f07d7 (2 High): the reviewed foundation must be present

Base: 17f07d7, the orchestrator's merge of origin/main; `git pull --ff-only`
was already up to date. Local commits only (not pushed). 0001 unchanged. Raw
logs: `scratchpad/r11/`.

## R10.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| df64a63 | test(ingest): failing tests for round 10 — the reviewed 0001 foundation must be present, not only free of extras | tests (red) |
| f3f84e1 | fix(ingest): catalog check requires the reviewed 0001 foundation to be present and unaltered (round 10, Copilot Highs) | fix + generated manifest + generator script |
| (this) | docs(evidence): Slice 0 round 10 | docs |

## R10.2 Red (at df64a63)

`foundation.db.test.ts` + `cli.db.test.ts`: **14 failed / 11 passed (25)**.
- 11 attacks were APPLIED (`runner must refuse: expected null not to be null`):
  every DROP TRIGGER, DISABLE / ENABLE REPLICA TRIGGER, NOT DEFERRABLE RT003,
  NO FORCE / DISABLE RLS, DROP POLICY / USING (true), the no-op guard
  function, the dropped / NOT VALID FK, the revoked view grant and
  security_invoker, the dropped partial index, the column type change, and
  DROP SCHEMA ratio CASCADE.
- `--status` after an out-of-band DROP SCHEMA exited 0 with `matches: true`.
- The manifest module was absent.
- The positive controls passed: pre-migration, clean apply, post-down.

One defect was fixed before the red commit: the first NOT DEFERRABLE fixture
renamed the constraint trigger and recreated it under the old name. The
trigger's pg_constraint row kept that name, so the recreate failed with 23505.
The fixture now drops the trigger and recreates it.

## R10.3 Mutation table (privilegeModel.ts; each restored with `git checkout`, tree clean after)

```
F0  foundationViolations not called                          KILLED  13 tests
F1  ledger gating removed (required before 0001 / after down) KILLED  positive controls + 3 CLI status tests
F2  trigger presence not required                             KILLED  3
F3  tgenabled not compared                                    KILLED  DISABLE / ENABLE REPLICA
F4  deferrable / initially-deferred not compared              KILLED  NOT DEFERRABLE RT003
F5  RLS enabled/forced not compared                           KILLED
F6  policy presence not required                              KILLED
F6b policy USING / WITH CHECK hashes not compared             KILLED  USING (true)
F7  function definition hash not compared                     KILLED  no-op guard function
F8  constraint presence not required                          KILLED  dropped FK
F8b convalidated not compared                                 SURVIVED: by design, pg_get_constraintdef prints
                                                              "NOT VALID", so the definition hash catches it too
                                                              (the flag is kept as belt and braces)
F9  required grants not checked                               KILLED  revoked reader grant
F10 view options not compared                                 KILLED  security_invoker
F11 index presence not required                               KILLED
F12 column presence/type not required                         KILLED
F13 schema entry not required                                 KILLED  both DROP SCHEMA tests
```

## R10.4 Verification (main checkout at f3f84e1 + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1809/1809 (includes the suites merged from origin/main) |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 185/185 each |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state | `pg_db_role_setting` rows 0; `ratio_probe*` roles 0; ratio roles NOLOGIN; no `ratio_manifest_*` scratch database left |
| Slice 1 compat: scratch worktree `slice/01` 3541d6b (already contains 17f07d7) + f3f84e1 (removed) | merge clean (no conflict); tsc 0, lint 0, fast 1922/1922; test:db 310/310 in runs 1, 5 and 6 |

**Compat note.** Full test:db runs 2–4 on the merge each had 18 failures, all
in the S3-backed files (cliWorker, demo, s3Source). Every failure came from
`InternalError 500` returned by the local SeaweedFS (`ratio-s3`) on evidence
puts in `beforeAll`. None came from the catalog check. On the same base
(3541d6b without this change) a full run passed 295/295. `s3Source.db.test.ts`
alone passed on the merge 2/2, and two later full runs on the merge passed
310/310. These are transient object-store errors.

---

# Round 11 — challenger on 0b041c5 (0 High / 1 Medium) + Lows L1–L3

Base: 0b041c5. Local commits only (not pushed). **0001 edited in place**
(L1). It has never been deployed. Dev databases migrated with the old bytes
report CHECKSUM_MISMATCH by design. The down file is unchanged. Raw logs:
`scratchpad/r12/`.

## R11.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 4907dc7 | test(ingest): failing tests for round 11 (extra policies on ratio tables; pg_dump round trip; policy roles; replica identity) | tests (red) |
| 60a6dc5 | fix(ingest): refuse unreviewed policies on ratio tables; dump-stable 0001 CHECK; pin persistence and replica identity (round 11) | fix + regenerated manifest |
| (this) | docs(evidence): Slice 0 round 11 | docs |

## R11.2 Red (at 4907dc7)

`foundation.db.test.ts`: **8 failed / 15 passed (23)**.
- Four policy attacks were APPLIED: the split-keyword repro, FOR SELECT,
  TO ratio_worker, AS RESTRICTIVE, and the extra policy on a new table.
- The no-ledger case reported nothing, and status said `matches: true`.
- The pg_dump round trip changed exactly one entry:
  `ingest_artifacts_artifact_name_check`.
- REPLICA IDENTITY FULL was applied, and the table entries lacked
  persistence/replident.
- The `ALTER POLICY … TO ratio_owner` test passed on arrival, as intended:
  roles were already in the entry, and the test exists to kill the roles
  mutant.

## R11.3 Mutation table (each restored with `git checkout`; tree clean after)

```
P1 policyViolations not called                          KILLED  5 tests
P2 reviewed-shape allowance removed (manifest only)     KILLED  new-table positive + the round-4 legitimate-migration positive
P3 manifest allowance removed (shapes only)             SURVIVED: by design, every 0001 policy IS of a reviewed
                                                        shape (the shapes are derived from them)
P4 RESTRICTIVE policies allowed                         KILLED
P5 policy roles not rendered                            KILLED  TO ratio_worker variant, ALTER POLICY … TO ratio_owner
P6 relpersistence not rendered (manifest regenerated)   KILLED  entry-shape test only (UNLOGGED cannot be set on a
                                                        0001 table because of its FKs)
P7 relreplident not rendered (manifest regenerated)     KILLED  REPLICA IDENTITY FULL
L1 0001 back to BETWEEN (manifest regenerated)          KILLED  pg_dump round trip
```

## R11.4 Verification (main checkout at 60a6dc5 + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1809/1809 |
| `npm run test:db` ×3 (URL set) | 3/3 exit 0, 194/194 each |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state | `pg_db_role_setting` rows 0; `ratio_probe*` roles 0; ratio roles NOLOGIN; no `ratio_manifest_*` database |
| Slice 1 compat: scratch worktree `slice/01` 770e333 + 60a6dc5 (removed) | merge clean (no conflict); tsc 0, lint 0, fast 1924/1924, test:db 319/319 ×2 (S3 test-bucket fix on Slice 1: no object-store errors) |

---

# Round 12 — challenger on 8079351 (1 High: flaky test) + Lows L1–L4

Base: 8079351. Local commits only (not pushed). 0001 unchanged; manifest
unchanged. Raw logs: `scratchpad/r13/`.

## R12.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 6b52a3f | test(ingest): settingRows counts only rows this test could leak (fixes a cross-file race, challenger round 12 H1) | test fix (H1) |
| a33a9ff | test(ingest): failing tests for round 12 Lows (per-table RLS/policy/inheritance rule, exact policy shapes) | tests (red) |
| 737c94f | fix(ingest): every ratio table needs forced RLS, a reviewed policy and no inheritance; tenants policy shape not reusable (round 12 L1, L4) | fix |
| 7cf79d1 | ci: pin PostgreSQL 16 client tools for the DB suite's pg_dump round-trip test (round 12 L3) | **CI workflow (restricted change)** |
| 8f6c8d9 | test(ingest): G2 uses the reviewed policy name so only the roles differ (kills the 'shape ignores roles' mutant) | test |
| (this) | docs(evidence): Slice 0 round 12 | docs |

## R12.2 H1 — race fixed, 25 consecutive runs

**Cause.** `settingRows()` counted the whole cluster-wide
`pg_db_role_setting`. `cli.db.test.ts` and other privileges tests commit
rows scoped to their own disposable databases in parallel, and those rows
disappear when those databases are dropped.

**Fix.** The count is now `WHERE setdatabase = 0 OR setdatabase = <this
database>`. The assertion is unchanged.

**Other cluster-global snapshots reviewed.** `roles.db.test.ts` reads only
the ratio roles' own attributes and their memberships in other roles. No test
commits either: every such probe is rolled back. Nothing snapshots
`pg_parameter_acl`, role counts or `pg_database`.

**Proof.** `npm run test:db` was run **25 times in a row** at 8f6c8d9:
**25/25 exit 0, 203/203 each, 0 failures, no "Errors" line**
(`run25-*.txt`).

## R12.3 Red (at a33a9ff)

`foundation.db.test.ts` + `privileges.db.test.ts`: **6 failed / 83 passed
(89)**. Six attacks were APPLIED:
- a new ratio table with RLS disabled;
- a new ratio table with RLS forced but no policy;
- an INHERITS (ratio.cost_facts) child;
- a public partition of a new partitioned ratio table;
- SET UNLOGGED on a new ratio table;
- the tenants `id =` shape reused on another table.

G2, G3 and G4 passed on arrival, as intended: they exist to kill mutants.
Fixtures that created `ratio.session_probe` (round 7/8) now write
`public.session_probe`, because a ratio table without RLS and a policy is now
refused. What they probe is unchanged.

Two fixture defects were fixed before the red commit. The partition was
created while the migration was still `SET LOCAL ROLE ratio_owner`; it now
uses `RESET ROLE` first. And `G2` initially used another policy name, so the
name, not the roles, caused the refusal; 8f6c8d9 made it exact.

## R12.4 Mutation table (privilegeModel.ts; each restored with `git checkout`, tree clean after)

```
T1 tableViolations not called                   KILLED  5 tests
T2 RLS enabled/forced rule removed              KILLED
T3 permanent-table rule removed                 KILLED  (SET UNLOGGED on a new table)
T4 reviewed-policy-per-table rule removed       KILLED
T5 inheritance rule removed                     KILLED  INHERITS child + partition
T6 tenants shape reusable again (L4)            KILLED
G2 shape ignores roles                          KILLED  (after 8f6c8d9; survived the first table)
G3 shape ignores USING hash                     KILLED
G4 shape ignores the policy name                KILLED
```

## R12.5 Verification (main checkout at 8f6c8d9 + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1809/1809 |
| `npm run test:db` ×25 (URL set) | 25/25 exit 0, 203/203 each |
| `npm run test:db` (URL unset) | exit 1 |
| pg_dump test with `RATIO_PG_DUMP=/usr/lib/postgresql/16/bin/pg_dump` / with a missing binary | pass / **fails** (`spawnSync … ENOENT`): never skipped |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state | `pg_db_role_setting` rows 0; `ratio_probe*` roles 0; ratio roles NOLOGIN; no `ratio_manifest_*` database |
| Slice 1 compat: scratch worktree `slice/01` 770e333 + 8f6c8d9 (removed) | **one conflict in `.github/workflows/ci.yml`**: Slice 1 adds a SeaweedFS step and `RATIO_TEST_S3_ENDPOINT`; this round adds the PG16 client-tools step and `RATIO_PG_DUMP` / `RATIO_PSQL`. Resolved by keeping both (YAML valid). tsc 0, lint 0, fast 1924/1924, test:db 328/328 ×2 |

**Restricted change.** 7cf79d1 edits `.github/workflows/ci.yml`. It adds a
"PostgreSQL 16 client tools" step, which installs `postgresql-client-16` only
when `/usr/lib/postgresql/16/bin/{pg_dump,psql}` are absent and prints their
versions. It also adds `RATIO_PG_DUMP` / `RATIO_PSQL` to the DB-test step's
env. The workflow was not executed here (no push).

---

# Round 13 — Copilot on 0ef880f (2 High) + challenger round-12 Low 1

Base: 0ef880f (on origin; CI green, including the PG16 client step). Local
commits only (not pushed). 0001 unchanged; manifest unchanged. Raw logs:
`scratchpad/r14/`.

## R13.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 8769153 | test(ingest): failing tests for round 13 (setting values never printed; explicit system-schema ACLs) | tests (red) |
| 0bf387e | fix(ingest): diagnostics name setting keys, never values; explicit system-schema ACLs for ratio roles refused (round 13 H1, H2) | fix (+ one test defect, recorded in its message) |
| (this) | docs(evidence): Slice 0 round 13 | docs |

## R13.2 Red (at 8769153)

`npm run test:db`: **21 failed / 194 passed (215)**.

- **Value printed.** The `ratio.api_token` value appeared in the migration
  error, in `migrationStatus` and in the CLI output.
- **System-schema grants invisible.** All six were missed: SELECT on
  pg_authid, the rolpassword column grant, EXECUTE on pg_read_file and
  lo_import, USAGE on information_schema, and the grant to a LOGIN member.
- **Assertions updated in the red commit.** 13 round-8/9 assertions matched
  `key=value`. They now match `<key> for role …`, because values are no
  longer reported.
- **Green on arrival, as intended.** The source-text sweep and the
  RLS-not-forced test passed. The sweep shows that no other diagnostic carries
  source text; the RLS test kills the challenger's mutant H3.

**Defects found while making it green.**
- **Superusers as members.** The first fix treated superusers as "members of"
  the ratio roles (`pg_has_role` is true for them), which flagged every
  default catalog ACL entry of `postgres`. Superusers are now excluded.
- **CLI test expectation.** The round-13 CLI test expected plain `migrate`
  (nothing pending, so no check runs) to name the key. It now only requires
  that the value is absent there.

## R13.3 Mutation table (each restored with `git checkout`; tree clean after)

```
V1 setting value reported again                      KILLED  15 tests (incl. the secret-marker tests)
A1 systemAclViolations not called                    KILLED  6
A2 relation ACL branch removed                       KILLED  pg_authid, LOGIN member
A3 column ACL branch removed                         KILLED  pg_authid(rolpassword)
A4 function ACL branch removed                       KILLED  pg_read_file, lo_import
A5 schema ACL branch removed                         KILLED  information_schema USAGE
A6 members of ratio roles not checked                KILLED  LOGIN member
H3 RLS FORCE not required for ratio tables           KILLED  RLS ENABLED but not FORCED
```

## R13.4 Verification (main checkout at 0bf387e + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1809/1809 |
| `npm run test:db` **×10** consecutive (URL set, PG16 client tools pinned) | **10/10 exit 0, 215/215 each, no "Errors" line** (`run10-*.txt`) |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state | `pg_db_role_setting` rows 0; `pg_parameter_acl` rows 0; `ratio_probe*` roles 0; ratio roles NOLOGIN; no `ratio_manifest_*` database; no system-schema ACL entry for a ratio role in the `postgres` database |
| Slice 1 compat: scratch worktree `slice/01` 909ec1a + 0bf387e (removed) | merge clean (no conflict); tsc 0, lint 0, fast 1924/1924, test:db 340/340 ×2 |

---

# Round 14 — Copilot on c016ffb (1 High, 2 Medium)

Base: c016ffb (on origin). Local commits only (not pushed). 0001 unchanged.
The 0001 manifest moved from a TS constant to
`0001_ratio_schema.manifest.json`; it has the same 306 entries. Raw logs:
`scratchpad/r15/`.

## R14.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 4fbf6fd | test(ingest): failing tests for round 14 (PUBLIC system-schema baseline, crash-line flush, versioned manifests) | tests (red) |
| 756cb93 | test(ingest): type the spawned CLI env as NodeJS.ProcessEnv (tsc only; no behaviour change) | test typing |
| a2dc70d | fix(ingest): PUBLIC system-schema baseline, synchronous crash line, per-version foundation manifests (round 14) | fix + generated baseline + manifest file + script |
| (this) | docs(evidence): Slice 0 round 14 | docs |

## R14.2 Red (at 4fbf6fd)

**DB tests** (`foundation.db.test.ts` + `privileges.db.test.ts`): **10
failed / 102 passed (112)**.
- The system baseline module was missing, so the four PUBLIC grant tests,
  the pg_toast tests and the version test all failed.
- The loader rejected `*.manifest.json` (`BAD_FILENAME`).
- `0001_ratio_schema.manifest.json` was absent.

**Fast** (`cli.process.test.ts`): **2 failed / 1 passed**. No crash hook
existed, so the built CLI ran the command instead of crashing. The refusal
test passed on arrival.

**Test-side fixes in the fix commit.** The compiled test CLI needs the
migrations copied next to it, as `worker:build` does, because the manifests
are now loaded from there. The env cast became `as unknown as ProcessEnv`.

**One defect found while making it green.** The crash hook first ran
alongside the command, so a fast `ECONNREFUSED` line raced the crash line.
With the hook active, the CLI now crashes instead of running the command.

## R14.3 Mutation table (each restored with `git checkout`; tree clean after)

```
B1 system baseline check not called                         KILLED  5
B2 major-version check removed                              KILLED  version test
B3 pg_toast not a system schema                             KILLED  both pg_toast tests
B4 relation ACLs not compared for PUBLIC                    KILLED  drift + pg_authid
B5 column ACLs not compared for PUBLIC                      KILLED  drift + rolpassword column
B6 function ACLs not compared for PUBLIC                    KILLED  pg_read_file
M1 active manifest is always 0001 (later manifests ignored) KILLED  0002 positive + "does more" test
M2 active manifest = highest in the dir (ignores ledger)    KILLED  positive controls + 0002 tests
C1 fatal line via async process.stderr.write                KILLED  both crash tests (the >2 MB line is lost)
C2 crash hook honoured outside RATIO_ENV=test               KILLED  refusal test
```

## R14.4 Verification (main checkout at a2dc70d + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1812/1812 (includes cli.process.test.ts) |
| `npm run test:db` **×10** consecutive (PG16 client tools pinned) | **10/10 exit 0, 227/227 each** (`run10-*.txt`) |
| `npm run test:db` against the official **`postgres:16` docker image** (16.15, Debian build, as CI uses) | **227/227**: manifest and system baseline also match that build (`docker-pg16.txt`; container removed) |
| `npm run test:db` (URL unset) | exit 1 |
| `npm run worker:build` (migrations + manifest copied) / CLI smoke migrate → status → down → migrate → status on a scratch DB | 0 / all 0 (scratch DB dropped) |
| `npm run build` | 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state | `pg_db_role_setting` 0; `pg_parameter_acl` 0; `ratio_probe*` roles 0; ratio roles NOLOGIN; no scratch databases; no system-schema ACL entry for a ratio role in `postgres` |

## R14.5 Slice 1 compat (local slice/01 0e80eff ⊇ origin; scratch worktree, removed)

**Merge.** One conflict, in `src/ingest/cli.ts`, in the main-module block
plus the new helpers. It was resolved as follows:
- kept `writeAllSync` and `testCrashHook`;
- kept Slice 1's io object;
- the single `installProcessHandlers` is Slice 1's extended version, which
  also redacts worker secrets, now with the synchronous fd-2 fatal writer;
- the crash hook is gated the same way.

**Results:** tsc 0, lint 0, test:db 352/352 ×2. Fast tests: **1925/1927**.

**The two failures are `cli.process.test.ts` crash tests**, which time out
after 60 s. The cause is in Slice 1's merged crash handler. It runs every line
through Slice 1's worker redactor (`jsonLineRedactorFor`) after Slice 0's.
Measured on the merged build:
- 0 pad: 0.2 s;
- 20 KB message: 0.9 s;
- 200 KB message: **77 s**.

The output is truncated to ~4 KB. A 4 KB line fits a pipe buffer, so the
flush race cannot happen there. But the test's ">2 MB line" assertion does
not hold on the merge, and a crash handler that blocks for minutes on a large
error message is a Slice 1 issue: **flag for the Slice 1 owner**. Options
there: cap the message length before redaction (as Slice 1 already caps the
output), or fix the super-linear redaction. Then adapt the size assertion.
Slice 0's own tree is unaffected.

# Round 15 — review on 344de78 (1 High, 1 Medium)

Base: 344de78. Local commits only (not pushed). 0001 unchanged; no manifest or
baseline change. Raw logs: `scratchpad/r16/`.

## R15.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 8dcc585 | test(ingest): failing tests for round 15 (dangerous attributes on ratio-role members; COMMIT answered with ROLLBACK) | tests (red) + serial DB phase |
| 40a7967 | fix(ingest): refuse dangerous attributes on (transitive) members of ratio roles; COMMIT answered with ROLLBACK is an error (round 15) | fix |
| (this) | docs(evidence): Slice 0 round 15 | docs |

## R15.2 Red (at 8dcc585)

**Parallel DB phase: 11 failed / 228 passed (239).**
- Nine member-attribute cases were not refused:
  - BYPASSRLS, SUPERUSER and CREATEDB members of ratio_worker;
  - REPLICATION and CREATEROLE members of ratio_reader;
  - BYPASSRLS, SUPERUSER and REPLICATION members of ratio_owner.
- The transitive BYPASSRLS member was not refused either.
- `withTenantTransaction` returned normally after a swallowed `SELECT 1/0`.
- The runner treated a COMMIT answered with `ROLLBACK` as success.
- The two positive controls passed on arrival.

**Serial phase: 1 failed (1).** The threat reproduced first: the leak
assertion passed, because a committed BYPASSRLS LOGIN member of ratio_worker,
set to tenant B, counted tenant A's `cost_facts` (> 0). Then the catalog
check returned no problem for it, and the test failed there.

The fast `tenant.test.ts` case (COMMIT tag `ROLLBACK`) was red as well; T1
below shows it is load-bearing.

## R15.3 Mutation table (each restored with `git checkout`; tree clean after)

```
R1 member-attribute check removed                 KILLED  9 parallel + the serial leak test
R2 direct members only (no recursion)             KILLED  transitive test
R3 owner members held to all five attributes      KILLED  positive control (CREATEROLE/CREATEDB migrator)
R4 owner members exempt                           KILLED  3 owner tests
R5 SUPERUSER not checked                          KILLED  2
R6 BYPASSRLS not checked                          KILLED  3 + serial leak test
R7 REPLICATION not checked                        KILLED  2
R8 CREATEROLE not checked (non-owner)             KILLED  1
R9 CREATEDB not checked (non-owner)               KILLED  1
T1 tenant COMMIT tag not checked                  KILLED  fast test + DB test
T2 runner (inTransaction) COMMIT tag not checked  KILLED  runner DB test
```

## R15.4 Verification (main checkout at 40a7967 + docs)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npx vitest run` | 1813/1813 |
| `npm run test:db` single run | 239/239 parallel + 1/1 serial |
| `npm run test:db` **×10** consecutive | **7/10 exit 0** (239/239 + 1/1 each). See R15.5 for the other 3 |
| `npm run test:db` and the serial config alone (URL unset) | exit 1 / exit 1 |
| `npm run worker:build` | 0 |
| `npm run build` | 0; tsconfig.json + next-env.d.ts restored; no AGENTS.md/CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| cluster state afterwards | `pg_db_role_setting` 0; `pg_parameter_acl` 0; probe roles 0; `ratio_test_login*` 0; no non-superuser member of any ratio role; ratio roles NOLOGIN; no scratch databases |

## R15.5 The 3 failed ×10 runs were caused by another agent's tests

Runs 1, 8 and 9 each failed exactly one test (238/239), and each test failed
in the same way. `createTestDatabase`'s `migrateUp` refused with:

```
run 1: role ratio_test_login_27461_89344cd86b (member of ratio_worker) must not be BYPASSRLS
run 8: role ratio_test_login_13636_8660b4be81 (member of ratio_worker) must not be BYPASSRLS
run 9: role ratio_test_login_16190_f77bc81d18 (member of ratio_worker) must not be BYPASSRLS
```

**Where the roles come from.** The 10-hex-character names come from Slice 1's
`src/ingest/testing/db.ts` `createLogin()`, which uses
`crypto.randomBytes(5)`. Slice 0 has no such file; its only test login uses a
base-36 name and is a plain member. The Slice 1 agent was running its
`test:db` on the shared cluster at the same time. Its `auth.db.test.ts`
creates committed BYPASSRLS LOGIN members of ratio_worker, for example
"A1 refuses a BYPASSRLS login even if it is a ratio_worker member".

**Why this is not a Slice 0 defect.** Roles and memberships are
cluster-global. While such a role exists, every database's catalog check
must refuse it, and that is the threat this round closes. Slice 0's own
committed dangerous login runs in the new serial phase
(`*.serial.db.test.ts`, after the parallel phase). It is dropped in
`finally`, and `afterAll` asserts that it is gone.

**Residual limit.** The serial phase isolates only within one `test:db`
process. Another process on the same cluster still overlaps for about 1.5 s
while that role exists.

## R15.6 Slice 1 compat (local slice/01 6a1244b ⊇ origin; scratch worktree, removed)

The Slice 1 agent's worktree has moved on since then (fc71471, not merged
here).

**Merge.** There were three conflicts:
- `cli.ts`: resolved as in round 14. The single handler is Slice 1's, with
  the synchronous fd-2 writer and the crash hook.
- `vitest.db.config.ts`: kept Slice 1's S3 `globalSetup` and added the
  serial exclude.
- `package.json`: took Slice 0's two-phase `test:db` and Slice 1's
  `worker:build`, which writes build-info.

| Gate | Result |
|---|---|
| npm ci / tsc / lint | 0 / 0 / 0 |
| fast tests | 1976/1979 |
| test:db run 1 (S3 at :18333, PG16 tools) | 369/370 |
| test:db run 2 | 369/370 |
| serial phase | 1/1 |

**Fast-test failures (3), all on Slice 1's side:**
- 2 are the known round-14 crash-redactor issue. Slice 1 truncates the crash
  line, so the ">2 MB line" assertions fail (`159`/`160 > 2000000`).
- 1 is a timing assertion in `cli.worker.test.ts` ("within 2 s", 2160 ms
  under load). It passed 14/14 when rerun alone.

**test:db failures, both from the same interference as R15.5,** inside
Slice 1's own parallel run:
- run 1: a migrateUp refused `ratio_test_login_23152_a26b0193c4` (BYPASSRLS
  member of ratio_worker);
- run 2: Slice 1's `doctor.db.test.ts` D1 saw an extra
  `PRIVILEGE_MODEL_VIOLATION` problem next to `PENDING`.

**Flag for the Slice 1 owner.** On the merge, Slice 1's committed BYPASSRLS
and SUPERUSER test logins (`auth.db.test.ts`, via `createLogin`) make
concurrent migrations and `--status`/doctor checks fail on the same cluster,
correctly. Either:
- move those tests to `*.serial.db.test.ts`; or
- create the dangerous logins in a transaction that is rolled back, where no
  separate connection is needed.

A cluster-wide advisory lock would also work: shared in `createTestDatabase`,
exclusive around a dangerous login. Separately, D1 should match `PENDING` as
a member of `problems`, not the whole list.

# Round 16: review on 289db6a (2 High, 1 Medium) + challenger round-15 Lows + spawn timeouts

Base: 289db6a (round 15, pushed). Local commits only; nothing pushed.
- 0001 is unchanged. The manifest and PUBLIC baseline needed no regeneration
  (see R16.6).
- **Every DB run in this round used a PRIVATE PostgreSQL 16 cluster**
  (16.14): initdb into `/tmp/r16pg`, 127.0.0.1:55520, TCP only (`-k ''`),
  started with `runuser -u postgres`. It was stopped and deleted at the end.
  The shared 55432 cluster was not touched.
- Raw logs: `scratchpad/r17/`.

## R16.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 53839af | test(ingest): failing tests for round 16 (…) | tests (red) |
| 7aba31b | fix(ingest): scan every privilege category for ratio-role members through their full membership closure; PUBLIC revokes are expand only on objects the file created; seed checks its COMMIT tag (round 16) | fix (+1 test correction, below) |
| 4ba9a78 | test(ingest): explicit 60 s timeout for the spawn-based CLI crash tests | test timeouts |
| (this) | docs(evidence): Slice 0 round 16 | docs |

## R16.2 Red (at 53839af, private cluster)

**`memberPrivileges.db.test.ts`: 39 failed / 2 passed (41).**
- H1: every category × parent case failed, plus the transitive case and the
  ratio-role language/tablespace/type case.
- H2: every second-role case failed, plus the ratio-object, the two
  system-ACL and the chain cases, and the assumable-role case.
- The two passing tests were the scope-kept test and the positive control.

**Serial `memberParameter.serial.db.test.ts`: 1 failed.** The threat was
reproduced first:
- before the grant, RT001 refused the delete and `SET session_replication_role`
  was denied (42501);
- after the grant, in replica mode, the PUBLISHED batch's facts were deleted
  (rowCount > 0).

Then the check reported nothing, and the test failed there.

**Fast tests:**
- `migrationFiles.test.ts`: 17 failed (every contract case, the mixed /
  ordering / signature cases). The expand-stays and 0001 tests passed.
- `fixtures.test.ts`: 1 failed (the seed returned normally).
- `vitestConfigs.test.ts` passed on arrival, as expected: it guards wiring
  that was already correct. Mutation L3 shows it can fail.

**Correction to a red test, in the fix commit.** The per-category loop also
required that the owner member's `database:CREATE` be refused. That
contradicts the owner decision (the migrator may hold CREATE on the
database) and the test's own positive control. That one case (owner ×
database) is skipped, with a comment. The 40 remaining tests are unchanged.

## R16.3 Mutation table (each restored with `git checkout`; tree clean after)

```
H1a members scanned on ratio objects only                 KILLED  33 + serial real-login test
H1b owner members not scanned (ratio-scoped)              KILLED  7
H1c tablespace category removed                           KILLED  5
H1d language category removed                             KILLED  5
H1e type category removed                                 KILLED  5
H1f language: PUBLIC baseline not subtracted              KILLED  40 (every positive state flagged)
H1g owner side allowed everything                         KILLED  7
H2a privilege closure = self only                         KILLED  10
H2b privilege closure follows INHERIT edges only          KILLED  10
H2c privilege closure one level deep                      KILLED  chain test
H2d system ACL: exact grantee only (round-13 join)        KILLED  3
H2e system ACL closure one level deep                     KILLED  chain test
H2f assumable SUPERUSER/BYPASSRLS/REPLICATION not checked KILLED  1
H2g server-file roles not checked                         KILLED  1
M1a every PUBLIC revoke is expand (old rule)              KILLED  17
M1b ALL … IN SCHEMA not checked                           KILLED  2
M1c routine signature ignored                             KILLED  overload test
M1d creations later in the file count                     KILLED  ordering test
M1e IF NOT EXISTS creations recorded                      KILLED  IF NOT EXISTS test
L2  seed COMMIT tag not checked                           KILLED  fixtures test
L3  parallel phase does not exclude serial files          KILLED  vitestConfigs test
```

## R16.4 Verification (main checkout at 4ba9a78 + docs; private cluster)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npm test` | 1836/1836 |
| `npm run test:db` **×10** consecutive (RATIO_PG_DUMP/RATIO_PSQL = PG16 client tools, as CI uses) | **10/10 exit 0**: 279/279 parallel + 2/2 serial each (`run10-*.txt`) |
| `npm run test:db` / serial config alone, URL unset | exit 1 / exit 1 |
| `npm run worker:build` | 0 |
| `npm run build` | 0; tsconfig.json and next-env.d.ts restored; no AGENTS.md or CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| private cluster before deletion | `pg_db_role_setting` 0; `pg_parameter_acl` 0; only the three ratio roles (all NOLOGIN) besides postgres; no members of a ratio role; no scratch databases. Then stopped, `/tmp/r16pg` deleted, port 55520 closed |

## R16.5 Spawn-based tests

**`cli.process.test.ts`.** Its three tests spawn the built CLI: the two
large-payload crash tests, and the refusal test, which spawns four times in
sequence. Each now has an explicit 60 s timeout (`SPAWN_TIMEOUT_MS`, the same
as each `spawnSync` budget). The build `beforeAll` already had 180 s. The
assertions are unchanged.

**Other spawn-based tests:**
- `foundation.db.test.ts` runs `pg_dump` and `psql`, under the DB suite's
  30 s `testTimeout`. It is not at risk.
- `src/costsource/transports/redactLinear.test.ts` is not Slice 0 code (it
  came with the #47 security follow-up). Its child processes have a
  deliberate hard 2 s budget, so it is left to its owner.

## R16.6 No regeneration

The foundation manifest pins only the `ratio`-scope privileges (`privilege:`
entries for schema, relation and function in `ratio`). The PUBLIC system
baseline covers PUBLIC only. Neither changed: a fresh database has no
tablespace, language or type privilege beyond PUBLIC for any ratio role. The
drift tests (`foundation.db.test.ts`, the round-14 baseline test) pass
unchanged.

The Slice 1 compat merge was not part of this round's gate list and was not
run.

# Round 17: challenger round-16 Lows

**Branch.** #52 (round 16) was merged into main at 8ab78e7, which has the
same tree as 234bab3. Round 17 is on `slice/00-r17-predefined-roles`, created
from `origin/main` in the r16 worktree. The two commits first made on the
finished r16 branch were cherry-picked over (afa0fb2, cc76136), and the
uncommitted changes were carried over as a patch. Local commits only;
nothing pushed.

**Cluster.** Every DB run used a private PostgreSQL 16.14 cluster: initdb as
postgres into `/tmp/r17pg`, 127.0.0.1:55540, TCP only. It was stopped and
deleted at the end. Raw logs: `scratchpad/r18/`.

**Nothing regenerated.** No change touches the foundation manifest (`ratio`
objects and grants) or the PUBLIC system baseline.

## R17.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| afa0fb2 | test(ingest): failing tests for round 17 (owner database grants explicitly allowed; more refused predefined roles over any edge; quoted identifiers case-sensitive …) | tests (red) |
| cc76136 | fix(ingest): refuse more reachable predefined roles for ratio-role members; PostgreSQL identifier rules in the PUBLIC-revoke classifier | fix |
| e9caf6b | test(ingest): failing tests for round 17 identifier identity (quoted names read from masked text; non-ASCII folding) | tests (red, found by a surviving mutant) |
| 25d53e7 | fix(ingest): read quoted identifiers from the original SQL and compare names part by part under PostgreSQL folding rules | fix |
| (this) | docs(evidence): Slice 0 round 17 | docs |

## R17.2 Red

**At afa0fb2:**
- `memberPrivileges.db.test.ts`: **36 failed / 42 passed**. All 36 new
  predefined-role cases failed: 4 roles × 3 parents × default, SET-only and
  transitive SET-only edges.
  - Owner members, and worker/reader members over SET-only edges: the check
    reported nothing.
  - Worker/reader members over a default edge: the check reported only the
    `holds relation:…` lines, not the reachable role.
- The generated owner × database "allowed" test passed on arrival. It
  replaces a skip, and mutations O1 and O2 show it can fail.
- `migrationFiles.test.ts`: **9 failed**, every quoted-case contract case.

**At e9caf6b: 3 failed / 59 passed.**
- `"ratio.t1"` vs `ratio_t1` and `"a b"` vs `a_b` were classified expand.
- Unquoted `ratio.É` vs `ratio."É"` (the same object in PostgreSQL) was
  classified contract.

The dotted-name contract cases added in the same commit already passed.

## R17.3 Mutation table (each restored with `git checkout`; tree clean after)

```
O1 owner database CREATE no longer allowed                   KILLED  2 (incl. the generated allowed test)
O2 owner side gets no non-ratio allowance                    KILLED  78
P1 pg_read_all_data not refused                              KILLED  9
P2 pg_write_all_data not refused                             KILLED  9
P3 pg_signal_backend not refused                             KILLED  9
P4 pg_create_subscription not refused                        KILLED  9
P5 refused roles checked for worker/reader members only      KILLED  13
P6 refused roles: INHERIT edges only (first hop)             KILLED  26
Q1 quoted parts folded too                                   KILLED  10
Q2 unquoted parts not folded                                 KILLED  6
Q3 classifier on upper-cased masked text                     KILLED  5
Q4 quotes stripped, case kept                                KILLED  8
Q5 quoted identifiers read from the masked text              KILLED  3
Q6 Unicode (not ASCII-only) folding of unquoted parts        KILLED  1
```

**Two notes on these runs:**
- O1–P6 were first run on the r16 branch, then re-run on this branch after
  the cherry-pick, with the same results.
- **Q4 survived the first implementation.** It was then a string-level fold
  in which a quoted part that was not a simple lower-case name kept its
  quotes. Investigating the mutant exposed the masked-text defect: the
  classifier read names from the masked SQL. That led to the red tests in
  e9caf6b and the part-based fix in 25d53e7. The table shows the mutants
  re-targeted at the final code (Q1–Q6), all killed.

## R17.4 Verification (worktree r16, branch slice/00-r17-predefined-roles at 25d53e7 + docs; private cluster)

| Command | Result |
|---|---|
| `npm ci` (fresh worktree) / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npm test` | 1857/1857 |
| `npm run test:db` **×10** (RATIO_PG_DUMP/RATIO_PSQL = PG16 client tools) | **10/10 exit 0**: 317/317 parallel + 2/2 serial each |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json and next-env.d.ts restored; no AGENTS.md or CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| private cluster before deletion | `pg_db_role_setting` 0; `pg_parameter_acl` 0; only the three NOLOGIN ratio roles besides postgres; no members of a ratio role; no scratch databases. Then stopped, `/tmp/r17pg` deleted, port 55540 closed |

# Round 18: monitoring roles; Copilot on #53 (C1 ADMIN-only edge, C2 dots in names)

**Branch.** Round 18 was started on `slice/00-r17-predefined-roles`. After the
owner merged #53, it moved to `slice/00-r18-stats-roles-identifiers`, created
from `origin/main` (5d46099, same tree as 0af62f2). The three commits already
made were cherry-picked, and the uncommitted C2 fix was applied as a patch.
Local commits only; nothing pushed.

**Cluster.** Every DB run used a private PostgreSQL 16.14 cluster: initdb as
postgres into `/tmp/r18pg`, 127.0.0.1:55541, TCP only. It was stopped and
deleted at the end. Raw logs: `scratchpad/r19/`.

**Nothing regenerated.** No change touches the foundation manifest or the
PUBLIC system baseline.

## R18.1 Commits

| Hash | Subject | Kind |
|---|---|---|
| 9dcdf16 | test(ingest): failing tests for round 18 (pg_monitor / pg_read_all_stats / pg_read_all_settings …; canonIdent doubled quotes) | tests (red) |
| 0ec7d23 | fix(ingest): refuse pg_monitor, pg_read_all_stats and pg_read_all_settings …; export canonIdent | fix |
| 14affa2 | test(ingest): failing tests for Copilot on #53 (ADMIN-only edge …; whitespace/comments around qualification dots) | tests (C1 guard, C2 red) |
| ef4b3f0 | fix(ingest): accept whitespace and comments around qualification dots …; a dangling dot is malformed | fix (C2) |
| 7bbbbc1 | test(ingest): a dangling-dot name never records a shorter prefix of its last part | tests (from surviving mutants D3/D8) |
| 4aefcb7 | test(ingest): sweep for names that stop early … red: a quoted name containing a line break | tests (red) |
| f730317 | fix(ingest): REVOKE patterns cross line breaks inside quoted identifiers | fix |
| (this) | docs(evidence): Slice 0 round 18 | docs |

## R18.2 Red

**Monitoring roles: 27 failed out of 27 new** (at that point, three edge
kinds).
- `pg_read_all_settings` was not reported at all (9 cases).
- `pg_monitor` and `pg_read_all_stats` were reported only as system-ACL
  entries `via` the role (18 cases), never as a reachable refused role.

**canonIdent unit test: 1 failed** (not exported). The classifier
doubled-quote test passed on arrival.

**C1 (ADMIN-only edge): 21 cases, all passed on arrival.** Production
already follows every edge. The cases guard against a regression, and
mutation A1 kills them.

**C2: 13 failed / 64 passed.**
- The repro: `ratio. t` was recorded as `ratio`.
- Spaced and commented spellings of `ratio.t` did not match each other.
- `canonIdent('"ratio" . "t"')` was malformed.

**Sweep: 1 failed / 87 passed.** A quoted name containing a line break was
not recognised in a REVOKE, because `.` does not match a line break.

## R18.3 Mutations

```
R1 pg_monitor not refused                                          KILLED  12
R2 pg_read_all_stats not refused                                   KILLED  12
R3 pg_read_all_settings not refused                                KILLED  12
S1 system-ACL scan stripped for the monitoring roles               SURVIVED, as intended: 36/36 still refused by the explicit check
S2 system-ACL scan removed entirely                                SURVIVED, as intended: 36/36 still refused by the explicit check
A1 closure ignores admin_option-only edges (refused-role reach)    KILLED  21
D1 dangling-dot lookahead removed from NAME                        KILLED  1
D2 NAME without spaces around dots                                 KILLED  12
D3 NAME unquoted part may backtrack                                KILLED  1 (survived first; guard added in 7bbbbc1)
D4 canonIdent accepts a trailing dot (round-17 behaviour)          KILLED  1
D5 canonIdent does not skip whitespace around dots                 KILLED  13
D6 canonIdent accepts two parts without a dot                      KILLED  1
D7 argument types: dots not joined                                 KILLED  1
D8 NAME quoted part may backtrack                                  KILLED  1 (guard added in 7bbbbc1)
L1 REVOKE pattern uses `.` (stops at a line break)                 KILLED  1
C1 doubled quote kept doubled in canonIdent                        KILLED  1
```

R1–R3, S1, S2 and C1 were re-run on the new branch after the cherry-pick
(the counts shown include the ADMIN-only cases). Each mutant was restored
with `git checkout`; the tree was clean afterwards.

## R18.4 Verification (worktree r16, branch slice/00-r18-stats-roles-identifiers at f730317 + docs; private cluster)

| Command | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npm test` | 1883/1883 |
| `npm run test:db` **×10** (RATIO_PG_DUMP/RATIO_PSQL = PG16 client tools) | **10/10 exit 0**: 365/365 parallel + 2/2 serial each |
| `npm run worker:build` / `npm run build` | 0 / 0; tsconfig.json and next-env.d.ts restored; no AGENTS.md or CLAUDE.md |
| skip/only/todo/it.fails grep | 0 |
| private cluster before deletion | `pg_db_role_setting` 0; `pg_parameter_acl` 0; only the three NOLOGIN ratio roles besides postgres; no non-`pg_` role is a member of any role. The only two edges into the listed predefined roles are PostgreSQL's built-in `pg_monitor` → `pg_read_all_settings` / `pg_read_all_stats`. No scratch databases. Then stopped, `/tmp/r18pg` deleted, port 55541 closed |
