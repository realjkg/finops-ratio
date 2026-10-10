// Multi-Model Comparison tab — spec §3.4.2. What the same workload would cost on
// every registry model at today's volume. Cheaper = green, pricier = red, with a
// value-ratio framing note and an A/B-test caveat.

import { useStore } from '@/store/useStore';
import { useMemo, useState } from 'react';
import type { ModelEntry, Workload } from '@/types';
import {
  compareModels,
  cheapestAlternative,
  projectedOvershoot,
  type ModelCostRow,
  type OvershootProjection,
} from '@/lib/modelCompare';
import { MODEL_QUALITY_NOTE } from '@/data/models';
import { formatRatio, formatSignedPct, formatUSD } from '@/lib/format';

export function MultiModelTab({
  workload,
  models,
}: {
  workload: Workload;
  models: ModelEntry[];
}) {
  const simulation = useStore(s => s.simulation);
  const busy = useStore(s => s.simulationBusy);
  const run = useStore(s => s.simulationCommand);
  const [choice, setChoice] = useState('');
  const volume = useMemo(() => {
    const calls = workload.outputs.daily_inferences;
    return {
      calls,
      avgInputTokens: Math.round(workload.costs.tokens_in_today / Math.max(calls, 1)),
      avgOutputTokens: Math.round(workload.costs.tokens_out_today / Math.max(calls, 1)),
    };
  }, [workload]);

  const rows = useMemo(
    () => compareModels(models, workload.model, volume),
    [models, workload.model, volume],
  );
  const alt = useMemo(() => cheapestAlternative(rows), [rows]);
  const current = rows.find((r) => r.isCurrent);

  // Multi-Model guardrail (obvious.md): candidates whose projected daily spend
  // at this volume breaks the workload's daily budget. Rendered as a warning —
  // never a block; the budget's throttle/pause thresholds enforce.
  const dailyBudget = workload.costs.daily_budget;
  const overshoots = useMemo(() => {
    const found: Array<{ row: ModelCostRow; overshoot: OvershootProjection }> = [];
    for (const row of rows) {
      const overshoot = projectedOvershoot(row.model, volume, dailyBudget);
      if (overshoot) found.push({ row, overshoot });
    }
    return found;
  }, [rows, volume, dailyBudget]);
  // Pre-apply warning for the model picked in the simulation select.
  const selectedBreak = overshoots.find(
    (x) => x.row.model.model_name === choice,
  ) ?? null;

  return (
    <div className="space-y-4">
      <div className="text-xs text-sub">
        Based on today's volume:{' '}
        <span className="font-mono text-txt">{volume.calls.toLocaleString()} calls</span> · avg input{' '}
        <span className="font-mono text-txt">{volume.avgInputTokens.toLocaleString()}</span> · avg output{' '}
        <span className="font-mono text-txt">{volume.avgOutputTokens.toLocaleString()}</span> tokens
      </div>

      <div className="overflow-hidden rounded-card border border-edge">
        <div className="grid grid-cols-[1.6fr_0.8fr_0.8fr_0.9fr_0.8fr] bg-raised px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-dim">
          <span>Model</span>
          <span className="text-right">Input</span>
          <span className="text-right">Output</span>
          <span className="text-right">Daily</span>
          <span className="text-right">Save</span>
        </div>
        {rows.map((row) => (
          <ModelRow key={row.model.id} row={row} />
        ))}
      </div>

      {overshoots.length > 0 && (
        <div
          role="alert"
          className="rounded-card border border-cost/40 bg-cost/5 p-3 text-xs leading-relaxed text-sub"
        >
          <span className="font-bold text-cost">⚠ Projected overspend</span>
          <span className="text-dim">
            {' '}at today's volume — daily budget {formatUSD(dailyBudget)}:{' '}
          </span>
          {overshoots.map(({ row, overshoot }, i) => (
            <span key={row.model.id}>
              {i > 0 && ' · '}
              <span className="font-mono text-txt">{row.model.display_name}</span>{' '}
              <span className="font-mono text-txt">
                {formatUSD(overshoot.projectedDaily)}/day,{' '}
              </span>
              <span className="font-mono text-cost">{overLabel(overshoot)}</span>
            </span>
          ))}
        </div>
      )}

      {simulation && <section className="rounded-card border border-edge p-3 text-xs text-sub">
        <p>Simulate a prospective model switch after cost approval. Recorded charges stay unchanged; evaluate quality before using a new model.</p>
        <label className="mt-3 block">Target model <select className="sim-input mt-2 max-w-full" value={choice} onChange={e => setChoice(e.target.value)}><option value="">Choose a model</option>{models.map(m => <option key={m.id} value={m.model_name}>{m.display_name}</option>)}</select></label>
        {selectedBreak && (
          <p
            role="alert"
            className="mt-3 rounded-card border border-cost/40 bg-cost/5 p-3 leading-relaxed"
          >
            <span className="font-bold text-cost">⚠ Projected overspend:</span>{' '}
            <span className="font-mono text-txt">{selectedBreak.row.model.display_name}</span> at this volume costs{' '}
            <span className="font-mono text-cost">{formatUSD(selectedBreak.overshoot.projectedDaily)}/day</span> —{' '}
            <span className="font-mono text-cost">{overLabel(selectedBreak.overshoot)}</span> the{' '}
            <span className="font-mono text-txt">{formatUSD(dailyBudget)}</span> daily budget.{' '}
            Applying is not blocked — the daily budget's throttle and pause thresholds remain the enforcement layer.
          </p>
        )}
        <button className="sim-button mt-3" disabled={busy || !choice || !workload.governance.cost_approval || simulation.session.identity.persona !== 'technical'} onClick={() => void run({ type: 'model', workloadId: workload.id, model: choice })}>Simulate model switch</button>
      </section>}
      {alt && current && (
        <div className="rounded-card border border-shape/40 bg-shape/5 p-3 text-xs text-sub">
          <span className="text-shape">⚠</span> Switching to{' '}
          <span className="font-mono text-txt">{alt.model.display_name}</span> saves{' '}
          <span className="font-mono text-value">
            {formatUSD(current.dailyCost - alt.dailyCost)}/day
          </span>{' '}
          ({formatUSD((current.dailyCost - alt.dailyCost) * 30)}/mo). At the same value, that lifts
          the {formatRatio(workload.value.value_ratio)} ratio higher.{' '}
          {MODEL_QUALITY_NOTE[alt.model.model_name] ?? 'Quality may change.'} Run an A/B test on
          resolution rate before switching.
        </div>
      )}
    </div>
  );
}

// "$677 (+423%) over" — the percent is omitted when the budget is zero and a
// percentage is undefined (overPct null).
function overLabel(o: OvershootProjection): string {
  const pct = o.overPct === null ? '' : ` (${formatSignedPct(o.overPct)})`;
  return `${formatUSD(o.overAmount)}${pct} over`;
}

function ModelRow({ row }: { row: ModelCostRow }) {
  const cheaper = row.savingsPct < 0;
  const savingsColor = row.isCurrent
    ? 'var(--sub)'
    : cheaper
      ? 'var(--value)'
      : 'var(--cost)';
  return (
    <div
      className={`grid grid-cols-[1.6fr_0.8fr_0.8fr_0.9fr_0.8fr] items-center border-b border-edge px-3 py-2 font-mono text-xs last:border-b-0 ${
        row.isCurrent ? 'bg-unit/10' : ''
      }`}
    >
      <span className="flex items-center gap-2 truncate text-txt">
        {row.model.display_name}
        {row.isCurrent && (
          <span className="rounded bg-unit/20 px-1 text-[9px] uppercase text-unit">current</span>
        )}
      </span>
      <span className="text-right text-sub">{formatUSD(row.inputCost)}</span>
      <span className="text-right text-sub">{formatUSD(row.outputCost)}</span>
      <span className="text-right text-txt">{formatUSD(row.dailyCost)}</span>
      <span className="text-right font-bold" style={{ color: savingsColor }}>
        {row.isCurrent ? 'base' : formatSignedPct(row.savingsPct)}
      </span>
    </div>
  );
}

