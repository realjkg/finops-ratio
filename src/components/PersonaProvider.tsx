// PersonaProvider (Ratio v2 Wave 2a). Wraps the app, holds the active persona,
// and persists it to localStorage. The initial render always uses the executive
// default so server and first client render agree (no hydration mismatch); the
// persisted persona is hydrated in an effect after mount.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_PERSONA,
  PersonaContext,
  readStoredPersona,
  writeStoredPersona,
  type Persona,
} from '@/lib/persona';

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // blocked site data: the persona still works for this page view
  }
}

export function PersonaProvider({ children }: { children: ReactNode }) {
  // Start from the executive default so SSR and the first client paint match.
  const [persona, setPersonaState] = useState<Persona>(DEFAULT_PERSONA);

  // After mount, adopt any persisted choice (client-only).
  useEffect(() => {
    setPersonaState(readStoredPersona(browserStorage()));
  }, []);

  const setPersona = useCallback((next: Persona) => {
    setPersonaState(next);
    writeStoredPersona(browserStorage(), next);
  }, []);

  const value = useMemo(() => ({ persona, setPersona }), [persona, setPersona]);

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

