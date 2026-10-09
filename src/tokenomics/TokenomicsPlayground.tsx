// TokenomicsPlayground — self-serve scenario playground on seeded data.
// Visitors move model-mix / volume / growth sliders and the scenario
// recomputes instantly (debounced, client-side, no run button): cost, value,
// the value ratio (the Wave 4 signature ValueRatioMeter), and the three
// integrity layers with their token-flow trace visual.
//
// Seeded/mock only — no client-mode toggle; every figure traces to seed ×
// visitor inputs (the derivations panel shows the seed workings). The API
// seam (/api/tokenomics) is untouched and separate from this surface.
import { useEffect, useMemo, useState } from 'react';
import { ValueRatioMeter } from '@/findings/ValueRatioMeter';
import { formatUSD } from '@/lib/format';
import { HealthBadge, MetricCard1, MetricCard2, MetricCard3, SectionLabel } from './TokenomicsMetricCards';
import { TokenFlowTrace } from './TokenFlowTrace';
import {
  DEFAULT_SCENARIO,
  MIX_MODELS,
  deriveScenario,
  buildScenarioReport,
  costPerInference,
  valuePerInference,
} from './scenario';
import type { ScenarioInputs } from './scenario';
import { SCENARIO_SEED } from './seeds';

// Derived counts are exact products in the bridge (see scenario.ts) and may be
// fractional; renderers round — the derivation panel shows the same integer
// figure the flow trace shows.
function formatCount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Debounce window between slider movement and recompute.
const DEBOUNCE_MS = 150;
// Slider ranges (UI affordances, not math constants).
const VOLUME_MIN = 0;
const VOLUME_MAX = 500_000;
const VOLUME_STEP = 1_000;
const GROWTH_MIN = 0;
const GROWTH_MAX = 25;
const GROWTH_STEP = 1;
const WEIGHT_MAX = 100;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

interface SliderRowProps {
  label: string;
  display: string;
  min: number;
  max: number;
  step: number;
  value: number;
  hint?: string;
  onChange: (v: number) => void;
}

function SliderRow({ label, display, min, max, step, value, hint, onChange }: SliderRowProps) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-sub">{label}</span>
        <span className="font-mono text-xs text-txt">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-unit"
      />
      {hint && <span className="mt-0.5 block text-[10px] leading-relaxed text-dim">{hint}</span>}
    </label>
  );
}

function DerivationRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sub">{label}</dt>
      <dd className="text-right font-mono text-txt">{value}</dd>
    </div>
  );
}

export function TokenomicsPlayground({
  initialScenario = DEFAULT_SCENARIO,
}: {
  initialScenario?: ScenarioInputs;
}) {
  const [draft, setDraft] = useState<ScenarioInputs>(initialScenario);
  const inputs = useDebounced(draft, DEBOUNCE_MS);

  const bridge = useMemo(() => deriveScenario(inputs), [inputs]);
  const report = useMemo(() => buildScenarioReport(bridge), [bridge]);

  const totalWeight = draft.mixWeights.reduce((s, w) => s + Math.max(w.weightPct, 0), 0);

  const setWeight = (modelId: string, weightPct: number) =>
    setDraft((d) => ({
      ...d,
      mixWeights: d.mixWeights.map((w) => (w.modelId === modelId ? { ...w, weightPct } : w)),
    }));

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-txt">
          Tokenomics Playground
        </h1>
        <p className="mt-1 text-sm text-sub">
          Shape a scenario — model mix, daily volume, growth — and watch cost, value, and the
          three integrity layers recompute. Every figure traces to seed data × your inputs.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">

        {/* Controls */}
        <div className="space-y-6 rounded-card border border-edge bg-slab p-6 lg:sticky lg:top-4">
          <div>
            <SectionLabel>Scenario</SectionLabel>
            <div className="space-y-4">
              <SliderRow
                label="Daily inferences"
                display={draft.dailyInferences.toLocaleString('en-US')}
                min={VOLUME_MIN}
                max={VOLUME_MAX}
                step={VOLUME_STEP}
                value={draft.dailyInferences}
                hint={`run-rate shown for a ${SCENARIO_SEED.daysPerMonth}-day month, compounded ${SCENARIO_SEED.horizonMonths} months`}
                onChange={(dailyInferences) => setDraft((d) => ({ ...d, dailyInferences }))}
              />
              <SliderRow
                label="Growth per month"
                display={`${draft.growthPctPerMonth}%/mo`}
                min={GROWTH_MIN}
                max={GROWTH_MAX}
                step={GROWTH_STEP}
                value={draft.growthPctPerMonth}
                onChange={(growthPctPerMonth) => setDraft((d) => ({ ...d, growthPctPerMonth }))}
              />
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <SectionLabel>Model mix</SectionLabel>
              <span className="mb-3 font-mono text-[10px] text-dim">
                weights normalize to {totalWeight > 0 ? '100%' : '0%'}
              </span>
            </div>
            <div className="space-y-4">
              {MIX_MODELS.map((m) => {
                const weight = draft.mixWeights.find((w) => w.modelId === m.modelId);
                const share = bridge.perModel.find((p) => p.modelId === m.modelId)?.sharePct ?? 0;
                return (
                  <SliderRow
                    key={m.modelId}
                    label={m.displayName}
                    display={totalWeight > 0 ? `${share.toFixed(1)}%` : '—'}
                    min={0}
                    max={WEIGHT_MAX}
                    step={1}
                    value={weight?.weightPct ?? 0}
                    hint={`seed ratio ${m.valueRatioSeed.toFixed(1)}× · $${m.inputPer1m}/$${m.outputPer1m} per 1M in/out`}
                    onChange={(v) => setWeight(m.modelId, v)}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Outputs */}
        <div className="space-y-4">

          {totalWeight === 0 && (
            <div className="rounded-card border border-edge bg-slab px-4 py-3">
              <p className="text-xs text-sub">
                No model share — raise a mix slider to compute a scenario.
              </p>
            </div>
          )}

          {/* Value-ratio hero — cost paired with value (R4). */}
          <div className="rounded-card border border-edge bg-slab p-6">
            <div className="flex items-center justify-between gap-4">
              <SectionLabel>Value returned per inference dollar</SectionLabel>
              <HealthBadge pass={bridge.valueRatio >= 1} />
            </div>
            <ValueRatioMeter ratio={bridge.valueRatio} size="large" />
            <p className="mt-2 text-[10px] text-dim">
              driven by the model mix — volume and growth scale both sides equally
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-md bg-raised/60 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-dim">Monthly cost</p>
                <p className="mt-0.5 font-mono text-xl font-bold text-cost">
                  {formatUSD(bridge.monthlyCost, { compact: true })}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-dim">
                  Σ per-model inferences × tokens × registry $/1M
                </p>
              </div>
              <div className="rounded-md bg-raised/60 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-dim">Monthly value returned</p>
                <p className="mt-0.5 font-mono text-xl font-bold text-value">
                  {formatUSD(bridge.monthlyValue, { compact: true })}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-dim">
                  Σ per-model inferences × seeded value/inference (seeded ratio × seeded cost/inference)
                </p>
              </div>
            </div>
          </div>

          {/* Token-flow traceability — the evidence visual. */}
          <div className="space-y-3">
            <SectionLabel>Token-flow traceability — where the data plane loses count</SectionLabel>
            <TokenFlowTrace bridge={bridge} />
          </div>

          {/* Overall health banner */}
          <div
            className={[
              'flex items-center justify-between rounded-card border p-4',
              report.overallHealthy ? 'border-value/30 bg-value/5' : 'border-shape/30 bg-shape/5',
            ].join(' ')}
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-sub">
                Overall Health
              </p>
              <p
                className={`mt-0.5 text-sm font-semibold ${
                  report.overallHealthy ? 'text-value' : 'text-shape'
                }`}
              >
                {report.overallHealthy ? 'All metrics passing' : 'One or more metrics failing'}
              </p>
            </div>
            <HealthBadge pass={report.overallHealthy} />
          </div>

          {/* Three integrity metric cards */}
          <MetricCard1 report={report} />
          <MetricCard2 report={report} />
          <MetricCard3 report={report} />

          {/* Derivations — the seed workings behind every figure above. */}
          <div className="rounded-card border border-edge bg-slab p-5">
            <SectionLabel>Derivations — seed × scenario</SectionLabel>
            <dl className="space-y-1.5 text-xs">
              <DerivationRow
                label="Monthly volume"
                value={`${inputs.dailyInferences.toLocaleString('en-US')}/day × ${SCENARIO_SEED.daysPerMonth} days × (1+${inputs.growthPctPerMonth}%)^${SCENARIO_SEED.horizonMonths} = ${formatCount(bridge.monthlyInferences)}`}
              />
              <DerivationRow
                label="Hardware events"
                value={`${formatCount(bridge.monthlyInferences)} inferences × ${SCENARIO_SEED.eventsPerInference} event/inference`}
              />
              <DerivationRow
                label="Capture rate (seed)"
                value={`${(bridge.derivations.captureRate * 100).toFixed(2)}%`}
              />
              <DerivationRow
                label="Dedup share (seed)"
                value={`${(bridge.derivations.dedupShare * 100).toFixed(1)}%`}
              />
              <DerivationRow
                label="Heartbeat allowance (seed, unit pending)"
                value={`${(bridge.derivations.heartbeatAllowance * 100).toFixed(1)}% of raw`}
              />
              <DerivationRow
                label="Pipeline pass threshold (seed)"
                value={String(bridge.derivations.pipelineThreshold)}
              />
              <DerivationRow
                label="Ledger reconciliation (seed)"
                value="exact — delta must be 0"
              />
              <DerivationRow
                label="Per-model value basis"
                value={`seeded ratio × seeded cost/inference — e.g. ${MIX_MODELS[0]?.displayName}: ${formatUSD(costPerInference(MIX_MODELS[0]))} → ${formatUSD(valuePerInference(MIX_MODELS[0]))}/inference`}
              />
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
