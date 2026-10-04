// Issue #62, orchestrator decision D1 (2026-10-04): synthetic provider names
// (SyntheticCloud) are accepted ONLY with the explicit opt-in
// RATIO_ALLOW_SYNTHETIC_PROVIDERS=1. Default OFF; refused when RATIO_ENV=production.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadWorkerConfig, resolveSettings, syntheticProvidersOptIn } from './config';

const base = { RATIO_DATABASE_URL: 'postgres://w@127.0.0.1:1/db' };

describe('RATIO_ALLOW_SYNTHETIC_PROVIDERS', () => {
  it('defaults to OFF everywhere: the default settings, resolveSettings, an empty env, the loaded config', () => {
    expect(DEFAULT_SETTINGS.allowSyntheticProviders).toBe(false);
    expect(resolveSettings().allowSyntheticProviders).toBe(false);
    expect(resolveSettings({ leaseTtlSeconds: 10 }).allowSyntheticProviders).toBe(false);
    expect(syntheticProvidersOptIn({})).toBe(false);
    for (const ratioEnv of [undefined, 'development', 'test', 'staging', 'production']) {
      const env = ratioEnv === undefined ? base : { ...base, RATIO_ENV: ratioEnv };
      expect(loadWorkerConfig(env).settings.allowSyntheticProviders, String(ratioEnv)).toBe(false);
    }
  });

  it('"1" turns it on (outside production); "" and "0" leave it off', () => {
    expect(syntheticProvidersOptIn({ RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' })).toBe(true);
    expect(loadWorkerConfig({ ...base, RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' }).settings.allowSyntheticProviders).toBe(true);
    expect(loadWorkerConfig({ ...base, RATIO_ENV: 'staging', RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' }).settings.allowSyntheticProviders).toBe(true);
    for (const v of ['', '0']) {
      expect(syntheticProvidersOptIn({ RATIO_ALLOW_SYNTHETIC_PROVIDERS: v })).toBe(false);
      expect(loadWorkerConfig({ ...base, RATIO_ALLOW_SYNTHETIC_PROVIDERS: v }).settings.allowSyntheticProviders).toBe(false);
    }
  });

  it('refuses any other value (no "true", "yes", spaces)', () => {
    for (const v of ['true', 'yes', 'on', ' 1', '1 ', '01', '2', 'TRUE']) {
      expect(() => loadWorkerConfig({ ...base, RATIO_ALLOW_SYNTHETIC_PROVIDERS: v }), v).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => syntheticProvidersOptIn({ RATIO_ALLOW_SYNTHETIC_PROVIDERS: v }), v).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });

  it('is refused when RATIO_ENV=production: a production config never accepts synthetic providers', () => {
    expect(() => loadWorkerConfig({ ...base, RATIO_ENV: 'production', RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' })).toThrow(
      expect.objectContaining({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' }),
    );
    expect(() => syntheticProvidersOptIn({ RATIO_ENV: 'production', RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' })).toThrow(
      expect.objectContaining({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' }),
    );
    expect(() => syntheticProvidersOptIn({ RATIO_ENV: ' production ', RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' })).toThrow(
      expect.objectContaining({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' }),
    );
  });
});
