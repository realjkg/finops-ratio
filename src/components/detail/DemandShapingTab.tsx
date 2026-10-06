// Demand Shaping tab — spec §3.4.4, §5.3. Six-option radio with projected monthly
// cost per shape; Always-On is blocked unless all gates pass. Also hosts the
// editable soft/hard/kill budget thresholds (spec §3.4, §4.1).

import { useMemo } from 'react';
import type { BudgetProfile, DemandShape, Workload } from '@/types';
import { useStore } from '@/store/useStore';
import { SHAPE_DESCRIPTION, SHAPE_LABEL, shapeProjections } from '@/lib/demandShape';
import { formatUSD } from '@/lib/format';

export function DemandShapingTab({
  workload,
  budget,
}: {
  workload: Workload;
  budget: BudgetProfile;
}) {
  const sim = useStore(s => s.simulation);
  const busy = useStore(s => s.simulationBusy);
  const setDemandShape = useStore((s) => s.setDemandShape);
  const updateThresholds = useStore((s) => s.updateThresholds);
  const projections = useMemo(() => shapeProjections(workload), [workload]);
  const currentMonthly =
    projections.find((p) => p.shape === workload.demand_shape)?.projectedMonthly ??
    workload.costs.monthly_spend;

  const setThreshold = (field: 'soft' | 'hard' | 'kill', value: number) => {
    const next = {
      soft: budget.soft_threshold_pct,
      hard: budget.hard_threshold_pct,
      kill: budget.kill_threshold_pct,
      [field]: value / 100,
    };
    updateThresholds(workload.id, next);
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-sub">Demand shape</h3>
        <div className="space-y-2">
          {projections.map((p) => {
            const active = p.shape === workload.demand_shape;
            const blocked = p.blockedReason !== null;
            const delta = p.projectedMonthly - currentMonthly;
            return (
              <button
                key={p.shape}
                type="button"
                disabled={blocked || busy || Boolean(sim && sim.session.identity.persona !== 'technical')}
                onClick={() => setDemandShape(workload.id, p.shape as DemandShape)}
                className={`flex w-full items-center gap-3 rounded-card border px-4 py-3 text-left transition-colors ${
                  active ? 'border-unit bg-unit/10' : 'border-edge bg-slab hover:border-sub'
                } ${blocked ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                  style={{ borderColor: active ? 'var(--unit)' : 'var(--dim)' }}
                >
                  {active && <span className="h-2 w-2 rounded-full bg-unit" />}
                </span>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-txt">{SHAPE_LABEL[p.shape]}</span>
                    <span className="font-mono text-xs text-txt">
                      {formatUSD(p.projectedMonthly, { compact: true })}/mo
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-sub">
                      {blocked ? p.blockedReason : SHAPE_DESCRIPTION[p.shape]}
                    </span>
                    {!active && !blocked && Math.abs(delta) > 1 && (
                      <span
                        className="font-mono text-[10px]"
                        style={{ color: delta < 0 ? 'var(--value)' : 'var(--cost)' }}
                      >
                        {delta < 0 ? '' : '+'}
                        {formatUSD(delta, { compact: true })}/mo
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-sub">
          Budget thresholds
        </h3>
        <div className="space-y-4 rounded-card border border-edge bg-slab p-4">
          <ThresholdSlider
            label="Soft alert"
            color="var(--value)"
            value={Math.round(budget.soft_threshold_pct * 100)}
            min={10}
            max={Math.round(budget.hard_threshold_pct * 100) - 5}
            onChange={(v) => setThreshold('soft', v)}
          />
          <ThresholdSlider
            label="Hard alert"
            color="var(--shape)"
            value={Math.round(budget.hard_threshold_pct * 100)}
            min={Math.round(budget.soft_threshold_pct * 100) + 5}
            max={Math.round(budget.kill_threshold_pct * 100) - 5}
            onChange={(v) => setThreshold('hard', v)}
          />
          <ThresholdSlider
            label="Kill switch"
            color="var(--cost)"
            value={Math.round(budget.kill_threshold_pct * 100)}
            min={Math.round(budget.hard_threshold_pct * 100) + 5}
            max={120}
            onChange={(v) => setThreshold('kill', v)}
          />
        </div>
      </section>
    </div>
  );
}

function ThresholdSlider({
  label,
  color,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  color: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-sub">{label}</span>
        <span className="font-mono text-sm font-bold" style={{ color }}>
          {value}%
        </span>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-current"
        style={{ accentColor: color }}
      />
    </div>
  );
}

