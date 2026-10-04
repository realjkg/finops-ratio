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
| `local:up` | secrets generated into `.ratio-local/env` (0600); PG16 asserted (`server_version_num` 16xxxx); bootstrap verified |
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
- Everything in the deployment brief (D-01..D-10) is open. Production is a
  non-delegable human gate.
