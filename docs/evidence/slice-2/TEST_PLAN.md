# Slice 2 — test plan

## Ground rules

Tests were written and committed failing, before the implementation:
- `ac37059`: the API, boundary and local tooling tests;
- `30084c2`: the bundle check;
- `e0585a5`: the lazy manifest and the startup check.

The red output is in `docs/evidence/slice-2/red/`. No test uses `.skip`, `.only`,
`.todo`, `it.fails`, `skipIf` or `runIf`.

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
- The local stack used its own compose project (`ratio-local-s2a`) on ports
  55710/18710/3710.

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
| L1–L8 | `scripts/local/local.test.mjs` | local secrets (random, distinct, strong token, uuid tenant); env file round trip and refusal of unsafe values; `.ratio-local/` gitignored; settings and ports validated; loopback URLs; **bootstrap plan**: only NO… attributes, ratio roles NOLOGIN with no membership, exactly one membership per login, no GRANT, the migrator owns the DB, every CREATE guarded, no password in the plan, identifiers validated; compose: 127.0.0.1-only ports, images pinned by digest (SeaweedFS = the CI digest), required superuser password, no passwordless auth, optional app/worker profiles, one-shot worker; `.env.example` names only; npm scripts wired; exact control-total comparison | local stack |
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
| D7 | 〃 | reader pool session settings: `search_path=pg_catalog,pg_temp`, read-only, 10 s statement timeout, UTC | hardening |
| S | `src/server/costs/publishedCosts.serial.db.test.ts` | BYPASSRLS, REPLICATION, CREATEROLE and CREATEDB readers (the attribute itself, or a role reached over a SET edge); a reachable SUPERUSER role; **every `REFUSED_PREDEFINED_ROLES` role over INHERIT, SET-only, ADMIN-only and transitive edges** ⇒ 503; a harmless extra role ⇒ 200 (no over-refusal); every role dropped and verified gone | unsafe-login refusal |
| — | all Slice 0 and Slice 1 DB tests, **unchanged** | still green with the lazy manifest, incl. the drift test, the manifest-file test and the `pg_dump` → restore round trip | coordinator Q1 (a)(d) |

## C. Outside vitest

| ID | Check | Command |
|---|---|---|
| X1 | CLI output identical before and after the lazy fix: `migrate --status --json` (pending), `migrate` (twice), `migrate --status --json`, `doctor --json` (worker login) and `doctor` as superuser (refused), on a fixture DB; normalised diff | scratch `cli-diff.sh before/after` (EVIDENCE §4) |
| X2 | fail-closed comparison of the eager vs lazy worker builds with a corrupt and with a missing 0001 manifest | scratch `failclosed.sh` (EVIDENCE §4) |
| X3 | `.next` bundle check on the real production build | `npm run check:bundle` |
| X4 | **full local flow under `next build && next start`** (also the regression test for the next-start-only failure class, now in CI): up ×2 → migrate ×2 (status matches, `privilegeProblems: []`) → seed ×2 → sync (both periods `published`) → sync (both `skipped_unchanged`) → anonymous GET 401 → paged GET (limit 17) → **totals == control totals exactly** (55 / `30.8272954899`, 40 / `21.0978157665`), 95 distinct rows → `down -v` | `npm run local:test` |
| X5 | the individual commands, plus `down -v` leaving nothing behind (containers, volumes, network, `.ratio-local/`) | `npm run local:up / local:migrate / local:seed / local:sync / local:down -- -v` |
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
| X9 | scratch `mutate2.sh`, `mutate3.sh` | mutation checks for every fix of this batch (EVIDENCE §11) | all |
