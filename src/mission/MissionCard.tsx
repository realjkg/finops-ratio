// Mission card (Ratio v2 Workstream 1, Layer 1 / Wave3a clean enterprise). One
// workload rendered as a data tile: name, status dot, budget gauge + value badge
// (R4), trajectory verdict, and a drill-down affordance. Left-border accent
// replaces the gamified top-border + card-lift pattern.
import { TOKEN_HEX } from '@/lib/scales';
import { FuelAndValue } from './FuelAndValue';
import type { MissionStatus, MissionView } from './missionModel';
import { StatusPulse } from './StatusPulse';

const STATUS_META: Record<MissionStatus, { label: string; color: string }> = {
  nominal: { label: 'ON TRACK', color: TOKEN_HEX.value },
  caution: { label: 'AT RISK', color: TOKEN_HEX.shape },
  critical: { label: 'CRITICAL', color: TOKEN_HEX.cost },
};

interface MissionCardProps {
  mission: MissionView;
  // Tapping the card opens its Mission Detail (Layer 2 drill-down).
  onOpen: () => void;
}

export function MissionCard({ mission, onOpen }: MissionCardProps) {
  const meta = STATUS_META[mission.status];

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${mission.name} workload detail — ${meta.label}, ${mission.fuelPct}% budget consumed, value ratio ${mission.valueRatio.toFixed(1)}x`}
      data-mission-id={mission.id}
      className="flex w-full flex-col gap-4 rounded-card border border-edge bg-slab p-5 text-left transition-colors hover:bg-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-gate"
      style={{ borderLeft: `2px solid ${meta.color}` }}
    >
      {/* Header: workload name + status dot */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-body text-base font-semibold text-txt">{mission.name}</h3>
          <p className="mt-0.5 truncate font-mono text-xs text-dim">
            {mission.model} · {mission.providerLabel} · {mission.team}
          </p>
        </div>
        <StatusPulse status={mission.status} />
      </header>

      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest"
          style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}
        >
          {meta.label}
        </span>
        {mission.alertCount > 0 && (
          <span className="font-mono text-[10px] text-sub">
            {mission.alertCount} active {mission.alertCount === 1 ? 'warning' : 'warnings'}
          </span>
        )}
      </div>

      {/* Budget gauge + value badge (R4 — never one without the other) */}
      <FuelAndValue
        fuelPct={mission.fuelPct}
        fuelColor={mission.fuelColor}
        spentToday={mission.spentToday}
        dailyBudget={mission.dailyBudget}
        valueRatio={mission.valueRatio}
        valueColor={mission.valueColor}
        evidenceStatus={mission.valueEvidenceStatus}
      />

      {/* Trajectory verdict (monthly forecast, plain language) */}
      <p className="flex items-start gap-1.5 border-t border-edge pt-3 text-sm text-sub">
        <span aria-hidden style={{ color: meta.color }}>
          ↗
        </span>
        <span>{mission.trajectoryVerdict}</span>
      </p>

      {/* Drill-down affordance into Mission Detail (Layer 2) */}
      <span aria-hidden className="font-mono text-[11px] font-semibold text-gate">
        View details →
      </span>
    </button>
  );
}

