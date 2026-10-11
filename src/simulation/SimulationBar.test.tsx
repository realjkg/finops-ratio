// A8: the "Customer sign-in simulation" link must only appear when the status
// route reports the simulation enabled; a demo deployment (enabled:false) has
// no /simulation surface, so the link would be dead.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useStore } from '@/store/useStore';

const access = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/' }) }));
vi.mock('./SimulationProvider', () => ({ useSimulationAccess: () => access.current }));

import { SimulationBar } from './SimulationBar';

function accessWith(enabled: boolean) {
  return {
    enabled,
    loading: false,
    error: null,
    identities: {},
    signIn: async () => {},
    signOut: async () => {},
    refresh: async () => {},
  };
}

describe('SimulationBar sign-in link', () => {
  beforeEach(() => {
    useStore.getState().clearSimulation();
  });

  it('hides_sign_in_link_when_simulation_disabled', () => {
    access.current = accessWith(false);
    const html = renderToStaticMarkup(<SimulationBar />);
    expect(html).toContain('Seeded demo');
    expect(html).not.toContain('Customer sign-in simulation');
    expect(html).not.toContain('href="/simulation"');
  });

  it('hides_sign_in_link_when_no_provider_is_mounted', () => {
    access.current = null;
    const html = renderToStaticMarkup(<SimulationBar />);
    expect(html).not.toContain('href="/simulation"');
  });

  it('shows_sign_in_link_when_enabled_and_signed_out', () => {
    access.current = accessWith(true);
    const html = renderToStaticMarkup(<SimulationBar />);
    expect(html).toContain('Customer sign-in simulation');
    expect(html).toContain('href="/simulation"');
  });
});
