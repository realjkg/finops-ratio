// Merge-eligibility decision, tested as a pure function over a fake PR state.
import { describe, it, expect } from 'vitest';
import { decideEligibility, latestCheckRuns, DEFAULT_CONFIG } from './eligibility.mjs';

const HEAD = 'a'.repeat(40);

function state(overrides = {}) {
  const base = {
    pr: { number: 7, draft: false, baseRef: 'main', headSha: HEAD, labels: ['risk:low'] },
    freshRisk: 'low',
    checkRuns: [
      { id: 1, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'Governance · risk classification', status: 'completed', conclusion: 'success' },
      { id: 3, name: 'copilot-pull-request-reviewer', status: 'completed', conclusion: 'success' },
      { id: 4, name: 'Governance · merge eligibility', status: 'in_progress', conclusion: null },
    ],
    statuses: [],
    unresolvedThreads: 0,
  };
  return { ...base, ...overrides, pr: { ...base.pr, ...(overrides.pr || {}) } };
}

describe('decideEligibility', () => {
  it('eligible when every condition holds (own job excluded)', () => {
    const d = decideEligibility(state());
    expect(d).toEqual({ eligible: true, reasons: [] });
  });

  it('defaults name the CI job, the governance job, the reviewer and this job', () => {
    expect(DEFAULT_CONFIG.requiredChecks).toEqual([
      'Lint · Typecheck · Test · Build',
      'Governance · risk classification',
    ]);
    expect(DEFAULT_CONFIG.reviewerCheckName).toBe('copilot-pull-request-reviewer');
    expect(DEFAULT_CONFIG.selfCheckNames).toEqual(['Governance · merge eligibility']);
  });

  it('requires the risk:low label', () => {
    const d = decideEligibility(state({ pr: { labels: ['risk:restricted'] } }));
    expect(d.eligible).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/risk:low/);
  });

  it('requires a fresh low classification even if the label says low (stale label)', () => {
    const d = decideEligibility(state({ freshRisk: 'restricted' }));
    expect(d.eligible).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/classif/i);
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
    expect(d.reasons.join('\n')).toMatch(/draft/i);
  });

  it('base other than main blocks', () => {
    const d = decideEligibility(state({ pr: { baseRef: 'slice/00' } }));
    expect(d.eligible).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/main/);
  });

  it('a failing other check blocks', () => {
    const s = state();
    s.checkRuns.push({ id: 9, name: 'Some other check', status: 'completed', conclusion: 'failure' });
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/Some other check/);
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

  it('a missing required CI check blocks (no vacuous truth)', () => {
    const s = state();
    s.checkRuns = s.checkRuns.filter((c) => c.name !== 'Lint · Typecheck · Test · Build');
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/Lint · Typecheck · Test · Build/);
  });

  it('missing independent reviewer check blocks', () => {
    const s = state();
    s.checkRuns = s.checkRuns.filter((c) => c.name !== 'copilot-pull-request-reviewer');
    const d = decideEligibility(s);
    expect(d.eligible).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/copilot-pull-request-reviewer/);
  });

  it('reviewer check still running blocks', () => {
    const s = state();
    s.checkRuns[2] = { ...s.checkRuns[2], status: 'queued', conclusion: null };
    expect(decideEligibility(s).eligible).toBe(false);
  });

  it('only the latest run of a re-run check counts', () => {
    const s = state();
    s.checkRuns.push({ id: 0, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure' });
    expect(decideEligibility(s).eligible).toBe(true);
    s.checkRuns.push({ id: 99, name: 'Lint · Typecheck · Test · Build', status: 'completed', conclusion: 'failure' });
    expect(decideEligibility(s).eligible).toBe(false);
  });

  it('failing or pending legacy commit status blocks', () => {
    expect(decideEligibility(state({ statuses: [{ context: 'ci/x', state: 'failure' }] })).eligible).toBe(false);
    expect(decideEligibility(state({ statuses: [{ context: 'ci/x', state: 'pending' }] })).eligible).toBe(false);
    expect(decideEligibility(state({ statuses: [{ context: 'ci/x', state: 'success' }] })).eligible).toBe(true);
  });

  it('a required check may be satisfied by a successful commit status of the same name', () => {
    const s = state({ statuses: [{ context: 'Governance · risk classification', state: 'success' }] });
    s.checkRuns = s.checkRuns.filter((c) => c.name !== 'Governance · risk classification');
    expect(decideEligibility(s)).toEqual({ eligible: true, reasons: [] });
    s.statuses = [{ context: 'Governance · risk classification', state: 'pending' }];
    expect(decideEligibility(s).eligible).toBe(false);
  });

  it('the reviewer check cannot be satisfied by a commit status (anyone with write can post one)', () => {
    const s = state({ statuses: [{ context: 'copilot-pull-request-reviewer', state: 'success' }] });
    s.checkRuns = s.checkRuns.filter((c) => c.name !== 'copilot-pull-request-reviewer');
    expect(decideEligibility(s).eligible).toBe(false);
  });

  it('unresolved review threads block', () => {
    const d = decideEligibility(state({ unresolvedThreads: 2 }));
    expect(d.eligible).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/2 unresolved/);
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
  it('keeps the highest id per name', () => {
    const runs = latestCheckRuns([
      { id: 1, name: 'a', status: 'completed', conclusion: 'failure' },
      { id: 3, name: 'a', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'b', status: 'completed', conclusion: 'success' },
    ]);
    expect(runs.map((r) => r.id).sort()).toEqual([2, 3]);
  });
});
