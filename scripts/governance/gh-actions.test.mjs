// Workflow glue tested against an in-memory fake of the github-script Octokit.
import { describe, it, expect } from 'vitest';
import {
  runClassify, runEligibility, runTargets, upsertReportComment, fetchChangeSet, mainProtection,
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
      },
      repos: {
        getBranch: rec('repos.getBranch', opts.branchError ? err('x', 403) : { protected: true }),
        getBranchRules: rec('repos.getBranchRules', opts.rulesError ? err('x', 404) : (opts.rules ?? [])),
        createCommitStatus: rec('repos.createCommitStatus', {}),
        getCombinedStatusForRef: rec('repos.getCombinedStatusForRef', { statuses: opts.statuses ?? [] }),
      },
      checks: {
        listForRef: rec('checks.listForRef', opts.checksError ? err('boom', 500) : (opts.checkRuns ?? [
          { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: CI_SUITE } },
          { id: 2, name: 'Governance · risk classification', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: GOV_SUITE } },
          { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
        ])),
      },
      actions: {
        listWorkflowRunsForRepo: rec('actions.listWorkflowRunsForRepo', opts.workflowRuns ?? [
          { check_suite_id: CI_SUITE, path: '.github/workflows/ci.yml' },
          { check_suite_id: GOV_SUITE, path: '.github/workflows/governance.yml' },
          { check_suite_id: COPILOT_SUITE, path: 'dynamic/agents/copilot-pull-request-reviewer' },
          { check_suite_id: EVIL_SUITE, path: '.github/workflows/evil.yml' },
        ]),
      },
    },
  };
  return { github, pr };
}

function fakeCore() {
  const core = {
    out: '', failed: null, warnings: [], outputs: {},
    info: () => {}, warning: (m) => core.warnings.push(m), setFailed: (m) => { core.failed = m; },
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
  it('H2: only removals and pure renames may lack a patch', async () => {
    const { github } = fakeGithub({ files: [
      { filename: 'docs/old.md', status: 'removed', changes: 3 },
      { filename: 'docs/new.md', previous_filename: 'docs/prev.md', status: 'renamed', changes: 0 },
      { filename: 'docs/edited.md', previous_filename: 'docs/p2.md', status: 'renamed', changes: 4 },
      { filename: 'x.md', status: 'modified', changes: 3 },
    ] });
    const cs = await fetchChangeSet(github, REPO, { number: 5, changed_files: 5 });
    expect(cs.files.map((f) => f.patchUnavailable)).toEqual([false, false, true, true]);
    expect(cs.truncated).toBe(true);
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
    const { github, pr } = fakeGithub({ addLabelsError: true });
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

  it('explicit PR numbers (matrix leg) are evaluated without listing PRs', async () => {
    const { github } = fakeGithub();
    const rows = await runEligibility({ github, core: fakeCore(), context: { repo: REPO, payload: {} }, numbers: [5] });
    expect(rows.map((r) => r.number)).toEqual([5]);
    expect(names(github.calls)).not.toContain('pulls.list');
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

  it('M1: CI check that maps to another workflow path is rejected', async () => {
    const { github, pr } = fakeGithub({ checkRuns: [
      { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: EVIL_SUITE } },
      { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: COPILOT_SUITE } },
    ] });
    const rows = await runEligibility({ github, core: fakeCore(), context: prCtx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(rows[0].reasons.join('\n')).toMatch(/ci\.yml/);
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

describe('runTargets', () => {
  it('PR event → that PR', async () => {
    const { github, pr } = fakeGithub();
    const core = fakeCore();
    expect(await runTargets({ github, core, context: prCtx(pr) })).toEqual([5]);
    expect(core.outputs.prs).toBe('[5]');
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
