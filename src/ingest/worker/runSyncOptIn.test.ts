// Copilot F3 (r4178540607): the library contract. runSync({ settings: { allowSyntheticProviders: true } })
// must NOT bypass the validated opt-in. Every path that ends up `true` requires THIS PROCESS's
// RATIO_ALLOW_SYNTHETIC_PROVIDERS=1 with RATIO_ENV explicitly development or test (no injected env:
// a caller cannot assert its own). An explicit `false` is a pure override and needs no env.
// The check happens before any I/O: the pool below records every use.
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeFocusSource } from '../sources/fake/FakeFocusSource';
import { MemoryEvidenceStore } from '../evidence/MemoryEvidenceStore';
import { runSync } from './pipeline';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PAST_THE_GATE = 'pool used: the opt-in gate was passed';
const KEYS = ['RATIO_ALLOW_SYNTHETIC_PROVIDERS', 'RATIO_ENV'] as const;

let saved: Record<string, string | undefined>;
let poolUses: number;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  poolUses = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

const pool = new Proxy({} as Pool, {
  get() {
    poolUses++;
    throw new Error(PAST_THE_GATE);
  },
});

const run = (allowSyntheticProviders?: boolean) =>
  runSync({
    pool,
    tenantId: TENANT,
    sourceKey: 'focus-main',
    source: new FakeFocusSource([]),
    evidence: new MemoryEvidenceStore(),
    mode: 'sync',
    ...(allowSyntheticProviders === undefined ? {} : { settings: { allowSyntheticProviders } }),
  });

describe('F3 runSync cannot enable synthetic providers without the validated opt-in', () => {
  it('explicit true without the opt-in is refused before any I/O', async () => {
    for (const env of [{}, { RATIO_ENV: 'test' }, { RATIO_ENV: 'development', RATIO_ALLOW_SYNTHETIC_PROVIDERS: '0' }, { RATIO_ALLOW_SYNTHETIC_PROVIDERS: '' }]) {
      setEnv(env);
      await expect(run(true), JSON.stringify(env)).rejects.toMatchObject({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' });
    }
    expect(poolUses).toBe(0);
  });

  it('explicit true with RATIO_ENV=production (or staging, or unset) and the opt-in at 1 is refused before any I/O', async () => {
    for (const ratioEnv of ['production', 'staging', undefined]) {
      setEnv({ RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1', ...(ratioEnv ? { RATIO_ENV: ratioEnv } : {}) });
      await expect(run(true), String(ratioEnv)).rejects.toMatchObject({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' });
    }
    expect(poolUses).toBe(0);
  });

  it('explicit false needs no env at all (pure override), even with an invalid or production env', async () => {
    for (const env of [{}, { RATIO_ENV: 'production', RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1' }, { RATIO_ALLOW_SYNTHETIC_PROVIDERS: 'yes' }]) {
      setEnv(env);
      await expect(run(false), JSON.stringify(env)).rejects.toThrow(PAST_THE_GATE);
    }
  });

  it('explicit true with a valid opt-in (RATIO_ENV development or test) is allowed past the gate', async () => {
    for (const ratioEnv of ['development', 'test']) {
      setEnv({ RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1', RATIO_ENV: ratioEnv });
      await expect(run(true), ratioEnv).rejects.toThrow(PAST_THE_GATE);
    }
  });

  it('the default (no setting) follows the validated process opt-in, as before', async () => {
    setEnv({});
    await expect(run()).rejects.toThrow(PAST_THE_GATE);
    setEnv({ RATIO_ALLOW_SYNTHETIC_PROVIDERS: '1', RATIO_ENV: 'production' });
    await expect(run()).rejects.toMatchObject({ code: 'SYNTHETIC_PROVIDERS_NOT_ALLOWED' });
  });
});
