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

export function gatewaySimulationMode(env: SimulationEnv = process.env): boolean {
  const ratioEnv = own(env, 'RATIO_ENV');
  return own(env, 'RATIO_SIMULATION') === '1' && typeof ratioEnv === 'string' && ALLOWED_RATIO_ENVS.includes(ratioEnv);
}
