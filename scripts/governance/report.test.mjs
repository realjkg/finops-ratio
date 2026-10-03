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

  it('retention/deployment add the owner-only escalation note', () => {
    expect(buildReport(restricted, {})).toMatch(/owner/i);
    const migOnly = { ...restricted, classes: ['migrations'], reasons: [restricted.reasons[0]] };
    expect(buildReport(migOnly, {})).not.toMatch(/NOT delegable/);
  });

  it('records when branch protection on main could not be confirmed, without blocking', () => {
    expect(buildReport(restricted, { mainProtection: { protected: false } })).toMatch(/main is NOT protected/);
    expect(buildReport(restricted, { mainProtection: { error: 'HTTP 403' } })).toMatch(/could not be verified.*HTTP 403/);
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
