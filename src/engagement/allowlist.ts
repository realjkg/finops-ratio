// R2 slice D: what an engagement instance serves (RATIO_MODE=engagement).
// Only the named-user session routes, the report page, the report routes
// (session or machine token, decided by the routes), the machine-token
// published-costs route and the build assets. Every demo page and every seed,
// simulation, anonymous or shared-token gateway route answers 404 there
// (plan decision 3: remove rather than protect; they show fabricated figures).
// Exact paths only: no prefix match except the build asset directory.
export const ENGAGEMENT_ALLOWED_ROUTES: readonly string[] = Object.freeze([
  '/engagement',
  '/api/auth/login', '/api/auth/logout', '/api/auth/session', '/api/auth/oidc/start', '/api/auth/oidc/callback',
  '/api/v1/reports/facts', '/api/v1/reports/engagement', '/api/v1/costs/published',
]);
const ASSETS = new Set(['/favicon.svg']);

export function engagementPathAllowed(pathname: string): boolean {
  return ENGAGEMENT_ALLOWED_ROUTES.includes(pathname) || ASSETS.has(pathname) || pathname.startsWith('/_next/');
}
