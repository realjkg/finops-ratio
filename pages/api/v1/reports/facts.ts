// GET /api/v1/reports/facts?period=YYYY-MM — internal report facts (1.0) for
// one billing period: source/import identity, period, currency, billed and
// effective cost basis, credits policy, freshness and coverage gaps, from the
// tenant's published cost facts; missing data is N/A with a reason, never 0.
// Same auth and tenant binding as /api/v1/costs/published.
//
// SERVER-ONLY: one of the two files allowed to import src/server/costs
// (enforced by src/ingest/importBoundary.test.ts and `npm run check:bundle`).
import { createReportFactsRoute } from '@/server/costs/reportFactsRoute';

export default createReportFactsRoute();
