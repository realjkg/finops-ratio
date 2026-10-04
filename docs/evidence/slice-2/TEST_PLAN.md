# Slice 2 — test plan

## Ground rules

Tests were written and committed failing, before the implementation:
- `ac37059`: the API, boundary and local tooling tests;
- `30084c2`: the bundle check;
- `e0585a5`: the lazy manifest and the startup check.

The red output is in `docs/evidence/slice-2/red/`. No test uses `.skip`, `.only`,
`.todo`, `it.fails`, `skipIf` or `runIf`.

Sections A–C list the tests as first committed. Each later section adds the
rows of one review round. Where a later round extends an earlier row, the
earlier row says so.

| Suite | Command | Without its backing service |
|---|---|---|
| Fast | `npm test` | needs no DB |
| DB | `npm run test:db` (`*.db.test.ts`) | **fails, never skips**, without `RATIO_TEST_DATABASE_URL` (existing guard) |
| Serial DB | `*.serial.db.test.ts`, run alone after the DB suite | same guard |

Isolation:
- Every DB run used a **private PG16 cluster**: initdb as `postgres` into
  `/dev/shm/s2pg`, 127.0.0.1:55700. It was stopped and deleted afterwards.
- S3 tests used the shared SeaweedFS (127.0.0.1:18333) with the existing
  per-run prefix helper.
- The individual `local:*` commands (X5) ran with their own compose project
  (`RATIO_LOCAL_PROJECT=ratio-local-s2a`) on ports 55710/18710/3710.
  `local:test` (X4) ran with its isolated defaults (`ratio-local-test` on
  54339/18353/3110, `localTestSettings`), as it does in CI.

## A. Fast suite (new files)

| ID | File | What it proves | Requirement |
|---|---|---|---|
| Q1–Q4 | `src/server/costs/query.test.ts` | defaults; `period`/`from`/`to` month filter with 2000-01..9999-12 bounds and every malformed shape refused; `limit` 1..500 (no 0, 501, sign, fraction, exponent, hex, padding, leading zero, Unicode digit); opaque cursor round trip and 21 malformed cursors (arity, types, period day, uuid, sha, negative/oversized/leading-zero ordinal); unknown params (incl. `tenant`, `offset`, `__proto__`) and repeated params refused; messages never echo input; inherited keys ignored | input validation, pagination bounds |
| R1 | `src/server/costs/publishedCostsRoute.test.ts` | **auth required**: no token configured, no header, wrong token, wrong scheme, a token in the query string ⇒ 401; weak token ⇒ 503; 1001 failures ⇒ 429 + Retry-After while a valid token still passes. The pool factory is never called | auth |
| R2 | 〃 | GET only (405 + Allow); a missing or invalid `RATIO_API_TENANT_ID` or missing reader URL ⇒ 503 `not_configured`, no DB work | tenant binding |
| R3 | 〃 | a `tenant` parameter ⇒ 400; bad values ⇒ 400 with a fixed message | input validation |
| R4 | 〃 | the `pages/` route is the factory default and refuses anonymous callers | wiring |
| C1–C2 | `src/server/costs/config.test.ts` | `RATIO_API_TENANT_ID` validated as a canonical UUID **at startup** (`instrumentation.ts` `register()`, Node.js runtime only; one structured error, never the value; silent when the feature is unused; the app keeps starting) **and per request** (503) | coordinator Q2 |
| LZ | `src/ingest/lazyFoundation.test.ts` | importing `privilegeModel`/`foundationManifest` (and Slice 1's `worker/db.ts`) does no I/O on the migrations dir and works when it is unavailable; `FOUNDATION_0001`/`REVIEWED_POLICY_SHAPES` are computed on first use, memoised, equal to the eager values, array-like and read-only; a missing dir (ENOENT), a missing 0001 manifest (same `Error`) or a corrupt manifest (`MigrationError BAD_MANIFEST`) still **fails closed at first use** and on every later use | coordinator Q1 (b) |
| IB | `src/ingest/importBoundary.test.ts` (extended) | the read-API island allowlist is exact (self-tests); only the route imports `src/server/costs`; the route's **import closure** contains Slice 0's `tenant.ts` and `privilegeModel.ts` and Slice 1's `worker/db.ts` (reuse, not copies) and no worker/source/evidence/S3/CLI/test code or `@aws-sdk`/`csv-parse`; `instrumentation.ts` reaches only the pure config (no runtime `pg`) | bundle hygiene, reuse |
| L1–L8 | `scripts/local/local.test.mjs` | local secrets (random, distinct, strong token, uuid tenant); env file round trip and refusal of unsafe values; `.ratio-local/` gitignored; settings and ports validated; loopback URLs; **bootstrap plan**: only NO… attributes, ratio roles NOLOGIN with no membership, exactly one membership per login, no GRANT on the database or any object (the plan's only GRANTs are the three membership re-grants, login → its ratio role with explicit options, since Copilot 4176705227; L4 pins them exactly), the migrator owns the DB, every CREATE guarded, no password in the plan, identifiers validated; compose: 127.0.0.1-only ports, images pinned by digest (SeaweedFS = the CI digest), required superuser password, no passwordless auth, optional app/worker profiles, one-shot worker; `.env.example` names only; npm scripts wired; exact control-total comparison | local stack |
| B1–B4 | `scripts/check-next-bundle.test.mjs` | on synthetic Turbopack build trees: clean passes; each driver/ingestion/reader/worker marker flagged in client code **and** client source maps; reader code in a chunk shared with another route, an orphan chunk or another entry flagged; worker-only code flagged even in the costs route; `pg` traced for another route flagged; worker packages traced flagged; server maps not judged; vacuous builds (no `.next`, no static, no costs route, no reader code, `pg` not traced) fail | client bundle |

## B. DB suite (new files)

| ID | File | What it proves | Requirement |
|---|---|---|---|
| D1 | `src/server/costs/publishedCosts.db.test.ts` | **tenant isolation**: Slice 0's two-tenant fixture plus a third tenant published by the **real Slice 1 worker** (`runSync`, `FakeFocusSource`). The key bound to A returns exactly A's published facts and totals, B's exactly B's; no B id appears in A's body and vice versa; headers cannot switch the tenant; an empty tenant gets nothing; a cursor from tenant C reveals nothing of C to A | tenant isolation |
| D2 | 〃 | **only published facts**: superseded, staged and quarantined batches (Slice 0 fixture) never appear; for the worker tenant, the quarantined period and the superseded revision are invisible, and rows and totals equal the superuser ground truth | published-only |
| D3 | 〃 | money as exact decimal strings (`12345678901234567890.123456789012345678`, `0.000000000000000001`, a sum of 23 × `0.0000000001` = `0.0000000023`); ordinals as strings; UTC microsecond timestamps | decimal strings |
| D4 | 〃 | keyset traversal at limit 5 visits all 34 rows once, in key order; totals on the first page only; `nextCursor` only when more rows exist; limits 1/500/default; 0/501 refused | pagination bounds |
| D5 | 〃 | `period`, `from`, `to` select whole months; an empty period gives an empty page | period filter |
| D6 | 〃 | **unsafe DB login refused (503, fixed body)**: superuser, `ratio_owner` member, `ratio_worker` login, reader+worker, a SET-only edge to `ratio_worker`, no ratio membership, reader held only through SET; accepted control: plain reader. The check runs **per request** (a pooled login made unsafe ⇒ refused at once, served again when fixed); the reason is logged, never returned | unsafe-login refusal |
| D7 | 〃 | reader pool session settings: `search_path=pg_catalog,pg_temp`, read-only, 10 s statement timeout, UTC (extended in F: DateStyle `ISO, MDY`, IntervalStyle `postgres`; client-side deadlines in G, RD1) | hardening |
| S | `src/server/costs/publishedCosts.serial.db.test.ts` | BYPASSRLS, REPLICATION, CREATEROLE and CREATEDB readers (the attribute itself, or a role reached over a SET edge); a reachable SUPERUSER role; **every `REFUSED_PREDEFINED_ROLES` role over INHERIT, SET-only, ADMIN-only and transitive edges** ⇒ 503; a harmless extra role ⇒ 200 (no over-refusal); every role dropped and verified gone | unsafe-login refusal |
| — | all Slice 0 and Slice 1 DB tests, **unchanged** | still green with the lazy manifest, incl. the drift test, the manifest-file test and the `pg_dump` → restore round trip | coordinator Q1 (a)(d) |

## C. Outside vitest

| ID | Check | Command |
|---|---|---|
| X1 | CLI output identical before and after the lazy fix: `migrate --status --json` (pending), `migrate` (twice), `migrate --status --json`, `doctor --json` (worker login) and `doctor` as superuser (refused), on a fixture DB; normalised diff | scratch `cli-diff.sh before/after` (EVIDENCE §4) |
| X2 | fail-closed comparison of the eager vs lazy worker builds with a corrupt and with a missing 0001 manifest | scratch `failclosed.sh` (EVIDENCE §4) |
| X3 | `.next` bundle check on the real production build | `npm run check:bundle` |
| X4 | **full local flow under `next build && next start`** (also the regression test for the next-start-only failure class, now in CI): up ×2 → migrate ×2 (status matches, `privilegeProblems: []`) → seed ×2 → sync (both periods `published`) → sync (both `skipped_unchanged`) → anonymous GET 401 → paged GET (limit 17) → **totals == control totals exactly** (`rowCount` `"55"` / `billedCost` `"30.8272954899"`, `"40"` / `"21.0978157665"`, all strings since Copilot 4176238961), 95 distinct rows → `down -v` | `npm run local:test` |
| X5 | the individual commands, plus `down -v` leaving nothing behind (containers, volumes, network, `.ratio-local/<project>/`) | `npm run local:up / local:migrate / local:seed / local:sync / local:down -- -v` |
| X6 | mutation checks for auth, tenant scope, unsafe-login refusal, the published-only read and the lazy load | scratch `mutate.sh` (EVIDENCE §5) |

## D. Challenger Lows and Copilot review of PR #59 (red: 03f6cf7)

| ID | File | What it proves | Source |
|---|---|---|---|
| RL | `src/server/costs/readerLogin.test.ts` | refusal reason codes per finding (`SUPERUSER`, `BYPASSRLS`, `PRIVILEGED_ROLE_REACHABLE`, `UNSAFE_ATTRIBUTE`, `REFUSED_PREDEFINED_ROLE`, `OWNER_MEMBER`, `NOT_READER_MEMBER`, `WORKER_REACHABLE`, `LOGIN_DISABLED`), never containing role names; several problems ⇒ several codes in a stable order | L2, L3 |
| R5 | `publishedCostsRoute.test.ts` | unsafe login ⇒ 503 with `requestId` in body and `X-Request-Id`; exactly one `unsafe_db_login` event (status 503, codes); no `unhandled_error` line; no role names in any log line | L3, Copilot 4175802693 |
| D6+ | `publishedCosts.db.test.ts` | refusals carry `requestId`; the operator log is the distinct event with codes (superuser, owner member); a pooled login set `NOLOGIN` (its session still alive) is refused on the next request, and served again after `LOGIN` | L2, L3, Copilot 4175802721 |
| D8 | 〃 | a restatement committed between the page query and the totals query (injection hook) cannot make page 1 and its totals disagree; a fresh read sees the restatement; the read transaction is REPEATABLE READ + read only; a pool without the REPEATABLE READ default is refused (fail closed) | L4, Copilot 4175802675 |
| D9 | 〃 | two sources publish identical artifacts for one period (rows differ only by `source_id`); paging at limit 3 visits all 10 rows exactly once, in key order | L5 K2, Copilot 4175802660 |
| S+ | `publishedCosts.serial.db.test.ts` | refusals carry `requestId`; a refused predefined role and an attribute are logged as codes only, never the role or the login name | L3 |
| C2+ | `config.test.ts` | the startup log never contains the invalid tenant value (six shapes) nor the reader URL | L5 C2 |
| L9–L12 | `scripts/local/local.test.mjs` | state per compose project and scoped removal; env file 0600 / directory 0700, also when rewritten; `local:test` settings isolated from the developer's, overlap refused, preflight refusals; listener ownership from a synthetic `/proc` (own pid, descendant, IPv6, foreign pid, not listening, no `/proc`) | L5 L3, L6, Copilot 4175802603 / 4175802639 |
| X7 | scratch `isolation-e2e.sh` | a developer stack runs while `local:test` passes on its own project (readiness `pid-verified`); the developer stack and its env file are unchanged; a foreign server on the test app port ⇒ `local:test` refuses before creating anything | L6, Copilot 4175802603 / 4175802639 |
| X8 | scratch `sideeffects.sh` | lazy-load side effects on an up-to-date DB with the manifest missing, eager vs lazy builds | L1 |
| X9 | scratch `mutate2.sh`, `mutate3.sh` | mutation checks for every fix of this batch (EVIDENCE §10) | all |

## E. Challenger delta review of 323984e..85e6185 (red: 2ed1748)

| ID | File | What it proves | Source |
|---|---|---|---|
| N3 | `readerLogin.test.ts` | a missing reader row, or a NULL `rolcanlogin`, reader or worker field, refuses (strict comparisons), never crashes or serves | N3 |
| N3-db | `publishedCosts.db.test.ts` D6 | a login dropped while its session is pooled is never served (42704 ⇒ 500, no data) | N3 |
| R6 | `publishedCostsRoute.test.ts` | `Cache-Control: no-store` on 401, 429, 503 weak, 405, 400, 503 not_configured, 503 unsafe_db_login and 500; on 200 in D1 | code note |
| TS | `testSeam.test.ts` | `readPublishedCosts` takes exactly three parameters (no hooks); the seam throws outside vitest; no production file names it. D8 runs through the seam | code note |
| L13 | `scripts/local/local.test.mjs` | `waitForOwnServer`: owned true ⇒ `pid-verified`; **false ⇒ refuse** (L6e); null ⇒ `port-preflight-only`; pid and port passed; an exited child fails fast; polls through connection errors; times out | L6e |
| L14 | 〃 | an existing 0755 state directory is tightened to 0700 | L6f |
| L15 | 〃 | `portInUse` against a real listener; `startIfPortFree` never spawns on a busy port; `local.mjs` spawns `next start` only through it | port re-check |
| L16 | 〃 | `childExited` (exit code OR signal); `stopChild` never hangs (already signalled, real SIGKILLed child, SIGTERM-ignoring ⇒ `killed`, obeying ⇒ `stopped`, stuck ⇒ `unresponsive`); `cleanupLocalTest` always runs `down -v` once; `runProcess` timeout | Copilot 4176004971 |
| L17 | 〃 | hard deadlines: `withDeadline` aborts and rejects; `waitUntil` and `waitForOwnServer` against a server that accepts TCP and never answers (and a probe ignoring its signal) fail within the deadline, every attempt aborted; `fetchJson` with no headers / a stalled body fails within the deadline; `runLocalTest` with a stalled readiness probe or API read fails and still runs `down -v` once; a never-settling `down` is cut off; `runProcess` refuses no deadline; `portInUse` hard timer; `/proc` walk cap and cycles; static: every fetch has a signal, every S3 send an `abortSignal`, pg timeouts, API deadline > 10 s statement timeout | Copilot 4176117539, 4176117553 |
| L18 | 〃 | `finalizeLocalTestSummary` over all 28 (error × app stop × down) combinations; a failed `down -v`, an `unresponsive` or `error` stop each fail alone; `already-exited`/never started fail; `runLocalTest` end to end; static: `setApp` right after spawn, exit code from `summary.pass` | Copilot 4176117561, challenger Low 1/2 |
| X10 | scratch `mutate4.sh` | 11 mutations, incl. D8 re-run through the seam (EVIDENCE §11) | all |

## F. Copilot reviews of b27f4ba (challenger Low 1) and 0a742b9

| ID | File | What it proves | Requirement |
|---|---|---|---|
| L19 | `scripts/local/local.test.mjs` | `runProcess`'s deadline is hard whatever holds the stdio: a grandchild on the captured or inherited pipe; a child that exits and leaves one behind (grace, then its exit status); the whole process group is killed; no marker process survives | challenger Low 1 on b27f4ba |
| U1 | `src/server/costs/publishedCosts.test.ts` | `rowCount` `'9007199254740993'` (2^53 + 1) and `'9223372036854775807'` round-trip exactly as strings, through JSON too | Copilot 4176238961 |
| U2 | 〃 | the read is refused, before any read, unless the session has REPEATABLE READ, read-only, DateStyle `ISO, MDY`, IntervalStyle `postgres` and TimeZone `UTC`; the pool options pin all three | Copilot 4176238982 |
| U3 | 〃 | `billing_period` is `to_char(…, 'YYYY-MM-DD')` in the page and in the totals; no date or timestamp is cast to text; counts are cast to text in SQL | Copilot 4176238982 |
| D10a | `publishedCosts.serial.db.test.ts` (ROLE defaults are cluster state: serial phase) | a reader login with ROLE defaults `DateStyle=SQL, DMY`, `TimeZone=America/Sao_Paulo`, `IntervalStyle=sql_standard` and `extra_float_digits=-15` (proven active on a plain session) gets output identical to the canonical login's, and paging at limit 1 through `nextCursor` returns every row of tenant A exactly once (red, and mutation A0: page 2 answers "cursor is not valid") | Copilot 4176238982 |
| D10b | `publishedCosts.db.test.ts` | the page and totals SQL alone, on a plain session under four hostile DateStyles, `Pacific/Chatham`, `iso_8601` and `extra_float_digits=-15`, returns exactly the canonical output | Copilot 4176238982 |
| D10c | `publishedCosts.serial.db.test.ts` | fail closed: a pool pinning everything but DateStyle, for a login whose default is `SQL, DMY`, is refused | Copilot 4176238982 |
| D1–D3, D8 | `publishedCosts.db.test.ts` | `totals[].rowCount` is a string (`'55'`, `'11'`, …) | Copilot 4176238961 |
| D7 | 〃 | the pinned session also reports `DateStyle = ISO, MDY` and `IntervalStyle = postgres` | Copilot 4176238982 |
| L8 | `scripts/local/local.test.mjs` | the control-totals comparison requires the string `rowCount`: a JS number `40` or `'040'` is a mismatch | Copilot 4176238961 |
| L20 | 〃 | an interrupt mid-body kills the in-flight command, stops the app and runs `down -v` exactly once, exit 130; SIGTERM with a body that ignores every signal still cleans up, exit 143; a signal during the cleanup is recorded and runs nothing twice; `runProcess` bound to an aborted signal never spawns, and aborting kills the group; the first signal calls `onFirst` and the second forces (`onForce`); `next start` is tracked and killed by `killLiveProcessGroups`; static checks of `local.mjs` (`next start` detached and tracked, `local:test` aborts while other commands exit, `down` is not bound to the interrupt) | Copilot 4176238924 |
| X13 | scratch `interrupt-live.sh`, `interrupt-serving.sh` | live `local.mjs`: SIGINT during `up` gives 130, cleaned; SIGTERM to `local.mjs` alone while `next start` serves gives 143, `next start` stopped, cleaned; two SIGINTs give a forced exit with leftovers, then a manual `local:down -v`; `local:up` interrupted gives 130 and leaves state for `local:down -v` | Copilot 4176238924 |
| X14 | scratch `tostop.sh` | `stty tostop` in a real pty: a detached (setsid) child writes and exits normally in every stdio mode | challenger Low (`stty tostop`) |
| G1 | `src/server/costs/parallelRoleDdl.test.ts` (fast) | no non-serial `*.db.test.ts` runs a cluster-wide role change (`GRANT <role> TO`, `REVOKE <role> FROM`, `GRANT`/`REVOKE … ON DATABASE / TABLESPACE / PARAMETER`, `ALTER ROLE/USER/GROUP` other than `… IN DATABASE`) in a `.query(...)` call outside `BEGIN … ROLLBACK`; the Slice 0/1 files pass unchanged and non-vacuously; detector self-test | challenger Medium on 7142a86 |
| D6 (serial) | `publishedCosts.serial.db.test.ts` | the four D6 cases that GRANT, REVOKE or ALTER ROLE on an existing login (SET-only worker, SET-only reader, unsafe-while-pooled then fixed, NOLOGIN then LOGIN), moved from the parallel file with identical assertions | challenger Medium on 7142a86 |

## G. Copilot review of f684dbc

| ID | File | What it proves | Requirement |
|---|---|---|---|
| G2 | `src/server/costs/parallelRoleDdl.test.ts` | soundness: each of Copilot's bypass shapes is flagged (a different client, ROLLBACK before the GRANT, an unused nested function, a conditional BEGIN, a conditional ROLLBACK), as are an early exit or COMMIT on a straight line and helpers that pass another client, run the callback after ROLLBACK or roll back conditionally; concatenated SQL (`'GR' + 'ANT …'`), a bare variable, a call, a statement-position hole and an object are findings; constants, `for…of` over literals and value holes resolve; the reviewed allowlist is exact (a stale entry and an unlisted finding both fail) | Copilot 4176494757, 4176494775 |
| RD1–RD3 | `src/server/costs/readDeadline.test.ts` | the reader pool's `query_timeout` (above `statement_timeout`), connect timeout and request deadline; a query that never answers ⇒ rejected at the deadline, client released with an error and its socket destroyed; a client-side timeout poisons the client (the ROLLBACK never reaches it); a healthy read releases normally; the route against a fake Postgres that accepts and never answers ⇒ 500 within the connect deadline, and a connection stalled mid-request ⇒ 500 at the request deadline | Copilot 4176494809 |
| D11 | `publishedCosts.db.test.ts` | a TCP proxy in front of the real Postgres stops forwarding answers: with `max: 1`, the stalled request ⇒ 500 within the deadline (`query_timeout`, D11a; request deadline, D11b), the pool holds 0 clients, and the next request succeeds | Copilot 4176494809 |
| L21 | `scripts/local/local.test.mjs` | bootstrap membership edges: the exact PG16 shape (ADMIN FALSE, INHERIT TRUE, SET TRUE); each wrong option on each edge, a NULL option, a duplicate grant, a missing or an extra edge fail; `verifyBootstrap` reads the option columns (extended in H, L25: edges on either side of a managed role, and the grantor) | Copilot 4176494789 |
| L22 | 〃 | after an interrupt, a spawn through `spawnGuard` (after an injected delay) is refused; a child handed to `setApp` late is killed and awaited (`lateChildren: 1`); the interrupted body is awaited, bounded by `bodySettleMs`; `next start` is spawned through `spawnGuard` | Copilot 4176494798 |
| RD4 / D12 | `readDeadline.test.ts` / `publishedCosts.db.test.ts` | the reader guard's stray-error listener is attached once per client: 50 reads (fake client) and 51 requests (real `max: 1` pool) leave the listener count flat; no `MaxListenersExceededWarning` | challenger Medium on 480dd87 |
| G3 | `parallelRoleDdl.test.ts` | hardening: client provenance (`await x.connect()`, `new Client` from pg, a local factory, a verified helper's parameter; a pool, `db.admin`, a `let`, a foreign `Client` or a non-client factory are autocommit); `CREATE ROLE … ROLE/ADMIN/USER` is a role change (`IN ROLE` is not); comments stripped in two readings; indirect `query` use (`.call`, `.apply`, `.bind`, computed, destructured) flagged; a reassigned client rejected | challenger Low on 480dd87 |

## H. Copilot reviews of 787824b and 5e4acf9

| ID | File | What it proves | Requirement |
|---|---|---|---|
| L23 | `scripts/local/local.test.mjs` | an app double whose child (same group) survives the leader's TERM: `stopChild` gives `killed` and the group ends empty; `runLocalTest` reports `appStop: killed`; an obeying group gives `stopped`; a group stays tracked after its leader is SIGKILLed while a descendant lives, and the sweep empties it and drops it; every kill site targets the group (static); a failing stop is recorded as its own error, and no exit-wait timer is left armed | Copilot 4176705245 |
| L24 | 〃 | `LOGIN_ATTRIBUTES`; each wrong attribute (INHERIT, LOGIN, SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE, CREATEDB, connection limit 0 or 5, NULL, a past or future VALID UNTIL) on each login fails; a missing login fails; per-role settings are reported by key, never by value; the plan normalises every login | Copilot 4176705227 |
| D13 | `scripts/local/localBootstrap.serial.db.test.ts` (role attributes are cluster state: serial phase, wired by `vitest.db.serial.config.ts`; L24 checks the wiring) | real PG16, logins that already exist in a wrong state (NOINHERIT, SUPERUSER, CONNECTION LIMIT 0; CREATEDB, CREATEROLE, a past VALID UNTIL, a global setting; NOLOGIN, BYPASSRLS, REPLICATION, a setting in the database): `verifyBootstrap` reports every one, then `runBootstrap` normalises them all, leaving the exact attributes, no settings and `verifyBootstrap` = []; the roles are dropped afterwards and checked gone | Copilot 4176705227 |
| L25 | `scripts/local/local.test.mjs` | every membership edge with a managed role (3 ratio roles, 3 local logins) on EITHER side is judged: an unexpected member of each ratio role, anything granted TO each login, a login in any other role fail; each of Slice 0's `REFUSED_PREDEFINED_ROLES` (and any other `pg_*` role) is named as a predefined role with Slice 0's reason; an expected edge granted by anyone but the bootstrap superuser (ADMIN delegation), or an unknown grantor, fails; static: the query matches either endpoint and reads the grantor, nothing is REVOKEd | Copilot 4176878790 |
| D13 (memberships) | `scripts/local/localBootstrap.serial.db.test.ts` | real PG16: an unrelated login granted `ratio_reader`, an unrelated role granted the local reader login, the reader login granted `pg_read_all_data`, and the worker's edge re-granted through ADMIN delegation each fail verification; `runBootstrap` refuses (fail closed) and the planted edge is still there; after cleanup `verifyBootstrap` = [] | Copilot 4176878790 |

## I. Copilot review of cb06552

| ID | File | What it proves | Requirement |
|---|---|---|---|
| RD5 | `src/server/costs/readDeadline.test.ts` | only a pg `DatabaseError` with severity `ERROR`, a SQLSTATE outside 08/57P01–57P05 and no `errno`/`syscall` keeps a client. Each of these poisons it (no ROLLBACK reaches it, release gets the error, socket destroyed): EPIPE, ECONNRESET, ETIMEDOUT and EIO as Node system errors; a bare Error; `query_timeout`; "Connection terminated"; a SQLSTATE-shaped look-alike (with and without severity); FATAL 57P01; class 08; 57P01 at ERROR; a localised severity; a DatabaseError carrying errno/syscall. 42P01, 57014, 42501 and 40001 keep it; static: `instanceof DatabaseError` and the severity | Copilot 4176969214 |
| D14 | `src/server/costs/publishedCosts.db.test.ts` | real PG16, the reader backend terminated (`pg_terminate_backend`) while its query waits on a lock: (a) `readWithDeadline` on the real pool sees FATAL 57P01, the ROLLBACK is refused with that same error (it never reaches pg), and the pool keeps no client; (b) through the route: 500, the slot is freed, the next request succeeds | Copilot 4176969214 |
