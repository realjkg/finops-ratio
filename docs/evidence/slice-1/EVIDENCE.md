# Slice 1 — operational evidence (trusted FOCUS ingestion worker)

Branch `slice/01-focus-ingestion-worker`, created from
`origin/slice/00-postgres-foundation` @ 2866556; amended Slice 0 merged in at
47711ff (origin 446563e, round 2) and again at 614e1c6 (origin d75a152,
round 3: tenant pinned at COMMIT, RT001 for missing/invisible parent batch,
stricter migration classifier). Local commits only: nothing pushed, no PR, nothing
merged elsewhere. **All data used is SYNTHETIC. No real provider export has
been ingested; the manual real-export acceptance procedure is NOT YET
PERFORMED** (`.obvious/skills/ingestion-ops/SKILL.md` §9).

Raw outputs referenced below live next to the working copy of this file in the
session scratchpad (`red-*.txt`, `v-*.txt`, `v-testdb-*.json`, `mutations.txt`,
`v-e2e*.txt`); the essential lines are reproduced here.

## 1. Commit order (audit trail)

| # | Hash | Subject | Kind |
|---|---|---|---|
| 1 | 8a107f9 | chore(deps): add @aws-sdk/client-s3, csv-parse and tsx (dev) | deps |
| 2 | 6ad3a3d | test(ingest): add failing Slice 1 tests | tests (red) |
| 3 | 33ba912 | test(ingest): correct Slice 1 test defects found on first run | test fixes (still red at that commit: no impl committed) |
| 4 | 843501d | feat(ingest): FOCUS validation, S3 source, evidence store, config, redaction | impl |
| 5 | 19515c9 | feat(ingest): ingestion worker — leases, evidence first, staged load, quarantine, fenced publish | impl |
| 6 | 88b2ea1 | feat(ingest): worker CLI commands with evidence records | impl |
| 7 | fa5c558 | test(fixtures): committed SYNTHETIC FOCUS 1.0 export + generator script | fixture |
| 8 | fdab613 | ci: S3 parts of the DB suite against a job-scoped SeaweedFS | CI |
| 9 | 725836a | test: replay-fixtures keeps a fresh retained tenant (orchestrator decision) | test (red for #10) |
| 10 | 374d48d | feat: replay-fixtures fresh retained tenant, no deletion | impl |
| 11 | 8eb0b11 | test: background heartbeat / dead run stops heartbeating | test (red for #12) |
| 12 | 1a73753 | fix: background lease heartbeat | impl |
| 13 | 939be07 | test: zombie stopped at next chunk without takeover (P6) | test (mutation-driven, passes on #12) |
| 14 | 47711ff | merge origin/slice/00-postgres-foundation (amended 0001) | merge |
| 15 | 8ad9485 | test: align with amended 0001 (reconciliation CHECKs, expand allow-list) + W7b/W7c | tests (red for #16) |
| 16 | 53e0282 | fix: reconciliation follows the amended 0001 CHECKs | impl |
| 17 | edd65d8 | test: S3 test files fail at collection when RATIO_TEST_S3_ENDPOINT is unset | test hardening |
| 18 | 1cc3406 | fix(build): keep src/ingest out of the Tailwind content scan | build fix |
| 19 | 8e3019b | docs: ingestion-ops skill + Slice 1 design/test plan/evidence | docs |
| 20 | 614e1c6 | merge origin/slice/00-postgres-foundation (round 3) — no Slice 1 code change needed | merge |
| 21 | 83305f3 | docs: evidence refreshed for the round-3 merge | docs |
| 22 | cd87483 | test: failing tests for challenger round 1 (M-1, M-2, L1–L3) | tests (red, `r2-red-*.txt`) |
| 23 | da7101c | test: L2 test-defect fix (field name clashed with a private member; tsc only) | test fix |
| 24 | 079eb0b | fix: M-2 — Postgres-rejected values quarantined, never leaked | impl |
| 25 | 1bb100f | fix: L2 — recordRetry fenced on an unexpired lease | impl |
| 26 | 8193b0d | fix: L3 — test-only switches refused in staging/production | impl |
| 27 | f594ed3 | fix: M-1 — stall watchdogs, S3 timeouts, progress-gated heartbeat, max run duration | impl |
| 28 | 20b79fc | docs: L11 skill wording + new settings; package.json description literal restored | docs |
| 29 | 96c495a | docs: design/test plan/evidence for challenger round 1 | docs |
| 30 | b94ae2b | test: M-3 slow-but-progressing runs survive (pass on current code; mutation-proven) | tests |
| 31 | a687f09 | test: failing tests for round-3 lows L-b, L-c, L-e | tests (red, `r3-red-*.txt`) |
| 32 | fd00bb2 | fix: L-e C1 / U+2028 / U+2029 refused in header names | impl |
| 33 | 93553b1 | fix: L-b lock/idle/statement timeouts; blocked takeover fails LOCK_TIMEOUT | impl |
| 34 | d5918fa | fix: L-c run past max duration aborts itself (MAX_RUN_EXCEEDED) | impl |
| 35 | 81ab2f6 | docs: design/test plan/evidence for challenger round 3 (challenger-approved) | docs |
| 36 | c02c6aa | merge origin/slice/00-postgres-foundation @ 453377e (final Slice 0: round 5 + origin/main) — clean, no conflicts | merge |
| 37 | 774ff13 | test: test-only triggers dropped and proven not to linger past the runner's catalog check | test-only |
| 38 | (final) | docs: evidence for the final Slice 0 merge | docs |

Challenger round 3 red evidence (at a687f09): fast — `Tests 2 failed | 37
passed (39)` (L-e header characters, L-b config); DB — `Tests 2 failed | 15
passed (17)`: L-b (session settings were `0`) and L-c (the run streamed on for
~10.5 s instead of aborting). The M-3 tests (b94ae2b) pass on the code they
guard by design; they are proven by mutation (§6).

Challenger round 1 red evidence (at cd87483): fast — `Tests 8 failed | 31
passed (39)` (validator year-0/control chars, stall/L3 config, S3 timeouts;
the S3 test reported "still hanging after 4 s"); DB — `Tests 12 failed | 51
passed (63)`: 3 new W9 cases, M2-backstop, M2-generic, K6, L2, and all five
M1 stall tests (each "run still in progress after 12000 ms" / lease still
renewed). L1 passed already (the code was correct); it is proven by mutation
(§6).

Honest notes on order:
- Commit 3 was written after the implementation existed in the working tree
  (uncommitted); the first run against it exposed test/infrastructure defects
  (details §3). It is test-only and precedes every implementation commit; no
  assertion was weakened.
- Until the merge (#14) the implementation needed a column grant that Slice 0
  had not shipped yet (`UPDATE (row_count)` on `ingest_artifacts`). For local
  runs before the merge I appended that GRANT to my working copy of 0001 and
  reverted it every time (`git checkout`); it was never committed. All results
  in §4–§6 are from the merged code with NO local modification.

## 2. Red evidence (at 6ad3a3d, before any implementation)

`npx vitest run src/ingest` → exit 1 (`red-fast.txt`): 8 Slice 1 files failed
to load (`Cannot find module` `'./config'`, `'./decimal'`, `'./errors'`,
`'./evidenceRecord'`, `'./layout'`, `'./redact'`, `'./syntheticFocus'`) and `cli.worker.test.ts` 6/7 failing (worker commands
unknown ⇒ exit 2 without evidence record); `Test Files 8 failed | 7 passed (15)`,
`Tests 6 failed | 37 passed (43)`. The passing files were Slice 0's plus
`dependencyBoundary.test.ts` (a regression guard over existing code).

`RATIO_TEST_DATABASE_URL=… RATIO_TEST_S3_ENDPOINT=… npm run test:db` → exit 1
(`red-db.txt`): all 12 Slice 1 DB files failed with `Cannot find module`
(`../sources/fake/FakeFocusSource`, `./db`, `./S3FocusExportSource`,
`./fixtures/syntheticFocus`); `Test Files 12 failed | 6 passed (18)`, the 63
Slice 0 tests passed.

## 3. Test defects corrected (commit 33ba912 and later test commits)

1. SeaweedFS (`server -s3`, default config) has 20 volume slots and grows 7
   per bucket: a third bucket holding data fails with `InternalError`
   (reproduced with a probe). Per-test buckets therefore could not work. The
   suite now creates ONE bucket per run (vitest `globalSetup`, deleted at the
   end) and every test works under its own unique key prefix; evidence goes
   under that prefix via the new `RATIO_EVIDENCE_S3_PREFIX`.
2. Demo tests seed the committed data files byte-for-byte; the committed
   manifests list bucket-relative keys, so manifests are regenerated for the
   relocated prefix (the fixture test proves they equal the committed ones).
3. Fixture test summed with trailing-zero trimming; Postgres prints sums at the
   inputs' scale (10) — the test now prints the exact BigInt sum at scale 10.
4. BigInt literals (`10n`) are not allowed by the root tsconfig target
   (ES2017) — replaced with `BigInt(…)`.
5. Config test used bucket name `ev` (invalid: min 3 chars).
6. Spawn env typing for `tsc`.
7. After the merge: the doctor probe migration `SELECT 1` is not on the
   amended expand allow-list (now a `CREATE TABLE`); W8 expectation follows the
   amended reconciliation CHECK (orchestrator ruling).
8. Without `RATIO_TEST_S3_ENDPOINT` the S3 files failed in `beforeAll`, which
   vitest reports as "skipped" tests inside failed files (run still exit 1).
   They now fail at collection (no skipped count at all).

## 4. Verification (HEAD d5918fa + docs, after challenger round 3; worktree, no local modifications)

| Command | Result |
|---|---|
| `npm ci` | exit 0. `npm audit --omit=dev`: **0 vulnerabilities** (dev-tree advisories pre-existing) |
| `npm run lint` | exit 0 |
| `rm -rf .next && npx tsc --noEmit` | exit 0 |
| `npm test` | exit 0 — 39 files / 426 tests passed (Slice 1 fast files: 10 files / 106 tests) |
| `RATIO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres RATIO_TEST_S3_ENDPOINT=http://127.0.0.1:18333 npm run test:db` ×3 | exit 0 each: 21 files / **229 passed, 0 failed, 0 skipped, 0 todo** each run (55.4 s, 46.8 s, 46.8 s — the M-3 trickle tests add ~25 s by design). Slice 1 DB files: 13 files / 124 tests. No Slice 1 assertion needed changing for round 3 (none expects 42501 for a cross-tenant child-row insert; tenant-escape tests go through NOT_FOUND / RLS-filtered paths) |
| `npm run test:db` with `RATIO_TEST_DATABASE_URL` unset | exit 1: "RATIO_TEST_DATABASE_URL is not set … refusing to run" |
| `npm run test:db` with `RATIO_TEST_S3_ENDPOINT` unset | exit 1: 3 S3 files FAIL at collection ("RATIO_TEST_S3_ENDPOINT is not set"), 211 passed, nothing skipped |
| `grep -rnE '\.(skip\|only\|todo\|fails)\b\|skipIf\|runIf' src/ingest` | no matches |
| `npm run worker:build` | exit 0; `dist-worker/ingest/build-info.json` carries the git SHA; built CLI used for §5 |
| `npm run build` | exit 0 (after commit 1cc3406 — before it, Tailwind's JIT scanned `src/ingest` and emitted an invalid class from a regex literal). Then `git checkout tsconfig.json next-env.d.ts`; no AGENTS.md/CLAUDE.md generated |
| `grep -rlE 'pg-protocol\|ratio\.tenant_id\|schema_migrations\|S3FocusExportSource\|csv-parse\|ingest_artifacts' .next --include=*.js` | none — no ingestion code or driver in the Next bundles |
| `git diff --name-only origin/slice/00-postgres-foundation -- pages src \| grep -v ^src/ingest/` | none — no existing page, route or src module changed |
| Leftovers after the runs | 0 `ratio_test_login_%` roles, 0 `s1-` buckets. One stray database `ratio_test_23557_*` exists whose creating process is gone; two other agents were running DB suites concurrently in this cluster (PIDs 231xx–232xx at the time) and the count did not grow across my three final runs — not provably mine, so not dropped |
| CI (`.github/workflows/ci.yml`) | edited, YAML parses; NOT executed (no push) |

### Staged-only trigger cost (orchestrator request)

S1 (200,000 rows, 1000-row chunks, each chunk its own lease-fenced txn), same
machine, 3 runs each:
- before the merge (local temp grant, no staged-only triggers): 7 660 / 8 004 / 7 825 ms
- after the round-2 merge (per-row staged-only trigger with `FOR SHARE` on the batch): 9 465 / 11 505 / 10 712 ms
- after the round-3 merge (HEAD 614e1c6): 9 851 / 9 930 / 10 286 ms
- after challenger round 1 (watchdog + progress-gated heartbeat): 9 339 / 9 690 / 10 013 ms (no measurable cost from the watchdog); SIGKILL demo 0.92 / 0.94 / 1.05 s
- after challenger round 3 (session timeouts, max-run abort): 10 768 / 10 458 / 12 168 ms; SIGKILL demo 1.20 / 1.18 / 1.24 s — measured while another agent's DB suite was running in the same cluster (PID 10356), so not comparable 1:1; the new code adds no per-row work

≈ +2–3.7 s per 200k rows (≈ 10–18 µs per row, +25–45 % of the whole load
including parse, gzip and evidence I/O). Acceptable for this slice; a
statement-level trigger (one check per chunk) would remove most of it — a
Slice 0 design choice, noted for the owner.

## 5. Manual end-to-end (built CLI, merged code, `v-e2e.txt`)

Run on HEAD d5918fa (after challenger round 3; identical results on 20b79fc, 614e1c6 and 1cc3406 before it).
Script `e2e.sh` (scratch, not committed): scratch DB `ratio_s1_e2e_b008f434`,
worker login `IN ROLE ratio_worker`, reader login `IN ROLE ratio_reader`,
bucket `s1-e2e-b008f434` seeded with `fixtures/focus-1.0-synthetic/base/**`,
tenant provisioned as in SKILL §2, source credentials from the AWS SDK default
chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env).

| Step | Result |
|---|---|
| `migrate --status --json` | exit 3, `problems:["PENDING"]` |
| `migrate` / `--status --json` | exit 0 / exit 0, `matches:true` |
| `worker sync` | exit 0; 2026-07 `published` 55 rows `30.8272954899` `reconciled`; 2026-08 `published` 40 rows `21.0978157665` `reconciled` |
| `worker sync` again | both periods `skipped_unchanged` |
| reader view totals vs `control-totals.json` (base) | `2026-07-01 55 30.8272954899`, `2026-08-01 40 21.0978157665` — **identical** |
| batches | both `published/reconciled`, control = loaded exactly |
| evidence re-hash (3 objects) | all `OK` (sha256 of the stored object = `ingest_artifacts.sha256`) |
| `worker doctor --json --tenant …` | exit 0, all checks pass |
| `RATIO_ENV=test worker replay-fixtures --json` | exit 0, 6/6 scenarios pass, tenant `fixture-20261003070324-6ac69c12` retained |
| fixture tenant footprint | 341 fact rows (~409 kB), 8 batches, 8 runs, 38 objects / 75 458 bytes |
| cleanup (scratch only) | bucket deleted, database and logins dropped |

## 6. Mutation checks (run on the round-2 merge 53e0282+; the mutated lines are unchanged by round 3, `mutations.txt`)

Each mutation applied to one line, the named tests run, the file restored
byte-identically (`cmp`).

| Mutation | Result |
|---|---|
| M1 publish without the lease fence (`lock_run`) | 1 test fails (P4; P3 is additionally caught by staged-batch deletion + fenced finish) |
| M2 evidence not re-hashed on parse | 1 test fails (s3Source file: X4) |
| M3 staged batches not deleted at acquisition | 1 test fails (lease/crash files) |
| M4 reconciliation variance ignored | 6 tests fail (sync file: W7 variants) |
| M5 no per-chunk lease check | **survived at first** (a takeover's staged-batch deletion also stopped the zombie) → added P6 (commit 939be07); now P6 fails |
| M6 live lease not refused | 2 tests fail (lease/crash files) |
| (heartbeat) background heartbeat not stopped on exit | L6 times out |

### Challenger round 1 mutation proofs (`mutations2.txt`)

| Mutation | Result |
|---|---|
| R1-M1a heartbeat renews without progress gating | 2 fail (M1-heartbeat, M1-maxrun) |
| R1-M1b no idle watchdog on the source stream | 1 fails (M1-stream) |
| R1-M1c no deadline on opening the source | 1 fails (M1-open) |
| R1-M1d evidence watchdog disabled (timeout 1e9 ms) | 1 fails (M1-evidence). A first attempt that only unpiped the watchdog survived because the unpiped watchdog still fired — the mutation, not the test, was wrong |
| R1-M1e S3 request timeout only warns | 1 fails (S3-timeout) |
| R1-M2a no year floor | 1 fails (W9 year 0000) |
| R1-M2b no control-character check in cells | 2 fail (W9 NUL mapped / extra) |
| R1-M2c no class-22 backstop | 1 fails (M2-backstop) |
| R1-M2d raw pg messages persisted | 2 fail (M2-generic, K6) |
| R1-L1 staged cleanup across every source of the tenant | 1 fails (L1) |
| R1-L2 retry recorded on an expired lease | 1 fails (L2) |
| R1-L3 RATIO_ENV ignored by test switches | 1 fails (L3) |

### Challenger round 3 mutation proofs (`mutations3.txt`, `mutations4.txt`)

| Mutation | Killed by |
|---|---|
| N2 watchdog not re-armed when data arrives | M3-a (source path) and M3-b (evidence path) |
| N10 capture never reports progress | M3-a (lease lost while trickling) |
| N3 `touch()` is a no-op | M3-c (`EVIDENCE_STALLED`). A first version of M3-c (no slow insert, 0.8 s hook vs 1 s stall) let N3 survive: the stream buffers absorbed the file. M3-c now makes each insert slow (1 s statement trigger) and uses a 2 s stall with a 1.6 s hook, so only `touch()` bridges the ~2.6 s between evidence bytes |
| Lb-1 no `lock_timeout` on worker sessions | L-b (fails at the session-settings assertion) |
| Lb-2 lock timeout not mapped to LOCK_TIMEOUT | L-b (outcome `DB_55P03`) |
| Lc-1 max-run abort timer never fires | L-c |
| Lc-2 streams ignore the abort signal | L-c |
| Le C1/U+2028 allowed in header names | V L-e |

## 7. Owner acceptance demonstration ↔ tests (`src/ingest/demo.db.test.ts`, committed fixture, real S3, real LOGIN roles)

| # | Check | Proven by |
|---|---|---|
| 1 | Fixture ingested; original bytes stored with hash | `demo 1` (re-hash every evidence object; bytes equal the committed files); also X2, X3, W1, e2e §5 |
| 2 | Parser creates a staged revision | `demo 2` (batch `staged` with 10 fact rows, invisible to `ratio_reader`); C1 |
| 3 | Validation passes, or inspectable quarantine | `demo 3` (reconciled + published; corrupt variant ⇒ quarantined, `quarantine show --json` lists sha256/row/column/code); W9 matrix, W11, K2 |
| 4 | Reprocessing yields no duplicate published facts | `demo 4` (sync ×2, `replay --period`, backfill ⇒ one batch per period, totals = control); W2, R2 |
| 5 | SIGKILL mid-run exposes no partial data | `demo 5 + 6` (≈0.9 s per run; real child process via tsx, paused by the NODE_ENV=test hook after ≥20 rows, `kill -9`, reader view = previous revision, checkpoint unchanged); C1, C1b |
| 6 | Restart completes safely or fails visibly without advancing checkpoint | `demo 5 + 6` (immediate restart exit 4, checkpoint unchanged; after lease expiry exit 0, totals = restatement control, killed run `abandoned`, its staged batch gone); L3, L6 |
| 7 | App reads latest accepted revision; staged/quarantined inaccessible to `ratio_reader` | `demo 7` (reader LOGIN sees exactly the published batches; 42501 on cost_facts, ingest_batches, ingest_validation_errors, ingest_artifacts, sync_runs, period_publications); demo 2 |
| 8 | Tenant-bound access fails closed | `demo 8` (no tenant ⇒ 0 rows; tenant B ⇒ none of A; worker cannot update A from B; CLI B + A's source ⇒ SOURCE_NOT_FOUND; malformed tenant ⇒ exit 2); T1, T2 |

## 8. Complete Slice 1 test list (final run; every test `passed`)

### Fast suite (npm test)

- `src/ingest/cli.worker.test.ts`
  - passed: usage errors exit 2 and still print one evidence record
  - passed: missing RATIO_DATABASE_URL is a configuration error (exit 2)
  - passed: replay-fixtures is refused unless RATIO_ENV is staging or test, before connecting
  - passed: the test kill hook outside NODE_ENV=test refuses to start (before connecting)
  - passed: connection failures exit 1 and never echo the URL, user or password
  - passed: doctor --json reports db_connectivity failure as a failed check
  - passed: unknown commands still exit 2 (Slice 0 contract unchanged)

- `src/ingest/config.test.ts`
  - passed: applies safe defaults
  - passed: refuses out-of-range or non-integer numbers
  - passed: refuses an unknown RATIO_ENV
  - passed: the test kill hook is impossible to enable outside NODE_ENV=test
  - passed: fake source is allowed only with RATIO_ALLOW_FAKE_SOURCE=1 AND NODE_ENV=test
  - passed: refuses S3 endpoints carrying credentials, query or fragment
  - passed: refuses plain-http S3 endpoints in production, allows them elsewhere
  - passed: requires both halves of a static S3 credential pair
  - passed: enforces RATIO_ARTIFACT_DIGEST format
  - passed: config errors never echo secret values
  - passed: stall watchdog and maximum run duration have defaults and bounds (M-1)
  - passed: L3: test-only switches refuse to activate when RATIO_ENV is staging or production, even with NODE_ENV=test
  - passed: L-b: worker DB session timeouts have defaults and bounds

- `src/ingest/dependencyBoundary.test.ts`
  - passed: no file under pages/ or src/ (outside src/ingest) imports @aws-sdk/* or csv-parse
  - passed: detector flags the forbidden specifiers (self-test)

- `src/ingest/evidenceRecord.test.ts`
  - passed: has the machine-readable shape the pipeline consumes
  - passed: redacts secrets that reach results
  - passed: git SHA precedence: env, then build-info, then null; invalid env values ignored

- `src/ingest/fixtures/syntheticFocus.test.ts`
  - passed: is deterministic
  - passed: uses the AWS Data Exports layout under the given prefix/export name
  - passed: control totals are the exact decimal sums of the generated rows
  - passed: base contains duplicate legitimate rows within a file and across files
  - passed: restatement re-exports 2026-07 under a new run with different totals; 2026-08 unchanged
  - passed: manifests carry control totals (base/restatement), a wrong one (variance), none (nocontrol)
  - passed: every row is labelled synthetic (never presented as a real provider)
  - passed: the committed fixture equals the generator output and its README/control-totals match

- `src/ingest/focus/validate.test.ts`
  - passed: accepts plain, signed, fractional and exponent decimals
  - passed: rejects non-decimals, NaN and Infinity
  - passed: accepts ISO 8601 forms and normalizes offset-less values to UTC
  - passed: rejects malformed and impossible timestamps
  - passed: reports every missing required column
  - passed: rejects control characters in header names (M-2)
  - passed: rejects C1 controls and U+2028/U+2029 in header names (they become JSON keys) (L-e)
  - passed: rejects duplicate column names
  - passed: maps a valid FOCUS 1.0 row; money stays the exact source string
  - passed: maps FOCUS 0.5 UsageQuantity/UsageUnit when ConsumedQuantity is absent
  - passed: rejects empty BilledCost without echoing the cell value
  - passed: rejects unparseable BilledCost without echoing the cell value
  - passed: rejects NaN BilledCost without echoing the cell value
  - passed: rejects Infinity EffectiveCost without echoing the cell value
  - passed: rejects unparseable quantity without echoing the cell value
  - passed: rejects unparseable ChargePeriodStart without echoing the cell value
  - passed: rejects impossible ChargePeriodEnd without echoing the cell value
  - passed: rejects BillingPeriodStart of another period without echoing the cell value
  - passed: rejects BillingPeriodStart not at midnight without echoing the cell value
  - passed: rejects ChargePeriodEnd before start without echoing the cell value
  - passed: rejects lower-case currency without echoing the cell value
  - passed: rejects empty currency without echoing the cell value
  - passed: rejects year 0000 timestamps (Postgres cannot store them) (M-2)
  - passed: rejects NUL and other C0 control characters in any cell; allows TAB, CR and LF (M-2)
  - passed: accepts BillingPeriodStart expressed with an equivalent offset
  - passed: rejects a row with the wrong number of cells

- `src/ingest/redact.test.ts`
  - passed: removes URL query string
  - passed: removes presigned signature
  - passed: removes bare sig=
  - passed: removes bearer token
  - passed: removes AWS access key id
  - passed: removes AWS temp key id
  - passed: removes AWS secret after name
  - passed: removes security token
  - passed: removes postgres URL credentials
  - passed: removes password=
  - passed: removes signature=
  - passed: removes literal configured secrets anywhere
  - passed: ignores empty/short configured secrets (no over-redaction)
  - passed: leaves benign operational text unchanged
  - passed: caps output at 4000 characters
  - passed: secretsFromEnv collects credential env values and DB URL passwords

- `src/ingest/retry.test.ts`
  - passed: is full jitter within [0, min(cap, base * 2^(n-1))]
  - passed: classifies transient errors
  - passed: classifies permanent errors
  - passed: retries transient errors and returns the eventual result
  - passed: gives up after maxAttempts and rethrows the last error
  - passed: never retries permanent errors
  - passed: rejects a non-positive maxAttempts

- `src/ingest/s3client.test.ts`
  - passed: config exposes request/connect timeouts with defaults and bounds
  - passed: a request to a server that never answers fails within the configured timeout

- `src/ingest/sources/s3/layout.test.ts`
  - passed: derives metadata and data prefixes
  - passed: parses BILLING_PERIOD=YYYY-MM prefixes and filters by range
  - passed: validates source config (bucket/prefix/exportName), failing closed
  - passed: parses dataFiles given as bucket-relative keys, s3 URIs and objects with row counts
  - passed: a manifest without control yields no control
  - passed: refuses a manifest with not JSON
  - passed: refuses a manifest with no dataFiles
  - passed: refuses a manifest with another bucket
  - passed: refuses a manifest with path traversal
  - passed: refuses a manifest with dot segment
  - passed: refuses a manifest with empty segment
  - passed: refuses a manifest with query string
  - passed: refuses a manifest with other period folder
  - passed: refuses a manifest with outside the export
  - passed: refuses a manifest with file not in listing
  - passed: refuses a manifest with billingPeriod mismatch
  - passed: refuses a manifest with non-integer control rowCount
  - passed: refuses a manifest with non-decimal control total
  - passed: refuses a manifest with NaN control total
  - passed: refuses a manifest with duplicate data file
  - passed: listing fingerprint is order-independent and changes with etag, size or manifest bytes
  - passed: classifies artifact formats

(106 tests)

### DB suite (npm run test:db, final run 3)

- `src/ingest/cliWorker.db.test.ts`
  - passed: K1 sync prints one evidence record, logs JSON without row contents or secrets, and appends RATIO_EVIDENCE_FILE (also for migrate)
  - passed: K2 backfill, replay --batch, replay --period and quarantine show via the CLI
  - passed: K3 a fake source is refused by the CLI outside NODE_ENV=test + RATIO_ALLOW_FAKE_SOURCE=1
  - passed: K4 exit 4 while another run holds a live lease; S3 failures exit 1 with secrets redacted everywhere
  - passed: K5 doctor --json exits 0 when healthy and 1 when not; replay-fixtures --json runs all scenarios in a fresh, retained, synthetic-labelled tenant
  - passed: K6 (M-2) rejected values never appear in the CLI evidence record, logs, error_detail or stats

- `src/ingest/demo.db.test.ts`
  - passed: demo 1: fixture ingested; original bytes stored with hash (re-hashing the evidence object)
  - passed: demo 2: the parser creates a staged revision that nobody can read until it is published
  - passed: demo 3: validation passes (reconciled) or yields an inspectable quarantine
  - passed: demo 4: reprocessing the same artifacts yields no duplicate published facts
  - passed: demo 5 + 6: SIGKILL mid-load exposes no partial data; restart fails visibly before lease expiry and completes after, without advancing the checkpoint in between
  - passed: demo 7: the app (ratio_reader) reads the latest accepted revision; staged and quarantined data are inaccessible
  - passed: demo 8: tenant-bound access fails closed

- `src/ingest/sources/s3/s3Source.db.test.ts`
  - passed: X1 lists periods, honours the range, reads manifests and refuses unsafe or ambiguous ones
  - passed: X2 content-addressed put is idempotent; a size conflict is refused; objects re-hash to their key
  - passed: X3 the synthetic gzip export is read end-to-end and totals equal its control totals
  - passed: X4 a tampered evidence object (same size, different bytes) fails EVIDENCE_INTEGRITY and publishes nothing
  - passed: X5 a parquet artifact is captured as evidence and the batch quarantined UNSUPPORTED_FORMAT

- `src/ingest/worker/auth.db.test.ts`
  - passed: A1 accepts a plain ratio_worker login
  - passed: A1 refuses a superuser connection
  - passed: A1 refuses a BYPASSRLS login even if it is a ratio_worker member
  - passed: A1 refuses a login that can SET ROLE to a superuser role
  - passed: A1 refuses a member of ratio_owner (could disable RLS)
  - passed: A1 refuses a login that is not a ratio_worker member (e.g. the reader)
  - passed: A1 the CLI refuses to sync as a superuser (exit 1, UNSAFE_DB_ROLE, nothing written)
  - passed: A2 every worker entry point fails with permission denied as ratio_reader

- `src/ingest/worker/crash.db.test.ts`
  - passed: C1 crash after N rows: nothing visible, checkpoint untouched; restart before expiry refused; after expiry recovery equals a clean run
  - passed: C1b crash during a restatement keeps the previous revision readable
  - passed: C2 transient source errors are retried with backoff; attempts and retries are visible in sync_runs
  - passed: C3 transient errors beyond the retry budget fail the period; checkpoint not advanced
  - passed: C4 permanent (validation) errors are not retried

- `src/ingest/worker/doctor.db.test.ts`
  - passed: D1 healthy: every check passes
  - passed: D1 superuser connection ⇒ role_safety fails
  - passed: D1 schema behind the code ⇒ migration_version fails; ledger unavailable ⇒ fails (never skipped)
  - passed: D1 last run failed, stale data, or never succeeded ⇒ source check fails; disabled source skipped

- `src/ingest/worker/lease.db.test.ts`
  - passed: L1 five workers started at once on the same source: exactly one runs, the rest are refused ALREADY_RUNNING
  - passed: L2 two tenants run concurrently, both succeed, and each sees only its own facts
  - passed: L3 acquiring after expiry marks the dead run abandoned (LEASE_EXPIRED) and deletes its staged batches
  - passed: L5 a background heartbeat keeps a long-running run's lease alive
  - passed: L6 a crashed (simulated dead) run stops heartbeating, so its lease expires
  - passed: L1 (challenger) acquiring source X never deletes source Y's staged batch in the same tenant
  - passed: L2 (challenger) a zombie whose lease expired cannot record a retry (attempt and retries unchanged)
  - passed: L-b worker sessions carry lock/idle/statement timeouts; a takeover blocked by a held row lock fails LOCK_TIMEOUT within its bound

- `src/ingest/worker/publish.db.test.ts`
  - passed: publish steps are the documented, complete sequence
  - passed: P1 failure injected at "lock_run" leaves view, publications, batches and checkpoint unchanged; a later run recovers
  - passed: P1 failure injected at "lock_period" leaves view, publications, batches and checkpoint unchanged; a later run recovers
  - passed: P1 failure injected at "supersede_prior" leaves view, publications, batches and checkpoint unchanged; a later run recovers
  - passed: P1 failure injected at "mark_published" leaves view, publications, batches and checkpoint unchanged; a later run recovers
  - passed: P1 failure injected at "upsert_publication" leaves view, publications, batches and checkpoint unchanged; a later run recovers
  - passed: P1 failure injected at "advance_checkpoint" leaves view, publications, batches and checkpoint unchanged; a later run recovers
  - passed: P1 failure injected at "commit" leaves view, publications, batches and checkpoint unchanged; a later run recovers
  - passed: P2 failure inside the quarantine transaction leaves the batch staged (never published) and the view unchanged
  - passed: P3 run A loses its lease, run B takes over and publishes, A then fails at publish and cannot touch its run row
  - passed: P4 an expired lease without takeover still fails at publish; heartbeat cannot revive it
  - passed: L4 heartbeat extends a live lease
  - passed: P5 a zombie cannot insert further chunks after takeover
  - passed: P6 an expired lease stops a zombie at its next chunk even without a takeover

- `src/ingest/worker/replay.db.test.ts`
  - passed: R1 rollback re-points the period at the retained batch, pins it against scheduled syncs, and rolls forward again
  - passed: R2 replay --period re-ingests from the source ignoring the checkpoint and clears the pin
  - passed: R3 quarantined and staged batches are not replayable; other sources/tenants batches are NOT_FOUND
  - passed: R4 replay failure injected at "lock_run" changes nothing
  - passed: R4 replay failure injected at "lock_period" changes nothing
  - passed: R4 replay failure injected at "supersede_prior" changes nothing
  - passed: R4 replay failure injected at "mark_published" changes nothing
  - passed: R4 replay failure injected at "upsert_publication" changes nothing
  - passed: R4 replay failure injected at "advance_checkpoint" changes nothing
  - passed: R4 replay failure injected at "commit" changes nothing

- `src/ingest/worker/stall.db.test.ts`
  - passed: M1-stream: a source stream that never emits fails SOURCE_STALLED in bounded time; next sync succeeds
  - passed: M1-open: a source open that never resolves fails SOURCE_STALLED in bounded time; next sync succeeds
  - passed: M1-evidence: an evidence read that never emits fails EVIDENCE_STALLED in bounded time; nothing published
  - passed: M1-heartbeat: a run that makes no progress stops renewing its lease, so another worker can take over
  - passed: M1-maxrun: renewal also stops after the maximum run duration, even while progressing
  - passed: M3-a: a source trickling one chunk every 0.7 s for ~10 s (stall 3 s, TTL 5 s) succeeds and holds its lease throughout
  - passed: M3-b: an evidence read trickling one chunk every 0.7 s for ~10 s (stall 3 s, TTL 5 s) succeeds and holds its lease
  - passed: M3-c: slow downstream inserts plus a 0.8 x stall hook per chunk are not mistaken for an evidence stall
  - passed: L-c: a run past its maximum duration aborts itself (MAX_RUN_EXCEEDED) while still streaming, checkpoint untouched

- `src/ingest/worker/streaming.db.test.ts`
  - passed: S1 200,000 rows load in bounded chunks while the evidence stream is still being read

- `src/ingest/worker/sync.db.test.ts`
  - passed: W1 clean load publishes one batch; evidence stored and re-hashes; checkpoint records the fingerprint; logs carry no row contents
  - passed: W2 idempotency: same input twice ⇒ one batch, identical totals, second run skips without downloading; backfill ⇒ unchanged
  - passed: W3 duplicate legitimate rows (same file and across files) are all stored and summed
  - passed: W4 restatement supersedes the period (no double count); W5 a revert re-publishes the retained batch
  - passed: W12 provisional flag: current month true, previous month false
  - passed: W13 incremental skips unchanged periods without opening them; backfill touches only the range
  - passed: W14 a listing failure fails the run visibly, other periods still publish, failed period not checkpointed
  - passed: W16 the worker runs against exactly the shipped schema version
  - passed: W6 matching control ⇒ reconciled and published (numeric, not string, compare)
  - passed: W8 no control ⇒ unverified and published; a partial (row-count only) agreeing control ⇒ reconciled
  - passed: W7 row count mismatch ⇒ quarantined variance, prior publication and checkpoint untouched
  - passed: W7 billed total mismatch ⇒ quarantined variance, prior publication and checkpoint untouched
  - passed: W7 row count only mismatch ⇒ quarantined variance, prior publication and checkpoint untouched
  - passed: W7 billed total only mismatch ⇒ quarantined variance, prior publication and checkpoint untouched
  - passed: W7 per-artifact row count mismatch ⇒ quarantined variance, prior publication and checkpoint untouched
  - passed: W7b a per-artifact count for only some artifacts that disagrees ⇒ quarantined (no set-level control to store, so reconciliation stays unverified)
  - passed: W7c per-artifact counts covering every artifact become the set-level control row count
  - passed: W15 same bytes but a disagreeing control ⇒ failed visibly, publication untouched
  - passed: W9 missing column BilledCost ⇒ quarantined (MISSING_REQUIRED_COLUMN); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 missing column BillingCurrency ⇒ quarantined (MISSING_REQUIRED_COLUMN); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 missing column ChargePeriodStart ⇒ quarantined (MISSING_REQUIRED_COLUMN); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 missing column ChargePeriodEnd ⇒ quarantined (MISSING_REQUIRED_COLUMN); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 missing column BillingPeriodStart ⇒ quarantined (MISSING_REQUIRED_COLUMN); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 unparseable BilledCost ⇒ quarantined (UNPARSEABLE_NUMBER); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 NaN BilledCost ⇒ quarantined (UNPARSEABLE_NUMBER); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 unparseable date ⇒ quarantined (UNPARSEABLE_TIMESTAMP); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 impossible date ⇒ quarantined (UNPARSEABLE_TIMESTAMP); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 row of another billing period ⇒ quarantined (PERIOD_MISMATCH); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 inverted charge period ⇒ quarantined (CHARGE_PERIOD_INVERTED); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 bad currency ⇒ quarantined (INVALID_CURRENCY); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 year 0000 timestamp ⇒ quarantined (UNPARSEABLE_TIMESTAMP); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 NUL in a mapped column ⇒ quarantined (INVALID_CHARACTER); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 NUL in an extra column ⇒ quarantined (INVALID_CHARACTER); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 inconsistent column count ⇒ quarantined (CSV_PARSE_ERROR); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 invalid gzip ⇒ quarantined (INVALID_GZIP); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 parquet artifact ⇒ quarantined (UNSUPPORTED_FORMAT); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 row limit exceeded ⇒ quarantined (ROW_LIMIT_EXCEEDED); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 empty artifact set ⇒ quarantined (EMPTY_ARTIFACT_SET); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 zero data rows ⇒ quarantined (EMPTY_BATCH); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 mixed billing currencies ⇒ quarantined (MIXED_BILLING_CURRENCY); prior publication, view and checkpoint untouched; no facts kept
  - passed: W9 byte-identical duplicate artifacts ⇒ quarantined (DUPLICATE_ARTIFACT); prior publication, view and checkpoint untouched; no facts kept
  - passed: W10 oversize artifact (by listing) ⇒ failed before download; nothing captured; checkpoint not advanced
  - passed: W11 validation errors: 1000 stored, true total counted; quarantine show returns them inspectably
  - passed: M2-backstop: a class-22 rejection by Postgres quarantines the batch with a code-only error; the value is never persisted
  - passed: M2-generic: any other database error fails the period with a code and generic text only (no raw pg message anywhere)

- `src/ingest/worker/tenantEscape.db.test.ts`
  - passed: T1 B source keys, batch ids and quarantine reports are NOT_FOUND for tenant A; A syncs never change B
  - passed: T2 malformed or missing tenant ids are refused before any query

(124 tests)

Slice 0 suites (unchanged by Slice 1, all passing in the same runs): see
`docs/evidence/slice-0/`.

## 9. Fixture provenance

`fixtures/focus-1.0-synthetic/` — SYNTHETIC (provider `SyntheticCloud`,
`syn-…` ids), generated by `npm run fixture:generate`
(`scripts/generate-focus-fixture.ts` → `src/ingest/fixtures/syntheticFocus.ts`,
BigInt money). Control totals (exact): base 2026-07 55 rows
`30.8272954899`; base 2026-08 40 rows `21.0978157665`; restatement 2026-07
56 rows `24.4997954899`; restatement 2026-08 40 rows `21.0978157665`.
Deliberate duplicate legitimate rows: base 2026-07 file 00001 data line 4 ×3,
and data line 8 repeated in file 00002. `syntheticFocus.test.ts` fails if the
committed files, `control-totals.json` or the README drift from the generator.
Other test data: hand-built synthetic CSVs (`src/ingest/testing/focusCsv.ts`).

## 10. Rollback / replay procedure

See SKILL §5. Data: `replay --batch <superseded>` (fenced, atomic, pins the
period), `replay --batch <newer>` to roll forward, `replay --period` to
re-ingest and unpin — tested (R1–R4, K2). Code: no Slice 1 migration, so
reverting the Slice 1 commits needs no DB action; ingested rows stay in
`ratio.*` (removing them is retention-class, owner-only).

## 11. Known gaps

- Real AWS manifest format/semantics unverified (acceptance NOT YET PERFORMED);
  multiple manifests per period refused (`MANIFEST_AMBIGUOUS`); real manifests
  expected to carry no control totals ⇒ `unverified`.
- Quarantined batches are terminal; identical bytes are not re-validated
  after a code fix.
- Byte-identical data files inside one set are quarantined (`DUPLICATE_ARTIFACT`).
- One billing currency per batch (else quarantined).
- Temp capture files of a SIGKILLed process remain under `RATIO_TMP_DIR`.
- Evidence objects and replay-fixtures tenants are never deleted (no deletion
  path this cycle).
- `doctor` needs the owner URL (read-only txn) or a ledger grant for its
  migration check (delegated decision (b), DESIGN §15).
- A stalled attempt costs up to `RATIO_STALL_TIMEOUT_SECONDS` and is retried
  within the retry budget.
- Deferred to an issue (orchestrator): L-a run-history accuracy when a publish
  commit outlives its lease; L-d long DB steps do not count as progress (a
  single statement longer than the stall limit stops lease renewal);
  challenger L4–L10.
- Leftover test objects in the shared cluster: `ratio_test_23557_*` (origin
  gone) and login `ratio_test_login_1169_*` (origin gone) are not provably
  mine and were not dropped; `ratio_test_10356_*` belonged to another agent's
  run in progress at the time.
- The S3 request timeout covers time-to-response only; body streaming is
  guarded by the stall watchdog.
- `quarantine show` exposes validation messages but never cell values; an
  operator needs the evidence object to see the bad value.
- The test kill hook and fake source ship in the build but are refused
  unless `NODE_ENV=test` (fake also needs `RATIO_ALLOW_FAKE_SOURCE=1`).
- CI change not executed (no push); local SeaweedFS volume limit means the
  suite must keep using one bucket per run.
- One stray `ratio_test_23557_*` database in the shared local cluster of
  unknown (gone) origin.

## 12. Final Slice 0 merge (453377e) — re-verification

Merged with a merge commit (c02c6aa), no conflicts. The merge brings Slice 0
round 5 (runner + `migrate --status`/doctor catalog privilege check,
`privilegeModel.ts`) and origin/main (governance workflow, costsource etc.).

| Check | Result |
|---|---|
| `npm ci` / prod audit | exit 0 / 0 vulnerabilities |
| lint, `rm -rf .next && tsc --noEmit` | exit 0 |
| `npm test` | 68 files / 1189 passed (includes origin/main's suites) |
| `test:db` ×3 (both env vars) | 22 files / **269 passed** each run (56.8 s, 46.9 s, 46.4 s), 0 skipped |
| without `RATIO_TEST_DATABASE_URL` | exit 1 (refuses to run) |
| without `RATIO_TEST_S3_ENDPOINT` | exit 1, 3 S3 files fail at collection, 251 passed, nothing skipped |
| `.skip/.only/.todo/fails` grep | none |
| `worker:build`, `next build` + restore | exit 0; no AGENTS.md/CLAUDE.md; no ingestion code in `.next`; no change outside `src/ingest` vs the Slice 0 branch |
| targeted re-run: doctor D1 (4), M2-backstop, M2-generic, K6, M3-c | all pass. The D1 probe migration (`CREATE TABLE public.ratio_doctor_future_probe`) passes the classifier and is only reported as `PENDING` |
| manual end-to-end (built CLI, DB `ratio_s1_e2e_90dbb1bf`) | status 3→migrate 0→status 0 (`problems: []`), sync published+reconciled, re-sync skipped_unchanged, reader totals = control totals, 3/3 evidence re-hash OK, doctor exit 0 (migration_version `problems: []`), replay-fixtures 6/6 (`fixture-20261003073233-da92a79c`), scratch cleaned up |

**Finding (test-only, fixed in 774ff13):** the new catalog check reports any
non-reviewed trigger as `PRIVILEGE_MODEL_VIOLATION`. The superuser-created
test triggers in `sync.db` (M2-backstop/generic) and `cliWorker.db` (K6) were
never dropped, so a later `migrate`/`doctor` in the same per-file database
would have failed depending on test order (it did not in practice: they ran
last). Both tests now assert the violation is reported while the trigger
exists, drop it, and assert `migrate --status` (and doctor's
`migration_version`) is clean afterwards. M3-c already dropped its trigger in
`finally`. No production code path changed.

Leftovers: login `ratio_test_login_6414_*` appeared during this session's
window; an isolated re-run of `test:db` leaves zero new roles/databases, and
PID 6414 is gone — not attributable to this suite, not dropped.
