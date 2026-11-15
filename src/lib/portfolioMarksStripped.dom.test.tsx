// @vitest-environment happy-dom
// /demo and the attribution page with the first seed workload stripped of its marks: opening the
// portfolio mark counts it (fails if unmarkedWorkloads is not passed).
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/data/workloads', async (orig) => {
  const m = await orig<typeof import('@/data/workloads')>();
  const W = structuredClone(m.WORKLOADS);
  delete (W[0].value as { evidence?: unknown }).evidence;
  return { ...m, WORKLOADS: W };
});
vi.mock('@/lib/persona', async (orig) => ({ ...(await orig<typeof import('@/lib/persona')>()), usePersona: () => ({ persona: 'executive', setPersona: () => {} }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/demo', isReady: true, push: async () => true, replace: async () => true }) }));
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { AttributionPage } = await import('@/attribution/AttributionPage');
const { default: Demo } = await import('../../pages/demo');
const { useStore } = await import('@/store/useStore');
const { WORKLOADS } = await import('@/data/workloads');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
function openMark(el: ReactElement, near: string): string {
  const box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  act(() => root!.render(el));
  // The mark whose nearest ancestor (up to four levels) also holds the figure's label.
  const within = (b: Element) => { let el: Element | null = b; for (let i = 0; i < 4 && el; i++, el = el.parentElement) if (el.textContent?.includes(near)) return true; return false; };
  const mark = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Estimated value' && within(b))!;
  act(() => mark.click());
  return document.querySelector('[data-testid="evidence-note"]')?.textContent ?? '';
}

describe('portfolio marks outside the simulation count an unmarked workload', () => {
  it('/demo Portfolio Value / cost', () => {
    useStore.setState({ workloads: structuredClone(WORKLOADS), simulation: null });
    expect(openMark(<Demo />, 'Portfolio Value / cost')).toContain('One workload has value inputs with no recorded provenance');
  });
  it('attribution value context', () => {
    expect(openMark(<AttributionPage />, 'Value context')).toContain('One workload has value inputs with no recorded provenance');
  });
});
