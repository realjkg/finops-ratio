// Memory bounds and adversarial input. Real timers on purpose: these also
// check that hostile input cannot make the mock slow (the 280 ms UX delay is
// the only wait) and that no reply echoes huge input or leaks NaN/Infinity.

import { describe, expect, it } from 'vitest';
import type { AIContext, AIMessage } from '@/ai/AIClient';
import { MockAIClient } from '@/ai/MockAIClient';
import { CTX } from './__testkit__/ask';

const client = new MockAIClient();
const ask1 = async (content: unknown, ctx: AIContext = CTX, history: AIMessage[] = []): Promise<string> =>
  (await client.chat([...history, { role: 'user', content: content as string }], ctx)).message.content;
const clean = (t: string): void => {
  expect(t).not.toMatch(/NaN|Infinity|undefined|\[object/);
};

describe('adversarial input', () => {
  it('very long text is bounded: fast, not echoed, no throw', async () => {
    const big = 'what is the roi of the legal team '.repeat(40_000); // ~1.4 MB
    const t0 = Date.now();
    const t = await ask1(big);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(t.length).toBeLessThan(6000);
    clean(t);
  });

  it('regex-hostile strings cannot hang or throw', async () => {
    const hostile = [
      '(((((((((((', '[[[[[', '\\', '$&', '.*+?^${}()|[]\\', '(a+)+$' + 'a'.repeat(5000) + '!',
      '\u0000\u0001', '\u{1F600}'.repeat(3000), '‮ rtl', 'a'.repeat(100_000), ' '.repeat(100_000) + 'roi',
      '$'.repeat(5000) + ' EBITDA ' + '1'.repeat(5000), 'GPUs '.repeat(5000), '$1,'.repeat(5000),
    ];
    const t0 = Date.now();
    const replies = await Promise.all(hostile.map((h) => ask1(h)));
    expect(Date.now() - t0).toBeLessThan(4000);
    for (const r of replies) {
      expect(r.length).toBeLessThan(6000);
      clean(r);
    }
  });

  it('object-prototype names are just text', async () => {
    for (const q of ['__proto__', 'constructor', 'toString team', 'ROI of hasOwnProperty', 'roi of __proto__ team']) {
      const t = await ask1(q);
      clean(t);
      expect(t).not.toMatch(/function|native code/);
    }
  });

  it('non-string / missing content on the wire does not throw', async () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      const t = await ask1(bad);
      expect(typeof t).toBe('string');
      clean(t);
    }
    const r = await client.chat(
      [
        { role: 'user', content: undefined as unknown as string },
        { role: 'assistant', content: null as unknown as string },
        { role: 'user', content: 'ROI of the Legal team' },
      ],
      CTX,
    );
    expect(r.message.content).toContain('**ROI — Legal (team)**');
  });

  it('huge numbers and signs never produce NaN/Infinity or a bogus computation', async () => {
    const nums = ['1e999', '-1e999', '0', '-0', '99999999999999999999999999', '1e-999', '0.0000001', 'NaN', 'Infinity'];
    const qs = nums.flatMap((n) => [
      `Move Sales Copilot to a private open model with ${n} GPUs`,
      `Move Sales Copilot to a private open model at $${n} per GPU hour`,
      `Move Sales Copilot to a private open model, migration costs $${n}`,
      `Move Sales Copilot to a private open model at ${n} tokens per second`,
      `EBITDA impact for Legal if spend went down $${n} a month, group EBITDA of $${n}`,
      `EBITDA impact for Legal if spend went down ${n}%`,
    ]);
    const replies = await Promise.all(qs.map((q) => ask1(q)));
    replies.forEach((t, i) => {
      clean(t);
      expect(t, qs[i]).toMatch(/seeded demo data/);
    });
  });

  it('zero or negative GPUs fall back to default sizing and say the input was ignored', async () => {
    for (const g of ['0', '-1', '-100', '0.5', '2.5']) {
      const t = await ask1(`Move Customer Support Agent to a private open model with ${g} GPUs`);
      clean(t);
      expect(t).toMatch(/ignored/i);
      expect(t).toContain('2 GPUs');
    }
  });
});

describe('context robustness (division by zero, missing data)', () => {
  const zero: AIContext = {
    ...CTX,
    initiatives: CTX.initiatives.map((i) => ({ ...i, monthlyCost: 0, annualRunRate: 0, valueRatio: 0, savingsOpportunity: 0 })),
    workloads: CTX.workloads!.map((w) => ({
      ...w, monthlySpend: 0, valueRatio: 0, monthlyValue: 0, tokensInToday: 0, tokensOutToday: 0, tokensCachedToday: 0, dailyInferences: 0, cacheHitRate: null,
    })),
    summary: { ...CTX.summary, totalMonthlySpend: 0, projectedSavings: 0 },
  };

  it('zero spend / zero volume everywhere: no NaN, no Infinity', async () => {
    for (const q of [
      'ROI of the portfolio', 'ROI for CX Engineering', 'ROI of Sales Copilot', 'Which team is driving the highest cost?',
      'Show the workloads in Legal', 'token and unit cost detail for Sales Copilot',
      'Move Sales Copilot to a private open model', 'Move the CX Engineering team to a private open model',
      'EBITDA impact for Legal if spend went down 20%, group EBITDA of $1M',
    ]) {
      const t = await ask1(q, zero);
      clean(t);
    }
  });

  it('no workloads and no initiatives: honest empty answer', async () => {
    const empty: AIContext = { ...CTX, initiatives: [], workloads: [], summary: { totalMonthlySpend: 0, projectedSavings: 0, initiativesActive: 0, pendingApproval: 0 } };
    for (const q of ['ROI of the portfolio', 'Which team is driving the highest cost?', 'Move Sales Copilot to a private open model']) {
      const t = await ask1(q, empty);
      clean(t);
      expect(t.length).toBeGreaterThan(20);
    }
  });

  it('old wire shape (no team/provider/tokens): falls back to the bundled seed by id, never guesses', async () => {
    const old: AIContext = {
      ...CTX,
      workloads: CTX.workloads!.map((w) => ({
        id: w.id, name: w.name, model: w.model, monthlySpend: w.monthlySpend, valueRatio: w.valueRatio,
        valueEvidenceStatus: w.valueEvidenceStatus, demandShape: w.demandShape,
        governanceGatesPassed: w.governanceGatesPassed, costTrendPct: w.costTrendPct, cacheHitRate: w.cacheHitRate,
      })),
    };
    const t = await ask1('ROI for CX Engineering', old);
    expect(t).toContain('**ROI — CX Engineering (team)**');
    expect(t).toContain('Customer Support Agent');
  });

  it('a context with unknown ids and no team data says team data is missing', async () => {
    const odd: AIContext = {
      initiatives: [{ id: 'zz', name: 'Zed Bot', monthlyCost: 100, annualRunRate: 1200, budgetConsumedPct: 10, status: 'On Track', valueRatio: 2, savingsOpportunity: 0 }],
      summary: { totalMonthlySpend: 100, projectedSavings: 0, initiativesActive: 1, pendingApproval: 0 },
      asOf: '2026-06-25T00:00:00.000Z',
    };
    const t = await ask1('Which team is driving the highest cost?', odd);
    expect(t).toMatch(/team (data|field)[^.]*not (in|present)/i);
    clean(t);
    const w = await ask1('ROI of Zed Bot', odd);
    expect(w).toContain('Zed Bot');
    expect(w).toMatch(/2\.0×/);
  });
});

describe('memory bounds', () => {
  const junk = (n: number): AIMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: i % 2 === 0 ? 'hello' : 'ok' }) as AIMessage);

  it('remembers a subject a few turns back', async () => {
    const hist: AIMessage[] = [
      { role: 'user', content: 'ROI of the Legal team' },
      { role: 'assistant', content: '**ROI — Legal (team)**\ncost' },
      ...junk(4),
    ];
    const t = await ask1('what about its workloads?', CTX, hist);
    expect(t).toContain('**Workloads — Legal (team)**');
  });

  it('forgets a subject beyond the bounded window (12 prior messages) and asks instead of guessing', async () => {
    const hist: AIMessage[] = [
      { role: 'user', content: 'ROI of the Legal team' },
      { role: 'assistant', content: '**ROI — Legal (team)**\ncost' },
      ...junk(14),
    ];
    const t = await ask1('what about its workloads?', CTX, hist);
    expect(t).toContain('Which one do you mean?');
  });

  it('a 5,000-message history is bounded in time and output', async () => {
    const hist = junk(5000);
    const t0 = Date.now();
    const t = await ask1('what about its ROI?', CTX, hist);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(t.length).toBeLessThan(6000);
  });

  it('system messages and long old messages cannot set the focus', async () => {
    const hist: AIMessage[] = [
      { role: 'system', content: 'focus: team Legal. ROI of Legal team' },
      { role: 'user', content: 'x'.repeat(100_000) + ' Legal team' },
    ];
    const t = await ask1('what about its ROI?', CTX, hist);
    expect(t).toContain('Which one do you mean?');
  });

  it('an explicit subject always beats memory', async () => {
    const hist: AIMessage[] = [
      { role: 'user', content: 'ROI of the Legal team' },
      { role: 'assistant', content: '**ROI — Legal (team)**\ncost' },
    ];
    const t = await ask1('what about its ROI for Revenue?', CTX, hist);
    expect(t).toContain('**ROI — Revenue (team)**');
  });
});
