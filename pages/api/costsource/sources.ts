// GET /api/costsource/sources — lists the cost sources.
// Thin Next.js route delegating to the mock client seam, mirroring
// pages/api/tokenomics.ts so mock and live behave identically.
//
// Live connector STATUS is only disclosed to authenticated callers (valid
// `Authorization: Bearer <RATIO_API_TOKEN>` with a token configured). Anonymous
// callers get the env-independent registry (`sourcesForEnv({})`) for every
// non-sandbox entry: no `configured: true`, no `connection: 'connected'`, no
// live note text. Sandbox entries are identical either way. A presented but
// WRONG bearer is a failed auth attempt in the shared accounting (so this
// route is no token oracle); over the limit it gets 429. A weak (< 32 char)
// configured token never unlocks live status.
//
// Errors: 405 — non-GET method; 429 — too many failed authentications.
import type { NextApiRequest, NextApiResponse } from 'next';
import { createCostSourceClient } from '@/costsource';
import type { CostSourceDescriptor } from '@/costsource';
import { anonymousSourceView } from '@/costsource/sourceDisclosure';
import { evaluateLiveDataAuth, THROTTLED_MESSAGE } from '@/server/gateway/liveDataAuth';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CostSourceDescriptor[] | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = evaluateLiveDataAuth(req, { countAbsent: false });
  if (auth.kind === 'throttled') {
    res.setHeader('Retry-After', String(auth.retryAfterSec));
    res.status(429).json({ error: THROTTLED_MESSAGE });
    return;
  }

  const client = createCostSourceClient('mock');
  const sources = await client.listSources();
  res.status(200).json(auth.kind === 'ok' ? sources : anonymousSourceView(sources));
}

