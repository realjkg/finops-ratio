# Slice 2 — Local environment, published-costs read API, deployment brief: design note

Branch `slice/02-local-env-brief`, from `origin/main` at 6eac391 (Slice 0 and
Slice 1 merged). The slice has three concerns:

1. a **local, ephemeral stack** that runs the whole path (Postgres 16 + S3 →
   migrate → seed → sync);
2. a **read API**, `GET /api/v1/costs/published`, that reads the published-facts
   view as a `ratio_reader` member;
3. a **deployment decision brief**. Its first draft listed the decisions as
   open; the owner then delegated D-01..D-10 to the orchestrator, and the brief
   records them as decided (its Decision log; §1 keeps the option analysis
   as historical rationale). The **production go-live sign-off is not
   delegated**: it stays a non-delegable owner gate, as do hosting spend, the
   GitHub App install and (optionally) connecting real billing data.

Boundary (BOUNDARY v2): local and ephemeral only. No production
infrastructure is provisioned. Slice 1's worker semantics do not change.
**Slice 0 is touched exactly once:** the coordinator-approved lazy load of
the foundation manifest (9d83590: `src/ingest/db/foundationManifest.ts` and
`privilegeModel.ts`, §7), made test-first. Nothing else under `src/ingest/db`
changes; in particular `withTenantTransaction` (`tenant.ts`) is NOT changed
(the REPEATABLE READ snapshot comes from the reader pool, §8). The read API *imports* Slice 0's
`withTenantTransaction`, `isTenantId` and `REFUSED_PREDEFINED_ROLES`, and Slice 1's
`inspectRole` / `roleProblems`. It does not copy them.

## 1. Components

| Path | Purpose |
|---|---|
| `docker-compose.local.yml` | The file's default project name is `ratio-local`, but `local.mjs` always passes `-p <project>`: `RATIO_LOCAL_PROJECT` (default `ratio-local`), or for `local:test` `RATIO_LOCAL_TEST_PROJECT` (default `ratio-local-test`). Services: `postgres` (PG16, pinned by digest) and `s3` (SeaweedFS, the digest CI already uses). Both are published on 127.0.0.1 only. Optional profiles: `app` (Next.js) and `worker` (a one-shot `sync`, `restart: "no"`). Named volumes are removed by `local:down -v`. |
| `scripts/local/local.mjs` | Subcommands `up`, `migrate`, `seed`, `sync`, `down [-v]` and `test`. Every one is idempotent. State (generated local secrets, the tenant id) lives in `.ratio-local/<project>/env` (gitignored; directory 0700, file 0600). `down -v` deletes only its own project's directory. `test` uses its own project and ports (§3.2 settings table, §8). Every child process, network call and wait has a hard deadline (§11; inventory in EVIDENCE §13). |
| `scripts/local/bootstrap.mjs` | The documented role bootstrap. It runs as the local superuser and creates the three NOLOGIN ratio roles, the migrator, worker and reader logins, and the database. Every statement is idempotent. |
| `.env.example` | Variable names only, for the new server-side settings. |
| `src/server/costs/query.ts` | Pure: strict query-string validation and an opaque keyset cursor. No `pg`. |
| `src/server/costs/readerLogin.ts` | The reader-login safety check. It is Slice 1's `inspectRole` + `roleProblems` plus a reader-specific membership rule. |
| `src/server/costs/publishedCosts.ts` | `readPublishedCosts(pool, tenantId, query)`. One read-only tenant transaction: the login check, then the page, then the totals. |
| `src/server/costs/readerPool.ts` | One `pg` pool per reader URL, with pinned session settings. |
| `src/server/costs/publishedCostsRoute.ts` | The Next.js handler factory: auth, tenant binding, validation, error mapping. |
| `pages/api/v1/costs/published.ts` | `export default createPublishedCostsRoute()`. |
| `scripts/check-next-bundle.mjs` (`npm run check:bundle`) | The `.next` bundle check that was a manual grep until now. |
| `.github/workflows/ci.yml` | Two steps added to the existing job, after Build: `check:bundle` and `local:test`. |

`src/server/costs/**` is a server-only island. `importBoundary.test.ts` is
extended:
- Only `src/server/costs/**` may import `pg` or `src/ingest`, and only the four
  listed modules: `@/ingest/db/tenant`, `@/ingest/worker/db`,
  `@/ingest/db/privilegeModel` (type-only) and `pg`.
- Only `pages/api/v1/costs/published.ts` may import `@/server/costs/*`.
- Everything else stays forbidden.
- A new test walks the transitive import closure of the route. It asserts the
  closure contains no `@aws-sdk/*`, no `csv-parse`, and no worker pipeline,
  source or evidence module.

## 2. Read API — `GET /api/v1/costs/published`

### 2.1 Authentication (reused, not invented)

The repo's API authentication is a Bearer token compared in constant time with
`RATIO_API_TOKEN` (`src/server/gateway/auth.ts`). Its documented model is
"one API key per tenant" (`.obvious/obvious.md`, API-First rules). Cost data
already uses the strictest variant: `evaluateLiveDataAuth`
(`src/server/gateway/liveDataAuth.ts`), which works as follows:
- **Deny by default.** With no token configured, every request is refused.
- **Weak tokens are refused.** A configured token shorter than 32 characters
  or with fewer than 10 distinct characters gives 503.
- **Failed attempts are throttled.** They are counted per client IP and
  answered with 429 over the limit. A valid token always passes.

The route uses exactly that:
1. Before anything else, `evaluateLiveDataAuth(req, { countAbsent: true })`.
   A missing or wrong token gives 401, throttling gives 429 and a weak token
   gives 503. No database work happens on any of these paths.
2. The handler is wrapped in `withGateway(handler, { methods: ['GET'] })`. That
   adds the method guard (405), the body-size guard, the gateway's own token
   check, the per-tenant 1,000/min rate limit, structured request logging and
   the generic 500 envelope with a `requestId`.

**Tenant binding.** The gateway's tenant is an opaque hash of the token
(`tnt_…`), not a Ratio tenant UUID. The configured key therefore needs a
server-side binding to the `ratio.tenants.id` it belongs to:
`RATIO_API_TENANT_ID`, a canonical UUID checked by Slice 0's `isTenantId`.
- This is configuration of the existing "one key per tenant" model, not a new
  auth scheme.
- The tenant is **never** read from the request. A `tenant` query parameter is
  an unknown parameter, so it gets 400.
- A missing or malformed binding gives 503 `not_configured`, and no query runs.
- Consequence: one deployment serves one tenant per configured key. The
  current mechanism has exactly one key. A per-tenant key store (several keys,
  each bound to a tenant) does not exist in the repo. Brief D-10 records the
  decision (option a: one key per deployment for now); it is not built here.

### 2.2 Database identity and the unsafe-login refusal

`RATIO_READER_DATABASE_URL` is a LOGIN member of `ratio_reader`. Missing ⇒
503 `not_configured`.

**Every request** checks its own connection inside the read transaction,
before it reads anything. The check reuses Slice 1's logic:
- `inspectRole(client)` (Slice 1, `src/ingest/worker/db.ts`) computes, over
  every `pg_auth_members` edge (INHERIT, SET or ADMIN, at any depth):
  superuser and BYPASSRLS on `current_user`/`session_user`; any reachable
  SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE or CREATEDB role; any
  reachable role in Slice 0's `REFUSED_PREDEFINED_ROLES`; and membership in
  `ratio_owner`.
- `roleProblems(report)` (Slice 1) turns that into messages. Its last rule
  ("not a member of `ratio_worker`") is specific to the worker. The reader
  evaluates `roleProblems({ ...report, workerMember: true })`, which neutralises
  only that one rule, and then adds the reader's own rules:
  - the login must hold `ratio_reader`'s privileges directly
    (`pg_has_role(current_user, 'ratio_reader', 'USAGE')`), because the API
    never runs `SET ROLE`;
  - the login must not be able to reach `ratio_worker` over **any** edge
    (closure query). A reader that can write is not a reader;
  - the login's `rolcanlogin` must still be true. `ALTER ROLE … NOLOGIN` does
    not end pooled sessions, so this rule makes NOLOGIN an immediate kill
    switch (§8).
  - The reader rules fail closed: a missing row or a NULL field counts as
    unsafe.

Any problem ⇒ the transaction is rolled back and the route answers 503
`unsafe_db_login` with a fixed message and a `requestId` (body and
`X-Request-Id`). The operator log gets **one** `unsafe_db_login` event with
status 503, the same `requestId` and fixed reason **codes** only (§8). The
problem texts can name roles, so they are never logged or returned.

Why per request and not once at start-up: role attributes and memberships can
change while a process runs, and a superuser flag takes effect in sessions
that are already open.

What runs per request inside the read transaction:
1. `BEGIN` and `set_config` (Slice 0's `withTenantTransaction`);
2. `SET TRANSACTION READ ONLY`;
3. the isolation / read-only assertion;
4. two catalog queries for the login check (Slice 1's `inspectRole`, then the
   reader query);
5. the page;
6. the totals (first page only);
7. `COMMIT`.

The catalog queries cost about a millisecond against the read.

Pool session settings (startup `options`):
- `search_path=pg_catalog,pg_temp`. This is Slice 0's deployment note option 2,
  so the owner's `CREATE` on `public` cannot shadow anything. Every name in the
  API's SQL is schema-qualified.
- `default_transaction_read_only=on`.
- `default_transaction_isolation=repeatable read`: page 1's rows and its totals
  share one snapshot (§8). The read asserts it in-transaction and refuses
  (500) on a pool without it.
- `statement_timeout=10000`, `lock_timeout=5000` and
  `idle_in_transaction_session_timeout=30000`.
- `timezone=UTC`.
- `max: 4`, `application_name=ratio-reader-api`.

### 2.3 Query

Reads `ratio.cost_facts_published` only. That is Slice 0's definer-rights view:
- it joins on `period_publications` and `status = 'published'`;
- it filters `tenant_id = ratio.current_tenant_id()`;
- FORCE RLS applies underneath it.

The reader has no grant on any base table, so the API *cannot* reach staged,
quarantined or superseded rows even with a wrong query.

The tenant is set by Slice 0's `withTenantTransaction`: a transaction-local
`set_config`, a bound parameter, and a UUID validated first.

Parameters, all optional, validated strictly by hand-written code (the repo has
no zod, and adding a dependency for one route is not justified):

| Param | Rule |
|---|---|
| `period` | `YYYY-MM`, 2000-01..9999-12 (the worker's bounds); exclusive with `from`/`to` |
| `from`, `to` | `YYYY-MM`, same bounds, `from ≤ to`; either may be given alone |
| `limit` | decimal digits only, 1..500, default 100 |
| `cursor` | opaque, ≤ 512 chars, base64url of a strict JSON 4-tuple `[period 'YYYY-MM-01', source uuid, artifact sha256 hex, row ordinal digits]` |

The following get 400 `invalid_request` with a **fixed** message that never
echoes the input:
- any other parameter;
- a parameter given twice;
- an empty value;
- any violation of the rules above.

Pagination is **keyset**, ordered by `(billing_period, source_id,
artifact_sha256, row_ordinal)`:
- That tuple is unique in the view, because each (source, period) has exactly
  one published batch and a fact's identity is (batch, artifact, ordinal).
- There is no OFFSET, so a deep page costs the same as the first.
- The query fetches `limit + 1` rows to decide whether `nextCursor` is set.
- A republish between two page requests can mix revisions across pages. This
  is documented. Each row carries `batchId` and `publishedAt`.

Response (200):
```json
{
  "data": [{ "billingPeriod": "2026-07-01", "sourceId": "…", "batchId": "…",
             "artifactSha256": "…", "rowOrdinal": "0",
             "chargePeriodStart": "2026-07-02T00:00:00.000000Z", "chargePeriodEnd": "…",
             "billedCost": "1.25", "effectiveCost": "1.25", "listCost": "1.50", "contractedCost": "1.25",
             "billingCurrency": "USD", "providerName": "…", "serviceName": "…", "serviceCategory": "…",
             "chargeCategory": "…", "resourceId": "…", "subAccountId": "…", "billingAccountId": "…",
             "usageQuantity": "1", "usageUnit": "…", "pricingQuantity": "1", "pricingUnit": "…",
             "focusVersion": "1.0", "extraColumns": {}, "publishedAt": "…Z" }],
  "page": { "limit": 100, "nextCursor": "…" },
  "totals": [{ "billingPeriod": "2026-07-01", "billingCurrency": "USD", "rowCount": 55, "billedCost": "30.8272954899" }]
}
```
- **Money and quantities** are decimal strings produced by Postgres
  (`::text`), never a JS number.
- **Timestamps** are formatted in SQL in UTC with microseconds.
- **`totals`** (per period and currency, over the whole filter, summed in
  Postgres) is returned on the first page only, the request without a
  `cursor`. That keeps a deep page from rescanning the filter. Later pages
  carry `"totals": null`.
- **Not exposed:** `tenant_id` (it is implied by the key).

### 2.4 Error mapping

| Status | When |
|---|---|
| 401 / 429 / 503 `weak_token` | live-data auth, before anything else |
| 405 | not GET (gateway) |
| 503 `not_configured` | `RATIO_API_TENANT_ID` or `RATIO_READER_DATABASE_URL` missing or invalid |
| 400 `invalid_request` | validation |
| 503 `unsafe_db_login` + `requestId` (body and `X-Request-Id`) | reader-login check failed; logged as its own event with reason codes |
| 500 `internal_error` + `requestId` | anything else (gateway; message logged redacted, never returned) |

Every response of the route, whatever layer writes it, carries
`Cache-Control: no-store`.

## 3. Local stack

### 3.1 Roles and logins (bootstrap, run by `local:up` as the container superuser)

Every statement is idempotent: it creates the object only if it is missing,
and resets the password with `ALTER ROLE … PASSWORD` when the role exists.

1. `ratio_owner`, `ratio_worker` and `ratio_reader` are created exactly as
   0001 would create them: `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB
   NOCREATEROLE`, with no membership. Pre-creating them means the migrator
   **never needs CREATEROLE**. 0001's guard (RT010) and the runner's catalog
   check still verify them.
2. `ratio_local_migrator`: `LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION
   NOCREATEDB NOCREATEROLE IN ROLE ratio_owner`. It owns database `ratio`,
   which `CREATE SCHEMA` and the ledger in `public` need. That is the case
   Slice 0 allows: `REVIEWED_OWNER_PRIVILEGES`.
3. `ratio_local_worker`: `LOGIN … IN ROLE ratio_worker`. `ratio_local_reader`:
   `LOGIN … IN ROLE ratio_reader`. Both get every `NO…` attribute explicitly
   and no other membership.
4. No `GRANT` on the database or on any object to a login. An explicit grant
   to a member would exceed the reviewed set, and Slice 0's check would refuse
   it.

How the bootstrap is verified:
- `local:migrate` runs `migrate`, then `migrate --status --json`. That must
  exit 0 with `privilegeProblems: []`. The runner's catalog check therefore
  judges these exact logins against Slice 0's privilege model.
- `local:sync` runs the worker, so Slice 1's startup check accepts the worker
  login.
- `local:test` calls the API, so the reader check accepts the reader login.

Passwords and the API token are random, generated by `local:up` into
`.ratio-local/<project>/env` (directory 0700, file 0600). Nothing secret is
committed.

### 3.2 Data flow

```
local:up       docker compose up -d --wait postgres s3  →  bootstrap (superuser)
local:migrate  worker:build → migrate (as migrator) → migrate --status --json (exit 0, no privilege problems)
local:seed     buckets ratio-local-source / ratio-local-evidence (idempotent)
               → PUT fixtures/focus-1.0-synthetic/base/** into the source bucket (same keys, same bytes)
               → provision tenant + source as the migrator (SKILL §2 SQL, ON CONFLICT DO NOTHING)
local:sync     worker sync --tenant <local tenant> --source local-focus (as worker; S3 env → local SeaweedFS)
local:test     requires an existing `next build`. Its OWN stack (localTestSettings:
               project ratio-local-test on 127.0.0.1:54339 / 18353 / 3110, RATIO_LOCAL_TEST_*),
               after a preflight that refuses existing state, containers or busy ports. It runs:
               up → migrate → seed → sync (both periods published)
               → sync again (both skipped_unchanged)
               → next start (reader URL, token, tenant binding)
               → GET /api/v1/costs/published (paged with limit=17 until nextCursor is null)
               → assert:
                 - totals == control-totals.json base (55 / 30.8272954899; 40 / 21.0978157665), as exact strings;
                 - row count over all pages == 95, no duplicates;
                 - no auth ⇒ 401;
               → stop next start, then down -v (always; every step has a hard deadline, §11)
               → pass only if the body passed, next start was stopped (stopped/killed) and down -v succeeded
local:down     docker compose down [-v]; with -v also removes .ratio-local/<project>/
               (and .ratio-local/ itself once it is empty)
```

Settings (all ports bind 127.0.0.1 only; `localSettings` / `localTestSettings`
in `scripts/local/lib.mjs`):

| Used by | Project | Postgres | S3 | App |
|---|---|---|---|---|
| `local:up`, `local:migrate`, `local:seed`, `local:sync`, `local:down` (developer stack) | `RATIO_LOCAL_PROJECT`, default `ratio-local` | `RATIO_LOCAL_PG_PORT`, default 54329 | `RATIO_LOCAL_S3_PORT`, default 18343 | `RATIO_LOCAL_APP_PORT`, default 3100 |
| `local:test` (and the CI step) | `RATIO_LOCAL_TEST_PROJECT`, default `ratio-local-test` | `RATIO_LOCAL_TEST_PG_PORT`, default 54339 | `RATIO_LOCAL_TEST_S3_PORT`, default 18353 | `RATIO_LOCAL_TEST_APP_PORT`, default 3110 |

`local:test` refuses a project name or port shared with the developer
settings. `local:up` (and so `local:test`) asserts the server is version 16
(`server_version_num` 16xxxx).

### 3.3 CI

Two steps are appended to the existing `ci` job after `Build`. No new job is
added, the workflow stays minimal, and the change is reviewed as restricted:
1. `npm run check:bundle`.
2. `npm run local:test`.

The CI step runs `local:test`, so it uses `localTestSettings`' defaults:
project `ratio-local-test` on 127.0.0.1:54339 (Postgres), 18353 (S3) and 3110
(app). It therefore collides neither with the job's service Postgres (5432)
and test SeaweedFS (8333), nor with a developer stack's defaults
(54329/18343/3100). Docker Compose v2
is preinstalled on `ubuntu-latest`. No PG client tools are needed on the
host: the scripts use `pg`, and the server is the pinned PG16 image.

## 4. Threat model

| Threat | Control | Test |
|---|---|---|
| Unauthenticated read of cost data | deny-by-default live-data auth before any work; no token configured ⇒ 401 | fast: no token configured / no header / wrong token / weak token ⇒ 401/401/401/503 and the pool factory is never called |
| Brute-forcing the token | shared failed-attempt throttling (existing), per-tenant rate limit (gateway) | existing gateway tests; fast: throttled ⇒ 429 |
| Tenant A reads tenant B | tenant only from the server binding; transaction-local tenant via `withTenantTransaction`; the view filters on `current_tenant_id()`; FORCE RLS; the reader has no base-table grant | DB: A and B seeded with published + superseded + staged + quarantined; the API bound to A returns exactly A's published rows and totals, and vice versa; a `tenant` param ⇒ 400 |
| Unpublished/staged/quarantined/superseded facts leak | view-only grant + view predicate | DB: ids and totals equal the ground truth of published batches only; none of the other batch ids appear |
| API runs with a login that bypasses RLS or can escalate | per-request reader-login check (Slice 1 logic, Slice 0 list) | DB: superuser URL, `ratio_owner` member, `ratio_worker` member, reader+worker, a login with no ratio membership ⇒ 503 and no rows; serial DB: BYPASSRLS, a reachable SUPERUSER role, every `REFUSED_PREDEFINED_ROLES` role over INHERIT / SET-only / ADMIN-only edges ⇒ 503 |
| SQL injection | every value bound (`$n`); identifiers fixed; params validated before use; the cursor is decoded into typed, regex-checked values | fast: hostile values ⇒ 400 with a fixed message; DB: hostile cursor ⇒ 400 |
| Resource exhaustion | `limit` ≤ 500, keyset (no OFFSET), totals on the first page only, `statement_timeout` 10 s, pool max 4 | fast: limit bounds |
| Error/info leakage | fixed messages for 4xx/503; 500 via the gateway envelope; reasons logged redacted | fast: no echo of input; DB: unsafe login ⇒ the body has no role names |
| Ingestion/driver code in the browser | import boundary (allowlist) + import-closure test + `check:bundle` on `.next/static` | fast + CI |
| SSRF | n/a: the route makes no outbound request; the DB URL is env only | — |
| Local secrets committed | generated into the gitignored `.ratio-local/<project>/env` (0700/0600); `.env.example` has names only | review + `git status`; `local.test.mjs` L2, L9, L10, L14 |
| Local stack exposed on the network | ports bound to 127.0.0.1 | compose file |

Out of scope, recorded in the brief:
- per-tenant DB roles (D-06, decided: session tenant for now);
- a multi-key tenant store (D-10, decided: one key per deployment for now);
- production provisioning and spend (owner actions; hosting plan decided: AWS).

## 5. Failure cases

- **DB down:** `pool.connect` fails ⇒ 500 with a `requestId`. The message is
  logged redacted.
- **Reader login made unsafe while running:** the next request gets 503.
  Nothing is cached.
- **Unknown or invalid cursor:** 400.
- **Republish between pages:** pages can mix revisions. That is documented.
- **`local:test` failure:** `down -v` still runs (`finally`). The exit code is
  non-zero.
- **`local:*` run twice:** each is idempotent. The second `sync` reports
  `skipped_unchanged`.

## 6. Rollback

- **Code:** revert the slice's commits. No migration is added. The one Slice 0
  change (the lazy manifest load, §7) is code only and needs no database
  action; reverting it restores the import-time read, which breaks the read
  API under `next start` again (so revert it only together with the route).
- **CI:** remove the two appended steps.
- **Local:** `npm run local:down -- -v` removes the containers, network,
  volumes and `.ratio-local/<project>/`.

## 7. Found during implementation; coordinator decisions

**Next-start-only failure (found by the local e2e).**
- Under `next build && next start`, every request to the route failed with a
  500: `ENOENT: scandir '/ROOT/src/ingest/db/migrations'`.
- Cause: Slice 0's `foundationManifest.ts` read the migrations directory at
  module load (`FOUNDATION_0001`), and `privilegeModel.ts` derived
  `REVIEWED_POLICY_SHAPES` from it at load too. The route imports
  `privilegeModel` through Slice 1's `worker/db.ts` for
  `REFUSED_PREDEFINED_ROLES`, and Turbopack rewrites `__dirname`.
- vitest runs from source, so the unit and DB suites could not see it.
- I stopped and reported it, as BOUNDARY v2 requires.

**Q1, option 1 (approved): the manifest is loaded lazily**, test-first. This
is the only `src/ingest/db` change.
- `FOUNDATION_0001` and `REVIEWED_POLICY_SHAPES` become `lazyReadonlyArray`s:
  computed on first use and memoised. A failure is not memoised.
- Each is a read-only Proxy over the array, so every existing use is unchanged.
- Importing `privilegeModel` / `foundationManifest` does no file I/O.
- A missing directory (`ENOENT`), a missing 0001 manifest (same `Error`) or a
  corrupt manifest (`MigrationError BAD_MANIFEST`) still fails closed, at first
  use.
- No existing Slice 0 test changed.
- Migrate, status and doctor output is identical before and after (normalised
  diff, EVIDENCE §4).
- **Side effects of the lazy load** (measured with eager and lazy builds,
  EVIDENCE §4). They apply only to a broken build whose 0001 manifest is
  missing; every result with the manifest present is identical:
  - **fresh database:** `migrate` now fails inside the 0001 transaction
    (rolled back, no `ratio` schema, 0 ledger rows) after the runner has
    created the empty ledger table. The eager code crashed while loading,
    before connecting. Exit code (1) and message are the same.
  - **up-to-date database:** a no-op `migrate` (nothing pending) now **exits
    0**; the eager code exited 1. Nothing is applied either way; the catalog
    check (which needs the manifest) only runs when a migration runs.
  - `sync`, `backfill` and `replay` **no longer crash on import**: they run
    and succeed or fail on their own terms (they never read the manifest).
  - `migrate --status`, `doctor` and any real apply still **exit 1**
    (the manifest is read on first use).
  - Errors are now the CLI's structured JSON (`BAD_MANIFEST`, or `UNKNOWN`
    for the codeless "missing" error) instead of an uncaught crash.
- `local:test` in CI is the regression test for this class: it calls the
  route under a real `next start`.

**Q2 (approved): the tenant binding.**
- `RATIO_API_TENANT_ID` is validated as a canonical UUID **at startup**:
  `instrumentation.ts` `register()` runs in the Node.js runtime only and imports
  only the pure `src/server/costs/config.ts`; the boundary test asserts the
  closure has no runtime `pg`. An invalid value gives one structured error
  that names the variable, never its value. The check is silent when the
  feature is unused, and it never stops the app starting.
- It is validated again **per request**: missing or invalid ⇒ 503
  `not_configured`.
- A store of several keys, each bound to a tenant, is decision **D-10** in the
  brief (decided: one key per deployment for now).

**Bundle check.**
- The server-side rule judges reader *database code* (`cost_facts_published`,
  `ratio.tenant_id`, `pg_auth_members`). The env-var name
  `RATIO_READER_DATABASE_URL` is not code: the startup hook's pure config chunk
  names it. That name is still forbidden in the client bundle.

**Local SeaweedFS.**
- The default `volume.max=8` cannot grow a second bucket (7 volumes per bucket
  on first write). That is the "~2 buckets" limit Slice 1 saw.
- The local compose runs `-volume.max=64 -master.volumeSizeLimitMB=64`.
- `local:seed` warms each new bucket with a probe object.

## 8. Challenger Lows and Copilot review of PR #59 (local batch, not pushed)

**NOLOGIN as an immediate kill switch** (challenger L2; Copilot 4175802721).
`ALTER ROLE … NOLOGIN` stops NEW connections only; pooled sessions survive
(verified live). The per-request reader check now also refuses a login whose
`rolcanlogin` is false (reason `LOGIN_DISABLED`), so the next request after
NOLOGIN gets 503 even on a pooled connection. Brief §6 says exactly that.

**Unsafe-login refusals are their own event** (challenger L3; Copilot
4175802693).
- The route logs one `{tag:'published-costs', event:'unsafe_db_login',
  status:503, requestId, reasons:[…]}` line instead of the generic
  `unhandled_error`/500 line.
- `reasons` are fixed codes: `SUPERUSER`, `BYPASSRLS`,
  `PRIVILEGED_ROLE_REACHABLE`, `UNSAFE_ATTRIBUTE`, `REFUSED_PREDEFINED_ROLE`,
  `OWNER_MEMBER`, `NOT_READER_MEMBER`, `WORKER_REACHABLE`, `LOGIN_DISABLED`
  (`UNCLASSIFIED` as a fallback). The problem texts, which can name roles,
  are never logged or returned.
- The decision itself is unchanged: Slice 1's `roleProblems` plus the reader
  rules; the codes only classify it.
- The 503 body and `X-Request-Id` carry the same `requestId`.

**One snapshot for page 1 and its totals** (challenger L4; Copilot
4175802675).
- Every reader-pool session defaults to `REPEATABLE READ`
  (`default_transaction_isolation`), plus `default_transaction_read_only=on`.
- Slice 0's `withTenantTransaction` is **not** changed. `SET TRANSACTION
  ISOLATION LEVEL` inside the callback is impossible: the helper's
  `set_config` query has already fixed the isolation level by then.
- The read asserts `transaction_isolation = 'repeatable read'` and
  `transaction_read_only = on` inside its own transaction, and refuses
  (500) on any pool that does not provide them.
- Tested by committing a restatement between the page and the totals queries
  (D8).

**Keyset tie-break on `source_id`** (challenger L5 K2; Copilot 4175802660).
- D9 publishes the same artifact bytes for two sources in one period, so
  rows differ only by `source_id`.
- Paging at limit 3 must visit all 10 rows once.
- Dropping `source_id` from the ORDER BY or from the cursor predicate both
  fail it.

**Local stack per project** (challenger L6, L5 L3; Copilot 4175802603 /
4175802639).
- State is in `.ratio-local/<project>/` (directory 0700, env 0600, tightened
  on every write). `down -v` removes only its own project's directory, and
  `.ratio-local/` only when it is empty.
- `local:test` runs its own stack: `RATIO_LOCAL_TEST_*`, default project
  `ratio-local-test` on 54339/18353/3110. It refuses any project name or port
  shared with the developer settings.
- Before changing anything, it refuses existing state, existing containers or
  a busy port.
- Readiness fails fast if `next start` exits. On Linux the listening socket
  must belong to the spawned process or a descendant (`/proc`), so a stale or
  foreign listener is detected. Without `/proc`, the port preflight is the
  guarantee.
- No nonce route was added: that would mean a test-only endpoint in the
  production app.

**Startup log never echoes the tenant value** (challenger L5 C2): tested with
several value shapes, the reader URL too.

**Decisions** (owner delegation to the orchestrator, 2026-10-04): the brief
now records D-01..D-10 as decided (Decision log at its top). The owner keeps,
in order:
1. the non-delegable production go-live sign-off;
2. hosting spend;
3. the GitHub App install;
4. optionally, connecting real billing data.

## 9. Challenger delta review of 323984e..85e6185 (local, not pushed)

- **D-01 tightened (Medium; tightened again in §10: an audited CMK allowlist).** Unrestricted only with SSE-KMS using a
  customer-managed key (not `aws/s3`) whose key policy is the access control,
  or client-side encryption by the source. SSE-S3 (`AES256`, S3's default since
  January 2023) and `aws/s3` SSE-KMS are transparent to anyone with
  `s3:GetObject` and stay restricted. Enforcement: issue #60 (brief
  Appendix A).
- **D-02 facts.** The data is in `FOCUS-1.0/focus_sample.csv` and
  `FOCUS-1.0/focus_sample_10000.csv`, and covers AWS, Microsoft and Oracle only
  (no Google in these files). The "anonymized real-world" claim is cited from
  `FOCUS-1.0/README.md` at adbdd17.
- **Production go-live is a non-delegable owner gate,** restored in the
  brief's banner, §7 and §8.
- **Code notes:**
  - `Cache-Control: no-store` is set first on every response of the route,
    covering the gateway's errors too.
  - The publish-injection hook is no longer a parameter of the public
    `readPublishedCosts`. It is a module-level seam
    (`setAfterPageHookForTests`), refused outside vitest, and a test fails if
    any production file names it.
  - Reader-login fields fail closed on a missing row or NULL (N3). A dropped
    login is not served either: Postgres errors 42704 on its session ⇒ 500.
- **Local:** `portInUse`, `startIfPortFree` (the app port is re-checked right
  before `next start` is spawned, which matters where there is no `/proc`) and
  `waitForOwnServer` now live in `lib.mjs` and are unit-tested, including
  `owned === false ⇒ refuse` (L6e) and tightening an existing directory to 0700
  (L6f).
- **§2.2/§2.4 brought in line** with the code: the NOLOGIN rule, codes-only
  logging, `default_transaction_isolation`, the per-request query list, the
  503's `requestId`, and `no-store`.

## 10. Copilot review of 0e972ca (1 High, 1 Medium, 6 Low; local, not pushed)

**High (4176004971): `local:test` could hang before `down -v`.**
- Cause: a `next start` child that had already been ended by a signal has
  `exitCode === null` and `signalCode !== null`. The cleanup checked only
  `exitCode`, then waited for an `exit` event that had already fired.
- Fix: child handling moved to `lib.mjs`:
  - `childExited` checks the exit code OR the signal;
  - `stopChild` returns at once if the child has already exited, otherwise
    sends SIGTERM and waits a bounded grace period, then SIGKILL and waits a
    bounded time, then gives up (`unresponsive`);
  - `cleanupLocalTest` stops the app (errors are recorded, not thrown) and
    then **always** runs `down -v`, exactly once;
  - `runProcess` takes a timeout that SIGKILLs and rejects; local:test's
    `docker compose down` is bounded at 300 s.
- Audit: this was the only exit wait. `run()` attaches its `close` listener
  at spawn, so it cannot miss the event, and `waitForOwnServer` already
  checked both fields.

**Medium (4176004999): D-01 tightened again.**
- An artifact is unrestricted only when its SSE-KMS key ARN is on an
  **audited allowlist**. Each entry records the reviewer, the date and the
  SHA-256 of the reviewed key policy. Optionally the worker re-checks the
  policy at ingest with `kms:GetKeyPolicy`, failing closed.
- Client-side encryption by the source also qualifies.
- A CMK that is not on the allowlist is restricted: object metadata can name
  the key, but cannot show that its policy restricts `kms:Decrypt`.
- Brief: Decision log, §1 and Appendix A updated; enforcement in #60.

**Lows.**
- Every stale `.ratio-local/env` reference now names
  `.ratio-local/<project>/env`: `.env.example`, `bootstrap.mjs`, DESIGN §3.1
  and the threat model, EVIDENCE §7.
- The brief's opening states the governance state in three lines: D-01..D-10
  decided under delegation; production go-live a non-delegable owner gate;
  the acceptance run on public sample data in a follow-up PR.

## 11. Copilot review of 551c16c (3 Medium, 2 Low; local, not pushed)

**Medium (4176117539, 4176117553): every wait has a hard deadline.** These
are closed as a class, not line by line.
- `withDeadline(fn, ms, what)` (lib.mjs) runs `fn(signal)`. At `ms` it aborts
  the signal, so fetch, the S3 SDK and our pg wrapper cancel their I/O. It
  also rejects, even when `fn` ignores the signal.
- `waitUntil` replaces local.mjs's `waitFor`, which checked its deadline only
  after the probe resolved, so a stalled endpoint hung `local:up`.
  - It is used for the postgres, s3 and bucket warm-up waits.
  - Each attempt is bounded by `attemptTimeoutMs` AND by what is left of the
    overall deadline.
  - The overall deadline is checked before each attempt and caps each sleep.
- `waitForOwnServer` (next start readiness) has the same structure.
- `fetchJson` makes the API reads (anonymous and paginated).
  - Its 30 s limit is longer than the route's 10 s `statement_timeout`.
  - The limit covers headers and body: a stalled body is a timeout, not the
    old silently-null body.
- `runProcess` refuses to run without a deadline, so every docker, npm and
  worker command carries one. The deadline is hard whatever the stdio mode
  (challenger Low 1 on b27f4ba, EVIDENCE §13a):
  - each command runs in its own process group, which is SIGKILLed at the
    deadline;
  - the promise rejects at once instead of waiting for `close`, which never
    fires while a grandchild still holds a pipe;
  - a pipe still held after `exit` is ended after a 2 s grace;
  - `local.mjs` kills the live groups on SIGINT/SIGTERM.
- The pg sessions have a hard limit at every stage:
  - connect timeout;
  - `query_timeout` (client side);
  - `statement_timeout` (server side);
  - a bounded `end()`;
  - an overall session cap, after which the socket is destroyed.
- Every S3 `send` carries an `abortSignal`, and the client has handler
  timeouts too.
- `portInUse` has a hard timer: an attempt that has not settled counts as
  busy, failing closed.
- The synchronous `/proc` walk is bounded by work (`maxProcesses`): beyond
  that limit it refuses.
- EVIDENCE §13 lists every wait with its bound.

**Medium (4176117561), plus challenger Lows 1 and 2: pass or fail is decided
in one place.**
- `runLocalTest` runs the body, then always the bounded cleanup.
- The pure `finalizeLocalTestSummary` then decides. A run passes only if all
  three hold:
  - the body completed;
  - the app stop was `stopped` or `killed`, meaning we stopped an app that was
    still serving;
  - `down -v` returned `ok`.
- Every other outcome fails the run. That includes `unresponsive`, any
  `error: …`, `already-exited`, never started (`null`), and any value the
  code does not know (fail closed).
- Every result is still recorded in the summary, and `down -v` always runs.
- `local.mjs` exits 1 unless `summary.pass`. The summary's `failures` lists
  every reason.
- Mutation T1 from the last round (dropping `pass = false` when the down
  fails) is now F1, and a unit test kills it.

**Low (4176117574): the brief's option analysis is historical.**
- §1 is retitled "Option analysis considered before the decisions
  (historical rationale)", with a note saying it records no open question.
- The D-01 "unresolved" sentence is in the past tense and names the
  resolution.
- "Recommended default (now DECIDED)" reads "Recommended, then adopted".
- "Choose"/"Decide" wording is now labelled as revisit triggers.
- "Blocks" reads "Depended on this decision".
- The D-02 manifest-semantics item is a known test gap, not an open
  decision.
- Sweep: the brief, DESIGN, EVIDENCE and TEST_PLAN had no other
  present-tense open-decision wording about D-01..D-10. Two Slice 2 files
  called a decided item "an owner decision", and both are fixed:
  - the `docker-compose.local.yml` header (hosting);
  - the `bootstrap.mjs` header (D-04).

**Low (4176117585): the documented ports, project names and paths match the
code.**
- DESIGN §3.2 has a settings table (developer stack and `local:test`) taken
  from `localSettings` / `localTestSettings`.
- §3.3 says CI runs `local:test` on `ratio-local-test` 54339/18353/3110.
- The CI comment names the app port 3110.
- The compose header says `name:` is only the default; the scripts always
  pass `-p`.
- TEST_PLAN separates the `ratio-local-s2a` run of the individual commands
  from `local:test`'s defaults.
- `local:down -v` removes `.ratio-local/<project>/`.
- Sweep, scripted:
  - every backticked repository path in the four Slice 2 docs exists;
  - every `RATIO_*` name they mention occurs in code or configuration;
  - every `npm run` script they name exists;
  - every port they mention is a code default, the shared or private test
    infrastructure, or the recorded `ratio-local-s2a` run.

**Left as is (outside Slice 2, historical):**
- Slice 0 and Slice 1 docs and tests still call some items "owner decision".
  They record their time, and the Slice 0/1 tests may not change.
- `.obvious/skills/ingestion-ops/SKILL.md` still calls retention (D-03) and
  the ledger grant (D-05) "owner decisions". It is reported to the
  coordinator rather than changed here.
