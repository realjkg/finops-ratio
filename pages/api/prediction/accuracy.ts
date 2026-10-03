// GET /api/prediction/accuracy — the prediction-error ledger summary (p50/p90
// per change type, source error distributions, cold-start flag). Delegates to
// the mock client seam; pure over offline seed data (empty cold-start ledger).
//
// Errors:
//   405 — non-GET method
import type { NextApiRequest, NextApiResponse } from 'next';
import { createPredictionClient } from '@/prediction';
import type { AccuracyReport } from '@/prediction';
import { withInternalErrorGuard } from '@/server/gateway/internalError';

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AccuracyReport | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const client = createPredictionClient('mock');
  res.status(200).json(await client.getAccuracyReport());
}

export default withInternalErrorGuard(handler);
