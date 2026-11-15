// LiveAIClient — posts to /api/v1/ai/chat. The actual LLM call happens server-side,
// over a context the server builds from its own records;
// this client never sees an API key. Mirrors LiveCostSourceClient error handling:
// a typed Error on network failure and on non-2xx, never a raw fetch rejection.

import type { AIClient, AIContext, AIMessage, AIResponse } from './AIClient';
import { withBasePath } from '@/lib/basePath';
import { describeHttpError, readJsonResponse } from '@/lib/httpError';

const CHAT_URL = withBasePath('/api/v1/ai/chat');
/** A live answer that takes longer is abandoned, so a hung provider never leaves the panel waiting. */
export const CHAT_TIMEOUT_MS = 90_000;

export class LiveAIClient implements AIClient {
  readonly mode = 'live' as const;

  async chat(messages: AIMessage[], context: AIContext): Promise<AIResponse> {
    let res: Response;
    try {
      res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only the conversation and the focus id cross the wire: the server derives
        // every figure, name and evidence status from its own records.
        body: JSON.stringify({ messages, focusInitiativeId: context.focusInitiativeId ?? null }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`AI chat timed out after ${CHAT_TIMEOUT_MS / 1000} seconds. Ask again.`);
      }
      throw new Error(
        `AI chat unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new Error(await describeHttpError('AI chat', res));
    }
    return readJsonResponse<AIResponse>(res, 'AI chat');
  }
}

