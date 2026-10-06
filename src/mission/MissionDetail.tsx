// Mission Detail (Ratio v2 Workstream 1, Layer 2) — the drill-down behind a
// mission card. Progressive disclosure: this carries the FULL v1 engine depth,
// re-presented as mission sections. The six v1 detail tabs are reused verbatim
// in capability (relabeled, not reduced), so a practitioner loses nothing while
// a newcomer is never forced to see it. No engine changes — values are identical
// to the v1 detail panel. Renders fully offline on mock data.
//
// Accessibility (PR C): Escape to close, auto-focus back button on open, ARIA
// tablist with Left/Right/Home/End arrow-key navigation across mission sections.
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { useStore, type DetailTab } from '@/store/useStore';
import { formatInt, formatRatio } from '@/lib/format';
import { PROVIDER_LABEL, ratioColor, TOKEN_HEX } from '@/lib/scales';
import { KpiCards } from '@/components/detail/KpiCards';
import { BudgetProfileTab } from '@/components/detail/BudgetProfileTab';
import { MultiModelTab } from '@/components/detail/MultiModelTab';
import { GovernanceTab } from '@/components/detail/GovernanceTab';
import { DemandShapingTab } from '@/components/detail/DemandShapingTab';
import { UnitCostsTab } from '@/components/detail/UnitCostsTab';
import { AlertHistoryTab } from '@/components/detail/AlertHistoryTab';
import { AdjustmentCards } from './AdjustmentCards';
import { AccuracyLedgerSummary } from './AccuracyLedgerSummary';
import { toMissionView, type MissionStatus } from './missionModel';

// Mission Detail surfaces the six v1 sections plus the WS3 "Adjustments" capstone
// (PR H). 'adjust' is not a v1 DetailTab — it is the new change-management surface.
type MissionSectionId = DetailTab | 'adjust';

// Mission sections map 1:1 onto the six v1 detail tabs (spec §3.4 → Workstream 1
// mapping table). `tab` is the underlying v1 DetailTab id; `label` is the mission
// re-labeling; `v1` names the capability it carries so the lineage is explicit.
interface MissionSection {
  tab: MissionSectionId;
  label: string;
  v1?: string; // the v1 capability this section carries; undefined for new WS3 surfaces
}

const SECTIONS: MissionSection[] = [
  { tab: 'budget', label: 'Budget & Forecast', v1: 'Budget Profile' },
  { tab: 'models', label: 'Model Selection', v1: 'Multi-Model' },
  { tab: 'governance', label: 'Governance', v1: 'Governance Gates' },
  { tab: 'demand', label: 'Demand Shaping', v1: 'Demand Shaping' },
  { tab: 'unit', label: 'Unit Costs', v1: 'Unit Costs' },
  { tab: 'alerts', label: 'Alert History', v1: 'Alert History' },
  { tab: 'adjust', label: 'Proposed Changes' },
];

const STATUS_META: Record<MissionStatus, { label: string; color: string }> = {
  nominal: { label: 'ON TRACK', color: TOKEN_HEX.value },
  caution: { label: 'AT RISK', color: TOKEN_HEX.shape },
  critical: { label: 'CRITICAL', color: TOKEN_HEX.cost },
};

interface MissionDetailProps {
  missionId: string;
  // Back affordance to the Mission Board (Layer 1).
  onBack: () => void;
}

export function MissionDetail({ missionId, onBack }: MissionDetailProps) {
  const workloads = useStore((s) => s.workloads);
  const budgets = useStore((s) => s.budgets);
  const models = useStore((s) => s.models);
  const now = useStore((s) => s.now);
  const alerts = useStore(s => s.alerts);

  // Each mission detail keeps its own open section, defaulting to Fuel &
  // Trajectory (the spec’s default drill-down section).
  const [section, setSection] = useState<MissionSectionId>('budget');

  // Ref for auto-focus on open (WCAG 2.4.3 — moving keyboard focus into the new
  // view so screen-reader users know the context changed).
  const backButtonRef = useRef<HTMLButtonElement>(null);
  // One ref slot per SECTIONS entry — used for arrow-key focus in the tablist.
  const sectionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Auto-focus the back button when the detail mounts.
  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);

  // Escape anywhere in the detail closes it and returns to the board.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onBack();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onBack]);

  // ARIA tablist arrow-key navigation (roving tabindex pattern).
  const handleSectionKey = useCallback(
    (e: React.KeyboardEvent, idx: number) => {
      let target: number | null = null;
      if (e.key === 'ArrowRight') target = (idx + 1) % SECTIONS.length;
      else if (e.key === 'ArrowLeft') target = (idx - 1 + SECTIONS.length) % SECTIONS.length;
      else if (e.key === 'Home') target = 0;
      else if (e.key === 'End') target = SECTIONS.length - 1;
      if (target !== null) {
        e.preventDefault();
        setSection(SECTIONS[target].tab);
        sectionRefs.current[target]?.focus();
      }
    },
    [],
  );

  const workload = workloads.find((w) => w.id === missionId);
  const budget = budgets.find((b) => b.workload_id === missionId);

  if (!workload || !budget) {
    return (
      <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
        <div className="mx-auto max-w-5xl space-y-6">
          <BackToFleet ref={backButtonRef} onBack={onBack} />
          <p className="text-sm text-dim">Workload not found.</p>
        </div>
      </div>
    );
  }

  // Reuse the board view-model so the detail header reads the SAME status and
  // value the card showed — no divergent copy of the truth.
  const view = toMissionView(workload, { budgets, alerts, now });
  const meta = STATUS_META[view.status];
  const activeSection = SECTIONS.find((s) => s.tab === section);

  return (
    <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
      <div className="mx-auto max-w-5xl space-y-6">
        <BackToFleet ref={backButtonRef} onBack={onBack} />

        {/* Mission header — R4: the value badge rides in the header so no cost
            section ever appears without its value context. */}
        <header className="rounded-card border border-edge bg-slab p-6" style={{ borderLeft: `2px solid ${meta.color}` }}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-body text-2xl font-semibold tracking-tight text-txt">
                {workload.name}
              </h1>
              <p className="mt-1 font-mono text-xs text-sub">
                {workload.model} · {PROVIDER_LABEL[workload.model_provider]} · {workload.team} ·{' '}
                {workload.environment}
              </p>
              <div className="mt-3 flex items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest"
                  style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}
                >
                  {meta.label}
                </span>
                {view.alertCount > 0 && (
                  <span className="font-mono text-[10px] text-sub">
                    {view.alertCount} active {view.alertCount === 1 ? 'warning' : 'warnings'}
                  </span>
                )}
              </div>
            </div>

            {/* Value badge (R4 — the denominator) */}
            <div className="text-right">
              <div
                className="font-mono text-2xl font-bold"
                style={{ color: ratioColor(workload.value.value_ratio) }}
              >
                {formatRatio(workload.value.value_ratio)} return
              </div>
              <div className="mt-0.5 font-mono text-xs text-sub">
                {formatInt(workload.outputs.daily_inferences)} calls/day
              </div>
            </div>
          </div>
        </header>

        {/* Section nav — ARIA tablist so keyboard users can arrow between sections.
            Only the active tab is in the tab sequence (tabIndex 0); the rest are
            reachable via Left/Right/Home/End (roving tabindex pattern). */}
        <nav role="tablist" aria-label="Workload sections" className="flex flex-wrap gap-2">
          {SECTIONS.map((s, idx) => {
            const active = section === s.tab;
            return (
              <button
                key={s.tab}
                ref={(el) => {
                  sectionRefs.current[idx] = el;
                }}
                type="button"
                role="tab"
                id={`mission-tab-${s.tab}`}
                aria-selected={active}
                aria-controls={`mission-panel-${s.tab}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setSection(s.tab)}
                onKeyDown={(e) => handleSectionKey(e, idx)}
                className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gate ${
                  active
                    ? 'border-gate bg-raised text-txt'
                    : 'border-edge text-dim hover:text-sub'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </nav>

        {/* Active section body — the unchanged v1 tab, full depth. KpiCards rides
            above every section exactly as in the v1 detail panel (R4: value
            anchors the KPI row). tabIndex={0} makes the panel focusable for
            screen-reader users navigating with Enter from the tab row. */}
        <section
          id={`mission-panel-${section}`}
          role="tabpanel"
          aria-labelledby={`mission-tab-${section}`}
          tabIndex={0}
          className="space-y-5 rounded-card border border-edge bg-deep p-6 focus:outline-none focus-visible:ring-2 focus-visible:ring-gate"
        >
          {/* Lineage caption — each mission section IS a full v1 capability. */}
          {activeSection && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-dim">
              {activeSection.v1
                ? `${activeSection.label} · carries v1 ${activeSection.v1}`
                : `${activeSection.label} · Ratio v2 change management (WS3)`}
            </p>
          )}
          <KpiCards workload={workload} />
          {section === 'budget' && (
            <BudgetProfileTab workload={workload} budget={budget} now={now} />
          )}
          {section === 'models' && <MultiModelTab workload={workload} models={models} />}
          {section === 'governance' && <GovernanceTab workload={workload} />}
          {section === 'demand' && <DemandShapingTab workload={workload} budget={budget} />}
          {section === 'unit' && <UnitCostsTab workload={workload} />}
          {section === 'alerts' && <AlertHistoryTab workloadId={workload.id} />}
          {section === 'adjust' && (
            <div className="space-y-5">
              <AdjustmentCards workload={workload} />
              <AccuracyLedgerSummary />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// forwardRef so MissionDetail can auto-focus the back button on mount.
const BackToFleet = forwardRef<HTMLButtonElement, { onBack: () => void }>(
  function BackToFleet({ onBack }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onBack}
        aria-label="Back to workload board"
        className="inline-flex items-center gap-1.5 font-mono text-xs text-sub transition-colors hover:text-txt focus:outline-none focus-visible:ring-2 focus-visible:ring-gate"
      >
        <span aria-hidden>&#8592;</span> Portfolio
      </button>
    );
  },
);

