// @vitest-environment happy-dom
// The methodology page as a user sees it in each mode: the demo, a store whose data no longer matches its
// source, and a simulation workspace. Also the links into it from Value review and /demo.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Methodology from '../../pages/methodology';
import Demo from '../../pages/demo';
import { WORKLOADS } from '@/data/workloads';
import { FindingsPage } from '@/findings/FindingsPage';
import { PersonaProvider } from '@/components/PersonaProvider';
import { seedWorkspace } from '@/simulation/server/workflow';
import { useStore } from '@/store/useStore';
import { traceAll } from './valueSources';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', isReady: true, push: async () => true, replace: async () => true }) }));
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let box: HTMLDivElement;
function mount(el: ReactElement) {
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  act(() => root!.render(el));
  return box;
}
const initial = useStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  box?.remove();
  useStore.setState(initial, true);
});
const text = (el: Element | null) => el?.textContent ?? '';

describe('methodology page in each mode', () => {
  it('demo: every workload matches, the evidence counts come from the data, and the portfolio figure is shown', () => {
    const page = mount(<Methodology />);
    expect(text(page.querySelector('[data-testid="methodology-source-check"]'))).toContain(`Dataset check: ${WORKLOADS.length} of ${WORKLOADS.length} workloads match (amounts to the cent, ratios to 0.01).`);
    const inputs = traceAll(WORKLOADS).flatMap((t) => t.inputs.filter((i) => i.evidence !== null)).length;
    expect(text(page.querySelector('[data-testid="methodology-evidence"]'))).toContain(`${inputs} of the ${inputs} value inputs on this page`);
    const value = WORKLOADS.reduce((s, w) => s + w.value.total_value, 0);
    const cost = WORKLOADS.reduce((s, w) => s + w.costs.monthly_spend, 0);
    expect(text(page.querySelector('[data-testid="methodology-portfolio"]'))).toContain(`${(value / cost).toFixed(3)}\u00d7 (shown as ${(value / cost).toFixed(1)}\u00d7)`);
    expect(text(page)).toContain('adjusted value \u00f7 cost for the same month');
    // The exact line, so each component is pinned and the four-decimal components reproduce the total by hand.
    const d = traceAll(WORKLOADS).find((t) => t.id === 'wl-support')!.dailyCost!;
    const daily = text(page.querySelector('[data-testid="daily-wl-support"]'));
    for (const v of [d.inputCost, d.outputCost, d.cachedCost, d.compute]) expect(daily).toContain(`$${v.toFixed(4)}`);
    expect(daily).toContain(`Total, the sum rounded to the cent: $${d.dailySpend.toFixed(2)}`);
    expect(daily.indexOf(`$${d.cachedCost.toFixed(4)}`)).toBeLessThan(daily.indexOf(`= $${d.compute.toFixed(4)}`));
  });

  it('a store that no longer matches its source shows the count and the difference, in the example', () => {
    const changed = structuredClone(WORKLOADS);
    changed.find((w) => w.id === 'wl-fraud')!.value.harm_from_misses = 100;
    act(() => useStore.setState({ workloads: changed }));
    const page = mount(<Methodology />);
    expect(text(page.querySelector('[data-testid="methodology-source-check"]'))).toContain(`${WORKLOADS.length - 1} of ${WORKLOADS.length} workloads match`);
    expect(text(page.querySelector('[data-testid="methodology-source-check"]'))).toContain('The differences are listed in each worked example below.');
    expect(text(page.querySelector('[data-testid="check-wl-fraud"]'))).toContain('Harm from misses: $100 in use, $4,600 in the source record.');
    expect(text(page.querySelector('[data-testid="check-wl-support"]'))).toContain('Check passed');
  });

  it('evidence counts and unmarked inputs come from the data, not from fixed text', () => {
    const changed = structuredClone(WORKLOADS);
    const fraudW = changed.find((w) => w.id === 'wl-fraud')!;
    fraudW.value.evidence = { revenue_protected: 'measured', cost_avoided: 'measured', harm_from_misses: 'measured', quality_floor_pass_rate: 'measured' };
    delete (changed.find((w) => w.id === 'wl-sales')!.value as { evidence?: unknown }).evidence;
    act(() => useStore.setState({ workloads: changed }));
    const page = mount(<Methodology />);
    const total = traceAll(changed).flatMap((t) => t.inputs.filter((i) => i.evidence !== null)).length;
    const evidence = text(page.querySelector('[data-testid="methodology-evidence"]'));
    expect(evidence).toContain(`4 of the ${total} value inputs on this page`);
    expect(evidence).toContain(`${total - 4} of the ${total} value inputs on this page`);
    const unmarkedRow = page.querySelector('[data-testid="input-wl-sales-revenue_protected"]')!;
    expect([...unmarkedRow.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).join(' ')).toContain('No valid provenance is recorded for revenue protected');
  });

  it('simulation workspace: cost ties to the ledger, the periods are disclosed, and there is no token-based daily cost', () => {
    const state = seedWorkspace();
    act(() => useStore.setState({ simulation: { session: { identity: {} as never, csrf: 'x', expiresAt: 0 }, state }, workloads: state.workloads }));
    const page = mount(<Methodology />);
    const status = text(page.querySelector('[data-testid="methodology-data-status"]'));
    expect(status).toContain('You are in a simulation workspace.');
    expect(status).toContain('The periods differ');
    expect(status).toContain(`Source check: ${state.workloads.length} of ${state.workloads.length} workloads match (amounts to the cent, ratios to 0.01).`);
    expect(text(page)).toContain('adjusted value \u00f7 cost (here, a whole month of value over cost recorded to date)');
    const fraudCost = state.workloads.find((w) => w.id === 'wl-fraud')!.costs.monthly_spend;
    expect(text(page.querySelector('[data-testid="input-wl-fraud-monthly_cost"]'))).toMatch(/Recorded cost, month to date.*Sum of 25 cost postings recorded in this workspace/);
    expect(text(page.querySelector('[data-testid="input-wl-fraud-monthly_cost"]'))).toContain(`$${fraudCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    expect(text(page.querySelector('[data-testid="calc-example-wl-fraud"]'))).toContain('Workspace record wl-fraud');
    expect(text(page.querySelector('[data-testid="input-wl-fraud-revenue_protected"]'))).toContain('Copied into the workspace when it was created.');
    expect(page.querySelector('[data-testid="daily-wl-fraud"]')).toBeNull();
  });
});

describe('links into the methodology page', () => {
  it('View calculation names the record and links to its own worked example', () => {
    const page = mount(<FindingsPage />);
    const panel = page.querySelector('[data-testid="finding-calculation"]')!;
    const link = [...panel.querySelectorAll('a')].find((a) => a.textContent === 'How this is calculated, and where each input comes from')!;
    const id = link.getAttribute('href')!.replace('/methodology#calc-', '');
    expect(link.getAttribute('href')).toBe(`/methodology#calc-${id}`);
    expect(WORKLOADS.map((w) => w.id)).toContain(id);
    expect(text(panel)).toContain(`Demo dataset, record ${id}.`);
  });

  it('/demo links to the page', () => {
    const page = mount(<PersonaProvider><Demo /></PersonaProvider>);
    const link = [...page.querySelectorAll('a')].find((a) => a.textContent === 'See how Value / cost is calculated')!;
    expect(link.getAttribute('href')).toBe('/methodology');
  });
});
