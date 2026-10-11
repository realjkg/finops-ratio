// A8: every suggested /demo prompt gets a real mock Frank answer, not the help
// text, the "cannot answer" reply or a clarifying question.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PROMPTS } from '@/ai/MockAIClient';
import { help } from '@/ai/mock/legacy';
import { CLARIFY, UNSUPPORTED, chat, restoreClock, useFastClock } from '@/ai/mock/__testkit__/ask';

beforeEach(useFastClock);
afterEach(restoreClock);

describe('/demo prompts', () => {
  it('every_demo_prompt_gets_a_non_help_mock_frank_reply', async () => {
    const helpText = help().message.content;
    for (const prompt of DEMO_PROMPTS) {
      const { text } = await chat([{ role: 'user', content: prompt }]);
      expect(text, prompt).not.toBe(helpText);
      expect(text, prompt).not.toContain(UNSUPPORTED);
      expect(text, prompt).not.toContain(CLARIFY);
      expect(text, prompt).not.toBe("I can't process that context."); // MockAIClient's safety net
    }
  });
});
