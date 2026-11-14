// The mode the page was served in (demo or engagement), for components that label demo figures.
// AppShell provides it from _app's mode; outside a provider the default is the demo, the same
// default as modeOfPage().
import { createContext, useContext, type ReactNode } from 'react';
import type { RatioMode } from '@/lib/demoMode';

const RatioModeContext = createContext<RatioMode>('demo');

export function RatioModeProvider({ mode, children }: { mode: RatioMode; children: ReactNode }) {
  return <RatioModeContext.Provider value={mode}>{children}</RatioModeContext.Provider>;
}

export function useRatioMode(): RatioMode {
  return useContext(RatioModeContext);
}
