// Release blocker: the simulation routes must refuse on a Vercel production deployment
// (VERCEL_ENV exactly "production"), like the gateway gate, even with the simulation flags set.
// NODE_ENV=production behavior is intentionally unchanged (CI acceptance runs `next start`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { readdirSync } from 'node:fs';
import { simulationEnabled } from './enabled';

afterEach(() => vi.unstubAllEnvs());
const flags = () => { vi.stubEnv('RATIO_SIMULATION', '1'); vi.stubEnv('RATIO_ENV', 'development'); };
const routes = readdirSync('pages/api/v1/simulation').filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, ''));

async function call(route: string, method: string): Promise<{ status: number; body: unknown }> {
  const mod = await import(`../../../pages/api/v1/simulation/${route}.ts`);
  const out = { status: 200, body: undefined as unknown };
  const res = { setHeader() {}, status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
  await mod.default({ method, headers: {}, body: {}, query: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return out;
}

describe('simulation gate', () => {
  it('is on for the documented dev env and off for VERCEL_ENV=production', () => {
    flags();
    expect(simulationEnabled()).toBe(true);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(simulationEnabled()).toBe(false);
  });

  it('keeps VERCEL_ENV=preview and NODE_ENV=production unchanged (documented difference)', () => {
    flags();
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(simulationEnabled()).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(simulationEnabled()).toBe(true);
  });

  it('covers every simulation route file', () => {
    expect(routes.sort()).toEqual(['chat', 'command', 'frank', 'operations', 'report', 'session', 'state', 'status']);
  });

  it.each(['chat', 'command', 'frank', 'operations', 'report', 'session', 'state'])('%s refuses on VERCEL_ENV=production', async (route) => {
    flags();
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await call(route, 'DELETE')).status).toBe(404);
    vi.unstubAllEnvs(); flags();
    expect((await call(route, 'DELETE')).status).not.toBe(404); // enabled: reaches the method or session check
  });

  it('status reports disabled on VERCEL_ENV=production', async () => {
    flags();
    vi.stubEnv('VERCEL_ENV', 'production');
    expect((await call('status', 'GET')).body).toEqual({ enabled: false });
  });
});
