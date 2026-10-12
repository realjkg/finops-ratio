// Fail-closed configuration. Disabled unless an explicitly allowlisted
// simulated target is named, by exact match. This build contains no network
// client at all, so any other target is refused rather than attempted.
import { SimulatedSrmdAdapter } from './simulated';
import type { SrmdAdapter } from './types';

export const ALLOWED_SIMULATED_TARGETS: readonly string[] = ['simulated://srmd-fixtures'];

export type SrmdConfig =
  | { enabled: true; target: string }
  | { enabled: false; reason: 'not_configured' | 'target_not_allowlisted' | 'credentials_not_accepted_in_this_build' | 'invalid_environment' };

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/** Reads only SRMD_ENDPOINT and SRMD_CREDENTIAL. Never throws; values are never echoed or trimmed into acceptance. */
export function resolveSrmdConfig(env: unknown): SrmdConfig {
  try {
    const e = (env !== null && typeof env === 'object' ? env : {}) as Record<string, unknown>;
    const endpoint = e.SRMD_ENDPOINT;
    const credential = e.SRMD_CREDENTIAL;
    if (!present(endpoint) && !present(credential)) return { enabled: false, reason: 'not_configured' };
    if (typeof endpoint !== 'string' || !ALLOWED_SIMULATED_TARGETS.includes(endpoint)) return { enabled: false, reason: 'target_not_allowlisted' };
    if (present(credential)) return { enabled: false, reason: 'credentials_not_accepted_in_this_build' };
    return { enabled: true, target: endpoint };
  } catch {
    return { enabled: false, reason: 'invalid_environment' };
  }
}

export function createSrmdAdapter(env: unknown): { enabled: true; adapter: SrmdAdapter } | { enabled: false; reason: string } {
  const cfg = resolveSrmdConfig(env);
  return cfg.enabled ? { enabled: true, adapter: new SimulatedSrmdAdapter() } : { enabled: false, reason: cfg.reason };
}
