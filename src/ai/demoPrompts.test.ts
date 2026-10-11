// A8: every suggested /demo prompt must get a real mock Frank answer (not the
// help text, the "cannot answer" reply, or a clarifying question), and the
// prompts the help text itself offers must each reach a different answer path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PROMPTS } from '@/ai/MockAIClient';
import { classifyIntent, classifyLegacy } from '@/ai/mock/intents';
import { help } from '@/ai/mock/legacy';
import { chat, restoreClock, useFastClock } from '@/ai/mock/__testkit__/ask';

// main (#102) made these module-private, so the test pins them here, as
// src/ai/mock/regression.test.ts does for the help text.
const HELP_TEXT = help().message.content;
const UNSUPPORTED_HEADER = "**I can't answer that from the seeded data**";
const CLARIFY_HEADER = '**Which one do you mean?**';

beforeEach(useFastClock);
afterEach(restoreClock);

function helpPrompts(): string[] {
  return [...HELP_TEXT.matchAll(/^• "(.+)"$/gm)].map((m) => m[1]);
}

describe('/demo prompts', () => {
  it('every_demo_prompt_gets_a_non_help_mock_frank_reply', async () => {
    expect(DEMO_PROMPTS.length).toBeGreaterThanOrEqual(3);
    const texts: string[] = [];
    for (const prompt of DEMO_PROMPTS) {
      const { text } = await chat([{ role: 'user', content: prompt }]);
      expect(text, prompt).not.toBe(HELP_TEXT);
      expect(text, prompt).not.toContain(UNSUPPORTED_HEADER);
      expect(text, prompt).not.toContain(CLARIFY_HEADER);
      expect(text, prompt).toMatch(/\$[\d,]+/);
      texts.push(text);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('help_reply_prompts_each_classify_to_a_distinct_intent', async () => {
    const prompts = helpPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    const intents = prompts.map((p) => {
      const lower = p.toLowerCase();
      const intent = classifyIntent(lower, { hasEntity: false, namesTeam: false, backRef: false });
      return intent === 'legacy' ? `legacy:${classifyLegacy(p)}` : intent;
    });
    for (const i of intents) expect(i).not.toBe('legacy:help');
    expect(new Set(intents).size).toBe(intents.length);
    const texts: string[] = [];
    for (const p of prompts) {
      const { text } = await chat([{ role: 'user', content: p }]);
      expect(text, p).not.toBe(HELP_TEXT);
      texts.push(text);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });
});
