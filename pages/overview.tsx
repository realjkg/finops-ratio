// Overview route — the executive Initiative Dashboard demoted from home
// (Wave 4 Slice 1). Served at /overview inside the shared AppShell, which owns
// the top bar + agent launcher. Wave 4 Slice 2: portfolio spend-to-value graph
// added as a secondary section above the executive surface.
import { useMemo } from 'react';
import { MissionSurface } from '@/executive/MissionSurface';
import { SpendToValueGraph } from '@/findings/SpendToValueGraph';
import { useStore } from '@/store/useStore';

export default function Overview() {
  const workloads = useStore((s) => s.workloads);
  // Memoised so the graph doesn't re-render on unrelated store changes.
  const graphWorkloads = useMemo(() => workloads, [workloads]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Portfolio — spend-to-value scatter (secondary, above the dashboard) */}
        <section className="border-b border-edge bg-deep px-6 py-5">
          <p className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            Portfolio — Spend vs. Value
          </p>
          <p className="mb-4 text-xs text-sub">
            All workloads by monthly spend and value ratio. Reference lines mark break-even (1x) and the Gate 3 minimum (3x).
          </p>
          <SpendToValueGraph workloads={graphWorkloads} size="large" />
        </section>

        {/* Embedded: the shell owns the top bar + ChatPanel, so MissionSurface
            renders only the dashboard body (no standalone header, no second chat). */}
        <MissionSurface embedded />
      </div>
    </div>
  );
}
