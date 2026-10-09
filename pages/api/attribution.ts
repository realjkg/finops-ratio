// GET /api/attribution?dimension=team|user — returns an AttributionReport built
// from the mock seed. Mirrors pages/api/tokenomics.ts in shape: a thin Next.js
// route that delegates entirely to the client seam so mock and live behave
// identically. The report is value-agnostic (absolute tokens + USD only); the
// wire carries no value-ratio field — a contract test pins that.
//
// Errors:
//   400 — dimension is not one of team, user (fixed message, never echoes input)
//   405 — non-GET method
//   500 — generic { error, requestId } via withInternalErrorGuard
import type { NextApiRequest, NextApiResponse } from 'next';
import { createAttributionClient, isAttributionDimension } from '@/attribution';
import type { AttributionReport } from '@/attribution';
import { withInternalErrorGuard } from '@/server/gateway/internalError';

/** The ONE fixed 400 message (allow-listed in src/lib/httpError.ts). */
export const INVALID_DIMENSION_MESSAGE = 'dimension must be one of team, user';

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AttributionReport | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Absent → default 'team'; anything else invalid is a fixed 400 (no echo).
  const dimension = req.query.dimension ?? 'team';
  if (typeof dimension !== 'string' || !isAttributionDimension(dimension)) {
    res.status(400).json({ error: INVALID_DIMENSION_MESSAGE });
    return;
  }

  // Default to mock; future: read ?mode=live to exercise LiveAttributionClient.
  const client = createAttributionClient('mock');
  const report = await client.getAttributionReport(dimension);
  res.status(200).json(report);
}

export default withInternalErrorGuard(handler);
