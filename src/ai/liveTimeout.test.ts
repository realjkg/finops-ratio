// A live chat exchange (headers and body) is abandoned at CHAT_TIMEOUT_MS with a clear message, so a
// hung provider never leaves the panel waiting. The fetch double stays pending until the signal the
// client passed aborts, so these tests fail if no deadline is set or the signal never fires.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_TIMEOUT_MS, LiveAIClient } from './LiveAIClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An AbortSignal.timeout stand-in the test fires by hand, recording the requested deadline. */
function controlledTimeout() {
  const controller = new AbortController();
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => controller.signal);
  return { spy, fire: () => controller.abort(new DOMException('signal timed out', 'TimeoutError')) };
}
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));
const ask = () => new LiveAIClient().chat([{ role: 'user', content: 'hi' }], { focusInitiativeId: null } as never);

describe('LiveAIClient timeout', () => {
  it('the request uses a CHAT_TIMEOUT_MS deadline and waits for it; when it fires, the user is told it timed out', async () => {
    const { spy, fire } = controlledTimeout();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => untilAborted(init.signal!)));
    let settled = false;
    const p = ask().finally(() => { settled = true; });
    p.catch(() => {});
    await flush();
    expect(spy).toHaveBeenCalledWith(CHAT_TIMEOUT_MS);
    expect(CHAT_TIMEOUT_MS).toBe(90_000);
    expect(settled).toBe(false); // still waiting before the deadline
    fire();
    await expect(p).rejects.toThrow('AI chat timed out after 90 seconds. Ask again.');
  });

  it('a body that stalls past the deadline is a timeout, not an invalid response', async () => {
    const { fire } = controlledTimeout();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, status: 200, text: () => untilAborted(init.signal!) }) as unknown as Response));
    const p = ask();
    p.catch(() => {});
    await flush();
    fire();
    await expect(p).rejects.toThrow('AI chat timed out after 90 seconds. Ask again.');
  });

  it('an error response whose body stalls past the deadline is a timeout too', async () => {
    const { fire } = controlledTimeout();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({ ok: false, status: 502, statusText: 'Bad Gateway', headers: new Headers(), text: () => untilAborted(init.signal!), json: () => untilAborted(init.signal!) }) as unknown as Response));
    const p = ask();
    p.catch(() => {});
    await flush();
    fire();
    await expect(p).rejects.toThrow('AI chat timed out after 90 seconds. Ask again.');
  });

  it('other network failures keep their message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(ask()).rejects.toThrow('AI chat unreachable: Failed to fetch');
  });
});
