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
  it('a wrong-typed valueRatio is a 200 with the workload excluded through the real route', async () => {
    const r = await viaRoute(mod((c) => { for (const o of [c.workloads![0], c.initiatives[0]]) Object.assign(o, { valueRatio: 'oops' }); }), 'What is the ROI of the portfolio?');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/out of range and ignored/);
  });
});

describe('malformed wire shapes never 500 and never reach a renderer', () => {
  const LEGACY_Q = ['Which initiatives are at risk?', "What's driving cloud cost?", 'How much can we save?', 'Summarize the portfolio', 'What is the ROI of the portfolio?'];
  const SHAPES: [string, (c: Record<string, unknown>) => void][] = [
    ['initiatives [null]', (c) => { c.initiatives = [null]; }],
    ['odd entries', (c) => { c.initiatives = [1, 'x', []]; c.workloads = [null, 2]; }],
    ['initiative without valueRatio', (c) => { delete (c.initiatives as Record<string, unknown>[])[0].valueRatio; }],
    ['12,000-deep nesting', (c) => { Object.assign((c.initiatives as Record<string, unknown>[])[0], { extra: Array.from({ length: 12000 }).reduce<unknown>((o) => ({ o }), {}) }); }],
  ];
  it.each(SHAPES)('%s', async (_n, mut) => {
    const c = structuredClone(CTX) as unknown as Record<string, unknown>;
    mut(c);
    for (const q of LEGACY_Q) {
      const r = await viaRoute(c as unknown as AIContext, q);
      expect(r.status, q).toBe(200);
      expect(r.text, q).not.toMatch(/NaN|Infinity|undefined|\[object|can't process/);
    }
  });
  it('an omitted malformed entry is listed in the note', async () => {
    expect((await viaRoute(mod((c) => { Object.assign(c, { initiatives: [null, ...c.initiatives] }); }), 'Summarize the portfolio')).text).toMatch(/1 malformed[^\n]*ignored/);
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
  it('wire names are capped in length', async () => {
    const ctx = withSnap(0, { team: 'T'.repeat(500) });
    const { text } = await chat([{ role: 'user', content: 'Which team is driving the highest cost?' }], ctx);
    expect(text).not.toContain('T'.repeat(100));
  });
});
