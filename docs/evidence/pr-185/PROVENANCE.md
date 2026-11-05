# How this evidence was produced

- **Attested code SHA:** `cc844cc70b9d5b77836072d4e66a28ef4dc7c6ac` (PR #185), against base `6c809af` (main).
- **Collector:** `scripts/evidence/collect-pr-evidence.mjs` from PR #182 (branch `claude/platform-a0-evidence-manifest`)
  at commit `2161173`, run from that separate checkout with this checkout as the working directory (the pattern of
  `docs/evidence/pr-179`). That version writes an `evidence.md` that passes `git diff --check` and adds the
  non-gating platform section (N/A here: this branch has no manifest).
- **Exact command**, in a clean clone at the attested SHA, Linux container, Node v22.23.4:

  ```
  RATIO_EVIDENCE_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
    node ../sa1/scripts/evidence/collect-pr-evidence.mjs --base origin/main --head cc844cc70b9d5b77836072d4e66a28ef4dc7c6ac --pr 185 --logs ../sa1-ev185-logs
  ```

  The run exited 1. `evidence.md` and `evidence.json` are committed exactly as generated, unedited:
  - `evidence.md` sha256: `acfd6bf96338706e8c7d050e3e90161c0fa4613cfc3599f78e68b91d97448618`
  - `evidence.json` sha256: `e86c59335bdcf36a5690c2dda19d37da80ef07454ed4a516012a11b728ce6d9b`
- **Why charter item 1 is FAIL, and why that is not this PR's code:** the unit-test gate failed 2 of 5208 tests, both
  timing bounds in files this PR does not touch: `src/reports/engagementReportPdf.test.tsx` (hostile input "renders
  within 15 s", killed by its watchdog) and `src/connectors/managed/evidence/redact.test.ts` ("finishes 1 MB hostile
  inputs in under a second"). The shared 4-core host ran other sessions' suites at the same time (load average 8–9).
  - Re-run of those two files at the same SHA, same checkout: `npx vitest run --cache=false <both files>` -> 2 files,
    37 tests passed.
  - A second full run at the same SHA (not committed) failed 2 different timing tests (the PDF watchdog again and
    `boundary.test.ts` "no file Next can bundle…", a 5 s timeout; it passes alone: 15 of 15 with the import and
    dependency boundary files), and its rollback check failed 5 timing tests **on the rolled-back tree, which is
    main** (`src/evidence/evidence.test.ts` "handles a 250k-line bill", among others). So these failures belong to the host.
  - GitHub CI on the same SHA `cc844cc`: every check success, including "Lint · Typecheck · Test · Build" (full
    vitest and `npm run test:db`, so the new Postgres RLS suite too).
- **test:db** is NOT RUN here (no S3 endpoint). Locally, `connections.db.test.ts` and the migrate, tenancy,
  privileges and schema DB suites passed against a throwaway PostgreSQL 16.15 (`docs/evidence/platform-a1/green.txt`).
- **Logs:** outside git; their sha256 and last 40 lines are in the evidence files.
