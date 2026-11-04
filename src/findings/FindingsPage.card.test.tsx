// @vitest-environment happy-dom
// The finding card: title, status line, the two numbers with their target, one reason, and
// two actions. Detail (formula, period, basis, assumptions, source) sits behind
// "View calculation"; Frank is secondary and optional.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FindingsPage } from './FindingsPage';
import { useStore } from '@/store/useStore';

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
  useStore.setState({ simulation: null, aiPanelOpen: false, selectedId: 'wl-support' });
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
  it('shows the status line, run rate, Value / cost with its target, and one reason', () => {
    expect(q('[data-testid="finding-status"]')?.textContent).toBe('Below target · Estimated value');
    expect(q('[data-testid="finding-value-cost"]')?.textContent).toBe('-0.2×');
    const text = box.textContent ?? '';
    expect(text).toContain('Monthly run rate');
    expect(text).toContain('Target 3×');
    expect(text).toContain('Why this needs attention');
    expect(q('[data-testid="finding-why"]')?.textContent).toMatch(/Harm from misses/);
    expect(text).not.toMatch(/3\.2.{0,3}below|below minimum|Monthly spend|Current ratio/);
  });

  it('keeps the formula and sources off the card until "View calculation" is opened', () => {
    expect(q('[data-testid="finding-calculation"]')).toBeNull();
    const toggle = button('View calculation');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const calc = q('[data-testid="finding-calculation"]')!;
    expect(toggle.getAttribute('aria-controls')).toBe(calc.id);
    for (const part of ['Value / cost = (counted value', 'Period.', 'Cost basis.', 'Value assumptions.', 'Source.', 'Gap to the 3× target', 'not a general financial standard', 'Set in demo configuration']) {
      expect(calc.textContent, part).toContain(part);
    }
    act(() => toggle.click());
    expect(q('[data-testid="finding-calculation"]')).toBeNull();
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
