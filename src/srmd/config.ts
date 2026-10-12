// Fail-closed configuration. Disabled unless an explicitly allowlisted
// simulated target is named. This build contains no network client at all, so
// any other target is refused rather than attempted.
import { SimulatedSrmdAdapter } from './simulated';
import type { SrmdAdapter } from './types';

export const ALLOWED_SIMULATED_TARGETS: readonly string[] = ['simulated://srmd-fixtures'];

export type SrmdConfig =
  | { enabled: true; target: string }
  | { enabled: false; reason: 'not_configured' | 'target_not_allowlisted' | 'credentials_not_accepted_in_this_build' };

/** Reads only SRMD_ENDPOINT and SRMD_CREDENTIAL. Values are never echoed back. */
export function resolveSrmdConfig(env: Record<string, string | undefined>): SrmdConfig {
  const endpoint = env.SRMD_ENDPOINT?.trim();
  const credential = env.SRMD_CREDENTIAL?.trim();
  if (!endpoint && !credential) return { enabled: false, reason: 'not_configured' };
  if (!endpoint || !ALLOWED_SIMULATED_TARGETS.includes(endpoint)) return { enabled: false, reason: 'target_not_allowlisted' };
  if (credential) return { enabled: false, reason: 'credentials_not_accepted_in_this_build' };
  return { enabled: true, target: endpoint };
}

export function createSrmdAdapter(env: Record<string, string | undefined>): { enabled: true; adapter: SrmdAdapter } | { enabled: false; reason: string } {
  const cfg = resolveSrmdConfig(env);
  return cfg.enabled ? { enabled: true, adapter: new SimulatedSrmdAdapter() } : { enabled: false, reason: cfg.reason };
}
