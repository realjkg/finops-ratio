// Demo vs engagement mode, and the one demo wording used by the top-bar badge and the demo exports.
// Client-safe: no Node import. The mode follows the same rule as proxy.ts: RATIO_MODE unset or empty
// is the demo; "engagement" is a customer instance; anything else is invalid (fails closed, not a demo).

export const DEMO_LABEL = 'Demo environment — figures are illustrative';

export type RatioMode = 'demo' | 'engagement' | 'invalid';

export function ratioModeOf(env: Record<string, string | undefined>): RatioMode {
  const m = env.RATIO_MODE;
  if (m === undefined || m === '') return 'demo';
  return m === 'engagement' ? 'engagement' : 'invalid';
}

/** Set by the engagement page's getServerSideProps, so the browser knows the server's mode. */
export const ENGAGEMENT_PAGE_MARK = '__ratioMode';

/** The mode a page was served in: engagement when its server props carry the mark, otherwise the demo. */
export function modeOfPage(pageProps: unknown): RatioMode {
  const p = pageProps as Record<string, unknown> | null | undefined;
  return p && p[ENGAGEMENT_PAGE_MARK] === 'engagement' ? 'engagement' : 'demo';
}

const NO_BADGE = new Set(['/engagement', '/_error', '/404', '/500']);

/**
 * The badge shows only in demo mode (never in engagement or an invalid mode), and then on every
 * page except /simulation* (its route name and heading say "Simulation"), the engagement page and
 * error pages.
 */
export function showsDemoBadge(pathname: string, mode: RatioMode): boolean {
  if (mode !== 'demo') return false;
  if (pathname === '/simulation' || pathname.startsWith('/simulation/')) return false;
  return !NO_BADGE.has(pathname);
}

/** The quiet line demo exports carry (PDF footer, XLSX note), or null outside demo mode. */
export function demoExportLine(env: Record<string, string | undefined>): string | null {
  return ratioModeOf(env) === 'demo' ? DEMO_LABEL : null;
}
