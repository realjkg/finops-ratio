import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from '@/store/useStore';
import { usePersona } from '@/lib/persona';
import { simulationRequest, SimulationHttpError } from './client';
import type { SimIdentity, SimSession, Workspace } from './types';

interface SimulationAccess {
  enabled: boolean; loading: boolean; error: string | null; identities: Record<string, SimIdentity>;
  signIn: (identity: string) => Promise<void>; signOut: () => Promise<void>; refresh: () => Promise<void>;
}
const Access = createContext<SimulationAccess | null>(null);
export function useSimulationAccess() { return useContext(Access); }
export function SimulationProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<Record<string, SimIdentity>>({});
  const { setPersona } = usePersona();
  async function adopt(session: SimSession) {
    const state = await simulationRequest<Workspace>('state');
    useStore.getState().clearSimulation();
    useStore.getState().loadSimulation(session, state);
    setPersona(session.identity.persona);
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Capability probe first: a demo deployment must not attempt session
        // restore — the honest Seeded-demo chip is the only state a visitor sees.
        const capability = await simulationRequest<{ enabled: boolean }>('status');
        if (!active) return;
        if (!capability.enabled) return;
        try {
          const result = await simulationRequest<{ session: SimSession | null; identities: Record<string, SimIdentity> }>('session');
          if (!active) return;
          setEnabled(true); setIdentities(result.identities);
          if (result.session) {
            const state = await simulationRequest<Workspace>('state');
            if (active) { useStore.getState().loadSimulation(result.session, state); setPersona(result.session.identity.persona); }
          }
        } catch (e) {
          if (active && !(e instanceof SimulationHttpError && e.status === 404)) setError('Could not restore the saved simulation. Reload to retry.');
        }
      } catch (e) {
        // Probe failed: the simulation API surface is unreachable or broken — a
        // real failure in an enabled deployment, so it surfaces (a probe 404 is
        // a stale deployment artifact, suppressed like a 404 restore).
        if (active && !(e instanceof SimulationHttpError && e.status === 404)) setError('Could not reach the simulation service. Reload to retry.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [setPersona]);
  async function signIn(identity: string) {
    setLoading(true); setError(null);
    try {
      const result = await simulationRequest<{ session: SimSession }>('session', { identity });
      await adopt(result.session);
    } catch (e) { useStore.getState().clearSimulation(); setError(e instanceof Error ? e.message : 'Sign in failed.'); }
    finally { setLoading(false); }
  }
  async function signOut() {
    const current = useStore.getState().simulation;
    if (!current) return;
    setLoading(true); setError(null);
    try { await simulationRequest('session', undefined, current.session.csrf, 'DELETE'); useStore.getState().clearSimulation(); }
    catch (e) {
      if (e instanceof SimulationHttpError && e.status === 401) useStore.getState().clearSimulation();
      else setError('Sign out could not reach the server. Retry to revoke this session.');
    } finally { setLoading(false); }
  }
  async function refresh() {
    const current = useStore.getState().simulation;
    if (!current) return;
    setError(null);
    try {
      const state = await simulationRequest<Workspace>('state');
      if (useStore.getState().simulation?.session.csrf === current.session.csrf) useStore.getState().loadSimulation(current.session, state);
    }
    catch (e) {
      if (useStore.getState().simulation?.session.csrf !== current.session.csrf) return;
      if (e instanceof SimulationHttpError && e.status === 401) useStore.getState().clearSimulation();
      setError(e instanceof Error ? e.message : 'Refresh failed.');
    }
  }
  return <Access.Provider value={{ enabled, loading, error, identities, signIn, signOut, refresh }}>{children}</Access.Provider>;
}
