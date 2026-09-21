// Mission Board (Ratio v2 Workstream 1, Layer 1) — the simple-by-default surface.
// Renders every workload as a mission card over the unchanged v1 engine, fully
// offline on mock seed data. Tapping a mission opens Mission Detail (Layer 2).
// Board↔detail transitions use AnimatePresence (fade+lift) so the switch is
// perceivable and focus is managed per WCAG 2.4.3 — closing the detail returns
// focus to the card that triggered the drill-in.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useStore } from '@/store/useStore';
import { FleetHeader } from './FleetHeader';
import { MissionCard } from './MissionCard';
import { MissionDetail } from './MissionDetail';
import { buildMissionBoard } from './missionModel';

export function MissionBoard() {
  // Read workloads from the store so Mission Detail edits (demand shape, gates)
  // stay consistent with the board view-model — one source of truth.
  const workloads = useStore((s) => s.workloads);
  const [openMissionId, setOpenMissionId] = useState<string | null>(null);
  // Track the last-opened id so focus can be restored on close (WCAG 2.4.3).
  const lastOpenedIdRef = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const { missions, fleet } = useMemo(() => buildMissionBoard(workloads), [workloads]);

  const handleOpen = useCallback((id: string) => {
    lastOpenedIdRef.current = id;
    setOpenMissionId(id);
  }, []);

  const handleBack = useCallback(() => {
    setOpenMissionId(null);
  }, []);

  // After the detail closes and the board re-renders, move focus back to the
  // card that triggered the drill-in (rAF waits for the paint so the DOM node
  // is guaranteed visible before .focus() fires).
  useEffect(() => {
    if (!openMissionId && lastOpenedIdRef.current) {
      requestAnimationFrame(() => {
        const card = boardRef.current?.querySelector<HTMLElement>(
          `[data-mission-id="${lastOpenedIdRef.current}"]`,
        );
        card?.focus();
      });
    }
  }, [openMissionId]);

  // Fade + gentle lift: subtle direction cue without overwhelming motion.
  const pageVariants = {
    hidden: { opacity: 0, y: reducedMotion ? 0 : 8 },
    visible: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reducedMotion ? 0 : -8 },
  } as const;
  const transition = { duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' } as const;

  return (
    <AnimatePresence mode="wait">
      {openMissionId ? (
        <motion.div
          key="detail"
          variants={pageVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={transition}
        >
          <MissionDetail missionId={openMissionId} onBack={handleBack} />
        </motion.div>
      ) : (
        <motion.div
          key="board"
          variants={pageVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={transition}
        >
          <div ref={boardRef} className="min-h-screen bg-void px-4 py-10 font-body text-txt">
            <div className="mx-auto max-w-6xl space-y-8">
              <FleetHeader fleet={fleet} />

              <main aria-label="Workload board">
                <h2 className="sr-only">Missions</h2>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {missions.map((mission) => (
                    <MissionCard
                      key={mission.id}
                      mission={mission}
                      onOpen={() => handleOpen(mission.id)}
                    />
                  ))}
                </div>
              </main>

              <Link href="/" className="block text-center text-xs text-dim hover:text-sub">
                ← back to Ratio
              </Link>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}



