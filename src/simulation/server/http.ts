import { AGENT_POLICY } from '@/agent-workflows/policy';
import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { SimIdentity, SimSession } from '../types';
import { database } from './database';
import { simulationEnabled } from './enabled';
import { WorkflowError } from './workflow';

export const IDENTITIES: Record<string, SimIdentity> = {
  'acme-executive': { tenant: 'acme', user: 'Morgan (simulated)', persona: 'executive' },
  'acme-technical': { tenant: 'acme', user: 'Alex (simulated)', persona: 'technical' },
  'acme-procurement': { tenant: 'acme', user: 'Jordan (simulated)', persona: 'procurement' },
  'northstar-executive': { tenant: 'northstar', user: 'Casey (simulated)', persona: 'executive' },
  'northstar-technical': { tenant: 'northstar', user: 'Sam (simulated)', persona: 'technical' },
  'northstar-procurement': { tenant: 'northstar', user: 'Taylor (simulated)', persona: 'procurement' },
};
const COOKIE = 'ratio_simulation';
export { simulationEnabled } from './enabled';
export function tokenFrom(req: NextApiRequest): string { return req.cookies?.[COOKIE] ?? ''; }
export function setCookie(res: NextApiResponse, token: string): void {
  const secure = (process.env.RATIO_SIMULATION_ORIGIN ?? '').startsWith('https://');
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 3600 : 0}${secure ? '; Secure' : ''}`);
}
export function sessionFor(req: NextApiRequest): SimSession {
  const session = database().session(tokenFrom(req));
  if (!session) throw new WorkflowError(401, 'Your simulation session ended. Sign in again to continue.');
  if (!database().consumeRequest(session.identity.tenant, AGENT_POLICY.requestsPerMinute)) throw new WorkflowError(429, 'Simulation request limit reached. Wait until the next minute before retrying.');
  return session;
}
export function sameOrigin(req: NextApiRequest): void {
  const expected = process.env.RATIO_SIMULATION_ORIGIN ?? 'http://localhost:3000';
  if (req.headers.origin !== expected) throw new WorkflowError(403, 'This action requires the configured simulation origin.');
}
export function requireCsrf(req: NextApiRequest, session: SimSession): void {
  sameOrigin(req);
  const supplied = req.headers['x-ratio-csrf'];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))) {
    throw new WorkflowError(403, 'Session verification failed. Reload and try again.');
  }
}
export function simulationRoute(methods: string[], handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void) {
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    const requestId = randomUUID();
    const started = Date.now();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!simulationEnabled()) { res.status(404).json({ error: 'Customer simulation is not enabled on this deployment.' }); return; }
    if (!methods.includes(req.method ?? '')) { res.setHeader('Allow', methods.join(', ')); res.status(405).json({ error: 'Method not allowed.' }); return; }
    try { await handler(req, res); }
    catch (e) {
      if (e instanceof WorkflowError && e.status === 429) res.setHeader('Retry-After', String(60 - Math.floor(Date.now() / 1000) % 60));
      res.status(e instanceof WorkflowError ? e.status : 500).json({ error: e instanceof WorkflowError ? e.message : 'Simulation storage or processing failed. Retry after checking the local service.' });
    } finally {
      console.info(JSON.stringify({ event: 'simulation_request', requestId, method: req.method, status: res.statusCode, durationMs: Date.now() - started }));
    }
  };
}
