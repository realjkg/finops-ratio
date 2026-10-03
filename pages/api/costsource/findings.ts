// GET /api/costsource/findings?sourceId= — waste/opportunity findings.
// Delegates to the client seam. Sandbox sources answer from offline seed data;
// any other source (e.g. live PointFive) uses server credentials, so it gets
// the same deny-by-default gate as /api/costsource/rows: a valid
// `Authorization: Bearer <RATIO_API_TOKEN>` is required (refused outright when
// no token is configured), checked BEFORE any lookup or upstream call.
//
// Errors:
//   400 — missing sourceId
//   401 — non-sandbox source without a valid Bearer token
//   429 — too many failed authentications from this client IP (per minute)
//   404 — unknown source (only after auth)
//   405 — non-GET method
import type { NextApiRequest, NextApiResponse } from 'next';
import { createCostSourceClient } from '@/costsource';
import type { CostFinding } from '@/costsource';
import { gateSourceAccess } from '@/server/gateway/liveDataAuth';

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CostFinding[] | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sourceId = firstQueryValue(req.query.sourceId);
  if (!sourceId) {
    res.status(400).json({ error: 'sourceId query param is required' });
    return;
  }

  if (!gateSourceAccess(req, res, sourceId)) return;

  const client = createCostSourceClient('mock');
  try {
    res.status(200).json(await client.fetchFindings(sourceId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(message.includes('Unknown') ? 404 : 500).json({ error: message });
  }
}

