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

  it('sign_in_link_shows_only_when_the_simulation_is_enabled', () => {
    access.current = accessWith(false);
    expect(renderToStaticMarkup(<SimulationBar />)).not.toContain('href="/simulation"');
    access.current = accessWith(true);
    expect(renderToStaticMarkup(<SimulationBar />)).toContain('href="/simulation"');
  });
});
