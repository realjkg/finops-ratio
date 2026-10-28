// Next.js startup hook (runs once when the server starts). Slice 2: validates
// the published-costs configuration (RATIO_API_TENANT_ID must be a canonical
// UUID) and logs a structured error when it is invalid; the route then fails
// closed (503). Node.js runtime only; never imports pg (importBoundary test).
// The positive NEXT_RUNTIME check lets the Edge build drop this body entirely.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Engagement mode (RATIO_MODE=engagement): an invalid or missing engagement
    // config ends the process with exit code 1. A rejected register() alone does
    // not stop `next start` (it keeps serving 500s), so exit explicitly. Only the
    // problem keys are logged, never values.
    const { checkEngagementStartup, EngagementConfigError } = await import('./src/engagement/config');
    try {
      checkEngagementStartup(process.env);
    } catch (e) {
      if (!(e instanceof EngagementConfigError)) throw e;
      console.error(JSON.stringify({ event: 'engagement_config_invalid', problems: e.problems }));
      process.exit(1);
      return;
    }
    const { checkPublishedCostsStartup } = await import('./src/server/costs/config');
    checkPublishedCostsStartup(process.env);
  }
}
