// KPI cards — spec §12 Sprint 1: Value, Spend, Per Query, Per User. Each cost is
// shown with its value context (R4): the Value card anchors the row.

import type { EvidenceStatus, Workload } from '@/types';
import { EvidenceMark } from '@/components/EvidenceMark';
import { headlineEvidenceStatus } from '@/lib/valueEvidence';
import { deriveUnitCosts } from '@/lib/derive';
import { formatCents, formatRatio, formatSignedPct, formatUSD } from '@/lib/format';
import { ratioColor } from '@/lib/scales';

export function KpiCards({ workload }: { workload: Workload }) {
  const unit = deriveUnitCosts(workload);
  const trendUp = workload.cost_trend_pct > 0;
  // The Value card anchors the band — its ratio carries the provenance mark.
  const valueEvidence = headlineEvidenceStatus(workload.value);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card
        label="Value / mo"
        value={formatUSD(workload.value.total_value, { compact: true })}
        accent="var(--value)"
        note={`${formatRatio(workload.value.value_ratio)} return`}
        noteColor={ratioColor(workload.value.value_ratio)}
        evidenceStatus={valueEvidence}
      />
      <Card
        label="Spend / mo"
        value={formatUSD(workload.costs.monthly_spend, { compact: true })}
        accent="var(--cost)"
        note={`${formatSignedPct(workload.cost_trend_pct, 1)} MoM`}
        noteColor={trendUp ? 'var(--cost)' : 'var(--value)'}
      />
      <Card
        label="Per Resolved Query"
        value={formatCents(unit.cost_per_resolved)}
        accent="var(--unit)"
        note={`${(workload.outputs.resolution_rate * 100).toFixed(0)}% resolved`}
        noteColor="var(--sub)"
      />
      <Card
        label="Per Active User"
        value={unit.cost_per_user !== null ? formatUSD(unit.cost_per_user) : 'n/a'}
        accent="var(--purple)"
        note={`${workload.outputs.active_users_monthly.toLocaleString()} users/mo`}
        noteColor="var(--sub)"
      />
    </div>
  );
}

function Card({
  label,
  value,
  accent,
  note,
  noteColor,
  evidenceStatus,
}: {
  label: string;
  value: string;
  accent: string;
  note: string;
  noteColor: string;
  evidenceStatus?: EvidenceStatus;
}) {
  return (
    <div className="rounded-card border border-edge bg-slab p-3" style={{ borderTop: `2px solid ${accent}` }}>
      <div className="text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="mt-1 font-mono text-xl font-bold text-txt">{value}</div>
      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px]">
        <span style={{ color: noteColor }}>{note}</span>
        <EvidenceMark status={evidenceStatus} />
      </div>
    </div>
  );
}

