// @vitest-environment happy-dom
// The finding card: title, status line, the two numbers with their target, one reason, and
// two actions. Detail (formula, period, basis, assumptions, source) sits behind
// "View calculation"; Frank is secondary and optional.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingsPage } from './FindingsPage';
import { useStore } from '@/store/useStore';
import { WORKLOADS } from '@/data/workloads';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', isReady: true, push: async () => true, replace: async () => true }) }));
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let box: HTMLDivElement;
const q = (sel: string) => box.querySelector(sel) as HTMLElement | null;
const button = (text: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

beforeEach(() => {
  useStore.setState({ workloads: structuredClone(WORKLOADS), simulation: null, aiPanelOpen: false, selectedId: 'wl-support' });
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  act(() => root.render(<FindingsPage />));
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
});

describe('finding card (lowest Value / cost first: Fraud Triage Agent)', () => {
  it('shows the status line, modeled cost with its basis, Value / cost with its target, and one reason', () => {
    expect(q('[data-testid="finding-status"]')?.textContent).toBe('Below target');
    expect(box.textContent).toContain('Estimated value'); // beside the number, once on the card
    expect(q('[data-testid="finding-value-cost"]')?.textContent).toBe('-0.2×');
    const text = box.textContent ?? '';
    expect(text).toContain('Modeled workload cost');
    expect(text).toContain('Basis: demo assumption');
    expect(text).not.toMatch(/Monthly run rate|Cost basis not stated/);
    expect(text).toContain('Target 3×');
    expect(text).toContain('Why this is below target');
    expect(text).not.toContain('Why this needs attention');
    expect(q('[data-testid="finding-why"]')?.textContent).toMatch(/Harm from misses/);
    expect(text).not.toMatch(/3\.2.{0,3}below|below minimum|Monthly spend|Current ratio/);
    expect(text).not.toContain('\u2212'); // one minus glyph everywhere: the ASCII hyphen
  });

  it('keeps the calculation hidden until "View calculation" is opened; aria-controls always names a real element', () => {
    const toggle = button('View calculation');
    const calc = q('[data-testid="finding-calculation"]')!;
    expect(calc.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(calc.id);
    expect(box.querySelector(`#${calc.id}`)).toBe(calc);
    act(() => toggle.click());
    expect(calc.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide calculation');
    act(() => toggle.click());
    expect(calc.hidden).toBe(true);
    expect(button('View calculation')).toBe(toggle);
  });

  it('the opened calculation shows the code order of operations with the Fraud Triage numbers', () => {
    act(() => button('View calculation').click());
    const calc = q('[data-testid="finding-calculation"]')!;
    const t = calc.textContent!;
    expect(t).not.toMatch(/\\u[0-9a-f]{4}/i); // no escape sequences shown as text
    expect(t).not.toContain('\u2212');
    const order = [
      'Quality-adjusted business value, less modeled harm from misses, divided by workload cost for the same reporting period.',
      'Gross value (protected revenue + avoided cost)$6,720',
      'Quality-floor pass rate (applied to gross value)58%',
      'Counted business value$3,898',
      'Less modeled harm from misses-$4,600',
      'Adjusted value (estimated business value)-$702',
      'Modeled workload cost (monthly)$4,200',
      'Value / cost (unrounded)-0.167×',
      'Displayed-0.2×',
      'Break-even1×',
      'Configured policy target3×',
      'Gap to the 3× target3.167×',
    ];
    let at = -1;
    for (const part of order) {
      const i = t.indexOf(part, at + 1);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
    expect(t.split('Set in demo configuration').length - 1).toBe(1); // said once, not twice
    for (const part of ['applied once, to gross value', 'neither is deducted twice', 'Basis: demo assumption', '30-day month convention', 'Period.', 'Value assumptions.', 'Target source. Set in demo configuration.', 'Break-even. 1×, where value equals cost', 'not a general financial standard', 'Set in demo configuration', 'not Billed cost or Effective cost']) {
      expect(t, part).toContain(part);
    }
  });

  it('Ask Frank selects this workload as context and opens the panel; nothing else needs it', () => {
    expect(useStore.getState().aiPanelOpen).toBe(false);
    act(() => button('Ask Frank').click());
    expect(useStore.getState().selectedId).toBe('wl-fraud');
    expect(useStore.getState().aiPanelOpen).toBe(true);
  });

  it('draws a visible bar for the negative ratio on the shared axis', () => {
    const meter = box.querySelector('[role="meter"][aria-valuemin="-1"]');
    expect(meter).not.toBeNull();
  });
});

describe('Value review header count', () => {
  it('states the computed number of workloads below the target, out of all workloads', async () => {
    const { WORKLOADS } = await import('@/data/workloads');
    const { buildFindings } = await import('./findingsModel');
    const below = buildFindings(WORKLOADS).filter((f) => f.targetStatus !== 'on_target').length;
    expect(below).toBe(2);
    expect(box.textContent).toContain(`${below} of ${WORKLOADS.length} below the 3× target.`);
  });

  it('changes when the data changes (not a fixed string)', () => {
    const raised = useStore.getState().workloads.map((w) => ({ ...w, value: { ...w.value, revenue_protected: 1e9, cost_avoided: 0, harm_from_misses: 0, quality_floor_pass_rate: 1 } }));
    act(() => useStore.setState({ workloads: raised }));
    expect(box.textContent).toContain('0 of 11 below the 3× target.');
  });
});

describe('Below target filter', () => {
  const group = () => box.querySelector('[role="group"][aria-label="Show workloads"]')!;
  const btn = (prefix: string) => [...group().querySelectorAll('button')].find((b) => b.textContent!.startsWith(prefix))!;
  const rows = () => box.querySelectorAll('aside[aria-label="Value review list"] button').length;

  it('shows all workloads by default, with counts on both buttons', () => {
    expect(btn('All').getAttribute('aria-pressed')).toBe('true');
    expect(btn('All').textContent).toBe('All (11)');
    expect(btn('Below target').textContent).toBe('Below target (2)');
    expect(rows()).toBe(11);
  });

  it('narrows the list to below-target workloads and keeps the header count', () => {
    act(() => (btn('Below target') as HTMLButtonElement).click());
    expect(btn('Below target').getAttribute('aria-pressed')).toBe('true');
    expect(rows()).toBe(2);
    expect(box.textContent).toContain('2 of 11 below the 3× target.');
    act(() => (btn('All') as HTMLButtonElement).click());
    expect(rows()).toBe(11);
  });

  it('is keyboard operable: native buttons in the tab order', () => {
    for (const b of group().querySelectorAll('button')) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('tabindex')).toBeNull();
    }
  });
});
