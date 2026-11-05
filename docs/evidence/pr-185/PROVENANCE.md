# How this evidence was produced

- **Attested SHA:** `48be087c3bd83d4bcea0fcfdf7610fed8b9f7aa8` (PR #185, review round: code at `68b4fd1` plus its
  red/green notes), against base `6c809af` (main). It replaces the evidence for `cc844cc` (commit `17aba34`).
- **Collector:** `scripts/evidence/collect-pr-evidence.mjs` from PR #182 (branch `claude/platform-a0-evidence-manifest`)
  at commit `09f0c6e`, run from that separate checkout with this checkout as the working directory (the pattern of
  `docs/evidence/pr-179`); the platform section is N/A here (this branch has no manifest).
- **Exact command**, in a clean clone at the attested SHA, Linux container, Node v22.23.4:

  ```
  RATIO_EVIDENCE_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
  RATIO_EVIDENCE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55434/postgres \
  RATIO_EVIDENCE_PG_DUMP=/usr/lib/postgresql/16/bin/pg_dump RATIO_EVIDENCE_PSQL=/usr/lib/postgresql/16/bin/psql \
    node ../a0/scripts/evidence/collect-pr-evidence.mjs --base origin/main --head 48be087c3bd83d4bcea0fcfdf7610fed8b9f7aa8 --pr 185 --logs ../../sa2-ev185-logs
  ```

  The run exited 1. `evidence.md` and `evidence.json` are committed exactly as generated, unedited:
  - `evidence.md` sha256: `767b5bca6cc11a701df7261751dd0a7f4ec8e79e251c18d1187b0c31556357a7`
  - `evidence.json` sha256: `f33d32225783dfe0f6b8a782c806db3d3e01e1d926311c0b4bc532a79052565b`
- **Why charter item 1 is FAIL:** 1 of 5214 unit tests, `src/connectors/managed/boundary.test.ts` "no file Next can
  bundle reaches a worker-only managed module…", hit vitest's 5 s timeout while the shared 4-core host ran other
  sessions' suites (load average 9–11). It is a timing failure, not a boundary finding: in isolation, the same test
  takes 2397–2596 ms at this SHA and 2529–2550 ms on main (`--reporter=verbose`, two runs each, same host), and it
  passed in the full local run at `ffe894a` (312 files, 5214 passed) and in GitHub CI on this SHA.
- **GitHub CI on `48be087`:** every check success, including "Lint · Typecheck · Test · Build" (full vitest and
  `npm run test:db`, so the Postgres RLS, append-only and privilege-pin suite ran in CI).
- **test:db** is NOT RUN in the collector: the database and client tools were passed in, but the suite also needs an
  S3 endpoint (`RATIO_EVIDENCE_S3_ENDPOINT`), which this container lacks; the collector says exactly that. Locally,
  `connections.db.test.ts` passed 9/9 against the same throwaway PostgreSQL 16.
- **Logs:** outside git; their sha256 and last 40 lines are in the evidence files.
