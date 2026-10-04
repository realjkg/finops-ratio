# Slice 2 — evidence (local stack, published-costs read API, deployment brief)

Branch `slice/02-local-env-brief`, from `origin/main` 6eac391. Local and
ephemeral only. Nothing pushed, no GitHub comments.

Isolation:
- Every DB run used a private PG16 cluster: `initdb` as `postgres` (via
  `setpriv`), `/dev/shm/s2pg`, 127.0.0.1:55700, `fsync=off`. It was stopped and
  deleted at the end.
- S3 tests used the shared SeaweedFS 127.0.0.1:18333 with the existing per-run
  prefix.
- The local stack used its own compose project, `ratio-local-s2a`, on
  55710 / 18710 / 3710.
- The shared 55432 and the ports 555xx–556xx were never used.

## 1. Commit order

| # | SHA | Commit | Kind |
|---|---|---|---|
| 1 | b29099f | design note | docs |
| 2 | ac37059 | API, reader-login, import-boundary, local-tooling tests | **red** |
| 3 | cde7448 | `GET /api/v1/costs/published` | green |
| 4 | 18ad019 | local stack: compose, bootstrap, `local:*` | green |
| 5 | 30084c2 | bundle-check tests | **red** |
| — | — | *stop: the next-start-only failure needed a Slice 0 change; reported to the coordinator, option 1 approved (Q1), tenant binding approved (Q2)* | — |
| 6 | e0585a5 | lazy-manifest + startup tenant-binding tests | **red** |
| 7 | 9d83590 | `fix(db)`: lazy manifest load (the only `src/ingest/db` change) | green |
| 8 | 6fed636 | startup and per-request tenant-binding validation | green |
| 9 | 87381f0 | bundle-check script | green |
| 10 | e18ecc1 | CI: two steps appended to the existing job | ci |
| 11 | 5c182da | DEPLOYMENT_BRIEF, TEST_PLAN, DESIGN §7 | docs |
| 12 | (this commit) | EVIDENCE | docs |

## 2. Red evidence (`docs/evidence/slice-2/red/`)

| File | At | Result |
|---|---|---|
| `red-fast.txt` | ac37059 | 4 files fail: `query`, `publishedCostsRoute` and `local.test` cannot import their modules; `importBoundary` fails "the route's import closure…" (route file missing; the other 4 boundary tests pass) |
| `red-db.txt` / `red-serial.txt` | ac37059 | `publishedCosts.db.test.ts` / `.serial.db.test.ts` fail to import `./publishedCostsRoute` |
| `red-bundle-check.txt` | 30084c2 | cannot import `./check-next-bundle.mjs` |
| `red-lazy-config.txt` | e0585a5 | 8 failures. The no-I/O test **received the reads** `readdir …/src/ingest/db/migrations` and `read …/0001_ratio_schema.manifest.json` on import. The fail-closed tests threw **at import** (`foundationManifest.ts:11`) instead of at first use. `config.test.ts` cannot import `./config`. The instrumentation boundary test fails (no `instrumentation.ts`). |

## 3. Test defects corrected after red (no assertion weakened)

1. A list of test queries needed a type annotation for `tsc`.
2. PostgreSQL reports a **startup-option** `search_path` exactly as given:
   `pg_catalog,pg_temp`, not `pg_catalog, pg_temp`.
3. Lint: `URL` and `process` imports in two `.mjs` test files.

## 4. The lazy-manifest fix (coordinator Q1, option 1)

**Finding.** The read API only crashed under `next build && next start`:
`⨯ Error: ENOENT … scandir '/ROOT/src/ingest/db/migrations'` on every request.
- `FOUNDATION_0001` was computed at module load, and so was
  `REVIEWED_POLICY_SHAPES` from it.
- The route imports `privilegeModel` via Slice 1's `worker/db.ts` (for
  `REFUSED_PREDEFINED_ROLES`), and Turbopack rewrites `__dirname`.
- It was found by the first `local:test` run. All unit and DB tests were
  green, because vitest runs from source.

**Change** (9d83590, `git diff --stat origin/main -- src/ingest/db`):
`foundationManifest.ts` +32 −2 and `privilegeModel.ts` +3 −3. No other file in
`src/ingest/db`, and **no existing test**, changed.

**Requirement (a): all existing tests pass unchanged.** Full fast suite ×3 and
`test:db` ×5 are green (§6).

**Requirement (b): fails closed at first use, same error.**
- `lazyFoundation.test.ts` covers it at unit level: `ENOENT`, the plain
  `Error` "0001_ratio_schema.manifest.json is missing from the migrations
  directory", and `MigrationError BAD_MANIFEST`, for `FOUNDATION_0001` and
  `REVIEWED_POLICY_SHAPES` alike, on first and later uses.
- At CLI level (scratch `failclosed.sh`), I compared an eager build (HEAD's two
  files compiled in a scratch copy) against the lazy build, each with a corrupt
  and with a missing 0001 manifest in `dist-worker`:

| Build | Fault | Command | Exit | Error | Database after |
|---|---|---|---|---|---|
| eager | corrupt | `migrate --status --json` / `migrate` | 1 / 1 | BAD_MANIFEST "is not valid JSON" (uncaught at load) | untouched |
| lazy | corrupt | 〃 | 1 / 1 | `"code":"BAD_MANIFEST"` "is not valid JSON" (structured CLI error) | untouched |
| eager | missing | 〃 | 1 / 1 | "is missing from the migrations directory" (uncaught at load) | untouched |
| lazy | missing | 〃 | 1 / 1 | `"code":"UNKNOWN"`, the same message (the CLI's label for a codeless Error) | `--status`: untouched; `migrate`: **0001 rolled back (no `ratio` schema, 0 ledger rows), but the runner's empty `public.schema_migrations` table remains** |

**Residual difference, flagged for the challenger.** With a *missing* 0001
manifest in a broken build, `migrate` now reaches the database:
- it creates the empty ledger table, then fails in the 0001 transaction's
  catalog check, which rolls back;
- the eager code crashed before connecting.

Exit code and message are the same, and no migration is applied. A *corrupt*
manifest is still refused before connecting, because `loadMigrations` parses
every manifest. Removing the difference would need a change outside the two
approved files (the runner), so I left it and recorded it here.

**Side effects on an UP-TO-DATE database (challenger L1, measured after
approval).** Scratch `sideeffects.sh`: a database migrated to 0001, a tenant
and a source, and the 0001 manifest removed from each build's `dist-worker`.
Eager = origin/main's two files compiled in a scratch copy; lazy = HEAD.

| Command (manifest missing) | Eager | Lazy |
|---|---|---|
| `migrate` (nothing pending, a no-op) | exit 1, crash on import | **exit 0** (nothing applied; the catalog check only runs when a migration runs) |
| `migrate --status --json` | exit 1, crash on import | exit 1 (`"code":"UNKNOWN"`, "is missing from the migrations directory") |
| `doctor --json` | exit 1, crash on import | exit 1 (same message) |
| `sync` | exit 1, crash on import | **no crash on import**; exit 1 on its own terms here (`SOURCE_LIST_FAILED`: the test source endpoint is unreachable) |
| `backfill` | exit 1, crash on import | **no crash on import**; exit 1 `SOURCE_LIST_FAILED` |
| `replay --period` | exit 1, crash on import | **no crash on import**; exit 1 `SOURCE_LIST_FAILED` |

So, with the manifest missing:
- a no-op `migrate` exits 0 where it used to exit 1;
- `sync`, `backfill` and `replay` no longer crash on import;
- `--status`, `doctor` and any real apply still exit 1 (the fresh-database
  case is in the table above this one).

With the manifest present, every result is identical (requirement c).

**Requirement (c): identical CLI results.** The scratch `cli-diff.sh` ran on a
fresh fixture DB:
- `migrate --status --json` (pending, exit 3);
- `migrate` (twice, exit 0);
- `migrate --status --json` (exit 0);
- `doctor --json --tenant` with a worker login and one never-published source
  (exit 1);
- `doctor` as superuser (refused `UNSAFE_DB_ROLE`, exit 1).

It ran with the eager build before the fix and the lazy build after it. Volatile
fields (timestamps, durations, git SHA) were normalised, and
`diff -r before after` is **empty** (13 files, 4851 bytes).

**Requirement (d): drift and dump tests.** `foundation.db.test.ts` runs
verbose with 37/37 passing, including:
- "a fresh 0001 apply produces exactly FOUNDATION_0001 (the stored manifest)";
- "the shipped migrations directory carries the 0001 manifest file, equal to
  FOUNDATION_0001";
- "dump a migrated database, restore it into a fresh one: the foundation still
  matches and the check passes" (`RATIO_PG_DUMP`/`RATIO_PSQL` = PG16 binaries).

**Requirement (e):** only the two files changed.

**Regression test under a real `next start`:** `npm run local:test` (§7). It
is now a CI step.

## 5. Mutation checks (scratch `mutate.sh`; each mutation applied, run, file restored from a backup copy; tree clean afterwards)

| ID | Control | Mutation | Result |
|---|---|---|---|
| M1 | auth | the `evaluateLiveDataAuth` refusal is skipped | **killed**: route tests 4 failed / 12 (no token configured, weak token, throttling, query-string token) |
| M2 | tenant scope | the tenant is taken from an `x-ratio-tenant` header when present | **killed**: DB 1 failed / 21 (D1 "request headers cannot switch the tenant") |
| M2b | tenant scope | the tenant is memoised from the first request (bleed across requests) | **killed**: DB 10 failed / 21 |
| M3 | unsafe-login refusal | `assertSafeReaderLogin` removed | **killed**: DB 9/21, serial 53/56 |
| M3b | unsafe-login refusal | reader rule "cannot reach ratio_worker" removed | **killed**: DB 3/21 |
| M3c | unsafe-login refusal | Slice 1's `roleProblems` dropped (only the reader rules remain) | **killed**: DB 3/21, serial 53/56 |
| M4 | published-only | page read from `ratio.cost_facts` (all statuses) instead of the view | **killed**: DB 12/21, every read 500 (the reader has no grant on the base table: the view-only grant is the backstop) |
| M5 | lazy load | eager `FOUNDATION_0001` (import-time read) restored | **killed**: `lazyFoundation.test.ts` 7/9 (incl. the no-I/O test) |

## 6. Gates (HEAD = 5c182da + this file; worktree; `npm ci` fresh)

| Gate | Result |
|---|---|
| `npm ci` | exit 0 |
| `npm run lint` | exit 0 |
| `rm -rf .next && npx tsc --noEmit` | exit 0 |
| `npm test` ×3, **in parallel** (load; `test:db` ran at the same time) | 98 files / **2213 tests** passed, ×3 (baseline 92/2119; +94 new) |
| `npm run test:db` ×5 (private PG16 + S3) | **589 + 160 passed** ×5; 157 / 108 / 108 / 107 / 109 s (baseline 568 + 104; +21 DB, +56 serial) |
| `npm run worker:build` | exit 0 |
| `next build` (Turbopack) | exit 0; `/api/v1/costs/published` listed (ƒ). `tsconfig.json`/`next-env.d.ts` rewritten by Next and restored with `git checkout`. |
| `npm run check:bundle` | pass; 116 client files and 91 server files scanned, no problem |
| legacy grep `pg-protocol\|ratio\.tenant_id\|schema_migrations\|S3FocusExportSource\|csv-parse\|ingest_artifacts\|cost_facts_published` over `.next/static` | 0 files |
| full local flow, individual commands (§7) | pass |
| `npm run local:test` (CI command) | pass (§7) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `ps` / docker after the runs | no `next`, worker, vitest or `local.mjs` process; no `ratio-local*` container, volume or network; no `.ratio-local/`. (The only `weed` process is the pre-existing shared `ratio-s3` container.) |
| `.github/workflows` | +13 lines (two steps after Build); the governance tests (`scripts/governance`, 397) pass. **Not executed in GitHub** (no push). |

A `MaxListenersExceededWarning` in the DB suite is pre-existing: it also
appears in the baseline run on origin/main.

## 7. Local stack end to end

**Individual commands** (`RATIO_LOCAL_PROJECT=ratio-local-s2a`, ports 55710/18710/3710):

| Step | Result |
|---|---|
| `local:up` | secrets generated (0600) into `.ratio-local/env`: this run predates per-project state (f94034d); with today's code the same run writes `.ratio-local/ratio-local-s2a/env`; PG16 asserted (`server_version_num` 16xxxx); bootstrap verified |
| `local:migrate` | as the non-superuser `ratio_local_migrator` (member of `ratio_owner`, NOCREATEROLE); `currentVersion 0001`, **`privilegeProblems: []`** (Slice 0's catalog check judged the bootstrapped logins) |
| `local:seed` | 5 SYNTHETIC fixture objects uploaded; tenant + source provisioned as the owner login |
| `local:sync` | 2026-07-01 `published`, 2026-08-01 `published`, pass true (worker login accepted by Slice 1's startup check) |
| `local:sync` again | both `skipped_unchanged` |
| `docker compose --profile worker run --rm worker` (optional one-shot container) | both `skipped_unchanged`, exitCode 0 |
| `docker compose --profile app up -d app` (optional) | anonymous `GET /api/v1/costs/published` → **401**; with the Bearer token → totals 55 / `30.8272954899` and 40 / `21.0978157665` |
| `local:down -- -v` | containers 0, volumes 0, networks 0, `.ratio-local/` gone |

**`npm run local:test`** (up ×2 → migrate ×2 → seed ×2 → sync → sync → `next start`
→ API → `down -v`):
```
{"type":"ratio.local-test","project":"ratio-local-s2a","steps":{"up":"ok (twice)",
 "migrate":{"currentVersion":"0001","privilegeProblems":[]},"seed":"ok (twice)",
 "sync":{"2026-07-01":"published","2026-08-01":"published"},
 "syncAgain":{"2026-07-01":"skipped_unchanged","2026-08-01":"skipped_unchanged"},
 "anonymous":401,
 "api":{"totals":[{"billingPeriod":"2026-07-01","billingCurrency":"USD","rowCount":55,"billedCost":"30.8272954899"},
                  {"billingPeriod":"2026-08-01","billingCurrency":"USD","rowCount":40,"billedCost":"21.0978157665"}],
        "rows":95,"distinct":95},"down":"ok (-v)"},"pass":true}
```
The reader totals equal `fixtures/focus-1.0-synthetic/control-totals.json`
(`base`) **as exact strings**. 95 rows over 6 pages (limit 17), all distinct.

**Local findings.**
- SeaweedFS's default `volume.max=8` cannot grow a second bucket: the first
  attempt saw 2 worker retries (`EVIDENCE_STORE_FAILED`), then a 60 s stall.
  The compose file now sets `-volume.max=64 -master.volumeSizeLimitMB=64`, and
  `local:seed` warms each bucket.
- The worker needs `RATIO_SOURCE_S3_FORCE_PATH_STYLE=1` (not `true`).

## 8. How the API authenticates (existing mechanism, reused)

1. `evaluateLiveDataAuth(req, { countAbsent: true })` from
   `src/server/gateway/liveDataAuth.ts` is the repo's deny-by-default Bearer
   check for cost data:
   - it compares with `RATIO_API_TOKEN` in constant time;
   - no token configured, or a missing or wrong token ⇒ 401;
   - a weak configured token ⇒ 503;
   - repeated failures from one client ⇒ 429; a valid token is never
     throttled.
2. `withGateway(handler, { methods: ['GET'] })` adds 405, the body-size guard,
   the gateway's token check, the per-tenant 1,000/min rate limit,
   structured logging and the generic 500.
3. **Tenant:** "one API key per tenant". The key is bound server-side by
   `RATIO_API_TENANT_ID`:
   - validated as a canonical UUID at startup (`instrumentation.ts`) and per
     request (503 if missing or invalid);
   - never read from the request (a `tenant` parameter ⇒ 400; headers are
     ignored).
4. **Database identity:** `RATIO_READER_DATABASE_URL` is checked on every
   request before any read, by Slice 1's `inspectRole`/`roleProblems` (Slice
   0's `REFUSED_PREDEFINED_ROLES`) plus the reader rules ⇒ 503
   `unsafe_db_login`.

## 9. Known gaps and open items

- **The residual difference of the lazy load** (§4): an empty ledger table
  after `migrate` with a missing manifest.
- The read API's tenant safety rests on credential custody (D-06). One tenant
  per deployment until D-10.
- Pages are consistent per page, not across pages: a republish between page
  requests can mix revisions. Each row carries `batchId` and `publishedAt`.
- `totals` scans the filter on every first page. That is fine at pilot size.
- The CI steps have not run on GitHub (no push). Docker Compose v2 on
  `ubuntu-latest` and the image pulls are expected to add about 1–2 min to a
  job that currently runs about 3.5–4 min under a 10 min timeout.
- The deployment brief records D-01..D-10 as DECIDED (owner delegation to the
  orchestrator, 2026-10-04). The production go-live sign-off is NOT delegated (non-delegable owner gate). Owner actions: (1) go-live sign-off, (2) hosting spend, (3) GitHub App, (4) real billing data, optional. The acceptance run uses the public FOCUS 1.0 Sample Data (CC BY 4.0) in a follow-up PR after #59.

## 10. Challenger Lows and Copilot review of PR #59 (local batch on 323984e; not pushed)

### Commits

| SHA | Commit | Kind |
|---|---|---|
| 03f6cf7 | tests for every item below | **red** (`red/red-lows-{fast,db,serial}.txt`: fast 23 failed / 83, DB 12 failed / 25, serial 54 failed / 57) |
| 42b136f | API: NOLOGIN kill switch, distinct 503 event with requestId, one snapshot per page | green |
| f94034d | local: per-project state, 0600 env file, isolated `local:test`, verified readiness | green |
| 52d941d | test: a pool without the REPEATABLE READ default is refused (kills mutant S2) | test |
| beb30b4 | docs: decisions recorded, kill switch corrected, DESIGN Slice 0 claims fixed, TEST_PLAN §D | docs |
| (this commit) | docs: D-02 = public FOCUS sample data; this section | docs |

Three tests closed gaps and passed on first run, as expected: C2, K2 (D9) and
the per-request NOLOGIN case's 200 control. Their teeth are shown by the
mutations below (C2, K2a, K2b).

### Mapping

| Finding | Commit(s) | Test(s) |
|---|---|---|
| Challenger L1: record the lazy-load side effects | beb30b4 (DESIGN §7), this commit (§4 table) | scratch `sideeffects.sh`, eager vs lazy (§4) |
| Challenger L2: NOLOGIN does not end pooled sessions; refuse `rolcanlogin = false` | 42b136f, beb30b4 (brief §6) | `readerLogin.test.ts` LOGIN_DISABLED; DB D6 "a pooled login set NOLOGIN…" (session still alive ⇒ 503 ⇒ LOGIN ⇒ 200) |
| Challenger L3: 503 logged as unhandled_error/500 | 42b136f | route R5; DB D6 log test; serial "codes only" test |
| Challenger L4: page 1 and totals in one snapshot | 42b136f, 52d941d | DB D8 (publish injected between the queries; isolation; fail closed on a READ COMMITTED pool) |
| Challenger L5: K2 (two sources, source_id tie-break) | 03f6cf7 | DB D9 |
| Challenger L5: L3 (env file 0600) | f94034d | `local.test.mjs` L10 |
| Challenger L5: C2 (startup log never echoes the tenant) | 03f6cf7 | `config.test.ts` C2 (six value shapes + the URL) |
| Challenger L6: per-project `.ratio-local/<project>/`; readiness checks it is our server | f94034d | `local.test.mjs` L9, L11, L12; scratch `isolation-e2e.sh` |
| Copilot 4175802603 (lib.mjs:8, per-project state) | f94034d | L9, L10; isolation e2e |
| Copilot 4175802639 (local.mjs:292, stale listener) | f94034d | L11 preflight, L12 `/proc` ownership; isolation e2e (foreign server ⇒ refused; `appReady: pid-verified`) |
| Copilot 4175802660 (publishedCosts.ts:98, tie-break untested) | 03f6cf7 | D9; mutations K2a (ORDER BY) and K2b (cursor predicate) both killed |
| Copilot 4175802675 (publishedCosts.ts:113, REPEATABLE READ READ ONLY) | 42b136f, 52d941d | D8 (3 tests). **No Slice 0 change**: `withTenantTransaction` is untouched; the reader pool defaults to REPEATABLE READ and the read asserts it in-transaction (`transaction_isolation`, `transaction_read_only`). `SET TRANSACTION` inside the callback is impossible: the helper's `set_config` query has already fixed the isolation level |
| Copilot 4175802693 (route.ts:88, 503 log + requestId) | 42b136f | R5; D6; serial |
| Copilot 4175802721 (brief §6 kill switch) | 42b136f (code), beb30b4 (text) | D6 NOLOGIN test; brief §6 states what the code does (NOLOGIN stops new connections; the per-request `rolcanlogin` check refuses pooled sessions; `pg_terminate_backend` or a restart ends them) |
| Copilot 4175802745 / 4175802771 (DESIGN.md "Slice 0 untouched") | beb30b4 | — (docs: DESIGN intro and §6 state the one Slice 0 touch, 9d83590) |

**Not changed, on purpose:**
- **No nonce route or header** for the readiness probe. It would add a
  test-only endpoint to the production app. The port preflight, fail-fast on
  child exit, and `/proc` listener ownership (on Linux) cover the stale-listener
  case instead.
- **Slice 0's `tenant.ts` not extended.** The pool-level default achieves the
  snapshot without touching it.

### Mutation checks (scratch `mutate2.sh`, `mutate3.sh`; each applied, run, restored; tree clean after)

| ID | Mutation | Result |
|---|---|---|
| K2a | `source_id` dropped from the ORDER BY | **killed**: DB 1/25 (D9) |
| K2b | `source_id` dropped from the cursor predicate | **killed**: DB 15/25 |
| N1 | `rolcanlogin` rule removed | **killed**: unit 3/12, DB 1/25 |
| E1 | 503 refusal logged through the generic `unhandled_error`/500 path | **killed**: route 1/13 |
| E2 | `requestId` dropped from the 503 body | **killed**: route 1/13 |
| E3 | problem texts (with role names) logged instead of codes | **killed**: route 1/13, serial 1/57 |
| S1 | REPEATABLE READ session default removed | **killed**: DB 24/25 (the in-transaction assertion refuses every read) |
| S2 | in-transaction isolation assertion removed (pool still RR) | survived at first (25/25); **killed** after 52d941d: DB 1/26 ("fails closed on a pool that does not start transactions at REPEATABLE READ") |
| S1+S2 | both removed | **killed**: DB 3/26, including D8's publish-injection test on its own |
| C2 | startup log includes the invalid tenant value | **killed**: config 1/9 |
| L3 | env file not tightened to 0600 on rewrite | **killed**: local 1/34 |
| L6a | `local:test` falls back to the developer project name | **killed**: local 1/34 |
| L6b | `down -v` removes every project's state | **killed**: local 1/34 |
| L6c | readiness accepts any socket of our process, not the listener | **killed**: local 1/34 |

### End-to-end isolation (scratch `isolation-e2e.sh`)

1. A developer stack runs (project `ratio-local-s2dev`): 2 containers; env
   file mode 600, directory 700.
2. `local:test` (project `ratio-local-s2t`) passes alongside it:
   - `appReady: pid-verified`;
   - exact control totals;
   - `down -v` of its own project only;
   - the developer stack is still running, and its env file is byte-identical
     (same sha256).
3. A foreign HTTP server on the test app port ⇒ `local:test` exits 1 with
   "refuses to start (nothing was changed): port(s) already in use on
   127.0.0.1: 3710". 0 test containers were created, and the developer stack
   is untouched.
4. The developer stack is taken down with `down -v`; no container, volume or
   `.ratio-local/` is left.

### Gates (HEAD beb30b4 + docs; fresh `npm ci`)

| Gate | Result |
|---|---|
| `npm ci` / `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 / 0 |
| `npm test` ×3 in parallel, while `test:db` ran | 99 files / **2238** passed ×3 |
| `npm run test:db` ×5 (private PG16 at 55700 + S3 prefixes) | **594 + 161** passed ×5; 157 / 109 / 110 / 107 / 109 s |
| `worker:build`; `next build` | 0; 0 (`tsconfig.json`/`next-env.d.ts` restored) |
| `npm run check:bundle` | pass (116 client files, 91 server files) |
| `npm run local:test` (default isolated settings: `ratio-local-test`, 54339/18353/3110) | pass; `appReady: pid-verified`; totals 55 / `30.8272954899`, 40 / `21.0978157665`; 95 distinct rows; `down -v` |
| `npm audit --omit=dev` | 0 vulnerabilities |
| leftovers (`ps`, docker, `.ratio-local/`) | none |

### §10 addendum

**D-01 enforcement is issue #60.** The brief's Appendix A now points to it.

## 11. Challenger delta review of 323984e..85e6185 (REQUEST CHANGES: 1 Medium, 6 Low); local, not pushed

### Commits

| SHA | Commit | Kind |
|---|---|---|
| 2ed1748 | tests for every code item | **red** (`red/red-delta-{fast,db}.txt`: fast 14 failed / 101, DB 1 failed / 27) |
| 30b8f55 | code notes, N3, local helpers | green |
| 21d9ce7 | D-01 tightened, D-02 facts, go-live gate, DESIGN §2.2/§2.4/§9, TEST_PLAN §E | docs |
| (this commit) | this section | docs |

**Gap tests that passed on first run, as expected:** "an existing 0755 state
directory becomes 0700" (L6f), plus the N3 NULL-`rolcanlogin` and
NULL-reader cases, which the old truthiness checks already refused. Their
teeth are shown below (L6f, N3c).

### Mapping

| Finding | Commit(s) | Test(s) / evidence |
|---|---|---|
| **Medium**: D-01 too loose (SSE-S3 is S3's default; `aws/s3` SSE-KMS is transparent to `s3:GetObject`) | 21d9ce7 | Docs: Decision log, §1 and Appendix A now say unrestricted only with SSE-KMS under a customer-managed key (key policy as access control) or client-side encryption; SSE-S3 and `aws/s3` explicitly restricted. Appendix A references **#60**, with acceptance criteria that `AES256` and `aws/s3` (alias or ARN) classify as restricted, plus mutations for both |
| Low: D-02 facts | 21d9ce7 | Docs: `FOCUS-1.0/focus_sample.csv`, `FOCUS-1.0/focus_sample_10000.csv`; AWS, Microsoft and Oracle only (no Google in these files); the claim cited from `FOCUS-1.0/README.md` at adbdd17 |
| Low: L6e (`owned === false` ignored) | 2ed1748, 30b8f55 | `local.test.mjs` L13 (`waitForOwnServer` is now in `lib.mjs`, injectable probe/owns/clock); mutation L6e killed |
| Low: L6f (existing directory to 0700) | 2ed1748 | L14; mutation L6f killed |
| Low: port re-check before spawn (no `/proc`) | 2ed1748, 30b8f55 | L15 (`portInUse` against a real listener; `startIfPortFree` never spawns on a busy port; `local.mjs` spawns only through it); mutation P1 killed |
| Low: DESIGN §2.2/§2.4 | 21d9ce7 | NOLOGIN rule, fail-closed fields, codes-only logging, `default_transaction_isolation`, the per-request statement list (two catalog queries, not one), the 503 `requestId`, `no-store` |
| Low: governance, production go-live not delegated | 21d9ce7 | Brief banner "PRODUCTION GO-LIVE IS A NON-DELEGABLE HUMAN GATE"; §7 owner actions: (1) go-live sign-off, (2) hosting spend, (3) GitHub App, (4) real billing data, optional; §8 ends with the sign-off check. The Decision log is unchanged apart from the D-01 / D-02 corrections and renumbered owner-action references |
| Low: `Cache-Control: no-store` on errors | 2ed1748, 30b8f55 | route R6 (401, 429, 503 weak, 405, 400, 503 not_configured, 503 unsafe, 500) and D1 (200). Set once, first thing in the route, so the gateway's own errors are covered; mutation CC1 killed |
| Low: test-only `hooks` on the public signature | 2ed1748, 30b8f55 | `testSeam.test.ts` (3 parameters; seam refused outside vitest; no production file names it); D8 now uses the seam; mutations TS1, TS2 killed; **X1 re-run: D8x and D8y killed** |
| Low: N3, a missing session_user row treated as login-capable | 2ed1748, 30b8f55 | `readerLogin.test.ts`: no row, NULL `rolcanlogin`, NULL reader, NULL worker ⇒ refused (strict `=== true` / `=== false`); DB D6: a login dropped while pooled is never served. Live probe: Postgres raises 42704 "invalid role OID" on every statement of a session whose role was dropped (`session_user`, `current_user`, the `rolcanlogin` query), so the read fails closed with a 500; mutations N3a–N3c killed |

### Mutation checks (scratch `mutate4.sh`; each applied, run, restored; tree clean after)

| ID | Mutation | Result |
|---|---|---|
| L6e | `waitForOwnServer` ignores `owned === false` | **killed**: local 1/44 |
| L6f | existing state directory not tightened to 0700 | **killed**: local 1/44 |
| P1 | no port re-check before spawning `next start` | **killed**: local 1/44 |
| N3a | NULL worker reachability treated as safe | **killed**: readerLogin 2/16 |
| N3b | a missing reader row crashes instead of refusing | **killed**: readerLogin 1/16 |
| N3c | NULL `rolcanlogin` treated as login-capable | **killed**: readerLogin 2/16 |
| CC1 | `Cache-Control: no-store` removed | **killed**: route 1/14, DB 1/27 |
| TS1 | seam allowed outside vitest | **killed**: seam 1/3 |
| TS2 | `hooks` parameter back on the public signature | **killed**: seam 1/3 |
| D8x | **X1 re-run through the seam**: REPEATABLE READ default AND the in-transaction assertion removed | **killed**: DB 3/27, incl. D8 "a publish committed between the page query and the totals query cannot make them disagree" |
| D8y | the seam call removed from the read (no publish injected) | **killed**: DB 1/27 (D8 notices the publish never ran) |

### Gates (HEAD 21d9ce7 + this file)

| Gate | Result |
|---|---|
| `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 |
| `npm test` | **2256 passed** ×3, sequential, each run concurrent with `test:db` (load average about 12) |
| `npm test` ×3 in parallel *and* concurrent with `test:db` (an extra stress run) | 2254/2256 ×3: the pre-existing Slice 1 test `src/ingest/worker/periods.test.ts` timed out at vitest's 5 s default. It spawns 8 `tsx` children and takes 3.6 s alone; it passes alone and in every sequential run; neither it nor `periods.ts` was changed in Slice 2. Not fixed (a Slice 1 test; out of scope). Noted for a follow-up: a per-test timeout like `cli.process.test.ts` has. |
| `npm run test:db` ×3 (private PG16 at 55700 + S3 prefixes) | **595 + 161** passed ×3; 123 / 114 / 110 s |
| `worker:build`; `next build` | 0; 0 (`tsconfig.json`/`next-env.d.ts` restored) |
| `npm run check:bundle` | pass (116 client files, 91 server files) |
| `npm run local:test` (`ratio-local-test`, 54339/18353/3110) | pass; `appReady: pid-verified`; totals 55 / `30.8272954899`, 40 / `21.0978157665`; 95 distinct rows; `down -v` |
| `npm audit --omit=dev` | 0 vulnerabilities |
| leftovers | none |

## 12. Copilot review of 0e972ca (1 High, 1 Medium, 6 Low); local, not pushed

### Commits

| SHA | Commit | Kind |
|---|---|---|
| 4f6fea3 | L16 tests: stopping `next start` and cleanup never hang | **red** (`red/red-copilot2-fast.txt`: 11 failed / 55) |
| 914f5bf | bounded child stop and cleanup in `lib.mjs`; `local.mjs` uses them | green |
| bf8a442 | D-01 audited CMK allowlist; per-project state paths; the brief's opening states the governance state | docs |
| (this commit) | this section | docs |

### Mapping

| Comment | Severity | Commit(s) | Test(s) / evidence |
|---|---|---|---|
| 4176004971: cleanup hangs if `next start` already ended by a signal (`exitCode` stays `null`) | **High** | 4f6fea3, 914f5bf | `local.test.mjs` L16 (11 tests): `childExited` treats `exitCode !== null \|\| signalCode !== null` as exited; an already-signalled child gives `already-exited` at once, with no kill; a REAL child SIGKILLed before the wait does not hang; a child that ignores SIGTERM is SIGKILLed (`killed`); a child that obeys gives `stopped`; one that never exits gives `unresponsive` after bounded waits; `cleanupLocalTest` runs `down -v` exactly once with an already-signalled app, when stopping throws, and with no app; a failing `down` is reported, not thrown; `runProcess` timeout kills and rejects; a static check that `local.mjs` cleans up only through `cleanupLocalTest`, has no `once('exit'`, delegates `run` to `runProcess`, and passes `timeoutMs: DOWN_TIMEOUT_MS` (300 s) to `down`. **Audit of every exit wait:** the cleanup in `local:test` was the only unbounded one. `run()` attaches its `close` listener at spawn, so it cannot miss an exit, and it now has an optional bounded timeout. `waitForOwnServer` already checked both fields. Mutations H1–H5 killed |
| 4176004999: D-01 should use an audited CMK allowlist | Medium | bf8a442 | Docs: Decision log D-01, §1 and Appendix A (**#60**). "Unrestricted" now requires SSE-KMS under a key ARN on an audited allowlist. Each entry records `keyArn`, `policySha256`, `reviewedBy` and `reviewedAt`. An optional `kms:GetKeyPolicy` re-check compares the hash and fails closed. A customer-managed key that is not on the list is restricted. New Appendix A acceptance criteria (numbered 1–6): a non-allowlisted CMK, a hash mismatch, a KMS error, and an alias or key id that does not match an ARN all give restricted; an `aws/s3` entry is rejected; every malformed allowlist file gives restricted; `policySha256` is persisted with the classification. New mutations for each. DESIGN §9 and §10 |
| 4176005021: `.env.example:168` stale `.ratio-local/env` | Low | bf8a442 | Now `.ratio-local/<project>/env`. The `RATIO_LOCAL_TEST_*` defaults are documented as names and comments only, with no secrets |
| 4176005056: DESIGN.md:263-264 stale path | Low | bf8a442 | §3.1 names `.ratio-local/<project>/env` (directory 0700, file 0600) |
| 4176005072: DESIGN.md:319 stale path | Low | bf8a442 | The threat-model line names the per-project path |
| 4176005092: EVIDENCE.md:184 stale path | Low | bf8a442 | The historical run is kept as recorded, with a note: it predates per-project state (f94034d), and today's code writes `.ratio-local/ratio-local-s2a/env` for that run |
| 4176005111: `bootstrap.mjs:6` stale comment | Low | bf8a442 | The comment now names `.ratio-local/<project>/env`. A repo-wide grep for `.ratio-local/env` finds only the annotated historical line (§7) and DESIGN §10's description of this fix |
| 4176005032: the brief's opening should state the governance state | Low | bf8a442 | The brief now opens with "Governance state, in three lines": (1) D-01..D-10 were decided by the orchestrator under the owner's delegation; (2) production go-live remains a NON-DELEGABLE owner gate; (3) the acceptance run uses public sample data (FOCUS 1.0 sample, CC BY 4.0) in a follow-up PR, not #59. Owner actions 1–4 follow |

### Mutation checks (scratch `mutate5.sh`; each applied, run, restored; tree clean after; no orphan children)

| ID | Mutation | Result |
|---|---|---|
| H1 | `childExited` checks only `exitCode` (the reported bug) | **killed**: local 4/55 (`childExited`; already-signalled; REAL SIGKILLed child; cleanup with signalled app) |
| H2 | cleanup skips `down` when stopping the app throws | **killed**: local 1/55 |
| H3 | no SIGKILL escalation | **killed**: local 2/55 |
| H4 | `runProcess` ignores `timeoutMs` | **killed**: local 1/55. The first run of H4 hung vitest: the untimed child was never killed. The test now spawns through a tracked `spawnFn` that `afterAll` SIGKILLs, and the re-run fails cleanly |
| H5 | `waitForExit` unbounded (timer never resolves) | **killed**: local 2/55 |

### Gates (HEAD bf8a442 + this file)

| Gate | Result |
|---|---|
| `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 |
| `npm test` | **2267 passed** (100 files), run concurrently with `test:db` |
| `npm run test:db` ×2 (private PG16 at 55700 + S3 prefixes) | **595 + 161** passed ×2; 110 / 107 s |
| `worker:build`; `next build` | 0; 0 (`tsconfig.json`/`next-env.d.ts` restored) |
| `npm run check:bundle` | pass (116 client files, 91 server files) |
| `npm run local:test` (`ratio-local-test`, 54339/18353/3110) | pass; `appReady: pid-verified`; totals 55 / `30.8272954899`, 40 / `21.0978157665`; 95 distinct rows; **`appStop: stopped`**; `down: ok (-v)` |
| `npm audit --omit=dev` | 0 vulnerabilities |
| leftovers | none (see final check below) |

Slice 0 (`src/ingest/db`) and Slice 1 worker semantics are unchanged in this
round. The pre-existing Slice 1 `periods.test.ts` timeout under extreme load
(§11) still stands and is not addressed here.

## 13. Copilot review of 551c16c (3 Medium, 2 Low); local, not pushed

### Commits

| SHA | Commit | Kind |
|---|---|---|
| feb9901 | L17 (deadlines) and L18 (summary finalisation) tests | **red** (`red/red-copilot3-fast.txt`: 52 failed / 106) |
| 95f8786 | hard deadline on every wait; local:test fails on an unclean app stop | green |
| 37b22c0 | brief §1 historical; documented ports, projects and paths match the code; DESIGN §11, TEST_PLAN L16–L18 | docs |
| (this commit) | this section | docs |

**Changes to tests after red (no assertion weakened):**
- One static regex in L17 was wrong. `/\bfetchFn\(url, \{[^}]*signal/` stopped
  at the first `}` inside the `headers` object, so it could never match. It
  is now `/\bfetchFn\(url, \{[^\n]*, signal \}\)/`, which asserts the same
  thing: `fetchJson` passes the deadline's signal to `fetch`.
- L16's static check used to look for `await cleanupLocalTest({` in
  `local.mjs`. Cleanup now goes through `runLocalTest` in `lib.mjs`, so the
  check asserts that `local.mjs` calls `runLocalTest({` and that `lib.mjs`
  calls `cleanupLocalTest({`. Every other L16 assertion is unchanged.

### Mapping

| Comment | Severity | Commit(s) | Test(s) / evidence |
|---|---|---|---|
| 4176117539: `waitFor` checks its deadline only after `fetch` resolves, so a stalled S3 or app endpoint hangs `local:up` (local.mjs:131, :310) | Medium | feb9901, 95f8786 | `waitFor` is removed and replaced by `waitUntil` (lib.mjs). Each attempt runs under `withDeadline(min(attemptTimeoutMs, remaining))`, which aborts the attempt's signal. The overall deadline is checked before every attempt and caps every sleep. `waitForOwnServer` (readiness, :310) has the same structure. L17 covers it with a real TCP server that accepts and never answers: `waitUntil` (s3) and `waitForOwnServer` each fail within their deadline and every attempt signal is aborted. They also fail when a probe ignores its signal, and when one attempt would outlast the overall deadline. Mutations W1–W4 and F9 killed |
| 4176117553: the end-to-end API reads have no time limit, so a stuck `next start` blocks the `finally` teardown (local.mjs:263) | Medium | feb9901, 95f8786 | `fetchJson` bounds every read at `API_REQUEST_TIMEOUT_MS` = 30 s, longer than the route's 10 s `statement_timeout` (a static test reads both values from source). The limit covers the headers AND the body: a stalled body is now a timeout, where the old `r.json().catch(() => null)` silently returned null. L17 tests three cases: no headers, then a stalled body, both within the deadline; and `runLocalTest` with a stalled readiness probe or a stalled API read, where the run fails within its deadline and `down -v` still runs exactly once. **Sweep:** every wait in `scripts/local/*.mjs` has a hard deadline (inventory below). Mutations W5–W10 and F8 killed |
| 4176117561: an `unresponsive` or `error` app stop must fail the run (local.mjs:353); with challenger Lows 1 and 2 | Medium | feb9901, 95f8786 | The pure function `finalizeLocalTestSummary` (lib.mjs) decides. A run passes only when the body completed, the app stop was `stopped` or `killed`, and `down -v` returned `ok`. Everything else fails, unknown values included (fail closed). Every result is still recorded. `runLocalTest` runs the body, then always the bounded cleanup, then the finalisation. `local.mjs` exits 1 unless `summary.pass`, and `summary.failures` lists the reasons. L18 covers all 28 combinations (body error × 7 app results × 2 down results), each of the three single failures alone, `already-exited` and never-started, `runLocalTest` end to end, and static checks: `setApp` right after the spawn, the exit code taken from `summary.pass`, and no `summary.pass =` in `local.mjs`. **Challenger T1** (dropping `pass = false` on a failed `down`) is now mutation F1, and it is killed. F2 and F3 kill the `unresponsive` and `error` variants. F4–F7 killed |
| 4176117574: DEPLOYMENT_BRIEF.md:54 still calls D-01 unresolved | Low | 37b22c0 | Brief §1 changes: <ul><li>retitled "Option analysis considered before the decisions (historical rationale)", with a note that it records no open question;</li><li>the D-01 sentence is in the past tense and names the resolution;</li><li>every "Recommended default (now DECIDED)" reads "Recommended, then adopted (Decision log)";</li><li>"Choose / Decide" wording is labelled as revisit triggers;</li><li>"Blocks" reads "Depended on this decision";</li><li>the D-02 manifest-semantics item is labelled a known test gap, not an open decision.</li></ul> **Sweep** of the brief, DESIGN, EVIDENCE and TEST_PLAN (grep for unresolved, pending, open, owner must or decides, to be decided, recommended default, choose, decide, Blocks): nothing else open about D-01..D-10. DESIGN §1 no longer says the brief records the decisions in "§8"; it now points to the Decision log. Outside the four docs, two headers in Slice 2 files called decided items "owner decisions", and both are fixed: `docker-compose.local.yml` (hosting) and `scripts/local/bootstrap.mjs` (D-04) |
| 4176117585: DESIGN.md:302 lists the developer ports, but CI runs `local:test` on 54339/18353/3110 | Low | 37b22c0 | DESIGN changes: <ul><li>§3.2 has a settings table for the developer stack and for `local:test`, taken from `localSettings` / `localTestSettings`;</li><li>the data flow names `local:test`'s own project, ports and preflight, and the pass rule;</li><li>`local:down -v` removes `.ratio-local/<project>/`;</li><li>§3.3: CI runs `local:test` on `ratio-local-test` 54339/18353/3110, clear of 5432/8333 and of the developer defaults;</li><li>the component row says `-p <project>` always overrides the compose file's `name: ratio-local`.</li></ul> The CI comment names the app port 3110, and the compose header notes `-p`. TEST_PLAN separates the `ratio-local-s2a` run of the individual commands from `local:test`'s defaults. **Sweep** (scripted, `check_names.py`): every backticked repository path in the four Slice 2 docs exists; every `RATIO_*` name occurs in code or configuration; every `npm run` script exists; every port mentioned is a code default, the shared SeaweedFS (18333), the private test cluster (55700), the shared cluster named only as avoided (55432), or the recorded `ratio-local-s2a` run (55710/18710/3710) |

**Not changed, and why:** some Slice 0 and Slice 1 docs and tests still call
items "owner decisions". They are historical, and the Slice 0/1 tests may not
change. `.obvious/skills/ingestion-ops/SKILL.md` still calls retention (D-03)
and the ledger grant (D-05) "owner decisions". It is outside Slice 2, so it is
reported to the coordinator instead of changed here.

### Deadline inventory: every wait in `scripts/local/*.mjs`

| # | Wait | Where | Hard bound | On expiry |
|---|---|---|---|---|
| 1 | `docker ps` (preflight) | local.mjs `localTest` → `runProcess` | 60 s | SIGKILL of the process group, immediate reject (§13a) |
| 2 | `docker compose up -d --wait` | `up` | 600 s (allows a first image pull in CI) | SIGKILL of the process group, immediate reject (§13a) |
| 3 | `docker compose down [-v]` | `down` (developer `local:down` and local:test cleanup) | 300 s; local:test also wraps it in a 330 s `withDeadline` | SIGKILL of the process group, immediate reject (§13a); the cleanup records `error: …` and the run fails |
| 4 | `npm run worker:build` | `migrate`, `workerCli` | 300 s | SIGKILL of the process group, immediate reject (§13a) |
| 5 | worker CLI `migrate`, `migrate --status`, `sync` | `workerCli` | 600 s each (the worker also has its own `RATIO_MAX_RUN_SECONDS` and stall timeouts) | SIGKILL of the process group, immediate reject (§13a) |
| 6 | Postgres readiness | `up` → `waitUntil` | 120 s overall, 5 s per attempt | reject "timed out waiting for postgres" |
| 7 | S3 readiness (`fetch` with `signal`, body cancelled) | `up` → `waitUntil` | 120 s overall, 5 s per attempt | attempt aborted; reject at overall |
| 8 | every Postgres session (readiness probe; version check and bootstrap; seed provisioning) | `withClient` | connect 5 s; each statement 60 s (`query_timeout` client-side and `statement_timeout` server-side); `end()` 5 s; whole session 120 s | the socket is destroyed (also when the caller's signal aborts); reject |
| 9 | S3 `CreateBucket` | `seed` | 30 s via `withDeadline` with `abortSignal`; client handler connect 5 s, request 30 s | request aborted; reject |
| 10 | bucket warm-up (put + delete) | `seed` → `waitUntil` | 60 s overall, 30 s per attempt, both sends with `abortSignal` | reject |
| 11 | fixture `PutObject` (one per file) | `seed` | 30 s each (`withDeadline` + `abortSignal`) | reject |
| 12 | `portInUse` (preflight ×3, and the pre-spawn re-check) | lib.mjs | 2 s each (hard timer plus socket idle timeout) | counts as busy: refuse (fail closed) |
| 13 | `next start` readiness (`fetch` with `signal`, body cancelled) | `waitForOwnServer` | 60 s overall, 5 s per attempt; fails at once if the child exits | reject; the run fails, cleanup runs |
| 14 | `/proc` listener ownership | `ownsListeningSocket` | synchronous, so bounded by work: at most 4096 processes visited (`maxProcesses`); a seen-set ends cycles | refuse (`false`) |
| 15 | anonymous API read | `fetchJson` | 30 s, headers and body | reject; the run fails, cleanup runs |
| 16 | paginated API reads | `fetchJson` | 30 s each; at most 100 pages (`MAX_PAGES`; more ⇒ the run fails) | as 15 |
| 17 | stopping `next start` | `stopChild` | SIGTERM, 10 s grace; SIGKILL, 5 s; then `unresponsive` | the run fails; `down -v` still runs |
| 18 | `runProcess` without a deadline | lib.mjs | refused before spawning | reject |
| 19 | `withDeadline` / `waitUntil` / `waitForOwnServer` without a positive deadline | lib.mjs | refused | reject |

`bootstrap.mjs` makes no I/O of its own: it runs its statements on the client
it is given (row 8). Local file reads (`fs.*Sync`) and log writes are not
waits. Every network and process step is bounded, so a whole `local:test` run
is bounded too.

### Mutation checks (scratch `mutate6.sh`; each applied, run, restored; tree clean after; 0 orphan children)

| ID | Mutation | Result |
|---|---|---|
| W1 | `waitUntil`: attempt not bounded (the reported bug) | **killed**: local 2/106 |
| W2 | `waitUntil`: attempt bounded by `attemptTimeoutMs` only, not by what is left of the overall deadline | **killed**: 1/106 |
| W3 | `waitForOwnServer`: probe not bounded (the bug reported at :310) | **killed**: 3/106 |
| W4 | `withDeadline` does not abort the signal | **killed**: 3/106 |
| W5 | `fetchJson` passes no signal to `fetch` | **killed**: 1/106 |
| W6 | `fetchJson` deadline ignored (1 h) | **killed**: 4/106 |
| W7 | cleanup: `down -v` unbounded | **killed**: 1/106 |
| W8 | `runProcess` runs without a deadline | **killed**: 1/106 |
| W9 | `portInUse`: no hard timer | **killed**: 1/106 |
| W10 | `/proc` walk: no process cap | **killed**: 1/106 |
| F1 | **challenger T1**: a failed `down -v` does not fail the run | **killed**: 3/106 |
| F2 | an `unresponsive` app passes | **killed**: 3/106 |
| F3 | an `error: …` app stop passes | **killed**: 2/106 |
| F4 | a body error does not fail the run | **killed**: 4/106 |
| F5 | `runLocalTest` rethrows a body error (skips the cleanup) | **killed**: 2/106 |
| F6 | `local.mjs` exits 0 whatever `summary.pass` says | **killed**: 1/106 |
| F7 | `local.mjs` never records the spawned app (no stop at cleanup) | **killed**: 1/106 |
| F8 | `local.mjs` API reads without a deadline | **killed**: 1/106 |
| F9 | `local.mjs` S3 readiness `fetch` without a signal | **killed**: 1/106 |

### Gates (HEAD 37b22c0 + this file)

| Gate | Result |
|---|---|
| `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 |
| `npm test` | **2318 passed** (100 files), run concurrently with `test:db` |
| `npm run test:db` ×2 (private PG16 at 55700 + S3 prefixes) | **595 + 161** passed ×2; 111 / 107 s |
| `worker:build`; `next build` | 0; 0 (`tsconfig.json`/`next-env.d.ts` restored) |
| `npm run check:bundle` | pass (116 client files, 91 server files) |
| `npm run local:test` (`ratio-local-test`, 54339/18353/3110) | pass in 26 s; `appReady: pid-verified`; totals 55 / `30.8272954899`, 40 / `21.0978157665`; 95 distinct rows; `appStop: stopped`; `down: ok (-v)`; **`failures: []`** |
| `npm audit --omit=dev` | 0 vulnerabilities |
| leftovers | none: private cluster stopped and deleted; no `ratio-local*` containers or volumes; no `.ratio-local/`; no sleeper children |

Slice 0 (`src/ingest/db`) and Slice 1 worker semantics are unchanged in this
round. The pre-existing Slice 1 `periods.test.ts` timeout under extreme load
(§11) still stands and is not addressed here.

## 13a. Challenger Low 1 on b27f4ba: the `runProcess` deadline was not hard with `capture: true`

The challenger APPROVED b27f4ba (0 High, 0 Medium). Its Low 1 contradicted
§13: rows 1–5 claimed a hard bound, but with `capture: true` `runProcess`
SIGKILLed only the child and settled only on `close`. `close` never fires
while a grandchild still holds the stdout pipe. The challenger confirmed it
live: the call was still waiting more than 8 s past a 1 s deadline.

### Commits

| SHA | Commit | Kind |
|---|---|---|
| aff055d | L19 tests | **red** (`red/red-challenger-runprocess.txt`: 6 failed / 112; afterAll killed the leftover sleepers) |
| 9227eb5 | the fix | green |
| (this commit) | this section, plus DESIGN §11 | docs |

### Fix (lib.mjs `runProcess`)

- **Its own process group.** Each command is spawned `detached: true`, so it
  runs in its own process group. On timeout, `process.kill(-pid, 'SIGKILL')`
  kills the command **and its descendants**.
- **Rejects at the deadline.** At `timeoutMs` the promise rejects at once
  ("timed out after N ms (killed)") and the stdio pipes are destroyed. It no
  longer waits for `close`.
- **A held pipe after exit.** The command may exit while a descendant keeps
  the pipe open. In that case the result is settled `exitGraceMs` (2 s) after
  `exit`, still inside the deadline: the group is killed, the pipe is
  destroyed, and the result is resolved or rejected on the exit status.
- **Ctrl-C and SIGTERM.** The groups are detached, so Ctrl-C to `local.mjs`
  would not reach them. `local.mjs` therefore handles SIGINT and SIGTERM by
  calling `killLiveProcessGroups()`, then exits 130 or 143.
- **Deadline inventory (§13):** rows 1–5 now read "SIGKILL of the whole
  process group and an immediate reject at the bound, whatever the stdio
  mode". After `exit` with the pipe still held, the result settles within at
  most 2 s.

### Tests (L19, `scripts/local/local.test.mjs`)

| Case | Expected |
|---|---|
| `bash -c '(sleep N) & sleep N'`, `capture: true`, 500 ms | rejects "timed out after 500 ms" in < 2 s; no `sleep N` left |
| the same without capture (inherited stdio) | the same |
| `bash -c 'echo hi; (sleep N) & exit 0'`, `capture: true`, grace 300 ms, 10 s deadline | resolves `{ code: 0, out: 'hi\n' }` in < 3 s; the grandchild is killed |
| `bash -c '(sleep N) & exit 0'`, grace 60 s, deadline 500 ms | rejects at the deadline; the grandchild is killed |
| `bash -c '(sleep N) & exit 4'`, grace 300 ms | rejects "exited 4"; the grandchild is killed |
| static | `local.mjs` kills the live groups on SIGINT/SIGTERM; `runProcess` spawns `detached: true` |

Every case uses a unique `sleep` duration as a marker. The test reads
`/proc/*/cmdline` to check that nothing with that marker survives, and an
`afterAll` kills any survivor. After the red run, the mutations and the gates,
0 marker processes remained.

### Mutation checks (scratch `mutate7.sh`; each applied, run, restored; tree clean after; 0 orphans)

| ID | Mutation | Result |
|---|---|---|
| R1 | **the old behaviour: settle on `close` only** (the deadline kills just the child; no exit grace) | **killed**: 6/112 |
| R2 | the deadline kills the group but waits for `close` | **killed**: 4/112 |
| R3 | no exit grace | **killed**: 2/112 |
| R4 | kill only the child, not its process group | **killed**: 5/112 |
| R5 | not detached (no process group of its own) | **killed**: 6/112 |
| R6 | `local.mjs` does not kill the live groups on SIGINT/SIGTERM | **killed**: 1/112 (static) |

### Gates (HEAD 9227eb5)

| Gate | Result |
|---|---|
| `npm run lint` / `npx tsc --noEmit` | 0 / 0 |
| `scripts/local/local.test.mjs` | 112 passed |
| `npm test` | **2324 passed** (100 files) |
| `npm run local:test` (`ratio-local-test`, 54339/18353/3110; every docker, npm and worker command now in its own process group) | pass in 25 s; `appReady: pid-verified`; totals 55 / `30.8272954899`, 40 / `21.0978157665`; 95 distinct rows; `appStop: stopped`; `down: ok (-v)`; `failures: []` |
| leftovers | none: no marker sleepers, no `ratio-local*` containers or volumes, no `.ratio-local/` |

`test:db`, `next build` and `check:bundle` were not re-run for this change.
It touches only `scripts/local/*.mjs`, which none of them build or test; the
§13 results stand.

## 14. Copilot review of 0a742b9 (3 Medium); local, not pushed

### Commits

| SHA | Commit | Kind |
|---|---|---|
| 08ca079 | U1–U3, D10a–c, D7, string `rowCount` in D1–D3/D8, L8, L20 | **red** (`red/red-copilot4-fast.txt`: 21 failed / 133; `red/red-copilot4-db.txt`: 7 failed / 30, D10a with "cursor is not valid" on page 2) |
| dfc7d35 | explicit date formatting, pinned and asserted session settings, string `rowCount`, interrupt-aware `local:test` | green |
| f299f46 | the control-totals `rowCount` check is one strict comparison (mutation I8 showed the `typeof` guard was redundant) | refactor |
| 40fd4df | D10a and D10c move to `publishedCosts.serial.db.test.ts` | test move |
| (this commit) | DESIGN §2.2/§2.3/§12, TEST_PLAN §F, this section | docs |

**Changes to existing Slice 2 tests:**
- Every `rowCount` expectation is now a string. Before, a JS number was the
  contract under test; the contract changed on purpose, so the expectations
  follow it.
- The static check in L18 now asserts `return localTestExitCode(summary);`,
  which also covers 130/143; it used to assert `summary.pass ? 0 : 1`.
- L19's static check now finds `killLiveProcessGroups()` inside
  `installInterruptHandlers`.
- L15's regex allows `trackProcessGroup(spawn(…))`.

**Why D10a and D10c moved.** They run `ALTER ROLE … SET` on a reader login,
which is cluster state, and Slice 1's static rule (`serialLogins.test.ts`)
flags role DDL with a dynamic part in a parallel DB file. The full gate run
caught this. The two tests now run in the serial phase and page tenant A at
limit 1, so page 2 onwards still needs the cursor. D10b, the SQL alone, stays
in the parallel file.

No assertion was weakened.

### Mapping

| Comment | Commit(s) | Test(s) / evidence |
|---|---|---|
| **4176238982**: `billing_period` follows DateStyle; under `SQL, DMY` the periods are not canonical and the next cursor is unusable | 08ca079, dfc7d35 | **Fix, two layers:** <ul><li>`to_char(billing_period, 'YYYY-MM-DD')` in the page and the totals, and so in the cursor;</li><li>the pool pins `DateStyle=ISO,MDY`, `IntervalStyle=postgres` and `TimeZone=UTC`, and every read asserts them with the isolation level and read-only, failing closed before any read.</li></ul> **Sweep of every returned or cursor value:**<ul><li>timestamps were already `to_char(… AT TIME ZONE 'UTC', …)`;</li><li>numeric, bigint and uuid text forms ignore every setting;</li><li>there are no float, interval or money-typed columns;</li><li>`lc_numeric` affects only `to_char` of numbers (unused);</li><li>`extraColumns` is jsonb with worker-written string values.</li></ul> **Tests:**<ul><li>D10a: role defaults `SQL, DMY`, Sao Paulo, `sql_standard` and `extra_float_digits=-15` are proven active on a plain session; the API output equals the canonical login's and paging through `nextCursor` (limit 1) returns every row exactly once;</li><li>D10b: the SQL alone, under hostile `SET LOCAL` values, equals the canonical output;</li><li>D10c: an unpinned DateStyle fails closed;</li><li>U2, U3, D7.</li></ul> Startup options take precedence over `ALTER ROLE … SET`, as D10a shows. Mutations A1–A7 |
| **4176238961**: `count(*)` converted to a JS number loses precision above 2^53 | 08ca079, dfc7d35 | `rowCount` is the bigint's decimal string, like the money amounts. U1: `'9007199254740993'` and `'9223372036854775807'` are exact, through JSON too. Sweep: no other `Number()` on a database value (`rowOrdinal`, money and quantities were already text). The contract change is documented in DESIGN §2.3: the API is new and unreleased (#59 not merged), has no consumers, and changes type now without versioning. Updated: D1–D3 and D8, `local:test`'s comparison (L8: a numeric `40` or `'040'` is a mismatch), and the DESIGN example. Mutations A8, I8b |
| **4176238924**: SIGINT/SIGTERM exits at once, so `local:test` never reaches `down -v` | 08ca079, dfc7d35 | **First signal:** `local:test`'s run is aborted. The body ends, its commands are killed, and none starts afterwards. Then the same bounded cleanup runs (stop `next start`, then `down -v`, which is not bound to the interrupt). Exit 130/143, and the summary records `interrupted`. **Second signal:** a forced exit; the groups are killed and the cleanup is skipped. **`next start`** runs in its own detached group, tracked with the commands, which closes the challenger's Info note. **Other commands** kill their groups and exit 130/143, leaving state for `local:down` (documented in DESIGN §12 and in the comment above `installInterruptHandlers` in `local.mjs`). L20 is the unit and static coverage; the live runs follow below. Mutations I1–I7 |
| challenger Low (`stty tostop`) | (none) | Kept detached for every command, with evidence in the next section. |

### Live interrupt runs (`interrupt-live.sh`, `interrupt-serving.sh`; real Docker, real `next start`)

| Case | Exit | Summary | Left behind |
|---|---|---|---|
| SIGINT 4 s into `local:test` (during compose up) | **130** | `interrupted: SIGINT`, `down: ok (-v)`, pass false | 0 containers, 0 volumes, no state dir |
| SIGTERM to `local.mjs` **alone** as soon as `next start` runs (its own pgid 22291) | **143** | `interrupted: SIGTERM`, `appStop: stopped`, `down: ok (-v)`, error "interrupted by SIGTERM" | no `next start`, 0 containers, 0 volumes, no state dir |
| SIGTERM 21 s in (the run was already in its cleanup) | **143** | every step ok, `appStop: stopped`, `down: ok (-v)`, failure "interrupted by SIGTERM during the cleanup" | nothing |
| two SIGINTs (6 s, then +0.5 s) | **130** | forced exit, "cleanup skipped" | 1 container, 2 volumes, state dir (as documented); a manual `local:down -v` for `ratio-local-test` removed all of it |
| SIGINT 3 s into the developer's `local:up` (`ratio-local-int`) | **130** | "child processes killed; use local:down to clean up" | 2 containers, 2 volumes, state dir kept for `local:down -v`, which then removed everything |

### `stty tostop` (challenger Low): measured, detaching kept

A real pty (`script(1)`) with `stty tostop`, and node in the foreground:

```
plain node write ok                          [baseline] node exit: 0
child-ok / parent ok after non-detached child [non-detached] node exit: 0
child-ok / parent ok after detached inherit child [detached-inherit] node exit: 0
piped: child-ok / parent ok after detached piped child [detached-pipe] node exit: 0
parent ok after detached SILENT child        [detached-silent] node exit: 0
parent ok after detached ignore child        [detached-ignore] node exit: 0
```

- **Why detaching is safe here.** Node's `detached: true` is `setsid()`: the
  child's session id equals its pid (`ps -o pid,pgid,sid,tty`:
  `31519 31519 31519 ?`), and it has no controlling terminal. Terminal job
  control, including TOSTOP, applies only to the terminal's own session.
- **The one stop that was seen came from the harness.** GNU `timeout` without
  `--foreground` moves node into a background process group, and node was
  then stopped (`T`) on its own write, with or without a detached child.
- **Why not detach only when output is captured or not a TTY.** It would gain
  nothing, and it would let an inherited-stdio command leave a grandchild
  that the deadline cannot kill. So every command stays detached, and #58
  needs no change for this.

### Mutation checks (scratch `mutate8.sh`, `mutate8b.sh`; each applied, run, restored; tree clean after; 0 orphans)

| ID | Mutation | Caught by |
|---|---|---|
| A0 | **the original code**: `date::text`, no DateStyle pin, no DateStyle assertion (`mutate8c.sh`) | serial **D10a** fails with exactly the reported symptom: `{"error":{"code":"invalid_request","message":"cursor is not valid"}}` on page 2; D10c; D10b |
| A1 | page: `billing_period::text` again (formatting removed, pin kept) | U3 `billing_period is formatted with to_char…`; DB **D10b** (the SQL alone under hostile DateStyles) |
| A2 | totals: `billing_period::text` again (pin kept) | U3; DB **D10b** |
| A3 | DateStyle pin removed | U2 `the reader pool pins…`; DB **D10a** (role default `SQL, DMY` ⇒ the assertion refuses the read; re-run on the serial file after the move: caught) |
| A4 | TimeZone pin removed | U2; DB: 26/30 fail (the test cluster defaults to `Etc/UTC`, not the pinned `UTC`, so every read is refused: fail closed) |
| A5 | IntervalStyle pin removed | U2; DB **D10a** (role default `sql_standard`; re-run on the serial file: caught) |
| A6 | DateStyle dropped from the in-transaction assertion | U2 `DateStyle SQL, DMY / German ⇒ refused`; DB **D10c** (re-run on the serial file: caught) |
| A7 | the whole session assertion off | U2 (6 cases); DB D10c and the existing REPEATABLE READ fail-closed test |
| A8 | `rowCount` through `Number()` again | U1 (both); DB D1, D2, D3, D8, D10a |
| I1 | `local:test` interrupt exits at once (no cleanup) | L20 static (`onFirst … COMMAND === 'test' … interrupt.abort`) |
| I2 | `runLocalTest` ignores the interrupt | L20 "SIGTERM while the body ignores every signal" |
| I3 | `runProcess` ignores the interrupt once running | L20 "SIGINT mid-body" (the in-flight command is not killed) and "runProcess bound to an aborted signal" |
| I4 | a second signal is not forced | L20 `installInterruptHandlers` |
| I5 | `next start` not tracked | L20 static; L15 |
| I6 | the exit code ignores the interrupt | L20 (4 tests) |
| I7 | `down` bound to the interrupt (it would be refused during the cleanup) | L20 static |
| I8 | the `typeof` guard in the control-totals check removed | **survived: equivalent.** `!==` against the string already rejects a number, so the guard was removed (f299f46) |
| I8b | the control-totals check compares by numeric value | L8 (`40` and `'040'`) |

### Gates

| Gate | Result |
|---|---|
| `npm run lint` / `npx tsc --noEmit` (HEAD 40fd4df) | 0 / 0 |
| `npm test` (40fd4df) | **2345 passed** (101 files), run alongside `test:db` |
| `npm run test:db` (private PG16 at 55700 + S3 prefixes) | at 40fd4df: **596 + 163** passed in 3 of 4 runs (113, 111, 108 s). The fourth run failed once, in `doctor.db.test.ts`; see the note below |
| `worker:build`; `next build`; `check:bundle`; `npm audit --omit=dev` (f299f46; no production file changed after it) | 0; 0 (`tsconfig.json`/`next-env.d.ts` restored); pass (116 client / 91 server files); 0 vulnerabilities |
| `npm run local:test` (f299f46, `ratio-local-test`, 54339/18353/3110) | pass in 26 s; `appReady: pid-verified`; totals `rowCount` **`"55"` / `"40"`** (strings), `30.8272954899` / `21.0978157665`; 95 distinct rows; `appStop: stopped`; `down: ok (-v)` |
| live interrupt runs | all five cases as in the table above |
| leftovers | none: private cluster stopped and deleted; no `ratio-local*` containers or volumes; no `.ratio-local/`; no `next start` or sleeper processes |

**Intermittent `test:db` failure (1 of 4 runs; not caused by this change).**
- **What happened.** `doctor.db.test.ts`'s `beforeAll` migration was refused
  with `PRIVILEGE_MODEL_VIOLATION`, which named a test login
  `ratio_test_login_14967_…`. The check reported the login as holding
  `ratio_worker`'s table privileges "beyond the reviewed set of the ratio
  roles it belongs to".
- **Likely cause** (not proven). The migration's catalog check reads the
  catalog in several statements at READ COMMITTED. When a parallel DB test
  file drops a worker login between two of those statements, the check sees
  the login's privileges but no longer its membership.
- **Why it is not from this change.** No production file touches role DDL, and
  this round's only change to the parallel DB phase took role DDL *out* of it
  (40fd4df).
- **Not fixed here.** A fix belongs to Slice 0's catalog check (for example,
  reading the catalog in one REPEATABLE READ snapshot) or to Slice 1's test
  isolation. Both are outside what Slice 2 may change without stopping first,
  so it is reported instead. Before this round it had not been seen in about
  ten `test:db` runs.

## 14a. Challenger REQUEST CHANGES on 7142a86 (1 Medium): parallel-phase role changes

**Correction to §14.** §14 called the intermittent `test:db` failure "not
caused by this change". That holds for that round's commits, but the cause is
in this PR's own earlier Slice 2 tests, so it is fixed here.

### Root cause (challenger)

- **The race.** Slice 0's `memberPrivilegeViolations`, the catalog check run
  by every `migrate`, `migrate --status` and `doctor`, reads in two steps:
  1. a role's memberships, in one statement;
  2. its privileges, with `has_*_privilege()`, in a later statement.

  `has_*_privilege()` follows the LIVE memberships, not the statement's
  snapshot. A role change committed between the two statements is therefore
  half-visible: the check sees privileges "beyond the reviewed set of the
  ratio roles it belongs to".
- **The trigger.** `src/server/costs/publishedCosts.db.test.ts` ran in the
  PARALLEL DB phase and committed, with autocommit `db.pool.query`, role
  changes on existing logins. Roles are cluster-wide, so a concurrent
  `migrate` or `doctor` in another test database (here `doctor.db.test.ts`)
  could see the half-applied state. The offending D6 statements:
  - `GRANT ratio_reader` then `GRANT ratio_worker … SET`;
  - `GRANT ratio_reader … INHERIT FALSE`;
  - `GRANT ratio_worker` then `REVOKE`;
  - `ALTER ROLE … NOLOGIN` then `LOGIN`.
- **Measured (by the challenger).** This file caused violations in concurrent
  checks. The other 8 parallel DB files caused 0 violations in thousands of
  checks: they only `CREATE ROLE … IN ROLE` atomically through `createLogin`,
  or change roles inside `BEGIN … ROLLBACK`.

### Commits

| SHA | Commit | Kind |
|---|---|---|
| 0307c79 | `parallelRoleDdl.test.ts`: the static guard | **red** (`red/red-parallel-role-ddl.txt`: it flags exactly the 7 D6 statements at lines 337, 338, 348, 364, 366, 395 and 400; the Slice 0/1 files pass) |
| 8c4919c | the four D6 tests move to `publishedCosts.serial.db.test.ts` | green |
| 06b5f90 | guard self-test: a pool statement inside a client's `BEGIN … ROLLBACK` still autocommits | test |
| (this commit) | this section, plus TEST_PLAN | docs |

### The move

These four tests moved to `publishedCosts.serial.db.test.ts`, as
'D6 (serial)'. Their assertions are byte-identical; only the helpers
(`login`, `get`, `refused`) are local copies with the same assertions:
- "a reader that can only SET ROLE ratio_worker (no inherit) is refused";
- "a reader holding ratio_reader only through SET (no inherited privileges)
  is refused";
- "the check runs on every request: a login made unsafe while pooled is
  refused at once, and served again when fixed";
- "a pooled login set NOLOGIN is refused on the very next request …; LOGIN
  again ⇒ served".

The parallel file keeps the D6 cases that only `CREATE ROLE … IN ROLE`
atomically. It also keeps N3, which drops a login (`DROP ROLE` is atomic, and
the other files' drops caused 0 violations).

### The guard (`src/server/costs/parallelRoleDdl.test.ts`, in `npm test`)

It covers every non-serial `*.db.test.ts` in `src/`, and is modelled on Slice
1's `serialLogins.test.ts`: the same TypeScript AST walk and the same
"string pieces, dynamic parts as placeholders" reading of SQL.

**What it flags.** A `.query(...)` call whose SQL makes a cluster-wide role
change must provably run inside `BEGIN … ROLLBACK`. Cluster-wide role changes
are:
- `GRANT <role> TO`;
- `REVOKE <role> FROM`;
- `GRANT`/`REVOKE … ON DATABASE | TABLESPACE | PARAMETER`;
- `ALTER ROLE | USER | GROUP`, except `ALTER ROLE … IN DATABASE`, a setting
  scoped to one test database.

**What counts as inside `BEGIN … ROLLBACK`.** The receiver is not a pool
(a pool autocommits), and either:
- an enclosing function issues both `query('BEGIN')` and `query('ROLLBACK')`;
  or
- the enclosing callback is passed to a helper of the file that does (for
  example `inTxn`).

**What it does not flag.** Object grants (`GRANT … ON <table> TO`) are
database-local. `CREATE ROLE … IN ROLE` is atomic. Test titles and SQL handed
to a helper are not `.query(...)` calls.

**Slice 0/1 files.** Unchanged, and they pass. The check is not vacuous:
`memberPrivileges.db.test.ts` and `privileges.db.test.ts` each run more than 5
such statements, all recognised as rolled back. `cli.db.test.ts`'s autocommit
`GRANT SELECT ON ratio.cost_facts` and its `ALTER ROLE … IN DATABASE` are
database-local, so they are not flagged.

### Mutation checks (scratch `mutate9.sh`, `mutate9b.sh`; each applied, run, restored; tree clean after)

| ID | Mutation | Caught by |
|---|---|---|
| M1 | one D6 `GRANT ratio_worker TO <existing login>` back in the parallel file | the guard (main test) |
| M2 | one D6 `REVOKE ratio_worker FROM <login>` back | the guard |
| M3 | the D6 `ALTER ROLE … NOLOGIN` back | the guard |
| M4 | guard: a pool not recognised as autocommit | self-test (pool inside a client's `BEGIN … ROLLBACK`) |
| M5 | guard: `BEGIN` alone counts (no `ROLLBACK` required) | self-test (`BEGIN … COMMIT` flagged) |
| M6 | guard: transaction helpers of the file not recognised | the main test and the Slice 0/1 test (`inTxn` callers flagged), plus the self-test |
| M7b | guard: membership `GRANT` not treated as a cluster-wide change | the Slice 0/1 non-vacuous count and the self-test. The first M7 edit broke the file (a load error, not a test failure), so it was re-run as M7b. |
| M8 | guard: every `ALTER ROLE` exempted (not only `IN DATABASE`) | the Slice 0/1 non-vacuous count and the self-test |

### Known Slice 0 limitation (not in this PR)

The race itself is in Slice 0's catalog check, and production
`migrate`/`doctor` can hit it. If a DBA changes ratio-role memberships at the
same moment, the check can be falsely refused. It fails closed, and a rerun
passes. REPEATABLE READ does not fix it, because `has_*_privilege` ignores the
snapshot. **Tracked as a follow-up issue opened by the coordinator: a known
Slice 0 limitation.**

### Gates (HEAD 06b5f90)

| Gate | Result |
|---|---|
| `npm run lint` / `npx tsc --noEmit` | 0 / 0 |
| `npm test` | **2348 passed** (102 files; the guard included) |
| `npm run test:db` ×6 (private PG16 at 55700 + S3 prefixes) | **592 + 167** passed in **6 of 6** runs (106, 116, 107, 104, 105, 105 s); 0 `PRIVILEGE_MODEL_VIOLATION` lines in any log. The parallel count fell from 596 because 4 tests moved, and the serial count rose from 163 by the same 4 |
| leftovers | none: private cluster stopped and deleted |

No production file changed in this section, so the `next build`,
`check:bundle` and `local:test` results of §14 stand.

## 15. Copilot review of f684dbc (2 High, 3 Medium); local, not pushed

### Commits

| SHA | Commit | Kind |
|---|---|---|
| b73ae23 | guard soundness self-tests, RD1–RD3, D11, L21, L22 | **red** (`red/red-copilot5-fast.txt`: 19 failed / 143; `red/red-copilot5-db.txt`: D11a/D11b failed / 26) |
| cb29bbb | strict `BEGIN … ROLLBACK` proof; every `.query` call scanned; unreadable SQL fails closed; reviewed allowlist; D10b in an explicit `BEGIN … ROLLBACK` | green (4176494757, 4176494775) |
| de4d25a | reader client-side deadlines; a stuck client is destroyed | green (4176494809) |
| 631888e | bootstrap verifies each membership's full PG16 shape | green (4176494789) |
| 5e2a232 | `spawnGuard`, late `setApp` child killed and awaited, the body settles before the sweep | green (4176494798) |
| 720dca5 | guard allowlist drift self-test | test |
| (this commit) | DESIGN §2.2/§2.4/§13, TEST_PLAN §G, this section | docs |

**Changes to existing Slice 2 tests:**
- D10b (DB) now runs in its own explicit `BEGIN … finally ROLLBACK`. The
  API's SQL is imported, so the guard cannot read its text, and
  `withTenantTransaction` commits. The assertions are unchanged.
- The L15/L20 static checks now accept `start: spawnGuard(() => …)`.
- The L20 test whose body never settles passes `bodySettleMs: 200`, because
  `runLocalTest` now waits (bounded) for the body to settle.
- The guard's main test now reports the full SHA-256 of each finding.

No assertion was weakened.

### Mapping

| Comment | Severity | Commit(s) | Test(s) / evidence |
|---|---|---|---|
| **4176494757**: BEGIN and ROLLBACK anywhere in the enclosing function is no proof | High | b73ae23, cb29bbb | **Acceptance is now strict:**<ul><li>the same receiver for BEGIN, the call and the ROLLBACK;</li><li>BEGIN is an unconditional statement strictly before the call, in the same function (a nested function never counts);</li><li>nothing ends the transaction in between;</li><li>the ROLLBACK is unconditional after the call: first in the `finally` of an enclosing `try`, or straight-line with no `return`, `throw`, `break`, `continue` or `COMMIT` in between;</li><li>helpers (`inTxn`) are verified by the same rules for their callback call with that client, and the callback must not end the transaction itself.</li></ul>**Self-tests flag each bypass:** a different client; ROLLBACK before the GRANT; an unused nested function; a conditional BEGIN; a conditional ROLLBACK; plus an early exit, COMMIT or no ROLLBACK on a straight line, and 4 helper bypasses. **Slice 0/1 files:** unchanged and passing. Non-vacuity: memberPrivileges ≥ 6, privileges ≥ 6 and roles ≥ 2 proven rolled-back calls. Mutations G1–G7 |
| **4176494775**: the raw-text prefilter skips SQL the AST would rebuild | High | b73ae23, cb29bbb | **The prefilter is gone:** every `.query(...)` call of every non-serial DB test file is scanned. **How the SQL is rebuilt:** from the AST, with a one-file TypeScript checker covering literals, templates, `+` concatenation, `const` bindings, `for…of` over array literals, parameters of functions only ever called directly, and SQL quote doubling (`.replace(/'/g, "''")`); dynamic values are placeholders. **Findings outside a proven transaction:** a bare variable, a call, an object, or a dynamic part in statement position (start of a statement, `EXECUTE`, `format('…`). Self-tests cover concatenation (`'GR' + 'ANT …'`, `'ALT' + 'ER ROLE …'`), the variable case, a call, a statement hole, an object, and the resolvable cases. **Reviewed allowlist: 3 entries,** all Slice 0 calls (file, SHA-256 of the call, reason; listed below); drift fails, with a self-test. Mutations G8–G11 |
| **4176494809**: the API pool has no client-side deadline | Medium | b73ae23, de4d25a | **Bounds:**<ul><li>`query_timeout` 12 s, above the server's 10 s `statement_timeout`;</li><li>`connectionTimeoutMillis` 5 s;</li><li>`readWithDeadline` bounds the whole request at 20 s: tenant transaction, login check and reads.</li></ul>**A guarded client** that had a client-side failure (no SQLSTATE), or is still held at the deadline, is released with the error and its socket destroyed. Once poisoned, it refuses further queries, so the ROLLBACK doesn't queue behind the stuck one. Slice 0's `withTenantTransaction` is unchanged. **Tests:**<ul><li>RD1: the config;</li><li>RD2: a query that never answers, a poisoning timeout, a healthy release;</li><li>RD3: the route against a fake Postgres that accepts and never answers gives 500 within the connect deadline, and a connection stalled mid-request gives 500 at the deadline with the client destroyed;</li><li>D11, real Postgres behind a stall proxy with `max: 1`: 500 within the deadline (`query_timeout`, D11a; request deadline, D11b), 0 pooled clients, and the next request succeeds.</li></ul>Mutations Q1–Q5 |
| **4176494789**: bootstrap ignores the PG16 membership options | Medium | b73ae23, 631888e | `verifyBootstrap` reads `admin_option`, `inherit_option` and `set_option`, and `membershipProblems` requires exactly one grant per login → ratio-role edge with `EXPECTED_MEMBERSHIP_OPTIONS` = {admin false, inherit true, set true} (what `CREATE ROLE … IN ROLE` gives on PG16). A NULL option fails closed. L21: each wrong option on each of the 3 edges, a NULL option, a duplicate grant, a missing edge, an extra edge, a ratio role as a member, and a static check. `local:test` ran the real bootstrap on PG16 and the verification passed. Mutations B1–B5 |
| **4176494798**: a late `startIfPortFree` can spawn after the cleanup | Medium | b73ae23, 5e2a232 | Once the cleanup has started (body done or interrupted):<ul><li>`spawnGuard` refuses to spawn, and `next start` is spawned through it;</li><li>a child handed to `setApp` late is SIGKILLed (its group) and awaited (`summary.lateChildren`);</li><li>`runLocalTest` waits for the interrupted body to settle, bounded by `bodySettleMs` (10 s), before the caller's final process-group sweep.</li></ul>L22 is deterministic, with an injected 400 ms delay after a 100 ms abort. Mutations S1–S4 |

### The reviewed allowlist (3 entries, all in Slice 0 test files, which this PR may not edit)

| File | Call | Why it is safe |
|---|---|---|
| `src/ingest/db/commit.db.test.ts` | `real.query(sql as string, params)` in a pass-through proxy | It passes `migrateUp`'s SQL (the repository's own migrations, copied) to a scratch database and turns every COMMIT into a ROLLBACK, so nothing is committed. 0001 changes no membership or attribute of an existing login. |
| `src/ingest/db/foundation.db.test.ts` | `c.query(sqlOverride … : fs.readFileSync(…))` in `writeManifest` | The repository migrations (or this file's `ALTER TABLE ratio.sources … SET DEFAULT` override), applied to a fresh scratch database as the manifest script does. This is the same SQL the runner applies to every test database. |
| `src/ingest/db/immutability.db.test.ts` | `zombie.query(z.sql, z.params)` | `z.sql` comes from this file's `zombieSql` callbacks: a DELETE on `ratio.cost_facts` and an UPDATE on `ratio.ingest_artifacts`, both database-local DML. The zombie's BEGIN is issued in a loop, so it can't be proven statically, and the test rolls it back. |

Every other `.query` call in the 34 non-serial DB test files is either
proven to run inside `BEGIN … ROLLBACK`, or its SQL is read and contains no
cluster-wide role change.

### Mutation checks (scratch `mutate10.sh`; each applied, run, restored; tree clean after; 0 orphans)

| ID | Mutation | Result |
|---|---|---|
| G1 | receiver ignored for BEGIN/ROLLBACK | **killed** (2) |
| G2 | a ROLLBACK/COMMIT between BEGIN and the call ignored | **killed** (1) |
| G3 | a nested function judged by its enclosing function | **killed** (1) |
| G4 | BEGIN accepted anywhere before the call (conditional) | **killed** (1) |
| G5 | ROLLBACK anywhere in the finally (conditional) | **killed** (2) |
| G6 | straight line: early exits not checked | **killed** (1) |
| G7 | any callback helper accepted | **killed** (1) |
| G8 | the raw-text prefilter back | **killed** (4) |
| G9 | unreadable SQL accepted | **killed** (3) |
| G10 | statement-position holes not detected | **killed** (1) |
| G11 | allowlist drift not reported | **killed** (1) |
| Q1 | no client-side `query_timeout` | **killed**: RD1 (D11 sets its own `query_timeout`, so it still passes) |
| Q2 | a stuck client released without the error (returned to the pool) | **killed**: RD 3/6, D11 2/2 |
| Q3 | a client-side failure does not poison the client | **killed**: RD 1, D11a |
| Q4 | no request deadline (the race removed) | **killed**: RD 2/6. D11b still passes: the deadline's destroy alone ends the stuck query |
| Q5 | the destroyed client's socket is not destroyed | **killed**: RD2 |
| B1 / B2 / B3 | `admin_option` / `inherit_option` / `set_option` not checked | **killed** (1 / 1 / 2) |
| B4 | a duplicate grant not reported | **killed** (1) |
| B5 | `verifyBootstrap` ignores the options | **killed** (1) |
| S1 | `spawnGuard` does not refuse after the cleanup started | **killed** (1) |
| S2 | a late `setApp` child is kept | **killed** (1) |
| S3 | the body is not awaited before returning | **killed** (2) |
| S4 | `next start` spawned without `spawnGuard` | **killed** (3) |

### Gates (HEAD 720dca5)

| Gate | Result |
|---|---|
| `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 |
| `npm test` | **2375 passed** (103 files) |
| `npm run test:db` ×3 (private PG16 at 55700 + S3 prefixes) | **594 + 167** passed ×3 (114, 112, 113 s) |
| `worker:build`; `next build`; `check:bundle` | 0; 0 (`tsconfig.json`/`next-env.d.ts` restored); pass (116 client / 91 server files) |
| `npm run local:test` (`ratio-local-test`, 54339/18353/3110) | pass in 27 s: the new membership verification passed on the real PG16 bootstrap; `appReady: pid-verified`; totals `"55"` / `"40"`, `30.8272954899` / `21.0978157665`; 95 distinct rows; `appStop: stopped`; `down: ok (-v)`; `failures: []` |
| `npm audit --omit=dev` | 0 vulnerabilities |
| leftovers | none: private cluster stopped and deleted; no `ratio-local*` containers or volumes; no `.ratio-local/`; no sleepers |

## 15a. Challenger REQUEST CHANGES on f684dbc..480dd87 (1 Medium, 1 Low); local, not pushed

### Commits

| SHA | Commit | Kind |
|---|---|---|
| 4556d48 | RD4, D12 (listener leak); guard hardening self-tests (a)–(e) | **red** (`red/red-challenger6-fast.txt`: 6 failed / 26; `red/red-challenger6-db.txt`: D12 **expected 51 to be 1**, the live leak) |
| f63d374 | the stray-error listener is attached once per client (`WeakSet`) | green (Medium) |
| a2dba00 | guard hardening (a)–(e); header documents the remaining limits | green (Low), with the 2 open findings below |
| 1abb85d | self-test: a comment inside an `EXECUTE '…'` string is stripped | test |
| (this commit) | this section | docs |

### Medium: error-listener leak in `readDeadline.ts` `guard()`

- **The defect.** Every checkout added `client.on('error', …)` and never
  removed it. A pooled client is never retired, so it collected one
  listener per request. D12 reproduced this live in red: 51 listeners after
  51 requests on a `max: 1` pool.
- **The fix.** The listener is attached once per client, tracked in a
  module-level `WeakSet`. It stays for the client's life, which keeps the
  stray-error protection while the client sits in the pool.
- **Tests.**
  - RD4 (unit, fake EventEmitter client): 50 reads on one pooled client leave
    exactly 1 listener, 50 releases, and no `MaxListenersExceededWarning`.
  - D12 (DB, a real `max: 1` reader pool, 51 requests): the client's
    listener count after the last request equals the count after the first.
- **Mutation M1** (per-checkout `on()` back) fails both RD4 and D12.

### Low: guard hardening (`parallelRoleDdl.test.ts`)

- **(a) Client provenance.** A receiver is transaction-capable only when it
  is one of these:
  - a `const` initialised with `await <x>.connect()`;
  - a `const` initialised with `new Client(…)`, where `Client` is
    named-imported from `'pg'`;
  - a `const` initialised with `await f(…)`, where `f` is a function of the
    file that only returns such a client;
  - the client parameter of a verified helper.

  `const c = db.pool`, `db.admin`, a `let`, a `new Client` from another
  module, or a factory that returns something else all count as autocommit,
  so a fake `BEGIN … ROLLBACK` on them is flagged. The helper's own client
  must be provable too.
- **(b) CREATE ROLE that adds members.** `CREATE ROLE | USER | GROUP …
  ROLE | ADMIN | USER <x>` adds existing roles as members, so it counts as a
  role change. `… IN ROLE` / `IN GROUP` stays accepted, because it is atomic
  for the new role.
- **(c) Comments stripped before matching**, in two readings whose findings
  are combined:
  - outside quoted text only, so a `--` inside `'…'` is text and the GRANT
    after it still counts;
  - everywhere, so a comment inside an `EXECUTE '…'` string is stripped too.

  Nested block comments are handled.
- **(d) Indirect use of `query` is a finding:** `.call`, `.apply`, `.bind`,
  any non-call `x.query`, a computed `['query']`, and destructuring
  (`{ query }`, `{ query: run }`).
- **(e) Reassigned clients.** A verified helper's callback client that the
  callback reassigns is rejected. A plain parameter is never provable, so
  `c = …` after BEGIN in the same function is flagged too.
- **Earlier self-tests now use provable clients** (`const c = await
  db.pool.connect()`), so each rule from §15 is still tested on its own
  rather than being masked by (a).
- **Remaining limits are documented in the guard's header:**
  - only `*.db.test.ts` files are scanned, not the shared test helpers;
  - `query` is the only SQL sink;
  - SQL from outside the file is unreadable, so it fails closed;
  - transaction control is recognised by literal text on the same
    receiver.
  - Slice 1's runtime backstop covers dangerous logins, not membership
    changes.

### Open: 2 NEW Slice 1 findings, reported before widening the allowlist

The stricter scan, rule (d), surfaced two calls that were blind spots before:

| File | Statement (SHA-256 of the enclosing statement) | What it is |
|---|---|---|
| `src/ingest/worker/commitTag.db.test.ts:37` | `const r = await (target.query as …).apply(target, args);` (`ac2dcea8a0c1013076cc3b723d762a9b2366a192e86ba8c1a816809a52f37f43`) | `swallowingPool`: a Proxy over a worker pool client. It forwards the worker's own query calls, then injects `SELECT 1 / 0` after a matching statement. |
| `src/ingest/worker/reviewFindings.db.test.ts:182` | `return (target.query as …).apply(target, args);` (`583be933c615bcae4dbc20bb359875133647de9e8ea49a9f45e3e056c594312c`) | A Proxy over a worker pool client that forwards the worker's own query calls. Before the run-finish UPDATE, it rotates the lease with `admin.query`, which is database-local DML. |

- **What they run.** Both forward whatever the Slice 1 worker's production
  code sends. The guard cannot read that SQL, so it fails closed.
- **Not allowlisted, per the instruction.** They are reported here first. The
  guard's repository tests (3 of the guard's 19) fail on exactly these two.
- **Ready to approve.** The two allowlist entries are prepared, with the
  hashes above and a "Slice 1, worker pass-through" reason.
  - With the entries applied (locally, not committed), the guard is 19/19
    green; the mutation baseline below used that temporary state.
  - Nothing else in Slice 0/1 changed status: the 3 existing entries still
    match exactly.

### Mutation checks (scratch `mutate11.sh`; each applied, run, restored; tree restored to the committed state after)

| ID | Mutation | Result |
|---|---|---|
| M1 | per-checkout `on('error')` back (no `WeakSet`) | **killed**: RD4, D12 |
| H1 | (a) client provenance not required | **killed** (2) |
| H2 | (a) `new X()` accepted whatever `X` is | **killed** (1) |
| H3 | (a) a local factory accepted whatever it returns | **killed** (1) |
| H4 | (a) a `let` accepted | **killed** (1) |
| H5 | (b) `CREATE ROLE … ROLE/ADMIN/USER` not a role change | **killed** (1) |
| H6 | (c) comments not stripped at all | **killed** (1) |
| H7 | (c) only the quote-respecting reading | **killed** (1): the `EXECUTE '…/**/…'` case |
| H8 | (c) only the quote-ignoring reading | **killed** (1): the `SELECT '--'; GRANT …` case |
| H9 | (d) `.call` / `.apply` / `.bind` / alias not flagged | **killed** (4) |
| H10 | (d) computed `['query']` not flagged | **killed** (1) |
| H11 | (d) destructured `query` not flagged | **killed** (1) |
| H12 | (e) a reassigned callback client accepted | **killed** (1) |

### Gates (HEAD 1abb85d)

| Gate | Result |
|---|---|
| `npm run lint` / `rm -rf .next && npx tsc --noEmit` | 0 / 0 |
| `npm test` | **2379 passed, 3 failed** (103 files). All 3 failures are the guard's repository-scan tests, and they fail ONLY on the 2 open Slice 1 findings above. With the 2 prepared entries applied the guard is 19/19 |
| `npm run test:db` ×2 (private PG16 at 55700 + S3 prefixes) | **595 + 167** passed ×2 (118, 114 s), D12 included |
| `worker:build`; `next build`; `check:bundle`; `npm audit --omit=dev` | 0; 0; pass (116 client / 91 server files); 0 vulnerabilities |
| `npm run local:test` | pass in 27 s; totals `"55"` / `"40"`; `appStop: stopped`; `down: ok (-v)`; `failures: []` |
| leftovers | none: private cluster stopped and deleted; no `ratio-local*` containers or volumes; no `.ratio-local/`; no sleepers |

### Decision on the 2 Slice 1 findings: approved, allowlisted (commit 8bc8513)

The coordinator approved adding both calls to the allowlist, because Slice 1
test files may not change. The allowlist goes from 3 to 5 entries in a
separate commit, so it can be reviewed on its own. The entries are
`src/ingest/worker/commitTag.db.test.ts:37` and
`src/ingest/worker/reviewFindings.db.test.ts:182`, with the hashes above.

**Rationale, recorded in each entry's `reason`** (corrected after the
challenger's approval of 911ff84; reason text only, the hashed calls are
unchanged):
- **The proxies forward only the worker's own SQL, and the worker's runtime
  code issues no role DDL at all.** There is no GRANT, REVOKE, ALTER ROLE or
  CREATE ROLE outside migrations and tests (verified by search of `src/`).
  This is what makes the entries safe.
- **GRANT and REVOKE of ratio-role membership are refused** for a
  `ratio_worker` member (no CREATEROLE, no ADMIN option): SQLSTATE 42501,
  verified.
- **ALTER ROLE is not refused.** An ordinary role CAN `ALTER ROLE <itself>
  SET …` and change its own password (the challenger verified this on
  PG16). The earlier wording "cannot … ALTER ROLE" was wrong.
- **The hashes pin the exact calls,** so any change to them is re-reviewed.
- **The only statements the proxies add** are `SELECT 1 / 0` (commitTag) and
  a database-local lease UPDATE on `ratio.sync_runs` through `admin.query`
  (reviewFindings).

**Remaining limits of the guard, now also in its header:**
- **Transaction control hidden inside other SQL:** `'BEGIN; COMMIT'`, a
  multi-statement `'SELECT 1; COMMIT'`, or COMMIT held in a const.
- **A computed member** `db.pool[k]`, where `k` is a const holding `'query'`.
- **Dynamic SQL built inside PL/pgSQL** (`||`, `format()`), an inherent limit
  of static analysis.

All three need deliberate obfuscation. The underlying Slice 0 race is tracked
in realjkg/finops-ratio#61.

**Gates after the decision (HEAD 8bc8513):**
- `npm run lint` and `npx tsc --noEmit`: 0 errors each.
- `npm test`: **2382 passed** (103 files), all green; the guard is 19/19.
- Only the guard's test file changed after the §15a gate run, so the
  `test:db` ×2, build, `check:bundle` and `local:test` results recorded in
  §15a still apply.
