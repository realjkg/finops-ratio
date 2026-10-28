// Leaf module on purpose: the simulation capability route (/api/v1/simulation/status)
// must load on any deployment — including hosts where the sqlite-backed database
// module cannot (Node versions without node:sqlite) — so demo mode can be reported
// affirmatively instead of being inferred from a failed session restore.
import { isVercelProduction } from '@/server/gateway/simulationMode';

// VERCEL_ENV=production refuses outright (same rule as the gateway gate). NODE_ENV=production
// is deliberately NOT refused here: CI acceptance and the local image run `next start`.
export function simulationEnabled(): boolean {
  if (isVercelProduction()) return false;
  return process.env.RATIO_SIMULATION === '1' && ['development', 'test'].includes(process.env.RATIO_ENV ?? '');
}
