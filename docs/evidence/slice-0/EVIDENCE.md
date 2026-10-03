# Slice 0 — operational evidence

Branch `slice/00-postgres-foundation`, created from `origin/slice/00a-ci-deps`
@ `ec68902`. Upstream tracking removed (`git branch --unset-upstream`). Local
commits only: nothing pushed, no PR, nothing merged.

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

## 5. Complete test list (all passing in the verification run)

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
  → `DROP SCHEMA ratio CASCADE` + ledger row removed (verified above). Refused
  when NODE_ENV or RATIO_ENV is production. Roles stay (cluster-global); remove
  manually on a dedicated cluster with `DROP ROLE ratio_reader, ratio_worker, ratio_owner`
  after confirming no other database uses them.
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

- CI workflow not executed (no push); triggers only on `main`.
- Migration lock has no timeout (a hung holder blocks others; operator uses
  `pg_terminate_backend`).
- Process-kill during a migration is not simulated; relies on Postgres
  aborting the transaction and releasing the session advisory lock.
- The pre-existing-role guard (RAISE if a ratio role is SUPERUSER/BYPASSRLS) is
  not tested: altering cluster-global roles would break concurrently running test
  databases.
- Expand-additivity check is lexical (e.g. `SET NOT NULL`, `CREATE OR REPLACE
  FUNCTION` semantics changes are not detected).
- Secret guard inspects JSON keys only, not values; it is deliberately broad
  (false positives such as `partition_key` are rejected).
- `period_publications` does not itself enforce that the pointed batch is
  `published` (the view filters on it; Slice 1 publish txn must keep them in sync).
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
