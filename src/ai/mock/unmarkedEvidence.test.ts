// The offline mock names the inputs that have no valid mark (a workload) and counts the workloads
// that have one (a group), so a missing record never reads like a stated assumption (review M2).
import { describe, expect, it } from 'vitest';
import { buildAIContext } from '@/ai/buildAIContext';
import { MockAIClient } from '@/ai';
import { WORKLOADS } from '@/data/workloads';
import { evid } from './format';

describe('unmarked inputs reach the mock answers', () => {
  it('evid names a workload\u2019s unmarked inputs and counts a group\u2019s workloads', () => {
    expect(evid('assumed', ['harm_from_misses', 'quality_floor_pass_rate'])).toBe(' (value evidence: assumed; no valid mark for harm from misses and quality-floor pass rate)');
    expect(evid('assumed', 2)).toBe(' (value evidence: assumed; 2 workloads have inputs with no valid mark)');
    expect(evid('measured', [])).toBe(' (value evidence: measured)');
    expect(evid(undefined)).toBe(' (value evidence: assumed, no mark recorded)');
  });
  it('a workload with no evidence block: the portfolio answer counts it', async () => {
    const legacy = { ...WORKLOADS[0], value: { ...WORKLOADS[0].value, evidence: undefined } };
    const ctx = buildAIContext([legacy, ...WORKLOADS.slice(1)]);
    const reply = await new MockAIClient().chat([{ role: 'user', content: 'What is the ROI of the portfolio?' }], ctx);
    expect(reply.message.content).toContain('1 workload has inputs with no valid mark');
  });
});
