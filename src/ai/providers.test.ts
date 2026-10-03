// AI provider registry — normalization, liveness, and env resolution. Pure.

import { describe, it, expect } from 'vitest';
import {
  AI_PROVIDERS,
  LIVE_AI_PROVIDERS,
  OPENAI_COMPATIBLE_PRESETS,
  normalizeAIProvider,
  resolveOpenAICompatible,
} from './providers';

describe('normalizeAIProvider', () => {
  it('passes canonical names through, case- and space-insensitively', () => {
    for (const p of AI_PROVIDERS) expect(normalizeAIProvider(` ${p.toUpperCase()} `)).toBe(p);
  });

  it('maps aliases for hosted and open-weight servers', () => {
    expect(normalizeAIProvider('anthropic')).toBe('claude');
    expect(normalizeAIProvider('dashscope')).toBe('qwen');
    expect(normalizeAIProvider('mistralai')).toBe('mistral');
    for (const a of ['ollama', 'vllm', 'tgi', 'lmstudio', 'llama.cpp', 'open-weight', 'openai-compatible']) {
      expect(normalizeAIProvider(a)).toBe('openllm');
    }
  });

  it('falls back to the offline mock for unset or unknown values', () => {
    expect(normalizeAIProvider(undefined)).toBe('mock');
    expect(normalizeAIProvider('')).toBe('mock');
    expect(normalizeAIProvider('skynet')).toBe('mock');
  });
});

describe('LIVE_AI_PROVIDERS', () => {
  it('is every provider except the mock', () => {
    expect([...LIVE_AI_PROVIDERS].sort()).toEqual(['claude', 'mistral', 'openai', 'openllm', 'qwen']);
  });
});

describe('resolveOpenAICompatible', () => {
  it('applies hosted defaults and honours overrides', () => {
    expect(resolveOpenAICompatible(OPENAI_COMPATIBLE_PRESETS.mistral, 'mistral', { MISTRAL_API_KEY: 'k' })).toEqual({
      ok: true,
      value: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', apiKey: 'k' },
    });
    const qwen = resolveOpenAICompatible(OPENAI_COMPATIBLE_PRESETS.qwen, 'qwen', {
      QWEN_API_KEY: 'q',
      DASHSCOPE_API_KEY: 'ignored',
      QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
    expect(qwen.ok && qwen.value).toEqual({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKey: 'q',
    });
  });

  it('requires base URL + model (not a key) for self-hosted open-weight servers', () => {
    const missing = resolveOpenAICompatible(OPENAI_COMPATIBLE_PRESETS.openllm, 'openllm', {});
    expect(missing).toEqual({
      ok: false,
      message: 'OPENLLM_BASE_URL and OPENLLM_MODEL are required for AI_PROVIDER=openllm',
    });
    const ok = resolveOpenAICompatible(OPENAI_COMPATIBLE_PRESETS.openllm, 'openllm', {
      OPENLLM_BASE_URL: 'http://vllm:8000/v1',
      OPENLLM_MODEL: 'Qwen/Qwen2.5-72B-Instruct',
    });
    expect(ok).toEqual({
      ok: true,
      value: { baseUrl: 'http://vllm:8000/v1', model: 'Qwen/Qwen2.5-72B-Instruct', apiKey: undefined },
    });
  });

  it('names every accepted key env in the error', () => {
    const r = resolveOpenAICompatible(OPENAI_COMPATIBLE_PRESETS.qwen, 'qwen', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('QWEN_API_KEY or DASHSCOPE_API_KEY is required for AI_PROVIDER=qwen');
  });
});
