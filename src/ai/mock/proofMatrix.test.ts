// Proof-question matrix: 40 questions across portfolio / team / workload /
// model, simple to drill-down, including multi-turn pronoun follow-ups. Every
// expected number is computed by the independent oracle straight from the seed
// (see __testkit__/oracle.ts) — never by the code under test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKLOADS } from '@/data/workloads';
import { MODEL_REGISTRY } from '@/data/models';
import {
  alertsOf, model, portfolio, team, teamsByCost, teamsByRatio, usd, wl, x1,
} from './__testkit__/oracle';
import {
  BASIS, CLARIFY, UNSUPPORTED, ask, last, nextQuestions, restoreClock, useFastClock,
} from './__testkit__/ask';

beforeAll(useFastClock);
afterAll(restoreClock);

const roiPct = (ratio: number): string => `${Math.round((ratio - 1) * 100).toLocaleString('en-US')}%`;
const share = (n: number, total: number): string => `${((n / total) * 100).toFixed(1)}%`;
const EVID = '(value evidence: assumed)';
const P = portfolio();
const byValueDesc = (ws: typeof WORKLOADS) =>
  [...ws].sort((a, b) => b.value.total_value - a.value.total_value);
const wlLine = (id: string): string[] => {
  const w = wl(id);
  return [w.name, usd(w.costs.monthly_spend), x1(w.value.total_value / w.costs.monthly_spend)];
};
const esc = (n: string): string => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Position of the numbered list line "N. <name>" so prose mentions don't count.
const order = (text: string, names: string[]): boolean => {
  const idx = names.map((n) => text.search(new RegExp(`^\\d+\\. ${esc(n)}`, 'm')));
  return idx.every((i) => i >= 0) && idx.every((v, k) => k === 0 || v > idx[k - 1]);
};

interface Case {
  name: string;
  turns: string[];
  has: string[];
  not?: string[];
  ordered?: string[];
}

const CX = team('CX Engineering');
const LEGAL = team('Legal');
const RISK = team('Risk & Trust');
const REV = team('Revenue');
const IT = team('IT');
const GPT4O = model('gpt-4o');
const SONNET = model('claude-sonnet-4-20250514');
const costRank = teamsByCost();
const ratioRank = teamsByRatio();

const CASES: Case[] = [
  // ---- portfolio ----
  { name: '01 portfolio ROI', turns: ['What is the ROI of the portfolio?'],
    has: ['**ROI — Portfolio**', usd(P.spend), usd(P.value), x1(P.ratio), roiPct(P.ratio), EVID,
      'Weakest: Fraud Triage Agent', 'Strongest: Code Review Bot'] },
  { name: '02 overall ROI wording', turns: ["What's our overall ROI?"],
    has: ['**ROI — Portfolio**', usd(P.value), x1(P.ratio), EVID] },
  { name: '03 best-ROI team', turns: ['Which team has the best ROI?'],
    has: [`**Best-ROI team: ${ratioRank[0]}**`, x1(team(ratioRank[0]).ratio), EVID],
    ordered: ratioRank },
  { name: '04 weakest-ROI team', turns: ['Which team has the lowest ROI?'],
    has: [`**Weakest-ROI team: ${ratioRank[ratioRank.length - 1]}**`, x1(RISK.ratio), EVID] },
  { name: '05 highest-cost team', turns: ['Who or which team is driving up the highest cost?'],
    has: [`**Highest-cost team: ${costRank[0]}**`, `${usd(CX.spend)}/mo`, share(CX.spend, P.spend), x1(CX.ratio), EVID,
      'Customer Support Agent'],
    not: ['The largest cost driver is'], ordered: costRank },
  { name: '06 rank teams by spend', turns: ['Rank the teams by spend'],
    has: costRank.map((t) => `${usd(team(t).spend)}/mo`), ordered: costRank },
  { name: '07 savings by team', turns: ['Which team has the most savings opportunity?'],
    has: ['**Largest savings opportunity by team: Marketing**', usd(1568), 'projected'] },
  // ---- team ----
  { name: '08 Legal team ROI', turns: ['What is the ROI of the Legal team?'],
    has: ['**ROI — Legal (team)**', usd(LEGAL.spend), usd(LEGAL.value), x1(LEGAL.ratio), roiPct(LEGAL.ratio), EVID],
    ordered: byValueDesc(LEGAL.members).map((w) => w.name) },
  { name: '09 CX Engineering ROI + contributors ranked by value', turns: ['ROI for CX Engineering'],
    has: ['**ROI — CX Engineering (team)**', usd(CX.value), x1(CX.ratio), ...wlLine('wl-support'), ...wlLine('wl-triage')],
    ordered: ['Customer Support Agent', 'Support Triage Router'] },
  { name: '10 Revenue group ROI', turns: ['ROI for the Revenue group'],
    has: ['**ROI — Revenue (team)**', usd(REV.spend), usd(REV.value), x1(REV.ratio), ...wlLine('wl-sales'), ...wlLine('wl-forecast')] },
  { name: '11 Risk & Trust ROI is negative and honest', turns: ['ROI of Risk & Trust'],
    has: ['**ROI — Risk & Trust (team)**', usd(RISK.value), `${RISK.ratio.toFixed(1)}×`, roiPct(RISK.ratio), EVID, 'no positive return'] },
  { name: '12 workloads of Platform Eng', turns: ['Show the workloads in Platform Eng'],
    has: ['**Workloads — Platform Eng (team)**', ...wlLine('wl-codereview'), ...wlLine('wl-infrabot'), EVID] },
  { name: '13 scoped cost driver', turns: ["What's driving cost in Legal?"],
    has: ['**Cost drivers — Legal**', `${usd(3120)}/mo`, x1(wl('wl-redline').value.total_value / 3120), EVID],
    ordered: ['Contract Redliner', 'Document Summarizer'] },
  { name: '14 team savings', turns: ['How much can we save in Marketing?'],
    has: ['**Savings — Marketing**', usd(1568), 'projected', 'Realized savings: $0'] },
  { name: '15 team with no savings says so', turns: ['How much can we save for Legal?'],
    has: ['**Savings — Legal**', 'no savings opportunities'], not: ['$1,568'] },
  { name: '16 IT single-workload team', turns: ['What is the ROI of the IT team?'],
    has: ['**ROI — IT (team)**', usd(IT.spend), x1(IT.ratio), 'Internal Knowledge Bot'] },
  // ---- workload ----
  { name: '17 Sales Copilot ROI', turns: ['What is the ROI of the Sales Copilot?'],
    has: ['**ROI — Sales Copilot (workload)**', usd(6800), usd(wl('wl-sales').value.total_value), x1(wl('wl-sales').value.total_value / 6800), EVID, 'Revenue'] },
  { name: '18 Fraud Triage Agent ROI negative', turns: ['ROI of Fraud Triage Agent'],
    has: ['**ROI — Fraud Triage Agent (workload)**', usd(4200), '-0.2×', 'no positive return', EVID] },
  { name: '19 cache hit rate', turns: ['What cache hit rate does the Customer Support Agent have?'],
    has: ['16.5%', 'Customer Support Agent'] },
  { name: '20 token and unit cost detail', turns: ['Show token and unit cost detail for Marketing Content Gen'],
    has: ['**Tokens and unit cost — Marketing Content Gen**', '7,040,000', '8,960,000', '220,000', '3.0%', '$2.50', '$10.00', '$1.25', '$16.75', 'gpt-4o'] },
  { name: '21 alerts for a workload', turns: ['Any alerts for Marketing Content Gen?'],
    has: ['**Alerts — Marketing Content Gen**', ...alertsOf('wl-marketing').map((a) => a.message)] },
  { name: '22 alerts for Fraud Triage Agent', turns: ['What alerts exist for Fraud Triage Agent?'],
    has: alertsOf('wl-fraud').map((a) => a.message) },
  { name: '23 outcome evidence is not measured', turns: ['Is there outcome evidence for Code Review Bot?'],
    has: ['**Outcome evidence — Code Review Bot**', 'no measured outcome evidence', 'assumed', 'simulated'] },
  // ---- model ----
  { name: '24 ROI of gpt-4o', turns: ['What is the ROI of gpt-4o?'],
    has: ['**ROI — gpt-4o (model)**', usd(GPT4O.spend), usd(GPT4O.value), x1(GPT4O.ratio), EVID, 'Sales Copilot', 'Marketing Content Gen', 'Pipeline Forecast Analyst'] },
  { name: '25 workloads on Claude Sonnet', turns: ['Which workloads run on Claude Sonnet?'],
    has: ['**Workloads on claude-sonnet-4-20250514 (model)**', 'Customer Support Agent', 'Contract Redliner', usd(SONNET.spend)], not: ['Sales Copilot'] },
  { name: '26 model price per 1M', turns: ['What does gemini-2.5-flash cost per 1M tokens?'],
    has: ['$0.075', '$0.30', '$0.0188', 'Document Summarizer', 'Support Triage Router'] },
  // ---- multi-turn / pronouns ----
  { name: '27 screenshot follow-up: team then its workloads and ROI',
    turns: ['Who or which team is driving up the highest cost?', 'What about its workload activities and ROI?'],
    has: ['**Workloads — CX Engineering (team)**', ...wlLine('wl-support'), ...wlLine('wl-triage'), EVID],
    not: ["I'm Frank Coster"] },
  { name: '28 team then "show its workloads"', turns: ['ROI of the Legal team', 'show its workloads'],
    has: ['**Workloads — Legal (team)**', ...wlLine('wl-redline'), ...wlLine('wl-docsum')] },
  { name: '29 workload then "what team is it in"', turns: ['ROI of Sales Copilot', 'what team is it in?'],
    has: ['Sales Copilot', 'Revenue'], not: [UNSUPPORTED, CLARIFY] },
  { name: '30 workload then "the same team"', turns: ['ROI of Sales Copilot', 'And the ROI of the same team?'],
    has: ['**ROI — Revenue (team)**', usd(REV.value), x1(REV.ratio)] },
  { name: '31 workload then migrate "it"', turns: ['ROI of Marketing Content Gen', 'what if we moved it to a private open model?'],
    has: ['**Private-model migration — Marketing Content Gen**', 'Realized savings: $0'] },
  { name: '32 team then EBITDA for "its" spend', turns: ['ROI of the Legal team', 'EBITDA impact if its spend went down $2,000 a month'],
    has: ['**EBITDA impact — Legal**', usd(24000)] },
  { name: '33 team then savings "there"', turns: ['Legal team ROI', 'how much can we save there?'],
    has: ['**Savings — Legal**', 'no savings opportunities'] },
  { name: '34 model then "which workloads use it"', turns: ['ROI of gpt-4o', 'which workloads use it?'],
    has: ['**Workloads on gpt-4o (model)**', 'Sales Copilot', 'Pipeline Forecast Analyst'] },
  { name: '35 workload then alerts for "it"', turns: ['ROI of Fraud Triage Agent', 'and any alerts for it?'],
    has: ['**Alerts — Fraud Triage Agent**', ...alertsOf('wl-fraud').map((a) => a.message)] },
  { name: '36 explicit entity overrides focus', turns: ['ROI of the Legal team', 'what about Revenue?'],
    has: ['**ROI — Revenue (team)**', usd(REV.value)], not: ['**ROI — Legal'] },
  { name: '37 portfolio word resets focus', turns: ['ROI of the Legal team', 'and for the whole portfolio?'],
    has: ['**ROI — Portfolio**', usd(P.value)] },
  { name: '38 elliptical savings follows the team', turns: ['Marketing team ROI', 'what about savings?'],
    has: ['**Savings — Marketing**', usd(1568)] },
  // ---- meta ----
  { name: '39 unsupported question', turns: ['What will our spend be next quarter?'],
    has: [UNSUPPORTED, 'Closest questions I can answer'], not: ["I'm Frank Coster"] },
  { name: '40 capability ladder', turns: ['What can you answer, and how deep can you go for each team?'],
    has: ['**What I can answer**', 'deterministic mock', 'no LLM', 'seeded', 'portfolio', 'team', 'workload', 'model', 'alerts'] },
];

describe('proof-question matrix (oracle computed from the seed)', () => {
  it('has at least 30 questions across the four scopes', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CASES)('$name', async ({ turns, has, not, ordered }) => {
    const text = await last(turns);
    for (const s of has) expect(text, `missing ${JSON.stringify(s)}`).toContain(s);
    for (const s of not ?? []) expect(text, `unexpected ${JSON.stringify(s)}`).not.toContain(s);
    if (ordered) expect(order(text, ordered), `order ${ordered.join(' > ')}`).toBe(true);
  });

  it('08b Legal strongest/weakest come from the oracle ratios', async () => {
    const text = await last(['What is the ROI of the Legal team?']);
    const sorted = [...LEGAL.members].sort(
      (a, b) => b.value.total_value / b.costs.monthly_spend - a.value.total_value / a.costs.monthly_spend);
    expect(text).toContain(`Strongest: ${sorted[0].name}`);
    expect(text).toContain(`Weakest: ${sorted[sorted.length - 1].name}`);
  });

  it('every new-style answer states its basis and shows an evidence status', async () => {
    for (const c of CASES.filter((k) => !k.has.includes(UNSUPPORTED) && !k.name.includes('capability'))) {
      const text = await last(c.turns);
      expect(text, c.name).toMatch(BASIS);
      expect(text, c.name).toMatch(/assumed|evidence/);
    }
  });

  it('ladder closure: every suggested next question is itself answerable', async () => {
    let checked = 0;
    for (const c of CASES.filter((k) => k.turns.length === 1 && !k.has.includes(UNSUPPORTED))) {
      const first = await last(c.turns);
      const qs = nextQuestions(first);
      expect(qs.length, `${c.name} suggests 2-3 questions`).toBeGreaterThanOrEqual(2);
      expect(qs.length, c.name).toBeLessThanOrEqual(3);
      for (const q of qs) {
        const reply = await last([...c.turns, q]);
        expect(reply, `${c.name} -> ${q}`).not.toContain(UNSUPPORTED);
        expect(reply, `${c.name} -> ${q}`).not.toContain(CLARIFY);
        expect(reply, `${c.name} -> ${q}`).not.toContain("I'm Frank Coster");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('the answer ladder reaches portfolio -> team -> workload -> unit cost -> alerts', async () => {
    const r = await ask([
      'What is the ROI of the portfolio?',
      'Which team is driving the highest cost?',
      'show its workloads',
      'token and unit cost detail for Customer Support Agent',
      'any alerts for it?',
    ]);
    expect(r[1]).toContain('**Highest-cost team: CX Engineering**');
    expect(r[2]).toContain('**Workloads — CX Engineering (team)**');
    expect(r[3]).toContain('**Tokens and unit cost — Customer Support Agent**');
    expect(r[4]).toContain('**Alerts — Customer Support Agent**');
  });

  it('registry prices quoted match MODEL_REGISTRY', async () => {
    const m = MODEL_REGISTRY.find((r) => r.model_name === 'claude-opus-4-20250514')!;
    const text = await last(['token and unit cost detail for Fraud Triage Agent']);
    expect(text).toContain(`$${m.pricing.input_per_1m.toFixed(2)}`);
    expect(text).toContain(`$${m.pricing.output_per_1m.toFixed(2)}`);
  });
});
