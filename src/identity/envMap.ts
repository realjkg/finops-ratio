// The interim environment mapping of PLAN 4.2 (D11 may rename it). Exact
// match only, no trimming or case folding; anything else maps to null and
// callers fail closed. A Map never matches a prototype key.
import type { DeployEnv } from './types';

const RATIO_ENV = new Map<unknown, DeployEnv>([['development', 'dev'], ['test', 'test'], ['staging', 'test'], ['production', 'prod']]);
const DATA_ENV = new Map<unknown, DeployEnv>([['dev', 'dev'], ['sandbox', 'dev'], ['staging', 'test'], ['prod', 'prod']]);

/** A raw `RATIO_ENV` value (src/ingest/config.ts vocabulary). */
export const ratioEnvToDeployEnv = (value: unknown): DeployEnv | null => RATIO_ENV.get(value) ?? null;

/** A workload's `environment` field (F16 vocabulary). */
export const dataEnvToDeployEnv = (value: unknown): DeployEnv | null => DATA_ENV.get(value) ?? null;

/** The deployment's own DeployEnv (a token's `aud`), from RATIO_ENV only; NODE_ENV plays no part. */
export function deployEnvFromProcess(env: Readonly<Record<string, string | undefined>> = process.env): DeployEnv | null {
  return ratioEnvToDeployEnv(Object.hasOwn(env, 'RATIO_ENV') ? env.RATIO_ENV : undefined);
}
