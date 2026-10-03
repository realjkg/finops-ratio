// AI provider registry — the single definition of which LLM providers the
// /api/v1/ai/chat route can route to, shared by the route (adapter selection)
// and the gateway (whether a live provider forces auth on).
//
// Ratio is provider-agnostic: Claude and OpenAI have native adapters; every
// other provider speaks the OpenAI-compatible chat-completions wire format, so
// one adapter serves Mistral, Qwen, and ANY open-weight model behind a
// self-hosted server (vLLM, Ollama, TGI, LM Studio, llama.cpp — Llama, Mistral,
// Mixtral, Qwen, DeepSeek, Gemma, Phi...). Adding a hosted provider is one
// preset entry below.
//
// Pure data + pure functions: env NAMES and public base URLs only, never key
// values, so this module is safe anywhere. Keys are read by the route.

export const AI_PROVIDERS = ['claude', 'openai', 'mistral', 'qwen', 'openllm', 'mock'] as const;
export type AIProvider = (typeof AI_PROVIDERS)[number];

/** Providers that make a real network call (and so require gateway auth). */
export const LIVE_AI_PROVIDERS: ReadonlySet<AIProvider> = new Set(
  AI_PROVIDERS.filter((p) => p !== 'mock'),
);

// Friendly AI_PROVIDER spellings → canonical provider.
const ALIASES: Record<string, AIProvider> = {
  anthropic: 'claude',
  'mistral-ai': 'mistral',
  mistralai: 'mistral',
  dashscope: 'qwen',
  'open-weight': 'openllm',
  'openai-compatible': 'openllm',
  ollama: 'openllm',
  vllm: 'openllm',
  tgi: 'openllm',
  lmstudio: 'openllm',
  'llama.cpp': 'openllm',
  llamacpp: 'openllm',
};

/** Normalize AI_PROVIDER. Unset / unknown → `mock` (offline-safe default). */
export function normalizeAIProvider(raw: string | undefined): AIProvider {
  const v = (raw ?? '').trim().toLowerCase();
  if ((AI_PROVIDERS as readonly string[]).includes(v)) return v as AIProvider;
  return ALIASES[v] ?? 'mock';
}

/** Env contract for a provider reached over the OpenAI-compatible wire format. */
export interface OpenAICompatiblePreset {
  label: string;
  /** Key env vars, first match wins. */
  keyEnv: readonly string[];
  keyRequired: boolean;
  baseUrlEnv: string;
  defaultBaseUrl?: string; // absent → base URL must be configured
  modelEnv: string;
  defaultModel?: string; // absent → model must be configured
}

export const OPENAI_COMPATIBLE_PRESETS: Record<'mistral' | 'qwen' | 'openllm', OpenAICompatiblePreset> = {
  mistral: {
    label: 'Mistral',
    keyEnv: ['MISTRAL_API_KEY'],
    keyRequired: true,
    baseUrlEnv: 'MISTRAL_BASE_URL',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    modelEnv: 'MISTRAL_MODEL',
    defaultModel: 'mistral-large-latest',
  },
  qwen: {
    label: 'Qwen',
    keyEnv: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    keyRequired: true,
    baseUrlEnv: 'QWEN_BASE_URL',
    // Alibaba Cloud Model Studio (DashScope) OpenAI-compatible mode, international.
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    modelEnv: 'QWEN_MODEL',
    defaultModel: 'qwen-plus',
  },
  openllm: {
    label: 'OpenLLM',
    keyEnv: ['OPENLLM_API_KEY'],
    keyRequired: false, // self-hosted servers are often unauthenticated in-cluster
    baseUrlEnv: 'OPENLLM_BASE_URL',
    modelEnv: 'OPENLLM_MODEL',
  },
};

export interface ResolvedOpenAICompatible {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/**
 * Resolve an OpenAI-compatible provider's settings from env. Returns either the
 * settings or the human-readable reason it is misconfigured (the route turns
 * that into a 422 before any LLM call).
 */
export function resolveOpenAICompatible(
  preset: OpenAICompatiblePreset,
  providerName: string,
  env: Record<string, string | undefined>,
): { ok: true; value: ResolvedOpenAICompatible } | { ok: false; message: string } {
  const apiKey = preset.keyEnv.map((k) => env[k]?.trim()).find(Boolean);
  const baseUrl = env[preset.baseUrlEnv]?.trim() || preset.defaultBaseUrl;
  const model = env[preset.modelEnv]?.trim() || preset.defaultModel;

  const missing: string[] = [];
  if (preset.keyRequired && !apiKey) missing.push(preset.keyEnv.join(' or '));
  if (!baseUrl) missing.push(preset.baseUrlEnv);
  if (!model) missing.push(preset.modelEnv);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} required for AI_PROVIDER=${providerName}`,
    };
  }
  return { ok: true, value: { baseUrl: baseUrl as string, model: model as string, apiKey } };
}
