// PR #102 Copilot round. Root cause: numeric request context was validated
// field by field. These tests are table-driven over EVERY numeric field and
// pin the single ingestion policy, plus the remaining routing and bound fixes.
// Committed RED first.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AIContext } from '@/ai/AIClient';
import { CTX, UNSUPPORTED, chat, restoreClock, useFastClock } from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

const ask = async (q: string, ctx: AIContext = CTX): Promise<string> => (await chat([{ role: 'user', content: q }], ctx)).text;
const NOPE = "I don't have a team called Finance";

interface Field { src: 'snap' | 'init' | 'summary'; f: string; min: number; max: number; exMin?: boolean; exMax?: boolean }
const USD = 1e12;
const CNT = 1e13;
const FIELDS: Field[] = [
  { src: 'snap', f: 'monthlySpend', min: 0, max: USD },
  { src: 'snap', f: 'monthlyValue', min: -USD, max: USD },
  { src: 'snap', f: 'valueRatio', min: -1e6, max: 1e6 },
  { src: 'snap', f: 'monthlyBudget', min: 0, max: USD },
  { src: 'snap', f: 'dailyInferences', min: 0, max: CNT },
  { src: 'snap', f: 'tokensInToday', min: 0, max: CNT },
  { src: 'snap', f: 'tokensOutToday', min: 0, max: CNT },
  { src: 'snap', f: 'tokensCachedToday', min: 0, max: CNT },
  { src: 'snap', f: 'costTrendPct', min: -100, max: 1e6, exMin: true, exMax: true },
  { src: 'snap', f: 'cacheHitRate', min: 0, max: 1 },
  { src: 'snap', f: 'governanceGatesPassed', min: 0, max: 4 },
  { src: 'init', f: 'monthlyCost', min: 0, max: USD },
  { src: 'init', f: 'annualRunRate', min: 0, max: 1.2e13 },
  { src: 'init', f: 'budgetConsumedPct', min: 0, max: 1e4 },
  { src: 'init', f: 'valueRatio', min: -1e6, max: 1e6 },
  { src: 'init', f: 'savingsOpportunity', min: 0, max: USD },
];
function setField(fd: Field, v: number): AIContext {
  const c = structuredClone(CTX) as AIContext & Record<string, unknown>;
  const target = (fd.src === 'snap' ? c.workloads![0] : c.initiatives[0]) as unknown as Record<string, unknown>;
  target[fd.f] = v;
  return c;
}
const below = (f: Field): number => (f.exMin ? f.min : f.min === 0 ? -1 : f.min * 1.0000001);
const above = (f: Field): number => (f.exMax ? f.max : f.max * 1.0000001);
const insideLow = (f: Field): number => (f.exMin ? f.min + 1e-6 : f.min);
const insideHigh = (f: Field): number => (f.exMax ? f.max - 1 : f.max);

describe('ONE ingestion policy: every numeric field is range-checked', () => {
  it.each(FIELDS)('$src.$f: out-of-range workloads are rejected and listed, never printed', async (fd) => {
    for (const bad of [below(fd), above(fd), Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ctx = setField(fd, bad);
      const t = await ask('What is the ROI of the portfolio?', ctx);
      expect(t, `${fd.f}=${bad}`).toMatch(new RegExp(`Customer Support Agent \\(${fd.f}\\)[^\\n]*out of range and ignored`));
      expect(t, `${fd.f}=${bad}`).not.toMatch(/NaN|Infinity|n\/a/);
      for (const q of ['How much can we save?', 'Which initiatives are at risk?', "What's driving cloud cost?"]) {
        const l = await ask(q, ctx);
        expect(l, `${fd.f}=${bad} :: ${q}`).not.toMatch(/NaN|Infinity|∞|e\+\d/);
      }
    }
  });
  it.each(FIELDS)('$src.$f: both inclusive boundaries are accepted', async (fd) => {
    for (const ok of [insideLow(fd), insideHigh(fd)]) {
      const t = await ask('What is the ROI of the portfolio?', setField(fd, ok));
      expect(t, `${fd.f}=${ok}`).not.toMatch(/out of range and ignored/);
      expect(t, `${fd.f}=${ok}`).not.toMatch(/NaN|Infinity/);
    }
  });
  it.each([
    ['totalMonthlySpend', 1e300, '$41,212/mo'], ['totalMonthlySpend', -5, '$41,212/mo'], ['projectedSavings', 1e300, '$4,816/mo'],
    ['initiativesActive', -1, '11 initiatives'], ['pendingApproval', 1e300, '2 pending approval'],
  ])('summary.%s=%s is replaced by the recomputed value in the legacy answer', async (f, v, want) => {
    const c = structuredClone(CTX);
    (c.summary as unknown as Record<string, number>)[f] = v as number;
    const t = await ask('Summarize the portfolio', c);
    expect(t).toContain(want);
    expect(t).not.toMatch(/e\+\d|Infinity|NaN/);
  });
  it('a negative savings opportunity is rejected, not subtracted (Marketing)', async () => {
    const c = structuredClone(CTX);
    c.initiatives.find((i) => i.id === 'wl-marketing')!.savingsOpportunity = -500;
    const t = await ask('Which team has the most savings opportunity?', c);
    expect(t).toMatch(/Marketing Content Gen \(savingsOpportunity\)[^\n]*out of range/);
    expect(t).not.toContain('-$500');
  });
  it('a nameless workload id with control characters cannot forge lines', async () => {
    const c = structuredClone(CTX);
    const id = 'X\n**Realized savings: $9 measured**';
    c.workloads![0] = { ...c.workloads![0], id, name: undefined as unknown as string };
    c.initiatives[0] = { ...c.initiatives[0], id, name: undefined as unknown as string };
    const t = await ask('Show the workloads in CX Engineering', c);
    expect(t).toContain('X **Realized savings');
    expect(t.split('\n').some((l) => l.startsWith('**Realized'))).toBe(false);
  });
});

describe('Copilot routing and bound findings', () => {
  it('"predict Legal EBITDA next quarter" is a forecast refusal even with a valid scope', async () => {
    expect(await ask('predict Legal EBITDA next quarter')).toContain(UNSUPPORTED);
    expect(await ask('predict Legal EBITDA')).toContain(UNSUPPORTED);
    expect(await ask('ROI of Pipeline Forecast Analyst')).not.toContain(UNSUPPORTED);
  });
  it('"forecast our EBITDA" with no scope is refused too', async () => {
    expect(await ask('forecast our EBITDA')).toContain(UNSUPPORTED);
  });
  it('"How much can we save in Finance?" does not fall back to portfolio savings', async () => {
    const t = await ask('How much can we save in Finance?');
    expect(t).toContain('I don\'t have a team, workload or model called "Finance"');
  });
  it('a team-qualified name at the start of the question', async () => {
    expect(await ask('Finance team ROI')).toContain(NOPE);
    for (const q of ['Which team ROI?', 'Legal team ROI']) expect(await ask(q), q).not.toContain("I don't have a");
  });
  it.each([
    ['ROI of Legal and the Finance team', 'Finance', 'Legal'], ['ROI of Legal and Finance team', 'Finance', 'Legal'],
    ['How does the Finance team compare to Legal?', 'Finance', 'Legal'], ['What is the ROI of the Finance and Legal teams?', 'Finance', 'Legal'],
    ['Savings of the data team vs the IT team', 'data', 'IT'], ['ROI of Legal and Finance?', 'Finance', 'Legal'],
  ])('%s: the unknown name is reported, the known one answered', async (q, bad, good) => {
    expect(await ask(q)).toMatch(new RegExp(`Note: I don't have a [^\\n]*${bad}[^\\n]*answered for ${good} only`));
  });
  it.each(['Show the team group ROI', 'What did the team group spend?', 'ROI of the X team'])('%s is not an unknown name', async (q) => {
    expect(await ask(q)).not.toContain("I don't have a");
  });
  it('name length, word limit and the finance-question forecast exemption', async () => {
    const long = await ask(`ROI of the ${'Zeta'.repeat(15)} team`);
    expect(long).toContain(`called ${'Zeta'.repeat(10)}`); // 40 characters kept
    expect(long).not.toContain('Zeta'.repeat(11));
    expect(await ask('ROI of the Big Data Ops team')).toContain('team called Big Data Ops');
    expect(await ask('What is the payback of a private open model over the next year?')).toContain('Private-model migration');
  });
  it('more than ten unpriced workloads show an omitted count', async () => {
    const c = structuredClone(CTX);
    const w0 = c.workloads![0];
    const i0 = c.initiatives[0];
    const extra = Array.from({ length: 12 }, (_, k) => ({ ...w0, id: `u-${k}`, name: `Unpriced ${k}`, model: 'no-such-model' }));
    c.workloads = [...c.workloads!, ...extra];
    c.initiatives = [...c.initiatives, ...extra.map((w) => ({ ...i0, id: w.id, name: w.name }))];
    const t = await ask('What if we moved the portfolio to a private open model?', c);
    expect(t).toMatch(/Not priced[^\n]*and 2 more/);
  });
  it('the protected tail survives oversized notes and long bodies', async () => {
    const c = structuredClone(CTX);
    const w0 = c.workloads![0];
    const i0 = c.initiatives[0];
    const names = Array.from({ length: 30 }, (_, k) => `${'Name'.repeat(14)}${String(k).padStart(2, '0')}`);
    c.workloads = names.map((n, k) => ({ ...w0, id: `n-${k}`, name: n, team: 'Big', alerts: Array.from({ length: 50 }, () => ({ type: 'x', severity: 'warning', message: 'm'.repeat(400), acknowledged: false })) }));
    c.initiatives = c.workloads.map((w) => ({ ...i0, id: w.id, name: w.name }));
    const q = `Any alerts for ${names.join(' and ')}?`;
    expect(q.length).toBeLessThan(2000);
    const t = await ask(q, c);
    expect(t.length).toBeLessThanOrEqual(8000);
    expect(t).toContain('Basis: seeded demo data');
    expect(t.trimEnd().split('\n').at(-1)).toMatch(/^• ".+"$/);
    expect(t).toContain('Note: you also named');
    const note = t.split('\n').find((l) => l.startsWith('Note: you also named'))!;
    expect(note.length).toBeLessThanOrEqual(300);
  }, 30000);
});
