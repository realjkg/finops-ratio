// The interim environment mapping of PLAN 4.2, implemented once (card A1).
// Owner decision D11 replaces it if other names are chosen.
//
// | Source value                                | DeployEnv |
// | RATIO_ENV = development                     | dev       |
// | RATIO_ENV = test or staging                 | test      |
// | RATIO_ENV = production                      | prod      |
// | workload environment = dev or sandbox       | dev       |
// | workload environment = staging              | test      |
// | workload environment = prod                 | prod      |
// | anything else or unset                      | null (fail closed: deny) |
//
// Exact string match only: no trimming and no case folding, the same as
// `simulationEnabled` in src/simulation/server/enabled.ts. A switch is used
// instead of an object lookup so a prototype key can never produce a value.
import type { DeployEnv } from './types';

/** Maps a raw `RATIO_ENV` value (src/ingest/config.ts vocabulary). */
export function ratioEnvToDeployEnv(value: unknown): DeployEnv | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'development':
      return 'dev';
    case 'test':
    case 'staging':
      return 'test';
    case 'production':
      return 'prod';
    default:
      return null;
  }
}

/** Maps a workload's `environment` field (F16 vocabulary: prod, staging, dev, sandbox). */
export function dataEnvToDeployEnv(value: unknown): DeployEnv | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'dev':
    case 'sandbox':
      return 'dev';
    case 'staging':
      return 'test';
    case 'prod':
      return 'prod';
    default:
      return null;
  }
}

/**
 * The deployment's own `DeployEnv` (the value a token's `aud` must equal),
 * from the raw `RATIO_ENV`. `NODE_ENV` plays no part. Null means the
 * deployment environment is unknown and every caller must fail closed.
 */
export function deployEnvFromProcess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeployEnv | null {
  return ratioEnvToDeployEnv(Object.hasOwn(env, 'RATIO_ENV') ? env.RATIO_ENV : undefined);
}
