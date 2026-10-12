// GET /api/v1/simulation/status — the simulation capability probe.
//
// Deliberately NOT wrapped in simulationRoute: this route must answer on every
// deployment, including ones where the simulation gate disables it — its whole
// purpose is to tell the client affirmatively that restore is not applicable,
// so a demo deployment never attempts a session restore and never renders a
// restore-error banner. It imports only the env-gate leaf (no sqlite-backed
// database module), so it responds even where the session route cannot load.
import type { NextApiRequest, NextApiResponse } from 'next';
import { simulationEnabled } from '@/simulation/server/enabled';

export default function statusRoute(req: NextApiRequest, res: NextApiResponse): void {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.status(405).json({ error: 'Method not allowed.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ enabled: simulationEnabled() });
}
