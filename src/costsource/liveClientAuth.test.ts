// M1 — the browser LiveCostSourceClient never carries a token, so once the
// server requires one a live connector answers 401. That must surface as a
// typed, user-readable error, and the /costsource page must show it instead of
// a generic failure.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveCostSourceClient, LiveDataAuthError, LIVE_DATA_AUTH_MESSAGE } from './LiveCostSourceClient';
import { ingestErrorView } from './CostSourcePage';

afterEach(() => {
  vi.unstubAllGlobals();
});

const WINDOW = { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' };

describe('M1 — LiveCostSourceClient surfaces a 401 as a typed auth error', () => {
  it('fetchCostRows rejects with LiveDataAuthError and a readable message, sending no Authorization header', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'Missing Authorization' }, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await new LiveCostSourceClient().fetchCostRows('focus-endpoint', WINDOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveDataAuthError);
    expect((err as Error).message).toBe('Live connector data requires authenticated API access');
    expect(LIVE_DATA_AUTH_MESSAGE).toBe('Live connector data requires authenticated API access');
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
  });

  it('healthCheck rejects with LiveDataAuthError on 401 too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(new LiveCostSourceClient().healthCheck('focus-endpoint')).rejects.toBeInstanceOf(LiveDataAuthError);
  });

  it('other failures keep their generic error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const err = await new LiveCostSourceClient().healthCheck('focus-endpoint').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(LiveDataAuthError);
    expect((err as Error).message).toMatch(/error 500/);
  });

  it('the /costsource page shows the auth message instead of a generic failure', () => {
    const view = ingestErrorView(new LiveDataAuthError());
    expect(view.title).not.toBe('Ingest failed');
    expect(view.message).toBe('Live connector data requires authenticated API access');
    expect(ingestErrorView(new Error('boom'))).toEqual({ title: 'Ingest failed', message: 'boom' });
  });
});
