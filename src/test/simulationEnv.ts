// Test helper (P11): the explicit local simulation mode that replaced the old
// "no token means open" default. Tests that exercise a protected route's
// handler without credentials opt in here, visibly, instead of relying on an
// implicit bypass.
import { afterEach, beforeEach, vi } from 'vitest';

export const SIMULATION_ENV = Object.freeze({ RATIO_SIMULATION: '1', RATIO_ENV: 'test' });

/** Enable simulation mode for every test in the calling file via process.env. */
export function enableSimulationEnv(): void {
  beforeEach(() => {
    vi.stubEnv('RATIO_SIMULATION', '1');
    vi.stubEnv('RATIO_ENV', 'test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}
