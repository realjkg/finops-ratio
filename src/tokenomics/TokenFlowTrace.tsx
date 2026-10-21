// TokenFlowTrace — the evidence visual for the playground: the scenario's
// token flow through the three integrity layers (Hardware Ingest → Data
// Pipeline → UI Presentation), with the visible drop at each layer.
//
// Counts and flows are the scenario's own (animated on change); the RATES are
// seeded structure — that is the honest story the visual tells: integrity is
// structural, scale and mix move the volumes. Semantic data palette only
// (unit cyan flows, cost red losses, value green in-sync) — no warm accent.
import { useEffect, useRef, useState } from 'react';
import { animate, motion, useReducedMotion } from 'framer-motion';
import { formatUSD } from '@/lib/format';
import type { ScenarioBridge, FlowStage } from './scenario';

function formatCount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatStageValue(value: number, unit: FlowStage['unit']): string {
  return unit === 'usd' ? formatUSD(value) : formatCount(value);
}

/** Number that animates to its new value when the scenario changes. */
function AnimatedNumber({
  value,
  unit,
}: {
  value: number;
  unit: FlowStage['unit'];
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = value;
    if (reduceMotion || from === value) return;
    const controls = animate(from, value, {
      duration: 0.5,
      ease: 'easeOut',
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, reduceMotion]);

  return (
    <span className="font-mono text-xs font-semibold text-txt">
      {formatStageValue(display, unit)}
    </span>
  );
}

function LossDot({ reduceMotion, inSync }: { reduceMotion: boolean; inSync: boolean }) {
  const color = inSync ? 'bg-value' : 'bg-cost';
  if (reduceMotion) {
    return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
  }
  return (
    <motion.span
      className={`inline-block h-1.5 w-1.5 rounded-full ${color}`}
      animate={{ opacity: [1, 0.25, 1] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

function FlowStagePanel({
  stage,
  ordinal,
  reduceMotion,
}: {
  stage: FlowStage;
  ordinal: number;
  reduceMotion: boolean;
}) {
  const outPct = stage.inValue > 0 ? (stage.outValue / stage.inValue) * 100 : 0;
  const inSync = stage.lossValue === 0;
  return (
    <div className="rounded-card border border-edge bg-slab p-4">
      <p className="text-[10px] uppercase tracking-widest text-dim">
        Layer {ordinal} — {stage.layer}
      </p>

      {/* Flow counts — in above, out below; the out-bar shows the share kept. */}
      <div className="mt-3 space-y-2">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-dim">in</span>
            <AnimatedNumber value={stage.inValue} unit={stage.unit} />
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-raised">
            <motion.div
              className="h-full rounded-full bg-dim/60"
              initial={{ width: '100%' }}
              animate={{ width: '100%' }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-dim">out</span>
            <AnimatedNumber value={stage.outValue} unit={stage.unit} />
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-raised">
            <motion.div
              className={`h-full rounded-full ${inSync ? 'bg-value' : 'bg-unit'}`}
              initial={{ width: `${outPct}%` }}
              animate={{ width: `${outPct}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
        </div>
      </div>

      {/* The visible drop at this layer. */}
      <div className="mt-3 flex items-center gap-2">
        <LossDot reduceMotion={reduceMotion} inSync={inSync} />
        {inSync ? (
          <span className="font-mono text-xs text-value">in sync — Δ $0</span>
        ) : (
          <span className="font-mono text-xs text-cost">
            −{formatStageValue(stage.lossValue, stage.unit)} {stage.lossLabel}
          </span>
        )}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-dim">{stage.rateLabel}</p>
    </div>
  );
}

export function TokenFlowTrace({ bridge }: { bridge: ScenarioBridge }) {
  const reduceMotion = useReducedMotion() ?? false;
  const [s1, s2, s3] = bridge.flow;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <FlowStagePanel stage={s1} ordinal={1} reduceMotion={reduceMotion} />
      <FlowStagePanel stage={s2} ordinal={2} reduceMotion={reduceMotion} />
      <FlowStagePanel stage={s3} ordinal={3} reduceMotion={reduceMotion} />
    </div>
  );
}
