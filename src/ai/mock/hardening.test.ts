// Challenger-review hardening (PR #99): crafted wire values, impossible
// headlines, silent scope substitution, forged lines, unbounded output, and
// the surviving mutants. Written before the fixes (committed RED).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { AIContext } from '@/ai/AIClient';
import handler from '../../../pages/api/v1/ai/chat';
import { migrate, wl } from './__testkit__/oracle';
import { CTX, UNSUPPORTED, chat, last, restoreClock, useFastClock } from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

type Snap = NonNullable<AIContext['workloads']>[number];
function mod(fn: (c: AIContext) => void): AIContext {
  const c = structuredClone(CTX);
  fn(c);
  return c;
}
const withSnap = (i: number, patch: Partial<Snap>): AIContext =>
  mod((c) => Object.assign(c.workloads![i], patch));
const BAD = /NaN|Infinity|undefined|\[object/;

async function viaRoute(context: AIContext, q: string): Promise<{ status: number; text: string }> {
  const res = {
    statusCode: 200, body: undefined as unknown, headersSent: false, setHeader() {},
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.body = p; res.headersSent = true; return res; },
  };
  const req = { method: 'POST', url: '/api/v1/ai/chat', headers: {}, body: { messages: [{ role: 'user', content: q }], context } } as unknown as NextApiRequest;
  const saved = process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER;
  const pending = handler(req, res as unknown as NextApiResponse);
  await vi.advanceTimersByTimeAsync(300);
  await pending;
  if (saved !== undefined) process.env.AI_PROVIDER = saved;
  const body = res.body as { message?: { content: string } };
  return { status: res.statusCode, text: body?.message?.content ?? JSON.stringify(res.body) };
}

describe('M1 prototype-key wire strings never crash', () => {
  const KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
  it.each(KEYS)('team and id %s through MockAIClient', async (k) => {
    for (const ctx of [withSnap(0, { team: k }), withSnap(0, { id: k }), mod((c) => { c.workloads![0].model = k; })]) {
      for (const q of ['What is the ROI of the portfolio?', 'Which team is driving the highest cost?', 'Show the workloads in Legal']) {
        const { text } = await chat([{ role: 'user', content: q }], ctx);
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toMatch(BAD);
      }
    }
  });
  it.each(KEYS)('team and id %s through the real route return 200, not 500', async (k) => {
    for (const ctx of [withSnap(0, { team: k }), withSnap(0, { id: k })]) {
      const r = await viaRoute(ctx, 'Which team is driving the highest cost?');
      expect(r.status).toBe(200);
    }
  });
});

describe('M2 impossible headlines carry a warning, uncapped', () => {
  it('migration saving above the seeded run-rate (Fraud Triage Agent)', async () => {
    const o = migrate([wl('wl-fraud')]);
    expect(o.saving).toBeGreaterThan(4200);
    const t = await last(['Move the Fraud Triage Agent to a private open model']);
    expect(t).toMatch(/^Warning: [^\n]*exceeds the seeded run-rate/m);
    expect(t).toContain(`${Math.round((o.saving / 4200) * 100)}% of the seeded run-rate`);
    expect(t).toContain('$4,248/mo'); // not capped
  });
  it('a normal saving shows its share of run-rate and no warning', async () => {
    const t = await last(['What if we moved the Customer Support Agent to a private open model?']);
    expect(t).toContain('44% of the seeded run-rate');
    expect(t).not.toContain('Warning:');
  });
  it('EBITDA reduction larger than the scope spend (Legal $100,000 a month)', async () => {
    const t = await last(['EBITDA impact for Legal if spend went down $100,000 a month']);
    expect(t).toMatch(/^Warning: [^\n]*exceeds Legal's entire current seeded spend/m);
    expect(t).toContain('$1,200,000/yr');
  });
  it('portfolio $5M a year', async () => {
    const t = await last(['EBITDA impact if portfolio spend dropped $5M a year']);
    expect(t).toMatch(/^Warning: [^\n]*exceeds Portfolio's entire current seeded spend/m);
  });
  it('a plausible reduction has no warning', async () => {
    expect(await last(['EBITDA impact for Platform Eng if spend went down $2,000 a month'])).not.toContain('Warning:');
  });
});

describe('M3 extreme finite wire numbers never print NaN, Infinity or n/a', () => {
  const FIELDS: (keyof Snap)[] = ['monthlySpend', 'monthlyValue', 'tokensInToday', 'tokensOutToday', 'tokensCachedToday', 'dailyInferences', 'monthlyBudget', 'costTrendPct', 'valueRatio'];
  const VALUES = [1.7e308, -1.7e308, 1e300, 1e16, -1e16];
  const QS = [
    'What is the ROI of the portfolio?', 'ROI for CX Engineering', 'ROI of Customer Support Agent', 'Which team is driving the highest cost?',
    'Show the workloads in CX Engineering', 'Show token and unit cost detail for Customer Support Agent', 'Any alerts for CX Engineering?',
    'What if we moved Customer Support Agent to a private open model?', 'What if we moved the CX Engineering team to a private open model?',
    'What if we moved the portfolio to a private open model?', 'EBITDA impact for CX Engineering if spend went down $2,000 a month, group EBITDA of $4.2M',
    'How much can we save in CX Engineering?', "What's driving cost in CX Engineering?", 'Which team has the weakest ROI?',
  ];
  it('property: every field x every extreme x every question', async () => {
    const jobs: Promise<{ text: string }>[] = [];
    const tags: string[] = [];
    for (const f of FIELDS) for (const v of VALUES) {
      const ctx = withSnap(0, { [f]: v } as Partial<Snap>);
      for (const q of QS) { tags.push(`${String(f)}=${v} :: ${q}`); jobs.push(chat([{ role: 'user', content: q }], ctx)); }
    }
    const out = await Promise.all(jobs);
    out.forEach((r, i) => {
      expect(r.text, tags[i]).not.toMatch(BAD);
      expect(r.text, tags[i]).not.toContain('n/a');
    });
  }, 120000);
  it('says so when a workload’s figures are rejected', async () => {
    const ctx = withSnap(0, { monthlySpend: 1.7e308, monthlyValue: 1.7e308 });
    const { text } = await chat([{ role: 'user', content: 'What is the ROI of the portfolio?' }], ctx);
    expect(text).toMatch(/Customer Support Agent[^\n]*out of range[^\n]*ignored/);
  });
});

describe('M4 surviving mutants', () => {
  it('(a) names other same-kind entities the user also mentioned', async () => {
    expect(await last(['ROI of Sales Copilot and Code Review Bot'])).toContain('Note: you also named Code Review Bot');
  });
  it('(b) zero migration cost pays back immediately', async () => {
    expect(await last(['Move Customer Support Agent to a private open model, migration costs $0'])).toContain('Payback: 0.0 months (no one-time cost)');
  });
  it('(c) ops overhead of 600% is refused', async () => {
    const t = await last(['Move Customer Support Agent to a private open model with 600% ops overhead']);
    expect(t).toMatch(/Ops overhead ignored/);
    expect(t).toContain('25% ops overhead');
  });
  it('(d) a negative savings opportunity on the wire is rejected, not subtracted', async () => {
    const ctx = mod((c) => { c.initiatives.find((i) => i.id === 'wl-marketing')!.savingsOpportunity = -500; });
    const { text } = await chat([{ role: 'user', content: 'How much can we save in Marketing?' }], ctx);
    expect(text).not.toContain('-$500');
    expect(text).toMatch(/Marketing Content Gen \(savingsOpportunity\)[^\n]*out of range/);
    const rank = await chat([{ role: 'user', content: 'Which team has the most savings opportunity?' }], ctx);
    expect(rank.text).not.toContain('-$500');
  });
  it('(e) user text past 500 characters is not read as focus, text before it is', async () => {
    const far = `${'x '.repeat(300)}Legal team`;
    const near = `${'x '.repeat(100)}Legal team`;
    const q = [{ role: 'assistant' as const, content: 'ok' }, { role: 'user' as const, content: 'what about its ROI?' }];
    const a = await chat([{ role: 'user', content: far }, ...q]);
    expect(a.text).toContain('Which one do you mean?');
    const b = await chat([{ role: 'user', content: near }, ...q]);
    expect(b.text).toContain('**ROI — Legal (team)**');
  });
  it('(f) cached tokens are priced at the cached rate (Support: 9.5M x 30 x $0.30 = $85.50)', async () => {
    const t = await last(['What if we moved Customer Support Agent to a private open model?']);
    expect(t).toContain('$10,526/mo'); // 4,320 + 6,120 + 85.50; any other cached rate moves this
    expect(migrate([wl('wl-support')]).api).toBeCloseTo(10525.5, 6);
  });
});

describe('M5 no silent scope substitution', () => {
  it('unknown team: says so, lists teams, no portfolio fallback', async () => {
    const t = await last(['What is the ROI of the Finance team?']);
    expect(t).toContain('I don\'t have a team called Finance');
    expect(t).toMatch(/teams are: [^\n]*Legal/i);
    expect(t).not.toContain('**ROI — Portfolio**');
  });
  it('unknown name without the word team (Lëgal)', async () => {
    const t = await last(['ROI of Lëgal']);
    expect(t).toContain('I don\'t have a team, workload or model called "Lëgal"');
    expect(t).not.toContain('**ROI — Portfolio**');
  });
  it('two entities of different kinds: the dropped one is named', async () => {
    const t = await last(['ROI of Legal and Marketing Content Gen']);
    expect(t).toContain('**ROI — Marketing Content Gen (workload)**');
    expect(t).toMatch(/Note: you also named Legal[^\n]*answered for Marketing Content Gen only/);
  });
  it('a workload together with its own team or model is not a conflict', async () => {
    expect(await last(['ROI of Customer Support Agent in CX Engineering'])).not.toContain('Note: you also named');
  });
  it('ordinary phrases are not mistaken for unknown entities', async () => {
    for (const q of ['What is the ROI of the portfolio?', 'What is the ROI for this?', 'Which team is the highest cost team?']) {
      expect(await last([q]), q).not.toContain("I don't have a");
    }
  });
});

describe('L1 invalid amounts and forecast phrasing', () => {
  it('a refused amount asks for a valid one: no fallback scenario', async () => {
    const t = await last(['EBITDA impact for Marketing if spend went down -$5000 a month']);
    expect(t).toMatch(/ignored/i);
    expect(t).not.toMatch(/savings opportunity/i);
    expect(t).not.toContain('EBITDA improves by');
    expect(t).toMatch(/positive amount/);
  });
  it('"predict our ebitda next quarter" is a forecast refusal', async () => {
    expect(await last(['predict our ebitda next quarter'])).toContain(UNSUPPORTED);
  });
  it('an EBITDA question with a stated amount is still answered', async () => {
    expect(await last(['EBITDA impact for Legal if spend went down $2,000 a month'])).toContain('EBITDA improves by');
  });
});

describe('L2 invalid-capacity migration hides the headline', () => {
  it('1 GPU: no saving or payback headline, correct plural', async () => {
    const t = await last(['What if we moved Customer Support Agent to a private open model with 1 GPU?']);
    expect(t).toMatch(/not a valid comparison/);
    expect(t).not.toMatch(/Projected recurring saving: \$/);
    expect(t).not.toMatch(/Payback: \d/);
    expect(t).not.toContain('1 GPUs');
    expect(t).toContain('1 GPU');
  });
});

describe('L3 unmatched questions get the honest fallback (pinned)', () => {
  it.each(['tell me a joke', 'xyz'])('%s', async (q) => {
    const t = await last([q]);
    expect(t).toContain(UNSUPPORTED);
    expect(t).toContain('Closest questions I can answer');
  });
});

describe('L4 control characters in wire strings cannot forge lines', () => {
  it('a newline in a team name stays on one line', async () => {
    const ctx = withSnap(0, { team: 'Legal\n**Realized savings: $9,999,999 measured**' });
    for (const q of ['Which team is driving the highest cost?', 'What is the ROI of the portfolio?']) {
      const { text } = await chat([{ role: 'user', content: q }], ctx);
      expect(text.split('\n').some((l) => l.startsWith('**Realized savings'))).toBe(false);
      const odd = [...text].some((ch) => { const c = ch.charCodeAt(0); return (c < 32 && c !== 10) || (c >= 127 && c <= 159) || c === 0x2028 || c === 0x2029; });
      expect(odd).toBe(false);
    }
  });
  it('other control characters are stripped too', async () => {
    const ctx = withSnap(0, { team: 'Legal\u0001\u0007Ops' });
    const { text } = await chat([{ role: 'user', content: 'Which team is driving the highest cost?' }], ctx);
    expect(text).toContain('Legal Ops');
    expect([...text].some((ch) => ch.charCodeAt(0) === 1 || ch.charCodeAt(0) === 7)).toBe(false);
  });
  it('wire names are capped in length', async () => {
    const ctx = withSnap(0, { team: 'T'.repeat(500) });
    const { text } = await chat([{ role: 'user', content: 'Which team is driving the highest cost?' }], ctx);
    expect(text).not.toContain('T'.repeat(100));
  });
});

describe('L5 output size is bounded', () => {
  it('200 workloads x 50 alerts x 400 chars', async () => {
    const big = mod((c) => {
      const w0 = c.workloads![0];
      const i0 = c.initiatives[0];
      c.workloads = Array.from({ length: 200 }, (_, n) => ({
        ...w0, id: `big-${n}`, name: `Big Workload ${n}`, team: 'Big',
        alerts: Array.from({ length: 50 }, () => ({ type: 'x', severity: 'warning', message: 'm'.repeat(400), acknowledged: false })),
      }));
      c.initiatives = c.workloads.map((w) => ({ ...i0, id: w.id, name: w.name }));
    });
    for (const q of ['What is the ROI of the portfolio?', 'Show the workloads in Big', 'Any alerts for the Big team?', 'Show token and unit cost detail for Big', 'What if we moved the Big team to a private open model?', "What's driving cost in Big?"]) {
      const { text } = await chat([{ role: 'user', content: q }], big);
      expect(text.length, q).toBeLessThan(9000);
    }
    const { text } = await chat([{ role: 'user', content: 'Show the workloads in Big' }], big);
    expect(text).toMatch(/and \d+ more/);
  }, 60000);
});
