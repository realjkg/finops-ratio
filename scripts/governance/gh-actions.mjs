// GitHub-facing glue for .github/workflows/governance.yml, invoked from
// actions/github-script with its injected { github, context, core }.
// The workflow checks this file out from the BASE commit (never the PR head),
// so a PR cannot change the code that classifies it.
import { classify } from './classify-risk.mjs';
import {
  decideEligibility, decideMergeStatus, evaluateExceptionApproval, parseExceptionCommand, outsiderReason, isApproverRole,
  isGovernanceCandidateRun,
  DEFAULT_CONFIG, ELIGIBILITY_CONTEXT, REVOKED_CONTEXT, ACTIONS_BOT_LOGIN,
} from './eligibility.mjs';
import { REPORT_MARKER, buildReport, desiredLabels, labelChanges } from './report.mjs';

const MAX_LISTED_FILES = 3000; // GitHub's hard cap for pulls.listFiles
const BOT_LOGIN = 'github-actions[bot]';
const CLASSIFY_CONTEXT = 'Governance · risk classification';

const LABEL_COLORS = { 'risk:low': '0e8a16', 'risk:restricted': 'b60205' };

const AUTO_MERGE_NOT_ALLOWED = /auto.?merge is not allowed|allow_auto_merge|auto.?merge (?:is )?disabled for this repository/i;

/** Changed files of a PR in classifier input shape (+ truncation flag). */
export async function fetchChangeSet(github, repo, pr) {
  const raw = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 });
  const files = raw.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename,
    patch: f.patch,
    // GitHub omits `patch` for large files and for anything it deems binary —
    // including a source file with a NUL byte (changes: 0), renamed or not.
    // Content rules cannot see those, so anything but a removal is
    // uninspectable. Pure renames are restricted too (fail closed).
    patchUnavailable: f.patch === undefined && f.status !== 'removed',
  }));
  const truncated = raw.length >= MAX_LISTED_FILES || (typeof pr.changed_files === 'number' && raw.length < pr.changed_files);
  return { files, truncated };
}

/**
 * Attach git file modes (from the head commit's recursive tree) to the changed
 * files, so symlinks (mode 120000) are restricted. A truncated tree or an API
 * error leaves modes unknown, which the classifier treats as restricted.
 */
export async function attachModes(github, repo, headSha, changeSet) {
  let data;
  try {
    ({ data } = await github.rest.git.getTree({ ...repo, tree_sha: headSha, recursive: 'true' }));
  } catch {
    return { ...changeSet, treeStatus: 'unavailable' };
  }
  if (data.truncated) return { ...changeSet, treeStatus: 'truncated' };
  const modes = new Map((data.tree ?? []).map((t) => [t.path, t.mode]));
  return {
    ...changeSet,
    treeStatus: 'ok',
    files: changeSet.files.map((f) => (modes.has(f.path) ? { ...f, mode: modes.get(f.path) } : f)),
  };
}

/**
 * What GITHUB_TOKEN can see about main's protection: the branch `protected`
 * flag, plus required status checks from the branch RULES API (rulesets).
 */
export async function mainProtection(github, repo, branch = 'main') {
  let out;
  try {
    const { data } = await github.rest.repos.getBranch({ ...repo, branch });
    out = { protected: Boolean(data.protected) };
  } catch (e) {
    return { error: `HTTP ${e.status ?? '?'}` };
  }
  try {
    const rules = github.rest.repos.getBranchRules
      ? await github.paginate(github.rest.repos.getBranchRules, { ...repo, branch, per_page: 100 })
      : (await github.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', { ...repo, branch })).data;
    out.rulesRequiredChecks = rules
      .filter((r) => r.type === 'required_status_checks')
      .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context));
  } catch (e) {
    out.rulesError = `HTTP ${e.status ?? '?'}`;
  }
  return out;
}

async function ensureLabel(github, repo, name) {
  try {
    await github.rest.issues.getLabel({ ...repo, name });
  } catch (e) {
    if (e.status !== 404) throw e;
    await github.rest.issues.createLabel({
      ...repo,
      name,
      color: LABEL_COLORS[name] ?? 'd93f0b',
      description: 'Set by the Governance workflow (scripts/governance/risk-rules.json)',
    });
  }
}

export async function syncLabels(github, repo, pr, result) {
  const current = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  const { add, remove } = labelChanges(current, desiredLabels(result));
  for (const name of add) await ensureLabel(github, repo, name);
  if (add.length) await github.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: add });
  for (const name of remove) {
    try {
      await github.rest.issues.removeLabel({ ...repo, issue_number: pr.number, name });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return { add, remove };
}

/**
 * Single upserted report comment, found by hidden marker AND authored by the
 * Actions bot (a marker pasted by anyone else is ignored). Low-risk PRs only
 * update an existing comment (so a stale exception report is corrected) and
 * never create one.
 */
export async function upsertReportComment(github, repo, prNumber, body, { createIfMissing }) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: prNumber, per_page: 100 });
  const mine = comments.find((c) => c.user?.login === BOT_LOGIN && typeof c.body === 'string' && c.body.includes(REPORT_MARKER));
  if (mine) {
    if (mine.body !== body) await github.rest.issues.updateComment({ ...repo, comment_id: mine.id, body });
    return mine.body === body ? 'unchanged' : 'updated';
  }
  if (!createIfMissing) return 'none';
  await github.rest.issues.createComment({ ...repo, issue_number: prNumber, body });
  return 'created';
}

async function disableAutoMerge(github, nodeId) {
  await github.graphql(
    'mutation($id:ID!){ disablePullRequestAutoMerge(input:{pullRequestId:$id}){ clientMutationId } }',
    { id: nodeId },
  );
}

const prIdentity = (pr) => ({
  headRepo: pr.head?.repo?.full_name ?? null,
  baseRepo: pr.base?.repo?.full_name ?? null,
  authorAssociation: pr.author_association,
});

/** Job: classify the PR in the pull_request_target event. Never fails on risk. */
export async function runClassify({ github, context, core }) {
  const repo = context.repo;
  const pr = context.payload.pull_request;
  const changeSet = await attachModes(github, repo, pr.head.sha, await fetchChangeSet(github, repo, pr));
  const result = classify(changeSet);
  core.info(JSON.stringify(result, null, 2));

  // A restricted change, or any new push, must not ride an earlier auto-merge
  // enablement: switch it off before anything else is published.
  if (pr.auto_merge && (result.risk !== 'low' || context.payload.action === 'synchronize')) {
    try {
      await disableAutoMerge(github, pr.node_id);
      core.info('auto-merge disabled (restricted change or new push)');
    } catch (e) {
      core.setFailed(`Could not disable auto-merge on #${pr.number}: ${e.message}`);
      return result;
    }
  }

  const protection = await mainProtection(github, repo);
  const outsider = outsiderReason(prIdentity(pr));
  const report = buildReport(result, { headSha: pr.head.sha, mainProtection: protection, outsider });
  await core.summary.addRaw(report).write();

  // Label/comment/status writes failing is an operational error (reported red);
  // the classification itself is already in the summary.
  try {
    const labels = await syncLabels(github, repo, pr, result);
    core.info(`labels: +[${labels.add}] -[${labels.remove}]`);
    const comment = await upsertReportComment(github, repo, pr.number, report, {
      createIfMissing: result.risk === 'restricted',
    });
    core.info(`report comment: ${comment}`);
    await github.rest.repos.createCommitStatus({
      ...repo,
      sha: pr.head.sha,
      state: 'success',
      context: CLASSIFY_CONTEXT,
      description: (result.risk === 'low' ? 'risk:low' : `risk:restricted (${result.classes.join(', ')})`).slice(0, 140),
    });
  } catch (e) {
    core.warning(`Could not write labels/comment/status: ${e.message}`);
    core.setFailed('Governance classification could not be published to the PR.');
  }
  return result;
}

async function unresolvedThreadCount(github, repo, number) {
  let after = null;
  let unresolved = 0;
  for (let page = 0; page < 50; page++) {
    const data = await github.graphql(
      `query($owner:String!,$name:String!,$number:Int!,$after:String){
        repository(owner:$owner,name:$name){ pullRequest(number:$number){
          reviewThreads(first:100, after:$after){ nodes{ isResolved } pageInfo{ hasNextPage endCursor } } } } }`,
      { owner: repo.owner, name: repo.repo, number, after },
    );
    const threads = data.repository.pullRequest.reviewThreads;
    unresolved += threads.nodes.filter((t) => !t.isResolved).length;
    if (!threads.pageInfo.hasNextPage) return unresolved;
    after = threads.pageInfo.endCursor;
  }
  return null; // too many pages: unknown → fail-closed
}

/** Gather everything decideEligibility needs for one PR. */
/** All commit statuses on a SHA (newest first, as the API returns them). */
async function listStatuses(github, repo, sha) {
  return github.paginate(github.rest.repos.listCommitStatusesForRef, { ...repo, ref: sha, per_page: 100 });
}

/** Sticky revocation statuses in a status list, honoured only from the Actions bot. */
const revokedFrom = (statuses) => (statuses ?? []).filter((st) => st.context === REVOKED_CONTEXT && st.creator?.login === ACTIONS_BOT_LOGIN);

const STATUS_CAP = /maximum number of statuses/i;

/**
 * Record each revocation as a sticky failure status on the SHA it names
 * (once per SHA): statuses cannot be deleted, so the revocation survives the
 * revoke comment being edited or deleted later.
 */
export async function recordRevocations(github, repo, revocations, known = {}) {
  const done = new Set();
  for (const r of revocations ?? []) {
    if (done.has(r.sha)) continue;
    done.add(r.sha);
    const statuses = known[r.sha] ?? (await listStatuses(github, repo, r.sha));
    if (revokedFrom(statuses).length) continue;
    const description = `exception revoked by @${r.login} in comment ${r.commentId}`;
    // Eligibility goes red FIRST, then the permanent marker is recorded.
    await postEligibilityStatus(github, repo, r.sha, 'failure', description, { existing: statuses });
    await github.rest.repos.createCommitStatus({
      ...repo,
      sha: r.sha,
      state: 'failure',
      context: REVOKED_CONTEXT,
      description: description.slice(0, 140),
    });
  }
}

/**
 * Revocation carried by an issue_comment edited/deleted event on a PR: the
 * comment's ORIGINAL body parsed as an exception command (any SHA it names).
 * Null for anything else. The author's role is checked by the caller.
 */
export function revocationFromEvent(payload) {
  if (!payload?.issue?.pull_request) return null;
  const c = eventCommentFor(payload, payload.issue.number);
  if (!c || !c.user?.login || c.user.type === 'Bot') return null;
  const cmd = parseExceptionCommand(c.body);
  if (!cmd) return null;
  return { sha: cmd.sha, login: c.user.login, commentId: c.id, why: 'edited-or-deleted', prNumber: payload.issue.number };
}

/**
 * Job `revocations`: record a revocation straight from an edited/deleted
 * comment event (no per-PR queue), after checking the author is admin/maintain.
 */
export async function runRevocations({ github, context, core }) {
  const repo = context.repo;
  const r = revocationFromEvent(context.payload);
  if (!r) {
    core.info('No exception command in the edited/deleted comment; nothing to revoke.');
    return null;
  }
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...repo, username: r.login });
    if (!isApproverRole({ permission: data.permission, role_name: data.role_name })) {
      core.info(`@${r.login} is not admin/maintain; their command carries no approval to revoke.`);
      return null;
    }
    await recordRevocations(github, repo, [r]);
    core.info(`Revocation recorded for ${r.sha.slice(0, 7)} (comment ${r.commentId}, @${r.login}).`);
    return r;
  } catch (e) {
    if (e.statusCap) core.error(e.message);
    core.setFailed(`Could not record the revocation: ${e.message}`);
    return null;
  }
}

/**
 * For an issue_comment edited/deleted event on this PR, the comment's ORIGINAL
 * body (edited: changes.body.from; deleted: comment.body) — so an admin's
 * command that is edited away or deleted still counts as a revocation.
 */
export function eventCommentFor(payload, number) {
  if (!payload?.comment || payload?.issue?.number !== number) return undefined;
  if (payload.action === 'edited') return { id: payload.comment.id, body: payload.changes?.body?.from, user: payload.comment.user };
  if (payload.action === 'deleted') return { id: payload.comment.id, body: payload.comment.body, user: payload.comment.user };
  return undefined;
}

/** Per-sweep memo for workflow-run lookups (never fetch the same thing twice). */
export function newLookupCache() {
  return { prtByHead: new Map(), suites: new Map() };
}

export async function gatherState(github, repo, number, { eventComment, core, cache = newLookupCache() } = {}) {
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  const headSha = pr.head.sha;
  const changeSet = await attachModes(github, repo, headSha, await fetchChangeSet(github, repo, pr));
  const fresh = classify(changeSet);
  const checkRuns = await github.paginate(github.rest.checks.listForRef, { ...repo, ref: headSha, filter: 'latest', per_page: 100 });
  // CI via the Actions jobs API: newest pull_request run of ci.yml for this
  // head, latest attempt, its jobs (job id == check run id).
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
    ...repo, head_sha: headSha, event: 'pull_request', per_page: 100,
  });
  // Resolve check-run suites to their workflow run (path, event, head
  // repository) ONLY where it matters: suites holding a GitHub Actions run with
  // one of our governance job names (the only runs that can ever be excluded or
  // count as our classification). Every other suite stays unresolved without an
  // API call, which is safe: unresolved ⇒ ordinary check (fail closed).
  // Budget per head: one head_sha pull_request_target listing, then a
  // check_suite_id lookup only for candidates still unresolved; both memoised
  // in `cache` for the whole sweep.
  const runMeta = (r) => ({ path: r.path, event: r.event, headRepo: r.head_repository?.full_name });
  const suiteMeta = new Map(runs.map((r) => [r.check_suite_id, runMeta(r)]));
  const candidates = [...new Set(checkRuns
    .filter((c) => c.check_suite?.id != null && isGovernanceCandidateRun({ name: c.name, appId: c.app?.id }))
    .map((c) => c.check_suite.id))]
    .filter((id) => !suiteMeta.has(id));
  if (candidates.length) {
    if (!cache.prtByHead.has(headSha)) {
      let listed = null;
      try {
        listed = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
          ...repo, head_sha: headSha, event: 'pull_request_target', per_page: 100,
        });
      } catch (e) {
        core?.warning(`Could not list pull_request_target workflow runs for ${headSha.slice(0, 7)} (${e.status ? `HTTP ${e.status}` : e.message}); falling back to per-suite lookups.`);
      }
      cache.prtByHead.set(headSha, listed);
    }
    for (const r of cache.prtByHead.get(headSha) ?? []) {
      if (!suiteMeta.has(r.check_suite_id)) suiteMeta.set(r.check_suite_id, runMeta(r));
    }
    for (const suiteId of candidates.filter((id) => !suiteMeta.has(id))) {
      if (!cache.suites.has(suiteId)) {
        let meta = null;
        try {
          const found = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { ...repo, check_suite_id: suiteId, per_page: 100 });
          const run = found.find((r) => r.check_suite_id === suiteId);
          if (run) meta = runMeta(run);
        } catch (e) {
          // Unresolved ⇒ its check runs stay ordinary checks (fail closed).
          core?.warning(`Could not resolve check suite ${suiteId} to its workflow run (${e.status ? `HTTP ${e.status}` : e.message}); its check runs are treated as ordinary checks.`);
        }
        cache.suites.set(suiteId, meta);
      }
      const meta = cache.suites.get(suiteId);
      if (meta) suiteMeta.set(suiteId, meta);
    }
  }
  const ciPath = DEFAULT_CONFIG.ciCheck.workflowPath;
  // Only runs listing THIS PR against main count, and EVERY such run must have
  // a successful CI job on its latest attempt: a run triggered by another PR
  // (e.g. into another base) can list this PR too and must not hide a failure.
  const ciRunsForPr = runs
    .filter((r) => r.path === ciPath && r.event === 'pull_request')
    .filter((r) => (r.pull_requests ?? []).some((x) => x.number === number && x.base?.ref === DEFAULT_CONFIG.baseBranch));
  let ciJobs = null;
  if (ciRunsForPr.length) {
    ciJobs = [];
    for (const run of ciRunsForPr) {
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...repo, run_id: run.id, filter: 'latest', per_page: 100,
      });
      const latest = jobs
        .filter((j) => j.run_attempt === undefined || run.run_attempt === undefined || j.run_attempt === run.run_attempt)
        .map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, runId: run.id }));
      if (!latest.some((j) => j.name === DEFAULT_CONFIG.ciCheck.name)) {
        latest.push({ id: null, name: DEFAULT_CONFIG.ciCheck.name, status: 'missing', conclusion: null, runId: run.id });
      }
      ciJobs.push(...latest);
    }
  }
  // Other open PRs sharing this head SHA (unknown on API error → fail closed).
  const sharedHeadWith = await github
    .paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 })
    .then((open) => open.filter((x) => x.number !== number && x.head?.sha === headSha).map((x) => x.number))
    .catch(() => null);
  const { data: combined } = await github.rest.repos.getCombinedStatusForRef({ ...repo, ref: headSha, per_page: 100 });
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: number, per_page: 100 });
  // Unknown (API error) → null → decideEligibility fails closed.
  const unresolvedThreads = await unresolvedThreadCount(github, repo, number).catch(() => null);

  // Every status on the head (creator-aware): used to avoid re-posting an
  // unchanged eligibility status and to read sticky revocations.
  const headStatuses = await listStatuses(github, repo, headSha);

  // Exception approval (restricted PRs only): SHA-bound approval comments with
  // sticky revocation. Permission is looked up only for authors of well-formed
  // non-bot commands. Any API failure ⇒ not approved (fail closed).
  let exception;
  if (fresh.risk !== 'low') {
    try {
      const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
      const authors = [...new Set([...comments, ...(eventComment ? [eventComment] : [])]
        .filter((c) => c.user?.type !== 'Bot' && parseExceptionCommand(c.body))
        .map((c) => c.user?.login)
        .filter(Boolean))];
      const roles = {};
      for (const username of authors) {
        const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...repo, username });
        roles[username] = { permission: data.permission, role_name: data.role_name };
      }
      exception = evaluateExceptionApproval({ comments, roles, headSha, revokedStatuses: revokedFrom(headStatuses), eventComment });
      await recordRevocations(github, repo, exception.revocations, { [headSha.toLowerCase()]: headStatuses });
    } catch (e) {
      exception = { approved: false, reason: `Could not verify exception approvals (${e.status ? `HTTP ${e.status}` : e.message}).` };
    }
  }

  // The head must not have moved while we were gathering.
  const { data: again } = await github.rest.pulls.get({ ...repo, pull_number: number });
  const moved = again.head.sha !== headSha;

  return {
    raw: pr,
    latest: again,
    headStatuses,
    fresh,
    moved,
    state: {
      pr: {
        number,
        draft: pr.draft,
        baseRef: pr.base.ref,
        headSha,
        labels: (pr.labels ?? []).map((l) => l.name),
        ...prIdentity(pr),
      },
      freshRisk: fresh.risk,
      checkRuns: checkRuns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        appId: c.app?.id,
        workflowPath: suiteMeta.get(c.check_suite?.id)?.path,
        workflowEvent: suiteMeta.get(c.check_suite?.id)?.event,
        workflowHeadRepo: suiteMeta.get(c.check_suite?.id)?.headRepo,
      })),
      statuses: (combined.statuses ?? []).map((s) => ({ context: s.context, state: s.state })),
      ciJobs,
      sharedHeadWith,
      exception,
      reviews: reviews.map((r) => ({ login: r.user?.login, userType: r.user?.type, commitId: r.commit_id, state: r.state })),
      unresolvedThreads,
    },
  };
}

/** Enable (eligible) or disable (otherwise) auto-merge. Returns the action taken. */
export async function applyDecision(github, repo, raw, decision) {
  const hasAutoMerge = Boolean(raw.auto_merge);
  if (!decision.eligible) {
    if (!hasAutoMerge) return 'auto-merge already off';
    await disableAutoMerge(github, raw.node_id);
    return 'auto-merge DISABLED';
  }
  if (hasAutoMerge) return 'auto-merge already on';
  try {
    await github.graphql(
      'mutation($id:ID!,$sha:GitObjectID!){ enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:SQUASH, expectedHeadOid:$sha}){ clientMutationId } }',
      { id: raw.node_id, sha: raw.head.sha },
    );
    return 'auto-merge ENABLED (squash)';
  } catch (e) {
    const msg = e.message ?? '';
    // GitHub refuses to *enable* auto-merge on a PR that is already mergeable
    // ("clean status"). Every condition was just verified, so squash-merge
    // directly, pinned to the head SHA we evaluated (refused if it moved).
    if (/clean status/i.test(msg)) {
      await github.rest.pulls.merge({ ...repo, pull_number: raw.number, merge_method: 'squash', sha: raw.head.sha });
      return 'squash-merged (PR was already clean; pinned to evaluated head SHA)';
    }
    // Repository setting, not an evaluation error: report, do not turn red.
    if (AUTO_MERGE_NOT_ALLOWED.test(msg)) {
      return 'CONFIGURATION GAP: the repository does not allow auto-merge (enable "Allow auto-merge" in repo settings, e.g. via scripts/governance/protect-main.mjs). Not merged.';
    }
    throw e;
  }
}

export const MAX_TARGETS = 200; // GitHub matrices cap at 256 legs

/**
 * The required eligibility status on a SHA, posted only when (state,
 * description) differs from the latest one github-actions[bot] created there:
 * GitHub caps statuses at 1000 per SHA and context, and unconditional
 * re-posting could freeze the status. `existing` is the SHA's status list when
 * already gathered; otherwise it is fetched, and if that fails we post anyway.
 * Hitting the cap throws an error marked `statusCap` (the job goes red).
 */
export async function postEligibilityStatus(github, repo, sha, state, description, { existing } = {}) {
  const desc = String(description).slice(0, 140);
  let statuses = existing;
  if (!statuses) {
    try {
      statuses = await listStatuses(github, repo, sha);
    } catch {
      statuses = null;
    }
  }
  const latest = (statuses ?? []).find((st) => st.context === ELIGIBILITY_CONTEXT && st.creator?.login === ACTIONS_BOT_LOGIN);
  if (latest && latest.state === state && latest.description === desc) return 'unchanged';
  try {
    await github.rest.repos.createCommitStatus({ ...repo, sha, state, context: ELIGIBILITY_CONTEXT, description: desc });
  } catch (e) {
    if (STATUS_CAP.test(e.message ?? '')) {
      throw Object.assign(new Error(
        `GitHub refuses more "${ELIGIBILITY_CONTEXT}" statuses on ${sha.slice(0, 7)} (maximum number of statuses per SHA and context); `
        + 'the status is frozen at its last value. To resolve, push a new commit to the PR head.',
      ), { statusCap: true });
    }
    throw e;
  }
  return 'posted';
}

async function candidatePrs(github, context) {
  const repo = context.repo;
  const p = context.payload;
  if (p.pull_request) return [p.pull_request];
  // issue_comment: evaluate the PR right away (e.g. a new approval comment).
  if (p.issue) return p.issue.pull_request ? [{ number: p.issue.number }] : [];
  if (p.workflow_run) {
    const listed = p.workflow_run.pull_requests ?? [];
    if (listed.length) return listed;
    const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
    return open.filter((x) => x.head.sha === p.workflow_run.head_sha);
  }
  return github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: DEFAULT_CONFIG.baseBranch, per_page: 100 });
}

async function candidatePrNumbers(github, context) {
  return (await candidatePrs(github, context)).map((x) => x.number);
}

/**
 * Job: list the PR numbers this event should evaluate (matrix input), newest
 * updated first. Above MAX_TARGETS (the matrix caps at 256 legs) the window
 * rotates by sweep slot: offset = (minute-of-day / 30) * MAX_TARGETS modulo the
 * count, wrapping around, so successive sweeps eventually cover every PR.
 */
export async function runTargets({ github, context, core, now = new Date() }) {
  const prs = await candidatePrs(github, context);
  const ts = (x) => (x.updated_at ? Date.parse(x.updated_at) : 0);
  const sorted = [...prs].sort((a, b) => ts(b) - ts(a));
  let nums = [...new Set(sorted.map((x) => x.number))];
  if (nums.length > MAX_TARGETS) {
    const d = new Date(now);
    const slot = Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes()) / 30);
    const offset = (slot * MAX_TARGETS) % nums.length;
    const window = [];
    for (let i = 0; i < MAX_TARGETS; i++) window.push(nums[(offset + i) % nums.length]);
    core.warning(`${nums.length} PRs to evaluate; capped at ${MAX_TARGETS} (newest updated first, rotating window starting at offset ${offset}). The rest are covered by later sweeps.`);
    nums = window;
  }
  core.setOutput('prs', JSON.stringify(nums));
  core.info(`PRs to evaluate: ${JSON.stringify(nums)}`);
  return nums;
}

/** Job: decide merge eligibility for the given PR(s) (or those relevant to this event). */
export async function runEligibility({ github, context, core, numbers }) {
  const repo = context.repo;
  const targets = numbers ?? (await candidatePrNumbers(github, context));
  const rows = [];
  let errors = 0;
  const cache = newLookupCache(); // one memo for the whole sweep
  for (const number of targets) {
    try {
      const { raw, latest, fresh, moved, state, headStatuses } = await gatherState(github, repo, number, {
        eventComment: eventCommentFor(context.payload, number),
        core,
        cache,
      });
      if (moved) {
        // Apply an ineligible decision first (never leave auto-merge armed on a
        // head we did not evaluate), mark the new head pending, then defer.
        let action = await applyDecision(github, repo, latest, { eligible: false, reasons: [] });
        await postEligibilityStatus(github, repo, latest.head.sha, 'pending', 'Head moved during evaluation; re-evaluation pending.');
        action = `head moved during evaluation; ${action}; pending status on ${latest.head.sha.slice(0, 7)}; deferred to the next event`;
        rows.push({ number, risk: fresh.risk, eligible: false, action, reasons: [] });
        continue;
      }
      const decision = decideEligibility(state);
      const status = decideMergeStatus(state);
      // Auto-merge is only ever ENABLED for eligible low-risk PRs; an approved
      // exception yields a success status, and the approver merges.
      const action = await applyDecision(github, repo, raw, decision);
      if (action.startsWith('CONFIGURATION GAP')) core.warning(`#${number}: ${action}`);
      await postEligibilityStatus(github, repo, state.pr.headSha, status.state, status.description, { existing: headStatuses });
      rows.push({
        number, risk: fresh.risk, eligible: decision.eligible,
        action: `${action}; status ${status.state} (${status.mode})`, reasons: decision.reasons,
      });
    } catch (e) {
      errors++;
      if (e.statusCap) core.error(e.message);
      let action = `error: ${e.message}`;
      // Fail closed: if auto-merge is on and we could not re-verify, turn it off.
      try {
        const { data: raw } = await github.rest.pulls.get({ ...repo, pull_number: number });
        action += `; ${await applyDecision(github, repo, raw, { eligible: false, reasons: [] })}`;
        await postEligibilityStatus(github, repo, raw.head.sha, 'failure', 'Eligibility evaluation error; see the Governance job summary.');
      } catch (e2) {
        action += `; could not disable auto-merge / post failure status: ${e2.message}`;
      }
      rows.push({ number, risk: '?', eligible: false, action, reasons: [] });
    }
  }
  const md = ['### Governance: merge eligibility', ''];
  if (!rows.length) md.push('No open PRs to evaluate for this event.');
  for (const r of rows) {
    md.push(`#### #${r.number} — ${r.eligible ? 'ELIGIBLE' : 'not eligible'} (fresh risk: ${r.risk})`, '', `Action: ${r.action}`);
    for (const reason of r.reasons) md.push(`- ${reason}`);
    md.push('');
  }
  await core.summary.addRaw(md.join('\n')).write();
  if (errors) core.setFailed(`${errors} PR(s) could not be evaluated; auto-merge was not enabled for them.`);
  return rows;
}
