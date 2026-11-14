// The chat route rejects a message over MAX_MESSAGE_CHARS. The panel must not put such a turn into
// the history it resends on every later turn, or one long paste would make every later question a 400.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_CHARS } from '@/ai/limits';
import { useStore } from './useStore';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('an over-long message never enters the chat history', () => {
  it('is refused with a notice naming the limit; the next question still works', async () => {
    useStore.setState({ aiMessages: [], aiThinking: false, simulation: null });
    await useStore.getState().sendAIMessage('x'.repeat(MAX_MESSAGE_CHARS + 1));
    const after = useStore.getState().aiMessages;
    expect(after.some((m) => m.role === 'user')).toBe(false);
    expect(after.at(-1)?.role).toBe('system');
    expect(after.at(-1)?.content).toContain('10,000 characters');
    expect(useStore.getState().aiThinking).toBe(false);

    const p = useStore.getState().sendAIMessage('Which initiatives are at risk?');
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(useStore.getState().aiMessages.at(-1)?.role).toBe('assistant');
  });

  it('a message at exactly the limit is sent', async () => {
    useStore.setState({ aiMessages: [], aiThinking: false, simulation: null });
    const p = useStore.getState().sendAIMessage('y'.repeat(MAX_MESSAGE_CHARS));
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(useStore.getState().aiMessages.some((m) => m.role === 'user')).toBe(true);
  });
});

describe('a long conversation stays within the route turn limit', () => {
  it('sends at most MAX_MESSAGES turns, ending with the new question', async () => {
    const { MAX_MESSAGES } = await import('@/ai/limits');
    const { MockAIClient } = await import('@/ai');
    const spy = vi.spyOn(MockAIClient.prototype, 'chat');
    const old = Array.from({ length: 60 }, (_, n) => ({
      id: `m${n}`, role: (n % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `turn ${n}`, timestamp: '2026-01-01T00:00:00Z',
    }));
    useStore.setState({ aiMessages: old, aiThinking: false, simulation: null });
    const p = useStore.getState().sendAIMessage('Latest question');
    await vi.advanceTimersByTimeAsync(400);
    await p;
    const sent = spy.mock.calls[0][0];
    // The last 50 turns start with an assistant reply, which is dropped too: the history opens with a user turn.
    expect(sent.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(sent).toHaveLength(MAX_MESSAGES - 1);
    expect(sent[0].role).toBe('user');
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'Latest question' });
    spy.mockRestore();
  });
});

describe('the history sent always fits the route (review H1)', () => {
  it('long multi-byte turns: the oldest are dropped until the body fits; the new question is last', async () => {
    const { MockAIClient, MAX_REQUEST_BYTES } = await import('@/ai');
    const { requestBytes } = await import('@/ai/limits');
    const spy = vi.spyOn(MockAIClient.prototype, 'chat');
    const long = '費'.repeat(10_000);
    const old = Array.from({ length: 10 }, (_, n) => ({
      id: `b${n}`, role: (n % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: n % 2 ? 'ok' : long, timestamp: '2026-01-01T00:00:00Z',
    }));
    useStore.setState({ aiMessages: old, aiThinking: false, simulation: null });
    const p = useStore.getState().sendAIMessage('Latest question');
    await vi.advanceTimersByTimeAsync(400);
    await p;
    const sent = spy.mock.calls[0][0];
    expect(requestBytes({ messages: sent, focusInitiativeId: null })).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(sent.length).toBeLessThan(11);
    expect(sent[0].role).toBe('user');
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'Latest question' });
    spy.mockRestore();
  });

  it('an over-long or empty assistant reply is trimmed or left out, never sent as is', async () => {
    const { fitHistory, MAX_MESSAGE_CHARS } = await import('@/ai');
    const out = fitHistory([
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'z'.repeat(MAX_MESSAGE_CHARS + 50) },
      { role: 'user', content: 'b' }, { role: 'assistant', content: '  ' }, { role: 'user', content: 'c' },
    ]);
    expect(out.map((t) => t.content.length)).toEqual([1, MAX_MESSAGE_CHARS, 1, 1]);
    expect(out.at(-1)).toEqual({ role: 'user', content: 'c' });
  });
});
