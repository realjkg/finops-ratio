# Merge evidence on a Mac

## Quick start

1. Install the prerequisites:
   - Xcode Command Line Tools: `xcode-select --install`
   - Node 22.13 or later: `brew install node@22`, or `nvm install 22`
   - For the database gates:
     - Docker Desktop, Colima or OrbStack, running
     - the Postgres 16 client tools: `brew install postgresql@16`
2. Get the repository: `git clone https://github.com/realjkg/finops-ratio && cd finops-ratio`. In an existing clone, run `git pull` instead.
3. Run the one command:

   ```bash
   ./scripts/evidence/mac-evidence.sh --pr 179
   ```

   - To pin the commit you expect, add `--head <sha>`.
   - To check the setup without running anything, add `--dry-run`. It runs the preflight checks and prints the plan.
4. Wait about 15–25 minutes. The script works in a temporary folder and removes it at the end; add `--keep` to keep it. It also stops the containers it started.
5. Find the output in `~/ratio-evidence/pr-179/<head sha>/`:
   - `evidence.md`, which opens automatically
   - `evidence.json`
6. Send it back: attach both files to the PR, or paste the summary table the script prints as a PR comment.

The script installs nothing on its own and needs no secret or token; `gh` is optional. Each database password is random, used once and never printed. The challenger review and the merge decision always stay `PENDING (orchestrator)`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node >= 22.13 required` | Run the command the script prints (`nvm install 22 && nvm use 22`, `fnm install 22`, or `brew install node@22 && brew link --overwrite node@22`), open a new terminal and run again. |
| `database gates: NOT RUN (no Docker …)`, or `docker could not start Postgres` | Start Docker Desktop, Colima (`colima start`) or OrbStack and wait until `docker info` works. If `test:db` stays NOT RUN with "PG16 client tools", run `brew install postgresql@16`. To run without a database on purpose, use `--no-db`; the gap is recorded. |
| Port already in use | The script picks free ports itself. If something grabs a port in between, run it again. A leftover container from an interrupted run is named `ratio-evidence-pg-<pr>-…` or `ratio-evidence-s3-<pr>-…`; remove it with `docker rm -f -v <that exact name>`. |
| `Playwright Chromium download failed` | The browser download was blocked (VPN, proxy or firewall). Allow `playwright.azureedge.net` and `playwright.download.prss.microsoft.com`, or set `RATIO_EVIDENCE_CHROMIUM=/path/to/Chromium` (`…/Chromium.app/Contents/MacOS/Chromium`). Until then the browser gates are recorded NOT RUN, never PASS. |
| `disk: need >= 5 GB free` | Free space, or point `TMPDIR` at a larger volume: `TMPDIR=/Volumes/Data/tmp ./scripts/evidence/mac-evidence.sh --pr 179`. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every required gate passed (NOT RUN items are listed as known gaps) |
| 1 | A gate or check failed |
| 2 | Usage error |
| 3 | Preflight or setup failed |
| 4 | The PR or a commit could not be resolved |
