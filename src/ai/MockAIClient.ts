// MockAIClient — offline/CI mock, no network, no API key. Deterministic and
// data-grounded: the analytics live in ./mock (pure modules); this class keeps
// the public AIClient API and the small UX delay. Every response honors the R4
// principle — cost is always paired with its value ratio and evidence status.

import type { AIClient, AIContext, AIMessage, AIResponse } from './AIClient';
import { respond } from './mock';

/**
 * The /demo page's suggested questions. Each one is answered by the mock Frank
 * with real analytics (not the help text or a "cannot answer" reply); the
 * demoPrompts test pins that against the current mock.
 */
export const DEMO_PROMPTS = [
  'Why is my spend spiking?',
  'Which team has the weakest ROI?',
  'What if we moved Customer Support Agent to a private open model?',
] as const;

export class MockAIClient implements AIClient {
  readonly mode = 'mock' as const;

  async chat(messages: AIMessage[], context: AIContext): Promise<AIResponse> {
    await new Promise((resolve) => setTimeout(resolve, 280));
    try { return respond(messages, context); } catch { // safety net: no malformed shape may surface as an error
      return { message: { role: 'assistant', content: "I can't process that context." }, initiativesReferenced: [], provider: 'mock' };
    }
  }
}
