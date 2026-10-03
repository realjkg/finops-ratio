# Slice 0 — test plan

Written before any test or implementation code. Every brief requirement maps to
at least one named test. `F` = fast suite (`npm test`, no DB). `D` = DB suite
(`npm run test:db`, real Postgres 16, one fresh database per test file — the
migration tests create one per test case because each needs a pristine DB).

All fixtures are synthetic (fixed UUIDs, invented amounts such as `10.10`,
`20.20`, `1000.01`); no real provider data is used anywhere.

## Brief → test mapping

| Brief requirement | Suite | File | Test name(s) |
|---|---|---|---|
| migrations apply on empty DB | D | `src/ingest/db/migrate.db.test.ts` | `applies every migration to an empty database and records checksums` |
| re-running is a no-op | D | same | `re-running is a no-op (nothing applied, ledger and catalog unchanged)` |
| checksum tamper refused | D | same | `refuses to run when an applied migration's checksum changed` |
| two concurrent runners → one applies, other waits then no-ops | D | same | `two concurrent runners: exactly one applies, the other waits on the lock then no-ops` |
| down migration returns DB to empty state | D | same | `down 1 returns the database to its pre-migration catalog state, and up re-applies (up/down/up)` |
| `--down N` non-prod only | F+D | `src/ingest/db/migrate.test.ts`, `migrate.db.test.ts` | `assertDownAllowed refuses without RATIO_ALLOW_DOWN_MIGRATIONS=1`, `assertDownAllowed refuses in production even with the flag`, `down is refused without the allow flag and in production; schema untouched` |
| each migration in own txn | D | `migrate.db.test.ts` | `a failing migration is rolled back completely and stops the run` |
| (added) missing applied file refused | D | same | `refuses when an applied migration's file is missing` |
| (added) out-of-order refused | D | same | `refuses an out-of-order pending migration` |
| (added) no down file refused | D | same | `down is refused when a migration has no down file` |
| (added) down steps > applied refused | D | same | `down refuses more steps than applied migrations` |
| (added) file discovery / validation | F | `src/ingest/db/migrationFiles.test.ts` | `orders migrations by version and pairs down files`, `checksum is sha256 of the raw up-file bytes`, `rejects malformed filenames`, `rejects duplicate versions`, `rejects a down file without an up file`, `rejects a missing migrations directory`, `detects transaction-control statements`, `ignores transaction keywords inside dollar quotes, comments, strings and identifiers`, `rejects migration files containing transaction control`, `the shipped migrations directory loads cleanly` |
| (added) invalid down steps | F | `migrate.test.ts` | `migrateDown rejects non-positive / non-integer steps without touching the database` |
| tenant A cannot SELECT B rows | D | `src/ingest/db/tenancy.db.test.ts` | `worker with tenant A sees none of tenant B's rows in any table` |
| … cannot UPDATE B rows | D | same | `worker with tenant A cannot update tenant B rows (0 rows affected, data unchanged)` |
| … cannot DELETE B rows | D | same | `worker with tenant A cannot delete tenant B rows` |
| … INSERT with B tenant_id rejected | D | same | `worker with tenant A cannot insert rows carrying tenant B's id` |
| (added) cannot move a row to B | D | same | `worker with tenant A cannot re-assign its own row to tenant B` |
| no tenant ⇒ zero rows, cannot insert | D | same | `with no tenant set the worker sees zero rows everywhere and cannot insert` |
| (added) txn-local setting does not leak to next txn | D | same | `a tenant set in a previous transaction is gone in the next one (zero rows, no error)` |
| (added) malformed tenant fails closed | D | same | `a malformed tenant setting errors instead of returning rows` |
| composite FK blocks A batch → B source | D | same | `composite FK rejects a tenant A batch that references tenant B's source` |
| (added) FKs pin source/period | D | same | `composite FKs reject a publication or fact whose source/period disagree with its batch` |
| view respects RLS | D | same | `cost_facts_published shows only the caller tenant's currently published batch` |
| (added) worker least privilege | D | same | `worker cannot write tenants/sources, update facts, run DDL, disable RLS or become owner` |
| (added) tenant helper | F+D | `src/ingest/db/tenant.test.ts`, `tenancy.db.test.ts` | `rejects non-uuid tenant ids before touching the database`, `sets the tenant with a bound, transaction-local set_config and commits`, `rolls back and releases on error`, `withTenantTransaction scopes the tenant to one transaction (integration)` |
| ratio_reader cannot write anything | D | `src/ingest/db/reader.db.test.ts` | `reader cannot INSERT, UPDATE, DELETE or TRUNCATE any table or the view` |
| (added) reader reads only what it is granted | D | same | `reader can read the view, batches, runs and sources of its own tenant only`, `reader has no access to tenants, artifacts or checkpoints`, `reader querying raw cost_facts sees only the published batch` |
| secret-looking keys rejected | D | `src/ingest/db/schema.db.test.ts` | `sources.config rejects secret-looking keys at any depth`, `sources.config accepts non-secret config`, `sources.config must be a JSON object`, `updating sources.config to add a secret key is rejected` |
| numeric precision | D | same | `numeric money round-trips exactly (0.1 + 0.2 = 0.3, 60-digit values, negatives)` |
| RLS enabled+forced, composite FKs, numeric, timestamptz | D | same | `every ratio table has RLS enabled and forced`, `every tenant-owned table has tenant_id uuid not null`, `every foreign key is composite and includes tenant_id`, `money columns are unconstrained numeric and no float types exist`, `all timestamp columns are timestamptz`, `view is security_invoker and all objects are owned by ratio_owner` (superseded: now `view runs with definer rights of ratio_owner (not security_invoker)…`, see BOUNDARY v2) |
| roles not super/BYPASSRLS, NOLOGIN | D | same | `roles exist, are NOLOGIN, not superuser and not BYPASSRLS` |
| (added) schema invariants | D | same | `only one running sync run per source`, `only one published batch per source+period`, `billing_period must be the first of the month`, `billing_currency must be an ISO-4217-shaped code`, `a variance batch cannot be published` |
| import boundary | F | `src/ingest/importBoundary.test.ts` | `no file under pages/ or src/ (outside src/ingest) imports src/ingest or pg`, `detector flags every import form of src/ingest and pg (self-test)`, `detector ignores unrelated imports (self-test)` |
| DB harness (isolated DB per file) | D | `src/ingest/db/testing/harness.db.test.ts` | `creates a uniquely named database and drops it`, `migrate option leaves the database fully migrated`, `two test databases are isolated from each other` |
| test:db fails (not skips) without URL | F + evidence | `src/ingest/db/testing/requireTestDatabaseUrl.test.ts` + recorded `npm run test:db` with env unset | `throws when RATIO_TEST_DATABASE_URL is unset`, `throws when it is blank`, `returns the URL when set` |
| (added) CLI | F | `src/ingest/cli.test.ts` | `unknown command exits 2`, `migrate down requires a positive integer`, `missing RATIO_MIGRATE_DATABASE_URL exits 1`, `down is refused before connecting when not allowed`, `connection errors never echo the database URL or password` |
| (added) CLI end-to-end | D | `src/ingest/cli.db.test.ts` | `status, up, status, down via the CLI entry` |

Brief categories "idempotency / authorization / bad input / worker crash /
recovery" in Slice 0 terms: idempotency = re-run no-op; authorization = roles,
RLS, reader/worker matrices; bad input = checksum/out-of-order/filename/secret
keys/constraint checks; crash = failing migration rolled back (the process-kill
case is server-side transaction abort + session-scoped lock; not separately
simulated — see EVIDENCE gaps); recovery = up/down/up and re-run after failure.

## Run commands
- `npm test` (no DB; must not need RATIO_TEST_DATABASE_URL)
- `RATIO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:db`
- `npm run test:db` with the variable unset ⇒ must exit non-zero

## Additions from owner deployment constraints (added before any test code)

| Requirement | Suite | File | Test name(s) |
|---|---|---|---|
| unmarked migration refused | F | `migrationFiles.test.ts` | `rejects an up migration without a ratio:phase header`, `rejects an invalid or duplicated phase header` |
| expand must be additive (hardening) | F | same | `rejects an expand migration containing destructive statements`, `allows destructive statements in a contract migration` |
| 0001 is expand | F | same | `the shipped migrations directory loads cleanly and 0001 is expand` |
| contract refused without flag | D | `migrate.db.test.ts` | `a pending contract migration is refused without allowContract and applied with it` |
| unmarked refused at run time | D | same | `an unmarked migration is refused and nothing is applied` |
| down refused when RATIO_ENV/NODE_ENV=production | F+D | `migrate.test.ts`, `migrate.db.test.ts` | `assertDownAllowed refuses when RATIO_ENV=production`, `assertDownAllowed refuses when NODE_ENV=production`, `down is refused without the allow flag and in production; schema untouched` |
| status --json, non-zero on mismatch | D | `cli.db.test.ts` | `--status --json reports pending and exits 3 before migrating`, `--status --json reports a match and exits 0 after migrating`, `--status --json exits 3 on checksum drift or unknown applied versions`, `status --json prints exactly one JSON document` |
| CLI flags | F | `cli.test.ts` | `--down requires a positive integer`, `rejects unknown flags`, `down is refused before connecting when RATIO_ENV=production` |

## BOUNDARY v2 revisions (before the test commit)

| Requirement | File | Test name(s) |
|---|---|---|
| D4 reader gets permission denied on `SELECT * FROM ratio.cost_facts` (and every base table) | `reader.db.test.ts` | `reader gets permission denied on every base table, including SELECT * FROM ratio.cost_facts`, `reader holds exactly one privilege: SELECT on cost_facts_published` |
| D4 via view only own tenant's published rows | same | `reader sees only the published rows of its own tenant via the view` |
| D4 zero rows with no tenant | same | `reader sees zero rows with no tenant set, and an error (not data) with a malformed tenant` |
| D4 staged/quarantined never in view | same + `tenancy.db.test.ts` | `staged, superseded and quarantined batch rows never appear in the view`, `cost_facts_published shows only the caller tenant's currently published batch (never staged, superseded or quarantined)` |
| D4 reader cannot write | same | `reader cannot write through the view or run DDL` (replaces the earlier per-table write matrix, now folded into the permission-denied matrix) |
| D4 view is definer-rights, owner non-super | `schema.db.test.ts` | `view runs with definer rights of ratio_owner (not security_invoker) and all objects are owned by ratio_owner` |
| D5 quarantine status/reason/count | `schema.db.test.ts` | `a quarantined batch must carry a reason; status rejected no longer exists` |
| D5 validation errors cap + FK + RLS | `schema.db.test.ts`, `tenancy.db.test.ts` | `validation errors are capped at 1000 stored rows per batch and need a known artifact`; ingest_validation_errors is included in every tenancy matrix (TENANT_TABLES) |
| D6 sha256/evidence_key format, no secrets | `schema.db.test.ts` | `artifacts store a hex sha256 and the content-addressed evidence key only` |

Superseded from the first plan: `reader can read the view, batches, runs and
sources of its own tenant only`, `reader has no access to tenants, artifacts or
checkpoints`, `reader querying raw cost_facts sees only the published batch`
(all contradicted by D4 — replaced by the tests above); `view is
security_invoker…` (replaced). These were never committed.

## Added after the first red→green run (each in its own test commit, before the implementation commit)

| Test | File | Why |
|---|---|---|
| `a real LOGIN member of ratio_worker / ratio_reader cannot become ratio_owner and is bound by RLS` | `tenancy.db.test.ts` (commit 631034f) | SET ROLE escalation cannot be tested from the superuser harness session (Postgres checks SET ROLE against the session user); the `SET ROLE` lines in the worker/reader deny lists moved here. |
| `exactly the expected composite foreign keys exist` | `schema.db.test.ts` (commit 35e3577) | Mutation check M7 (dropping the sync_runs→sources FK) survived the generic FK test. |

## Round 2 — challenger REQUEST CHANGES (tests committed red in 02b5dad, before the fixes)

| Finding | File | Test name(s) |
|---|---|---|
| H1 flaky teardown | `testing/harness.db.test.ts` | `close() drops the database even with a checked-out, never-released client and no unhandled error (H1)`, `waitForNoBackends waits for connections to go away and reports a timeout`; proof = 25 consecutive green `test:db` runs (EVIDENCE) |
| H2(1) children staged-only | `immutability.db.test.ts` | `appending a fact to the published batch is refused (challenger repro), for worker and superuser`, `deleting or updating a fact of a published, superseded or quarantined batch is refused`, `artifacts and validation errors of non-staged batches cannot be inserted, updated or deleted`, `a staged batch stays fully writable (positive control)`, `TRUNCATE of fact, evidence, batch and publication tables is refused even for the superuser` |
| H2(2) pointer ⇒ published | same | `pointer to a staged batch: the view never exposes its rows, and COMMIT is refused (challenger repro)` (kills mutation "drop the view's status join"), `COMMIT is refused when the pointer and the published batch disagree in any way`, `the guarantee behind the view predicate: at every COMMIT each pointer names a published batch` |
| H2(3) transition graph | same | `new batches must start staged`, `refuses every transition outside …`, `challenger repro: superseding the live batch and publishing the quarantined one never exposes quarantined rows`, `data columns of a non-staged batch are frozen; identity columns are frozen always`, `only staged batches can be deleted`, `a publish (staged -> published + repoint) and a replay back to the retained batch both commit atomically` |
| H2(4) reconciled ⇒ match | same | `reconciled requires a control that matches (challenger repro: reconciled with mismatched counts)`, `challenger repro: a batch with mismatching controls cannot be laundered via unverified and published` |
| M1/M2 role guard | `roles.db.test.ts` | `positive control: with clean roles the migration body succeeds`, `refuses SUPERUSER / BYPASSRLS / REPLICATION on any ratio role (M1)`, `refuses CREATEROLE / CREATEDB on ratio_worker and ratio_reader (M2)`, `refuses any membership of a ratio role in another role (M1/M2)`, `the guard leaves no trace: roles are clean after all the rolled-back probes` |
| M3 allow-list | `migrationFiles.test.ts` | `expand is an allow-list: every challenger bypass is classified non-expand`, `always refuses RLS/policy/PUBLIC/role-escalation statements, even in a contract migration`, `a DO block is expand only with a reasoned ratio:allow-do marker on the preceding line`, `allows the additive vocabulary in expand and destructive statements in a contract migration`, `the shipped migrations directory loads cleanly and 0001 is expand` |
| M4 NaN/Infinity | `immutability.db.test.ts` | `NaN, Infinity and -Infinity are rejected in every money / quantity / total column` |
| M5 search_path / trust boundary | `reader.db.test.ts` | `shadowing the uuid type with a temp table does not break or bypass the tenant filter (M5)`, `documented trust boundary: any holder of a reader credential can select any tenant via the GUC` |
| L1 down checksum | `migrationFiles.test.ts`, `migrate.db.test.ts`, `cli.db.test.ts` | `records a checksum for the down file too`, `refuses when an applied migration's down file changed or disappeared`, `--status --json exits 3 on checksum drift or unknown applied versions` (extended) |
| L2 down env allow-list | `migrate.test.ts`, `migrate.db.test.ts`, `cli.test.ts` | `refuses when NODE_ENV=production even with the flag and a dev RATIO_ENV`, `refuses unless RATIO_ENV is development, test or ci (allow-list, trimmed, case-insensitive)`, `allows down only with the flag and RATIO_ENV in {development, test, ci}`, `down is refused without the allow flag and in production; schema untouched` (extended with staging/unset), `down is refused before connecting when not allowed` (extended) |
| L3 secrets | `schema.db.test.ts` | `sources.config rejects secret-looking keys at any depth` (widened), `sources.config rejects secret values under innocuous keys (challenger repro)`, `error_detail, quarantine_reason, validation messages and artifact names reject secret values (challenger repro)`, `sync_runs.stats rejects secret-looking keys and values`, `the worker (not only the superuser) gets the same rejection — it can execute the guard functions` |
| L4 function ACL | `schema.db.test.ts` | `PUBLIC can execute no function in schema ratio; reader only current_tenant_id`, `reader cannot call the secret-guard helpers` |
| L5 redaction | `cli.test.ts` | `redacts password= values in URL query strings and keyword DSNs` |
| L6 no session-level tenant | `tenantScope.test.ts` | `no file under src/ingest sets ratio.tenant_id at session level`, `detector flags session-level forms and accepts transaction-local ones (self-test)` — a guard: passes before and after (no violation exists) |
| Orchestrator: column grant | `immutability.db.test.ts` (red commit 5f3b6a1) | `worker may UPDATE ingest_artifacts.row_count only (column grant) and only while the batch is staged` |
| Orchestrator: Slice 1 order | `immutability.db.test.ts` | `Slice 1's exact publish order and replay-rollback order commit in ONE transaction as ratio_worker` (compatibility guard; passes against the implementation) |

Existing tests changed in the red commit (not weakened — moved to where they still
reach the constraint they target, because non-staged batches are now frozen):
schema `a quarantined batch must carry a reason…`, `validation errors are capped…`,
`a variance batch cannot be published` (now exercised on the staged batch);
tenancy batch-update probe uses an exact no-op update (still proves RLS row scope);
migrate.db failing-migration fixture marked `contract` (INSERT is outside the
expand allow-list) and run with `allowContract`; fixtures seed through the legal lifecycle.
