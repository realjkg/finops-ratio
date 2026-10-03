// Workflow glue tested against an in-memory fake of the github-script Octokit.
import { describe, it, expect } from 'vitest';
import { runClassify, runEligibility, upsertReportComment, fetchChangeSet } from './gh-actions.mjs';
import { REPORT_MARKER } from './report.mjs';

const REPO = { owner: 'o', repo: 'r' };
const HEAD = 'b'.repeat(40);

function fakeGithub(opts = {}) {
  const calls = [];
  const rec = (name, ret) => async (params) => {
    calls.push({ name, params });
    const v = typeof ret === 'function' ? ret(params) : ret;
    if (v instanceof Error) throw v;
    return { data: v };
  };
  const pr = {
    number: 5,
    node_id: 'PR_node',
    draft: false,
    base: { ref: 'main' },
    head: { sha: HEAD },
    labels: (opts.labels ?? ['risk:low']).map((name) => ({ name })),
    changed_files: (opts.files ?? [{ filename: 'README.md', status: 'modified', patch: '+hi', changes: 1 }]).length,
    auto_merge: opts.autoMerge ?? null,
    ...(opts.pr ?? {}),
  };
  const github = {
    calls,
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query, vars) => {
      calls.push({ name: 'graphql', query, vars });
      if (query.includes('reviewThreads')) {
        return { repository: { pullRequest: { reviewThreads: { nodes: opts.threads ?? [], pageInfo: { hasNextPage: false } } } } };
      }
      if (query.includes('enablePullRequestAutoMerge') && opts.enableError) throw new Error(opts.enableError);
      return {};
    },
    rest: {
      pulls: {
        get: rec('pulls.get', pr),
        list: rec('pulls.list', [pr]),
        listFiles: rec('pulls.listFiles', opts.files ?? [{ filename: 'README.md', status: 'modified', patch: '+hi', changes: 1 }]),
        merge: rec('pulls.merge', {}),
      },
      issues: {
        listComments: rec('issues.listComments', opts.comments ?? []),
        createComment: rec('issues.createComment', {}),
        updateComment: rec('issues.updateComment', {}),
        getLabel: rec('issues.getLabel', (p) => (opts.existingLabels ?? []).includes(p.name) ? {} : Object.assign(new Error('nf'), { status: 404 })),
        createLabel: rec('issues.createLabel', {}),
        addLabels: rec('issues.addLabels', {}),
        removeLabel: rec('issues.removeLabel', {}),
      },
      repos: {
        getBranch: rec('repos.getBranch', opts.branchError ? Object.assign(new Error('x'), { status: 403 }) : { protected: true }),
        createCommitStatus: rec('repos.createCommitStatus', {}),
        getCombinedStatusForRef: rec('repos.getCombinedStatusForRef', { statuses: opts.statuses ?? [] }),
      },
      checks: {
        listForRef: rec('checks.listForRef', opts.checkRuns ?? [
          { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'Governance · risk classification', status: 'completed', conclusion: 'success' },
          { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success' },
        ]),
      },
    },
  };
  return { github, pr };
}

function fakeCore() {
  const core = { out: '', failed: null, warnings: [], info: () => {}, warning: (m) => core.warnings.push(m), setFailed: (m) => { core.failed = m; } };
  core.summary = { addRaw: (s) => { core.out += s; return core.summary; }, write: async () => {} };
  return core;
}

const names = (calls) => calls.map((c) => c.name);

describe('fetchChangeSet', () => {
  it('flags missing patches and truncation', async () => {
    const { github } = fakeGithub({ files: [{ filename: 'docs/a.png', status: 'added', changes: 0 }, { filename: 'x.md', status: 'modified', changes: 3 }] });
    const cs = await fetchChangeSet(github, REPO, { number: 5, changed_files: 3 });
    expect(cs.truncated).toBe(true);
    expect(cs.files[0].patchUnavailable).toBe(false);
    expect(cs.files[1].patchUnavailable).toBe(true);
  });
});

describe('upsertReportComment', () => {
  it('updates the bot comment carrying the marker, ignores a spoofed one', async () => {
    const { github } = fakeGithub({ comments: [
      { id: 1, user: { login: 'mallory' }, body: `${REPORT_MARKER} fake` },
      { id: 2, user: { login: 'github-actions[bot]' }, body: `${REPORT_MARKER} old` },
    ] });
    expect(await upsertReportComment(github, REPO, 5, `${REPORT_MARKER} new`, { createIfMissing: true })).toBe('updated');
    const upd = github.calls.find((c) => c.name === 'issues.updateComment');
    expect(upd.params.comment_id).toBe(2);
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
    const result = await runClassify({ github, core, context: { repo: REPO, payload: { pull_request: pr } } });
    expect(result.risk).toBe('restricted');
    expect(core.failed).toBeNull();
    expect(core.out).toMatch(/EXCEPTION REPORT/);
    const add = github.calls.find((c) => c.name === 'issues.addLabels');
    expect(add.params.labels).toEqual(['risk:restricted', 'restricted:financial_semantics', 'restricted:migrations']);
    expect(github.calls.find((c) => c.name === 'issues.removeLabel').params.name).toBe('risk:low');
    expect(names(github.calls)).toContain('issues.createComment');
    const st = github.calls.find((c) => c.name === 'repos.createCommitStatus');
    expect(st.params).toMatchObject({ sha: HEAD, state: 'success', context: 'Governance · risk classification' });
  });

  it('low PR: risk:low label, no new comment', async () => {
    const { github, pr } = fakeGithub({ labels: [] });
    const core = fakeCore();
    await runClassify({ github, core, context: { repo: REPO, payload: { pull_request: pr } } });
    expect(github.calls.find((c) => c.name === 'issues.addLabels').params.labels).toEqual(['risk:low']);
    expect(names(github.calls)).not.toContain('issues.createComment');
  });

  it('records missing admin visibility of branch protection in the report without failing', async () => {
    const { github, pr } = fakeGithub({ branchError: true, files: [{ filename: 'package.json', status: 'modified', patch: '+x', changes: 1 }] });
    const core = fakeCore();
    await runClassify({ github, core, context: { repo: REPO, payload: { pull_request: pr } } });
    expect(core.out).toMatch(/could not be verified \(HTTP 403\)/);
    expect(core.failed).toBeNull();
  });
});

describe('runEligibility', () => {
  const ctx = (pr) => ({ repo: REPO, payload: { pull_request: pr } });

  it('eligible low PR → enables squash auto-merge pinned to head SHA', async () => {
    const { github, pr } = fakeGithub();
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: ctx(pr) });
    expect(rows[0].eligible).toBe(true);
    const m = github.calls.find((c) => c.name === 'graphql' && c.query.includes('enablePullRequestAutoMerge'));
    expect(m.query).toContain('SQUASH');
    expect(m.vars).toEqual({ id: 'PR_node', sha: HEAD });
    expect(core.out).toMatch(/ELIGIBLE/);
  });

  it('ineligible PR with auto-merge on → disables it and says why', async () => {
    const { github, pr } = fakeGithub({ autoMerge: { merge_method: 'squash' }, threads: [{ isResolved: false }] });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: ctx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(github.calls.some((c) => c.name === 'graphql' && c.query.includes('disablePullRequestAutoMerge'))).toBe(true);
    expect(core.out).toMatch(/1 unresolved review thread/);
  });

  it('stale risk:low label on a restricted change set is not eligible', async () => {
    const { github, pr } = fakeGithub({ files: [{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '+x', changes: 1 }] });
    const rows = await runEligibility({ github, core: fakeCore(), context: ctx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(github.calls.some((c) => c.name === 'graphql' && c.query.includes('enablePullRequestAutoMerge'))).toBe(false);
  });

  it('already-clean PR → squash merge pinned to evaluated SHA', async () => {
    const { github, pr } = fakeGithub({ enableError: 'Pull request Pull request is in clean status' });
    const rows = await runEligibility({ github, core: fakeCore(), context: ctx(pr) });
    expect(rows[0].action).toMatch(/squash-merged/);
    expect(github.calls.find((c) => c.name === 'pulls.merge').params).toMatchObject({ merge_method: 'squash', sha: HEAD });
  });

  it('other enable errors fail the job and do not merge', async () => {
    const { github, pr } = fakeGithub({ enableError: 'Auto merge is not allowed for this repository' });
    const core = fakeCore();
    const rows = await runEligibility({ github, core, context: ctx(pr) });
    expect(rows[0].eligible).toBe(false);
    expect(core.failed).toMatch(/could not be evaluated/);
    expect(names(github.calls)).not.toContain('pulls.merge');
  });

  it('workflow_run without PR list → matches open PRs by head SHA', async () => {
    const { github } = fakeGithub();
    const rows = await runEligibility({
      github,
      core: fakeCore(),
      context: { repo: REPO, payload: { workflow_run: { pull_requests: [], head_sha: HEAD } } },
    });
    expect(rows.map((r) => r.number)).toEqual([5]);
  });
});
