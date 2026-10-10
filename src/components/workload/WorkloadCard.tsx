// Workload card — spec §3.3. Name, model + team, value-ratio bar, gate dots,
// demand-shape badge, and cost-trend arrow. The bar's right label switches with
// the VALUE | COST | UNIT toggle.

import type { Workload } from '@/types';
import type { SecondaryMode } from '@/store/useStore';
import type { LandedProvenance } from '@/connectors/ingestLanding';
import { deriveUnitCosts } from '@/lib/derive';
import { formatCents, formatSignedPct, formatUSD } from '@/lib/format';
import { PROVIDER_LABEL } from '@/lib/scales';
import { ValueRatioBar } from './ValueRatioBar';
import { GateDots } from './GateDots';
import { DemandShapeBadge } from './DemandShapeBadge';

function secondaryLabel(workload: Workload, mode: SecondaryMode): string {
  switch (mode) {
    case 'value':
      return `${formatUSD(workload.value.total_value, { compact: true })}/mo value`;
    case 'cost':
      return `${formatUSD(workload.costs.monthly_spend, { compact: true })}/mo spend`;
    case 'unit': {
      const unit = deriveUnitCosts(workload);
      return `${formatCents(unit.cost_per_resolved)}/resolved`;
    }
  }
}

export function WorkloadCard({
  workload,
  selected,
  secondaryMode,
  onSelect,
  landedVia,
}: {
  workload: Workload;
  selected: boolean;
  secondaryMode: SecondaryMode;
  onSelect: (id: string) => void;
  /** Connector provenance: this workload's rows landed in an ingest run. */
  landedVia?: LandedProvenance;
}) {
  const trendUp = workload.cost_trend_pct > 0;
  return (
    <button
      type="button"
      onClick={() => onSelect(workload.id)}
      className={`w-full rounded-card border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-unit bg-raised'
          : 'border-edge bg-slab hover:border-sub hover:bg-raised'
      }`}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="text-[13px] font-semibold leading-tight text-txt">{workload.name}</span>
        <span
          className="flex items-center gap-0.5 font-mono text-[10px]"
          style={{ color: trendUp ? 'var(--cost)' : 'var(--value)' }}
        >
          {trendUp ? '▲' : '▼'} {formatSignedPct(workload.cost_trend_pct, 1)}
        </span>
      </div>
      <div className="mb-2 font-mono text-[10px] text-dim">
        {workload.model} · {workload.team} · {PROVIDER_LABEL[workload.model_provider]}
      </div>

      {landedVia && (
        <div
          className="mb-2 flex items-center gap-1.5 font-mono text-[10px]"
          style={{ color: 'var(--value)' }}
          title={`Cost rows for this workload landed from ${landedVia.sourceName} at ${landedVia.at}`}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--value)' }} />
          landed via {landedVia.sourceName}
        </div>
      )}

      <ValueRatioBar ratio={workload.value.value_ratio} rightLabel={secondaryLabel(workload, secondaryMode)} />

      <div className="mt-2 flex items-center justify-between">
        <GateDots governance={workload.governance} />
        <DemandShapeBadge shape={workload.demand_shape} />
      </div>
    </button>
  );
}

