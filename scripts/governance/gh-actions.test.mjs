// Workflow glue tested against an in-memory fake of the github-script Octokit.
import { describe, it, expect } from 'vitest';
import {
  runClassify, runEligibility, runTargets, runRevocations, revocationFromEvent, upsertReportComment, fetchChangeSet, mainProtection,
} from './gh-actions.mjs';
import { classify } from './classify-risk.mjs';
import { REPORT_MARKER } from './report.mjs';

const REPO = { owner: 'o', repo: 'r' };
const HEAD = 'b'.repeat(40);
const MOVED = 'd'.repeat(40);
const CI_SUITE = 100;
const GOV_SUITE = 200;
const COPILOT_SUITE = 300;
const EVIL_SUITE = 400;

const README = { filename: 'README.md', status: 'modified', patch: '+hi', changes: 1 };
const DEFAULT_GOV_RUN = { id: 777, check_suite_id: 200, path: '.github/workflows/governance.yml', event: 'pull_request_target', head_repository: { full_name: 'o/r' }, repository: { full_name: 'o/r' } };

function fakeGithub(opts = {}) {
  const calls = [];
  const rec = (name, ret) => async (params) => {
    calls.push({ name, params });
    const v = typeof ret === 'function' ? ret(params) : ret;
    if (v instanceof Error) throw v;
    return { data: v };
  };
  const err = (message, status) => Object.assign(new Error(message), { status });
  const files = opts.files ?? [README];
  const pr = {
    number: 5,
    node_id: 'PR_node',
    draft: false,
    author_association: opts.association ?? 'OWNER',
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    head: { sha: HEAD, repo: opts.headRepo === undefined ? { full_name: 'o/r' } : opts.headRepo },
    labels: (opts.labels ?? ['risk:low']).map((name) => ({ name })),
    changed_files: files.length,
    auto_merge: opts.autoMerge ?? null,
    ...(opts.pr ?? {}),
  };
  let getCount = 0;
  const github = {
    calls,
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query, vars) => {
      calls.push({ name: 'graphql', query, vars });
      if (query.includes('reviewThreads')) {
        return {
          repository: { pullRequest: { reviewThreads: {
            nodes: opts.threads ?? [],
            pageInfo: opts.threadsAlwaysMore ? { hasNextPage: true, endCursor: 'x' } : { hasNextPage: false },
          } } },
        };
      }
      if (query.includes('enablePullRequestAutoMerge') && opts.enableError) throw new Error(opts.enableError);
      if (query.includes('disablePullRequestAutoMerge') && opts.disableError) throw new Error(opts.disableError);
      return {};
    },
    rest: {
      pulls: {
        get: rec('pulls.get', () => {
          getCount++;
          if (opts.headMovesAfterFirstGet && getCount > 1) return { ...pr, head: { ...pr.head, sha: MOVED } };
          return pr;
        }),
        list: rec('pulls.list', [pr]),
        listFiles: rec('pulls.listFiles', files),
        listReviews: rec('pulls.listReviews', opts.reviews ?? [
          { user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, commit_id: HEAD, state: 'COMMENTED' },
        ]),
        merge: rec('pulls.merge', {}),
      },
      issues: {
        listComments: rec('issues.listComments', opts.comments ?? []),
        createComment: rec('issues.createComment', {}),
        updateComment: rec('issues.updateComment', {}),
        getLabel: rec('issues.getLabel', (p) => ((opts.existingLabels ?? []).includes(p.name) ? {} : err('nf', 404))),
        createLabel: rec('issues.createLabel', {}),
        addLabels: rec('issues.addLabels', opts.addLabelsError ? err('Resource not accessible by integration', 403) : {}),
        removeLabel: rec('issues.removeLabel', {}),
        listEvents: rec('issues.listEvents', opts.events ?? []),
      },
      repos: {
        getBranch: rec('repos.getBranch', opts.branchError ? err('x', 403) : { protected: true }),
        getBranchRules: rec('repos.getBranchRules', opts.rulesError ? err('x', 404) : (opts.rules ?? [])),
        createCommitStatus: rec('repos.createCommitStatus', (p) => (opts.statusError ? opts.statusError(p) : undefined) ?? {}),
        getCollaboratorPermissionLevel: rec('repos.getCollaboratorPermissionLevel', (p) => (opts.roles ?? {})[p.username] ?? { permission: 'write', role_name: 'write' }),
        getCombinedStatusForRef: rec('repos.getCombinedStatusForRef', { statuses: opts.statuses ?? [] }),
        listCommitStatusesForRef: rec('repos.listCommitStatusesForRef', (p) => (opts.statusesBySha ?? {})[p.ref] ?? []),
      },
      checks: {
        listForRef: rec('checks.listForRef', opts.checksError ? err('boom', 500) : (opts.checkRuns ?? [
          { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
          { id: 2, name: 'Governance · risk classification', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: GOV_SUITE } },
          { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
        ])),
      },
      git: {
        getCommit: rec('git.getCommit', { committer: { date: opts.headCommittedAt ?? '2026-10-01T10:00:00Z' } }),
        getTree: rec('git.getTree', opts.treeError ? err('tree boom', 500) : {
          truncated: Boolean(opts.treeTruncated),
          tree: opts.tree ?? files.map((f) => ({ path: f.filename, mode: '100644', type: 'blob' })),
        }),
      },
      actions: {
        listJobsForWorkflowRun: rec('actions.listJobsForWorkflowRun', (p) => {
          if (typeof opts.ciJobs === 'function') return opts.ciJobs(p);
          return opts.ciJobs ?? [{ id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', run_attempt: opts.ciAttempt ?? 1 }];
        }),
        listWorkflowRunsForRepo: rec('actions.listWorkflowRunsForRepo', (p) => {
          if (typeof opts.workflowRuns === 'function') return opts.workflowRuns(p);
          // check_suite_id lookups resolve the default governance suite (pull_request_target, base repo).
          if (p.check_suite_id !== undefined) return p.check_suite_id === GOV_SUITE ? [DEFAULT_GOV_RUN] : [];
          return opts.workflowRuns ?? [
            { id: 900, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: opts.ciAttempt ?? 1, pull_requests: [{ number: 5, base: { ref: 'main' } }] },
            { check_suite_id: COPILOT_SUITE, path: 'dynamic/agents/copilot-pull-request-reviewer' },
            { check_suite_id: EVIL_SUITE, path: '.github/workflows/evil.yml' },
          ];
        }),
      },
    },
  };
  return { github, pr };
}

function fakeCore() {
  const core = {
    out: '', failed: null, warnings: [], outputs: {},
    errors: [],
    info: () => {}, warning: (m) => core.warnings.push(m), error: (m) => core.errors.push(m), setFailed: (m) => { core.failed = m; },
    setOutput: (k, v) => { core.outputs[k] = v; },
  };
  core.summary = { addRaw: (s) => { core.out += s; return core.summary; }, write: async () => {} };
  return core;
}

const names = (calls) => calls.map((c) => c.name);
const gql = (github, word) => github.calls.filter((c) => c.name === 'graphql' && c.query.includes(word));
const prCtx = (pr, action = 'opened') => ({ repo: REPO, payload: { action, pull_request: pr } });

describe('fetchChangeSet', () => {
  it('H2: a source file GitHub treats as binary (NUL byte: changes 0, no patch) is uninspectable → restricted', async () => {
    const { github } = fakeGithub({ files: [{ filename: 'src/components/A.tsx', status: 'modified', changes: 0 }] });
    const cs = await fetchChangeSet(github, REPO, { number: 5, changed_files: 1 });
    expect(cs.files[0].patchUnavailable).toBe(true);
    expect(classify(cs).risk).toBe('restricted');
  });
  it('H2: an added binary docs/a.png is restricted (fail closed)', async () => {
    const { github } = fakeGithub({ files: [{ filename: 'docs/a.png', status: 'added', changes: 0 }] });
    const cs = await fetchChangeSet(github, REPO, { number: 5, changed_files: 1 });
    expect(cs.files[0].patchUnavailable).toBe(true);
    expect(classify(cs)).toMatchObject({ risk: 'restricted', reasons: [{ path: 'docs/a.png', rule: 'diff-unavailable' }] });
  });
  it('N1: only removals may lack a patch (pure renames are uninspectable too)', async () => {
    const { github } = fakeGithub({ files: [
      { filename: 'docs/old.md', status: 'removed', changes: 3 },
      { filename: 'docs/new.md', previous_filename: 'docs/prev.md', status: 'renamed', changes: 0 },
      { filename: 'docs/edited.md', previous_filename: 'docs/p2.md', status: 'renamed', changes: 4 },
      { filename: 'x.md', status: 'modified', changes: 3 },
    ] });
    const cs = await fetchChangeSet(github, REPO, { number: 5, changed_files: 5 });
    expect(cs.files.map((f) => f.patchUnavailable)).toEqual([false, true, true, true]);
    expect(cs.truncated).toBe(true);
  });
});

describe('N1: renamed binary-looking source', () => {
  it('renamed A.tsx→B.tsx with NUL byte + fetch line, changes 0, no patch ⇒ restricted', async () => {
    const { github } = fakeGithub({ files: [{ filename: 'src/components/B.tsx', previous_filename: 'src/components/A.tsx', status: 'renamed', changes: 0 }] });
    const cs = await fetchChangeSet(github, REPO, { number: 5, changed_files: 1 });
    expect(cs.files[0].patchUnavailable).toBe(true);
    expect(classify(cs)).toMatchObject({ risk: 'restricted', reasons: [{ path: 'src/components/B.tsx', rule: 'diff-unavailable' }] });
  });
});

describe('mainProtection', () => {
  it('M4b: reads required status checks from the branch rules API', async () => {
    const { github } = fakeGithub({ rules: [
      { type: 'pull_request', parameters: {} },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'A' }, { context: 'B' }] } },
    ] });
    expect(await mainProtection(github, REPO)).toEqual({ protected: true, rulesRequiredChecks: ['A', 'B'] });
  });
  it('M4b: rules API failure is reported, not fatal', async () => {
    const { github } = fakeGithub({ rulesError: true });
    expect(await mainProtection(github, REPO)).toEqual({ protected: true, rulesError: 'HTTP 404' });
  });
});

describe('upsertReportComment', () => {
  it('updates the bot comment carrying the marker, ignores a spoofed one', async () => {
    const { github } = fakeGithub({ comments: [
      { id: 1, user: { login: 'mallory' }, body: `${REPORT_MARKER} fake` },
      { id: 2, user: { login: 'github-actions[bot]' }, body: `${REPORT_MARKER} old` },
    ] });
    expect(await upsertReportComment(github, REPO, 5, `${REPORT_MARKER} new`, { createIfMissing: true })).toBe('updated');
    expect(github.calls.find((c) => c.name === 'issues.updateComment').params.comment_id).toBe(2);
    expect(names(github.calls)).not.toContain('issues.createComment');
  });
  it('creates once when missing and allowed; never spams', async () => {
    const { github } = fakeGithub();
    expect(await upsertReportComment(github, REPO, 5, 'b', { createIfMissing: false })).toBe('none');
    expect(await upsertReportComment(github, REPO, 5, 'b', { createIfMissing: true })).toBe('created');
  });
  it('identical body → no write', async () => {
    const { github } = fakeGithub({ comments: [{ id: 2, user: { login: 'github-actions[bot]' }, body: `${REPORT_MARKER}x` }] });
    expect(await upsertReportComment(github, REPO, 5, `${REPORT_MARKER}x`, { createIfMissing: true })).toBe('unchanged');
  });
});

describe('runClassify', () => {
  it('restricted PR: labels, exception report comment, summary, success status — never fails', async () => {
    const { github, pr } = fakeGithub({
      labels: ['risk:low', 'bug'],
      files: [{ filename: 'src/ingest/db/migrations/0002.up.sql', status: 'added', patch: '+create table x();', changes: 1 }],
    });
    const core = fakeCore();
    const result = await runClassify({ github, core, context: prCtx(pr) });
    expect(result.risk).toBe('restricted');
    expect(core.failed).toBeNull();
    expect(core.out).toMatch(/EXCEPTION REPORT/);
    expect(github.calls.find((c) => c.name === 'issues.addLabels').params.labels)
      .toEqual(['risk:restricted', 'restricted:financial_semantics', 'restricted:migrations']);
    expect(github.calls.find((c) => c.name === 'issues.removeLabel').params.name).toBe('risk:low');
    expect(names(github.calls)).toContain('issues.createComment');
    expect(github.calls.find((c) => c.name === 'repos.createCommitStatus').params)
      .toMatchObject({ sha: HEAD, state: 'success', context: 'Governance · risk classification' });
  });

  it('low PR: risk:low label, no new comment', async () => {
    const { github, pr } = fakeGithub({ labels: [] });
    await runClassify({ github, core: fakeCore(), context: prCtx(pr) });
    expect(github.calls.find((c) => c.name === 'issues.addLabels').params.labels).toEqual(['risk:low']);
    expect(names(github.calls)).not.toContain('issues.createComment');
  });

  it('records missing admin visibility of branch protection in the report without failing', async () => {
    const { github, pr } = fakeGithub({ branchError: true, files: [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }] });
    const core = fakeCore();
    await runClassify({ github, core, context: prCtx(pr) });
    expect(core.out).toMatch(/could not be verified \(HTTP 403\)/);
    expect(core.failed).toBeNull();
  });

  // M2
  it('M2: restricted result with auto-merge on → disabled BEFORE the status is posted', async () => {
    const { github, pr } = fakeGithub({ autoMerge: { merge_method: 'squash' }, files: [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }] });
    await runClassify({ github, core: fakeCore(), context: prCtx(pr, 'labeled') });
    const order = names(github.calls).map((n, i) => (n === 'graphql' ? (github.calls[i].query.includes('disable') ? 'disable' : n) : n));
    expect(order).toContain('disable');
    expect(order.indexOf('disable')).toBeLessThan(order.indexOf('repos.createCommitStatus'));
  });
  it('M2: low result but synchronize with auto-merge on → disabled (new head must be re-evaluated)', async () => {
    const { github, pr } = fakeGithub({ autoMerge: { merge_method: 'squash' } });
    await runClassify({ github, core: fakeCore(), context: prCtx(pr, 'synchronize') });
    expect(gql(github, 'disablePullRequestAutoMerge')).toHaveLength(1);
  });
  it('M2: low result on a non-push event leaves auto-merge alone', async () => {
    const { github, pr } = fakeGithub({ autoMerge: { merge_method: 'squash' } });
    await runClassify({ github, core: fakeCore(), context: prCtx(pr, 'labeled') });
    expect(gql(github, 'disablePullRequestAutoMerge')).toHaveLength(0);
  });
  it('M2: failure to disable auto-merge fails the job and posts no status', async () => {
    const { github, pr } = fakeGithub({ autoMerge: { merge_method: 'squash' }, disableError: 'nope', files: [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }] });
    const core = fakeCore();
    await runClassify({ github, core, context: prCtx(pr) });
    expect(core.failed).toMatch(/auto-merge/i);
    expect(names(github.calls)).not.toContain('repos.createCommitStatus');
  });

  it('L7: a publish failure (labels/comment/status) → setFailed', async () => {
    // labels: [] so the classifier must ADD risk:low and hit the failing write.
    const { github, pr } = fakeGithub({ addLabelsError: true, labels: [] });
    const core = fakeCore();
    await runClassify({ github, core, context: prCtx(pr) });
    expect(core.failed).toMatch(/could not be published/);
  });

  it('H3: a fork PR is classified and reported as never auto-merge eligible', async () => {
    const { github, pr } = fakeGithub({ headRepo: { full_name: 'mallory/r' } });
    const core = fakeCore();
    const r = await runClassify({ github, core, context: prCtx(pr) });
    expect(r.risk).toBe('low');
    expect(core.out).toMatch(/never eligible for auto-merge/i);
  });
});

describe('runEligibility', () => {
  it('eligible low PR → enables squash auto-merge pinned to head SHA', async () => {
    const { github, pr } = fakeGithub();
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0]).toMatchObject({ eligible: true });
    const [m] = gql(github, 'enablePullRequestAutoMerge');
    expect(m.query).toContain('SQUASH');
    expect(m.vars).toEqual({ id: 'PR_node', sha: HEAD });
    expect(core.out).toMatch(/ELIGIBLE/);
    expect(core.failed).toBeNull();
  });

  it('explicit PR numbers (matrix leg) are evaluated without enumerating sweep targets', async () => {
    const { github } = fakeGithub();
    const rows = await runEligibility({ github, core: fakeCore(), context: { repo: REPO, payload: {} }, numbers: [5] });
    expect(rows.map((r) => r.number)).toEqual([5]);
    // The only PR listing allowed is the L1 shared-head check (all open PRs, no base filter);
    // the sweep's target enumeration (base: main) must not run in a matrix leg.
    const lists = github.calls.filter((c) => c.name === 'pulls.list');
    expect(lists.every((c) => c.params.base === undefined)).toBe(true);
  });

  it('H3: fork PR is never eligible and never enabled', async () => {
    const { github, pr } = fakeGithub({ headRepo: { full_name: 'mallory/r' } });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
  });
  it('H3: outsider author is never eligible', async () => {
    const { github, pr } = fakeGithub({ association: 'CONTRIBUTOR' });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
  });

  it('M1/N2: a CI-named impostor next to a genuine successful CI job is rejected as a spoof', async () => {
    const { github, pr } = fakeGithub({ checkRuns: [
      { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
      { id: 77, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: EVIL_SUITE } },
      { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
      { id: 2, name: 'Governance · risk classification', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: GOV_SUITE } },
    ] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons).toHaveLength(1);
    expect(rows[0].reasons[0]).toMatch(/id 77 .*spoof/);
  });
  it('M1: Copilot review on an older SHA is rejected', async () => {
    const { github, pr } = fakeGithub({ reviews: [{ user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' }, commit_id: MOVED, state: 'COMMENTED' }] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
  });

  it('ineligible PR with auto-merge on → disables it and says why', async () => {
    const { github, pr } = fakeGithub({ autoMerge: { merge_method: 'squash' }, threads: [{ isResolved: false }] });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(gql(github, 'disablePullRequestAutoMerge')).toHaveLength(1);
    expect(core.out).toMatch(/1 unresolved review thread/);
  });

  it('L7: review-thread pagination exhaustion → unknown → ineligible', async () => {
    const { github, pr } = fakeGithub({ threadsAlwaysMore: true });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/thread count is unknown/);
  });

  it('stale risk:low label on a restricted change set is not eligible', async () => {
    const { github, pr } = fakeGithub({ files: [{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '+x', changes: 1 }] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
  });

  it('already-clean PR → squash merge pinned to evaluated SHA', async () => {
    const { github, pr } = fakeGithub({ enableError: 'Pull request Pull request is in clean status' });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].action).toMatch(/squash-merged/);
    expect(github.calls.find((c) => c.name === 'pulls.merge').params).toMatchObject({ merge_method: 'squash', sha: HEAD });
  });

  it('M4c: auto-merge disallowed by repo settings → configuration gap in summary, job stays green', async () => {
    const { github, pr } = fakeGithub({ enableError: 'Pull request Auto merge is not allowed for this repository' });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(core.failed).toBeNull();
    expect(rows[0].action).toMatch(/CONFIGURATION GAP/);
    expect(core.warnings.join('\n')).toMatch(/CONFIGURATION GAP.*Allow auto-merge/s); // N6
    expect(core.out).toMatch(/CONFIGURATION GAP.*Allow auto-merge/s);
    expect(names(github.calls)).not.toContain('pulls.merge');
  });

  it('other enable errors fail the job and do not merge', async () => {
    const { github, pr } = fakeGithub({ enableError: 'Something unexpected' });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(core.failed).toMatch(/could not be evaluated/);
    expect(names(github.calls)).not.toContain('pulls.merge');
  });

  it('L7: an evaluation error disables auto-merge that was on', async () => {
    const { github, pr } = fakeGithub({ checksError: true, autoMerge: { merge_method: 'squash' } });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0].action).toMatch(/auto-merge DISABLED/);
    expect(gql(github, 'disablePullRequestAutoMerge')).toHaveLength(1);
    expect(core.failed).toMatch(/could not be evaluated/);
  });

  it('L4: head SHA moved while gathering → no enable, deferred', async () => {
    const { github, pr } = fakeGithub({ headMovesAfterFirstGet: true });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].action).toMatch(/head moved/i);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
    expect(core.failed).toBeNull();
  });
});

describe('N2: CI via the Actions jobs API', () => {
  it('happy path: the ci.yml pull_request run is resolved and its latest-attempt jobs are listed', async () => {
    const { github, pr } = fakeGithub();
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(true);
    const call = github.calls.find((c) => c.name === 'actions.listJobsForWorkflowRun');
    expect(call.params).toMatchObject({ run_id: 900, filter: 'latest' });
  });
  it('masking: real failing job id 5 + impostor success id 99 in the same suite ⇒ ineligible', async () => {
    const { github, pr } = fakeGithub({
      ciJobs: [{ id: 5, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure', run_attempt: 1 }],
      checkRuns: [
        { id: 5, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
        { id: 99, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
        { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
      ],
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
  });
  it('missing CI job ⇒ ineligible', async () => {
    const { github, pr } = fakeGithub({ ciJobs: [] });
    expect((await runEligibility({ github, core: fakeCore(), context: prCtx(pr) }))[0].eligible).toBe(false);
  });
  it('no ci.yml pull_request run for the head ⇒ ineligible', async () => {
    const { github, pr } = fakeGithub({ workflowRuns: [{ id: 901, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'push', run_attempt: 1 }] });
    expect((await runEligibility({ github, core: fakeCore(), context: prCtx(pr) }))[0].eligible).toBe(false);
  });
  it('rerun: the latest attempt decides (attempt 1 failed, attempt 2 passed)', async () => {
    const { github, pr } = fakeGithub({
      ciAttempt: 2,
      ciJobs: (p) => (p.filter === 'latest'
        ? [{ id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', run_attempt: 2 }]
        : [
          { id: 0, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure', run_attempt: 1 },
          { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', run_attempt: 2 },
        ]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(true);
  });
  it('rerun: jobs from an older attempt are ignored even if returned', async () => {
    const { github, pr } = fakeGithub({
      ciAttempt: 2,
      ciJobs: [{ id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', run_attempt: 1 }],
    });
    expect((await runEligibility({ github, core: fakeCore(), context: prCtx(pr) }))[0].eligible).toBe(false);
  });
  it('L1: several qualifying ci.yml runs: EVERY one is checked (all succeed → eligible)', async () => {
    const { github, pr } = fakeGithub({ workflowRuns: [
      { id: 800, check_suite_id: 1, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }] },
      { id: 950, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }] },
    ] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    const ids = github.calls.filter((c) => c.name === 'actions.listJobsForWorkflowRun').map((c) => c.params.run_id).sort();
    expect(ids).toEqual([800, 950]);
    expect(rows[0].eligible).toBe(true);
  });
  it('L1 probe: a newer run listing this PR (triggered by a PR into evilbase) passes, the real run fails ⇒ ineligible', async () => {
    const { github, pr } = fakeGithub({
      workflowRuns: [
        { id: 900, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }] },
        { id: 990, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }, { number: 6, base: { ref: 'evilbase' } }] },
      ],
      ciJobs: (p) => (p.run_id === 900
        ? [{ id: 3, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure', run_attempt: 1 }]
        : [{ id: 99, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', run_attempt: 1 }]),
      checkRuns: [
        { id: 99, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
        { id: 7, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
      ],
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/id 3\b/);
  });
  it('L1: a qualifying run without the CI job ⇒ ineligible even if another run passed', async () => {
    const { github, pr } = fakeGithub({
      workflowRuns: [
        { id: 900, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }] },
        { id: 901, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }] },
      ],
      ciJobs: (p) => (p.run_id === 900
        ? [{ id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', run_attempt: 1 }]
        : []),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/901/);
  });
  it('L1: another open PR with the same head SHA ⇒ ineligible ("head SHA shared with PR #n")', async () => {
    const { github, pr } = fakeGithub();
    const other = { ...pr, number: 6, base: { ref: 'evilbase', repo: { full_name: 'o/r' } } };
    github.rest.pulls.list = async (params) => { github.calls.push({ name: 'pulls.list', params }); return { data: [pr, other] }; };
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons).toContain('head SHA shared with PR #6');
  });
  it('L1: open PRs with other head SHAs do not block', async () => {
    const { github, pr } = fakeGithub();
    const other = { ...pr, number: 6, head: { ...pr.head, sha: MOVED } };
    github.rest.pulls.list = async () => ({ data: [pr, other] });
    expect((await runEligibility({ github, core: fakeCore(), context: prCtx(pr) }))[0].eligible).toBe(true);
  });
});

describe('P1: CI run must belong to this PR (base main)', () => {
  const ciRun = (id, prs, extra = {}) => ({ id, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: prs, ...extra });
  it('a NEWER ci.yml run for another PR / another base / no PR at the same head SHA is ignored', async () => {
    const { github, pr } = fakeGithub({ workflowRuns: [
      ciRun(900, [{ number: 5, base: { ref: 'main' } }]),
      ciRun(990, [{ number: 6, base: { ref: 'main' } }]),
      ciRun(995, [{ number: 5, base: { ref: 'dev' } }]),
      ciRun(999, []),
      ciRun(1000, undefined),
    ] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(github.calls.find((c) => c.name === 'actions.listJobsForWorkflowRun').params.run_id).toBe(900);
    expect(rows[0].eligible).toBe(true);
  });
  it('only runs of other PRs → no CI run → ineligible', async () => {
    const { github, pr } = fakeGithub({ workflowRuns: [ciRun(990, [{ number: 6, base: { ref: 'main' } }])] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(names(github.calls)).not.toContain('actions.listJobsForWorkflowRun');
  });
  it('R2: this PR\'s failing CI job (id 3) + a successful same-name check run from another PR\'s newer run ⇒ ineligible', async () => {
    const { github, pr } = fakeGithub({
      workflowRuns: [ciRun(900, [{ number: 5, base: { ref: 'main' } }]), ciRun(990, [{ number: 6, base: { ref: 'main' } }])],
      ciJobs: (p) => (p.run_id === 900
        ? [{ id: 3, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure', run_attempt: 1 }]
        : [{ id: 99, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', run_attempt: 1 }]),
      checkRuns: [
        { id: 3, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
        { id: 99, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
        { id: 7, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
      ],
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/id 3\b/);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
  });
});

describe('L2: unusual git modes', () => {
  it('challenger probe: docs/evil.md as a gitlink (tree mode 160000) ⇒ restricted unusual-mode', async () => {
    const files = [{ filename: 'docs/evil.md', status: 'added', patch: '+Subproject commit 0123456789abcdef0123456789abcdef01234567', changes: 1 }];
    const { github, pr } = fakeGithub({ labels: [], files, tree: [{ path: 'docs/evil.md', mode: '160000', type: 'commit' }] });
    const r = await runClassify({ github, core: fakeCore(), context: prCtx(pr) });
    expect(r.risk).toBe('restricted');
    expect(r.reasons).toContainEqual({ path: 'docs/evil.md', class: 'unclassified', rule: 'unusual-mode' });
  });
  it('executable mode 100755 is a regular file', async () => {
    const { github, pr } = fakeGithub({ labels: [], tree: [{ path: 'README.md', mode: '100755', type: 'blob' }] });
    expect((await runClassify({ github, core: fakeCore(), context: prCtx(pr) })).risk).toBe('low');
  });
});

describe('P3: symlinks via the git tree API', () => {
  const linkFile = { filename: 'docs/x.md', status: 'added', patch: '+../.env', changes: 1 };
  it('runClassify: an API-shaped docs/x.md symlink (tree mode 120000) is restricted:symlink', async () => {
    const { github, pr } = fakeGithub({ labels: [], files: [linkFile], tree: [{ path: 'docs/x.md', mode: '120000', type: 'blob' }] });
    const r = await runClassify({ github, core: fakeCore(), context: prCtx(pr) });
    expect(r.risk).toBe('restricted');
    expect(r.reasons).toContainEqual({ path: 'docs/x.md', class: 'unclassified', rule: 'symlink' });
    expect(github.calls.find((c) => c.name === 'git.getTree').params).toMatchObject({ tree_sha: HEAD, recursive: 'true' });
  });
  it('runEligibility: a symlink makes the fresh classification restricted → ineligible', async () => {
    const { github, pr } = fakeGithub({ files: [linkFile], tree: [{ path: 'docs/x.md', mode: '120000', type: 'blob' }] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0]).toMatchObject({ eligible: false, risk: 'restricted' });
  });
  it('truncated tree → modes unknown → restricted tree-truncated', async () => {
    const { github, pr } = fakeGithub({ labels: [], treeTruncated: true });
    const r = await runClassify({ github, core: fakeCore(), context: prCtx(pr) });
    expect(r.risk).toBe('restricted');
    expect(r.reasons).toContainEqual(expect.objectContaining({ rule: 'tree-truncated' }));
  });
  it('tree API error → modes unknown → restricted tree-unavailable', async () => {
    const { github, pr } = fakeGithub({ labels: [], treeError: true });
    const r = await runClassify({ github, core: fakeCore(), context: prCtx(pr) });
    expect(r.risk).toBe('restricted');
    expect(r.reasons).toContainEqual(expect.objectContaining({ rule: 'tree-unavailable' }));
  });
  it('regular file modes keep a README-only PR low', async () => {
    const { github, pr } = fakeGithub({ labels: [] });
    expect((await runClassify({ github, core: fakeCore(), context: prCtx(pr) })).risk).toBe('low');
  });
});

const eligStatus = (github) => github.calls.filter((c) => c.name === 'repos.createCommitStatus' && c.params.context === 'Governance · merge eligibility');

describe('C1/M1: eligibility commit status and SHA-bound exception approvals', () => {
  const restrictedFiles = [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }];
  const restrictedLabels = ['risk:restricted', 'restricted:dependencies'];
  let nextId = 1000;
  const cmt = (login, body, o = {}) => ({
    id: o.id ?? nextId++, body, user: { login, type: o.bot ? 'Bot' : 'User' },
    created_at: '2026-10-01T11:00:00Z', updated_at: o.edited ? '2026-10-01T11:05:00Z' : '2026-10-01T11:00:00Z',
  });
  const ADMIN = { boss: { permission: 'admin', role_name: 'admin' }, dev: { permission: 'write', role_name: 'write' } };
  const restrictedPr = (o = {}) => fakeGithub({ files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, ...o });

  it('eligible low PR ⇒ success status on the evaluated head', async () => {
    const { github, pr } = fakeGithub();
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    const [st] = eligStatus(github);
    expect(st.params).toMatchObject({ sha: HEAD, state: 'success' });
  });
  it('native auto-merge on a low PR whose review is missing ⇒ failure status (and auto-merge disabled)', async () => {
    const { github, pr } = fakeGithub({ autoMerge: { merge_method: 'squash' }, reviews: [] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    const [st] = eligStatus(github);
    expect(st.params).toMatchObject({ sha: HEAD, state: 'failure' });
    expect(st.params.description).toMatch(/review/);
    expect(st.params.description.length).toBeLessThanOrEqual(140);
    expect(gql(github, 'disablePullRequestAutoMerge')).toHaveLength(1);
  });
  it('M1: admin /exception-approve <current head> ⇒ success; auto-merge NOT enabled', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('boss', `/exception-approve ${HEAD}`)] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params).toMatchObject({ sha: HEAD, state: 'success' });
    expect(eligStatus(github)[0].params.description).toMatch(/exception/i);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
    expect(rows[0].eligible).toBe(false);
    expect(github.calls.find((c) => c.name === 'repos.getCollaboratorPermissionLevel').params.username).toBe('boss');
    // No timestamps: the head commit is never fetched.
    expect(names(github.calls)).not.toContain('git.getCommit');
  });
  it('M1: approval by a write-only user ⇒ failure', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('dev', `/exception-approve ${HEAD}`)] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('M1: approval for an older SHA ⇒ failure (a new head has no approval)', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('boss', `/exception-approve ${MOVED}`)] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('M1: force-push back to an older SHA that has its own approval ⇒ success (approval binds to content)', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('boss', `/exception-approve ${HEAD}`, { id: 1 }), cmt('boss', `/exception-approve ${MOVED}`, { id: 2 })] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('success');
  });
  it('M1: edited approval comment ⇒ ignored ⇒ failure', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('boss', `/exception-approve ${HEAD}`, { edited: true })] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('M1: /exception-revoke by an admin revokes', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('boss', `/exception-approve ${HEAD}`, { id: 1 }), cmt('boss', `/exception-revoke ${HEAD}`, { id: 2 })] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('M1: malformed SHA ⇒ ignored ⇒ failure', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('boss', `/exception-approve ${HEAD.slice(0, 12)}`)] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('M1: bot-authored approval ⇒ ignored ⇒ failure (permission never even looked up)', async () => {
    const { github, pr } = restrictedPr({ comments: [cmt('github-actions[bot]', `/exception-approve ${HEAD}`, { bot: true })], roles: { 'github-actions[bot]': { permission: 'admin', role_name: 'admin' } } });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
    expect(names(github.calls)).not.toContain('repos.getCollaboratorPermissionLevel');
  });
  it('M1: a legacy exception:approved label grants nothing', async () => {
    const { github, pr } = restrictedPr({ labels: [...restrictedLabels, 'exception:approved'] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('M1: admin approval but Copilot review missing ⇒ failure', async () => {
    const { github, pr } = restrictedPr({ reviews: [], comments: [cmt('boss', `/exception-approve ${HEAD}`)] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('C3: head moved ⇒ auto-merge disabled, pending status on the NEW head, then deferred', async () => {
    const { github, pr } = fakeGithub({ headMovesAfterFirstGet: true, autoMerge: { merge_method: 'squash' } });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0].action).toMatch(/head moved/i);
    expect(gql(github, 'disablePullRequestAutoMerge')).toHaveLength(1);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
    const st = eligStatus(github);
    expect(st).toHaveLength(1);
    expect(st[0].params).toMatchObject({ sha: MOVED, state: 'pending' });
    expect(core.failed).toBeNull();
  });
  it('evaluation error ⇒ failure status on the head (best effort)', async () => {
    const { github, pr } = fakeGithub({ checksError: true });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params).toMatchObject({ sha: HEAD, state: 'failure' });
  });
});

const revokedStatus = (github) => github.calls.filter((c) => c.name === 'repos.createCommitStatus' && c.params.context === 'Governance · exception revoked');

describe('R1: sticky revocation', () => {
  const restrictedFiles = [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }];
  const restrictedLabels = ['risk:restricted', 'restricted:dependencies'];
  const ADMIN = { boss: { permission: 'admin', role_name: 'admin' }, dev: { permission: 'write', role_name: 'write' } };
  const cmt = (id, login, body, edited = false) => ({
    id, body, user: { login, type: 'User' },
    created_at: '2026-10-01T11:00:00Z', updated_at: edited ? '2026-10-01T11:05:00Z' : '2026-10-01T11:00:00Z',
  });
  const approve = cmt(10, 'boss', `/exception-approve ${HEAD}`);
  const commentCtx = (pr, action, comment, changes) => ({
    repo: REPO, payload: { action, issue: { number: pr.number, pull_request: { url: 'x' } }, comment, ...(changes ? { changes } : {}) },
  });

  it('delete-revoke: the deleted admin revoke (event payload) still revokes; sticky status posted on the head', async () => {
    const { github, pr } = fakeGithub({ files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, comments: [approve] });
    const deleted = { id: 77, body: `/exception-revoke ${HEAD}`, user: { login: 'boss', type: 'User' } };
    await runEligibility({ github, core: fakeCore(), context: commentCtx(pr, 'deleted', deleted), numbers: [5] });
    expect(eligStatus(github)[0].params.state).toBe('failure');
    const [st] = revokedStatus(github);
    expect(st.params).toMatchObject({ sha: HEAD, state: 'failure' });
    expect(st.params.description).toBe('exception revoked by @boss in comment 77');
  });
  it('edit-revoke: an admin revoke edited into something else still revokes (old body from the event)', async () => {
    const edited = cmt(78, 'boss', 'hi there', true);
    const { github, pr } = fakeGithub({ files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, comments: [approve, edited] });
    await runEligibility({ github, core: fakeCore(), context: commentCtx(pr, 'edited', edited, { body: { from: `/exception-revoke ${HEAD}` } }), numbers: [5] });
    expect(eligStatus(github)[0].params.state).toBe('failure');
    expect(revokedStatus(github)[0].params).toMatchObject({ sha: HEAD, state: 'failure' });
  });
  it('edited admin approve ⇒ revoked + sticky status posted', async () => {
    const { github, pr } = fakeGithub({ files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, comments: [cmt(10, 'boss', `/exception-approve ${HEAD}`, true)] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
    expect(revokedStatus(github)[0].params).toMatchObject({ sha: HEAD, state: 'failure', description: 'exception revoked by @boss in comment 10' });
  });
  it('a later deletion of the revoke comment cannot revive the approval (sticky status from the Actions app)', async () => {
    const { github, pr } = fakeGithub({
      files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, comments: [approve],
      statusesBySha: { [HEAD]: [{ context: 'Governance · exception revoked', state: 'failure', description: 'exception revoked by @boss in comment 11', creator: { login: 'github-actions[bot]', type: 'Bot' } }] },
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('failure');
    expect(eligStatus(github)[0].params.description).toMatch(/permanently/);
    expect(revokedStatus(github)).toHaveLength(0); // already recorded; no duplicate
  });
  it('a revocation status from a non-Actions source is ignored (no writer DoS)', async () => {
    const forged = { context: 'Governance · exception revoked', state: 'failure', description: 'x', creator: { login: 'mallory', type: 'User' } };
    const { github, pr } = fakeGithub({
      files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, comments: [approve],
      statusesBySha: { [HEAD]: [forged] },
      // Realistic: the combined status for the head also lists the forged status.
      statuses: [{ context: forged.context, state: forged.state }],
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('success');
  });
  it('a revoke naming an older SHA posts the sticky status on THAT SHA', async () => {
    const { github, pr } = fakeGithub({ files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, comments: [approve, cmt(11, 'boss', `/exception-revoke ${MOVED}`)] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    // Q1: the revoked SHA gets an eligibility failure (before its marker); the head's decision is unaffected.
    expect(eligStatus(github).filter((c) => c.params.sha === HEAD).map((c) => c.params.state)).toEqual(['success']);
    expect(eligStatus(github).filter((c) => c.params.sha === MOVED).map((c) => c.params.state)).toEqual(['failure']);
    expect(revokedStatus(github).map((c) => c.params.sha)).toEqual([MOVED]);
  });
  it('R3: approval with an evidence link on line 2 ⇒ success', async () => {
    const { github, pr } = fakeGithub({ files: restrictedFiles, labels: restrictedLabels, roles: ADMIN, comments: [cmt(10, 'boss', `/exception-approve ${HEAD}\nChallenger evidence: https://example.test/pr/45#review`)] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)[0].params.state).toBe('success');
  });
  it('R4: low-risk PRs never fetch comments', async () => {
    const { github, pr } = fakeGithub();
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(names(github.calls)).not.toContain('issues.listComments');
  });
});

const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const statusCallsOrder = (github) => github.calls
  .filter((c) => c.name === 'repos.createCommitStatus')
  .map((c) => `${c.params.context}@${c.params.sha.slice(0, 1)}:${c.params.state}`);

describe('Q1: eligibility status is posted only when it changes; cap errors are red', () => {
  const LOW_OK = 'Eligible: risk:low and every gate passed.';
  it('unchanged decision (latest bot status has the same state+description) posts nothing', async () => {
    const { github, pr } = fakeGithub({ statusesBySha: { [HEAD]: [{ context: 'Governance · merge eligibility', state: 'success', description: LOW_OK, creator: BOT }] } });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)).toHaveLength(0);
  });
  it('only the LATEST bot status counts (API lists newest first)', async () => {
    const { github, pr } = fakeGithub({ statusesBySha: { [HEAD]: [
      { context: 'Governance · merge eligibility', state: 'failure', description: 'x', creator: BOT },
      { context: 'Governance · merge eligibility', state: 'success', description: LOW_OK, creator: BOT },
    ] } });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)).toHaveLength(1);
    expect(eligStatus(github)[0].params.state).toBe('success');
  });
  it('a matching status by someone else does not count — the bot status is posted', async () => {
    const { github, pr } = fakeGithub({ statusesBySha: { [HEAD]: [{ context: 'Governance · merge eligibility', state: 'success', description: LOW_OK, creator: { login: 'mallory', type: 'User' } }] } });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)).toHaveLength(1);
  });
  it('changed decision posts', async () => {
    const { github, pr } = fakeGithub({ reviews: [], statusesBySha: { [HEAD]: [{ context: 'Governance · merge eligibility', state: 'success', description: LOW_OK, creator: BOT }] } });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)).toHaveLength(1);
    expect(eligStatus(github)[0].params.state).toBe('failure');
  });
  it('deferral path: fetches the new head\'s statuses and skips an unchanged pending', async () => {
    const { github, pr } = fakeGithub({
      headMovesAfterFirstGet: true,
      statusesBySha: { [MOVED]: [{ context: 'Governance · merge eligibility', state: 'pending', description: 'Head moved during evaluation; re-evaluation pending.', creator: BOT }] },
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github)).toHaveLength(0);
    expect(github.calls.some((c) => c.name === 'repos.listCommitStatusesForRef' && c.params.ref === MOVED)).toBe(true);
  });
  it('if fetching existing statuses fails on the deferral path, post anyway', async () => {
    const { github, pr } = fakeGithub({ headMovesAfterFirstGet: true });
    const orig = github.rest.repos.listCommitStatusesForRef;
    github.rest.repos.listCommitStatusesForRef = async (p) => {
      if (p.ref === MOVED) throw Object.assign(new Error('boom'), { status: 500 });
      return orig(p);
    };
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(eligStatus(github).map((c) => c.params.state)).toEqual(['pending']);
  });
  it('revocation: eligibility failure is posted BEFORE the "exception revoked" marker', async () => {
    const restrictedFiles = [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }];
    const edited = { id: 10, body: `/exception-approve ${HEAD}`, user: { login: 'boss', type: 'User' }, created_at: 'a', updated_at: 'b' };
    const { github, pr } = fakeGithub({ files: restrictedFiles, labels: ['risk:restricted'], roles: { boss: { permission: 'admin', role_name: 'admin' } }, comments: [edited] });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    const order = statusCallsOrder(github);
    const firstFail = order.indexOf('Governance · merge eligibility@b:failure');
    const marker = order.indexOf('Governance · exception revoked@b:failure');
    expect(firstFail).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(firstFail);
  });
  it('cap error (1000 statuses per SHA+context) ⇒ surfaced as an error and the job fails', async () => {
    const { github, pr } = fakeGithub({
      statusError: (p) => (p.context === 'Governance · merge eligibility'
        ? Object.assign(new Error('This SHA and context has reached the maximum number of statuses.'), { status: 422 })
        : undefined),
    });
    const core = fakeCore();
    await runEligibility({ github, core, context: prCtx(pr) });
    expect(core.failed).toBeTruthy();
    expect(core.errors.join('\n')).toMatch(/maximum number of statuses.*push a new commit/is);
  });
});

describe('Q4: an already-marked SHA is never marked again', () => {
  const restrictedFiles = [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }];
  const ADMIN = { boss: { permission: 'admin', role_name: 'admin' } };
  const cm = (id, body) => ({ id, body, user: { login: 'boss', type: 'User' }, created_at: 'a', updated_at: 'a' });
  const marker = { context: 'Governance · exception revoked', state: 'failure', description: 'exception revoked by @boss in comment 11', creator: BOT };
  it('second revocation for the marked head posts no marker (and no extra eligibility failure from recording)', async () => {
    const { github, pr } = fakeGithub({
      files: restrictedFiles, labels: ['risk:restricted'], roles: ADMIN,
      comments: [cm(10, `/exception-approve ${HEAD}`), cm(11, `/exception-revoke ${HEAD}`), cm(12, `/exception-revoke ${HEAD}`)],
      statusesBySha: { [HEAD]: [marker] },
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(revokedStatus(github)).toHaveLength(0);
    expect(eligStatus(github)).toHaveLength(1); // only the decision itself
  });
  it('second revocation for a marked OTHER SHA posts nothing on it', async () => {
    const { github, pr } = fakeGithub({
      files: restrictedFiles, labels: ['risk:restricted'], roles: ADMIN,
      comments: [cm(10, `/exception-approve ${HEAD}`), cm(11, `/exception-revoke ${MOVED}`)],
      statusesBySha: { [MOVED]: [marker] },
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(github.calls.filter((c) => c.name === 'repos.createCommitStatus' && c.params.sha === MOVED)).toHaveLength(0);
  });
});

describe('Q2: revocations job (edited/deleted comment events)', () => {
  const ev = (action, comment, changes) => ({ action, issue: { number: 5, pull_request: { url: 'x' } }, comment, ...(changes ? { changes } : {}) });
  const boss = { login: 'boss', type: 'User' };
  it('revocationFromEvent: deleted command ⇒ revocation of the SHA it named', () => {
    expect(revocationFromEvent(ev('deleted', { id: 7, body: `/exception-revoke ${HEAD}\nwhy`, user: boss })))
      .toEqual({ sha: HEAD, login: 'boss', commentId: 7, why: 'edited-or-deleted', prNumber: 5 });
  });
  it('revocationFromEvent: edited command uses the PREVIOUS body', () => {
    expect(revocationFromEvent(ev('edited', { id: 8, body: 'hi', user: boss }, { body: { from: `/exception-approve ${HEAD}` } })))
      .toMatchObject({ sha: HEAD, commentId: 8 });
    expect(revocationFromEvent(ev('edited', { id: 8, body: `/exception-approve ${HEAD}`, user: boss }, { title: { from: 'x' } }))).toBeNull();
  });
  it('revocationFromEvent: created, non-PR, bot, malformed ⇒ null', () => {
    expect(revocationFromEvent(ev('created', { id: 1, body: `/exception-revoke ${HEAD}`, user: boss }))).toBeNull();
    expect(revocationFromEvent({ ...ev('deleted', { id: 1, body: `/exception-revoke ${HEAD}`, user: boss }), issue: { number: 9 } })).toBeNull();
    expect(revocationFromEvent(ev('deleted', { id: 1, body: `/exception-revoke ${HEAD}`, user: BOT }))).toBeNull();
    expect(revocationFromEvent(ev('deleted', { id: 1, body: '/exception-revoke abc', user: boss }))).toBeNull();
  });
  it('runRevocations: admin ⇒ eligibility failure then marker on that SHA', async () => {
    const { github } = fakeGithub({ roles: { boss: { permission: 'admin', role_name: 'admin' } } });
    await runRevocations({ github, core: fakeCore(), context: { repo: REPO, payload: ev('deleted', { id: 7, body: `/exception-revoke ${HEAD}`, user: boss }) } });
    expect(statusCallsOrder(github)).toEqual(['Governance · merge eligibility@b:failure', 'Governance · exception revoked@b:failure']);
    expect(revokedStatus(github)[0].params.description).toBe('exception revoked by @boss in comment 7');
  });
  it('runRevocations: write-only author ⇒ nothing posted', async () => {
    const { github } = fakeGithub({ roles: { boss: { permission: 'write', role_name: 'write' } } });
    await runRevocations({ github, core: fakeCore(), context: { repo: REPO, payload: ev('deleted', { id: 7, body: `/exception-revoke ${HEAD}`, user: boss }) } });
    expect(names(github.calls)).not.toContain('repos.createCommitStatus');
  });
  it('runRevocations: already marked ⇒ nothing posted', async () => {
    const { github } = fakeGithub({
      roles: { boss: { permission: 'admin', role_name: 'admin' } },
      statusesBySha: { [HEAD]: [{ context: 'Governance · exception revoked', state: 'failure', description: 'd', creator: BOT }] },
    });
    await runRevocations({ github, core: fakeCore(), context: { repo: REPO, payload: ev('deleted', { id: 7, body: `/exception-revoke ${HEAD}`, user: boss }) } });
    expect(names(github.calls)).not.toContain('repos.createCommitStatus');
  });
});

describe('M1: label mechanism removed', () => {
  it('classify on synchronize does not touch an exception:approved label', async () => {
    const { github, pr } = fakeGithub({ labels: ['risk:low', 'exception:approved'] });
    await runClassify({ github, core: fakeCore(), context: prCtx(pr, 'synchronize') });
    expect(github.calls.filter((c) => c.name === 'issues.removeLabel').map((c) => c.params.name)).not.toContain('exception:approved');
  });
});

describe('PR #47 regression via the API: governance suites are resolved to their workflow run', () => {
  const GOV_RUN = { id: 37101786595, check_suite_id: GOV_SUITE, path: '.github/workflows/governance.yml', event: 'pull_request_target', head_repository: { full_name: 'o/r' } };
  const CI_RUN = { id: 900, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }], head_repository: { full_name: 'o/r' } };
  const govRuns = [
    { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
    { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
    { id: 101, name: 'Governance · risk classification', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: GOV_SUITE } },
    { id: 102, name: 'Governance · eligibility targets', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: GOV_SUITE } },
    { id: 103, name: 'Governance · merge eligibility (#5)', status: 'in_progress', conclusion: null, app: { id: 15368 }, check_suite: { id: GOV_SUITE } },
    { id: 104, name: 'Governance · revocations', status: 'completed', conclusion: 'skipped', app: { id: 15368 }, check_suite: { id: GOV_SUITE } },
  ];
  // The head_sha listing (filtered to pull_request events) does not include the
  // pull_request_target run; it is resolved by check_suite_id.
  const runsApi = (p) => (p.check_suite_id === GOV_SUITE ? [GOV_RUN] : p.check_suite_id !== undefined ? [] : [CI_RUN]);

  it('#47 shape: own governance runs (incl. skipped revocations, in-progress eligibility) do not block', async () => {
    const { github, pr } = fakeGithub({ checkRuns: govRuns, workflowRuns: runsApi });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].reasons).toEqual([]);
    expect(rows[0].eligible).toBe(true);
    expect(github.calls.some((c) => c.name === 'actions.listWorkflowRunsForRepo' && c.params.check_suite_id === GOV_SUITE)).toBe(true);
  });
  it('an impostor "Governance · revocations" in a suite from another workflow is refused', async () => {
    const evil = { id: 55, check_suite_id: EVIL_SUITE, path: '.github/workflows/evil.yml', event: 'pull_request', head_repository: { full_name: 'o/r' } };
    const { github, pr } = fakeGithub({
      checkRuns: [...govRuns, { id: 300, name: 'Governance · revocations', status: 'completed', conclusion: 'skipped', app: { id: 15368 }, check_suite: { id: EVIL_SUITE } }],
      workflowRuns: (p) => (p.check_suite_id === EVIL_SUITE ? [evil] : runsApi(p)),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/Governance · revocations/);
  });
  it('if the governance suite cannot be resolved, its runs are ordinary checks (fail closed)', async () => {
    const { github, pr } = fakeGithub({ checkRuns: govRuns, workflowRuns: (p) => (p.check_suite_id !== undefined ? [] : [CI_RUN]) });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
  });
  it('our own failed risk classification still refuses', async () => {
    const runs = govRuns.map((r) => (r.id === 101 ? { ...r, conclusion: 'failure' } : r));
    const { github, pr } = fakeGithub({ checkRuns: runs, workflowRuns: runsApi });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/risk classification/);
  });
});

describe('round 2: classify supersession, lookup failures, suite matching, forks', () => {
  const GOV2 = 201;
  const CI_RUN = { id: 900, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }], head_repository: { full_name: 'o/r' } };
  const govRun = (id, suite, o = {}) => ({ id, check_suite_id: suite, path: '.github/workflows/governance.yml', event: 'pull_request_target', head_repository: { full_name: 'o/r' }, repository: { full_name: 'o/r' }, ...o });
  const base = [
    { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
    { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
  ];
  const classify = (id, suite, conclusion) => ({ id, name: 'Governance · risk classification', status: 'completed', conclusion, app: { id: 15368 }, check_suite: { id: suite } });

  it('M1: two governance suites (older classify cancelled, newer success) resolved by check_suite_id ⇒ eligible', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, classify(101, GOV_SUITE, 'cancelled'), classify(205, GOV2, 'success'),
        { id: 206, name: 'Governance · revocations', status: 'completed', conclusion: 'skipped', app: { id: 15368 }, check_suite: { id: GOV2 } }],
      workflowRuns: (p) => (p.check_suite_id === GOV_SUITE ? [govRun(1, GOV_SUITE)] : p.check_suite_id === GOV2 ? [govRun(2, GOV2)] : p.check_suite_id !== undefined ? [] : [CI_RUN]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].reasons).toEqual([]);
    expect(rows[0].eligible).toBe(true);
  });
  it('L2/L3: a check_suite_id lookup that throws (403/429) leaves the PR not eligible and is logged as a warning', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, classify(101, GOV_SUITE, 'success')],
      workflowRuns: (p) => (p.check_suite_id !== undefined ? Object.assign(new Error('API rate limit exceeded'), { status: 429 }) : [CI_RUN]),
    });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(core.warnings.join('\n')).toMatch(new RegExp(`check suite ${GOV_SUITE}.*429`, 's'));
  });
  it("L6: a lookup returning ANOTHER suite's run does not resolve this suite", async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, classify(101, GOV_SUITE, 'success')],
      workflowRuns: (p) => (p.check_suite_id === GOV_SUITE ? [govRun(9, 999)] : p.check_suite_id !== undefined ? [] : [CI_RUN]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
  });
  it('L6: head_repository (not repository) decides — a fork head with the base as repository is not ours', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, classify(101, GOV_SUITE, 'success')],
      workflowRuns: (p) => (p.check_suite_id === GOV_SUITE ? [govRun(9, GOV_SUITE, { head_repository: { full_name: 'mallory/r' } })] : p.check_suite_id !== undefined ? [] : [CI_RUN]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/risk classification/);
  });
  it('L1: our workflow\'s run from a workflow_dispatch event is not ours — a skipped revocations from it blocks', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, classify(101, GOV_SUITE, 'success'),
        { id: 300, name: 'Governance · revocations', status: 'completed', conclusion: 'skipped', app: { id: 15368 }, check_suite: { id: GOV2 } }],
      workflowRuns: (p) => (p.check_suite_id === GOV_SUITE ? [govRun(1, GOV_SUITE)] : p.check_suite_id === GOV2 ? [govRun(2, GOV2, { event: 'workflow_dispatch' })] : p.check_suite_id !== undefined ? [] : [CI_RUN]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/Governance · revocations/);
  });
});

describe('PR #49 Copilot M: suite lookups are limited to governance-named Actions runs, batched and memoised', () => {
  const CI_RUN = { id: 900, check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml', event: 'pull_request', run_attempt: 1, pull_requests: [{ number: 5, base: { ref: 'main' } }], head_repository: { full_name: 'o/r' } };
  const govRun = (suite) => ({ id: 37101786595, check_suite_id: suite, path: '.github/workflows/governance.yml', event: 'pull_request_target', head_repository: { full_name: 'o/r' } });
  const cr = (id, name, suite, o = {}) => ({ id, name, status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: suite }, ...o });
  const base = [
    cr(1, 'Lint · Typecheck · Test · Build', CI_SUITE),
    cr(3, 'copilot-pull-request-reviewer', COPILOT_SUITE),
  ];
  const gov = (suite) => [
    cr(101, 'Governance · risk classification', suite),
    cr(102, 'Governance · eligibility targets', suite),
    cr(103, 'Governance · merge eligibility (#5)', suite, { status: 'in_progress', conclusion: null }),
    cr(104, 'Governance · revocations', suite, { conclusion: 'skipped' }),
  ];
  const suiteLookups = (github) => github.calls.filter((c) => c.name === 'actions.listWorkflowRunsForRepo' && c.params.check_suite_id !== undefined);
  const prtListings = (github) => github.calls.filter((c) => c.name === 'actions.listWorkflowRunsForRepo' && c.params.event === 'pull_request_target');

  it('N third-party suites (incl. governance-named, other app) + M non-governance Actions suites ⇒ zero check_suite_id lookups', async () => {
    const thirdParty = Array.from({ length: 5 }, (_, i) => cr(500 + i,
      ['Governance · risk classification', 'Governance · revocations', 'Governance · merge eligibility (#5)', 'Governance · eligibility targets', 'sonar'][i],
      1000 + i, { app: { id: 999 } }));
    const otherActions = Array.from({ length: 4 }, (_, i) => cr(600 + i, ['build', 'lint', 'Governance', 'Governance · something else'][i], 2000 + i));
    const { github, pr } = fakeGithub({
      checkRuns: [...base, ...thirdParty, ...otherActions],
      workflowRuns: (p) => (p.check_suite_id !== undefined ? [] : [CI_RUN]),
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(suiteLookups(github)).toHaveLength(0);
    expect(prtListings(github)).toHaveLength(0);
  });
  it('one governance suite resolved by the head_sha pull_request_target listing ⇒ zero check_suite_id lookups, eligible', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, ...gov(GOV_SUITE)],
      workflowRuns: (p) => (p.check_suite_id !== undefined ? [] : p.event === 'pull_request_target' ? [govRun(GOV_SUITE)] : [CI_RUN]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].reasons).toEqual([]);
    expect(prtListings(github)).toHaveLength(1);
    expect(prtListings(github)[0].params).toMatchObject({ head_sha: HEAD, event: 'pull_request_target' });
    expect(suiteLookups(github)).toHaveLength(0);
  });
  it('one governance suite NOT in the listing ⇒ exactly one check_suite_id lookup, eligible', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, ...gov(GOV_SUITE)],
      workflowRuns: (p) => (p.check_suite_id === GOV_SUITE ? [govRun(GOV_SUITE)] : p.check_suite_id !== undefined ? [] : p.event === 'pull_request_target' ? [] : [CI_RUN]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(true);
    expect(suiteLookups(github).map((c) => c.params.check_suite_id)).toEqual([GOV_SUITE]);
  });
  it('a failing pull_request_target listing falls back to check_suite_id lookups (and warns)', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, ...gov(GOV_SUITE)],
      workflowRuns: (p) => (p.event === 'pull_request_target' ? Object.assign(new Error('rate limited'), { status: 429 })
        : p.check_suite_id === GOV_SUITE ? [govRun(GOV_SUITE)] : p.check_suite_id !== undefined ? [] : [CI_RUN]),
    });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: prCtx(pr) });
    expect(rows[0].eligible).toBe(true);
    expect(suiteLookups(github)).toHaveLength(1);
    expect(core.warnings.join('\n')).toMatch(/pull_request_target.*429/s);
  });
  it('an impostor "Governance · revocations" from another app triggers no lookup and is still refused', async () => {
    const { github, pr } = fakeGithub({
      checkRuns: [...base, ...gov(GOV_SUITE), cr(300, 'Governance · revocations', 3000, { app: { id: 999 }, conclusion: 'skipped' })],
      workflowRuns: (p) => (p.check_suite_id === GOV_SUITE ? [govRun(GOV_SUITE)] : p.check_suite_id !== undefined ? [] : p.event === 'pull_request_target' ? [] : [CI_RUN]),
    });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/Governance · revocations/);
    expect(suiteLookups(github).map((c) => c.params.check_suite_id)).toEqual([GOV_SUITE]);
  });
  it('memoised within a sweep: the same suite and head listing are fetched once across evaluations', async () => {
    const { github } = fakeGithub({
      checkRuns: [...base, ...gov(GOV_SUITE)],
      workflowRuns: (p) => (p.check_suite_id === GOV_SUITE ? [govRun(GOV_SUITE)] : p.check_suite_id !== undefined ? [] : p.event === 'pull_request_target' ? [] : [CI_RUN]),
    });
    await runEligibility({ github, core: fakeCore(), context: { repo: REPO, payload: { schedule: 'x' } }, numbers: [5, 5] });
    expect(suiteLookups(github)).toHaveLength(1);
    expect(prtListings(github)).toHaveLength(1);
  });
});

describe('runTargets', () => {
  it('PR event → that PR', async () => {
    const { github, pr } = fakeGithub();
    const core = fakeCore();
    expect(await runTargets({ github, core, context: prCtx(pr) })).toEqual([5]);
    expect(core.outputs.prs).toBe('[5]');
  });
  it('P2: caps at 200 newest-updated first, rotating by sweep slot so every PR is eventually covered', async () => {
    const { github } = fakeGithub();
    // PR #1 is the most recently updated, #230 the oldest.
    const many = Array.from({ length: 230 }, (_, i) => ({ number: i + 1, head: { sha: 'x' }, updated_at: new Date(Date.UTC(2026, 0, 1) + (230 - i) * 60000).toISOString() }));
    github.rest.pulls.list = async (params) => { github.calls.push({ name: 'pulls.list', params }); return { data: many }; };
    const sweep = async (iso) => {
      const core = fakeCore();
      const nums = await runTargets({ github, core, context: { repo: REPO, payload: { schedule: 'x' } }, now: new Date(iso) });
      expect(core.warnings.join('\n')).toMatch(/200/);
      return nums;
    };
    const first = await sweep('2026-10-03T00:07:00Z'); // slot 0 → offset 0
    expect(first).toHaveLength(200);
    expect(first[0]).toBe(1); // newest first
    expect(first).not.toContain(201);
    const second = await sweep('2026-10-03T00:37:00Z'); // slot 1 → offset 200 (wraps)
    expect(second).toHaveLength(200);
    expect(second[0]).toBe(201);
    expect(second).toContain(230);
    expect(second).toContain(1); // wrapped around
    const covered = new Set([...first, ...second]);
    expect(covered.size).toBe(230);
  });
  it('P2: small lists are not rotated or capped', async () => {
    const { github } = fakeGithub();
    const few = [3, 1, 2].map((n) => ({ number: n, head: { sha: 'x' }, updated_at: new Date(Date.UTC(2026, 0, n)).toISOString() }));
    github.rest.pulls.list = async () => ({ data: few });
    const core = fakeCore();
    expect(await runTargets({ github, core, context: { repo: REPO, payload: {} }, now: new Date('2026-10-03T13:37:00Z') })).toEqual([3, 2, 1]);
    expect(core.warnings).toEqual([]);
  });

  it('issue_comment on a PR → that PR (approval comments are evaluated immediately)', async () => {
    const { github } = fakeGithub();
    const core = fakeCore();
    // #42 is not in the open-PR list (only #5 is), so a sweep fallback would not produce [42].
    expect(await runTargets({ github, core, context: { repo: REPO, payload: { issue: { number: 42, pull_request: { url: 'x' } }, comment: { id: 1 } } } })).toEqual([42]);
    expect(names(github.calls)).not.toContain('pulls.list');
  });
  it('issue_comment on a plain issue → nothing', async () => {
    const { github } = fakeGithub();
    const core = fakeCore();
    expect(await runTargets({ github, core, context: { repo: REPO, payload: { issue: { number: 9 }, comment: { id: 1 } } } })).toEqual([]);
    expect(names(github.calls)).not.toContain('pulls.list');
  });

  it('L7: sweep lists only open PRs based on main', async () => {
    const { github } = fakeGithub();
    const core = fakeCore();
    await runTargets({ github, core, context: { repo: REPO, payload: { schedule: '7,37 * * * *' } } });
    expect(github.calls.find((c) => c.name === 'pulls.list').params).toMatchObject({ state: 'open', base: 'main' });
  });
  it('workflow_run without PR list → matches open PRs by head SHA', async () => {
    const { github } = fakeGithub();
    const nums = await runTargets({ github, core: fakeCore(), context: { repo: REPO, payload: { workflow_run: { pull_requests: [], head_sha: HEAD } } } });
    expect(nums).toEqual([5]);
  });
});

// Trusted-actor QA-bar wiring: the classify report must not send the owner to
// the exception queue for a trusted-bot restricted PR that provably does not
// touch the governance gate's own files, and eligibility must enable
// auto-merge there; gate-file edits keep the exception path for any author.
describe('trusted-actor QA-bar wiring (report + eligibility)', () => {
  const BOT = { user: { login: 'obvious-autobuild[bot]' } };
  const MIGRATION = { filename: 'src/ingest/db/migrations/0002.up.sql', status: 'added', patch: '+create table x();', changes: 1 };
  const GOV_FILE = { filename: '.github/workflows/governance.yml', status: 'modified', patch: '+x', changes: 1 };

  it('runClassify: trusted bot + restricted + gate-clear → summary states the QA bar, no exception queue', async () => {
    const { github, pr } = fakeGithub({
      association: 'CONTRIBUTOR',
      labels: [],
      files: [MIGRATION],
      pr: BOT,
    });
    const core = fakeCore();
    const result = await runClassify({ github, core, context: prCtx(pr) });
    expect(result.risk).toBe('restricted');
    expect(core.out).toMatch(/Auto-merge at the QA bar/);
    expect(core.out).toMatch(/obvious-autobuild\[bot\]/);
    expect(core.out).not.toMatch(/Exception queue/);
    expect(core.out).not.toMatch(/first line is exactly/);
  });

  it('runClassify: trusted bot touching the gate → summary keeps the exception queue', async () => {
    const { github, pr } = fakeGithub({
      association: 'CONTRIBUTOR',
      labels: [],
      files: [GOV_FILE],
      pr: BOT,
    });
    const core = fakeCore();
    const result = await runClassify({ github, core, context: prCtx(pr) });
    expect(result.risk).toBe('restricted');
    expect(core.out).toMatch(/Exception queue/);
    expect(core.out).not.toMatch(/Auto-merge at the QA bar/);
  });

  it('runClassify: a non-trusted CONTRIBUTOR restricted PR still gets the exception queue (unchanged)', async () => {
    const { github, pr } = fakeGithub({
      association: 'CONTRIBUTOR',
      labels: [],
      files: [MIGRATION],
      pr: { user: { login: 'random-contributor' } },
    });
    const core = fakeCore();
    await runClassify({ github, core, context: prCtx(pr) });
    expect(core.out).toMatch(/Exception queue/);
    expect(core.out).not.toMatch(/Auto-merge at the QA bar/);
  });

  it('runEligibility: trusted bot + restricted + green gates → enables squash auto-merge, success status', async () => {
    const { github, pr } = fakeGithub({
      association: 'CONTRIBUTOR',
      labels: ['risk:restricted'],
      files: [MIGRATION],
      pr: BOT,
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(1);
    expect(github.calls.find((c) => c.name === 'repos.createCommitStatus').params)
      .toMatchObject({ sha: HEAD, state: 'success', context: 'Governance · merge eligibility' });
  });

  it('runEligibility: trusted bot touching the gate → disables auto-merge, failure status naming the QA bar', async () => {
    const { github, pr } = fakeGithub({
      association: 'CONTRIBUTOR',
      labels: ['risk:restricted'],
      files: [GOV_FILE],
      autoMerge: { merge_method: 'squash' },
      pr: BOT,
    });
    await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(gql(github, 'disablePullRequestAutoMerge')).toHaveLength(1);
    expect(gql(github, 'enablePullRequestAutoMerge')).toHaveLength(0);
    expect(github.calls.find((c) => c.name === 'repos.createCommitStatus').params)
      .toMatchObject({ sha: HEAD, state: 'failure', context: 'Governance · merge eligibility' });
    // The failure description names the actionable next step: the exception
    // path (the QA-bar-does-not-apply reason is in the decision's reason list).
    expect(github.calls.find((c) => c.name === 'repos.createCommitStatus').params.description)
      .toMatch(/exception-approve/);
  });
});
