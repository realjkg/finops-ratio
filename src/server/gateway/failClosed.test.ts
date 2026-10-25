// P11: protected operations fail closed by default. A missing token, a missing
// identity configuration or a failing auth check is a refusal, never anonymous
// or simulated access. A local simulation mode exists only when deliberately
// enabled (RATIO_SIMULATION=1 with RATIO_ENV development or test), and never
// as the automatic answer to an auth outage. Synthetic fixtures only.

import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withGateway } from './withGateway';
import { SlidingWindowRateLimiter } from './rateLimit';
import { checkAuth, resolveGatewayAuth, type GatewayEnv } from './auth';
import { checkPeerToken, resolveFinioPeerAuth } from '@/finio/config';

const SIM = { RATIO_SIMULATION: '1', RATIO_ENV: 'test' } as const;

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    setHeader() {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: { error?: { code: string } } };
}

async function call(env: GatewayEnv, headers: Record<string, string> = {}) {
  const handler = vi.fn((_req: NextApiRequest, res: NextApiResponse, ctx: { tenant: string }) => {
    res.status(200).json({ tenant: ctx.tenant });
  });
  const guarded = withGateway(handler, { env, logger: () => {}, limiter: new SlidingWindowRateLimiter() });
  const res = makeRes();
  await guarded({ method: 'POST', url: '/api/v1/ai/chat', headers, body: {} } as unknown as NextApiRequest, res);
  return { res, handler };
}

describe('default is fail closed', () => {
  it('refuses an unauthenticated request with an empty environment and never runs the handler', async () => {
    const { res, handler } = await call({});
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('resolves to enforcement with no token and no provider', () => {
    expect(resolveGatewayAuth({}).enforce).toBe(true);
    expect(checkAuth(undefined, resolveGatewayAuth({})).ok).toBe(false);
  });

  it('a mock IdP flag alone does not switch to simulation (an outage is not a mode)', async () => {
    const { res, handler } = await call({ RATIO_MOCK_IDP: '1', RATIO_ENV: 'test' } as GatewayEnv);
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('the FinIO peer check refuses when no peer token is configured', () => {
    expect(checkPeerToken(null, resolveFinioPeerAuth({})).ok).toBe(false);
  });
});

describe('auth service failure', () => {
  it('denies with 503 and never runs the handler when resolving auth throws', async () => {
    const env = {
      get RATIO_API_TOKEN(): string {
        throw new Error('identity configuration unavailable');
      },
    } as GatewayEnv;
    const { res, handler } = await call(env);
    expect(res.statusCode).toBe(503);
    expect(res.body.error?.code).toBe('auth_unavailable');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('explicit simulation mode', () => {
  it('serves the fixture-only path when deliberately enabled, labeled as simulation', async () => {
    const { res, handler } = await call({ ...SIM });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ tenant: 'simulation' });
  });

  it.each([
    ['production', '1'],
    ['staging', '1'],
    ['Test', '1'],
    [' test', '1'],
    ['', '1'],
    ['test', 'true'],
    ['test', ' 1'],
  ])('is off for RATIO_ENV=%j RATIO_SIMULATION=%j', async (ratioEnv, flag) => {
    const { res, handler } = await call({ RATIO_ENV: ratioEnv, RATIO_SIMULATION: flag } as GatewayEnv);
    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('is off when RATIO_ENV is unset', async () => {
    expect((await call({ RATIO_SIMULATION: '1' })).res.statusCode).toBe(401);
  });

  it.each([{ AI_PROVIDER: 'claude' }, { CM_PROVIDER: 'jira' }, { CM_PROVIDER: 'servicenow' }])(
    'cannot reach a live provider: %j still requires a token',
    async (extra) => {
      const { res, handler } = await call({ ...SIM, ...extra } as GatewayEnv);
      expect(res.statusCode).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('a configured token is still enforced inside simulation mode', async () => {
    const env = { ...SIM, RATIO_API_TOKEN: 'a'.repeat(8) } as GatewayEnv;
    expect((await call(env)).res.statusCode).toBe(401);
    expect((await call(env, { authorization: `Bearer ${'a'.repeat(8)}` })).res.statusCode).toBe(200);
  });

  it('the FinIO peer check passes only in explicit simulation mode', () => {
    expect(checkPeerToken(null, resolveFinioPeerAuth({ ...SIM })).ok).toBe(true);
    expect(checkPeerToken(null, resolveFinioPeerAuth({ RATIO_ENV: 'production', RATIO_SIMULATION: '1' })).ok).toBe(false);
  });
});
