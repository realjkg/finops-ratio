// AppShell — the single shared layout for the six north-star objects
// (Findings · Overview · Workloads · Connectors · Frameworks · Reports).
//
// It owns the top bar (the six-object NavBar with a router-derived active item),
// the single agent launcher in that bar, and one ChatPanel overlay — so every
// in-scope screen gets identical navigation and agent access with no per-page
// nav drift. Applied in pages/_app.tsx for in-scope routes only; legacy/demo
// routes render bare (still reachable by URL, just not in the nav).

import type { ReactNode } from 'react';
import { useRouter } from 'next/router';
import { useStore } from '@/store/useStore';
import { NavBar, NAV_ITEMS } from './NavBar';
import { ChatPanel } from '@/components/ai/ChatPanel';

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Active item derived from the route — never a hardcoded per-page prop.
  const active = NAV_ITEMS.find((item) => item.href === router.pathname)?.key;

  const toggleAIPanel = useStore((s) => s.toggleAIPanel);
  const aiPanelOpen = useStore((s) => s.aiPanelOpen);

  return (
    <div className="flex h-screen flex-col bg-void font-body text-txt">
      <NavBar active={active} onOpenAgent={toggleAIPanel} agentOpen={aiPanelOpen} />
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      {/* Launcher lives in the top bar; the panel itself is opened from there. */}
      <ChatPanel showLauncher={false} />
    </div>
  );
}

