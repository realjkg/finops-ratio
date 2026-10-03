// Merge-eligibility decision, tested as a pure function over a fake PR state.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { URL } from 'node:url';
import {
  decideEligibility, decideMergeStatus, evaluateExceptionApproval, latestCheckRuns,
  DEFAULT_CONFIG, CI_CHECK_NAME, ELIGIBILITY_CONTEXT, EXCEPTION_LABEL,
} from './eligibility.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const CI = { name: 'Lint · Typecheck · Test · Build', appId: 15368, workflowPath: '.github/workflows/ci.yml' };

function state(overrides = {}) {
  const base = {
    pr: {
      number: 7,
      draft: false,
      baseRef: 'main',
      headSha: HEAD,
      labels: ['risk:low'],
      headRepo: 'realjkg/finops-ratio',
      baseRepo: 'realjkg/finops-ratio',
      authorAssociation: 'OWNER',
    },
    freshRisk: 'low',
    checkRuns: [
      { id: 1, ...CI, status: 'completed', conclusion: 'success' },
      { id: 2, name: 'Governance · risk classification', appId: 15368, workflowPath: '.github/workflows/governance.yml', status: 'completed', conclusion: 'success' },
      { id: 3, name: 'copilot-pull-request-reviewer', appId: 15368, workflowPath: 'dynamic/agents/copilot-pull-request-reviewer', status: 'completed', conclusion: 'success' },
    ],
    // N2: jobs of the latest attempt of the ci.yml pull_request run for the head SHA.
    ciJobs: [{ id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success' }],
    sharedHeadWith: [],
    statuses: [],
    reviews: [{ login: 'copilot-pull-request-reviewer[bot]', userType: 'Bot', commitId: HEAD, state: 'COMMENTED' }],
    unresolvedThreads: 0,
  };
  return { ...base, ...overrides, pr: { ...base.pr, ...(overrides.pr || {}) } };
}
const why = (d) => d.reasons.join('\n');

describe('decideEligibility', () => {
  it('eligible when every condition holds', () => {
    expect(decideEligibility(state())).toEqual({ eligible: true, reasons: [] });
  });

  it('defaults pin CI to the Actions app and ci.yml, and the reviewer to the Copilot bot', () => {
    expect(DEFAULT_CONFIG.ciCheck).toEqual(CI);
    expect(DEFAULT_CONFIG.reviewer.login).toBe('copilot-pull-request-reviewer[bot]');
    expect(DEFAULT_CONFIG.reviewer.userType).toBe('Bot');
    expect(CI_CHECK_NAME).toBe(CI.name);
  });

  it('L7: the CI job name in ci.yml equals the required-check constant', () => {
    const ci = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).toMatch(new RegExp(`^\\s+name: ${CI_CHECK_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  });

  it('requires the risk:low label', () => {
    const d = decideEligibility(state({ pr: { labels: ['risk:restricted'] } }));
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/risk:low/);
  });

  it('requires a fresh low classification even if the label says low (stale label)', () => {
    const d = decideEligibility(state({ freshRisk: 'restricted' }));
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/classif/i);
  });

  it('missing fresh classification blocks (fail-closed)', () => {
    expect(decideEligibility(state({ freshRisk: undefined })).eligible).toBe(false);
  });

  it('a label risk:restricted alongside risk:low blocks', () => {
    expect(decideEligibility(state({ pr: { labels: ['risk:low', 'risk:restricted'] } })).eligible).toBe(false);
  });

  it('draft PR blocks', () => {
    const d = decideEligibility(state({ pr: { draft: true } }));
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/draft/i);
  });

  it('base other than main blocks', () => {
    const d = decideEligibility(state({ pr: { baseRef: 'slice/00' } }));
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/main/);
  });

  // H3
  it('H3: a fork PR is never eligible', () => {
    const d = decideEligibility(state({ pr: { headRepo: 'mallory/finops-ratio' } }));
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/fork/i);
  });
  it('H3: a PR whose head repo is gone is never eligible', () => {
    expect(decideEligibility(state({ pr: { headRepo: null } })).eligible).toBe(false);
  });
  for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN', undefined]) {
    it(`H3: author association ${assoc} is never eligible`, () => {
      const d = decideEligibility(state({ pr: { authorAssociation: assoc } }));
      expect(d.eligible).toBe(false);
      expect(why(d)).toMatch(/author/i);
    });
  }
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    it(`H3: author association ${assoc} may be eligible`, () => {
      expect(decideEligibility(state({ pr: { authorAssociation: assoc } })).eligible).toBe(true);
    });
  }

  it('a failing other check blocks', () => {
    const s = state();
    s.checkRuns.push({ id: 9, name: 'Some other check', status: 'completed', conclusion: 'failure' });
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/Some other check/);
  });

  it('a pending other check blocks', () => {
    const s = state();
    s.checkRuns[0] = { ...s.checkRuns[0], status: 'in_progress', conclusion: null };
    expect(decideEligibility(s).eligible).toBe(false);
  });

  for (const conclusion of ['skipped', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale']) {
    it(`conclusion ${conclusion} is not success and blocks`, () => {
      const s = state();
      s.checkRuns.push({ id: 10, name: 'x', status: 'completed', conclusion });
      expect(decideEligibility(s).eligible).toBe(false);
    });
  }

  it('a missing CI check blocks (no vacuous truth)', () => {
    const s = state();
    s.checkRuns = s.checkRuns.filter((c) => c.name !== CI.name);
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/Lint · Typecheck · Test · Build/);
  });

  // M1
  it('M1: a spoofed same-name CI check from another workflow path does not satisfy CI', () => {
    const s = state();
    s.checkRuns = s.checkRuns.filter((c) => c.name !== CI.name);
    s.checkRuns.push({ id: 50, ...CI, workflowPath: '.github/workflows/evil.yml', status: 'completed', conclusion: 'success' });
    expect(decideEligibility(s).eligible).toBe(false);
  });
  it('M1: a same-name CI check from another app does not satisfy CI', () => {
    const s = state();
    s.checkRuns = s.checkRuns.filter((c) => c.name !== CI.name);
    s.checkRuns.push({ id: 51, ...CI, appId: 999, status: 'completed', conclusion: 'success' });
    expect(decideEligibility(s).eligible).toBe(false);
  });
  // N2: CI is verified through the Actions jobs API.
  it('N2: masking — real failing CI job id 5 + impostor success id 99 in the same suite → ineligible', () => {
    const s = state({ ciJobs: [{ id: 5, name: CI.name, status: 'completed', conclusion: 'failure' }] });
    s.checkRuns = s.checkRuns.filter((c) => c.name !== CI.name);
    s.checkRuns.push({ id: 5, ...CI, status: 'completed', conclusion: 'failure' });
    s.checkRuns.push({ id: 99, ...CI, status: 'completed', conclusion: 'success' });
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/99/);
  });
  it('P1/R2: failing CI-named check run id 3 + successful same-name/app/path run id 99 (the job) ⇒ ineligible; catches "dedupe CI runs by latest"', () => {
    const s = state({ ciJobs: [{ id: 99, name: CI.name, status: 'completed', conclusion: 'success' }] });
    s.checkRuns = s.checkRuns.filter((c) => c.name !== CI.name);
    s.checkRuns.push({ id: 3, ...CI, status: 'completed', conclusion: 'failure' });
    s.checkRuns.push({ id: 99, ...CI, status: 'completed', conclusion: 'success' });
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/id 3\b/);
  });

  it('L1: every qualifying run\'s CI job must succeed — one failing CI job among several ⇒ ineligible', () => {
    const s = state({ ciJobs: [
      { id: 1, name: CI.name, status: 'completed', conclusion: 'success' },
      { id: 2, name: CI.name, status: 'completed', conclusion: 'failure' },
    ] });
    s.checkRuns.push({ id: 2, ...CI, status: 'completed', conclusion: 'failure' });
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/id 2\b/);
  });
  it('L1: head SHA shared with another open PR ⇒ ineligible', () => {
    const d = decideEligibility(state({ sharedHeadWith: [6, 9] }));
    expect(d.eligible).toBe(false);
    expect(d.reasons).toContain('head SHA shared with PR #6');
    expect(d.reasons).toContain('head SHA shared with PR #9');
  });
  it('L1: unknown sharing state (null) ⇒ ineligible', () => {
    expect(decideEligibility(state({ sharedHeadWith: null })).eligible).toBe(false);
  });

  it('N2: a CI-named check run whose id is not a ci.yml job is treated as a spoof', () => {
    const s = state();
    s.checkRuns.push({ id: 77, ...CI, status: 'completed', conclusion: 'success' });
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/77/);
  });
  it('N2: missing CI job → ineligible', () => {
    const d = decideEligibility(state({ ciJobs: [{ id: 2, name: 'other job', status: 'completed', conclusion: 'success' }] }));
    expect(d.eligible).toBe(false);
  });
  it('N2: no ci.yml run found (ciJobs null) → ineligible', () => {
    expect(decideEligibility(state({ ciJobs: null })).eligible).toBe(false);
  });
  it('N2: CI job not successful → ineligible even if its check run says success', () => {
    expect(decideEligibility(state({ ciJobs: [{ id: 1, name: CI.name, status: 'completed', conclusion: 'cancelled' }] })).eligible).toBe(false);
  });
  it('N2: CI job success but its check run is not on the head SHA → ineligible', () => {
    expect(decideEligibility(state({ ciJobs: [{ id: 1234, name: CI.name, status: 'completed', conclusion: 'success' }] })).eligible).toBe(false);
  });

  // N3: no name-based self exclusion.
  it('N3: a check named like the governance eligibility job on the head SHA is NOT excluded', () => {
    const s = state();
    s.checkRuns.push({ id: 40, name: 'Governance · merge eligibility (#7)', appId: 15368, workflowPath: '.github/workflows/evil.yml', status: 'in_progress', conclusion: null });
    expect(decideEligibility(s).eligible).toBe(false);
    const t = state();
    t.checkRuns.push({ id: 41, name: 'Governance · eligibility targets', status: 'completed', conclusion: 'failure' });
    expect(decideEligibility(t).eligible).toBe(false);
  });
  it('M1: a spoofed failing duplicate is not hidden by the genuine success (both must pass)', () => {
    const s = state();
    s.checkRuns.push({ id: 60, ...CI, workflowPath: '.github/workflows/evil.yml', status: 'completed', conclusion: 'failure' });
    expect(decideEligibility(s).eligible).toBe(false);
  });
  it('M1: status-only CI is rejected', () => {
    const s = state({ statuses: [{ context: CI.name, state: 'success' }] });
    s.checkRuns = s.checkRuns.filter((c) => c.name !== CI.name);
    expect(decideEligibility(s).eligible).toBe(false);
  });
  it('M1: status-only review is rejected', () => {
    const s = state({ reviews: [], statuses: [{ context: 'copilot-pull-request-reviewer', state: 'success' }] });
    expect(decideEligibility(s).eligible).toBe(false);
  });
  it('M1: a Copilot review on an older SHA is rejected', () => {
    const d = decideEligibility(state({ reviews: [{ login: 'copilot-pull-request-reviewer[bot]', userType: 'Bot', commitId: OLD, state: 'COMMENTED' }] }));
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/review/i);
  });
  it('M1: a review by a user impersonating the bot login without Bot type is rejected', () => {
    expect(decideEligibility(state({ reviews: [{ login: 'copilot-pull-request-reviewer[bot]', userType: 'User', commitId: HEAD, state: 'COMMENTED' }] })).eligible).toBe(false);
  });
  it('M1: a review by another bot is rejected', () => {
    expect(decideEligibility(state({ reviews: [{ login: 'dependabot[bot]', userType: 'Bot', commitId: HEAD, state: 'APPROVED' }] })).eligible).toBe(false);
  });
  it('M1: a pending (unsubmitted) Copilot review does not count', () => {
    expect(decideEligibility(state({ reviews: [{ login: 'copilot-pull-request-reviewer[bot]', userType: 'Bot', commitId: HEAD, state: 'PENDING' }] })).eligible).toBe(false);
  });
  it('M1: the copilot check run alone (no review) is not an independent review', () => {
    expect(decideEligibility(state({ reviews: [] })).eligible).toBe(false);
  });

  it('C2: check runs are never collapsed — two suites of the same workflow, one failing, one newer success ⇒ ineligible', () => {
    const s = state();
    const other = { name: 'Other check', appId: 15368, workflowPath: '.github/workflows/other.yml' };
    s.checkRuns.push({ id: 10, ...other, status: 'completed', conclusion: 'failure' });
    s.checkRuns.push({ id: 11, ...other, status: 'completed', conclusion: 'success' });
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/Other check.*failure/);
  });

  it('failing or pending legacy commit status blocks', () => {
    expect(decideEligibility(state({ statuses: [{ context: 'ci/x', state: 'failure' }] })).eligible).toBe(false);
    expect(decideEligibility(state({ statuses: [{ context: 'ci/x', state: 'pending' }] })).eligible).toBe(false);
    expect(decideEligibility(state({ statuses: [{ context: 'ci/x', state: 'success' }] })).eligible).toBe(true);
  });

  it('unresolved review threads block', () => {
    const d = decideEligibility(state({ unresolvedThreads: 2 }));
    expect(d.eligible).toBe(false);
    expect(why(d)).toMatch(/2 unresolved/);
  });

  it('unknown thread count blocks (fail-closed)', () => {
    expect(decideEligibility(state({ unresolvedThreads: null })).eligible).toBe(false);
  });

  it('collects every blocking reason, not just the first', () => {
    const d = decideEligibility(state({ pr: { draft: true, baseRef: 'dev', labels: [] }, unresolvedThreads: 1 }));
    expect(d.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe('C1: own eligibility status', () => {
  it('a previous failure of our own eligibility status on the head does not block re-evaluation', () => {
    const s = state({ statuses: [{ context: ELIGIBILITY_CONTEXT, state: 'failure' }, { context: 'Governance · risk classification', state: 'success' }] });
    expect(decideEligibility(s)).toEqual({ eligible: true, reasons: [] });
  });
});

describe('C1: evaluateExceptionApproval', () => {
  const COMMIT = '2026-10-01T10:00:00Z';
  const labeled = (login, at, event = 'labeled', name = EXCEPTION_LABEL) => ({ event, label: { name }, actor: { login }, created_at: at });
  const base = {
    labels: ['risk:restricted', EXCEPTION_LABEL],
    events: [labeled('boss', '2026-10-01T11:00:00Z')],
    roles: { boss: { permission: 'admin', role_name: 'admin' } },
    headCommittedAt: COMMIT,
  };
  it('admin added after the head commit ⇒ approved', () => {
    expect(evaluateExceptionApproval(base)).toMatchObject({ approved: true, approver: 'boss' });
  });
  it('maintain role ⇒ approved', () => {
    expect(evaluateExceptionApproval({ ...base, roles: { boss: { permission: 'write', role_name: 'maintain' } } }).approved).toBe(true);
  });
  it('write-only user ⇒ not approved', () => {
    const r = evaluateExceptionApproval({ ...base, roles: { boss: { permission: 'write', role_name: 'write' } } });
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/admin|maintain/);
  });
  it('unknown permission ⇒ not approved', () => {
    expect(evaluateExceptionApproval({ ...base, roles: {} }).approved).toBe(false);
  });
  it('label added before the latest push ⇒ not approved', () => {
    const r = evaluateExceptionApproval({ ...base, events: [labeled('boss', '2026-10-01T09:00:00Z')] });
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/before/);
  });
  it('latest event for the label is an unlabel (re-added label missing from events) ⇒ not approved', () => {
    const r = evaluateExceptionApproval({ ...base, events: [labeled('boss', '2026-10-01T11:00:00Z'), labeled('boss', '2026-10-01T12:00:00Z', 'unlabeled')] });
    expect(r.approved).toBe(false);
  });
  it('the LATEST add counts: admin added, removed, re-added by a writer ⇒ not approved', () => {
    const r = evaluateExceptionApproval({
      ...base,
      events: [labeled('boss', '2026-10-01T11:00:00Z'), labeled('boss', '2026-10-01T11:30:00Z', 'unlabeled'), labeled('dev', '2026-10-01T12:00:00Z')],
      roles: { boss: { permission: 'admin', role_name: 'admin' }, dev: { permission: 'write', role_name: 'write' } },
    });
    expect(r.approved).toBe(false);
  });
  it('label not present ⇒ not approved', () => {
    expect(evaluateExceptionApproval({ ...base, labels: ['risk:restricted'] }).approved).toBe(false);
  });
  it('missing head commit time ⇒ not approved', () => {
    expect(evaluateExceptionApproval({ ...base, headCommittedAt: undefined }).approved).toBe(false);
  });
  it('events for other labels are ignored', () => {
    const r = evaluateExceptionApproval({ ...base, events: [...base.events, labeled('dev', '2026-10-01T13:00:00Z', 'labeled', 'bug')] });
    expect(r.approved).toBe(true);
  });
});

describe('C1: decideMergeStatus', () => {
  const restrictedState = (exception) => state({
    pr: { labels: ['risk:restricted', 'restricted:migrations', EXCEPTION_LABEL] },
    freshRisk: 'restricted',
    exception,
  });
  it('low and eligible ⇒ success (mode low)', () => {
    expect(decideMergeStatus(state())).toMatchObject({ state: 'success', mode: 'low' });
  });
  it('low but review missing ⇒ failure, description is the top reason (≤140 chars)', () => {
    const r = decideMergeStatus(state({ reviews: [] }));
    expect(r.state).toBe('failure');
    expect(r.description).toMatch(/review/);
    expect(r.description.length).toBeLessThanOrEqual(140);
  });
  it('restricted without approval ⇒ failure', () => {
    expect(decideMergeStatus(restrictedState({ approved: false, reason: 'label added by @dev (write), not admin/maintain' })))
      .toMatchObject({ state: 'failure', description: expect.stringMatching(/admin\/maintain/) });
    expect(decideMergeStatus(restrictedState(undefined)).state).toBe('failure');
  });
  it('restricted with approval and all other conditions ⇒ success (mode exception)', () => {
    expect(decideMergeStatus(restrictedState({ approved: true, approver: 'boss' })))
      .toMatchObject({ state: 'success', mode: 'exception', description: expect.stringMatching(/boss/) });
  });
  it('approval never overrides a non-risk condition (fork, missing review, threads, shared head, draft, base, CI)', () => {
    const ok = { approved: true, approver: 'boss' };
    for (const o of [
      { pr: { headRepo: 'mallory/r' } }, { reviews: [] }, { unresolvedThreads: 1 }, { sharedHeadWith: [6] },
      { pr: { draft: true } }, { pr: { baseRef: 'dev' } }, { ciJobs: null },
    ]) {
      const s = restrictedState(ok);
      const merged = { ...s, ...o, pr: { ...s.pr, ...(o.pr || {}) } };
      expect(decideMergeStatus(merged).state, JSON.stringify(o)).toBe('failure');
    }
  });
  it('long reasons are truncated to 140 chars', () => {
    const r = decideMergeStatus(state({ statuses: [{ context: 'x'.repeat(300), state: 'failure' }] }));
    expect(r.description.length).toBeLessThanOrEqual(140);
  });
});

describe('latestCheckRuns', () => {
  it('keeps the highest id per (name, app, workflow path)', () => {
    const runs = latestCheckRuns([
      { id: 1, name: 'a', appId: 1, workflowPath: 'p', status: 'completed', conclusion: 'failure' },
      { id: 3, name: 'a', appId: 1, workflowPath: 'p', status: 'completed', conclusion: 'success' },
      { id: 4, name: 'a', appId: 1, workflowPath: 'q', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'b', status: 'completed', conclusion: 'success' },
    ]);
    expect(runs.map((r) => r.id).sort()).toEqual([2, 3, 4]);
  });
});
