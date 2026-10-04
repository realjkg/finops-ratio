# Slice 2 — Local environment, published-costs read API, deployment brief: design note

Branch `slice/02-local-env-brief`, from `origin/main` at 6eac391 (Slice 0 and
Slice 1 merged). The slice has three concerns:

1. a **local, ephemeral stack** that runs the whole path (Postgres 16 + S3 →
   migrate → seed → sync);
2. a **read API**, `GET /api/v1/costs/published`, that reads the published-facts
   view as a `ratio_reader` member;
3. a **deployment decision brief** for the owner. The brief records decisions.
   It does not make them.

Boundary (BOUNDARY v2): local and ephemeral only. No production
infrastructure is chosen. Nothing under `src/ingest/db` (Slice 0) changes, and
Slice 1's worker semantics do not change. The read API *imports* Slice 0's
`withTenantTransaction`, `isTenantId` and `REFUSED_PREDEFINED_ROLES`, and Slice 1's
`inspectRole` / `roleProblems`. It does not copy them.

## 1. Components

| Path | Purpose |
|---|---|
| `docker-compose.local.yml` | Compose project `ratio-local`: `postgres` (PG16, pinned by digest) and `s3` (SeaweedFS, the digest CI already uses). Both are published on 127.0.0.1 only. Optional profiles: `app` (Next.js) and `worker` (a one-shot `sync`, `restart: "no"`). Named volumes are removed by `local:down -v`. |
| `scripts/local/local.mjs` | Subcommands `up`, `migrate`, `seed`, `sync`, `down [-v]` and `test`. Every one is idempotent. State (generated local secrets, the tenant id) lives in `.ratio-local/env` (gitignored, mode 0600). `down -v` deletes it. |
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
  each bound to a tenant) does not exist in the repo. It is recorded as an
  open owner decision (brief D-10) and is not built here.

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
    (closure query). A reader that can write is not a reader.

Any problem ⇒ the transaction is rolled back, the route answers 503
`unsafe_db_login` with a fixed message, and the reasons go only to the server
log, redacted.

Why per request and not once at start-up: role attributes and memberships can
change while a process runs, and a superuser flag takes effect in sessions
that are already open. The check is one catalog query, and it costs about a
millisecond against the read.

Pool session settings (startup `options`):
- `search_path=pg_catalog,pg_temp`. This is Slice 0's deployment note option 2,
  so the owner's `CREATE` on `public` cannot shadow anything. Every name in the
  API's SQL is schema-qualified.
- `default_transaction_read_only=on`.
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
| 503 `unsafe_db_login` | reader-login check failed |
| 500 `internal_error` + `requestId` | anything else (gateway; message logged redacted, never returned) |

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
`.ratio-local/env`. Nothing secret is committed.

### 3.2 Data flow

```
local:up       docker compose up -d --wait postgres s3  →  bootstrap (superuser)
local:migrate  worker:build → migrate (as migrator) → migrate --status --json (exit 0, no privilege problems)
local:seed     buckets ratio-local-source / ratio-local-evidence (idempotent)
               → PUT fixtures/focus-1.0-synthetic/base/** into the source bucket (same keys, same bytes)
               → provision tenant + source as the migrator (SKILL §2 SQL, ON CONFLICT DO NOTHING)
local:sync     worker sync --tenant <local tenant> --source local-focus (as worker; S3 env → local SeaweedFS)
local:test     requires an existing `next build`. It runs:
               up → migrate → seed → sync (both periods published)
               → sync again (both skipped_unchanged)
               → next start (reader URL, token, tenant binding)
               → GET /api/v1/costs/published (paged with limit=17 until nextCursor is null)
               → assert:
                 - totals == control-totals.json base (55 / 30.8272954899; 40 / 21.0978157665), as exact strings;
                 - row count over all pages == 95, no duplicates;
                 - no auth ⇒ 401;
               → down -v (always)
local:down     docker compose down [-v]; with -v also removes .ratio-local/
```

Ports are `RATIO_LOCAL_PG_PORT` (default 54329), `RATIO_LOCAL_S3_PORT`
(default 18343) and `RATIO_LOCAL_APP_PORT` (default 3100). All bind
127.0.0.1. The project name is `RATIO_LOCAL_PROJECT` (default `ratio-local`).
`local:test` asserts the server is version 16 (`server_version_num` 16xxxx).

### 3.3 CI

Two steps are appended to the existing `ci` job after `Build`. No new job is
added, the workflow stays minimal, and the change is reviewed as restricted:
1. `npm run check:bundle`.
2. `npm run local:test`.

The stack uses its own ports (54329/18343), so it does not collide with the
job's service Postgres (5432) or the test SeaweedFS (8333). Docker Compose v2
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
| Local secrets committed | generated into the gitignored `.ratio-local/env`; `.env.example` has names only | review + `git status` |
| Local stack exposed on the network | ports bound to 127.0.0.1 | compose file |

Out of scope, recorded in the brief:
- per-tenant DB roles (D-06);
- a multi-key tenant store (D-10);
- production hosting (a non-delegable human gate).

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

- **Code:** the branch is unmerged. Reverting means not merging. No migration
  is added and nothing in `src/ingest/db` changes, so no database action is
  needed.
- **CI:** remove the two appended steps.
- **Local:** `npm run local:down -- -v` removes the containers, network,
  volumes and `.ratio-local/`.
