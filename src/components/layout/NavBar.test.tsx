// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS, NavBar, pageTitle } from './NavBar';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', isReady: true, push: async () => true, replace: async () => true }) }));
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
  act(() => root.render(<NavBar active="frameworks" />));
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
});

describe('main navigation', () => {
  it('uses plain destination names; routes and keys are unchanged', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(['Value review', 'Overview', 'Workloads', 'Connectors', 'Governance', 'Reports']);
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(['/', '/overview', '/workloads', '/connectors', '/frameworks', '/reports']);
    expect(box.querySelector('[aria-current="page"]')?.textContent).toBe('Governance');
  });

  it('phone strip: snap scrolling, and an arrow shows only on the side with more items', () => {
    const strip = box.querySelector<HTMLElement>('[data-testid="nav-strip"]')!;
    expect(strip.className).toMatch(/snap-x/);
    expect(strip.querySelectorAll('a.snap-start').length).toBe(NAV_ITEMS.length);
    const metrics = (left: number) => {
      Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
      Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 500 });
      strip.scrollLeft = left;
      act(() => {
        strip.dispatchEvent(new Event('scroll'));
      });
    };
    const shown = (side: 'left' | 'right') => !box.querySelector(`[data-testid="nav-more-${side}"]`)!.className.split(' ').includes('invisible');
    metrics(0);
    expect(shown('right')).toBe(true);
    expect(shown('left')).toBe(false);
    metrics(200);
    expect(shown('right')).toBe(false);
    expect(shown('left')).toBe(true);
  });

  it('keeps the affordances off from md up', () => {
    metricsHidden();
    function metricsHidden() {
      const strip = box.querySelector<HTMLElement>('[data-testid="nav-strip"]')!;
      Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
      Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 500 });
      act(() => {
        strip.dispatchEvent(new Event('scroll'));
      });
    }
    expect(box.querySelector('[data-testid="nav-more-right"]')?.className).toMatch(/md:hidden/);
  });
});

describe('Demo badge', () => {
  it('sits beside the logo when the page is a demo page, named for screen readers', () => {
    act(() => root.render(<NavBar active="frameworks" demo />));
    const badge = box.querySelector('nav [data-testid="demo-badge"]')!;
    expect(badge.textContent).toBe('Demo');
    expect(badge.getAttribute('aria-label')).toBe('Demo environment — figures are illustrative');
    expect(box.querySelectorAll('[data-testid="demo-badge"]')).toHaveLength(1);
  });

  it('is absent unless asked for (engagement and simulation pages never pass it)', () => {
    expect(box.querySelector('[data-testid="demo-badge"]')).toBeNull();
  });
});

describe('page titles', () => {
  it('every in-scope route has its own title, so tabs, bookmarks and screen readers can tell pages apart', () => {
    const titles = NAV_ITEMS.map((i) => pageTitle(i.href));
    expect(titles).toEqual(['Value review · Ratio', 'Overview · Ratio', 'Workloads · Ratio', 'Connectors · Ratio', 'Governance · Ratio', 'Reports · Ratio']);
    expect(new Set(titles).size).toBe(titles.length);
    expect(pageTitle('/unknown')).toBe('Ratio');
  });
});
