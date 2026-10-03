// M2 — sourcesForEnv(env) is a pure function of `env`: the generic FOCUS
// endpoint descriptor must never be built from process.env captured at module
// init when a caller supplies a different env (e.g. the client render's `{}`).

import { describe, expect, it, vi } from 'vitest';

describe('M2 — sourcesForEnv is pure over the supplied env', () => {
  const KEYS = ['FOCUS_ENDPOINT_NAME', 'FOCUS_ENDPOINT_COVERAGE', 'FOCUS_ENDPOINT_FOCUS_VERSION'] as const;

  it('sourcesForEnv({}) never reflects FOCUS_ENDPOINT_* set in process.env', async () => {
    const saved = KEYS.map((k) => process.env[k]);
    process.env.FOCUS_ENDPOINT_NAME = 'Leaky VMware';
    process.env.FOCUS_ENDPOINT_COVERAGE = 'private_cloud';
    process.env.FOCUS_ENDPOINT_FOCUS_VERSION = '1.3';
    try {
      vi.resetModules();
      const { sourcesForEnv } = await import('./seed');
      const endpoint = sourcesForEnv({}).find((s) => s.id === 'focus-endpoint');
      expect(endpoint?.name).toBe('FOCUS endpoint (any on-prem / private / public source)');
      expect(endpoint?.name).not.toContain('Leaky');
      expect(endpoint?.coverage).toBe('on_prem');
      expect(endpoint?.focusVersion).toBe('1.0');

      const fromEnv = sourcesForEnv({
        FOCUS_ENDPOINT_NAME: 'OpenStack',
        FOCUS_ENDPOINT_COVERAGE: 'private_cloud',
        FOCUS_ENDPOINT_FOCUS_VERSION: '1.2',
      }).find((s) => s.id === 'focus-endpoint');
      expect(fromEnv?.name).toBe('OpenStack (FOCUS endpoint)');
      expect(fromEnv?.coverage).toBe('private_cloud');
      expect(fromEnv?.focusVersion).toBe('1.2');
    } finally {
      KEYS.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });
});
