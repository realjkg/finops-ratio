// GET /api/v1/reports/engagement?period=YYYY-MM&format=xlsx — the engagement
// cost report (1.0) for one billing period, built only from the tenant's
// published report facts; missing data is N/A with a reason, never 0. Same
// auth and tenant binding as /api/v1/reports/facts.
//
// SERVER-ONLY: one of the three files allowed to import src/server/costs
// (enforced by src/ingest/importBoundary.test.ts and `npm run check:bundle`).
import { createEngagementReportRoute } from '@/server/costs/engagementReportRoute';

export default createEngagementReportRoute();
