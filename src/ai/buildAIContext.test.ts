// Cache hit-rate injection tests (conformance A3) — the seed → AIContext →
// live system-prompt path. buildAIContext must carry a per-workload hit rate
// for every snapshot, and buildSystemPrompt must render it into the WORKLOAD
// DETAIL lines the live agent reasons over.
import { describe, it, expect } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { buildAIContext } from './buildAIContext';
import { buildSystemPrompt } from '../../pages/api/v1/ai/chat';

describe('buildAIContext — cache hit rate injection', () => {
  it('carries a per-workload cache hit rate on every workload snapshot', () => {
    const ctx = buildAIContext(WORKLOADS);
    const snapshots = ctx.workloads ?? [];
    expect(snapshots).toHaveLength(WORKLOADS.length);
    for (const s of snapshots) {
      expect(s.cacheHitRate === null || (s.cacheHitRate >= 0 && s.cacheHitRate <= 1)).toBe(true);
    }
  });

  it('derives the rate from seed token counts (Customer Support Agent: 9.5M of 57.5M)', () => {
    const ctx = buildAIContext(WORKLOADS);
    const support = (ctx.workloads ?? []).find((w) => w.id === 'wl-support');
    expect(support?.cacheHitRate).toBeCloseTo(9.5 / 57.5);
  });

  it('feeds the live system prompt (buildSystemPrompt renders the WORKLOAD DETAIL lines)', () => {
    const prompt = buildSystemPrompt(buildAIContext(WORKLOADS));
    expect(prompt).toContain('WORKLOAD DETAIL:');
    expect(prompt).toContain('cache hit: 16.5%'); // wl-support
  });
});
