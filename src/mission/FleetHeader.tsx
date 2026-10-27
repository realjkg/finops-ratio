// Portfolio header (Ratio v2 Workstream 1 / Wave3a). Portfolio summary bar:
// total value returned, workloads needing attention, and aggregate budget
// consumed. Aggregates trace to the same engine outputs the cards use.
import { motion, useReducedMotion } from 'framer-motion';
import { formatRatio } from '@/lib/format';
import { TOKEN_COLOR } from '@/lib/scales';
import type { FleetSummary } from './missionModel';

interface FleetHeaderProps {
  fleet: FleetSummary;
}

export function FleetHeader({ fleet }: FleetHeaderProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const attentionColor = fleet.needsAttention > 0 ? TOKEN_COLOR.shape : TOKEN_COLOR.value;

  return (
    <header className="rounded-card border border-edge bg-slab p-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-body text-2xl font-semibold tracking-tight text-txt">
            Workload Portfolio
          </h1>
        </div>

        <dl className="flex flex-wrap items-end gap-x-10 gap-y-4">
          {/* Total value returned (R4 — the denominator leads the briefing) */}
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-wider text-dim">
              Value returned
            </dt>
            <dd className="font-mono text-2xl font-bold" style={{ color: TOKEN_COLOR.value }}>
              {formatRatio(fleet.valueReturned)}
            </dd>
          </div>

          {/* Missions needing attention */}
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-wider text-dim">
              Needs attention
            </dt>
            <dd className="font-mono text-2xl font-bold" style={{ color: attentionColor }}>
              {fleet.needsAttention}
              <span className="ml-1 text-sm font-normal text-sub">/ {fleet.missionCount}</span>
              {fleet.budgetNa > 0 && <span className="ml-2 text-xs font-normal text-sub">Budget N/A: {fleet.budgetNa}</span>}
            </dd>
          </div>
        </dl>
      </div>

      {/* Fleet fuel gauge */}
      <div className="mt-6">
        <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-dim">
          <span>Portfolio budget consumed</span>
          <span style={{ color: fleet.fleetFuelColor }}>{fleet.fleetFuelPct === null ? `N/A (${fleet.fleetFuelNa})` : `${fleet.fleetFuelPct}%`}</span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={fleet.fleetFuelPct === null ? undefined : Math.min(fleet.fleetFuelPct, 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={fleet.fleetFuelPct === null ? 'N/A' : `${fleet.fleetFuelPct}% of fleet daily budget consumed`}
          aria-label="Portfolio budget consumed (aggregate daily budget)"
          className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
        >
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: fleet.fleetFuelColor }}
            initial={reducedMotion ? false : { width: 0 }}
            animate={{ width: `${Math.min(fleet.fleetFuelPct ?? 0, 100)}%` }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.9, ease: 'easeOut' }}
          />
        </div>
      </div>
    </header>
  );
}

