// The simulation capability probe — the demo-mode door. It must answer on every
// deployment and never depend on the sqlite-backed database module (which cannot
// load where node:sqlite is absent). The handler is called directly with mocked
// req/res; nothing listens on a port.
//
// The database mock throws on import: if any module in the status route's import
// chain ever reaches the sqlite-backed database, every test here fails loudly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/simulation/server/database', () => {
  throw new Error('The status route must not import the sqlite-backed database module.');
});

let savedSim: string | undefined;
let savedEnv: string | undefined;
beforeEach(() => {
  savedSim = process.env.RATIO_SIMULATION;
  savedEnv = process.env.RATIO_ENV;
  delete process.env.RATIO_SIMULATION;
  delete process.env.RATIO_ENV;
  vi.resetModules();
});
afterEach(() => {
  if (savedSim === undefined) delete process.env.RATIO_SIMULATION; else process.env.RATIO_SIMULATION = savedSim;
  if (savedEnv === undefined) delete process.env.RATIO_ENV; else process.env.RATIO_ENV = savedEnv;
});

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { res.headers[k.toLowerCase()] = v; },
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

async function callStatus(method = 'GET') {
  const { default: handler } = await import('../../../pages/api/v1/simulation/status');
  const res = makeRes();
  await handler({ method } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

describe('/api/v1/simulation/status — capability probe', () => {
  it('reports disabled in a demo deployment (no simulation env)', async () => {
    const res = await callStatus();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports enabled when the deployment gate is satisfied', async () => {
    process.env.RATIO_SIMULATION = '1';
    process.env.RATIO_ENV = 'development';
    const res = await callStatus();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('refuses methods other than GET', async () => {
    const res = await callStatus('POST');
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET');
  });
});
