// AI slice public API — mirrors src/costsource/index.ts.
// Callers see the AIClient interface, createAIClient(), and buildAIContext();
// concrete implementations are an internal detail.

import { LiveAIClient } from './LiveAIClient';
import { MockAIClient } from './MockAIClient';
import type { AIClient } from './AIClient';

export type {
  AIClient,
  AIMessage,
  AIRole,
  AIContext,
  AIInitiativeSnapshot,
  AISpendSummary,
  AIWorkloadSnapshot,
  AIResponse,
} from './AIClient';

export { MockAIClient } from './MockAIClient';
export { AI_PROVIDERS, LIVE_AI_PROVIDERS, normalizeAIProvider } from './providers';
export type { AIProvider } from './providers';
export { buildAIContext } from './buildAIContext';

/**
 * Returns MockAIClient by default. Pass `'live'` to get LiveAIClient (which
 * proxies /api/ai/chat — no key ever reaches the browser).
 *
 * Provider selection (claude | openai | mistral | qwen | openllm | mock) is
 * resolved server-side from the AI_PROVIDER env var, not here.
 */
export function createAIClient(mode: 'mock' | 'live' = 'mock'): AIClient {
  return mode === 'live' ? new LiveAIClient() : new MockAIClient();
}

