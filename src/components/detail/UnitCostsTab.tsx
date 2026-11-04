// Unit Costs tab — spec §3.4.5. Eight-metric grid: per-call, per-resolved,
// per-user, per-deflection, handle time, satisfaction, trend, and return. This
// is the R1 view — cost per AI output, not cost per VM.

import { workloadValueRatio } from '@/lib/valueRatio';
import type { Workload } from '@/types';
import { deriveUnitCosts } from '@/lib/derive';
import {
  formatCents,
  formatRatio,
  formatSignedPct,
  formatUSD,
} from '@/lib/format';
import { ratioColor } from '@/lib/scales';

export function UnitCostsTab({ workload }: { workload: Workload }) {
  const unit = deriveUnitCosts(workload);
  const { outputs } = workload;

  const metrics: Array<{ label: string; value: string; note: string; color?: string }> = [
    {
      label: 'Cost / call',
      value: formatCents(unit.cost_per_call),
      note: `${outputs.daily_inferences.toLocaleString()} calls today`,
    },
    {
      label: 'Cost / resolved',
      value: formatCents(unit.cost_per_resolved),
      note: `${(outputs.resolution_rate * 100).toFixed(0)}% resolution rate`,
    },
    {
      label: 'Cost / active user',
      value: unit.cost_per_user !== null ? formatUSD(unit.cost_per_user) : 'n/a',
      note: `${outputs.active_users_monthly.toLocaleString()} users/mo`,
    },
    {
      label: 'Cost / deflection',
      value: unit.cost_per_deflection !== null ? formatCents(unit.cost_per_deflection) : 'n/a',
      note:
        outputs.deflection_rate > 0
          ? `${(outputs.deflection_rate * 100).toFixed(0)}% deflected`
          : 'no deflection',
    },
    {
      label: 'Avg handle time',
      value: `${outputs.avg_handle_time_seconds}s`,
      note: 'per interaction',
    },
    {
      label: 'Satisfaction',
      value: outputs.csat !== null ? `${outputs.csat.toFixed(1)} / 5` : 'n/a',
      note: 'CSAT',
    },
    {
      label: 'Cost trend',
      value: formatSignedPct(workload.cost_trend_pct, 1),
      note: 'month-over-month',
      color: workload.cost_trend_pct > 0 ? 'var(--cost)' : 'var(--value)',
    },
    {
      label: 'Value / cost',
      value: formatRatio(workloadValueRatio(workload)),
      note: `${formatUSD(workload.value.total_value, { compact: true })}/mo value`,
      color: ratioColor(workloadValueRatio(workload)),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {metrics.map((m) => (
        <div key={m.label} className="rounded-card border border-edge bg-slab p-3">
          <div className="text-[10px] uppercase tracking-wider text-dim">{m.label}</div>
          <div
            className="mt-1 font-mono text-lg font-bold"
            style={{ color: m.color ?? 'var(--txt)' }}
          >
            {m.value}
          </div>
          <div className="mt-0.5 text-[11px] text-sub">{m.note}</div>
        </div>
      ))}
    </div>
  );
}

