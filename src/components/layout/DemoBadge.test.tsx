// @vitest-environment happy-dom
// The one quiet demo indicator: a "Demo" badge in the top bar with a descriptive accessible name.
// It replaces the per-card synthetic/sample labels. /simulation (the route name says it) and the
// engagement report never show it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_BADGE_LABEL, DemoBadge, showsDemoBadge } from './DemoBadge';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let box: HTMLDivElement;
beforeEach(() => {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
});

describe('DemoBadge', () => {
  it('reads "Demo" and is named for assistive technology', () => {
    act(() => root.render(<DemoBadge />));
    const badge = box.querySelector('[data-testid="demo-badge"]')!;
    expect(badge.textContent).toBe('Demo');
    expect(badge.getAttribute('role')).toBe('note');
    expect(badge.getAttribute('aria-label')).toBe(DEMO_BADGE_LABEL);
    expect(DEMO_BADGE_LABEL).toBe('Demo environment — figures are illustrative');
  });

  it('makes no live or production claim', () => {
    expect(DEMO_BADGE_LABEL).not.toMatch(/live|production|verified|real/i);
  });
});

describe('showsDemoBadge', () => {
  it('shows on every demo page', () => {
    for (const p of ['/', '/overview', '/workloads', '/connectors', '/frameworks', '/reports', '/demo', '/agent-workflows', '/workspace', '/outcomes',
      '/costsource', '/finio', '/finio/demo', '/prediction', '/tokenomics', '/attribution', '/mission', '/hello']) {
      expect(showsDemoBadge(p, 'demo'), p).toBe(true);
      expect(showsDemoBadge(p, 'engagement'), p).toBe(false);
    }
  });

  it('never shows on /simulation and its sub-routes, the engagement report, or error pages', () => {
    for (const p of ['/simulation', '/simulation/', '/simulation/anything', '/engagement', '/_error', '/404', '/500']) expect(showsDemoBadge(p, 'demo'), p).toBe(false);
    expect(showsDemoBadge('/simulations', 'demo')).toBe(true); // a prefix match only on the path segment
  });
});
