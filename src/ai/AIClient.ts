// AIClient seam (Wave3b) — server-proxied multi-turn LLM interface.
//
// Follows the repo's typed-client-seam pattern (CostSourceClient, PredictionClient,
// HelloClient). The seam's three concerns:
//   1. AIClient interface — what the UI/store talks to
//   2. AIMessage / AIContext — wire types for the /api/ai/chat route
//   3. AIResponse — the reply the route returns
//
// Security: API keys are NEVER client-side. The MockAIClient and LiveAIClient
// are safe to import in the browser. Only the server-side adapters
// (ClaudeAdapter, OpenAIAdapter, OpenAICompatibleAdapter) touch keys, and they
// live exclusively inside pages/api/v1/ai/chat.ts.

import type { AIProvider } from './providers';
import type { EvidenceStatus } from '@/types';

/** OpenAI-style role taxonomy for conversation turns. */
export type AIRole = 'user' | 'assistant' | 'system';

/**
 * One message in a multi-turn conversation. The full history is passed on every
 * chat() call; the server injects a `system` message at position 0 before
 * forwarding to the LLM.
 */
export interface AIMessage {
  role: AIRole;
  content: string;
}

/**
 * Serialized snapshot of the current initiative board + optional workload detail.
 * Sent in the /api/ai/chat request body so the server can build the system prompt
 * without a second round-trip to fetch data. Kept lean — enough for the agent to
 * answer executive questions; deeper workload fields available via `workloads`.
 */
export interface AIContext {
  // --- Initiative board (executive surface, from initiativeModel.ts) ---
  initiatives: AIInitiativeSnapshot[];
  summary: AISpendSummary;
  // --- Workload detail (technical drill-down, optional) ---
  workloads?: AIWorkloadSnapshot[];
  /** Which initiative the user currently has focused (e.g. clicked a card). */
  focusInitiativeId?: string | null;
  /** ISO 8601 instant when the snapshot was taken (client's DEMO_NOW). */
  asOf: string;
  /** Initiatives left out of `initiatives` because their budget metric is N/A, with the reason. */
  omitted?: { id: string; name: string; reason: string }[];
}

/** Lean initiative projection — executive vocabulary, sufficient for most questions. */
export interface AIInitiativeSnapshot {
  id: string;
  name: string;
  monthlyCost: number; // USD
  annualRunRate: number; // monthlyCost × 12
  budgetConsumedPct: number; // whole percent of the approved budget; can exceed 100 (not clamped)
  status: 'On Track' | 'At Risk' | 'Pending Approval';
  valueRatio: number; // R4: cost-efficiency denominator
  /** Provenance mark on the ratio — weakest value input's status (audit C1/C2). */
  valueEvidenceStatus?: EvidenceStatus;
  savingsOpportunity: number; // USD/mo from configured findings sources
}

/** Board-level spend summary (mirrors SpendSummary from initiativeModel.ts). */
export interface AISpendSummary {
  totalMonthlySpend: number;
  projectedSavings: number;
  initiativesActive: number;
  pendingApproval: number;
}

/** Workload-level snapshot for technical drill-down questions. */
export interface AIWorkloadSnapshot {
  id: string;
  name: string;
  model: string;
  monthlySpend: number;
  valueRatio: number;
  /** Provenance mark on the ratio — weakest value input's status (audit C1/C2). */
  valueEvidenceStatus?: EvidenceStatus;
  demandShape: string;
  governanceGatesPassed: number; // 0–4
  costTrendPct: number;
  /**
   * Cache hit rate = cached ÷ (cached + uncached) input tokens (conformance A3).
   * `null` when the workload used no input tokens today — never a fabricated 0%.
   */
  cacheHitRate: number | null;
  // --- Optional analytics fields (Frank mock). Older clients omit them; the
  // mock then falls back to the bundled seed by workload id, and says so when
  // a field is genuinely unavailable rather than guessing. ---
  /** Owning team (Workload.team). */
  team?: string;
  /** Model provider enum value (Workload.model_provider). */
  provider?: string;
  /** Defensible monthly value in USD (Workload.value.total_value). */
  monthlyValue?: number;
  monthlyBudget?: number;
  /** Volume so far today: calls and tokens (the seed's daily framing). */
  dailyInferences?: number;
  tokensInToday?: number;
  tokensOutToday?: number;
  tokensCachedToday?: number;
  /** Seeded alerts for this workload, compact. */
  alerts?: AIAlertSnapshot[];
}

/** Compact alert projection for drill-down answers. */
export interface AIAlertSnapshot {
  type: string;
  severity: string;
  message: string;
  acknowledged: boolean;
}

/** The response from a chat() call. */
export interface AIResponse {
  message: AIMessage; // role is always 'assistant'
  /** IDs from AIContext.initiatives that the response explicitly references. */
  initiativesReferenced: string[];
  /** Which provider produced this response — surfaced in the panel badge. */
  provider: AIProvider;
}

/** The AIClient seam interface. The store calls this; adapters live server-side. */
export interface AIClient {
  readonly mode: 'mock' | 'live';
  /**
   * Send a conversation turn.
   * @param messages Full history, most-recent-last. The client must NOT include
   *   a system message — the server builds and prepends it from `context`.
   * @param context Current initiative snapshot — serialized to system prompt server-side.
   */
  chat(messages: AIMessage[], context: AIContext): Promise<AIResponse>;
}

