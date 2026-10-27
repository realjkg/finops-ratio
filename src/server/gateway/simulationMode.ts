// The one gate for local simulation of protected routes (P11). Auth is
// enforced everywhere by default; a missing token, a missing identity
// configuration or a failing auth check is a refusal, never a mode.
//
// True only when RATIO_SIMULATION is exactly '1' AND RATIO_ENV is exactly
// 'development' or 'test' (exact strings: no trimming, no case folding). Only
// own properties count, so a polluted prototype cannot switch it on. Callers
// still enforce auth when a token or a live provider is configured, so this
// mode serves bundled fixtures only and cannot reach a production action.

// Any env-shaped object (process.env, GatewayEnv, FinioEnv, test fixtures).
export type SimulationEnv = object;

const ALLOWED_RATIO_ENVS: readonly string[] = ['development', 'test'];

function own(env: SimulationEnv, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(env, key) ? (env as Record<string, string | undefined>)[key] : undefined;
}

/** True on a Vercel production deployment (exact string, own property only). Used by the gateway gate and by simulationEnabled(). */
export function isVercelProduction(env: SimulationEnv = process.env): boolean {
  return own(env, 'VERCEL_ENV') === 'production';
}

export function gatewaySimulationMode(env: SimulationEnv = process.env): boolean {
  // Never in a production deployment: Vercel production refuses outright, and
  // NODE_ENV=production (which `next start` sets) needs the additional opt-in
  // RATIO_SIMULATION_IMAGE=1, set only by infrastructure/simulation/Dockerfile.
  if (isVercelProduction(env)) return false;
  if (own(env, 'NODE_ENV') === 'production' && own(env, 'RATIO_SIMULATION_IMAGE') !== '1') return false;
  const ratioEnv = own(env, 'RATIO_ENV');
  return own(env, 'RATIO_SIMULATION') === '1' && typeof ratioEnv === 'string' && ALLOWED_RATIO_ENVS.includes(ratioEnv);
}
