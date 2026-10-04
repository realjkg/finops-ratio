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
