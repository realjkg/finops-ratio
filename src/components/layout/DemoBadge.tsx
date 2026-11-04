// The single, quiet demo indicator. One small "Demo" badge in the top bar takes the place of
// per-card "synthetic" or "sample" labels: the whole environment is a demo, so the data does not
// need to say so on every card. It is named for assistive technology with what it means.
//
// Not shown on /simulation (the route and its heading already say "Simulation"), on the
// engagement report (a customer instance, never a demo) or on error pages.

export const DEMO_BADGE_LABEL = 'Demo environment — figures are illustrative';

const NO_BADGE = new Set(['/engagement', '/_error', '/404', '/500']);

/** True for every demo page that should carry the badge. */
export function showsDemoBadge(pathname: string): boolean {
  if (pathname === '/simulation' || pathname.startsWith('/simulation/')) return false;
  return !NO_BADGE.has(pathname);
}

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
