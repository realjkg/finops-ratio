// A live chat request that hangs is abandoned after CHAT_TIMEOUT_MS with a clear message, so the
// panel's thinking state always ends (the store's catch turns this into an inline error notice).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_TIMEOUT_MS, LiveAIClient } from './LiveAIClient';

afterEach(() => vi.unstubAllGlobals());

describe('LiveAIClient timeout', () => {
  it('passes an abort signal and reports a timeout in plain words', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new LiveAIClient().chat([{ role: 'user', content: 'hi' }], { focusInitiativeId: null } as never))
      .rejects.toThrow(`AI chat timed out after ${CHAT_TIMEOUT_MS / 1000} seconds. Ask again.`);
  });
  it('other network failures keep their message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(new LiveAIClient().chat([{ role: 'user', content: 'hi' }], { focusInitiativeId: null } as never))
      .rejects.toThrow('AI chat unreachable: Failed to fetch');
  });
});
