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
| `--down N` non-prod only | F+D | `src/ingest/db/migrate.test.ts`, `migrate.db.test.ts` | `refuses without RATIO_ALLOW_DOWN_MIGRATIONS=1`, `refuses when NODE_ENV=production even with the flag and a dev RATIO_ENV`, `down is refused without the allow flag and in production; schema untouched` |
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
| ratio_reader cannot write anything | D | `src/ingest/db/reader.db.test.ts` | `reader cannot write through the view or run DDL`, `reader gets permission denied on every base table, including SELECT * FROM ratio.cost_facts` (the first plan's per-table write matrix was folded into these under D4) |
| (added) reader reads only what it is granted | D | same | superseded by D4 before any test was committed — see the BOUNDARY v2 table (`reader holds exactly one privilege: SELECT on cost_facts_published`, …) |
| secret-looking keys rejected | D | `src/ingest/db/schema.db.test.ts` | `sources.config rejects secret-looking keys at any depth`, `sources.config accepts non-secret config`, `sources.config must be a JSON object`, `updating sources.config to add a secret key is rejected` |
| numeric precision | D | same | `numeric money round-trips exactly (0.1 + 0.2 = 0.3, 60-digit values, negatives)` |
| RLS enabled+forced, composite FKs, numeric, timestamptz | D | same | `every ratio table has RLS enabled and forced`, `every tenant-owned table has tenant_id uuid not null`, `every foreign key is composite and includes tenant_id`, `money columns are unconstrained numeric and no float types exist`, `all timestamp columns are timestamptz`, `view is security_invoker and all objects are owned by ratio_owner` (superseded: now `view runs with definer rights of ratio_owner (not security_invoker)…`, see BOUNDARY v2) |
| roles not super/BYPASSRLS, NOLOGIN | D | same | `roles exist, are NOLOGIN, not superuser and not BYPASSRLS` |
| (added) schema invariants | D | same | `only one running sync run per source`, `only one published batch per source+period`, `billing_period must be the first of the month`, `billing_currency must be an ISO-4217-shaped code`, `a variance batch cannot be published` |
| import boundary | F | `src/ingest/importBoundary.test.ts` | `no file under pages/ or src/ (outside src/ingest) imports src/ingest or pg`, `detector flags every import form of src/ingest and pg (self-test)`, `detector ignores unrelated imports (self-test)` |
| DB harness (isolated DB per file) | D | `src/ingest/db/testing/harness.db.test.ts` | `creates a uniquely named database and drops it`, `migrate option leaves the database fully migrated`, `two test databases are isolated from each other` |
| test:db fails (not skips) without URL | F + evidence | `src/ingest/db/testing/requireTestDatabaseUrl.test.ts` + recorded `npm run test:db` with env unset | `throws when RATIO_TEST_DATABASE_URL is unset`, `throws when it is blank`, `returns the URL when set` |
| (added) CLI | F | `src/ingest/cli.test.ts` | `unknown command exits 2`, `rejects unknown flags`, `--down requires a positive integer`, `missing RATIO_MIGRATE_DATABASE_URL exits 1`, `down is refused before connecting when not allowed`, `connection errors never echo the database URL or password` |
| (added) CLI end-to-end | D | `src/ingest/cli.db.test.ts` | `--status --json reports pending and exits 3 before migrating`, `--status --json reports a match and exits 0 after migrating`, `down via the CLI requires the explicit allow flag and reverts the schema` |

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
| expand must be additive (hardening) | F | same | `rejects an expand migration containing destructive statements`, `allows the additive vocabulary in expand and destructive statements in a contract migration` |
| 0001 is expand | F | same | `the shipped migrations directory loads cleanly and 0001 is expand` |
| contract refused without flag | D | `migrate.db.test.ts` | `a pending contract migration is refused without allowContract and applied with it` |
| unmarked refused at run time | D | same | `an unmarked migration is refused and nothing is applied` |
| down refused when RATIO_ENV/NODE_ENV=production | F+D | `migrate.test.ts`, `migrate.db.test.ts` | `refuses unless RATIO_ENV is development, test or ci (allow-list, trimmed, case-insensitive)`, `refuses when NODE_ENV=production even with the flag and a dev RATIO_ENV`, `down is refused without the allow flag and in production; schema untouched` |
| status --json, non-zero on mismatch | D | `cli.db.test.ts` | `--status --json reports pending and exits 3 before migrating`, `--status --json reports a match and exits 0 after migrating`, `--status --json exits 3 on checksum drift or unknown applied versions`, `status --json prints exactly one JSON document` |
| CLI flags | F | `cli.test.ts` | `--down requires a positive integer`, `rejects unknown flags`, `down is refused before connecting when not allowed` |

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

## Round 3 — challenger round 2 (tests committed red in 35316bd, before the fixes)

| Finding | File | Test name(s) |
|---|---|---|
| H1 tenant switch before COMMIT | `immutability.db.test.ts` | `H1: switching ratio.tenant_id before COMMIT cannot smuggle a pointer to a staged batch past RT003 (repro T1)`, `H1: switching tenant before COMMIT cannot supersede the published batch without a replacement (repro T2)`, `H1: a legitimate publish with a constant tenant still commits (positive control, fresh DB)`, `H1: a child row whose parent batch is not found is refused by the trigger (RT001), not left to the FK` |
| H1 consequence | `tenancy.db.test.ts` | `worker with tenant A cannot insert rows carrying tenant B's id` — child tables now expect RT001 (trigger) instead of 42501 (RLS); other tables unchanged |
| M1 classifier | `migrationFiles.test.ts` | `round 3: policy, reader-grant, view, DO-body, NOT NULL column and function/trigger bypasses are caught (challenger round 2)` (18 forbidden + 9 non-expand cases), `round 3: the reasoned markers make ratio views, functions and triggers expand; legitimate forms still pass` |
| M2 FOR SHARE race | `immutability.db.test.ts` | `M2: a fact insert racing an uncommitted publish waits on the batch row lock, then fails RT001 (two connections)` |
| M3 frozen + transition | `immutability.db.test.ts` | `M3: data columns cannot ride along with a legal transition` |
| L2 no EXECUTE | `immutability.db.test.ts` | `L2: the worker cannot call the publication check directly; the deferred trigger still works for it` |

Test change after the red commit (a0996c2, before the classifier fix): the
additive-vocabulary positive control granted SELECT on a non-ratio table to
ratio_reader, which the stricter reader rule now forbids; it grants to
ratio_worker instead. Added `ADD COLUMN … DEFAULT 1 NOT NULL` as a legal form.

## Round 4 — challenger round 3 (tests committed red in c0ed583, before the fixes)

| Finding | File | Test name(s) |
|---|---|---|
| M1 runner catalog check | `privileges.db.test.ts` | `0001 applies cleanly and the effective reader/worker privileges equal the reviewed allow-list exactly` (positive), `a legitimate marked expand migration (table, ratio function revoked from PUBLIC, ratio view, no new grants) still applies` (positive), `challenger repro (classifier bypassed): the public SECURITY DEFINER reader of ratio.cost_facts is refused before COMMIT` (also proves the leak is real: reader with no tenant reads all rows of both tenants), `the repro with reasoned markers passes the classifier but is refused by the runner and rolled back`, `a marked SECURITY DEFINER function owned by ratio_owner, revoked from PUBLIC and granted to nobody, is still refused (not on the reviewed list)`, `view variant: a marked superuser-owned view over ratio.cost_facts granted to ratio_worker is refused`, `view variant (classifier bypassed): a view granted to ratio_reader is refused`, `implicit grant: a marked public non-definer function is refused (PUBLIC holds EXECUTE by default)`, `implicit grant: a marked ratio function that keeps the default PUBLIC EXECUTE is refused`, `worker grants beyond the reviewed set (table privilege, column privilege, schema CREATE) are refused`, `the check also runs inside a down migration transaction` |
| M1 classifier | `migrationFiles.test.ts` | `round 4 (challenger round 3, M1): functions, procedures and views in ANY schema need a marker; SECURITY DEFINER needs its own` (repro + 15 non-expand + 11 forbidden cases), `round 4: marked functions, procedures and views in any schema are expand; a marked SECURITY DEFINER passes the classifier (the runner catalog check is the backstop)` |
| M2 OLD-path FOR SHARE | `immutability.db.test.ts` | `M2 (round 4): a fact DELETE racing an uncommitted publish waits on the batch row lock, then fails RT001; rows unchanged`, `M2 (round 4): an artifact UPDATE (worker column grant) racing an uncommitted publish waits, then fails RT001; row unchanged` |

Test change in the red commit: the round-2 additive-vocabulary positive control
created an unqualified function and view; under the round-4 rule those need
markers, so the fixture now carries `ratio:allow-function` / `ratio:allow-view`
markers (a policy change mandated by M1; the control still asserts the same
additive vocabulary loads as expand, and the new round-4 test asserts the
unmarked forms are refused).

## Round 5 — challenger round 4 (tests committed red in c62d794, before the fix)

All in `privileges.db.test.ts` unless noted. Role and parameter probes run in
transactions that are always rolled back (cluster-global catalogs).

| Finding | Test name(s) |
|---|---|
| M1 (a) | `(a) expand: an AFTER INSERT trigger on public.schema_migrations granting the reader cost_facts is refused; nothing committed`, `(a, isolated) the ledger row is written BEFORE the check, …` |
| M1 (b) | `(b) expand: a deferred constraint trigger on the ledger, function in another schema, is refused; nothing committed` |
| M1 (c) | `(c) contract: a deferred constraint trigger on a helper table, queued by an INSERT, is refused; nothing committed`, `(c, isolated) the deferred trigger fires BEFORE the check (SET CONSTRAINTS ALL IMMEDIATE), so its GRANT is seen` |
| M1 hooks | `an event trigger is refused`, `a rule is refused (on a helper table, and on the ledger)`, `a policy (or RLS) on the ledger is refused`, `a trigger on a ratio table that is not on the reviewed list is refused, …`, `positive control: the 0001 triggers are exactly the reviewed list` |
| M1 status | `cli.db.test.ts`: `round 5: --status --json runs the catalog privilege check and exits 3 on privilege drift` |
| L1 | `a migration that installs public.=/<> operators and puts public first on the search_path still has its grant detected` |
| L2 | `GRANT to ratio_reader, rename it away and create an impostor ratio_reader: refused`, `rename without an impostor (members keep the old role): refused`, `a LOGIN member of ratio_reader holding an extra privilege is refused; a plain LOGIN member passes`, `a NOLOGIN member of a ratio role is refused`, `a non-ratio role holding any privilege on ratio objects is refused`, `ratio role attributes and memberships are pinned` |
| L3 | `L3: a sequence privilege beyond the reviewed set is refused` |
| L4 | `L4: GRANT CREATE ON DATABASE built inside a DO block is refused`, `L4: GRANT SET ON PARAMETER is refused (cluster-global: probed in a rolled-back transaction, never via a committing migration)`, `L4: USAGE on a foreign-data wrapper or foreign server is refused`, `L4: a large-object privilege is refused` |
| survivors (298142a) | `a reviewed trigger whose function is no longer owned by ratio_owner is refused`, `status (no runner SET LOCAL) still detects drift under a hostile session search_path with public operators`, `assertReviewedPrivileges pins its own search_path (a caller-side hostile search_path cannot blind it)`, `a ratio role made a member of a role that grants nothing is still refused` |

Test changes in the fix commit (1234da0), each recorded in its message:
- The trigger-count control now expects 11. 0001 has 11 user triggers; the red commit miscounted 12.
- The L1 test now grants TRUNCATE. The worker already holds SELECT on cost_facts, so the red version proved nothing.
- The parameter test now runs in a rolled-back transaction, because a red-phase run committed a cluster-global grant (see EVIDENCE R5.2).

## Round 6 — Copilot review of 453377e (tests committed red in b020e05, before the fix)

| Finding | File | Test name(s) |
|---|---|---|
| High: redaction ran after JSON.stringify | `cli.test.ts` | `a message carrying the decoded password is redacted in every serialized form` (quotes, backslashes, newline, tab, unicode, U+2028, control char, a JSON document as password), `literal %22 / %5C in the URL password: both the encoded and the decoded (and escaped) forms are redacted`, `redactDeep walks objects, arrays, Error messages and causes without mutating the input`, `the post-serialization pass alone is not what is relied on: escaped forms are also caught by the backstop`; added after the first mutation table (590d196, see EVIDENCE R6): `objects with toJSON are serialized through the redactor too`, `backstop: a non-string value whose serialized text equals the secret is still redacted` |
| High, end-to-end through a real pg error | `cli.db.test.ts` | `round 6 (Copilot High): a password with JSON metacharacters inside a real pg error is never printed, in any form` (the password is also the missing database name, so the server error carries it; `migrate` and `migrate --status --json`) |

Docs-only Lows (schema table, stale gap, rollback wording) have no tests; see DESIGN §3/§8/§15.

## Round 7 — Copilot review of 19fdbed (tests committed red in 16c9dca, before the fix)

| Finding | File | Test name(s) |
|---|---|---|
| High A | `privileges.db.test.ts` | `the next migration in the same run resolves names through the pinned path, as the runner role, with row_security on`, `the check of the following migration still detects a planted grant`, `down: a down file that plants a session search_path does not affect the next down step`, `resetSession clears SET SESSION AUTHORIZATION, SET ROLE, row_security and search_path` |
| High B | `roles.db.test.ts` | `round 7 High B: refuses a ratio role that can LOGIN (pre-created or altered; rolled back)`; `the guard leaves no trace…` now also asserts `rolcanlogin = false` |
| High C | `privileges.db.test.ts` | `ALTER ROLE ratio_owner LOGIN is reported by the check (and therefore by migrate --status)` (and the worker / reader variants; all in rolled-back transactions) |
| Medium | `cli.test.ts` | `a non-string value whose text equals the secret is redacted AND the line stays valid JSON (round 7 Medium)` (replaces the round-6 numeric backstop test, whose expectation of invalid JSON was the defect), `backstop: a secret that spans JSON structure is removed and the output is replaced by a fixed valid JSON line` |
| Low 1 | `cli.test.ts` | `a malformed connection URL (bad percent-encoding) exits 1 with a redacted JSON line, never a throw` (guard, green on arrival), `uncaughtException / unhandledRejection handlers print one redacted JSON line and exit 1`; added after the fix to kill the Client-outside-try mutation (bb169f6, see EVIDENCE R7): `a URL the pg Client constructor itself rejects (invalid port, unreadable sslcert) exits 1 with a redacted JSON line` |

## Round 8 — challenger Lows (tests committed red in 0804514, before the fix)

| Finding | File | Test name(s) |
|---|---|---|
| L1 setting defaults | `privileges.db.test.ts` | `a migration that sets session_replication_role for the database is refused; nothing committed`, `a migration that sets anything on ratio_worker IN DATABASE is refused; nothing committed`, `ALTER ROLE ratio_worker SET … (all databases, cluster-global) is refused — probed in a rolled-back transaction`, `ALTER ROLE ALL SET session_replication_role and a LOGIN member of ratio_reader with search_path are refused (rolled back)`, `a benign per-database default (statement_timeout) is not flagged`; added after the fix to kill mutations: `a security-relevant default for ANY role in this database (not only ratio roles) is refused (rolled back)` (6a1163f), `a setting row scoped to ANOTHER database does not count here (shared catalog; no cross-database interference)` (933e07f) |
| L1 status | `cli.db.test.ts` | `round 8 L1: --status exits 3 when the database or ratio_worker (IN DATABASE) carries a security-relevant setting default`, `round 8 L1: a benign ALTER DATABASE … SET statement_timeout keeps --status at exit 0` |
| L2 S11 | `cli.test.ts` | `round 8 L2 (S11): a reason whose toJSON throws (carrying the DSN) still yields one fixed JSON line and exit 1, never a throw` (green on arrival; kills the mutation) |
| L2 S5 | `privileges.db.test.ts` | `a caller client with a hostile session search_path does not affect the first pending migration` (green on arrival; kills the mutation) |
| L3 | `cli.test.ts` | `round 8 L3: Buffers and typed arrays are printed as "[binary]", never as their bytes` |

## Round 9 — challenger Lows (tests committed red in 66cbb31, before the fix)

| Finding | File | Test name(s) |
|---|---|---|
| L1 per-migration | `privileges.db.test.ts` | `ALTER DATABASE … SET ratio.tenant_id (DO/format, contract) is refused by the per-migration check; nothing committed`, `ALTER ROLE <LOGIN member of ratio_reader> IN DATABASE … SET ratio.tenant_id is refused by the per-migration check; nothing committed`, `matching is case-insensitive and covers any ratio.* key, for ALL roles (rolled back)`, `the threat is real: with a database default tenant, a fresh reader session that never calls set_config sees that tenant (…)` |
| L1 status | `cli.db.test.ts` | `round 9 L1: --status exits 3 for a ratio.tenant_id default on the database or on a LOGIN member of ratio_reader` |
| L1 positive control | `reader.db.test.ts` (existing) | `reader sees zero rows with no tenant set, and an error (not data) with a malformed tenant`; also asserted (0 rows) at the start of the "threat is real" test |
| L2 | `privileges.db.test.ts` | `lo_compat_privileges / session_preload_libraries / local_preload_libraries defaults for this database are refused` |

## Round 10 — required foundation (tests committed red in df64a63, before the fix)

All in `foundation.db.test.ts` (committed contract migrations on disposable
databases) unless noted.

| Rule | Test name(s) |
|---|---|
| manifest = fresh apply | `a fresh 0001 apply produces exactly FOUNDATION_0001 (the stored manifest)` |
| scope (positive controls) | `positive controls: pre-migration, a clean apply and post-down all pass; status reports no privilege problem` |
| trigger presence | `DROP TRIGGER for each guard class (RT001 child, RT002 lifecycle, RT003 publication consistency, TRUNCATE refusal)` |
| trigger enabled | `ALTER TABLE … DISABLE TRIGGER and ENABLE REPLICA TRIGGER (built so the lexical classifier cannot see them)` |
| RT003 timing | `a constraint trigger made NOT DEFERRABLE (RT003 timing pinned)` |
| RLS enabled + forced | `NO FORCE ROW LEVEL SECURITY, and DISABLE ROW LEVEL SECURITY` |
| policies | `DROP POLICY, and a policy rewritten to USING (true)` |
| function bodies | `CREATE OR REPLACE a guard function into a no-op (owner and trigger unchanged; body pinned)` |
| constraints | `a dropped composite tenant FK, and one re-added NOT VALID` |
| view + reader grant | `the published view: reader grant revoked, or switched to security_invoker` |
| indexes | `a partial unique index (one published batch per period) dropped` |
| columns | `a 0001 column type changed` |
| schema | `DROP SCHEMA ratio CASCADE as a migration is refused`, `DROP SCHEMA ratio CASCADE made outside the runner: status reports it (problem PRIVILEGE_MODEL_VIOLATION)`; `cli.db.test.ts`: `round 10: after 0001 is applied, DROP SCHEMA ratio CASCADE makes --status exit 3 (required foundation missing)` |

## Round 11 — extra policies, dump round trip (tests committed red in 4907dc7, before the fix)

All in `foundation.db.test.ts`.

| Finding | Test name(s) |
|---|---|
| M1 | `challenger repro: split-keyword CREATE POLICY open_all … USING (true) is refused; nothing committed`, `FOR SELECT, TO ratio_worker and AS RESTRICTIVE variants are refused too (decision: no unreviewed policy at all)`, `a non-standard policy on a NEW table added by a later migration is refused; the reviewed tenant_isolation shape is allowed`, `extra policies are refused even when 0001 is not in the ledger (schema present)`, `--status (migrationStatus) reports an extra policy made outside the runner` |
| L1 | `dump a migrated database, restore it into a fresh one: the foundation still matches and the check passes` |
| L2 | `ALTER POLICY … TO ratio_owner (split keyword) is refused` (green on arrival; kills the roles mutant) |
| L3 | `REPLICA IDENTITY FULL on a 0001 table is refused`, `table entries pin relpersistence and relreplident` |
