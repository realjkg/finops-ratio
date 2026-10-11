// Card A1: the interim environment mapping of PLAN 4.2 (replaced by owner
// decision D11 if other names are chosen). Exact string matching only: no
// trimming, no case folding, the same as `simulationEnabled` in
// src/simulation/server/enabled.ts. Anything unknown maps to null (fail closed).
import { describe, expect, it } from 'vitest';
import { dataEnvToDeployEnv, deployEnvFromProcess, ratioEnvToDeployEnv } from './envMap';

// Values that look plausible but are not on the allow-list. Prototype keys are
// included so a lookup table built on a plain object cannot leak a match.
const HOSTILE: unknown[] = [
  undefined, null, '', ' ', 'Production', 'PRODUCTION', ' production', 'production ', 'prod ', 'Prod',
  'DEV', 'Dev', 'Development', 'development\n', 'testing', 'qa', 'uat', 'preprod', 'local', '*',
  '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf',
  0, 1, true, false, {}, [], ['prod'], { toString: () => 'prod' },
];

describe('envMap', () => {
  it('workload_env_prod_staging_dev_sandbox_map_to_deploy_env', () => {
    expect(dataEnvToDeployEnv('prod')).toBe('prod');
    expect(dataEnvToDeployEnv('staging')).toBe('test');
    expect(dataEnvToDeployEnv('dev')).toBe('dev');
    expect(dataEnvToDeployEnv('sandbox')).toBe('dev');
    // The workload vocabulary is not the RATIO_ENV vocabulary (F16 vs PLAN 4.2).
    expect(dataEnvToDeployEnv('production')).toBeNull();
    expect(dataEnvToDeployEnv('development')).toBeNull();
    expect(dataEnvToDeployEnv('test')).toBeNull();
  });

  it('ratio_env_development_test_production_map_to_dev_test_prod', () => {
    expect(ratioEnvToDeployEnv('development')).toBe('dev');
    expect(ratioEnvToDeployEnv('test')).toBe('test');
    expect(ratioEnvToDeployEnv('staging')).toBe('test');
    expect(ratioEnvToDeployEnv('production')).toBe('prod');
    // The RATIO_ENV vocabulary is not the workload vocabulary.
    expect(ratioEnvToDeployEnv('prod')).toBeNull();
    expect(ratioEnvToDeployEnv('dev')).toBeNull();
    expect(ratioEnvToDeployEnv('sandbox')).toBeNull();

    // deployEnvFromProcess reads RATIO_ENV only (NODE_ENV plays no part).
    expect(deployEnvFromProcess({ RATIO_ENV: 'development' })).toBe('dev');
    expect(deployEnvFromProcess({ RATIO_ENV: 'test' })).toBe('test');
    expect(deployEnvFromProcess({ RATIO_ENV: 'staging' })).toBe('test');
    expect(deployEnvFromProcess({ RATIO_ENV: 'production' })).toBe('prod');
    expect(deployEnvFromProcess({ NODE_ENV: 'production' })).toBeNull();
    expect(deployEnvFromProcess({ NODE_ENV: 'development', RATIO_ENV: 'production' })).toBe('prod');
  });

  it('deployEnvFromProcess defaults to process.env', () => {
    const saved = process.env.RATIO_ENV;
    try {
      process.env.RATIO_ENV = 'staging';
      expect(deployEnvFromProcess()).toBe('test');
      delete process.env.RATIO_ENV;
      expect(deployEnvFromProcess()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.RATIO_ENV;
      else process.env.RATIO_ENV = saved;
    }
  });

  it('unknown_env_value_fails_closed', () => {
    for (const value of HOSTILE) {
      expect(ratioEnvToDeployEnv(value), `RATIO_ENV ${String(value)}`).toBeNull();
      expect(dataEnvToDeployEnv(value), `workload env ${String(value)}`).toBeNull();
      expect(deployEnvFromProcess({ RATIO_ENV: value as string | undefined }), `process ${String(value)}`).toBeNull();
    }
    expect(deployEnvFromProcess({})).toBeNull();
    // A polluted prototype must not create a mapping.
    const proto = Object.prototype as Record<string, unknown>;
    proto.qa = 'prod';
    try {
      expect(ratioEnvToDeployEnv('qa')).toBeNull();
      expect(dataEnvToDeployEnv('qa')).toBeNull();
    } finally {
      delete proto.qa;
    }
  });
});
