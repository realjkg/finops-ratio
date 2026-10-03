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

Low allow-list: `docs/**/*.{md,png,svg}` (images only when GitHub serves a
patch, so in practice Markdown), `*.md`, `src/components/**/*.{ts,tsx,js,jsx,css}`
and `*.test.*` outside `pages/` and `src/pages/`. Everything under `pages/` and
`src/pages/` is restricted (`routes`): Next.js builds any file there, including
`*.test.ts`, into a production route.

## Merge eligibility

Auto-merge (squash, pinned to the evaluated head SHA) is enabled only when
**all** hold, otherwise it is disabled and the job summary says why:

- Same-repo PR (not a fork) by an `OWNER`, `MEMBER` or `COLLABORATOR`.
- Label `risk:low` **and** a fresh low classification of the current files.
- Not a draft; base is `main`.
- The check run `Lint · Typecheck · Test · Build` from the GitHub Actions app
  (id 15368) from a run of `.github/workflows/ci.yml` succeeded. Same-named
  checks from other workflows or apps don't count, and neither do commit
  statuses.
- Every other check run (except this workflow's eligibility jobs) succeeded,
  and every commit status is `success`.
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
- **Copilot completion may be detected late.** It is detected through
  `workflow_run` (if GitHub emits it for the dynamic Copilot workflow) or the
  30-minute scheduled sweep.
- **Some settings can't be read with GITHUB_TOKEN.** It cannot read classic
  branch protection details. The report shows the branch `protected` flag and
  any ruleset required checks (`GET /rules/branches/main`).
- **Some settings need an admin.** Branch protection and "Allow auto-merge"
  need an admin to run `protect-main.mjs`. If auto-merge is not allowed, the
  eligibility summary reports a CONFIGURATION GAP and the job stays green.
- **Not detected:** hostnames written without a URL scheme, and egress hidden
  behind indirection, such as a helper that wraps `fetch` defined in an
  already-merged file.
- **Some rules are noisy.** The `auth|tenant|rls|role` filename rule matches
  e.g. `urls.ts`.
