import { describe, expect, it } from 'vitest';
import { dataEnvToDeployEnv, deployEnvFromProcess, ratioEnvToDeployEnv } from './envMap';

describe('envMap (PLAN 4.2, exact match, fail closed)', () => {
  it('workload_env_prod_staging_dev_sandbox_map_to_deploy_env', () => {
    expect(['prod', 'staging', 'dev', 'sandbox'].map(dataEnvToDeployEnv)).toEqual(['prod', 'test', 'dev', 'dev']);
    expect(['production', 'development', 'test'].map(dataEnvToDeployEnv)).toEqual([null, null, null]);
  });

  it('ratio_env_development_test_production_map_to_dev_test_prod', () => {
    expect(['development', 'test', 'staging', 'production'].map(ratioEnvToDeployEnv)).toEqual(['dev', 'test', 'test', 'prod']);
    expect(['prod', 'dev', 'sandbox'].map(ratioEnvToDeployEnv)).toEqual([null, null, null]);
    expect(deployEnvFromProcess({ NODE_ENV: 'development', RATIO_ENV: 'production' })).toBe('prod');
    expect(deployEnvFromProcess({ NODE_ENV: 'production' })).toBeNull();
    expect(deployEnvFromProcess(Object.create({ RATIO_ENV: 'production' }))).toBeNull(); // inherited, not set
    const saved = process.env.RATIO_ENV;
    try {
      process.env.RATIO_ENV = 'staging';
      expect(deployEnvFromProcess()).toBe('test');
    } finally {
      if (saved === undefined) delete process.env.RATIO_ENV;
      else process.env.RATIO_ENV = saved;
    }
  });

  it('unknown_env_value_fails_closed', () => {
    const hostile: unknown[] = [undefined, null, '', 'Production', ' production', 'prod ', 'DEV', 'qa', '*', '__proto__', 'constructor', 'toString', 0, true, {}, ['prod'], { toString: () => 'prod' }];
    for (const v of hostile) {
      expect([ratioEnvToDeployEnv(v), dataEnvToDeployEnv(v), deployEnvFromProcess({ RATIO_ENV: v as string })], String(v)).toEqual([null, null, null]);
    }
  });
});
