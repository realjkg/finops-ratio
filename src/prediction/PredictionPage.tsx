// Standalone /prediction route — demonstrates the prediction-error ledger seam
// (PR G) with a mock/live toggle. Propose a change to a workload, and the page
// shows the selected source, the predicted cost impact ALWAYS beside its
// value-ratio effect (R4), the confidence band, and whether the prediction
// cleared the >=99% gate or is an honest estimate. The accuracy panel reflects
// the ledger state — cold-start by design, since no synthetic back-test is
// seeded (approved scope). Isolated from the main app; no store.
import { useState, useCallback, useEffect, useMemo } from 'react';
import { createPredictionClient } from './index';
import type {
  ChangePrediction,
  AccuracyReport,
  ProposedChange,
  ChangeType,
} from './index';
import { WORKLOADS } from '@/data/workloads';
import { formatUSD, formatSignedPct } from '@/lib/format';
import { DELTA_RATIO_CAP_CAVEAT, formatDeltaValueRatio } from './predictors';

// A cheaper target model for the model-switch preset (falls back if equal).
const SWITCH_TARGET = 'gemini-2.5-flash';
const SWITCH_FALLBACK = 'gpt-4o-mini';

function presetFor(changeType: ChangeType, workloadId: string): ProposedChange {
  const workload = WORKLOADS.find((w) => w.id === workloadId) ?? WORKLOADS[0];
  switch (changeType) {
    case 'model_switch':
      return {
        type: 'model_switch',
        workloadId,
        fromModel: workload.model,
        toModel: workload.model === SWITCH_TARGET ? SWITCH_FALLBACK : SWITCH_TARGET,
      };
    case 'demand_shape':
      return {
        type: 'demand_shape',
        workloadId,
        fromShape: workload.demand_shape,
        toShape: 'throttled',
      };
    case 'scale':
      return { type: 'scale', workloadId, volumeMultiplier: 1.5 };
    case 'budget':
      return {
        type: 'budget',
        workloadId,
        newMonthlyBudget: Math.round(workload.costs.monthly_budget * 1.2),
      };
  }
}

const CHANGE_LABEL: Record<ChangeType, string> = {
  model_switch: 'Switch model',
  demand_shape: 'Reshape demand → throttled',
  scale: 'Scale volume ×1.5',
  budget: 'Raise monthly budget +20%',
};

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; prediction: ChangePrediction };

/** Format a possibly-Infinite USD delta (cold-start bands read as uncertain). */
function usdOrUncertain(value: number): string {
  if (!Number.isFinite(value)) return 'uncertain';
  return formatUSD(value);
}

function Pill({ tone, children }: { tone: 'value' | 'cost' | 'shape'; children: React.ReactNode }) {
  const color = tone === 'value' ? 'var(--value)' : tone === 'cost' ? 'var(--cost)' : 'var(--shape)';
  return (
    <span
      className="rounded-md px-2 py-0.5 font-mono text-[11px]"
      style={{ border: `1px solid ${color}`, color }}
    >
      {children}
    </span>
  );
}

export function PredictionPage() {
  const [clientMode, setClientMode] = useState<'mock' | 'live'>('mock');
  const [workloadId, setWorkloadId] = useState<string>(WORKLOADS[0].id);
  const [changeType, setChangeType] = useState<ChangeType>('model_switch');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });
  const [report, setReport] = useState<AccuracyReport | null>(null);

  const client = useMemo(() => createPredictionClient(clientMode), [clientMode]);

  // Refresh the accuracy report whenever the client mode changes.
  useEffect(() => {
    let cancelled = false;
    client
      .getAccuracyReport()
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch(() => {
        if (!cancelled) setReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const predict = useCallback(async () => {
    setLoadState({ status: 'loading' });
    try {
      const prediction = await client.predictChange(presetFor(changeType, workloadId));
      setLoadState({ status: 'success', prediction });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [client, changeType, workloadId]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 font-mono text-sm text-txt">
      <header className="mb-8">
        <h1 className="text-lg text-txt">Ratio — Change-Impact Prediction</h1>
        <p className="mt-1 max-w-prose font-sans text-sub">
          Predict a proposed change&apos;s cost impact, pick the lowest-error source for
          its change type, and show the result with its value-ratio effect (R4). The
          ledger is cold-start by design — no synthetic back-test is seeded — so every
          prediction here is an honest estimate until realized changes accumulate.
        </p>
      </header>

      {/* Controls */}
      <section className="mb-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-dim">Mode</span>
          <select
            className="rounded-md border border-edge bg-slab px-2 py-1"
            value={clientMode}
            onChange={(e) => setClientMode(e.target.value as 'mock' | 'live')}
          >
            <option value="mock">mock (offline)</option>
            <option value="live">live (/api)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-dim">Mission</span>
          <select
            className="rounded-md border border-edge bg-slab px-2 py-1"
            value={workloadId}
            onChange={(e) => setWorkloadId(e.target.value)}
          >
            {WORKLOADS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-dim">Proposed change</span>
          <select
            className="rounded-md border border-edge bg-slab px-2 py-1"
            value={changeType}
            onChange={(e) => setChangeType(e.target.value as ChangeType)}
          >
            {(Object.keys(CHANGE_LABEL) as ChangeType[]).map((ct) => (
              <option key={ct} value={ct}>
                {CHANGE_LABEL[ct]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={predict}
          className="rounded-md border border-gate bg-raised px-3 py-1.5 text-gate"
          disabled={loadState.status === 'loading'}
        >
          {loadState.status === 'loading' ? 'Predicting…' : 'Predict impact'}
        </button>
      </section>

      {/* Prediction result */}
      {loadState.status === 'error' && (
        <p className="mb-6 rounded-md border border-cost bg-slab px-3 py-2 text-cost">
          {loadState.message}
        </p>
      )}
      {loadState.status === 'success' && (
        <PredictionCard prediction={loadState.prediction} />
      )}

      {/* Accuracy ledger summary */}
      {report && <AccuracyPanel report={report} />}
    </main>
  );
}

function PredictionCard({ prediction }: { prediction: ChangePrediction }) {
  const { impact, confidence, source, mode, estimated, rationale, clearsConfidenceGate } =
    prediction;
  const deltaRatio = formatDeltaValueRatio(impact.deltaValueRatio);
  return (
    <section className="mb-8 rounded-lg border border-edge bg-slab p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-txt">Predicted impact</h2>
        <div className="flex items-center gap-2">
          <Pill tone="shape">{source}</Pill>
          {estimated ? (
            <Pill tone="cost">ESTIMATED — needs confirmation</Pill>
          ) : (
            <Pill tone="value">CONFIDENT — clears 99% gate</Pill>
          )}
        </div>
      </div>

      {/* R4: cost ALWAYS shown beside its value-ratio effect. */}
      <div className="grid grid-cols-3 gap-3">
        <Metric label="Δ daily spend" value={usdOrUncertain(impact.deltaDailySpend)} tone="cost" />
        <Metric label="Δ monthly spend" value={usdOrUncertain(impact.deltaMonthlySpend)} tone="cost" />
        <Metric label="Δ value ratio" value={deltaRatio.text} tone="value" />
      </div>
      {deltaRatio.capped && (
        <p className="mt-2 font-sans text-[12px] text-cost">
          {DELTA_RATIO_CAP_CAVEAT}
        </p>
      )}

      <dl className="mt-4 space-y-1 text-[12px] text-sub">
        <Row label="Confidence band (monthly Δ)">
          {Number.isFinite(confidence.low) && Number.isFinite(confidence.high)
            ? `${usdOrUncertain(confidence.low)} — ${usdOrUncertain(confidence.high)} (80%, z=${confidence.z})`
            : 'fully uncertain (cold-start, no error history)'}
        </Row>
        <Row label="Expected relative error">
          {Number.isFinite(confidence.expectedRelativeError)
            ? formatSignedPct(confidence.expectedRelativeError * 100, 2)
            : 'unknown'}
        </Row>
        <Row label="99% gate">{clearsConfidenceGate ? 'cleared' : 'not cleared'}</Row>
        <Row label="Mode">{mode}</Row>
      </dl>

      <p className="mt-3 font-sans text-[12px] text-dim">{rationale}</p>
    </section>
  );
}

function AccuracyPanel({ report }: { report: AccuracyReport }) {
  const changeTypes = Object.keys(report.byChangeType) as ChangeType[];
  return (
    <section className="rounded-lg border border-edge bg-deep p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-txt">Accuracy ledger</h2>
        {report.coldStart ? (
          <Pill tone="shape">COLD-START — {report.totalEntries} realized changes</Pill>
        ) : (
          <Pill tone="value">{report.totalEntries} realized changes</Pill>
        )}
      </div>
      <p className="mb-3 font-sans text-[12px] text-dim">
        Accuracy = 1 − |predicted − actual| / |actual|, reported as median (p50) with
        p90 alongside; no-ops are excluded from the ratio. Target: p50 ≥ 99%.
      </p>
      <table className="w-full text-left text-[12px]">
        <thead className="text-dim">
          <tr>
            <th className="py-1">Change type</th>
            <th className="py-1">Scored</th>
            <th className="py-1">p50</th>
            <th className="py-1">p90</th>
            <th className="py-1">No-ops</th>
          </tr>
        </thead>
        <tbody>
          {changeTypes.map((ct) => {
            const s = report.byChangeType[ct];
            const p50 = s.medianAccuracy;
            const p50Color =
              p50 === null ? 'var(--dim)' : s.meetsTarget ? 'var(--value)' : 'var(--shape)';
            return (
              <tr key={ct} className="border-t border-edge">
                <td className="py-1">{ct}</td>
                <td className="py-1">{s.scoredCount}</td>
                <td className="py-1" style={{ color: p50Color }}>
                  {p50 !== null ? formatSignedPct(p50 * 100, 2) : '—'}
                </td>
                <td className="py-1">
                  {s.p90Accuracy !== null ? formatSignedPct(s.p90Accuracy * 100, 2) : '—'}
                </td>
                <td className="py-1">
                  {s.noOpCorrect}/{s.noOpCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'value' | 'cost';
}) {
  const color = tone === 'value' ? 'var(--value)' : 'var(--cost)';
  return (
    <div className="rounded-md border border-edge bg-raised p-3">
      <div className="text-[11px] text-dim">{label}</div>
      <div className="mt-1 text-base" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-dim">{label}</dt>
      <dd className="text-sub">{children}</dd>
    </div>
  );
}

