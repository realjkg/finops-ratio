// Test helper: drives the PUBLIC MockAIClient.chat with a fake clock (the
// client waits 280 ms for UX) and builds real multi-turn histories out of the
// mock's own previous replies, exactly as the drawer does.

import { vi } from 'vitest';
import { buildAIContext } from '@/ai/buildAIContext';
import type { AIContext, AIMessage } from '@/ai/AIClient';
import { MockAIClient } from '@/ai/MockAIClient';
import { WORKLOADS } from '@/data/workloads';

export const CTX: AIContext = buildAIContext(WORKLOADS);
export const BASIS = /seeded demo data/;

export function useFastClock(): void {
  vi.useFakeTimers();
}
export function restoreClock(): void {
  vi.useRealTimers();
}

const client = new MockAIClient();

export async function chat(
  messages: AIMessage[],
  ctx: AIContext = CTX,
): Promise<{ text: string; referenced: string[]; provider: string }> {
  const p = client.chat(messages, ctx);
  await vi.advanceTimersByTimeAsync(300);
  const r = await p;
  return { text: r.message.content, referenced: r.initiativesReferenced, provider: r.provider };
}

/** Ask turns in order; each reply joins the history. Returns every reply. */
export async function ask(turns: string[], ctx: AIContext = CTX): Promise<string[]> {
  const history: AIMessage[] = [];
  const replies: string[] = [];
  for (const t of turns) {
    history.push({ role: 'user', content: t });
    const { text } = await chat(history, ctx);
    history.push({ role: 'assistant', content: text });
    replies.push(text);
  }
  return replies;
}

export async function last(turns: string[], ctx: AIContext = CTX): Promise<string> {
  const r = await ask(turns, ctx);
  return r[r.length - 1];
}

/** The "Next questions:" bullets of an answer, unquoted. */
export function nextQuestions(text: string): string[] {
  const idx = text.lastIndexOf('Next questions:');
  if (idx < 0) return [];
  return text
    .slice(idx)
    .split('\n')
    .map((l) => /^• "(.+)"$/.exec(l.trim())?.[1])
    .filter((q): q is string => Boolean(q));
}

export const UNSUPPORTED = "I can't answer that from the seeded data";
export const CLARIFY = 'Which one do you mean?';
