// Mission Surface (Ratio v2 Wave 2a). Persona-driven switch over the /mission
// route. Executives (the default) and procurement land on the light Initiative
// Dashboard; technical users (CTO / FinOps) opt into the unchanged dark Mission
// Control board. The MissionBoard component itself is untouched — the back-to-
// executive affordance is overlaid as a thin top bar so the dark surface renders
// exactly as before.
import { usePersona } from '@/lib/persona';
import { MissionBoard } from '@/mission/MissionBoard';
import { TechnicalViewToggle } from '@/components/TechnicalViewToggle';
import { ChatPanel } from '@/components/ai/ChatPanel';
import { InitiativeDashboard } from './InitiativeDashboard';

// `embedded` is set when MissionSurface renders inside the shared AppShell
// (the /overview object): the shell already owns the top bar and the single
// ChatPanel, so the dashboard renders as a content area — no standalone header,
// no second chat overlay. The legacy standalone /mission route renders it
// un-embedded, keeping its own ChatPanel and full-height surface.
export function MissionSurface({ embedded = false }: { embedded?: boolean }) {
  const { persona } = usePersona();

  return (
    <>
      {persona === 'technical' ? (
        <div className={embedded ? 'bg-void' : 'min-h-screen bg-void'}>
          <div className="flex justify-end border-b border-edge bg-deep px-4 py-2">
            <TechnicalViewToggle className="rounded-full border border-edge px-3 py-1 text-gate hover:bg-raised" />
          </div>
          <MissionBoard />
        </div>
      ) : (
        <InitiativeDashboard embedded={embedded} />
      )}
      {/* Un-embedded only: the AIClient-backed ChatPanel as a fixed overlay
          (Wave3b spec §7.3). When embedded, the AppShell owns the single panel. */}
      {!embedded && <ChatPanel />}
    </>
  );
}

