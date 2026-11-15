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

describe('round 4: cutting, failed questions, focus bytes and the simulation limit', () => {
  it('a reply that is blank after cutting is left out (cut first, then drop blanks)', async () => {
    const { fitHistory, MAX_MESSAGE_CHARS } = await import('@/ai');
    const out = fitHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: ' '.repeat(MAX_MESSAGE_CHARS) + 'tail' }, { role: 'user', content: 'b' }]);
    expect(out).toEqual([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  });

  it('the extra fields count against the byte budget: a history that fits only without them loses a turn', async () => {
    const { fitHistory, MAX_REQUEST_BYTES } = await import('@/ai');
    const { requestBytes } = await import('@/ai/limits');
    const focus = { focusInitiativeId: 'f'.repeat(64) };
    // Pad the first turn so the history alone is 20 bytes under the budget; the focus field pushes it over.
    const tail = Array.from({ length: 10 }, (_, n) => ({ role: (n % 2 ? 'user' : 'assistant') as 'user' | 'assistant', content: 'r'.repeat(9_000) }));
    const base = requestBytes({ messages: [{ role: 'user', content: '' }, ...tail] });
    const turns = [{ role: 'user' as const, content: 'q'.repeat(MAX_REQUEST_BYTES - 20 - base) }, ...tail];
    expect(requestBytes({ messages: turns })).toBe(MAX_REQUEST_BYTES - 20);
    expect(fitHistory(turns)).toHaveLength(turns.length);
    const out = fitHistory(turns, focus);
    expect(out.length).toBeLessThan(turns.length);
    expect(requestBytes({ messages: out, ...focus })).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  });

  it('a cut never splits an emoji (a lone surrogate half)', async () => {
    const { capChars, fitHistory, MAX_MESSAGE_CHARS } = await import('@/ai');
    const s = 'y'.repeat(MAX_MESSAGE_CHARS - 1) + '\u{1F600}tail';
    expect(capChars(s)).toBe('y'.repeat(MAX_MESSAGE_CHARS - 1));
    expect(capChars(s).isWellFormed()).toBe(true);
    expect(fitHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: s }, { role: 'user', content: 'b' }])[1].content.isWellFormed()).toBe(true);
  });

  it('a user turn followed by a notice that is not an error is still resent', async () => {
    const { MockAIClient } = await import('@/ai');
    const spy = vi.spyOn(MockAIClient.prototype, 'chat');
    useStore.setState({
      aiMessages: [
        { id: 'u1', role: 'user', content: 'kept question', timestamp: 't' },
        { id: 's1', role: 'system', content: 'Message not sent: it is 12,000 characters long', timestamp: 't' },
      ],
      aiThinking: false,
      simulation: null,
    });
    const p = useStore.getState().sendAIMessage('Next question');
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(spy.mock.calls[0][0]).toEqual([{ role: 'user', content: 'kept question' }, { role: 'user', content: 'Next question' }]);
    spy.mockRestore();
  });

  it('one question at a time: a send while a turn is in flight is ignored', async () => {
    const { MockAIClient } = await import('@/ai');
    const spy = vi.spyOn(MockAIClient.prototype, 'chat');
    useStore.setState({ aiMessages: [], aiThinking: true, simulation: null });
    void useStore.getState().sendAIMessage('overlapping question'); // not awaited: the guard must act synchronously
    expect(useStore.getState().aiMessages).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    useStore.setState({ aiThinking: false });
  });

  it('loadSimulation: a new session clears aiThinking (A to B too); the same session keeps it either way', () => {
    const state = { workloads: [], budgets: [], alerts: [], asOf: '2026-06-25T00:00:00.000Z' } as never;
    const load = (csrf: string) => useStore.getState().loadSimulation({ csrf } as never, state);
    useStore.setState({ aiThinking: true, simulation: null, aiMessages: [] });
    load('A');
    expect(useStore.getState().aiThinking).toBe(false); // none -> A
    useStore.setState({ aiThinking: true });
    load('A');
    expect(useStore.getState().aiThinking).toBe(true); // same session: an in-flight answer still holds the panel
    useStore.setState({ aiThinking: false });
    load('A');
    expect(useStore.getState().aiThinking).toBe(false); // same session, idle: stays idle (no lock after a command)
    useStore.setState({ aiThinking: true });
    load('B');
    expect(useStore.getState().aiThinking).toBe(false); // A -> B
    useStore.setState({ aiThinking: false, simulation: null, aiMessages: [] });
  });

  it('an answer whose conversation was reset never lands in the new one (failed sign-in, no session)', async () => {
    useStore.setState({ aiMessages: [], aiThinking: false, simulation: null });
    const q1 = useStore.getState().sendAIMessage('first question');
    useStore.getState().clearSimulation(); // e.g. a failed sign-in: no session before or after
    const q2 = useStore.getState().sendAIMessage('second question');
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([q1, q2]);
    const msgs = useStore.getState().aiMessages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0].content).toBe('second question');
  });

  it('a question dropped by a session change gets a notice instead of silence', async () => {
    const state = { workloads: [], budgets: [], alerts: [], asOf: '2026-06-25T00:00:00.000Z' } as never;
    useStore.setState({ aiMessages: [], aiThinking: false, simulation: null });
    const q = useStore.getState().sendAIMessage('which initiative is riskiest?');
    useStore.getState().loadSimulation({ csrf: 'restored' } as never, state); // a saved session is restored mid-answer
    await vi.advanceTimersByTimeAsync(1_000);
    await q;
    const msgs = useStore.getState().aiMessages;
    expect(msgs.at(-1)).toMatchObject({ role: 'system', content: expect.stringContaining('not answered because the session changed') });
    expect(msgs.some((m) => m.role === 'assistant')).toBe(false);
    expect(useStore.getState().aiThinking).toBe(false);
    useStore.setState({ simulation: null, aiMessages: [] });
  });

  it('a question that failed is not resent with the next one', async () => {
    const { MockAIClient } = await import('@/ai');
    const spy = vi.spyOn(MockAIClient.prototype, 'chat');
    useStore.setState({
      aiMessages: [
        { id: 'u1', role: 'user', content: 'rejected question', timestamp: 't' },
        { id: 's1', role: 'system', content: 'AI error: provider refused', timestamp: 't' },
      ],
      aiThinking: false,
      simulation: null,
    });
    const p = useStore.getState().sendAIMessage('Next question');
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(spy.mock.calls[0][0]).toEqual([{ role: 'user', content: 'Next question' }]);
    spy.mockRestore();
  });

  it('simulation mode refuses a question over its 2,000-character limit with that number', async () => {
    useStore.setState({ aiMessages: [], aiThinking: false, simulation: { session: { csrf: 'c' }, state: {} } as never });
    await useStore.getState().sendAIMessage('z'.repeat(2_001));
    expect(useStore.getState().aiMessages.at(-1)?.content).toContain('the limit is 2,000 characters');
    useStore.setState({ simulation: null });
  });
});
