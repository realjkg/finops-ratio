# Merge evidence on a Mac

## Quick start

1. Install the prerequisites:
   - Xcode Command Line Tools: `xcode-select --install`
   - Node 22.13 or later: `brew install node@22`, or `nvm install 22`
   - For the database gates:
     - Docker Desktop, Colima or OrbStack, running
     - the Postgres 16 client tools: `brew install postgresql@16`
2. Get the repository: `git clone https://github.com/realjkg/finops-ratio && cd finops-ratio`. In an existing clone, run `git pull`.
3. Run the one command:

   ```bash
   ./scripts/evidence/mac-evidence.sh --pr 179
   ```

   - `--head <sha>` (at least 12 hex characters) pins the commit you expect.
   - `--dry-run` only checks the machine and prints the plan.
   - `--migration-smoke` adds the full migration down/up check (informational).
4. Wait about 15–25 minutes. The script removes its temporary folder and the containers it started; `--keep` keeps the folder.
5. Find the output in `~/ratio-evidence/pr-179/<head sha>/`: `evidence.md`, which opens automatically, and `evidence.json`.
6. Send it back: attach both files to the PR, or paste the summary table the script prints as a PR comment.

It installs nothing silently, needs no secret or token, and sends no telemetry. `gh` is optional.

### What the run touches on your Mac

| Location | What and when |
|---|---|
| `$TMPDIR/ratio-evidence-pr<n>.XXXXXX/` | The clone, logs, the evidence and the tests' temporary files: the collector runs with `TMPDIR=<workspace>/tmp`, so the **rollback worktree** (`<workspace>/tmp/ratio-evidence-rollback-*`) lives here too. Removed at the end. |
| `/tmp/rpe.XXXXXX` | A short temporary directory for the Playwright gates only. Chromium's socket path must fit macOS's 104-byte limit, which a path inside the workspace would exceed. Removed by exact path at the end, also on Ctrl-C, and by the script if the collector is killed. |
| `~/ratio-evidence/pr-<n>/<sha>/` | The copy of `evidence.md` and `evidence.json`. Kept. |
| `~/.npm` | npm's download cache, filled by `npm ci`. Kept. |
| `~/Library/Caches/ms-playwright` | The pinned Chromium from `npx playwright install chromium`. Kept. Downloaded from `cdn.playwright.dev` or `playwright.download.prss.microsoft.com`. |
| Docker | The two pinned images (`postgres:16@sha256:1a6a…`, `chrislusf/seaweedfs@sha256:4e61…`) are pulled from Docker Hub if missing and **kept** in Docker's image store; remove them with `docker image rm` if you want. |
| Docker containers | Two containers, `ratio-evidence-pg-<pr>-<hex>` and `ratio-evidence-s3-<pr>-<hex>`, removed at the end (also on Ctrl-C). |

The database containers are **local only and ephemeral**:
- They listen on random ports on `127.0.0.1` only, so nothing outside the Mac can reach them.
- Their data lives in memory (tmpfs) and disappears with the container.
- Postgres uses **trust authentication with no password**, exactly as CI does. The database tests need that: they create password-less login roles.

Inherited variables are dropped before anything runs:
- every `RATIO_*` variable you have exported, except `RATIO_EVIDENCE_HOME` and `RATIO_EVIDENCE_CHROMIUM`;
- every libpq `PG*` variable (`PGHOST`, `PGUSER`, `PGPASSWORD`, …).

The collector also runs the PR's code with a small environment allowlist:
- PATH, HOME, TMPDIR, locale, CI and proxy/CA variables, including `ALL_PROXY`;
- npm's registry/CA/proxy/TLS settings, but never npm credentials;
- `NODE_OPTIONS` is deliberately excluded, because it can preload arbitrary code.

As a result, no app database URL or token from your shell can reach the run.

Down-migrations only ever run against a throwaway `ratio_evidence_*` database:
- on a loopback host (`127.0.0.1`, `localhost` or `::1`);
- with no `host`/`hostaddr`/`port`/`dbname`/`service` override in the URL;
- never when `RATIO_ENV` or `NODE_ENV` is production.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `node >= 22.13 required` | Run the command the script prints (`nvm install 22 && nvm use 22`, `fnm install 22`, or `brew install node@22 && brew link --overwrite node@22`), open a new terminal and run again. |
| `database gates: NOT RUN (no Docker …)`, `docker could not start Postgres`, or `could not pull` | Start Docker Desktop, Colima (`colima start`) or OrbStack and wait until `docker info` works. A pull failure means Docker Hub is blocked or rate-limited: retry later. If `test:db` stays NOT RUN with "PG16 client tools", run `brew install postgresql@16`. `--no-db` runs without a database on purpose; the gap is recorded. |
| Port already in use | Ports are picked at random. If one is taken in between, run again. A container left by a killed run is named `ratio-evidence-pg-<pr>-…` or `ratio-evidence-s3-<pr>-…`; remove it with `docker rm -f -v <that exact name>`. If the collector says a rollback worktree is still registered, run the `git worktree remove --force …` command it prints. |
| `Chromium did not launch` (browser gates NOT RUN) | The collector launches Chromium once before the browser gates and records why it failed (see the "Chromium launch preflight" row in evidence.md). Usually a blocked or partial download: run `npx playwright install chromium` again in the workspace (`--keep`), or set `RATIO_EVIDENCE_CHROMIUM`. |
| `Playwright Chromium download failed` | VPN, proxy or firewall: allow `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`, or set `RATIO_EVIDENCE_CHROMIUM=/path/to/Chromium.app/Contents/MacOS/Chromium`. Until then the browser gates are NOT RUN, never PASS. |
| `disk: need >= 5 GB free` | Free space, or use a larger volume: `TMPDIR=/Volumes/Data/tmp ./scripts/evidence/mac-evidence.sh --pr 179`. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every required gate passed; NOT RUN items are listed as known gaps |
| 1 | A gate or check failed |
| 2 | Usage error |
| 3 | Preflight or setup failed |
| 4 | The PR or a commit could not be resolved |
