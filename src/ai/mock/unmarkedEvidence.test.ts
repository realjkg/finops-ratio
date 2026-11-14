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

describe('legacy answers, groups and odd contexts (Copilot, round 3)', () => {
  const legacy = { ...WORKLOADS[0], value: { ...WORKLOADS[0].value, evidence: undefined } };
  const ctx = () => buildAIContext([legacy, ...WORKLOADS.slice(1)]);
  const ask = async (q: string, c = ctx()) => (await new MockAIClient().chat([{ role: 'user', content: q }], c)).message.content;

  it.each(['Which initiatives are at risk?', 'What is our biggest cost driver?'])('legacy "%s" names the unmarked inputs', async (q) => {
    const all = buildAIContext(WORKLOADS.map((w) => ({ ...w, value: { ...w.value, evidence: undefined } })));
    expect(await ask(q, all)).toContain('assumed; no valid mark for revenue protected, cost avoided, harm from misses and quality-floor pass rate');
  });
  it('a group with a member that has no status at all counts it', async () => {
    const c = ctx();
    for (const s of [...(c.workloads ?? []), ...c.initiatives]) if (s.id === legacy.id) { delete s.valueEvidenceStatus; delete s.valueEvidenceUnmarked; }
    expect(await ask('What is the ROI of the portfolio?', c)).toContain('1 workload has inputs with no valid mark');
  });
  it('a context that names unmarked inputs cannot also claim measured', async () => {
    const c = ctx();
    for (const s of [...(c.workloads ?? []), ...c.initiatives]) if (s.id === legacy.id) s.valueEvidenceStatus = 'measured';
    const answer = await ask(`What is the ROI of ${legacy.name}?`, c);
    expect(answer).not.toMatch(/measured; no valid mark/);
  });
  it('an empty group says so instead of "assumed"', () => {
    expect(evid(undefined, 0)).toBe(' (value evidence: no workloads in scope)');
  });
});

describe('confirmation round: legacy force, asymmetric lists, one-workload naming', () => {
  const W0 = WORKLOADS[0];
  const ask = async (q: string, c: ReturnType<typeof buildAIContext>) => (await new MockAIClient().chat([{ role: 'user', content: q }], c)).message.content;
  const measuredWithHarmUnmarked = () => {
    const c = buildAIContext(WORKLOADS);
    for (const s of [...(c.workloads ?? []), ...c.initiatives]) if (s.id === W0.id) { s.valueEvidenceStatus = 'measured'; s.valueEvidenceUnmarked = ['harm_from_misses']; }
    return c;
  };
  it('a legacy answer on a "measured but unmarked" context says assumed and names the input', async () => {
    expect(await ask('What is our biggest cost driver?', measuredWithHarmUnmarked())).toMatch(new RegExp(`${W0.name}[^\\n]*assumed; no valid mark for harm from misses`));
  });
  it('an empty list on the workload copy never hides the initiative copy’s list', async () => {
    const c = buildAIContext(WORKLOADS);
    for (const s of c.workloads ?? []) if (s.id === W0.id) { s.valueEvidenceStatus = 'measured'; s.valueEvidenceUnmarked = []; }
    for (const s of c.initiatives) if (s.id === W0.id) { s.valueEvidenceStatus = 'measured'; s.valueEvidenceUnmarked = ['harm_from_misses']; }
    expect(await ask(`What is the ROI of ${W0.name}?`, c)).toContain('assumed; no valid mark for harm from misses');
  });
  it('legacy and main answers agree about one workload when the two copies disagree', async () => {
    const c = buildAIContext(WORKLOADS);
    for (const s of c.initiatives) if (s.id === W0.id) { s.valueEvidenceStatus = 'measured'; delete s.valueEvidenceUnmarked; }
    for (const s of c.workloads ?? []) if (s.id === W0.id) { s.valueEvidenceStatus = 'assumed'; s.valueEvidenceUnmarked = ['harm_from_misses']; }
    expect(await ask('What is our biggest cost driver?', c)).not.toMatch(new RegExp(`${W0.name}[^\\n]*value evidence: measured`));
  });
  it('a one-workload scope names its inputs instead of counting itself', async () => {
    const answer = await ask(`What is the ROI of ${W0.name}?`, measuredWithHarmUnmarked());
    expect(answer).toContain('no valid mark for harm from misses');
    expect(answer).not.toContain('1 workload has inputs with no valid mark');
  });
});
