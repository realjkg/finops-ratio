// /api/v1/finio/export: the `invalid_focus_export` 500 carries a requestId (body
// + X-Request-Id) from the shared helper, keeps its code, and does not return
// the validator's per-row detail (that goes to the server log).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('./focusValidation', async (orig) => ({
  ...(await orig<typeof import('./focusValidation')>()),
  validateFocusRows: vi.fn(() => ({ ok: false, errors: ['row 3: ROWDETAIL-MARKER BilledCost missing'] })),
}));

afterEach(() => vi.restoreAllMocks());

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = String(v);
    },
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(p: unknown) {
      res.body = p;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

describe('invalid_focus_export 500', () => {
  it('has code invalid_focus_export, a fixed message, requestId and X-Request-Id', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createSession } = await import('./sessionStore');
    const { default: handler } = await import('../../pages/api/v1/finio/export');
    const session = createSession('1.4');
    const res = makeRes();
    await handler(
      {
        method: 'GET',
        url: '/api/v1/finio/export',
        headers: { 'x-finio-session': session.sessionId, 'x-forwarded-for': '192.0.2.77' },
        query: {},
      } as unknown as NextApiRequest,
      res as unknown as NextApiResponse,
    );
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('invalid_focus_export');
    expect(body.error.message).toBe('Refusing to emit non-conformant FOCUS rows');
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
    expect(JSON.stringify(res.body)).not.toContain('ROWDETAIL-MARKER');
    const log = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(log).toContain('ROWDETAIL-MARKER');
    expect(log).toContain(body.error.requestId);
  });
});
