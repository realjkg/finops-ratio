// GitHub-facing glue for .github/workflows/governance.yml, invoked from
// actions/github-script with its injected { github, context, core }.
// The workflow checks this file out from the BASE commit (never the PR head),
// so a PR cannot change the code that classifies it.
import { classify } from './classify-risk.mjs';
import { decideEligibility, outsiderReason, DEFAULT_CONFIG } from './eligibility.mjs';
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
    // including a source file with a NUL byte (changes: 0). Content rules
    // cannot see those, so they are uninspectable unless the change is a pure
    // removal or a pure rename. Fail closed.
    patchUnavailable: f.patch === undefined && !(f.status === 'removed' || (f.status === 'renamed' && f.changes === 0)),
  }));
  const truncated = raw.length >= MAX_LISTED_FILES || (typeof pr.changed_files === 'number' && raw.length < pr.changed_files);
  return { files, truncated };
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
  const changeSet = await fetchChangeSet(github, repo, pr);
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
export async function gatherState(github, repo, number) {
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  const headSha = pr.head.sha;
  const changeSet = await fetchChangeSet(github, repo, pr);
  const fresh = classify(changeSet);
  const checkRuns = await github.paginate(github.rest.checks.listForRef, { ...repo, ref: headSha, filter: 'latest', per_page: 100 });
  // Resolve each check run's suite to the workflow file that produced it, so a
  // same-named job in another workflow cannot impersonate CI.
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { ...repo, head_sha: headSha, per_page: 100 });
  const pathBySuite = new Map(runs.map((r) => [r.check_suite_id, r.path]));
  const { data: combined } = await github.rest.repos.getCombinedStatusForRef({ ...repo, ref: headSha, per_page: 100 });
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: number, per_page: 100 });
  // Unknown (API error) → null → decideEligibility fails closed.
  const unresolvedThreads = await unresolvedThreadCount(github, repo, number).catch(() => null);

  // The head must not have moved while we were gathering.
  const { data: again } = await github.rest.pulls.get({ ...repo, pull_number: number });
  const moved = again.head.sha !== headSha;

  return {
    raw: pr,
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
        workflowPath: pathBySuite.get(c.check_suite?.id),
      })),
      statuses: (combined.statuses ?? []).map((s) => ({ context: s.context, state: s.state })),
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

async function candidatePrNumbers(github, context) {
  const repo = context.repo;
  const p = context.payload;
  if (p.pull_request) return [p.pull_request.number];
  if (p.workflow_run) {
    const nums = (p.workflow_run.pull_requests ?? []).map((x) => x.number);
    if (nums.length) return nums;
    const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 });
    return open.filter((x) => x.head.sha === p.workflow_run.head_sha).map((x) => x.number);
  }
  const open = await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: DEFAULT_CONFIG.baseBranch, per_page: 100 });
  return open.map((x) => x.number);
}

/** Job: list the PR numbers this event should evaluate (matrix input). */
export async function runTargets({ github, context, core }) {
  const nums = [...new Set(await candidatePrNumbers(github, context))];
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
  for (const number of targets) {
    try {
      const { raw, fresh, moved, state } = await gatherState(github, repo, number);
      if (moved) {
        rows.push({ number, risk: fresh.risk, eligible: false, action: 'head moved during evaluation; deferred to the next event (auto-merge not enabled)', reasons: [] });
        continue;
      }
      const decision = decideEligibility(state);
      const action = await applyDecision(github, repo, raw, decision);
      rows.push({ number, risk: fresh.risk, eligible: decision.eligible, action, reasons: decision.reasons });
    } catch (e) {
      errors++;
      let action = `error: ${e.message}`;
      // Fail closed: if auto-merge is on and we could not re-verify, turn it off.
      try {
        const { data: raw } = await github.rest.pulls.get({ ...repo, pull_number: number });
        action += `; ${await applyDecision(github, repo, raw, { eligible: false, reasons: [] })}`;
      } catch (e2) {
        action += `; could not disable auto-merge: ${e2.message}`;
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
