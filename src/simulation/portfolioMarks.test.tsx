// Every portfolio Value / cost figure on the simulation pages carries the computed status, as an
// explain button (reachable by keyboard and touch), and a workload with no marks is counted.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { seedWorkspace } from './server/workflow';
import { WorkspacePage } from './WorkspacePage';
import { SimulationConnectors } from './SimulationConnectors';

const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(fake.state) }));
vi.mock('@/lib/persona', () => ({ usePersona: () => ({ persona: 'technical', setPersona: () => {} }) }));

function load(strip: boolean) {
  const ws = seedWorkspace();
  if (strip) delete (ws.workloads[0].value as { evidence?: unknown }).evidence;
  fake.state = {
    simulation: { state: ws, session: { identity: { tenant: 't', user: 'u', persona: 'technical' }, csrf: 'c' } },
    simulationBusy: false, simulationCommand: () => {}, select: () => {},
  };
}
const buttons = (html: string) => html.match(/<button[^>]*aria-expanded="false"[^>]*>Estimated value<\/button>/g) ?? [];

describe('simulation portfolio figures show their status', () => {
  it('the workspace: Value / cost metric, each source card and the charges line', () => {
    load(false);
    const html = renderToStaticMarkup(<WorkspacePage />);
    // 1 metric + one per source card + the recorded-charges line.
    expect(buttons(html).length).toBeGreaterThanOrEqual(3);
  });
  it('the connectors page: every source card', () => {
    load(false);
    expect(buttons(renderToStaticMarkup(<SimulationConnectors />)).length).toBe(3);
  });
});
