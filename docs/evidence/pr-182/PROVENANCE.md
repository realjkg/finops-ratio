# How this evidence was produced

- **Attested code SHA:** `2161173f442c595d67c21f2ec5c25a3accca8fbe` (PR #182), against base `6c809af` (main). It
  replaces the evidence of commit `35365aa` (which attested `4d31355`): the renderer fix in `2161173` makes the
  generated `evidence.md` pass `git diff --check`.
- **Collector:** `scripts/evidence/collect-pr-evidence.mjs` at that same SHA (this PR adds its platform section).
- **Exact command**, in a clean clone at the attested SHA, Linux container, Node v22.23.4:

  ```
  RATIO_EVIDENCE_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
    node scripts/evidence/collect-pr-evidence.mjs --base origin/main --head 2161173f442c595d67c21f2ec5c25a3accca8fbe --pr 182 --logs ../sa1-ev182-logs
  ```

  The run exited 0. `evidence.md` and `evidence.json` are committed exactly as generated, unedited:
  - `evidence.md` sha256: `04ce56cfe60d40b17d00b4dc52c2585a609411f090bca8a9328d497011a627ca`
  - `evidence.json` sha256: `743b7a760be5ef85d9521ae359cdf4a47f15e95de05dc93bbec6667520a3e339`
- **Charter item 1 is NOT RUN** only because `npm run test:db` needs Postgres 16, an S3 endpoint and PG client tools,
  which this container does not provide; GitHub CI ("Lint · Typecheck · Test · Build", which runs `test:db`) runs it
  on the PR head.
- **Earlier runs, not used:** one was stopped by a container restart; one at `ec778bb` was stopped because CodeQL then
  required the fix in `4d31355`; one at `4d31355` finished with 2–3 timing tests failing (`redact.test.ts` "stays
  linear…", `hostileWatchdog.test.ts`, a 5 s timeout) on both the PR tree and the rolled-back base tree while other
  sessions' suites loaded the shared 4-core host (load average ~9); one was ended by an external SIGTERM; one complete
  run at `4d31355` (exit 0) was superseded by the renderer fix.
- **Logs:** outside git; their sha256 and last 40 lines are in the evidence files.
