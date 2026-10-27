// Release blocker D2: the Workspace "Monthly budget" metric never prints an invalid budget as currency.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { seedWorkspace } from './server/workflow';
import { WorkspacePage } from './WorkspacePage';

const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/store/useStore', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(fake.state) }));
vi.mock('@/lib/persona', () => ({ usePersona: () => ({ persona: 'technical', setPersona: () => {} }) }));

function render(monthly: number): string {
  const ws = seedWorkspace();
  ws.workloads[0].costs.monthly_budget = monthly;
  fake.state = {
    simulation: { state: ws, session: { identity: { tenant: 't', user: 'u', persona: 'technical' } } },
    simulationBusy: false, simulationCommand: () => {}, select: () => {},
  };
  return renderToStaticMarkup(<WorkspacePage />);
}

describe('Workspace monthly budget metric', () => {
  it.each([0, -5, 0.004])('shows N/A with a reason for %s', (b) => {
    const html = render(b);
    expect(html).toMatch(/Monthly budget[^]*?N\/A \([^)]*approved budget/i);
    for (const bad of ['>$0.00<', '>-$5.00<', '>$0.01<', '>$NaN<']) expect(html).not.toContain(bad);
  });
  it('shows currency for a valid budget', () => {
    expect(render(15000)).toMatch(/Monthly budget[^]*?\$15,000/);
  });
});
