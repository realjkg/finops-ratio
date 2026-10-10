// Model registry seed — spec §2.2, pricing from §3.4.2. Per-1M-token rates.
// Cost tiers per §2.2: economy <$1/1M in | standard $1–5 | premium $5–20 | ultra >$20.

import type { ModelEntry, ModelProvider } from '@/types';

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'mdl-gemini-flash',
    provider: 'google',
    model_name: 'gemini-2.5-flash',
    display_name: 'Gemini 2.5 Flash',
    pricing: {
      input_per_1m: 0.075,
      output_per_1m: 0.3,
      cached_input_per_1m: 0.0188,
      batch_input_per_1m: 0.0375,
      batch_output_per_1m: 0.15,
    },
    context_window: 1_000_000,
    max_output: 8192,
    supports_vision: true,
    supports_tools: true,
    supports_streaming: true,
    cost_tier: 'economy',
    last_price_update: '2026-06-01T00:00:00Z',
  },
  {
    id: 'mdl-gpt4o-mini',
    provider: 'openai',
    model_name: 'gpt-4o-mini',
    display_name: 'GPT-4o mini',
    pricing: {
      input_per_1m: 0.15,
      output_per_1m: 0.6,
      cached_input_per_1m: 0.075,
      batch_input_per_1m: 0.075,
      batch_output_per_1m: 0.3,
    },
    context_window: 128_000,
    max_output: 16_384,
    supports_vision: true,
    supports_tools: true,
    supports_streaming: true,
    cost_tier: 'economy',
    last_price_update: '2026-06-01T00:00:00Z',
  },
  {
    id: 'mdl-claude-haiku',
    provider: 'anthropic',
    model_name: 'claude-haiku-3.5',
    display_name: 'Claude Haiku 3.5',
    pricing: {
      input_per_1m: 0.8,
      output_per_1m: 4.0,
      cached_input_per_1m: 0.08,
      batch_input_per_1m: 0.4,
      batch_output_per_1m: 2.0,
    },
    context_window: 200_000,
    max_output: 8192,
    supports_vision: true,
    supports_tools: true,
    supports_streaming: true,
    cost_tier: 'economy',
    last_price_update: '2026-06-01T00:00:00Z',
  },
  {
    id: 'mdl-gpt4o',
    provider: 'openai',
    model_name: 'gpt-4o',
    display_name: 'GPT-4o (Global Standard)',
    pricing: {
      input_per_1m: 2.5,
      output_per_1m: 10.0,
      cached_input_per_1m: 1.25,
      batch_input_per_1m: 1.25,
      batch_output_per_1m: 5.0,
    },
    context_window: 128_000,
    max_output: 16_384,
    supports_vision: true,
    supports_tools: true,
    supports_streaming: true,
    cost_tier: 'standard',
    last_price_update: '2026-06-01T00:00:00Z',
  },
  {
    id: 'mdl-claude-sonnet',
    provider: 'anthropic',
    model_name: 'claude-sonnet-4-20250514',
    display_name: 'Claude Sonnet 4',
    pricing: {
      input_per_1m: 3.0,
      output_per_1m: 15.0,
      cached_input_per_1m: 0.3,
      batch_input_per_1m: 1.5,
      batch_output_per_1m: 7.5,
    },
    context_window: 200_000,
    max_output: 64_000,
    supports_vision: true,
    supports_tools: true,
    supports_streaming: true,
    cost_tier: 'standard',
    last_price_update: '2026-06-01T00:00:00Z',
  },
  {
    id: 'mdl-claude-opus',
    provider: 'anthropic',
    model_name: 'claude-opus-4-20250514',
    display_name: 'Claude Opus 4',
    pricing: {
      input_per_1m: 15.0,
      output_per_1m: 75.0,
      cached_input_per_1m: 1.5,
      batch_input_per_1m: 7.5,
      batch_output_per_1m: 37.5,
    },
    context_window: 200_000,
    max_output: 32_000,
    supports_vision: true,
    supports_tools: true,
    supports_streaming: true,
    cost_tier: 'premium',
    last_price_update: '2026-06-01T00:00:00Z',
  },
  {
    id: 'mdl-gpt45',
    provider: 'openai',
    model_name: 'gpt-4.5',
    display_name: 'GPT-4.5 (Research Preview)',
    pricing: {
      input_per_1m: 75.0,
      output_per_1m: 150.0,
      cached_input_per_1m: 37.5,
      batch_input_per_1m: 37.5,
      batch_output_per_1m: 75.0,
    },
    context_window: 128_000,
    max_output: 16_384,
    supports_vision: true,
    supports_tools: true,
    supports_streaming: true,
    cost_tier: 'ultra',
    last_price_update: '2026-06-01T00:00:00Z',
  },
];

export function findModel(modelName: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.model_name === modelName);
}

// --- FOCUS 1.5 model-identity mapping (working draft — ratifies 3 Dec 2026) ---
// When a FOCUS export omits the draft's recommended model-identity properties
// (ModelDeveloper/ModelFamily/ModelId/ModelVersion), the ingest seam derives
// what the registry can honestly say and leaves the rest null — never a guessed
// value. Derivations below read only registry facts.

/** Provider enum -> model developer. null where the provider alone cannot say. */
const MODEL_DEVELOPER_BY_PROVIDER: Record<ModelProvider, string | null> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  // Bedrock hosts models from many developers; the provider enum alone cannot
  // attribute one, and inventing one would fabricate billing identity.
  aws_bedrock: null,
  // The Azure OpenAI Service serves OpenAI models exclusively.
  azure_openai: 'OpenAI',
  custom: null,
};

const MODEL_FAMILY_PREFIXES: readonly (readonly [prefix: string, family: string])[] = [
  ['claude', 'Claude'],
  ['gpt', 'GPT'],
  ['gemini', 'Gemini'],
];

/** Model family from the registry model_name's family token (e.g. 'claude-*' -> 'Claude'). */
function modelFamilyFor(modelName: string): string | null {
  const name = modelName.toLowerCase();
  const hit = MODEL_FAMILY_PREFIXES.find(([prefix]) => name.startsWith(prefix));
  return hit ? hit[1] : null;
}

/**
 * Model version from the developer's date-stamped snapshot segment (e.g.
 * 'claude-sonnet-4-20250514' -> '20250514'). Model names without a snapshot
 * segment stay null — the registry records no other version fact.
 */
function modelVersionFor(modelName: string): string | null {
  return /(\d{8})$/.exec(modelName)?.[1] ?? null;
}

export interface FocusModelIdentity {
  ModelDeveloper: string | null;
  ModelFamily: string | null;
  ModelId: string | null;
  ModelVersion: string | null;
}

/**
 * Registry-derived FOCUS 1.5 model identity for a cost row's ServiceName, or
 * null when no registry entry matches. Resolves by the registry's model_name
 * (what a provider-billed export usually carries) then its display_name (what
 * the seam's own seed rows put in ServiceName).
 */
export function modelIdentityForService(serviceName: string): FocusModelIdentity | null {
  const model =
    findModel(serviceName) ?? MODEL_REGISTRY.find((m) => m.display_name === serviceName);
  if (!model) return null;
  return {
    ModelDeveloper: MODEL_DEVELOPER_BY_PROVIDER[model.provider],
    ModelFamily: modelFamilyFor(model.model_name),
    ModelId: model.model_name,
    ModelVersion: modelVersionFor(model.model_name),
  };
}

// Lightweight quality hints used by the comparison view + agent responder.
// Cheaper models trade resolution quality for cost — surfaced, never hidden.
export const MODEL_QUALITY_NOTE: Record<string, string> = {
  'gemini-2.5-flash': 'Fastest + cheapest; may reduce resolution rate on complex queries',
  'gpt-4o-mini': 'Strong value; lighter reasoning than full GPT-4o',
  'claude-haiku-3.5': 'Fast and cheap; good for routing and simple tasks',
  'gpt-4o': 'Balanced cost and quality',
  'claude-sonnet-4-20250514': 'High quality reasoning at standard cost',
  'claude-opus-4-20250514': 'Top-tier reasoning; premium cost',
  'gpt-4.5': 'Research-grade; ultra cost — requires Cost gate approval',
};

