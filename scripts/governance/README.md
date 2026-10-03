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
- Every check run returned for the head SHA succeeded. No run is collapsed by
  name, in any suite (the API's `filter=latest` already returns the latest run
  per suite). No check run is excluded by name: the governance jobs run on
  base-context events, so their check runs are not on the PR head SHA.
- Every commit status is `success`, except our own `Governance · merge
  eligibility` status, which is an output of this decision and is ignored.
- A submitted review by `copilot-pull-request-reviewer[bot]` (type `Bot`) on
  the exact head SHA. The repository does not re-request review on push, so
  **a fresh Copilot review on the new head is required after each push**.
- Zero unresolved review threads.
- The head SHA did not move during evaluation.

## Required eligibility status and the exception queue

The eligibility job posts the commit status `Governance · merge eligibility` on
the head SHA it evaluated. Branch protection requires this status
(`protect-main.mjs`), so a writer who enables GitHub's native auto-merge by
hand still cannot merge past the gate.

| State | When |
| --- | --- |
| `success` | An eligible low-risk PR (all of the above), or a restricted PR with a valid exception approval (below). |
| `failure` | Otherwise. The description is the top blocking reason (≤140 characters). An evaluation error also posts `failure`. |
| `pending` | The head moved during evaluation. The job turns auto-merge off and posts `pending` on the new head, then defers. |

Our own previous eligibility status is ignored when evaluating, because it is
an output, not an input.

**Exception queue (restricted PRs).** The orchestrator or owner posts
`/exception-approve <sha>` after the independent review evidence is recorded.
A restricted PR can only merge when both of the following hold:

- There is a PR comment whose **first line** (trimmed) is exactly
  `/exception-approve <40-hex SHA>`, where the SHA is the PR's current head.
  Later lines are free text: put the link to the challenger review evidence
  there. The comment must be:
  - by a user with **admin or maintain** permission (checked with
    `getCollaboratorPermissionLevel`, using `role_name` or `permission`);
  - never edited (`updated_at === created_at`);
  - not bot-authored.

  All comments are read, across pages.
- No revocation exists for that SHA (see "Sticky revocation" below).
- Every non-risk condition holds: genuine CI on every qualifying run, a Copilot
  review on the head, zero unresolved threads, a same-repo PR by an
  OWNER/MEMBER/COLLABORATOR, no other open PR with the same head, not a draft,
  base `main`.

No timestamps are compared. The approval binds to content (the commit SHA),
so a new head simply has no approval. A force-push back to a previously
approved SHA is approved again, unless that SHA was revoked, because it is the
same reviewed content. The workflow never enables auto-merge for restricted
PRs; merge manually once the status is green.

**Sticky revocation.** Writers can edit or delete other users' comments, so a
revoke comment alone is not durable. Each of these counts as a revocation of
the SHA it names, when the command comes from an admin/maintain user:

- a `/exception-revoke <sha>` comment;
- an approve comment naming the head that has been **edited**;
- the original body of an admin/maintain command comment that the triggering
  `issue_comment` event **edited or deleted**. The body is taken from
  `changes.body.from`, or from the deleted comment.

The first evaluation that sees a revocation posts a `failure` commit status,
context `Governance · exception revoked`, on that SHA. Its description is
"exception revoked by @user in comment <id>". Statuses cannot be deleted. From
then on, approval for that SHA is permanently refused, whatever happens to the
comments.

Only revocation statuses created by `github-actions[bot]` are honoured, and
that context is excluded from the generic "every status is success" rule. A
writer therefore cannot block a PR by forging a revocation status. Any other
failing status they post still blocks, just as a failing CI run would.

Residual risk: a revoke comment that is edited or deleted before any
evaluation has run is still caught, through the edited/deleted event's old
body. It would be lost only if that event's workflow run also failed. The
30-minute sweep cannot recover a deleted revoke.

**When evaluation runs on comments.** `issue_comment` events (`created`,
`edited`, `deleted`) re-evaluate the PR immediately. The `targets` and
`merge-eligibility` jobs only run when:

- the issue is a PR;
- the comment body, or for an edit its previous body, starts with
  `/exception-`;
- the comment author's association is OWNER, MEMBER or COLLABORATOR.

Other comments are ignored. Every other trigger is unaffected.

**Who approves.** The owner has delegated merging restricted code, including
migrations, deployment and retention-class code, to the orchestrator.

- Approvals may be posted by the owner account the orchestrator acts through.
- Separation of duties comes from the independent challenger review recorded
  in the PR.
- Every approval comment must link that evidence. The gate does not parse the
  link; it is the audit trail.
- The non-delegable human gate is the **production environment** (deploys,
  production data deletion). It will be enforced by a GitHub Environment with
  required reviewers once one exists.

**Required checks are pinned to the GitHub Actions app.** `protect-main.mjs`
sets `app_id: 15368` on all three required checks: CI,
`Governance · risk classification` and `Governance · merge eligibility`. A
status posted with a personal access token or another app is therefore
rejected. Residual risk: any workflow on any branch with `statuses: write` runs
as the same app via `GITHUB_TOKEN` and could post these statuses. Only a
ruleset required-workflow or a dedicated GitHub App closes that. Workflow
changes are classified restricted, but that is detection, not prevention.

The classification status is informational. It is always `success` and never
gates on risk; eligibility re-classifies the PR itself.

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
  need an admin to run `protect-main.mjs`. It applies branch protection first
  and only then allows auto-merge, stops at the first failed request, and exits
  non-zero. If auto-merge is not allowed, the
  eligibility summary reports a CONFIGURATION GAP and emits a warning
  annotation; the job stays green.
- **Assumption: an Actions job id equals its check run id.** This holds on
  GitHub today. If it changed, CI would never verify, so nothing would be
  auto-merged (fail closed).
- **Some rules are noisy.** The `auth|tenant|rls|role` filename rule matches
  e.g. `urls.ts`.
