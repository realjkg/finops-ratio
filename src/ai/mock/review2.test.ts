// PR #102 challenger round: prototype keys in the quality-note lookup, false
// positives of the unknown-name check, unknown teams under every phrasing and
// intent, exact boundary assertions for every guard the PR claims, and notes
// that survive the reply cap. Committed RED first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIContext } from '@/ai/AIClient';
import { CTX, chat, restoreClock, useFastClock } from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

type Snap = NonNullable<AIContext['workloads']>[number];
const withSnap = (patch: Partial<Snap>): AIContext => {
  const c = structuredClone(CTX);
  Object.assign(c.workloads![0], patch);
  return c;
};
const ask = async (q: string, ctx: AIContext = CTX): Promise<string> => (await chat([{ role: 'user', content: q }], ctx)).text;
const SUPPORT = 'ROI of Customer Support Agent';
const REJECTED = /out of range and ignored/;

describe('M1 quality-note lookup uses own properties', () => {
  it.each(['constructor', '__proto__', 'toString'])('wire model %s reached by "the same model"', async (m) => {
    const ctx = withSnap({ model: m });
    for (const follow of ['What about the same model?', 'Show token and unit cost detail for the same model']) {
      const { text } = await chat(
        [
          { role: 'user', content: SUPPORT },
          { role: 'assistant', content: '**ROI — Customer Support Agent (workload)**' },
          { role: 'user', content: follow },
        ],
        ctx,
      );
      expect(text).not.toMatch(/function|native code|\[object/);
      expect(text).toContain(m);
    }
  });
});

describe('M2 valid portfolio questions are not mistaken for unknown names', () => {
  it.each([
    'What is the ROI in total?', 'What is the ROI in dollars?', 'What is the ROI on average?', 'What is the ROI of AI?',
    'What is the ROI in USD?', 'Show token usage for workloads', 'Any alerts on the models?', 'Is there outcome evidence for agents?',
    'Show token detail in aggregate', 'Any alerts on the dashboards?',
  ])('%s', async (q) => {
    const t = await ask(q);
    expect(t).not.toContain("I don't have a");
    expect(t).toMatch(/seeded demo data/);
  });
  it('a capitalized unknown name is still caught', async () => {
    expect(await ask('ROI of Finance')).toContain('I don\'t have a team, workload or model called "Finance"');
  });
});

describe('M3 unknown teams under every phrasing and intent', () => {
  const NOPE = "I don't have a team called Finance";
  it('follow-up after a known team', async () => {
    const { text } = await chat([
      { role: 'user', content: 'What is the ROI of the Legal team?' },
      { role: 'assistant', content: '**ROI — Legal (team)**' },
      { role: 'user', content: 'What about the Finance team?' },
    ]);
    expect(text).toContain(NOPE);
    expect(text).not.toContain('**ROI — Legal');
  });
  it.each([
    'What if we moved the Finance team to a private open model?',
    'How much can we save in the Finance team?',
    "What's driving cost in the Finance team?",
    'EBITDA impact for the Finance team if spend went down $2,000 a month',
    'Show token detail for the Finance group',
  ])('%s', async (q) => {
    const t = await ask(q);
    expect(t).toContain(NOPE);
    expect(t).not.toContain('**Savings — Portfolio**');
    expect(t).not.toContain('**Private-model migration — Portfolio**');
  });
  it('generic phrases with the word team are not names', async () => {
    for (const q of ['Which is the highest cost team?', 'What about the same team?', 'ROI of the best ROI team', 'Who is the weakest team?']) {
      expect(await ask(q), q).not.toContain("I don't have a");
    }
  });
});

describe('M5 exact boundaries of the claimed guards', () => {
  const bigCtx = (n: number): AIContext => {
    const c = structuredClone(CTX);
    const w0 = c.workloads![0];
    const i0 = c.initiatives[0];
    c.workloads = Array.from({ length: n }, (_, k) => ({
      ...w0, id: `b-${k}`, name: `Big Workload ${k}`, team: 'Big',
      alerts: Array.from({ length: 50 }, () => ({ type: 'x', severity: 'warning', message: 'm'.repeat(400), acknowledged: false })),
    }));
    c.initiatives = c.workloads.map((w) => ({ ...i0, id: w.id, name: w.name }));
    return c;
  };

  it('USD limit is 1e12 inclusive for spend and for value', async () => {
    for (const f of ['monthlySpend', 'monthlyValue'] as const) {
      const ok = await ask(SUPPORT, withSnap({ monthlySpend: 1e12, monthlyValue: 1e12, [f]: 1e12 }));
      expect(ok, f).toContain('**ROI — Customer Support Agent (workload)**');
      expect(ok, f).not.toMatch(REJECTED);
      const bad = await ask('What is the ROI of the portfolio?', withSnap({ [f]: 1.0000001e12 }));
      expect(bad, f).toMatch(REJECTED);
    }
  });
  it('count limit is 1e13 inclusive for tokens and calls', async () => {
    for (const f of ['tokensInToday', 'tokensOutToday', 'tokensCachedToday', 'dailyInferences'] as const) {
      expect(await ask('What is the ROI of the portfolio?', withSnap({ [f]: 1e13 })), f).not.toMatch(REJECTED);
      expect(await ask('What is the ROI of the portfolio?', withSnap({ [f]: 1.0000001e13 })), f).toMatch(REJECTED);
    }
  });
  it('list cap is 20 rows', async () => {
    expect(await ask('Show the workloads in Big', bigCtx(20))).not.toMatch(/and \d+ more/);
    expect(await ask('Show the workloads in Big', bigCtx(21))).toContain('…and 1 more.');
  });
  it('reply cap is 8,000 characters and keeps the tail', async () => {
    const t = await ask('Any alerts for Big Workload 1?', bigCtx(3));
    expect(t.length).toBeLessThanOrEqual(8000);
    expect(t).toContain('answer shortened');
    expect(t).toContain('Basis: seeded demo data');
    expect(t).toContain('Next questions:');
  });
  it('wire names are capped at 60 characters, not 59 or 61', async () => {
    const q = 'Which team is driving the highest cost?';
    expect(await ask(q, withSnap({ team: 'T'.repeat(60) }))).toContain('T'.repeat(60));
    const long = await ask(q, withSnap({ team: 'T'.repeat(61) }));
    expect(long).toContain('T'.repeat(60));
    expect(long).not.toContain('T'.repeat(61));
  });
  it('control characters, DEL, C1 controls and U+2028/2029 become spaces', async () => {
    for (const ch of ['\u0001', '\u001f', '\u007f', '\u0085', '\u009f', ' ', ' ']) {
      const t = await ask('Which team is driving the highest cost?', withSnap({ team: `Aa${ch}Bb` }));
      expect(t, JSON.stringify(ch)).toContain('Aa Bb');
    }
  });
  it('cache-rate bounds are [0, 1]', async () => {
    const q = 'Tell me about the Customer Support Agent';
    expect(await ask(q, withSnap({ cacheHitRate: 1 }))).toContain('100.0%');
    expect(await ask(q, withSnap({ cacheHitRate: 0 }))).toContain('Cache hit rate: 0.0%');
    expect(await ask(q, withSnap({ cacheHitRate: 1.01 }))).not.toContain('Cache hit rate');
    expect(await ask(q, withSnap({ cacheHitRate: -0.01 }))).not.toContain('Cache hit rate');
  });
  it('budget bound is 1e12 inclusive', async () => {
    const q = 'Tell me about the Customer Support Agent';
    expect(await ask(q, withSnap({ monthlyBudget: 1e12 }))).toContain('of $1,000,000,000,000/mo');
    expect(await ask(q, withSnap({ monthlyBudget: 1.0000001e12 }))).not.toContain('of $1,0');
  });
  it('trend bounds are (-100, 1e6) exclusive', async () => {
    const q = 'Tell me about the Customer Support Agent';
    expect(await ask(q, withSnap({ costTrendPct: 999999 }))).toContain('MoM trend +999999.0%');
    expect(await ask(q, withSnap({ costTrendPct: 1e6 }))).not.toContain('MoM trend');
    expect(await ask(q, withSnap({ costTrendPct: -99 }))).toContain('MoM trend -99.0%');
    expect(await ask(q, withSnap({ costTrendPct: -100 }))).not.toContain('MoM trend');
  });
});

describe('L1 notes survive the reply cap', () => {
  it('rejected-figures and also-named notes stay when the body is shortened', async () => {
    const c = structuredClone(CTX);
    const w0 = c.workloads![0];
    const i0 = c.initiatives[0];
    c.workloads = [
      ...Array.from({ length: 3 }, (_, k) => ({ ...w0, id: `b-${k}`, name: `Big Workload ${k}`, team: 'Big', alerts: Array.from({ length: 50 }, () => ({ type: 'x', severity: 'warning', message: 'm'.repeat(400), acknowledged: false })) })),
      { ...w0, id: 'bad', name: 'Bad Figures', monthlySpend: 1.7e308 },
    ];
    c.initiatives = c.workloads.map((w) => ({ ...i0, id: w.id, name: w.name }));
    const t = await ask('Any alerts for Big Workload 1 and Big Workload 2?', c);
    expect(t.length).toBeLessThanOrEqual(8000);
    expect(t).toContain('answer shortened');
    expect(t).toContain('Note: you also named Big Workload 2');
    expect(t).toMatch(/Bad Figures[^\n]*out of range and ignored/);
  }, 30000);
});
