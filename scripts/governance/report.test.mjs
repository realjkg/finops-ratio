// Exception report + label computation (pure functions used by the workflow).
import { describe, it, expect } from 'vitest';
import { REPORT_MARKER, buildReport, desiredLabels, labelChanges } from './report.mjs';

const restricted = {
  risk: 'restricted',
  classes: ['migrations', 'retention'],
  reasons: [
    { path: 'src/ingest/db/migrations/0002_x.up.sql', class: 'migrations', rule: 'migrations.paths' },
    { path: 'src/jobs/purge.ts', class: 'retention', rule: 'retention.paths' },
  ],
};
const low = { risk: 'low', classes: [], reasons: [] };

describe('buildReport', () => {
  it('restricted report carries marker, classes, triggering paths/rules and required evidence', () => {
    const md = buildReport(restricted, { headSha: 'abc1234def', mainProtection: { protected: true } });
    expect(md.startsWith(REPORT_MARKER)).toBe(true);
    expect(md).toMatch(/EXCEPTION REPORT/);
    expect(md).toContain('`migrations`');
    expect(md).toContain('`retention`');
    expect(md).toContain('src/ingest/db/migrations/0002_x.up.sql');
    expect(md).toContain('migrations.paths');
    expect(md).toMatch(/gates green/i);
    expect(md).toMatch(/challenger re-review/i);
    expect(md).toMatch(/zero open High/i);
    expect(md).toMatch(/operational evidence/i);
    expect(md).toMatch(/rollback verified/i);
    expect(md).toMatch(/auto-merge.*disabled/i);
    expect(md).toContain('abc1234');
  });

  it('M1: restricted report explains the SHA-bound exception queue', () => {
    const sha = 'f'.repeat(40);
    const md = buildReport(restricted, { headSha: sha });
    expect(md).toContain(`/exception-approve ${sha}`);
    expect(md).toContain('/exception-revoke');
    expect(md).toMatch(/admin or maintain/i);
    expect(md).toMatch(/new head needs a new approval/i);
    expect(md).toMatch(/link.*challenger review evidence/i);
    expect(md).toMatch(/never enables auto-merge for restricted/i);
    expect(md).not.toContain('exception:approved');
  });
  it('M1: without a head SHA the command shows a placeholder', () => {
    expect(buildReport(restricted, {})).toContain('/exception-approve <head-sha>');
  });

  it('M2: no owner-only class distinction; the human gate is the production environment', () => {
    for (const r of [restricted, { ...restricted, classes: ['migrations'], reasons: [restricted.reasons[0]] }]) {
      const md = buildReport(r, {});
      expect(md).not.toMatch(/NOT delegable/i);
      expect(md).not.toMatch(/Owner checkpoint/i);
      expect(md).toMatch(/production environment/i);
    }
  });

  it('records when branch protection on main could not be confirmed, without blocking', () => {
    expect(buildReport(restricted, { mainProtection: { protected: false, rulesRequiredChecks: [] } })).toMatch(/main is NOT protected/);
    expect(buildReport(restricted, { mainProtection: { error: 'HTTP 403' } })).toMatch(/could not be verified.*HTTP 403/);
  });

  it('M4b: reports required checks from the branch rules API, not the protected flag', () => {
    const withRules = buildReport(restricted, { mainProtection: { protected: true, rulesRequiredChecks: ['Lint · Typecheck · Test · Build'] } });
    expect(withRules).toMatch(/ruleset on `main` requires status checks: `Lint · Typecheck · Test · Build`/i);
    const noRules = buildReport(restricted, { mainProtection: { protected: true, rulesRequiredChecks: [] } });
    expect(noRules).toMatch(/no ruleset requires status checks on `main`/i);
    expect(noRules).not.toMatch(/Branch protection on `main`: enabled/);
    const rulesErr = buildReport(restricted, { mainProtection: { protected: true, rulesError: 'HTTP 404' } });
    expect(rulesErr).toMatch(/rules for `main` could not be read \(HTTP 404\)/i);
  });

  it('M4a: both reports say a fresh Copilot review on the new head is required after each push', () => {
    for (const md of [buildReport(restricted, {}), buildReport(low, {})]) {
      expect(md).toMatch(/fresh Copilot review on the new head/i);
      expect(md).toMatch(/after each push/i);
    }
  });

  it('M3: the low report says low is heuristic, not proven safe', () => {
    expect(buildReport(low, {})).toMatch(/heuristically low, not proven safe/i);
  });

  it('H3: fork/outsider PRs are reported as never auto-merge eligible', () => {
    const md = buildReport(low, { outsider: 'fork PR (head repo mallory/x)' });
    expect(md).toMatch(/never eligible for auto-merge/i);
    expect(md).toContain('mallory/x');
    expect(buildReport(low, {})).not.toMatch(/never eligible for auto-merge/i);
  });

  it('escapes table-breaking characters in paths', () => {
    const r = { ...restricted, reasons: [{ path: 'a|b`c.sql', class: 'migrations', rule: 'x' }] };
    const md = buildReport(r, {});
    expect(md).toContain('a\\|b');
    expect(md).not.toContain('a|b`c');
  });

  it('low report is short and says the PR is eligible for the auto-merge gate', () => {
    const md = buildReport(low, {});
    expect(md.startsWith(REPORT_MARKER)).toBe(true);
    expect(md).toMatch(/risk:low/);
    expect(md).not.toMatch(/EXCEPTION REPORT/);
  });
});

describe('labels', () => {
  it('restricted → risk:restricted plus one label per class', () => {
    expect(desiredLabels(restricted)).toEqual(['risk:restricted', 'restricted:migrations', 'restricted:retention']);
  });
  it('low → risk:low only', () => {
    expect(desiredLabels(low)).toEqual(['risk:low']);
  });
  it('labelChanges only touches governance labels', () => {
    const current = ['bug', 'risk:low', 'restricted:secrets', 'restricted:migrations'];
    expect(labelChanges(current, desiredLabels(restricted))).toEqual({
      add: ['risk:restricted', 'restricted:retention'],
      remove: ['risk:low', 'restricted:secrets'],
    });
  });
});
