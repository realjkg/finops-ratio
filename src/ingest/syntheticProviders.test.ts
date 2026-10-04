// Issue #62, orchestrator decision D1 (2026-10-04) and challenger L3: the
// synthetic provider names are accepted ONLY with the explicit opt-in
// RATIO_ALLOW_SYNTHETIC_PROVIDERS=1, and only when RATIO_ENV is EXPLICITLY
// `development` or `test`. Default OFF. Unset, unknown, staging and
// production RATIO_ENV refuse the opt-in.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadWorkerConfig, resolveSettings, syntheticProvidersOptIn } from './config';

const base = { RATIO_DATABASE_URL: 'postgres://w@127.0.0.1:1/db' };
const ON = { RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' };
const NOT_ALLOWED = expect.objectContaining({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' });

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

  it('"1" turns it on only when RATIO_ENV is explicitly development or test', () => {
    for (const ratioEnv of ['development', 'test']) {
      expect(syntheticProvidersOptIn({ ...ON, RATIO_ENV: ratioEnv }), ratioEnv).toBe(true);
      expect(loadWorkerConfig({ ...base, ...ON, RATIO_ENV: ratioEnv }).settings.allowSyntheticProviders, ratioEnv).toBe(true);
    }
  });

  it('"" and "0" leave it off in every RATIO_ENV, production included', () => {
    for (const v of ['', '0']) {
      for (const ratioEnv of [undefined, 'development', 'test', 'staging', 'production']) {
        const env = { RATIO_ALLOW_SYNTHETIC_PROVIDERS: v, ...(ratioEnv === undefined ? {} : { RATIO_ENV: ratioEnv }) };
        expect(syntheticProvidersOptIn(env), `${v}/${ratioEnv}`).toBe(false);
        expect(loadWorkerConfig({ ...base, ...env }).settings.allowSyntheticProviders, `${v}/${ratioEnv}`).toBe(false);
      }
    }
  });

  it('refuses any other value (no "true", "yes", spaces)', () => {
    for (const v of ['true', 'yes', 'on', ' 1', '1 ', '01', '2', 'TRUE']) {
      expect(() => loadWorkerConfig({ ...base, RATIO_ENV: 'test', RATIO_ALLOW_SYNTHETIC_PROVIDERS: v }), v).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
      expect(() => syntheticProvidersOptIn({ RATIO_ENV: 'test', RATIO_ALLOW_SYNTHETIC_PROVIDERS: v }), v).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });

  it('is refused when RATIO_ENV=production: a production config never accepts synthetic providers', () => {
    expect(() => loadWorkerConfig({ ...base, ...ON, RATIO_ENV: 'production' })).toThrow(NOT_ALLOWED);
    expect(() => syntheticProvidersOptIn({ ...ON, RATIO_ENV: 'production' })).toThrow(NOT_ALLOWED);
    expect(() => syntheticProvidersOptIn({ ...ON, RATIO_ENV: ' production ' })).toThrow(NOT_ALLOWED);
  });

  it('L3: is refused when RATIO_ENV is unset or empty (the worker would default to development, but the opt-in needs it explicit)', () => {
    expect(() => loadWorkerConfig({ ...base, ...ON })).toThrow(NOT_ALLOWED);
    expect(() => syntheticProvidersOptIn({ ...ON })).toThrow(NOT_ALLOWED);
    expect(() => loadWorkerConfig({ ...base, ...ON, RATIO_ENV: '' })).toThrow(NOT_ALLOWED);
    expect(() => syntheticProvidersOptIn({ ...ON, RATIO_ENV: '   ' })).toThrow(NOT_ALLOWED);
  });

  it('L3: is refused in staging', () => {
    expect(() => loadWorkerConfig({ ...base, ...ON, RATIO_ENV: 'staging' })).toThrow(NOT_ALLOWED);
    expect(() => syntheticProvidersOptIn({ ...ON, RATIO_ENV: 'staging' })).toThrow(NOT_ALLOWED);
  });

  it('L3: is refused for an unknown or differently-cased RATIO_ENV', () => {
    for (const ratioEnv of ['prod', 'dev', 'TEST', 'Development', 'local', 'testing', 'ci']) {
      expect(() => syntheticProvidersOptIn({ ...ON, RATIO_ENV: ratioEnv }), ratioEnv).toThrow(NOT_ALLOWED);
    }
  });

  it('the refusal names the rule, not the value', () => {
    try {
      syntheticProvidersOptIn({ ...ON, RATIO_ENV: 'staging' });
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as Error).message).toBe('RATIO_ALLOW_SYNTHETIC_PROVIDERS=1 is accepted only when RATIO_ENV is explicitly development or test');
    }
  });
});
