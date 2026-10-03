// Merge-eligibility decision, tested as a pure function over a fake PR state.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { URL } from 'node:url';
import { decideEligibility, latestCheckRuns, DEFAULT_CONFIG, CI_CHECK_NAME } from './eligibility.mjs';

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
      { id: 4, name: 'Governance · merge eligibility (#7)', appId: 15368, workflowPath: '.github/workflows/governance.yml', status: 'in_progress', conclusion: null },
      { id: 5, name: 'Governance · eligibility targets', appId: 15368, workflowPath: '.github/workflows/governance.yml', status: 'completed', conclusion: 'success' },
    ],
    statuses: [],
    reviews: [{ login: 'copilot-pull-request-reviewer[bot]', userType: 'Bot', commitId: HEAD, state: 'COMMENTED' }],
    unresolvedThreads: 0,
  };
  return { ...base, ...overrides, pr: { ...base.pr, ...(overrides.pr || {}) } };
}
const why = (d) => d.reasons.join('\n');

describe('decideEligibility', () => {
  it('eligible when every condition holds (own jobs excluded)', () => {
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
  it('M1: a CI check whose workflow path could not be resolved does not satisfy CI', () => {
    const s = state();
    s.checkRuns[0] = { ...s.checkRuns[0], workflowPath: undefined };
    expect(decideEligibility(s).eligible).toBe(false);
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

  it('only the latest run of a re-run check counts', () => {
    const s = state();
    s.checkRuns.push({ id: 0, ...CI, status: 'completed', conclusion: 'failure' });
    expect(decideEligibility(s).eligible).toBe(true);
    s.checkRuns.push({ id: 99, ...CI, status: 'completed', conclusion: 'failure' });
    expect(decideEligibility(s).eligible).toBe(false);
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
