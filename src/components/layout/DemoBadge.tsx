// The single, quiet demo indicator. One small "Demo" badge in the top bar takes the place of
// per-card "synthetic" or "sample" labels: the whole environment is a demo, so the data does not
// need to say so on every card. It is named for assistive technology with what it means.
//
// Where it shows is decided by src/lib/demoMode.ts: only in demo mode (never in engagement mode),
// and not on /simulation (the route and its heading already say "Simulation") or error pages.
import { DEMO_LABEL } from '@/lib/demoMode';

export const DEMO_BADGE_LABEL = DEMO_LABEL;
export { showsDemoBadge } from '@/lib/demoMode';

export function DemoBadge({ className = '' }: { className?: string }) {
  return (
    <span
      role="note"
      aria-label={DEMO_BADGE_LABEL}
      title={DEMO_BADGE_LABEL}
      data-testid="demo-badge"
      className={`shrink-0 rounded border border-edge px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-wider text-sub ${className}`}
    >
      Demo
    </span>
  );
}
