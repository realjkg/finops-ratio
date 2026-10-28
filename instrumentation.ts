// Next.js startup hook (runs once when the server starts). Slice 2: validates
// the published-costs configuration (RATIO_API_TENANT_ID must be a canonical
// UUID) and logs a structured error when it is invalid; the route then fails
// closed (503). Node.js runtime only; never imports pg (importBoundary test).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Engagement mode (RATIO_MODE=engagement): an invalid or missing engagement
  // config THROWS here (keys only, never values), so the server refuses to start.
  const { checkEngagementStartup } = await import('./src/engagement/config');
  checkEngagementStartup(process.env);
  const { checkPublishedCostsStartup } = await import('./src/server/costs/config');
  checkPublishedCostsStartup(process.env);
}
