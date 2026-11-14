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
    expect(sent).toHaveLength(MAX_MESSAGES);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'Latest question' });
    spy.mockRestore();
  });
});
