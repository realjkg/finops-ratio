# How this evidence was produced

- **Attested code SHA:** `cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa` (PR #179), against base `f7108e3` (main).
- **Collector:** `scripts/evidence/collect-pr-evidence.mjs` from PR #180 (branch `claude/pr-evidence-tooling`) at commit `d54f3b3`. It was run from that separate checkout with this checkout as the working directory, which is why `evidence.md` names `scripts/evidence/…` although #179 does not contain the script.
  - script sha256: `65a0f4915ea9a2ae39bc1728ed285fd2d7cc7652b41de1087679dd64c19c09fe`
  - lib sha256: `d07689e9cd0e9e623914e5b07cd6bcd485d877b5377a2c2e82fd38c66cb9b57f`
  - Newer collectors (#180 from `d915a5f`) record this provenance inside `evidence.md` themselves.
- **Exact command**, in a clean checkout at the attested SHA, in a Linux container:

  ```
  RATIO_EVIDENCE_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
    node ../ui4/scripts/evidence/collect-pr-evidence.mjs --base f7108e3 --head cbe5280768ee3ce43bb81004d4bd2bd09c69e3fa --pr 179 --logs ../ui3-evidence-logs
  ```

  The run exited 0.
- **Files:** `evidence.md` and `evidence.json` are committed exactly as generated, unedited:
  - `evidence.md` sha256: `048111fabaf7f33222d2b9a4e1f17764e7a4520de66f55c94c21907a44d2a1d1`
  - `evidence.json` sha256: `73556c76eeeceab9281fe323740524feec88bad5138a8ac60a92c128b03e9f3b`
- **Logs:** the full logs stay outside git. Their sha256 and last 40 lines are in the evidence files.
- **Re-run on a Mac**, with the Postgres and S3 database gates, after #180: `./scripts/evidence/mac-evidence.sh --pr 179 --head <head>`.
