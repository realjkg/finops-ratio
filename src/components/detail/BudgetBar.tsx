// Budget bar — spec §3.4.1 + §10.4. Fill colored by utilization, soft/hard/kill
// threshold markers, and a semi-transparent projected-overshoot extension past
// 100%. Framer Motion animates the fill on mount; prefers-reduced-motion skips
// the animation. Exposes progressbar ARIA so screen readers announce the value.

import { motion, useReducedMotion } from 'framer-motion';
import { budgetColor } from '@/lib/scales';

export function BudgetBar({
  pctUsed,
  projectedPct,
  soft,
  hard,
  kill,
  label = 'Budget consumption',
  na = null,
}: {
  pctUsed: number;
  projectedPct: number;
  soft: number;
  hard: number;
  kill: number;
  /** Accessible label for the progressbar; defaults to 'Budget consumption'. */
  label?: string;
  /** Reason the budget is invalid; the bar then announces N/A, not 0. */
  na?: string | null;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const fillPct = Math.min(pctUsed, 1) * 100;
  const fillColor = budgetColor(pctUsed);
  // Overshoot = projected spend beyond 100%, drawn faint red past the fill.
  const overshootPct = na ? 0 : Math.max(Math.min(projectedPct, 1.4) - 1, 0) * 100;
  const displayPct = Math.round(pctUsed * 100);

  return (
    <div
      role="progressbar"
      aria-valuenow={na ? undefined : displayPct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={na ? `N/A (${na})` : `${displayPct}% of budget consumed`}
      aria-label={label}
      className="relative h-6 w-full overflow-hidden rounded bg-void"
    >
      <motion.div
        className="absolute inset-y-0 left-0 rounded-l"
        style={{ background: fillColor }}
        initial={reducedMotion ? false : { width: 0 }}
        animate={{ width: `${fillPct}%` }}
        transition={reducedMotion ? { duration: 0 } : { duration: 0.8, ease: 'easeOut' }}
      />
      {overshootPct > 0 && (
        <div
          className="absolute inset-y-0"
          style={{
            left: '100%',
            width: `${overshootPct}%`,
            background: 'var(--cost)',
            opacity: 0.4,
            transform: 'translateX(-100%)',
          }}
        />
      )}
      <Marker pct={soft} />
      <Marker pct={hard} />
      <Marker pct={kill} />
    </div>
  );
}

function Marker({ pct }: { pct: number }) {
  return (
    <div
      className="absolute inset-y-0 w-px bg-txt/40"
      style={{ left: `${Math.min(pct, 1) * 100}%` }}
      title={`${(pct * 100).toFixed(0)}% threshold`}
    />
  );
}


