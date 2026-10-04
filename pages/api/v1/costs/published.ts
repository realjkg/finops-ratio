// GET /api/v1/costs/published — the tenant's published cost facts (Slice 2).
//
// Reads ONLY Slice 0's published-facts view as a ratio_reader member login
// (RATIO_READER_DATABASE_URL), tenant-scoped through withTenantTransaction.
// Auth is the existing live-data Bearer auth + withGateway; the tenant is the
// one the configured API key is bound to (RATIO_API_TENANT_ID), never taken
// from the request. Query: period=YYYY-MM | from/to=YYYY-MM, limit (1..500,
// default 100), cursor (opaque, from page.nextCursor). Money is returned as
// decimal strings. Details: src/server/costs/publishedCostsRoute.ts and
// docs/evidence/slice-2/DESIGN.md.
//
// SERVER-ONLY: this is the one file allowed to import src/server/costs
// (enforced by src/ingest/importBoundary.test.ts and `npm run check:bundle`).
import { createPublishedCostsRoute } from '@/server/costs/publishedCostsRoute';

export default createPublishedCostsRoute();
