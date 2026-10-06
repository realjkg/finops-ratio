import { describe, expect, it, vi, afterEach } from 'vitest';
import { requireCsrf, simulationEnabled, sameOrigin } from './http';
import type { NextApiRequest } from 'next';
import { executeCommand, seedWorkspace } from './workflow';
const session = { identity: { tenant: 'acme', user: 'a', persona: 'technical' as const }, csrf: 'a'.repeat(64), expiresAt: Date.now() + 1000 };
const req = (origin: string, token: string) => ({ headers: { origin, 'x-ratio-csrf': token } }) as unknown as NextApiRequest;
afterEach(() => vi.unstubAllEnvs());
describe('simulated authorization boundaries', () => {
 it('refuses a production environment even with simulation flag enabled', () => {
   vi.stubEnv('RATIO_SIMULATION', '1'); vi.stubEnv('RATIO_ENV', 'production');
   expect(simulationEnabled()).toBe(false); vi.stubEnv('RATIO_ENV', 'test'); expect(simulationEnabled()).toBe(true);
 });
 it('requires same origin and session CSRF token including byte-safe non-ASCII handling', () => {
   vi.stubEnv('RATIO_SIMULATION_ORIGIN', 'http://localhost:3000');
   expect(() => requireCsrf(req('http://localhost:3000', session.csrf), session)).not.toThrow();
   expect(() => requireCsrf(req('https://attacker.invalid', session.csrf), session)).toThrow();
   expect(() => requireCsrf(req('http://localhost:3000', 'b'.repeat(64)), session)).toThrow();
   expect(() => requireCsrf(req('http://localhost:3000', 'é'.repeat(64)), session)).toThrow(/verification/);
   expect(() => sameOrigin(req('', session.csrf))).toThrow();
 });
 it('blocks direct role and governance bypasses', () => {
   const s = seedWorkspace(); const workloadId = s.workloads[0].id;
   expect(() => executeCommand(s, session.identity, { type: 'budget', workloadId, amount: 2 })).toThrow(/permission/);
   expect(() => executeCommand(s, session.identity, { type: 'gate', workloadId, gate: 'scale' })).toThrow(/permission/);
   const locked = structuredClone(s); Object.assign(locked.workloads[0].governance, { policy_check: false, ethics_review: false, cost_approval: false, scale_authorized: false });
   expect(() => executeCommand(locked, session.identity, { type: 'shape', workloadId, shape: 'always_on' })).toThrow(/four gates/);
 });
});
