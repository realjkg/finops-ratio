# Governance: PR risk gate

Classifies every PR as `risk:low` or `risk:restricted`, writes an exception
report for restricted PRs, and enables squash auto-merge only for low-risk PRs
that pass every gate. Changes to anything in this directory, or to
`.github/**`, are themselves restricted (`deployment`, self-protection).

| File | Role |
| --- | --- |
| `risk-rules.json` | Reviewable rules (data). |
| `classify-risk.mjs` | Classifier + CLI (`node classify-risk.mjs --git origin/main...HEAD`). |
| `eligibility.mjs` | Pure merge-eligibility decision. |
| `report.mjs` | Exception report + label diff. |
| `gh-actions.mjs` | GitHub API glue called by `.github/workflows/governance.yml`. |
| `protect-main.mjs` | Applies branch protection (admin token; `--dry-run` prints payloads). |

## What "low" means

**"Low" means heuristically low, not proven safe.** The rules are path globs
and regexes over added diff lines. They fail closed: anything not on the low
allow-list is restricted, as is any diff the classifier cannot inspect (binary,
too large, truncated file list). A determined author can still write harmful
code that matches no pattern. Low-risk auto-merge relies on CI, the independent
review and resolved conversations as well, not on the classifier alone.

Examples the patterns do NOT catch (egress assembled at runtime or hidden in
markup):

- `window["Web"+"Socket"]` (no literal `WebSocket(` / `new WebSocket`)
- `` <img src={`//evil`}> `` (a template literal, not a quoted `'//`/`"//`)
- a helper that wraps `fetch` defined in an already-merged file
- hostnames written without a URL scheme

Also restricted regardless of path:

- Files that are not regular files: any git mode other than `100644` or
  `100755` (rule `unusual-mode`; covers gitlinks `160000` and symlinks
  `120000`, which also get rule `symlink`). In Actions, modes come from the head commit's recursive git tree
  (`git.getTree(head.sha, recursive)`). If that tree is truncated or
  unavailable, modes are unknown and the PR is restricted (`tree-truncated` /
  `tree-unavailable`).
- Any file without a patch that is not a removal, including pure renames.
- Agent instruction and policy files:
  - `agents.md`, `claude.md`, `gemini.md`, `copilot-instructions.md`,
    `skill.md` and `conventions.md` in any directory, matched
    case-insensitively;
  - `.obvious/**`, `.claude/**`, `.cursor/**`, `.cursorrules`, `.windsurf/**`
    and `.github/copilot*`.

Low allow-list: `docs/**/*.{md,png,svg}` (images only when GitHub serves a
patch, so in practice Markdown), `*.md` outside any dot-directory (Markdown in
`.continue/`, `.roo/`, `.kiro/`, `.junie/`, ... fails closed), `src/components/**/*.{ts,tsx,js,jsx,css}`
and `*.test.*` outside `pages/` and `src/pages/`. Everything under `pages/` and
`src/pages/` is restricted (`routes`): Next.js builds any file there, including
`*.test.ts`, into a production route.

## Merge eligibility

Auto-merge (squash, pinned to the evaluated head SHA) is enabled only when
**all** hold, otherwise it is disabled and the job summary says why:

- Same-repo PR (not a fork) by an `OWNER`, `MEMBER` or `COLLABORATOR`.
- Label `risk:low` **and** a fresh low classification of the current files.
- Not a draft; base is `main`.
- CI, verified through the Actions jobs API:
  - The newest `pull_request` run of `.github/workflows/ci.yml` for the head
    SHA whose `pull_requests` include THIS PR with base `main` are found. All
    of them are checked, not just the newest, and each must have a successful
    CI job on its latest attempt. Runs for another PR or base are ignored.
    With no qualifying run, the PR is not eligible.
  - If any other open PR has the same head SHA, the PR is not eligible
    ("head SHA shared with PR #n").
  - Its jobs in the latest attempt (`filter=latest`, matching `run_attempt`)
    are listed. The job named exactly `Lint · Typecheck · Test · Build` must
    have concluded `success`, and its check run must be on the head SHA.
  - Every check run on the head SHA with that name must be one of those job
    ids (an Actions job id is its check run id). Anything else with the name
    is a spoof and blocks.
  - Commit statuses never satisfy CI.
- Every other check run succeeded (CI-named runs are never deduplicated). Every
  commit status is `success`. Nothing is excluded by name: the governance jobs
  run on base-context events, so their check runs are not on the PR head SHA.
- A submitted review by `copilot-pull-request-reviewer[bot]` (type `Bot`) on
  the exact head SHA. The repository does not re-request review on push, so
  **a fresh Copilot review on the new head is required after each push**.
- Zero unresolved review threads.
- The head SHA did not move during evaluation.

The required status `Governance · risk classification` is a commit status
posted by the classify job, accepted from any app. That is safe because it is
always `success` (it reports, it never gates on risk), and eligibility
re-classifies the PR itself, so a spoofed status cannot make a restricted PR
auto-mergeable.

## Known limitations (documented, not fixed)

- **GITHUB_TOKEN merges do not trigger push workflows.** A PR merged by
  auto-merge enabled with `GITHUB_TOKEN`, or by the "already clean" fallback,
  does not trigger `on: push` workflows on `main` (e.g. CI on main). Recommended
  later: a GitHub App installation token for the eligibility job.
- **Before merge, the gate does nothing.** `pull_request_target` runs main's copy
  of the workflow, so the gate starts working only after it is on `main`, and
  it cannot classify its own PR.
- **Copilot completion is picked up by the sweep (L2).** The scheduled
  30-minute sweep is the mechanism. `workflow_run` listens to `CI` only,
  because the Copilot review is a dynamic workflow: "Running Copilot Code
  Review" is a run title, not a workflow name, and it is not expected to emit
  `workflow_run`.
- **A PR that falls behind `main` stalls (L5).** `protect-main.mjs` sets
  `strict: true` (branches must be up to date), and nothing here updates a PR
  branch that is behind `main`. Such a PR stalls until someone clicks
  "Update branch" or merges `main` into it. After that, CI and a fresh Copilot
  review must run again on the new head.
- **Permissions and matrix cap (L6).**
  - `classify`: contents read, pull-requests/issues/statuses write.
  - `targets`: contents and pull-requests read.
  - `merge-eligibility`: contents and pull-requests write (auto-merge, and the
    squash fallback); checks, statuses and actions read.
  - GitHub matrices cap at 256 legs, so `targets` caps the list at 200 PRs and
    warns. PRs are sorted newest updated first. Each sweep evaluates a window of
    200 that rotates by sweep slot: offset = (minute-of-day / 30) × 200, modulo
    the PR count, wrapping around. Successive sweeps therefore cover every open
    PR.
- **Some settings can't be read with GITHUB_TOKEN.** It cannot read classic
  branch protection details. The report shows the branch `protected` flag and
  any ruleset required checks (`GET /rules/branches/main`).
- **Some settings need an admin.** Branch protection and "Allow auto-merge"
  need an admin to run `protect-main.mjs`. If auto-merge is not allowed, the
  eligibility summary reports a CONFIGURATION GAP and emits a warning
  annotation; the job stays green.
- **Assumption: an Actions job id equals its check run id.** This holds on
  GitHub today. If it changed, CI would never verify, so nothing would be
  auto-merged (fail closed).
- **Some rules are noisy.** The `auth|tenant|rls|role` filename rule matches
  e.g. `urls.ts`.
