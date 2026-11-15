// AppShell hands the page's mode to everything it renders, so a demo-only label (FleetHeader)
// never shows in an engagement page and always shows in a demo page.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useRatioMode } from '@/lib/ratioModeContext';
import { AppShell } from './AppShell';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/overview', asPath: '/overview', query: {} }) }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/ai/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('@/simulation/SimulationBar', () => ({ SimulationBar: () => null }));

function ModeProbe() {
  return <span data-testid="mode">{useRatioMode()}</span>;
}

describe('AppShell provides the page mode to its children', () => {
  it.each(['demo', 'engagement'] as const)('%s', (mode) => {
    const html = renderToStaticMarkup(<AppShell mode={mode}><ModeProbe /></AppShell>);
    expect(html).toContain(`<span data-testid="mode">${mode}</span>`);
  });
});
