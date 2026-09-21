// Adjustment cards (Ratio v2 PR H, WS3 capstone) — the surface where all three
// workstreams converge. Inside Mission Detail, each of the four change types
// (model switch, demand shape, scale, budget) renders a proposed-change card.
// The user proposes -> the card calls /api/prediction/predict (PR G seam, mock
// offline) -> the prediction is scored against the >=99% confidence gate -> the
// card shows the predicted Δcost ALWAYS beside its Δvalue-ratio (R4), the selected
// source, the 80% band (z=1.28), and the gate routing: "Confident — ready to apply"
// or queued at the Cost (Gate 3) / Scale (Gate 4) governance gate. Nothing is
// ever auto-applied. Motion follows the PR C patterns and honors reduced motion.
import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Workload } from '@/types';
import type { ChangePrediction, ChangeType, ProposedChange } from '@/prediction';
import { formatRatio, formatUSD } from '@/lib/format';
import { TOKEN_HEX } from '@/lib/scales';
import { SHAPE_LABEL } from '@/lib/demandShape';
import { withBasePath } from '@/lib/basePath';
import {
  routeAdjustment,
  adjustmentDisplayState,
  pairedImpact,
  DISPLAY_STATE_LABEL,
  type AdjustmentDisplayState,
} from './adjustmentGate';

// A cheaper target model for the model-switch preset (falls back if equal).
const SWITCH_TARGET = 'gemini-2.5-flash';
const SWITCH_FALLBACK = 'gpt-4o-mini';

const CHANGE_LABEL: Record<ChangeType, string> = {
  model_switch: 'Model switch',
  demand_shape: 'Demand shape',
  scale: 'Scale volume',
  budget: 'Budget',
};

const CHANGE_ORDER: ChangeType[] = ['model_switch', 'demand_shape', 'scale', 'budget'];

/** Build a concrete proposed change for a change type against this workload. */
function presetFor(changeType: ChangeType, workload: Workload): ProposedChange {
  switch (changeType) {
    case 'model_switch':
      return {
        type: 'model_switch',
        workloadId: workload.id,
        fromModel: workload.model,
        toModel: workload.model === SWITCH_TARGET ? SWITCH_FALLBACK : SWITCH_TARGET,
      };
    case 'demand_shape':
      return {
        type: 'demand_shape',
        workloadId: workload.id,
        fromShape: workload.demand_shape,
        toShape: workload.demand_shape === 'throttled' ? 'batch_offpeak' : 'throttled',
      };
    case 'scale':
      return { type: 'scale', workloadId: workload.id, volumeMultiplier: 1.5 };
    case 'budget':
      return {
        type: 'budget',
        workloadId: workload.id,
        newMonthlyBudget: Math.round(workload.costs.monthly_budget * 1.2),
      };
  }
}

/** A one-line, plain-language description of the proposed change. */
function describeChange(change: ProposedChange): string {
  switch (change.type) {
    case 'model_switch':
      return `Switch ${change.fromModel} → ${change.toModel} at current volume`;
    case 'demand_shape':
      return `Reshape demand ${SHAPE_LABEL[change.fromShape]} → ${SHAPE_LABEL[change.toShape]}`;
    case 'scale':
      return `Scale volume ×${change.volumeMultiplier}`;
    case 'budget':
      return `Raise monthly budget → ${formatUSD(change.newMonthlyBudget)}`;
  }
}

/** PredictionClient wiring — calls the PR G API route (mock, offline-capable). */
async function fetchPrediction(change: ProposedChange): Promise<ChangePrediction> {
  const res = await fetch(withBasePath('/api/prediction/predict'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Prediction failed (HTTP ${res.status})`);
  }
  return (await res.json()) as ChangePrediction;
}

/** Format a possibly-infinite USD delta (cold-start bands read as uncertain). */
function usdOrUncertain(value: number): string {
  return Number.isFinite(value) ? formatUSD(value) : 'uncertain';
}

type TileState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; prediction: ChangePrediction };

export function AdjustmentCards({ workload }: { workload: Workload }) {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h3 className="font-body text-sm font-semibold text-txt">Proposed Changes</h3>
        <p className="max-w-prose font-body text-xs text-sub">
          Propose a change and Ratio predicts its cost impact — always beside the
          value-ratio effect (R4) — then routes it by confidence: cleared for a
          one-tap apply, or queued at a governance gate for confirmation. Ratio
          never applies a change automatically.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {CHANGE_ORDER.map((changeType) => (
          <AdjustmentTile key={changeType} changeType={changeType} workload={workload} />
        ))}
      </div>
    </div>
  );
}

function AdjustmentTile({
  changeType,
  workload,
}: {
  changeType: ChangeType;
  workload: Workload;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const [state, setState] = useState<TileState>({ status: 'idle' });
  const change = useMemo(() => presetFor(changeType, workload), [changeType, workload]);

  const predict = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const prediction = await fetchPrediction(change);
      setState({ status: 'success', prediction });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [change]);

  return (
    <section className="rounded-card border border-edge bg-slab p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
            {CHANGE_LABEL[changeType]}
          </div>
          <p className="mt-1 font-body text-sm text-txt">{describeChange(change)}</p>
        </div>
        <button
          type="button"
          onClick={predict}
          disabled={state.status === 'loading'}
          className="shrink-0 rounded-md border border-gate bg-raised px-3 py-1.5 font-mono text-[11px] text-gate transition-colors hover:bg-gate/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-gate disabled:opacity-60"
        >
          {state.status === 'loading' ? 'Predicting…' : 'Predict impact'}
        </button>
      </div>

      <AnimatePresence mode="wait">
        {state.status === 'error' && (
          <motion.p
            key="error"
            initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reducedMotion ? 0 : -6 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
            className="mt-3 rounded-md border border-cost bg-deep px-3 py-2 font-mono text-[11px] text-cost"
          >
            {state.message}
          </motion.p>
        )}
        {state.status === 'success' && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: reducedMotion ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reducedMotion ? 0 : -8 }}
            transition={{ duration: reducedMotion ? 0 : 0.2, ease: 'easeOut' }}
          >
            <PredictionResult prediction={state.prediction} />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

const STATE_TONE: Record<AdjustmentDisplayState, string> = {
  confident: TOKEN_HEX.value,
  estimated_cold_start: TOKEN_HEX.shape,
  estimated_low_confidence: TOKEN_HEX.shape,
};

function PredictionResult({ prediction }: { prediction: ChangePrediction }) {
  const displayState = adjustmentDisplayState(prediction);
  const route = routeAdjustment(prediction);
  const tone = STATE_TONE[displayState];

  // R4 guard: refuse to render cost without its paired value-ratio delta.
  let paired;
  try {
    paired = pairedImpact(prediction.impact);
  } catch {
    return (
      <p className="mt-3 font-mono text-[11px] text-cost">
        Impact withheld — value-ratio context unavailable (R4).
      </p>
    );
  }

  const { confidence } = prediction;
  const bandFinite = Number.isFinite(confidence.low) && Number.isFinite(confidence.high);

  return (
    <div className="mt-3 space-y-3">
      {/* Status + source */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider"
          style={{ color: tone, backgroundColor: `${tone}1a` }}
        >
          {DISPLAY_STATE_LABEL[displayState]}
        </span>
        <span
          className="rounded-md border px-2 py-0.5 font-mono text-[10px]"
          style={{ borderColor: TOKEN_HEX.purple, color: TOKEN_HEX.purple }}
        >
          source: {prediction.source}
        </span>
      </div>

      {/* R4: Δcost ALWAYS rendered beside its Δvalue-ratio effect. */}
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Δ daily" value={usdOrUncertain(paired.deltaDailySpend)} tone={TOKEN_HEX.cost} />
        <Metric label="Δ monthly" value={usdOrUncertain(paired.deltaMonthlySpend)} tone={TOKEN_HEX.cost} />
        <Metric
          label="Δ value ratio"
          value={`${paired.deltaValueRatio >= 0 ? '+' : ''}${formatRatio(paired.deltaValueRatio)}`}
          tone={TOKEN_HEX.value}
        />
      </div>

      {/* Confidence band (80%, z=1.28). */}
      <p className="font-mono text-[11px] text-sub">
        80% band (z={confidence.z}):{' '}
        {bandFinite
          ? `${usdOrUncertain(confidence.low)} — ${usdOrUncertain(confidence.high)}`
          : 'fully uncertain — cold-start, no error history'}
      </p>

      {/* Confidence-gate routing — the visual queue position. */}
      {route.kind === 'ready' ? (
        <div
          className="rounded-md border px-3 py-2 font-mono text-[11px]"
          style={{ borderColor: TOKEN_HEX.value, color: TOKEN_HEX.value }}
        >
          ✔ Confident — ready to apply. Review and apply manually; Ratio never
          auto-applies a change.
        </div>
      ) : (
        <div
          className="rounded-md border px-3 py-2 font-mono text-[11px]"
          style={{ borderColor: TOKEN_HEX.gate, color: TOKEN_HEX.gate }}
        >
          ⚠ Routed → {route.gateLabel}. {route.reason}
        </div>
      )}

      <p className="font-body text-[11px] text-dim">{prediction.rationale}</p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-md border border-edge bg-raised p-2">
      <div className="font-mono text-[10px] text-dim">{label}</div>
      <div className="mt-0.5 font-mono text-sm" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}

