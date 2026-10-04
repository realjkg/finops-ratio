// Test-only fake Next.js req/res for the published-costs route (no server, no
// network). Mirrors the helpers of src/server/nonGatewayRoutes.test.ts.
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

export type TestRes = NextApiResponse & { statusCode: number; body: unknown; headers: Record<string, string> };

export function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    headersSent: false,
    setHeader(k: string, v: string | number) {
      res.headers[k.toLowerCase()] = String(v);
    },
    getHeader(k: string) {
      return res.headers[k.toLowerCase()];
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    send(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    end() {
      res.headersSent = true;
      return res;
    },
  };
  return res as unknown as TestRes;
}

export function makeReq(
  opts: { method?: string; query?: Record<string, string | string[]>; headers?: Record<string, string>; remoteAddress?: string } = {},
): NextApiRequest {
  return {
    method: opts.method ?? 'GET',
    url: '/api/v1/costs/published',
    query: opts.query ?? {},
    body: undefined,
    headers: { ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
  } as unknown as NextApiRequest;
}

export async function call(handler: NextApiHandler, req: NextApiRequest): Promise<TestRes> {
  const res = makeRes();
  await handler(req, res);
  return res;
}

/** A strong API token for tests (>= 32 chars, >= 10 distinct). Not a real secret. */
export const TEST_API_TOKEN = 'ratio-test-reader-api-token-0123456789-ABCDEFGH';
export const bearer = (token: string = TEST_API_TOKEN) => ({ authorization: `Bearer ${token}` });
