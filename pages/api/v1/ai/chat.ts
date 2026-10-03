// POST /api/v1/ai/chat — proxies a chat turn to the configured LLM adapter,
// behind the composable API gateway (auth, rate-limit, validation, structured
// errors). Versioned under /v1/ per the repo's API-First rule (.obvious/obvious.md);
// breaking changes get a new version path.
//
// Security: API keys NEVER reach the client. Only AIMessage[] and AIContext
// cross the wire from the browser; keys are read here from server-side env and
// the provider adapters (Claude / OpenAI / OpenAI-compatible) are defined and
// instantiated EXCLUSIVELY in this file — never imported from src/. The
// provider registry (src/ai/providers.ts) carries env names only, never keys.
//
// Provider is selected by AI_PROVIDER (claude | openai | mistral | qwen |
// openllm | mock, plus aliases such as ollama / vllm). Mistral, Qwen, and any
// open-weight model share one OpenAI-compatible adapter. Unset/unknown →
// offline-safe mock, so the route works with no keys at all.
//
// The gateway owns: 405 method, 413 oversized, 401 auth, 429 rate-limit, 400
// invalid body, 500 on a thrown handler. This handler owns: 422 misconfigured
// provider and the 200 success envelope.
// TODO(wave3b+): streaming (SSE) — see spec §6.5; MVP is non-streaming.

import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AIContext, AIMessage } from '@/ai/AIClient';
import { logUpstreamError, readJsonBody, statusReason } from '@/costsource/transports/redact';
import { MockAIClient } from '@/ai/MockAIClient';
import {
  OPENAI_COMPATIBLE_PRESETS,
  normalizeAIProvider,
  resolveOpenAICompatible,
  type AIProvider,
} from '@/ai/providers';
import {
  withGateway,
  sendError,
  type GatewayContext,
  type GatewayValidation,
} from '@/server/gateway';

// Context-size budget (spec §8.6) — keep prompt + history well under truncation.
const MAX_MESSAGES = 50;
const MAX_INITIATIVES = 100;
const MAX_TOKENS = 1024;

// --- Server-only provider adapters ------------------------------------------
// These must never be imported from src/. The interface is intentionally inline.

interface AIAdapter {
  readonly provider: AIProvider;
  /**
   * Call the LLM with the pre-built system prompt and the user message history
   * (system entries already stripped — the route prepends the system prompt).
   */
  call(systemPrompt: string, messages: AIMessage[]): Promise<string>;
}

/**
 * SDK errors embed the provider's response body in their message. Log it
 * server-side (redacted) and rethrow `<provider> error <status> (<reason>)`
 * so no provider text reaches the caller through the gateway 500.
 */
function providerError(provider: string, err: unknown): Error {
  const status = (err as { status?: unknown } | null)?.status;
  const code = typeof status === 'number' ? status : 0;
  logUpstreamError(provider, code, err instanceof Error ? err.message : String(err));
  return new Error(
    typeof status === 'number'
      ? `${provider} error ${status} (${statusReason(status)})`
      : `${provider} error unavailable`,
  );
}

class ClaudeAdapter implements AIAdapter {
  readonly provider = 'claude' as const;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model = 'claude-sonnet-4-20250514') {
    // Server-side instantiation: no browser, no NEXT_PUBLIC_, no dangerous flag.
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async call(systemPrompt: string, messages: AIMessage[]): Promise<string> {
    try {
      return await this.callUnsafe(systemPrompt, messages);
    } catch (err) {
      throw providerError(this.provider, err);
    }
  }

  private async callUnsafe(systemPrompt: string, messages: AIMessage[]): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    });
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }
}

class OpenAIAdapter implements AIAdapter {
  readonly provider = 'openai' as const;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model = 'gpt-4o') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async call(systemPrompt: string, messages: AIMessage[]): Promise<string> {
    try {
      return await this.callUnsafe(systemPrompt, messages);
    } catch (err) {
      throw providerError(this.provider, err);
    }
  }

  private async callUnsafe(systemPrompt: string, messages: AIMessage[]): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ],
    });
    return completion.choices[0]?.message.content ?? '';
  }
}

// OpenAI-compatible chat completions — Mistral, Qwen, and any open-weight model
// behind vLLM / Ollama / TGI / LM Studio / llama.cpp. No SDK: a raw fetch keeps
// the adapter decoupled from a specific client version and vendor.
class OpenAICompatibleAdapter implements AIAdapter {
  constructor(
    readonly provider: AIProvider,
    private readonly label: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async call(systemPrompt: string, messages: AIMessage[]): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!res.ok) {
      // Status + fixed reason only; the provider body goes to the redacted log.
      const text = await res.text().catch(() => '');
      if (text) logUpstreamError(this.label, res.status, text);
      throw new Error(`${this.label} error ${res.status} (${statusReason(res.status)})`);
    }
    const data = await readJsonBody<{
      choices: Array<{ message: { content: string } }>;
    }>(res, this.label);
    return data.choices[0]?.message.content ?? '';
  }
}

// --- Provider resolution ----------------------------------------------------
// Misconfiguration surfaces as a thrown { status: 422 } BEFORE any LLM call,
// so a missing key is a clear, actionable error — not a cryptic SDK 500.

interface AdapterError {
  status: number;
  message: string;
}

function resolveAdapter(env: NodeJS.ProcessEnv, context: AIContext): AIAdapter {
  const provider = normalizeAIProvider(env.AI_PROVIDER);
  switch (provider) {
    case 'claude': {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) {
        throw {
          status: 422,
          message: 'ANTHROPIC_API_KEY is required for AI_PROVIDER=claude',
        } satisfies AdapterError;
      }
      return new ClaudeAdapter(key, env.ANTHROPIC_MODEL);
    }
    case 'openai': {
      const key = env.OPENAI_API_KEY;
      if (!key) {
        throw {
          status: 422,
          message: 'OPENAI_API_KEY is required for AI_PROVIDER=openai',
        } satisfies AdapterError;
      }
      return new OpenAIAdapter(key, env.OPENAI_MODEL);
    }
    case 'mistral':
    case 'qwen':
    case 'openllm': {
      const preset = OPENAI_COMPATIBLE_PRESETS[provider];
      const resolved = resolveOpenAICompatible(preset, provider, env);
      if (!resolved.ok) {
        throw { status: 422, message: resolved.message } satisfies AdapterError;
      }
      const { baseUrl, model, apiKey } = resolved.value;
      return new OpenAICompatibleAdapter(provider, preset.label, baseUrl, model, apiKey);
    }
    case 'mock':
      // Offline-safe default: the data-grounded mock, given the real context.
      return {
        provider: 'mock',
        call: async (_systemPrompt, messages) => {
          const result = await new MockAIClient().chat(messages, context);
          return result.message.content;
        },
      };
  }
}

function isAdapterError(err: unknown): err is AdapterError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as AdapterError).status === 'number' &&
    typeof (err as AdapterError).message === 'string'
  );
}

// --- System-prompt builder (spec §5.2) -------------------------------------

export function buildSystemPrompt(ctx: AIContext): string {
  const fmt = (n: number) =>
    n.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });

  const initiativeLines = ctx.initiatives
    .map(
      (i) =>
        `- ${i.name}: ${fmt(i.monthlyCost)}/mo | Annual: ${fmt(i.annualRunRate)} | Budget: ${i.budgetConsumedPct}%\n  Status: ${i.status} | Value ratio: ${i.valueRatio.toFixed(1)}×` +
        (i.savingsOpportunity > 0
          ? ` | Savings opportunity: ${fmt(i.savingsOpportunity)}/mo`
          : ''),
    )
    .join('\n');

  const workloadLines =
    ctx.workloads
      ?.map(
        (w) =>
          `- ${w.name} (${w.model}): ${fmt(w.monthlySpend)}/mo | ${w.valueRatio.toFixed(1)}× return | shape: ${w.demandShape} | gates: ${w.governanceGatesPassed}/4`,
      )
      .join('\n') ?? '';

  const focusedInitiative = ctx.focusInitiativeId
    ? ctx.initiatives.find((i) => i.id === ctx.focusInitiativeId)?.name
    : null;

  return [
    'IDENTITY:',
    'You are the Ratio AI agent — a FinOps advisor for executive AI initiative portfolios.',
    'You reason over cloud spend, value ratios, and savings opportunities.',
    '',
    'PRINCIPLES (non-negotiable):',
    '1. Every cost you cite MUST include its value ratio (R4: cost without value is just spend).',
    '2. Never recommend scaling an initiative with Pending Approval status.',
    '3. When asked about budget, include consumed %, projected run-rate, and savings opportunity.',
    '4. When comparing initiatives, always reference their status and value ratio together.',
    '5. When recommending action, always state the value at risk, not just the cost saved.',
    '',
    `PORTFOLIO SNAPSHOT (${ctx.asOf.slice(0, 10)}):`,
    `Total spend: ${fmt(ctx.summary.totalMonthlySpend)}/mo | Projected savings: ${fmt(ctx.summary.projectedSavings)}/mo`,
    `Initiatives: ${ctx.summary.initiativesActive} active, ${ctx.summary.pendingApproval} pending approval`,
    '',
    'INITIATIVES:',
    initiativeLines,
    ...(workloadLines ? ['', 'WORKLOAD DETAIL:', workloadLines] : []),
    ...(focusedInitiative ? ['', `FOCUS: ${focusedInitiative}`] : []),
  ].join('\n');
}

// --- Request validation -----------------------------------------------------

function isValidBody(
  body: unknown,
): body is { messages: AIMessage[]; context: AIContext } {
  if (typeof body !== 'object' || body === null) return false;
  const { messages, context } = body as {
    messages?: unknown;
    context?: unknown;
  };
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (messages.length > MAX_MESSAGES) return false;
  if (typeof context !== 'object' || context === null) return false;
  const { initiatives, summary, asOf } = context as {
    initiatives?: unknown;
    summary?: unknown;
    asOf?: unknown;
  };
  if (!Array.isArray(initiatives) || initiatives.length > MAX_INITIATIVES) return false;
  if (typeof summary !== 'object' || summary === null) return false;
  if (typeof asOf !== 'string') return false;
  return true;
}

/** Gateway body validator — wraps the type guard with a human-readable message. */
export function validateChatBody(body: unknown): GatewayValidation {
  return isValidBody(body)
    ? { ok: true }
    : {
        ok: false,
        message:
          'Body must include non-empty messages[] (max 50) and a context with initiatives (max 100), summary, and asOf',
      };
}

// --- Guarded handler --------------------------------------------------------
// The gateway has already validated the method, size, auth, rate limit, and body
// shape before this runs. Routing to the provider adapter happens here.

async function chatHandler(
  req: NextApiRequest,
  res: NextApiResponse,
  _ctx: GatewayContext,
): Promise<void> {
  const { messages, context } = req.body as {
    messages: AIMessage[];
    context: AIContext;
  };

  let adapter: AIAdapter;
  try {
    adapter = resolveAdapter(process.env, context);
  } catch (err) {
    if (isAdapterError(err)) {
      sendError(res, err.status, 'provider_misconfigured', err.message);
      return;
    }
    throw err; // unexpected — let the gateway convert to a 500 envelope.
  }

  const systemPrompt = buildSystemPrompt(context);
  const userMessages = messages.filter((m) => m.role !== 'system');

  // A thrown LLM error propagates to the gateway, which returns a 500 envelope
  // with only the message (no stack trace).
  const text = await adapter.call(systemPrompt, userMessages);
  const initiativesReferenced = context.initiatives
    .filter((i) => text.toLowerCase().includes(i.name.toLowerCase()))
    .map((i) => i.id);

  res.status(200).json({
    message: { role: 'assistant', content: text },
    initiativesReferenced,
    provider: adapter.provider,
  });
}

export default withGateway(chatHandler, {
  methods: ['POST'],
  validateBody: validateChatBody,
});

