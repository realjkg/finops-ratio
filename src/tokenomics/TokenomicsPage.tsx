// Standalone /tokenomics route — demonstrates the three tokenomics integrity
// metrics with a mock/live toggle. Isolated from the main Ratio app; does not
// touch the store. Presentation matches the FinioPage pattern.
import Link from 'next/link';
import { useState, useCallback } from 'react';
import { createTokenomicsClient } from './index';
import type { TokenomicsReport } from './index';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: TokenomicsReport }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">
      {children}
    </p>
  );
}

function HealthBadge({ pass }: { pass: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        pass
          ? 'bg-value/10 text-value'
          : 'bg-shape/10 text-shape',
      ].join(' ')}
    >
      <span
        className={[
          'h-1.5 w-1.5 rounded-full',
          pass ? 'bg-value' : 'bg-shape',
        ].join(' ')}
      />
      {pass ? 'PASS' : 'WARN'}
    </span>
  );
}

interface InputRowProps {
  label: string;
  value: string | number;
}
function InputRow({ label, value }: InputRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sub">{label}</dt>
      <dd className="font-mono text-txt">{typeof value === 'number' ? value.toLocaleString('en-US') : value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric cards
// ---------------------------------------------------------------------------

function MetricCard1({ report }: { report: TokenomicsReport }) {
  const m = report.metrics.counterAlignment;
  const pct = (m.value as number).toFixed(2);
  return (
    <div className="rounded-card border border-edge bg-slab p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-dim">Layer 1 — {m.layer}</p>
          <h3 className="mt-0.5 text-base font-semibold text-txt">{m.focus}</h3>
        </div>
        <HealthBadge pass={m.pass} />
      </div>

      {/* Formula */}
      <div className="rounded-md bg-raised/60 px-3 py-2">
        <p className="text-[10px] uppercase tracking-wider text-dim">Formula</p>
        <p className="mt-0.5 font-mono text-xs text-sub">{m.formulaLabel}</p>
      </div>

      {/* Inputs */}
      <div>
        <p className="mb-2 text-[10px] uppercase tracking-wider text-dim">Inputs</p>
        <dl className="space-y-1 text-xs">
          <InputRow label="Total ingested events" value={m.inputs.totalIngestedEvents} />
          <InputRow label="Hardware-reported events" value={m.inputs.totalHardwareReportedEvents} />
        </dl>
      </div>

      {/* Result */}
      <div className="flex items-center justify-between border-t border-edge pt-3">
        <span className="text-xs text-sub">Counter alignment</span>
        <span className={`font-mono text-lg font-bold ${m.pass ? 'text-value' : 'text-shape'}`}>
          {pct}%
        </span>
      </div>
    </div>
  );
}

function MetricCard2({ report }: { report: TokenomicsReport }) {
  const m = report.metrics.pipelineIntegrity;
  const score = (m.value as number).toFixed(4);
  return (
    <div className="rounded-card border border-edge bg-slab p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-dim">Layer 2 — {m.layer}</p>
          <h3 className="mt-0.5 text-base font-semibold text-txt">{m.focus}</h3>
        </div>
        <HealthBadge pass={m.pass} />
      </div>

      {/* Formula */}
      <div className="rounded-md bg-raised/60 px-3 py-2">
        <p className="text-[10px] uppercase tracking-wider text-dim">Formula</p>
        <p className="mt-0.5 font-mono text-xs text-sub">{m.formulaLabel}</p>
      </div>

      {/* Assumption note */}
      <div className="rounded-md border border-shape/30 bg-shape/5 px-3 py-2">
        <p className="text-[10px] uppercase tracking-wider text-shape">Assumption — needs confirmation</p>
        <p className="mt-1 text-xs text-sub">
          <span className="font-mono text-txt">expectedDroppedHeartbeats</span> is treated as a
          fractional allowance (0–1 share of raw tokens), not a raw count.
          Result is a 0–1 integrity score. Confirm the intended unit.
        </p>
      </div>

      {/* Inputs */}
      <div>
        <p className="mb-2 text-[10px] uppercase tracking-wider text-dim">Inputs</p>
        <dl className="space-y-1 text-xs">
          <InputRow label="Unique processed tokens" value={m.inputs.uniqueProcessedTokens} />
          <InputRow label="Raw ingested tokens" value={m.inputs.rawIngestedTokens} />
          <InputRow label="Expected dropped heartbeats (frac.)" value={m.inputs.expectedDroppedHeartbeats} />
          <InputRow label="Pass threshold" value={m.inputs.threshold} />
        </dl>
      </div>

      {/* Result */}
      <div className="flex items-center justify-between border-t border-edge pt-3">
        <span className="text-xs text-sub">Integrity score</span>
        <span className={`font-mono text-lg font-bold ${m.pass ? 'text-value' : 'text-shape'}`}>
          {score}
        </span>
      </div>
    </div>
  );
}

function MetricCard3({ report }: { report: TokenomicsReport }) {
  const m = report.metrics.ledgerSync;
  const { delta, inSync } = m.value as { delta: number; inSync: boolean };
  return (
    <div className="rounded-card border border-edge bg-slab p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-dim">Layer 3 — {m.layer}</p>
          <h3 className="mt-0.5 text-base font-semibold text-txt">{m.focus}</h3>
        </div>
        <HealthBadge pass={m.pass} />
      </div>

      {/* Formula */}
      <div className="rounded-md bg-raised/60 px-3 py-2">
        <p className="text-[10px] uppercase tracking-wider text-dim">Formula</p>
        <p className="mt-0.5 font-mono text-xs text-sub">{m.formulaLabel}</p>
      </div>

      {/* Inputs */}
      <div>
        <p className="mb-2 text-[10px] uppercase tracking-wider text-dim">Inputs</p>
        <dl className="space-y-1 text-xs">
          <InputRow label="UI displayed balance" value={`$${m.inputs.uiDisplayedBalance.toLocaleString('en-US')}`} />
          <InputRow label="Immutable DB balance" value={`$${m.inputs.immutableDatabaseBalance.toLocaleString('en-US')}`} />
        </dl>
      </div>

      {/* Result */}
      <div className="flex items-center justify-between border-t border-edge pt-3">
        <span className="text-xs text-sub">
          Delta{' '}
          <span className="text-dim">(must be exactly 0)</span>
        </span>
        <div className="flex items-center gap-3">
          <span
            className={`font-mono text-lg font-bold ${
              inSync ? 'text-value' : 'text-cost'
            }`}
          >
            {delta === 0 ? '0' : delta > 0 ? `+${delta}` : String(delta)}
          </span>
          {inSync && (
            <span className="font-mono text-xs text-value">in sync</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TokenomicsPage() {
  const [clientMode, setClientMode] = useState<'mock' | 'live'>('mock');
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  const runReport = useCallback(async () => {
    setLoadState({ status: 'loading' });
    try {
      const client = createTokenomicsClient(clientMode);
      const data = await client.getTokenomicsReport();
      setLoadState({ status: 'success', data });
    } catch (err) {
      setLoadState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [clientMode]);

  return (
    <div className="min-h-screen bg-void px-4 py-10 font-body text-txt">
      <div className="mx-auto max-w-4xl">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-txt">
            Tokenomics Measurement
          </h1>
          <p className="mt-1 text-sm text-sub">
            Three-layer data integrity model: Hardware Ingest → Data Pipeline → UI Presentation.
          </p>
        </div>

        {/* Controls */}
        <div className="mb-6 rounded-card border border-edge bg-slab p-6">
          <SectionLabel>Client mode</SectionLabel>

          <div className="mb-5 flex gap-2">
            {(['mock', 'live'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setClientMode(m);
                  setLoadState({ status: 'idle' });
                }}
                className={[
                  'rounded-card border px-4 py-1.5 text-sm font-medium transition-colors',
                  clientMode === m
                    ? m === 'mock'
                      ? 'border-shape bg-shape/10 text-shape'
                      : 'border-value bg-value/10 text-value'
                    : 'border-edge bg-raised text-sub hover:text-txt',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>

          <button
            onClick={runReport}
            disabled={loadState.status === 'loading'}
            className="w-full rounded-card bg-gate px-4 py-2 text-sm font-semibold text-void transition-opacity disabled:opacity-50"
          >
            {loadState.status === 'loading' ? 'Computing…' : 'Run Tokenomics Report'}
          </button>
        </div>

        {/* Idle */}
        {loadState.status === 'idle' && (
          <p className="text-center text-sm text-dim">
            Select a mode and run the report to see all three metrics.
          </p>
        )}

        {/* Loading */}
        {loadState.status === 'loading' && (
          <p className="text-center text-sm text-sub">Computing integrity metrics…</p>
        )}

        {/* Error */}
        {loadState.status === 'error' && (
          <div className="rounded-card border border-cost/40 bg-cost/10 p-4">
            <p className="text-sm font-medium text-cost">Report failed</p>
            <p className="mt-1 text-xs text-sub">{loadState.message}</p>
          </div>
        )}

        {/* Success */}
        {loadState.status === 'success' && (
          <div className="space-y-4">

            {/* Overall health banner */}
            <div
              className={[
                'rounded-card border p-4 flex items-center justify-between',
                loadState.data.overallHealthy
                  ? 'border-value/30 bg-value/5'
                  : 'border-shape/30 bg-shape/5',
              ].join(' ')}
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-sub">
                  Overall Health
                </p>
                <p
                  className={`mt-0.5 text-sm font-semibold ${
                    loadState.data.overallHealthy ? 'text-value' : 'text-shape'
                  }`}
                >
                  {loadState.data.overallHealthy
                    ? 'All metrics passing'
                    : 'One or more metrics failing'}
                </p>
              </div>
              <HealthBadge pass={loadState.data.overallHealthy} />
            </div>

            {/* Three metric cards */}
            <MetricCard1 report={loadState.data} />
            <MetricCard2 report={loadState.data} />
            <MetricCard3 report={loadState.data} />

            {/* Report meta */}
            <div className="rounded-card border border-edge bg-slab px-4 py-3">
              <dl className="flex flex-wrap gap-x-8 gap-y-1 text-xs">
                <div>
                  <dt className="text-sub">generatedAt</dt>
                  <dd className="font-mono text-dim">{loadState.data.generatedAt}</dd>
                </div>
                <div>
                  <dt className="text-sub">mode</dt>
                  <dd
                    className={`font-mono font-semibold ${
                      clientMode === 'mock' ? 'text-shape' : 'text-value'
                    }`}
                  >
                    {clientMode}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}

        {/* Back link */}
        <Link href="/" className="mt-8 block text-center text-xs text-dim hover:text-sub">
          ← back to Ratio
        </Link>
      </div>
    </div>
  );
}

