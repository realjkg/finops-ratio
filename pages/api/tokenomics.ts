// GET /api/tokenomics — returns a TokenomicsReport built from the mock seed.
// Mirrors pages/api/hello.ts in shape: a thin Next.js route that delegates
// entirely to the client seam so mock and live behave identically.
//
// Errors:
//   405 — non-GET method
import type { NextApiRequest, NextApiResponse } from 'next';
import { createTokenomicsClient } from '@/tokenomics';
import type { TokenomicsReport } from '@/tokenomics';
import { withInternalErrorGuard } from '@/server/gateway/internalError';

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TokenomicsReport | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Default to mock; future: read ?mode=live to exercise LiveTokenomicsClient.
  const client = createTokenomicsClient('mock');
  const report = await client.getTokenomicsReport();
  res.status(200).json(report);
}

export default withInternalErrorGuard(handler);
