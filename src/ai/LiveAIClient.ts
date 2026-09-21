// LiveAIClient — posts to /api/v1/ai/chat. The actual LLM call happens server-side;
// this client never sees an API key. Mirrors LiveCostSourceClient error handling:
// a typed Error on network failure and on non-2xx, never a raw fetch rejection.

import type { AIClient, AIContext, AIMessage, AIResponse } from './AIClient';
import { withBasePath } from '@/lib/basePath';

const CHAT_URL = withBasePath('/api/v1/ai/chat');

export class LiveAIClient implements AIClient {
  readonly mode = 'live' as const;

  async chat(messages: AIMessage[], context: AIContext): Promise<AIResponse> {
    let res: Response;
    try {
      res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, context }),
      });
    } catch (err) {
      throw new Error(
        `AI chat unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`AI chat error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as AIResponse;
  }
}

