// The three integrity metric cards — shared by the mock report flow and the
// scenario playground. Each card shows the full working: layer, formula,
// named inputs, computed value, and pass/fail status (no-invented-numbers).
import type { TokenomicsReport } from './index';

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-sub">
      {children}
    </p>
  );
}

export function HealthBadge({ pass }: { pass: boolean }) {
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

export function MetricCard1({ report }: { report: TokenomicsReport }) {
  const m = report.metrics.counterAlignment;
  const pct = m.value.toFixed(2);
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

export function MetricCard2({ report }: { report: TokenomicsReport }) {
  const m = report.metrics.pipelineIntegrity;
  const score = m.value.toFixed(4);
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

      {/* Assumption note — kept EXACTLY as seeded; unit confirmation pending. */}
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

export function MetricCard3({ report }: { report: TokenomicsReport }) {
  const m = report.metrics.ledgerSync;
  const { delta, inSync } = m.value;
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
