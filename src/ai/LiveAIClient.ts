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
    // One deadline for the whole exchange: headers and body. Whatever step it interrupts, the user is
    // told it timed out (not "unreachable" or "invalid response").
    const signal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
    const timedOut = () => new Error(`AI chat timed out after ${CHAT_TIMEOUT_MS / 1000} seconds. Ask again.`);
    let res: Response;
    try {
      res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only the conversation and the focus id cross the wire: the server derives
        // every figure, name and evidence status from its own records.
        body: JSON.stringify({ messages, focusInitiativeId: context.focusInitiativeId ?? null }),
        signal,
      });
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'TimeoutError')) throw timedOut();
      throw new Error(
        `AI chat unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    try {
      if (!res.ok) throw new Error(await describeHttpError('AI chat', res));
      return await readJsonResponse<AIResponse>(res, 'AI chat');
    } catch (err) {
      // The body read shares the deadline: a stalled body is a timeout, not a bad response.
      if (signal.aborted) throw timedOut();
      throw err;
    }
  }
}

