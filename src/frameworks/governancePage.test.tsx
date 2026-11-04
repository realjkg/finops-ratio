import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Governance from '../../pages/frameworks';
import { WORKLOADS } from '@/data/workloads';
import { deriveGateStatus } from './governanceModel';

describe('Governance page (route /frameworks)', () => {
  const html = renderToStaticMarkup(<Governance />);
  const approved = WORKLOADS.filter((w) => deriveGateStatus(w).allPassed).length;
  const conflicts = WORKLOADS.filter((w) => deriveGateStatus(w).alwaysOnConflict).length;

  it('is titled Governance; the page is approval gates, not frameworks', () => {
    expect(html).toContain('>Governance</h1>');
    expect(html).not.toContain('Frameworks');
  });

  it('counts approved workloads (all four gates passed) out of all workloads', () => {
    expect(html).toContain('Approved workloads');
    expect(html).toContain(`of ${WORKLOADS.length}`);
    expect(html).toContain('all four gates passed');
    expect(approved).toBeGreaterThan(0);
    expect(html).not.toMatch(/AUTHORIZED|Authorized/i);
  });

  it('names the actual conflict: always-on workloads without all four gates', () => {
    expect(html).toContain('Always-on policy conflicts');
    expect(html).toContain('running always-on without all four gates');
    expect(html).not.toMatch(/Shape conflicts|shape blocked/i);
    expect(conflicts).toBe(1);
    expect(html).toContain('always-on conflict');
  });
});
