// GET /api/costsource/rows?sourceId=&start=&end= — normalized FOCUS cost rows.
// Delegates to the client seam: sandbox sources serve offline seed data; a
// configured connector (cloud / Kubernetes / Nutanix / FOCUS endpoint) fetches
// its REAL export.
//
// Deny by default: only the offline sandbox sources are served anonymously.
// Every other source id (live connectors, PointFive, unknown ids) requires
// `Authorization: Bearer <RATIO_API_TOKEN>`; with no token configured it is
// refused outright. Unknown ids answer 404 only AFTER auth, so anonymous
// callers cannot discover which live sources exist.
//
// Errors:
//   400 — missing sourceId / window
//   401 — non-sandbox source without a valid Bearer token
//   404 — unknown source
//   409 — source not configured (live credentials required)
//   405 — non-GET method
import type { NextApiRequest, NextApiResponse } from 'next';
import { createCostSourceClient } from '@/costsource';
import type { CostRowsResult } from '@/costsource';
import { authorizeSourceAccess } from '@/server/gateway/liveDataAuth';

function statusForError(message: string): number {
  if (message.includes('Unknown')) return 404;
  if (message.includes('not configured')) return 409;
  if (message.includes('does not provide')) return 422;
  return 500;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CostRowsResult | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const sourceId = firstQueryValue(req.query.sourceId);
  const start = firstQueryValue(req.query.start);
  const end = firstQueryValue(req.query.end);
  if (!sourceId || !start || !end) {
    res.status(400).json({ error: 'sourceId, start, and end query params are required' });
    return;
  }

  const auth = authorizeSourceAccess(sourceId, req.headers.authorization);
  if (!auth.ok) {
    res.status(401).json({ error: auth.message });
    return;
  }

  const client = createCostSourceClient('mock');
  try {
    res.status(200).json(await client.fetchCostRows(sourceId, { start, end }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(statusForError(message)).json({ error: message });
  }
}

