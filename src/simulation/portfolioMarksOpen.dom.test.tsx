// @vitest-environment happy-dom
// Opening a portfolio mark on the simulation pages, with one workload stripped of its marks: the
// explanation counts that workload (fails if unmarkedWorkloads is not passed).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedWorkspace } from './server/workflow';
import { WorkspacePage } from './WorkspacePage';
import { SimulationConnectors } from './SimulationConnectors';

const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(fake.state) }));
vi.mock('@/lib/persona', () => ({ usePersona: () => ({ persona: 'technical', setPersona: () => {} }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a> }));
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
function openFirst(el: JSX.Element): string {
  const ws = seedWorkspace();
  delete (ws.workloads[0].value as { evidence?: unknown }).evidence;
  fake.state = {
    simulation: { state: ws, session: { identity: { tenant: 't', user: 'u', persona: 'technical' }, csrf: 'c' } },
    simulationBusy: false, simulationCommand: () => {}, select: () => {},
  };
  const box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  act(() => root!.render(el));
  const mark = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Estimated value')!;
  act(() => mark.click());
  return document.querySelector('[data-testid="evidence-note"]')?.textContent ?? '';
}

describe('simulation portfolio marks count an unmarked workload', () => {
  it('workspace', () => expect(openFirst(<WorkspacePage />)).toContain('One workload has value inputs with no recorded provenance'));
  it('connectors', () => expect(openFirst(<SimulationConnectors />)).toContain('One workload has value inputs with no recorded provenance'));
});
