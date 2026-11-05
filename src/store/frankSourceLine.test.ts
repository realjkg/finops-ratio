// Review Low (c): every mock Frank answer shown in the panel names its source, the four quick prompts and
// the legacy answers included. The legacy texts stay byte-identical in the API response (contract golden);
// the panel adds the one provenance line when an answer lacks it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_PROMPTS } from '@/components/ai/ChatQuickPrompts';
import { DEMO_PROMPTS } from '@/ai/MockAIClient';
import { useStore } from './useStore';

const SOURCE = /^Source: demo dataset as of \d{4}-\d{2}-\d{2} — computed by a deterministic mock \(no LLM, nothing live\)\.$/m;

async function ask(q: string): Promise<string> {
  useStore.setState({ aiMessages: [], aiThinking: false, simulation: null });
  const p = useStore.getState().sendAIMessage(q);
  await vi.advanceTimersByTimeAsync(400);
  await p;
  const last = useStore.getState().aiMessages.at(-1)!;
  expect(last.role, q).toBe('assistant');
  return last.content;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Frank answers in the panel name their source', () => {
  it.each([...QUICK_PROMPTS, ...DEMO_PROMPTS, 'hello', 'What can you answer?', 'tell me a joke', 'Which initiatives are at risk?'])('%s', async (q) => {
    const text = await ask(q);
    expect(text, q).toMatch(SOURCE);
    expect(text.match(new RegExp(SOURCE.source, 'gm'))?.length, `${q}: once`).toBe(1);
  });
});
