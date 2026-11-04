// @vitest-environment happy-dom
// #177 review: a workload whose Value / cost is N/A (no usable cost) sorts to the top of the Workloads
// list, ahead of the lowest computed ratio, and shows N/A rather than 0.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { workloadValueRatio } from '@/lib/valueRatio';
import { useStore } from '@/store/useStore';
import { WorkloadList } from './WorkloadList';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let box: HTMLDivElement;
const initial = useStore.getState();
beforeEach(() => {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
  useStore.setState({ workloads: initial.workloads, filters: initial.filters, selectedId: initial.selectedId });
});

const order = () => [...box.querySelectorAll('[aria-label="Workload list"] [aria-pressed]')].map((el) => el.textContent ?? '');

describe('WorkloadList ordering with N/A', () => {
  it('puts the N/A workload first, then lowest Value / cost first', () => {
    const na = structuredClone(WORKLOADS[WORKLOADS.length - 1]);
    na.costs.monthly_spend = 0;
    const workloads = [...WORKLOADS.slice(0, -1), na];
    useStore.setState({ workloads, filters: { ...initial.filters, team: 'all', provider: 'all', environment: 'all' }, selectedId: null });
    act(() => root.render(<WorkloadList />));
    const cards = order();
    expect(cards).toHaveLength(workloads.length);
    expect(cards[0]).toContain(na.name);
    expect(cards[0]).toContain('N/A');
    expect(cards[0]).not.toMatch(/\b0\.0×/);
    const expected = WORKLOADS.slice(0, -1).sort((a, b) => (workloadValueRatio(a) as number) - (workloadValueRatio(b) as number)).map((w) => w.name);
    expect(cards.slice(1).map((t) => expected.find((n) => t.includes(n)))).toEqual(expected);
  });
});
