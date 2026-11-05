// The demo indicator follows the MODE first (never in engagement mode, whatever the path), then the
// path rule (/simulation* carries no badge). Exports use the same wording, and only in demo mode.
import { describe, expect, it } from 'vitest';
import { DEMO_LABEL, ENGAGEMENT_PAGE_MARK, demoExportLine, modeOfPage, ratioModeOf, showsDemoBadge } from './demoMode';

describe('ratio mode', () => {
  it('is demo only when RATIO_MODE is unset or empty (as the proxy decides)', () => {
    expect(ratioModeOf({})).toBe('demo');
    expect(ratioModeOf({ RATIO_MODE: '' })).toBe('demo');
    expect(ratioModeOf({ RATIO_MODE: 'engagement' })).toBe('engagement');
    expect(ratioModeOf({ RATIO_MODE: 'Engagement' })).toBe('invalid'); // fails closed: not a demo
  });
  it('reads the engagement mark the engagement page sets in its server props', () => {
    expect(modeOfPage(undefined)).toBe('demo');
    expect(modeOfPage({})).toBe('demo');
    expect(modeOfPage({ [ENGAGEMENT_PAGE_MARK]: 'engagement' })).toBe('engagement');
  });
});

describe('showsDemoBadge', () => {
  const DEMO = ['/', '/overview', '/workloads', '/connectors', '/frameworks', '/reports', '/demo', '/costsource', '/mission', '/hello'];
  it('shows on demo pages in demo mode', () => {
    for (const p of DEMO) expect(showsDemoBadge(p, 'demo'), p).toBe(true);
  });
  it('never shows in engagement (or an invalid) mode, on any path', () => {
    for (const p of [...DEMO, '/engagement']) {
      expect(showsDemoBadge(p, 'engagement'), p).toBe(false);
      expect(showsDemoBadge(p, 'invalid'), p).toBe(false);
    }
  });
  it('never shows on /simulation and its sub-routes, the engagement page or error pages', () => {
    for (const p of ['/simulation', '/simulation/x', '/engagement', '/_error', '/404', '/500']) expect(showsDemoBadge(p, 'demo'), p).toBe(false);
  });
});

describe('demoExportLine', () => {
  it('is the badge wording in demo mode and null otherwise', () => {
    expect(DEMO_LABEL).toBe('Demo environment — figures are illustrative');
    expect(demoExportLine({})).toBe(DEMO_LABEL);
    expect(demoExportLine({ RATIO_MODE: 'engagement' })).toBeNull();
    expect(demoExportLine({ RATIO_MODE: 'typo' })).toBeNull();
  });
});
