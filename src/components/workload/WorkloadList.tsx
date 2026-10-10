// Left panel — workload list (spec §3.3). Filtered, then sorted by value ratio
// ascending so the worst ratios surface first for action.

import { useMemo } from 'react';
import { useStore } from '@/store/useStore';
import { Filters } from './Filters';
import { WorkloadCard } from './WorkloadCard';

export function WorkloadList() {
  const workloads = useStore((s) => s.workloads);
  const filters = useStore((s) => s.filters);
  const secondaryMode = useStore((s) => s.secondaryMode);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  const visible = useMemo(() => {
    return workloads
      .filter((w) => filters.team === 'all' || w.team === filters.team)
      .filter((w) => filters.provider === 'all' || w.model_provider === filters.provider)
      .filter((w) => filters.environment === 'all' || w.environment === filters.environment)
      .sort((a, b) => a.value.value_ratio - b.value.value_ratio);
  }, [workloads, filters]);

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-edge bg-deep md:w-[280px] md:border-b-0 md:border-r">
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="text-[11px] font-bold uppercase tracking-wider text-sub">Workloads</span>
        <span className="font-mono text-[10px] text-dim">{visible.length} shown</span>
      </div>
      <Filters />
      <div className="flex gap-2 overflow-x-auto px-3 py-3 md:block md:flex-1 md:space-y-2 md:overflow-y-auto">
        {visible.length === 0 ? (
          <p className="px-1 pt-6 text-center text-xs text-dim">
            No workloads match these filters.
          </p>
        ) : (
          visible.map((w) => (
            <div key={w.id} className="w-[82vw] max-w-sm shrink-0 md:w-auto md:max-w-none">
              <WorkloadCard
                workload={w}
                selected={w.id === selectedId}
                secondaryMode={secondaryMode}
                onSelect={select}
              />
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

