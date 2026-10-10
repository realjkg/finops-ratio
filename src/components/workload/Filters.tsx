// Workload-list filters — spec §3.3. VALUE | COST | UNIT toggle (switches the
// card's secondary label) plus team / provider / environment selects.

import { useMemo } from 'react';
import { useStore, type SecondaryMode } from '@/store/useStore';
import { PROVIDER_LABEL } from '@/lib/scales';
import type { Filters as FilterState } from '@/store/useStore';

const MODES: Array<{ value: SecondaryMode; label: string }> = [
  { value: 'value', label: 'VALUE' },
  { value: 'cost', label: 'COST' },
  { value: 'unit', label: 'UNIT' },
];

export function Filters() {
  const workloads = useStore((s) => s.workloads);
  const filters = useStore((s) => s.filters);
  const secondaryMode = useStore((s) => s.secondaryMode);
  const setSecondaryMode = useStore((s) => s.setSecondaryMode);
  const setFilter = useStore((s) => s.setFilter);

  const teams = useMemo(
    () => Array.from(new Set(workloads.map((w) => w.team))).sort(),
    [workloads],
  );
  const providers = useMemo(
    () => Array.from(new Set(workloads.map((w) => w.model_provider))).sort(),
    [workloads],
  );
  const environments = useMemo(
    () => Array.from(new Set(workloads.map((w) => w.environment))).sort(),
    [workloads],
  );

  return (
    <div className="flex flex-col gap-2.5 border-b border-edge px-3 py-3">
      <div className="flex rounded-md border border-edge bg-void p-0.5">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            onClick={() => setSecondaryMode(mode.value)}
            className={`flex-1 rounded py-1 font-mono text-[10px] font-bold tracking-wider transition-colors ${
              secondaryMode === mode.value
                ? 'bg-raised text-unit'
                : 'text-dim hover:text-sub'
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <FilterSelect
          label="Team"
          value={filters.team}
          field="team"
          options={teams}
          onChange={setFilter}
        />
        <FilterSelect
          label="Provider"
          value={filters.provider}
          field="provider"
          options={providers}
          render={(p) => PROVIDER_LABEL[p as keyof typeof PROVIDER_LABEL] ?? p}
          onChange={setFilter}
        />
        <FilterSelect
          label="Env"
          value={filters.environment}
          field="environment"
          options={environments}
          onChange={setFilter}
        />
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  field,
  options,
  render,
  onChange,
}: {
  label: string;
  value: string;
  field: keyof FilterState;
  options: string[];
  render?: (value: string) => string;
  onChange: (field: keyof FilterState, value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-wider text-dim">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(field, e.target.value)}
        className="min-w-0 w-full rounded border border-edge bg-slab px-1.5 py-1 font-mono text-[11px] text-txt outline-none focus:border-unit"
      >
        <option value="all">All</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {render ? render(opt) : opt}
          </option>
        ))}
      </select>
    </label>
  );
}

