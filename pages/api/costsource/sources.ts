// GET /api/costsource/sources — lists the cost sources.
// Thin Next.js route delegating to the mock client seam, mirroring
// pages/api/tokenomics.ts so mock and live behave identically.
//
// Live connector STATUS is only disclosed to authenticated callers (valid
// `Authorization: Bearer <RATIO_API_TOKEN>` with a token configured). Anonymous
// callers get the env-independent registry (`sourcesForEnv({})`) for every
// non-sandbox entry: no `configured: true`, no `connection: 'connected'`, no
// live note text. Sandbox entries are identical either way.
//
// Errors: 405 — non-GET method.
import type { NextApiRequest, NextApiResponse } from 'next';
import { createCostSourceClient } from '@/costsource';
import type { CostSourceDescriptor } from '@/costsource';
import { sourcesForEnv } from '@/costsource/seed';
import { isOfflineSandboxSource, requireLiveDataAuth } from '@/server/gateway/liveDataAuth';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CostSourceDescriptor[] | { error: string }>,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const client = createCostSourceClient('mock');
  const sources = await client.listSources();
  if (requireLiveDataAuth(req.headers.authorization).ok) {
    res.status(200).json(sources);
    return;
  }
  const neutral = new Map(sourcesForEnv({}).map((s) => [s.id, s]));
  res.status(200).json(
    sources.map((s) => (isOfflineSandboxSource(s.id) ? s : (neutral.get(s.id) ?? s))),
  );
}

