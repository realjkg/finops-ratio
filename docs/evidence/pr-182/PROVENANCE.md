# How this evidence was produced

- **Attested code SHA:** `4d313554ab80250d34f71341329a1952902f469b` (PR #182), against base `6c809af` (main).
- **Collector:** `scripts/evidence/collect-pr-evidence.mjs` at that same SHA (this PR adds its platform section).
- **Exact command**, in a clean clone at the attested SHA, Linux container, Node v22.23.4:

  ```
  RATIO_EVIDENCE_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
    node scripts/evidence/collect-pr-evidence.mjs --base origin/main --head 4d313554ab80250d34f71341329a1952902f469b --pr 182 --logs ../sa1-ev182-logs
  ```

  The run exited 0. `evidence.md` and `evidence.json` are committed exactly as generated, unedited:
  - `evidence.md` sha256: `f70d72f6b784723a810d8fbe08a0045746d604b42f809a260ef2c2e2f0fb495b`
  - `evidence.json` sha256: `22d3a40dd7fd0b633a1cce69205348c47e1dbf2f4441c58b857b63600a1b858a`
- **Charter item 1 is NOT RUN** only because `npm run test:db` needs Postgres 16, an S3 endpoint and PG client tools,
  which this container does not provide; GitHub CI ("Lint · Typecheck · Test · Build", which runs `test:db`) passed
  on the same SHA.
- **Earlier runs, not used:** one was stopped by a container restart; one at `ec778bb` was stopped because CodeQL then
  required the fix in `4d31355`; one at `4d31355` finished with 2–3 timing tests failing (`redact.test.ts` "stays
  linear…", `hostileWatchdog.test.ts`, a 5 s timeout) on both the PR tree and the rolled-back base tree while other
  sessions' suites loaded the shared 4-core host (load average ~9); one was ended by an external SIGTERM. This run is
  the first complete one on a quieter host; all its gates passed or are listed as NOT RUN / N/A.
- **Logs:** outside git; their sha256 and last 40 lines are in the evidence files.
