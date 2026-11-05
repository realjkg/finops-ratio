# How this evidence was produced

- **Attested SHA:** `09f0c6ebf61440eb7586a6acf12e6d977743eb06` (PR #182, review round: code at `6eac832` plus its
  red/green notes), against base `6c809af` (main). It replaces the evidence for `2161173` (commit `8ed8781`).
- **Collector:** `scripts/evidence/collect-pr-evidence.mjs` at that same SHA.
- **Exact command**, in a clean clone at the attested SHA, Linux container, Node v22.23.4:

  ```
  RATIO_EVIDENCE_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
  RATIO_EVIDENCE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55434/postgres \
  RATIO_EVIDENCE_PG_DUMP=/usr/lib/postgresql/16/bin/pg_dump RATIO_EVIDENCE_PSQL=/usr/lib/postgresql/16/bin/psql \
    node scripts/evidence/collect-pr-evidence.mjs --base origin/main --head 09f0c6ebf61440eb7586a6acf12e6d977743eb06 --pr 182 --logs ../../sa2-ev182-logs
  ```

  The run exited 0. `evidence.md` and `evidence.json` are committed exactly as generated, unedited:
  - `evidence.md` sha256: `a7dac69567c107587e15129f8a74b154b2ba392d27f1f07b7753a18a6e3e2f16`
  - `evidence.json` sha256: `19a0581700af8bbeeaf83981e8e4db6d5ee33f8959b8f39599ec37cce53f3bb7`
- **Charter item 1 is NOT RUN** only because of `npm run test:db`: a throwaway local PostgreSQL 16 and its client tools
  were passed in, but the suite also needs an S3 endpoint (`RATIO_EVIDENCE_S3_ENDPOINT`), which this container does
  not have; the collector says exactly that. GitHub CI ("Lint · Typecheck · Test · Build", which runs `test:db`)
  passed on the same SHA.
- **Logs:** outside git; their sha256 and last 40 lines are in the evidence files.
