// /api/report/snapshot: a render failure returns the fixed generic 500
// ({ error: "Internal error", requestId } + X-Request-Id) — never the thrown
// message, which goes to the redacted server log only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('./reportPdf', () => ({
  renderReportPdf: vi.fn(async () => {
    throw new Error('PDF-RENDER-DETAIL Bearer abc.def.SECRETTOKEN99');
  }),
}));

afterEach(() => vi.restoreAllMocks());

describe('/api/report/snapshot internal error', () => {
  it('returns the generic 500 and logs the redacted detail', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: handler } = await import('../../pages/api/report/snapshot');
    const captured = { statusCode: 0, headers: {} as Record<string, string>, body: undefined as unknown };
    const res = {
      headersSent: false,
      setHeader(k: string, v: string) {
        captured.headers[k.toLowerCase()] = String(v);
      },
      status(code: number) {
        captured.statusCode = code;
        return res;
      },
      json(p: unknown) {
        captured.body = p;
        res.headersSent = true;
        return res;
      },
      send(p: unknown) {
        captured.body = p;
        res.headersSent = true;
        return res;
      },
    };
    await handler(
      { method: 'GET', url: '/api/report/snapshot', query: { format: 'pdf' }, headers: {} } as unknown as NextApiRequest,
      res as unknown as NextApiResponse,
    );
    expect(captured.statusCode).toBe(500);
    const body = captured.body as { error: string; requestId: string };
    expect(body).toEqual({ error: 'Internal error', requestId: expect.any(String) });
    expect(captured.headers['x-request-id']).toBe(body.requestId);
    expect(JSON.stringify(body)).not.toContain('PDF-RENDER-DETAIL');
    const log = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(log).toContain('PDF-RENDER-DETAIL');
    expect(log).toContain(body.requestId);
    expect(log).not.toContain('SECRETTOKEN99');
  });
});
