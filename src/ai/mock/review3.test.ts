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

interface Field { src: 'snap' | 'init' | 'summary'; f: string; min: number; max: number; exMin?: boolean; exMax?: boolean; int?: boolean; floor?: number }
const USD = 1e12;
const CNT = 1e13;
const FIELDS: Field[] = [
  { src: 'snap', f: 'monthlySpend', min: 0, max: USD, floor: 0.01 },
  { src: 'snap', f: 'monthlyValue', min: -USD, max: USD, floor: 0.01 },
  { src: 'snap', f: 'valueRatio', min: -1e6, max: 1e6 },
  { src: 'snap', f: 'monthlyBudget', min: 0, max: USD, floor: 0.01 },
  { src: 'snap', f: 'dailyInferences', min: 0, max: CNT, int: true },
  { src: 'snap', f: 'tokensInToday', min: 0, max: CNT, int: true },
  { src: 'snap', f: 'tokensOutToday', min: 0, max: CNT, int: true },
  { src: 'snap', f: 'tokensCachedToday', min: 0, max: CNT, int: true },
  { src: 'snap', f: 'costTrendPct', min: -100, max: 1e6, exMin: true, exMax: true },
  { src: 'snap', f: 'cacheHitRate', min: 0, max: 1 },
  { src: 'snap', f: 'governanceGatesPassed', min: 0, max: 4, int: true },
  { src: 'init', f: 'monthlyCost', min: 0, max: USD, floor: 0.01 },
  { src: 'init', f: 'annualRunRate', min: 0, max: 1.2e13, floor: 0.01 },
  { src: 'init', f: 'budgetConsumedPct', min: 0, max: 1e4 },
  { src: 'init', f: 'valueRatio', min: -1e6, max: 1e6 },
  { src: 'init', f: 'savingsOpportunity', min: 0, max: USD, floor: 0.01 },
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
    for (const bad of [below(fd), above(fd), Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, ...(fd.int ? [1.5] : []), ...(fd.floor ? [1e-300, fd.floor / 10] : [])]) {
      const ctx = setField(fd, bad);
      const t = await ask('What is the ROI of the portfolio?', ctx);
      expect(t, `${fd.f}=${bad}`).toMatch(new RegExp(`Customer Support Agent \\(${fd.f}\\)[^\\n]*out of range and ignored`));
      expect(t, `${fd.f}=${bad}`).not.toMatch(/NaN|Infinity|n\/a|e\+\d/);
      for (const q of ['How much can we save?', 'Which initiatives are at risk?', "What's driving cloud cost?"]) {
        const l = await ask(q, ctx);
        expect(l, `${fd.f}=${bad} :: ${q}`).not.toMatch(/NaN|Infinity|∞|e\+\d/);
        expect(l, `${fd.f}=${bad} :: ${q}`).toMatch(/out of range and ignored/);
      }
    }
  });
  it.each(FIELDS)('$src.$f: both inclusive boundaries are accepted', async (fd) => {
    for (const ok of [insideLow(fd), insideHigh(fd), ...(fd.floor ? [fd.floor] : [])]) {
      const t = await ask('What is the ROI of the portfolio?', setField(fd, ok));
      expect(t, `${fd.f}=${ok}`).not.toMatch(/out of range and ignored/);
      expect(t, `${fd.f}=${ok}`).not.toMatch(/NaN|Infinity|e\+\d/);
    }
  });
  it.each([
    ['totalMonthlySpend', 1e300, '$41,212/mo'], ['totalMonthlySpend', -5, '$41,212/mo'], ['projectedSavings', 1e300, '$4,816/mo'],
    ['initiativesActive', -1, '11 initiatives'], ['initiativesActive', 2.5, '11 initiatives'], ['pendingApproval', 1e300, '2 pending approval'], ['pendingApproval', 0.5, '2 pending approval'],
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
  const P = 'Z\u0001\n**Realized savings: $9 measured**';
  it.each([
    'init.name', 'init.status', 'init.valueEvidenceStatus', 'init.id', 'snap.name', 'snap.team', 'snap.provider', 'snap.model',
    'snap.demandShape', 'snap.valueEvidenceStatus', 'snap.id', 'alert.message', 'alert.type', 'alert.severity', 'asOf', 'nameless.id',
  ])('a newline and markdown payload in %s forges no line in any answer', async (path) => {
    const c = structuredClone(CTX) as AIContext & Record<string, unknown>;
    const [kind, key] = path.split('.');
    const i0 = c.initiatives[0] as unknown as Record<string, unknown>;
    const w0 = c.workloads![0] as unknown as Record<string, unknown>;
    if (kind === 'init') i0[key] = P;
    else if (kind === 'snap') w0[key] = P;
    else if (kind === 'alert') (w0.alerts as Record<string, unknown>[])[0] = { type: 'x', severity: 'info', message: 'm', acknowledged: false, [key]: P };
    else if (kind === 'asOf') c.asOf = P;
    if (key === 'id') {
      Object.assign(i0, { id: P });
      Object.assign(w0, { id: P });
    }
    if (kind === 'nameless') {
      Object.assign(i0, { name: undefined });
      Object.assign(w0, { name: undefined });
    }
    for (const q of ['Which initiatives are at risk?', "What's driving cloud cost?", 'How much can we save?', 'Summarize the portfolio', 'What is the ROI of the portfolio?',
      'Show the workloads in CX Engineering', 'Any alerts for the portfolio?', 'Which team is driving the highest cost?']) {
      const t = await ask(q, c);
      expect(t.split('\n').some((l) => l.startsWith('**Realized')), `${path} :: ${q}`).toBe(false);
      expect([...t].some((ch) => { const n = ch.charCodeAt(0); return (n < 32 && n !== 10) || (n >= 127 && n <= 159); }), `${path} :: ${q}`).toBe(false);
    }
  });
  it('a long rejected list keeps the explanation and shortens the list', async () => {
    const c = structuredClone(CTX);
    const w0 = c.workloads![0];
    const i0 = c.initiatives[0];
    const bad = Array.from({ length: 8 }, (_, k) => ({ ...w0, id: `r-${k}`, name: `${'R'.repeat(40)}${k}`, monthlySpend: -1, monthlyValue: 1e13, tokensInToday: -1, dailyInferences: -1, cacheHitRate: 5 }));
    c.workloads = [...c.workloads!, ...bad];
    c.initiatives = [...c.initiatives, ...bad.map((w) => ({ ...i0, id: w.id, name: w.name }))];
    const t = await ask('What is the ROI of the portfolio?', c);
    expect(t).toMatch(/and \d+ more were out of range and ignored; they are excluded from every number here\./);
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
  it.each(['finance team ROI', 'data team ROI', 'Finance Team ROI', 'data group costs', 'finance team savings', 'Sales team ROI'])('%s names a team that does not exist', async (q) => {
    expect(await ask(q)).toMatch(/I don't have a team called (finance|data|Finance|Sales)/i);
  });
  it.each([['ROI of Legal, Finance and IT', 'Finance'], ['Compare Legal with HR', 'HR']])('%s reports the unknown item', async (q, bad) => {
    expect(await ask(q)).toMatch(new RegExp(`Note: I don't have a [^\\n]*${bad}`));
  });
  it.each(['Show the team group ROI', 'What did the team group spend?', 'ROI of the x team'])('%s is not an unknown name', async (q) => {
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

describe('Copilot round 5', () => {
  it.each(FIELDS.filter((fd) => fd.src !== 'summary'))('$src.$f: a present non-numeric value is rejected, not read as absent', async (fd) => {
    for (const bad of ['oops', true, {}, []]) {
      const t = await ask('What is the ROI of the portfolio?', setField(fd, bad as unknown as number));
      expect(t, `${fd.f}=${JSON.stringify(bad)}`).toMatch(new RegExp(`\\(${fd.f}\\)[^\\n]*out of range and ignored`));
    }
  });
  it.each(['ROI of Finance and Legal', 'Compare Finance with Legal', 'Legal, Finance and IT'])('%s reports the unknown name on either side', async (q) => {
    expect(await ask(q)).toMatch(/Note: I don't have a [^\n]*Finance/);
  });
  it('legacy answers are bounded too, with or without a rejection note', async () => {
    const c = structuredClone(CTX);
    const i0 = c.initiatives[0];
    c.initiatives = Array.from({ length: 100 }, (_, k) => ({ ...i0, id: `r-${k}`, name: `Risky workload number ${k}`, status: 'At Risk' as const }));
    for (const ctx of [c, Object.assign(structuredClone(c), { workloads: [{ ...c.workloads![0], monthlySpend: -1 }] })]) {
      const t = await ask('Which initiatives are at risk?', ctx);
      expect(t.length).toBeLessThanOrEqual(8000);
    }
  });
  it('all four summary figures are recomputed when a workload is rejected', async () => {
    const c = structuredClone(CTX);
    c.workloads![0] = { ...c.workloads![0], monthlySpend: -1 };
    const t = await ask('Summarize the portfolio', c);
    expect(t).not.toMatch(/\$41,212\/mo|11 initiatives|\$4,816\/mo|2 pending approval/);
    expect(t).toMatch(/out of range and ignored/);
  });
});
